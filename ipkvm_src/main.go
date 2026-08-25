package main

/*
	DezKVM-Go - IP KVM mode

	Serves the HDMI capture card (MS2109 / MS2109S, MJPEG only) and its USB
	audio output to a browser, and forwards mouse & keyboard events from that
	browser over a WebSocket to the on-board CH340 -> CH9329 HID bridge.

	This is the network counterpart to the WebSerial based local KVM in ../src:
	there the browser talks to the hardware directly, here the Pi does and the
	browser only talks to the Pi.

	This file is part of DezKVM-Go.
	DezKVM-Go is free software: you can redistribute it and/or modify
	it under the terms of the GNU General Public License as published by
	the Free Software Foundation, either version 3 of the License, or
	(at your option) any later version.
*/

import (
	"context"
	"embed"
	"errors"
	"flag"
	"io/fs"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"aroz.org/dezkvm/ipkvm/mod/kvmhid"
	"aroz.org/dezkvm/ipkvm/mod/usbcapture"
)

//go:embed www
var embeddedWebFiles embed.FS

/* Command line flags */
var (
	flagVideoDevice = flag.String("video", "", "Video capture device node, e.g. /dev/video0 (auto detected when empty)")
	flagAudioDevice = flag.String("audio", "", "ALSA capture PCM node, e.g. /dev/snd/pcmC3D0c (auto detected when empty)")
	flagSerialPort  = flag.String("tty", "", "CH9329 serial port, e.g. /dev/ttyUSB0 (auto detected when empty)")
	flagBaudRate    = flag.Int("baud", 115200, "CH9329 serial baud rate")
	flagListen      = flag.String("port", ":8080", "HTTP listening address")
	flagWidth       = flag.Int("width", 0, "Capture width, 0 to use the largest the device supports")
	flagHeight      = flag.Int("height", 0, "Capture height, 0 to use the largest the device supports")
	flagFPS         = flag.Int("fps", 30, "Maximum capture frame rate")
	flagJPEGQuality = flag.Int("jpeg-quality", 0, "Re-encode frames at this JPEG quality (5-80) to save bandwidth, 0 to pass frames through untouched")
	flagScrollSens  = flag.Int("scroll-sensitivity", 2, "Mouse wheel step size sent to the CH9329 (1-126)")
	flagDevMode     = flag.Bool("dev", false, "Serve the web UI from the www/ folder on disk instead of the embedded copy")
	flagListDevices = flag.Bool("list-devices", false, "Print every detectable capture/serial device and exit")
	flagNoHID       = flag.Bool("no-hid", false, "Start without the HID controller (video/audio only)")
)

// Runtime holds the two hardware handles the HTTP layer needs.
type Runtime struct {
	Capture *usbcapture.Instance
	HID     *kvmhid.Controller
	Devices *DetectedDevices
}

func main() {
	flag.Parse()

	if *flagListDevices {
		PrintDetectionReport()
		return
	}

	log.SetFlags(log.Ldate | log.Ltime)
	log.Println("DezKVM-Go IP KVM starting up")

	/* Resolve the device nodes */
	devices, err := DetectDevices(*flagVideoDevice, *flagAudioDevice, *flagSerialPort)
	if err != nil {
		log.Fatalf("device detection failed: %v", err)
	}
	log.Printf("Video  : %s [%s]", devices.VideoNode, devices.VideoSource)
	log.Printf("Audio  : %s [%s]", orNone(devices.AudioNode), devices.AudioSource)
	log.Printf("Serial : %s [%s]", orNone(devices.SerialNode), devices.SerialSource)

	/* Video + audio capture */
	resolution, err := pickResolution(devices.VideoNode, *flagWidth, *flagHeight, *flagFPS)
	if err != nil {
		log.Fatalf("failed to pick a capture resolution: %v", err)
	}

	capture, err := usbcapture.NewInstance(&usbcapture.Config{
		VideoDeviceName: devices.VideoNode,
		AudioDeviceName: devices.AudioNode,
		AudioConfig:     usbcapture.GetDefaultAudioConfig(),
		VideoConfig: &usbcapture.VideoConfig{
			UseJPEGCompression:     *flagJPEGQuality > 0,
			JPEGCompressionQuality: *flagJPEGQuality,
		},
	})
	if err != nil {
		log.Fatalf("failed to open capture device: %v", err)
	}

	if err := capture.StartVideoCapture(resolution); err != nil {
		log.Fatalf("failed to start video capture: %v", err)
	}
	log.Printf("Capturing %s", capture.GetStreamInfo())

	/* HID controller */
	var hid *kvmhid.Controller
	if !*flagNoHID {
		if devices.SerialNode == "" {
			log.Println("WARNING: no CH340/CH341 serial port found, keyboard and mouse control is disabled")
		} else {
			hid = kvmhid.NewHIDController(&kvmhid.Config{
				PortName:          devices.SerialNode,
				BaudRate:          *flagBaudRate,
				ScrollSensitivity: clampScrollSensitivity(*flagScrollSens),
			})
			if err := hid.Connect(); err != nil {
				log.Printf("WARNING: failed to open %s: %v - keyboard and mouse control is disabled",
					devices.SerialNode, err)
				hid = nil
			} else {
				log.Printf("HID controller connected on %s @ %d baud", devices.SerialNode, *flagBaudRate)
			}
		}
	}

	runtime := &Runtime{
		Capture: capture,
		HID:     hid,
		Devices: devices,
	}

	/* HTTP server */
	server := &http.Server{
		Addr:    *flagListen,
		Handler: runtime.buildRouter(webUIHandler()),
	}

	go func() {
		log.Printf("Web interface listening on http://%s", *flagListen)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http server error: %v", err)
		}
	}()

	/* Wait for Ctrl-C / SIGTERM and release the hardware cleanly. Leaving the
	   V4L2 device or the ALSA PCM open makes the next start fail with EBUSY. */
	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
	<-stop
	log.Println("Shutting down...")

	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	server.Shutdown(shutdownCtx)

	if hid != nil {
		hid.Close()
	}
	capture.Close()
	log.Println("Bye")
}

// webUIHandler serves either the embedded www folder or the one on disk.
func webUIHandler() http.Handler {
	if *flagDevMode {
		log.Println("Development mode: serving the web UI from ./www")
		return http.FileServer(http.Dir("www"))
	}
	subFS, err := fs.Sub(embeddedWebFiles, "www")
	if err != nil {
		log.Fatalf("failed to open the embedded web UI: %v", err)
	}
	return http.FileServer(http.FS(subFS))
}

func orNone(value string) string {
	if value == "" {
		return "(none)"
	}
	return value
}

// clampScrollSensitivity keeps the wheel step inside the range the CH9329
// accepts (0x01 - 0x7E); values outside it wrap around into the opposite
// scroll direction.
func clampScrollSensitivity(value int) uint8 {
	if value < 1 {
		return 1
	}
	if value > 0x7E {
		return 0x7E
	}
	return uint8(value)
}
