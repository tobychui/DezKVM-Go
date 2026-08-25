package usbcapture

import (
	"context"
	"sync"

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
	// MJPEG settings
	UseJPEGCompression     bool // Whether to use JPEG compression (if not using H264)
	JPEGCompressionQuality int  // JPEG compression quality (5-80), higher means better quality and larger size

	// H264 settings (WIP)
	UseH264     bool   // Whether to use H264 encoding
	H264Profile string // H264 profile, e.g., 480p, 720p, 1080p
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
	streamMu             sync.Mutex
	activeVideoConsumer  *videoConsumer
}

type videoConsumer struct {
	takeover chan struct{}
	done     chan struct{}
}
