package usbcapture

import (
	"context"

	"github.com/vladimirvivien/go4vl/device"
	"github.com/vladimirvivien/go4vl/v4l2"
)

// The capture resolution to open video device
type CaptureResolution struct {
	Width  int
	Height int
	FPS    int
}

type AudioConfig struct {
	SampleRate     int
	Channels       int
	FrameSize      int
	BytesPerSample int
}

type VideoConfig struct {
	UseH264 bool   // Whether to use H264 encoding
	Profile string // H264 profile, e.g., 480p, 720p, 1080p
}

type Config struct {
	VideoDeviceName string       // The video device name, e.g., /dev/video0
	AudioDeviceName string       // The audio device name, e.g., /dev/snd
	AudioConfig     *AudioConfig // The audio configuration
	VideoConfig     *VideoConfig // The video configuration
}

type Instance struct {
	/* Runtime configuration */
	Config               *Config
	SupportedResolutions []FormatInfo //The supported resolutions of the video device
	Capturing            bool

	/* Internals */
	/* Video capture device */
	camera             *device.Device
	cameraStartContext context.CancelFunc
	frames_buff        <-chan []byte
	pixfmt             v4l2.FourCCType
	width              int
	height             int
	fps                int
	streamInfo         string

	/* audio capture device */
	isAudioStreaming bool      // Whether audio is currently being captured
	audiostopchan    chan bool // Channel to stop audio capture

	/* Concurrent access */
	accessCount       int       // The number of current access, in theory each instance should at most have 1 access
	videoTakeoverChan chan bool // Channel to signal video takeover request
}
