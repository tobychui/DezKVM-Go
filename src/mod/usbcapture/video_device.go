package usbcapture

import (
	"bufio"
	"bytes"
	"context"
	_ "embed"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"log"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/vladimirvivien/go4vl/device"
	"github.com/vladimirvivien/go4vl/v4l2"
)

/*
	Bandwidth estimation for MJPEG video stream

	1920 x 1080 60fps = 55Mbps //Chrome not support
	1920 x 1080 30fps = 50Mbps
	1920 x 1080 25fps = 40Mbps
	1920 x 1080 20fps = 30Mbps
	1920 x 1080 10fps = 15Mbps

	1360 x 768 60fps = 28Mbps //Chrome not support
	1360 x 768 30fps = 25Mbps
	1360 x 768 25fps = 20Mbps
	1360 x 768 20fps = 18Mbps
	1360 x 768 10fps = 10Mbps
*/

// Struct to store the size and fps info
type FormatInfo struct {
	Format string
	Sizes  []SizeInfo
}

type SizeInfo struct {
	Width  int
	Height int
	FPS    []int
}

//go:embed stream_takeover.jpg
var endOfStreamJPG []byte

// start video capture
func (i *Instance) StartVideoCapture(openWithResolution *CaptureResolution) error {
	if i.Capturing {
		return fmt.Errorf("video capture already started")
	}

	if openWithResolution.FPS == 0 {
		openWithResolution.FPS = 25 //Default to 25 FPS
	}

	devName := i.Config.VideoDeviceName
	if openWithResolution == nil {
		return fmt.Errorf("resolution not provided")
	}
	frameRate := openWithResolution.FPS
	buffSize := 2 //No. of frames to buffer
	//Default to MJPEG
	//Other formats that are commonly supported are YUYV, H264, MJPEG
	format := "mjpeg"

	//Check if the video device is a capture device
	isCaptureDev, err := CheckVideoCaptureDevice(devName)
	if err != nil {
		return fmt.Errorf("failed to check video device: %w", err)
	}
	if !isCaptureDev {
		return fmt.Errorf("device %s is not a video capture device", devName)
	}

	//Check if the selected FPS is valid in the provided Resolutions
	resolutionIsSupported, err := deviceSupportResolution(i.Config.VideoDeviceName, openWithResolution)
	if err != nil {
		return err
	}
	if !resolutionIsSupported {
		return errors.New("this device do not support the required resolution settings")
	}

	// Retry opening the device up to 5 times with increasing delay
	var camera *device.Device
	maxRetries := 5
	for attempt := 0; attempt < maxRetries; attempt++ {
		//Open the video device
		camera, err = device.Open(devName,
			device.WithIOType(v4l2.IOTypeMMAP),
			device.WithPixFormat(v4l2.PixFormat{
				PixelFormat: getFormatType(format),
				Width:       uint32(openWithResolution.Width),
				Height:      uint32(openWithResolution.Height),
				Field:       v4l2.FieldAny,
			}),
			device.WithFPS(uint32(frameRate)),
			device.WithBufferSize(uint32(buffSize)),
		)
		if err == nil {
			break // Success
		}

		// Check if it's a "device or resource busy" error
		if strings.Contains(err.Error(), "device or resource busy") && attempt < maxRetries-1 {
			log.Printf("Device busy, retrying in %d seconds (attempt %d/%d)", attempt+1, attempt+1, maxRetries)
			time.Sleep(time.Duration(attempt+1) * time.Second)
			continue
		}

		// Other error or last attempt failed
		log.Println("Error opening video device:", err)
		return fmt.Errorf("failed to open video device: %w", err)
	}

	i.camera = camera
	caps := camera.Capability()
	log.Printf("device [%s] opened\n", devName)
	log.Printf("device info: %s", caps.String())
	// Should get something like this:
	//2025/03/16 15:45:25 device info: driver: uvcvideo; card: USB Video: USB Video; bus info: usb-0000:00:14.0-2

	// set device format
	currFmt, err := camera.GetPixFormat()
	if err != nil {
		return fmt.Errorf("failed to get current pixel format: %w", err)
	}

	// Should get something like this:
	// 2025/03/16 15:45:25 Current format: Motion-JPEG [1920x1080]; field=any; bytes per line=0; size image=0; colorspace=Default; YCbCr=Default; Quant=Default; XferFunc=Default
	log.Printf("Current format: %s", currFmt)

	// store format info
	i.pixfmt = currFmt.PixelFormat
	i.width = int(currFmt.Width)
	i.height = int(currFmt.Height)
	i.fps = frameRate

	i.streamInfo = fmt.Sprintf("%s - %s [%dx%d] %d fps",
		caps.Card,
		v4l2.PixelFormats[currFmt.PixelFormat],
		currFmt.Width, currFmt.Height, frameRate,
	)

	// start capture
	ctx, cancel := context.WithCancel(context.TODO())
	if err := camera.Start(ctx); err != nil {
		log.Fatalf("stream capture: %s", err)
	}
	i.cameraStartContext = cancel

	// video stream
	i.frames_buff = camera.GetOutput()

	log.Printf("device capture started (buffer size set %d)", camera.BufferCount())
	i.Capturing = true
	return nil
}

// start http service
func (i *Instance) ServeVideoStream(w http.ResponseWriter, req *http.Request) {
	//Check if the access count is already 1, if so, kick out the previous access
	if i.accessCount >= 1 {
		log.Println("Another client is already connected, kicking out the previous client...")
		if i.videoTakeoverChan != nil {
			i.videoTakeoverChan <- true
		}
		log.Println("Previous client kicked out, taking over the stream...")
	}
	i.accessCount++

	err := i.streamMJPEG(w, req)
	if err != nil {
		log.Printf("video stream error: %v", err)
	}
	i.accessCount--
}

func isJPEG(frame []byte) bool {
	if len(frame) < 4 {
		return false
	}
	// Quick check for SOI/EOI markers
	if bytes.HasPrefix(frame, []byte{0xFF, 0xD8}) && bytes.HasSuffix(frame, []byte{0xFF, 0xD9}) {
		return true
	}
	// Fallback: look for SOI anywhere and EOI after it
	start := bytes.Index(frame, []byte{0xFF, 0xD8})
	end := bytes.LastIndex(frame, []byte{0xFF, 0xD9})
	return start >= 0 && end > start
}

func (i *Instance) streamMJPEG(w http.ResponseWriter, req *http.Request) error {
	// Set up the multipart response
	mimeWriter := multipart.NewWriter(w)
	w.Header().Set("Content-Type", fmt.Sprintf("multipart/x-mixed-replace; boundary=%s", mimeWriter.Boundary()))
	partHeader := make(textproto.MIMEHeader)
	partHeader.Add("Content-Type", "image/jpeg")

	//Chrome MJPEG decoder cannot decode the first frames from MS2109 capture card for unknown reason
	//Thus we are discarding the first 10 frames here
	if i.frames_buff != nil {
		for j := 0; j < 10; j++ {
			select {
			case <-i.frames_buff:
				// Discard frame
			default:
				// No frame to discard
			}
		}
	}

	// Streaming loop
	var frame []byte
	for frame = range i.frames_buff {
		// Drain 2 frames every frame if there are buffered frames
		// This helps in reducing latency when the network is congested
		select {
		case f := <-i.frames_buff:
			frame = f
		default:
		}

		if len(frame) == 0 {
			log.Print("skipping empty frame")
			continue
		}

		if !isJPEG(frame) {
			continue
		}

		partWriter, err := mimeWriter.CreatePart(partHeader)
		if err != nil {
			log.Printf("failed to create multi-part writer: %s", err)
			return err
		}

		if _, err := partWriter.Write(frame); err != nil {
			if errors.Is(err, syscall.EPIPE) {
				//broken pipe, the client browser has exited
				return nil
			}
			log.Printf("failed to write image: %s", err)
		}

		// Flush the response so the frame is sent immediately to the client
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}

		select {
		case <-req.Context().Done():
			// Client disconnected, exit the loop
			return nil
		case <-i.videoTakeoverChan:
			// Another client is taking over, exit the loop

			//Send the endofstream.jpg as last frame before exit
			endFrameHeader := make(textproto.MIMEHeader)
			endFrameHeader.Add("Content-Type", "image/jpeg")
			endFrameHeader.Add("Content-Length", fmt.Sprint(len(endOfStreamJPG)))
			partWriter, err := mimeWriter.CreatePart(endFrameHeader)
			if err == nil {
				partWriter.Write(endOfStreamJPG)
			}
			log.Println("Video stream taken over by another client, exiting...")
			return nil
		default:
			// Continue streaming
		}

	}
	return nil
}

// StopVideoCapture stops the video capture and closes the camera device
func (i *Instance) StopVideoCapture() error {
	if i.camera != nil {
		i.cameraStartContext()
		err := i.camera.Close()
		if err != nil {
			return err
		}
		i.camera = nil
		time.Sleep(300 * time.Millisecond)
		log.Println("video capture stopped")
	} else {
		log.Println("video capture is not running")
	}
	i.Capturing = false

	return nil
}

// IsCaptureCardVideoInterface checks if the given video device is a capture card with multiple input interfaces
func IsCaptureCardVideoInterface(device string) bool {
	if ok, _ := CheckVideoCaptureDevice(device); !ok {
		return false
	}
	formats, err := GetV4L2FormatInfo(device)
	if err != nil {
		return false
	}
	count := 0
	for _, f := range formats {
		count += len(f.Sizes)
	}
	return count > 1
}

// CheckVideoCaptureDevice checks if the given video device is a video capture device
func CheckVideoCaptureDevice(device string) (bool, error) {
	// Run v4l2-ctl to get device capabilities
	cmd := exec.Command("v4l2-ctl", "--device", device, "--all")
	output, err := cmd.CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("failed to execute v4l2-ctl: %w", err)
	}

	// Convert output to string and check for the "Video Capture" capability
	outputStr := string(output)
	if strings.Contains(outputStr, "Video Capture") {
		return true, nil
	}
	return false, nil
}

// GetDefaultVideoDevice returns the first available video capture device, e.g., /dev/video0
func GetDefaultVideoDevice() (string, error) {
	// List all /dev/video* devices and return the first one that is a video capture device
	for i := 0; i < 10; i++ {
		device := fmt.Sprintf("/dev/video%d", i)
		isCapture, err := CheckVideoCaptureDevice(device)
		if err != nil {
			continue
		}
		if isCapture {
			return device, nil
		}
	}
	return "", fmt.Errorf("no video capture device found")
}

// deviceSupportResolution checks if the given video device supports the specified resolution and frame rate
func deviceSupportResolution(devicePath string, resolution *CaptureResolution) (bool, error) {
	formatInfo, err := GetV4L2FormatInfo(devicePath)
	if err != nil {
		return false, err
	}

	// Yes, this is an O(N^3) operation, but a video decices rarely have supported resolution
	// more than 20 combinations. The compute time should be fine
	for _, res := range formatInfo {
		for _, size := range res.Sizes {
			//Check if there is a matching resolution
			if size.Height == resolution.Height && size.Width == resolution.Width {
				//Matching resolution. Check if the required FPS is supported
				for _, fps := range size.FPS {
					if fps == resolution.FPS {
						return true, nil
					}
				}
			}
		}
	}

	return false, nil
}

// PrintV4L2FormatInfo prints the supported formats, resolutions, and frame rates of the given video device
func PrintV4L2FormatInfo(devicePath string) {
	// Check if the device is a video capture device
	isCapture, err := CheckVideoCaptureDevice(devicePath)
	if err != nil {
		fmt.Printf("Error checking device: %v\n", err)
		return
	}
	if !isCapture {
		fmt.Printf("Device %s is not a video capture device\n", devicePath)
		return
	}

	// Get format info
	formats, err := GetV4L2FormatInfo(devicePath)
	if err != nil {
		fmt.Printf("Error getting format info: %v\n", err)
		return
	}

	// Print format info
	for _, format := range formats {
		fmt.Printf("Format: %s\n", format.Format)
		for _, size := range format.Sizes {
			fmt.Printf("  Size: %dx%d\n", size.Width, size.Height)
			fmt.Printf("    FPS: %v\n", size.FPS)
		}
	}
}

// Function to run the v4l2-ctl command and parse the output
func GetV4L2FormatInfo(devicePath string) ([]FormatInfo, error) {
	// Run the v4l2-ctl command to list formats
	cmd := exec.Command("v4l2-ctl", "--list-formats-ext", "-d", devicePath)
	var out bytes.Buffer
	cmd.Stdout = &out
	err := cmd.Run()
	if err != nil {
		return nil, err
	}

	// Parse the output
	var formats []FormatInfo
	var currentFormat *FormatInfo
	scanner := bufio.NewScanner(&out)

	formatRegex := regexp.MustCompile(`\[(\d+)\]: '(\S+)'`)
	sizeRegex := regexp.MustCompile(`Size: Discrete (\d+)x(\d+)`)
	intervalRegex := regexp.MustCompile(`Interval: Discrete (\d+\.\d+)s \((\d+\.\d+) fps\)`)

	for scanner.Scan() {
		line := scanner.Text()

		// Match format line
		if matches := formatRegex.FindStringSubmatch(line); matches != nil {
			if currentFormat != nil {
				formats = append(formats, *currentFormat)
			}
			// Start a new format entry
			currentFormat = &FormatInfo{
				Format: matches[2],
			}
		}

		// Match size line
		if matches := sizeRegex.FindStringSubmatch(line); matches != nil {
			width, _ := strconv.Atoi(matches[1])
			height, _ := strconv.Atoi(matches[2])

			// Initialize the size entry
			sizeInfo := SizeInfo{
				Width:  width,
				Height: height,
			}

			// Match FPS intervals for the current size
			for scanner.Scan() {
				line = scanner.Text()

				if fpsMatches := intervalRegex.FindStringSubmatch(line); fpsMatches != nil {
					fps, _ := strconv.ParseFloat(fpsMatches[2], 32)
					sizeInfo.FPS = append(sizeInfo.FPS, int(fps))
				} else {
					// Stop parsing FPS intervals when no more matches are found
					break
				}
			}
			// Add the size information to the current format
			currentFormat.Sizes = append(currentFormat.Sizes, sizeInfo)
		}
	}

	// Append the last format if present
	if currentFormat != nil {
		formats = append(formats, *currentFormat)
	}

	if err := scanner.Err(); err != nil {
		return nil, err
	}

	return formats, nil
}

func getFormatType(fmtStr string) v4l2.FourCCType {
	switch strings.ToLower(fmtStr) {
	case "jpeg":
		return v4l2.PixelFmtJPEG
	case "mpeg":
		return v4l2.PixelFmtMPEG
	case "mjpeg":
		return v4l2.PixelFmtMJPEG
	case "h264", "h.264":
		return v4l2.PixelFmtH264
	case "yuyv":
		return v4l2.PixelFmtYUYV
	case "rgb":
		return v4l2.PixelFmtRGB24
	}
	return v4l2.PixelFmtMPEG
}

// CaptureScreenshot captures a single frame from the video device and returns it as JPEG
// This function can be called even if the device is not currently streaming
// If the device is already capturing, it will use the current stream
// If not, it will temporarily open the device, capture one frame, and close it
func (i *Instance) CaptureScreenshot() ([]byte, error) {
	// If device is already capturing, grab a frame from the current stream
	if i.Capturing && i.frames_buff != nil {
		// Flush the first 5 frames as they may be blank/invalid
		for j := 0; j < 5; j++ {
			select {
			case <-i.frames_buff:
				// Discard this frame
			case <-time.After(1 * time.Second):
				// Timeout flushing, continue
			}
		}
		select {
		case frame := <-i.frames_buff:
			if len(frame) > 0 && isJPEG(frame) {
				return frame, nil
			}
			return nil, fmt.Errorf("invalid frame received from stream")
		case <-time.After(5 * time.Second):
			return nil, fmt.Errorf("timeout waiting for frame from active stream")
		}
	}

	// Device is not capturing, we need to temporarily open it
	devName := i.Config.VideoDeviceName

	// Check if the video device is a capture device
	isCaptureDev, err := CheckVideoCaptureDevice(devName)
	if err != nil {
		return nil, fmt.Errorf("failed to check video device: %w", err)
	}
	if !isCaptureDev {
		return nil, fmt.Errorf("device %s is not a video capture device", devName)
	}

	// Get supported resolutions and pick the first available one
	formats, err := GetV4L2FormatInfo(devName)
	if err != nil || len(formats) == 0 {
		return nil, fmt.Errorf("failed to get device formats: %w", err)
	}

	// Find the first MJPEG format with a valid resolution
	var width, height, fps int
	found := false
	for _, format := range formats {
		if strings.ToLower(format.Format) == "mjpeg" && len(format.Sizes) > 0 {
			// Pick the first available size
			size := format.Sizes[0]
			width = size.Width
			height = size.Height
			if len(size.FPS) > 0 {
				fps = size.FPS[0]
			} else {
				fps = 15 // Default fallback
			}
			found = true
			break
		}
	}

	if !found {
		return nil, fmt.Errorf("no MJPEG format found for device")
	}

	// Open the device temporarily with buffer for multiple frames
	camera, err := device.Open(devName,
		device.WithIOType(v4l2.IOTypeMMAP),
		device.WithPixFormat(v4l2.PixFormat{
			PixelFormat: v4l2.PixelFmtMJPEG,
			Width:       uint32(width),
			Height:      uint32(height),
			Field:       v4l2.FieldAny,
		}),
		device.WithFPS(uint32(fps)),
		device.WithBufferSize(2), // Buffer size for frame capture
	)
	if err != nil {
		return nil, fmt.Errorf("failed to open video device for screenshot: %w", err)
	}
	defer camera.Close()

	// Start capture
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := camera.Start(ctx); err != nil {
		return nil, fmt.Errorf("failed to start capture: %w", err)
	}

	// Get frames channel
	frames := camera.GetOutput()

	// Flush the first 5 frames as they may be blank/invalid
	log.Printf("Flushing first 5 frames from newly opened device...")
	for i := 0; i < 5; i++ {
		select {
		case <-frames:
			// Discard this frame
		case <-ctx.Done():
			return nil, fmt.Errorf("timeout flushing initial frames")
		}
	}

	// Now get the actual screenshot frame
	select {
	case frame := <-frames:
		if len(frame) > 0 && isJPEG(frame) {
			log.Printf("Screenshot captured successfully from device")
			return frame, nil
		}
		return nil, fmt.Errorf("invalid frame captured")
	case <-ctx.Done():
		return nil, fmt.Errorf("timeout capturing screenshot")
	}
}

// ServeScreenshot serves a single JPEG screenshot via HTTP
// This is useful for preview thumbnails in the web UI
func (i *Instance) ServeScreenshot(w http.ResponseWriter, req *http.Request) {
	// Capture screenshot
	screenshot, err := i.CaptureScreenshot()
	if err != nil {
		log.Printf("Failed to capture screenshot: %v", err)

		// Return a placeholder error image
		w.Header().Set("Content-Type", "image/jpeg")
		w.WriteHeader(http.StatusInternalServerError)

		// Create a simple error placeholder image
		img := image.NewRGBA(image.Rect(0, 0, 320, 240))
		// Fill with dark gray
		for y := 0; y < 240; y++ {
			for x := 0; x < 320; x++ {
				img.Set(x, y, image.Black)
			}
		}

		var buf bytes.Buffer
		if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 80}); err == nil {
			w.Write(buf.Bytes())
		}
		return
	}

	// Serve the screenshot
	w.Header().Set("Content-Type", "image/jpeg")
	w.Header().Set("Content-Length", fmt.Sprint(len(screenshot)))
	w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
	w.WriteHeader(http.StatusOK)
	w.Write(screenshot)
}
