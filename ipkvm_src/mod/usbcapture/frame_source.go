package usbcapture

/*
	frame_source.go

	Programmatic access to the captured MJPEG frames for consumers other
	than the HTTP MJPEG stream (currently the WebRTC H.264 pipeline in
	mod/webrtcstream). The capture device delivers frames on a single
	channel, so the same single-consumer / takeover semantics as
	ServeVideoStream apply: starting a new consumer kicks the previous one.
*/

import (
	"context"
	"errors"
	"log"
	"time"
)

// ErrStreamTakenOver is returned by StreamFramesTo when another client
// (MJPEG or WebRTC) takes over the video stream.
var ErrStreamTakenOver = errors.New("video stream taken over by another client")

func (i *Instance) beginVideoConsumer() (*videoConsumer, bool) {
	consumer := &videoConsumer{
		takeover: make(chan struct{}),
		done:     make(chan struct{}),
	}

	i.streamMu.Lock()
	previous := i.activeVideoConsumer
	i.activeVideoConsumer = consumer
	i.streamMu.Unlock()

	if previous != nil {
		close(previous.takeover)
		select {
		case <-previous.done:
		case <-time.After(3 * time.Second):
			log.Println("Previous video consumer did not exit before timeout, continuing takeover...")
		}
	}

	return consumer, previous != nil
}

func (i *Instance) endVideoConsumer(consumer *videoConsumer) {
	i.streamMu.Lock()
	if i.activeVideoConsumer == consumer {
		i.activeVideoConsumer = nil
	}
	i.streamMu.Unlock()
	close(consumer.done)
}

// GetCaptureDims returns the active capture width, height and frame rate.
func (i *Instance) GetCaptureDims() (width int, height int, fps int) {
	return i.width, i.height, i.fps
}

// StreamFramesTo delivers MJPEG frames to fn until ctx is cancelled, fn
// returns an error, or another client takes over the video stream. Like
// ServeVideoStream it counts as the single active video consumer and kicks
// out whoever was streaming before.
func (i *Instance) StreamFramesTo(ctx context.Context, fn func(frame []byte) error) error {
	if !i.Capturing || i.frames_buff == nil {
		return errors.New("video capture is not running")
	}

	consumer, tookOver := i.beginVideoConsumer()
	defer i.endVideoConsumer(consumer)
	if tookOver {
		log.Println("Another client is already connected, taking over the video stream...")
	}

	for {
		select {
		case <-ctx.Done():
			return nil
		case <-consumer.takeover:
			return ErrStreamTakenOver
		case frame, ok := <-i.frames_buff:
			if !ok {
				return errors.New("capture stream closed")
			}
			// Drain one buffered frame to keep latency low when the
			// consumer falls behind the capture rate.
			select {
			case f := <-i.frames_buff:
				frame = f
			default:
			}
			if len(frame) == 0 || !isJPEG(frame) {
				continue
			}
			if err := fn(frame); err != nil {
				return err
			}
		}
	}
}
