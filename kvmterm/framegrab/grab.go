// Package framegrab captures frames from the DezKVM-Go's HDMI capture card
// (an MS2109 / MS2109S UVC device) by shelling out to ffmpeg.
//
// ffmpeg is used because it abstracts the per-OS capture backend behind one
// tool: AVFoundation on macOS, V4L2 on Linux, and DirectShow on Windows.
// Frames are read as raw RGBA so there is no image-codec overhead.
package framegrab

import (
	"bytes"
	"fmt"
	"image"
	"io"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"time"
)

// warmupTimeout bounds how long Grab keeps reading frames while waiting for
// the capture card to produce a non-black frame. The MS2109 emits black
// frames for about 1.5-2s each time its stream is opened after being idle.
const warmupTimeout = 4 * time.Second

// blankLevel is the channel value at or below which a pixel counts as black.
const blankLevel = 16

// Grabber captures still frames from a video device.
type Grabber struct {
	width  int
	height int
	// inputArgs is everything ffmpeg needs up to and including the -i device.
	inputArgs []string
}

// New builds a Grabber from an explicit set of ffmpeg input arguments
// (e.g. {"-f","avfoundation","-framerate","30","-video_size","1920x1080","-i","0:none"}).
func New(width, height int, inputArgs []string) *Grabber {
	return &Grabber{width: width, height: height, inputArgs: inputArgs}
}

// DefaultArgs returns sensible ffmpeg input arguments for the current OS,
// given a device specifier (see DefaultDevice).
func DefaultArgs(device string, width, height int) []string {
	size := strconv.Itoa(width) + "x" + strconv.Itoa(height)
	switch runtime.GOOS {
	case "darwin":
		return []string{
			"-f", "avfoundation", "-framerate", "30", "-video_size", size,
			"-i", device + ":none",
		}
	case "windows":
		return []string{"-f", "dshow", "-video_size", size, "-i", "video=" + device}
	default: // linux and others
		return []string{"-f", "v4l2", "-video_size", size, "-i", device}
	}
}

// DefaultDevice returns the default video device for the current OS. It is a
// best-effort guess; users can override it with a flag.
func DefaultDevice() string {
	switch runtime.GOOS {
	case "darwin":
		return "0" // AVFoundation video device index (0 = first capture device)
	case "windows":
		return "USB Video"
	default:
		return "/dev/video0"
	}
}

// Grab captures a single frame as an RGBA image. It skips the all-black
// frames the capture card emits while its stream starts up; if every frame
// within warmupTimeout is black, the last one is returned.
func (g *Grabber) Grab() (*image.RGBA, error) {
	args := append([]string{"-y", "-hide_banner", "-loglevel", "error"}, g.inputArgs...)
	args = append(args, "-f", "rawvideo", "-pix_fmt", "rgba", "pipe:1")

	cmd := exec.Command("ffmpeg", args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("ffmpeg: %w", err)
	}

	img := image.NewRGBA(image.Rect(0, 0, g.width, g.height))
	frame := make([]byte, len(img.Pix))
	deadline := time.Now().Add(warmupTimeout)
	n := 0
	for {
		if _, err = io.ReadFull(stdout, frame); err != nil {
			break
		}
		n++
		copy(img.Pix, frame)
		if !isBlank(img.Pix) || time.Now().After(deadline) {
			break
		}
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()

	if n == 0 && err != nil {
		return nil, fmt.Errorf("ffmpeg %s: %w: %s", strings.Join(args, " "), err, stderr.String())
	}
	return img, nil
}

// isBlank reports whether an RGBA buffer contains only near-black pixels.
func isBlank(pix []byte) bool {
	for i := 0; i < len(pix); i += 4 {
		if pix[i] > blankLevel || pix[i+1] > blankLevel || pix[i+2] > blankLevel {
			return false
		}
	}
	return true
}
