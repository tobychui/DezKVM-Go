package usbcapture

import (
	"fmt"
	"os"
	"time"
)

// NewInstance creates a new video capture instance
func NewInstance(config *Config) (*Instance, error) {
	if config == nil {
		return nil, fmt.Errorf("config cannot be nil")
	}

	//Check if the video device exists
	if _, err := os.Stat(config.VideoDeviceName); os.IsNotExist(err) {
		return nil, fmt.Errorf("video device %s does not exist", config.VideoDeviceName)
	} else if err != nil {
		return nil, fmt.Errorf("failed to check video device: %w", err)
	}

	//Check if the device file actualy points to a video device
	isValidDevice, err := CheckVideoCaptureDevice(config.VideoDeviceName)
	if err != nil {
		return nil, fmt.Errorf("failed to check video device: %w", err)
	}

	if !isValidDevice {
		return nil, fmt.Errorf("device %s is not a video capture device", config.VideoDeviceName)
	}

	//Get the supported resolutions of the video device
	formatInfo, err := GetV4L2FormatInfo(config.VideoDeviceName)
	if err != nil {
		return nil, fmt.Errorf("failed to get video device format info: %w", err)
	}

	if len(formatInfo) == 0 {
		return nil, fmt.Errorf("no supported formats found for device %s", config.VideoDeviceName)
	}

	return &Instance{
		Config:               config,
		Capturing:            false,
		SupportedResolutions: formatInfo,

		// Videos
		camera:     nil,
		pixfmt:     0,
		width:      0,
		height:     0,
		streamInfo: "",

		//Audio
		audiostopchan: make(chan bool, 1),

		// Access control
		videoTakeoverChan: make(chan bool, 1),
		accessCount:       0,
	}, nil
}

// GetStreamInfo returns the stream information string
func (i *Instance) GetStreamInfo() string {
	return i.streamInfo
}

// IsCapturing checks if the camera is currently capturing video
func (i *Instance) IsCapturing() bool {
	return i.Capturing
}

// IsAudioStreaming checks if the audio is currently being captured
func (i *Instance) IsAudioStreaming() bool {
	return i.isAudioStreaming
}

// Close closes the camera device and releases resources
func (i *Instance) Close() error {
	if i.camera != nil {
		i.StopVideoCapture()
	}

	if i.isAudioStreaming {
		i.StopAudioStreaming()
	}
	return nil
}

// GetSupportedResolutions returns the supported resolutions of the capture device
func (i *Instance) GetSupportedResolutions() []FormatInfo {
	var filtered []FormatInfo
	for _, res := range i.SupportedResolutions {
		var filteredSizes []SizeInfo
		for _, size := range res.Sizes {
			var filteredFPS []int
			for _, fps := range size.FPS {
				if fps >= 10 && fps < 60 {
					filteredFPS = append(filteredFPS, fps)
				}
			}
			if len(filteredFPS) > 0 {
				filteredSizes = append(filteredSizes, SizeInfo{
					Width:  size.Width,
					Height: size.Height,
					FPS:    filteredFPS,
				})
			}
		}
		if len(filteredSizes) > 0 {
			filtered = append(filtered, FormatInfo{
				Format: res.Format,
				Sizes:  filteredSizes,
			})
		}
	}
	return filtered
}

// ChangeResolution stops the current capture, changes the resolution, and restarts the capture
func (i *Instance) ChangeResolution(newResolution *CaptureResolution) error {
	if newResolution == nil {
		return fmt.Errorf("new resolution cannot be nil")
	}

	// Validate that the new resolution is supported
	resolutionIsSupported, err := deviceSupportResolution(i.Config.VideoDeviceName, newResolution)
	if err != nil {
		return fmt.Errorf("failed to validate resolution: %w", err)
	}
	if !resolutionIsSupported {
		return fmt.Errorf("resolution %dx%d @ %d fps is not supported by this device",
			newResolution.Width, newResolution.Height, newResolution.FPS)
	}

	// Stop the audio streaming if active
	if i.isAudioStreaming {
		i.StopAudioStreaming()
	}

	// Stop the current capture
	err = i.StopVideoCapture()
	if err != nil {
		return fmt.Errorf("failed to stop capture: %w", err)
	}

	// Additional delay to ensure device is fully released
	time.Sleep(500 * time.Millisecond)

	// Start capture with the new resolution, retry up to 3 times
	for attempt := 0; attempt < 3; attempt++ {
		err = i.StartVideoCapture(newResolution)
		if err == nil {
			break
		}
		if attempt < 2 {
			// Sometime shared video buffer devices need a bit more time to reinitialize
			fmt.Println("Error: ", err, " - Retrying to start capture with new resolution...")
			time.Sleep(500 * time.Millisecond) // Additional delay between retries
		}
	}
	if err != nil {
		return fmt.Errorf("failed to start capture with new resolution after 3 attempts: %w", err)
	}

	return nil
}
