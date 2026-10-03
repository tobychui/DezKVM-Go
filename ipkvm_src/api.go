package main

/*
	api.go

	HTTP routing and the small JSON API the web UI drives. There is no
	authentication and no server side configuration store: this is the minimum
	viable IP KVM, every user preference lives in the browser's localStorage.
*/

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strconv"
	"sync"

	"aroz.org/dezkvm/ipkvm/mod/usbcapture"
)

// resolutionMu serialises resolution changes: StopVideoCapture followed by
// StartVideoCapture is not safe to run twice concurrently on one V4L2 device.
var resolutionMu sync.Mutex

func (r *Runtime) buildRouter(webUI http.Handler) http.Handler {
	mux := http.NewServeMux()

	/* Media streams */
	mux.HandleFunc("/api/video/stream", r.Capture.ServeVideoStream)
	mux.HandleFunc("/api/video/screenshot", r.Capture.ServeScreenshot)
	mux.HandleFunc("/ws/audio", func(w http.ResponseWriter, req *http.Request) {
		if r.Devices.AudioNode == "" {
			http.Error(w, "no audio capture device available", http.StatusServiceUnavailable)
			return
		}
		r.Capture.AudioStreamingHandler(w, req, r.Devices.AudioNode)
	})

	/* HID control */
	mux.HandleFunc("/ws/hid", func(w http.ResponseWriter, req *http.Request) {
		if r.HID == nil {
			http.Error(w, "HID controller not available", http.StatusServiceUnavailable)
			return
		}
		r.HID.HIDWebSocketHandler(w, req)
	})
	mux.HandleFunc("/api/hid/reset", r.handleHIDReset)
	mux.HandleFunc("/api/hid/jiggler", r.handleJiggler)

	/* Status & capture control */
	mux.HandleFunc("/api/status", r.handleStatus)
	mux.HandleFunc("/api/video/resolutions", r.handleResolutions)
	mux.HandleFunc("/api/video/resolution", r.handleSetResolution)

	/* Web UI */
	mux.Handle("/", webUI)

	return noCacheAPI(mux)
}

// noCacheAPI stops browsers from caching API responses; the UI polls a few of
// these and a cached /api/status would freeze the on-screen indicators.
func noCacheAPI(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		if len(req.URL.Path) >= 5 && req.URL.Path[:5] == "/api/" {
			w.Header().Set("Cache-Control", "no-store")
		}
		next.ServeHTTP(w, req)
	})
}

/* ---------------------------------------------------------------------------
   Handlers
--------------------------------------------------------------------------- */

type statusResponse struct {
	VideoDevice  string `json:"video_device"`
	AudioDevice  string `json:"audio_device"`
	SerialDevice string `json:"serial_device"`

	VideoSource  string `json:"video_source"`
	AudioSource  string `json:"audio_source"`
	SerialSource string `json:"serial_source"`

	Capturing      bool   `json:"capturing"`
	AudioAvailable bool   `json:"audio_available"`
	AudioStreaming bool   `json:"audio_streaming"`
	HIDAvailable   bool   `json:"hid_available"`
	JigglerEnabled bool   `json:"jiggler_enabled"`
	StreamInfo     string `json:"stream_info"`
	Width          int    `json:"width"`
	Height         int    `json:"height"`
	FPS            int    `json:"fps"`
}

func (r *Runtime) handleStatus(w http.ResponseWriter, req *http.Request) {
	width, height, fps := r.Capture.GetCaptureDims()
	status := statusResponse{
		VideoDevice:    r.Devices.VideoNode,
		AudioDevice:    r.Devices.AudioNode,
		SerialDevice:   r.Devices.SerialNode,
		VideoSource:    r.Devices.VideoSource,
		AudioSource:    r.Devices.AudioSource,
		SerialSource:   r.Devices.SerialSource,
		Capturing:      r.Capture.IsCapturing(),
		AudioAvailable: r.Devices.AudioNode != "",
		AudioStreaming: r.Capture.IsAudioStreaming(),
		HIDAvailable:   r.HID != nil,
		StreamInfo:     r.Capture.GetStreamInfo(),
		Width:          width,
		Height:         height,
		FPS:            fps,
	}
	if r.HID != nil {
		status.JigglerEnabled = r.HID.IsMouseJigglerEnabled()
	}
	writeJSON(w, http.StatusOK, status)
}

type resolutionEntry struct {
	Width  int   `json:"width"`
	Height int   `json:"height"`
	FPS    []int `json:"fps"`
}

func (r *Runtime) handleResolutions(w http.ResponseWriter, req *http.Request) {
	sizes, err := mjpegSizes(r.Devices.VideoNode)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}

	entries := make([]resolutionEntry, 0, len(sizes))
	for _, size := range sizes {
		rates := selectableFPS(size.FPS)
		if len(rates) == 0 {
			// Nothing on this size a browser can keep up with
			continue
		}
		entries = append(entries, resolutionEntry{
			Width:  size.Width,
			Height: size.Height,
			FPS:    rates,
		})
	}
	writeJSON(w, http.StatusOK, entries)
}

// maxSelectableFPS caps what the resolution picker offers. The capture card
// advertises 50 and 60fps, but a browser's MJPEG decoder cannot keep up with
// either at useful resolutions and the bitrate saturates the link long before
// the extra frames arrive (1080p60 is ~55Mbps). Those modes are hidden rather
// than removed: POSTing one to /api/video/resolution still works.
const maxSelectableFPS = 30

func selectableFPS(rates []int) []int {
	filtered := make([]int, 0, len(rates))
	for _, rate := range rates {
		if rate <= maxSelectableFPS {
			filtered = append(filtered, rate)
		}
	}
	return filtered
}

func (r *Runtime) handleSetResolution(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("POST required"))
		return
	}

	width, err := intParam(req, "width")
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	height, err := intParam(req, "height")
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}
	fps, err := intParam(req, "fps")
	if err != nil {
		writeError(w, http.StatusBadRequest, err)
		return
	}

	resolutionMu.Lock()
	defer resolutionMu.Unlock()

	log.Printf("Changing capture resolution to %dx%d @ %dfps", width, height, fps)
	err = r.Capture.ChangeResolution(&usbcapture.CaptureResolution{
		Width:  width,
		Height: height,
		FPS:    fps,
	})
	if err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":          true,
		"stream_info": r.Capture.GetStreamInfo(),
	})
}

func (r *Runtime) handleHIDReset(w http.ResponseWriter, req *http.Request) {
	if req.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, fmt.Errorf("POST required"))
		return
	}
	if r.HID == nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Errorf("HID controller not available"))
		return
	}

	if err := r.HID.ChipSoftReset(); err != nil {
		writeError(w, http.StatusInternalServerError, err)
		return
	}
	// A soft reset leaves the chip's modifier state undefined; clearing it
	// avoids a phantom Ctrl or Shift sticking on the remote machine.
	r.HID.UnsetModifierKeysWithRetry(3)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

func (r *Runtime) handleJiggler(w http.ResponseWriter, req *http.Request) {
	if r.HID == nil {
		writeError(w, http.StatusServiceUnavailable, fmt.Errorf("HID controller not available"))
		return
	}

	if enable := req.URL.Query().Get("enable"); enable != "" {
		if enable == "true" || enable == "1" {
			r.HID.StartMouseJiggler()
		} else {
			r.HID.StopMouseJiggler()
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"enabled": r.HID.IsMouseJigglerEnabled()})
}

/* ---------------------------------------------------------------------------
   Helpers
--------------------------------------------------------------------------- */

func intParam(req *http.Request, name string) (int, error) {
	raw := req.URL.Query().Get(name)
	if raw == "" {
		return 0, fmt.Errorf("missing parameter %s", name)
	}
	value, err := strconv.Atoi(raw)
	if err != nil {
		return 0, fmt.Errorf("invalid value for %s: %s", name, raw)
	}
	return value, nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(payload); err != nil {
		log.Printf("failed to write JSON response: %v", err)
	}
}

func writeError(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}
