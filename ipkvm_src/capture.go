package main

/*
	capture.go

	Thin helpers around mod/usbcapture: format probing used by the device
	detector and the "pick a sensible resolution" logic used at startup.
*/

import (
	"fmt"
	"sort"
	"strings"

	"aroz.org/dezkvm/ipkvm/mod/usbcapture"
)

// nodeSupportsMJPEG reports whether a /dev/videoN node advertises at least one
// discrete MJPEG capture size. UVC capture cards expose a second, metadata-only
// node alongside the streaming one; only the streaming node lists MJPEG, so
// this is what separates the two.
func nodeSupportsMJPEG(node string) bool {
	formats, err := usbcapture.GetV4L2FormatInfo(node)
	if err != nil {
		return false
	}
	for _, format := range formats {
		if !isMJPEGFormat(format.Format) {
			continue
		}
		if len(format.Sizes) > 0 {
			return true
		}
	}
	return false
}

func isMJPEGFormat(name string) bool {
	switch strings.ToUpper(name) {
	case "MJPG", "MJPEG", "JPEG":
		return true
	}
	return false
}

// mjpegSizes returns every discrete MJPEG size the device supports, largest
// area first, with the frame rates sorted descending.
func mjpegSizes(node string) ([]usbcapture.SizeInfo, error) {
	formats, err := usbcapture.GetV4L2FormatInfo(node)
	if err != nil {
		return nil, err
	}

	var sizes []usbcapture.SizeInfo
	for _, format := range formats {
		if !isMJPEGFormat(format.Format) {
			continue
		}
		for _, size := range format.Sizes {
			rates := append([]int(nil), size.FPS...)
			sort.Sort(sort.Reverse(sort.IntSlice(rates)))
			sizes = append(sizes, usbcapture.SizeInfo{
				Width:  size.Width,
				Height: size.Height,
				FPS:    rates,
			})
		}
	}
	if len(sizes) == 0 {
		return nil, fmt.Errorf("device %s does not expose any MJPEG format", node)
	}

	sort.SliceStable(sizes, func(a, b int) bool {
		return sizes[a].Width*sizes[a].Height > sizes[b].Width*sizes[b].Height
	})
	return sizes, nil
}

// pickResolution resolves the requested width/height/fps against what the
// device actually supports. A zero width or height means "largest available";
// the frame rate is capped at maxFPS because anything above ~30fps at 1080p
// saturates both the USB bus and the browser's MJPEG decoder.
func pickResolution(node string, width, height, maxFPS int) (*usbcapture.CaptureResolution, error) {
	sizes, err := mjpegSizes(node)
	if err != nil {
		return nil, err
	}
	if maxFPS <= 0 {
		maxFPS = 30
	}

	// Explicit size requested: it has to exist, otherwise the user gets a
	// listing of what is actually on offer instead of a silent fallback.
	if width > 0 && height > 0 {
		for _, size := range sizes {
			if size.Width == width && size.Height == height {
				return &usbcapture.CaptureResolution{
					Width:  size.Width,
					Height: size.Height,
					FPS:    bestFPS(size.FPS, maxFPS),
				}, nil
			}
		}
		return nil, fmt.Errorf("device %s does not support %dx%d (supported: %s)",
			node, width, height, describeSizes(sizes))
	}

	largest := sizes[0]
	return &usbcapture.CaptureResolution{
		Width:  largest.Width,
		Height: largest.Height,
		FPS:    bestFPS(largest.FPS, maxFPS),
	}, nil
}

// bestFPS returns the highest supported frame rate that does not exceed maxFPS,
// falling back to the lowest available rate when every option is too fast.
func bestFPS(rates []int, maxFPS int) int {
	best := 0
	lowest := 0
	for _, rate := range rates {
		if lowest == 0 || rate < lowest {
			lowest = rate
		}
		if rate <= maxFPS && rate > best {
			best = rate
		}
	}
	if best > 0 {
		return best
	}
	if lowest > 0 {
		return lowest
	}
	return maxFPS
}

func describeSizes(sizes []usbcapture.SizeInfo) string {
	var parts []string
	for _, size := range sizes {
		parts = append(parts, fmt.Sprintf("%dx%d", size.Width, size.Height))
	}
	return strings.Join(parts, ", ")
}
