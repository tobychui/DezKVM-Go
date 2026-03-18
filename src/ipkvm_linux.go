//go:build linux
// +build linux

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"aroz.org/dezkvm/usbkvm/mod/usbcapture"
	"aroz.org/dezkvm/usbkvm/mod/utils"
	"github.com/gorilla/websocket"
	"github.com/tarm/serial"
)

var (
	usbCaptureInstance        *usbcapture.Instance //HDMI capture card
	usbHidController          *serial.Port         //HID controller
	usbHidTtyBridgeDeviceName string               //HID TTY bridge device name (e.g. ttyUSB0)
	usbHidBaudrate            int                  //HID controller baudrate
)

func initializeIpKVMApis(mux *http.ServeMux) {
	mux.HandleFunc("/api/ipkvm/check", HandleIpKvmSupported)
	mux.HandleFunc("/api/ipkvm/status", HandleIpKVmStatus)
	mux.HandleFunc("/api/ipkvm/configure", HandleIpKvmConfigure)
	mux.HandleFunc("/api/ipkvm/disconnect", HandleIpKvmDisconnect)
	mux.HandleFunc("/api/ipkvm/device_list", HandleIpKvmDeviceList)
	mux.HandleFunc("/api/ipkvm/video", HandleKvmVideoStream)
	mux.HandleFunc("/api/ipkvm/hid", HandleHidWebsocket)
}

/*
	IP-KVM API Handlers
*/

// HandleIpKvmSupported returns a fixed true value for front-end to check if IP-KVM is supported
func HandleIpKvmSupported(w http.ResponseWriter, r *http.Request) {
	utils.SendJSONResponse(w, "true")
}

func HandleIpKVmStatus(w http.ResponseWriter, r *http.Request) {
	type StatusResponse struct {
		VideoCaptureConnected  bool   `json:"video_capture_connected"`
		HidControllerConnected bool   `json:"hid_controller_connected"`
		VideoDeviceName        string `json:"video_device_name,omitempty"`
		HidDeviceName          string `json:"hid_device_name,omitempty"`
		Baudrate               int    `json:"baudrate,omitempty"`
	}

	resp := StatusResponse{
		VideoCaptureConnected:  usbCaptureInstance != nil,
		HidControllerConnected: usbHidController != nil,
	}

	if usbCaptureInstance != nil {
		resp.VideoDeviceName = usbCaptureInstance.Config.VideoDeviceName
	}
	if usbHidController != nil {
		resp.HidDeviceName = usbHidTtyBridgeDeviceName
		resp.Baudrate = usbHidBaudrate
	}

	jsonData, err := json.Marshal(resp)
	if err != nil {
		utils.SendErrorResponse(w, "failed to marshal status response")
		return
	}
	utils.SendJSONResponse(w, string(jsonData))
}

func HandleIpKvmConfigure(w http.ResponseWriter, r *http.Request) {
	videoDevice, err := utils.PostPara(r, "video")
	if err != nil {
		utils.SendErrorResponse(w, "missing video device path")
		return
	}

	hidTtyDevice, err := utils.PostPara(r, "hid")
	if err != nil {
		utils.SendErrorResponse(w, "missing hid tty device path")
		return
	}

	hidTtyBaudrate, err := utils.PostInt(r, "baud")
	if err != nil {
		//Assume default baudrate if not provided
		hidTtyBaudrate = 115200
	}

	audioDevice, err := utils.PostPara(r, "audio")
	if err != nil {
		//Audio is optional, ignore if not provided
		log.Println("No audio device provided, continuing without audio capture")
		audioDevice = ""
	}

	//Check if the baudrate is supported
	if hidTtyBaudrate != 9600 && hidTtyBaudrate != 115200 {
		utils.SendErrorResponse(w, "unsupported baudrate")
		return
	}

	// Close existing instances if any
	if usbCaptureInstance != nil {
		usbCaptureInstance.Close()
		usbCaptureInstance = nil
	}
	if usbHidController != nil {
		usbHidController.Close()
		usbHidController = nil
	}

	// Construct full device paths
	videoDevPath := filepath.Join("/dev/", videoDevice)
	hidDevPath := filepath.Join("/dev/", hidTtyDevice)

	// Initialize USB capture instance
	usbCaptureInstance, err = usbcapture.NewInstance(&usbcapture.Config{
		VideoDeviceName: videoDevPath,
		AudioDeviceName: audioDevice,
		AudioConfig:     usbcapture.GetDefaultAudioConfig(),
	})
	if err != nil {
		usbCaptureInstance = nil
		utils.SendErrorResponse(w, "failed to initialize video capture: "+err.Error())
		return
	}

	time.Sleep(300 * time.Millisecond)

	//Start capture
	err = usbCaptureInstance.StartVideoCapture(&usbcapture.CaptureResolution{
		Width:  1920,
		Height: 1080,
		FPS:    25,
	})
	if err != nil {
		log.Println("Failed to start video capture: " + err.Error())
		utils.SendErrorResponse(w, "failed to start remote screen capture")
		return
	}

	// Initialize HID controller
	usbHidController, err = serial.OpenPort(&serial.Config{
		Name: hidDevPath,
		Baud: hidTtyBaudrate,
	})
	if err != nil {
		usbHidController = nil
		// Clean up video capture instance if HID initialization fails
		if usbCaptureInstance != nil {
			usbCaptureInstance.Close()
			usbCaptureInstance = nil
		}
		utils.SendErrorResponse(w, "failed to initialize HID controller: "+err.Error())
		return
	}

	usbHidTtyBridgeDeviceName = hidTtyDevice
	usbHidBaudrate = hidTtyBaudrate

	utils.SendOK(w)
}

func HandleIpKvmDisconnect(w http.ResponseWriter, r *http.Request) {
	if usbCaptureInstance != nil {
		usbCaptureInstance.Close()
		usbCaptureInstance = nil
	}
	if usbHidController != nil {
		usbHidController.Close()
		usbHidController = nil
	}
	utils.SendOK(w)
}

func HandleIpKvmDeviceList(w http.ResponseWriter, r *http.Request) {
	type DeviceInfo struct {
		Name       string `json:"name"`
		Path       string `json:"path"`
		Properties string `json:"properties"`
	}

	type DeviceListResponse struct {
		VideoDev []DeviceInfo `json:"video_dev"`
		TtyDev   []DeviceInfo `json:"tty_dev"`
	}

	resp := DeviceListResponse{
		VideoDev: []DeviceInfo{},
		TtyDev:   []DeviceInfo{},
	}

	// List video capture devices from /dev/video*
	videoDevices, _ := filepath.Glob("/dev/video*")
	for _, devPath := range videoDevices {
		devName := filepath.Base(devPath)
		isCapture, err := usbcapture.CheckVideoCaptureDevice(devPath)
		if err != nil || !isCapture {
			continue
		}
		// Get format info as properties
		properties := ""
		formats, err := usbcapture.GetV4L2FormatInfo(devPath)
		if err == nil {
			var parts []string
			for _, f := range formats {
				for _, s := range f.Sizes {
					parts = append(parts, fmt.Sprintf("%s %dx%d", f.Format, s.Width, s.Height))
				}
			}
			properties = strings.Join(parts, ", ")
		}

		resp.VideoDev = append(resp.VideoDev, DeviceInfo{
			Name:       devName,
			Path:       devPath,
			Properties: properties,
		})
	}

	// List USB serial / TTY devices from /dev/ttyUSB* and /dev/ttyACM*
	ttyPatterns := []string{"/dev/ttyUSB*", "/dev/ttyACM*"}
	for _, pattern := range ttyPatterns {
		matches, _ := filepath.Glob(pattern)
		for _, devPath := range matches {
			devName := filepath.Base(devPath)
			// Check that the device file exists and is accessible
			if _, err := os.Stat(devPath); err != nil {
				continue
			}

			// Try to read the product name from sysfs for USB serial devices
			properties := ""
			// /dev/ttyUSB0 -> ttyUSB0, look in /sys/class/tty/ttyUSB0/device/../product
			sysPath := fmt.Sprintf("/sys/class/tty/%s/device/../product", devName)
			if data, err := os.ReadFile(sysPath); err == nil {
				properties = strings.TrimSpace(string(data))
			}

			resp.TtyDev = append(resp.TtyDev, DeviceInfo{
				Name:       devName,
				Path:       devPath,
				Properties: properties,
			})
		}
	}

	jsonData, err := json.Marshal(resp)
	if err != nil {
		utils.SendErrorResponse(w, "failed to marshal device list")
		return
	}
	utils.SendJSONResponse(w, string(jsonData))
}

func HandleKvmVideoStream(w http.ResponseWriter, r *http.Request) {
	if usbCaptureInstance == nil {
		log.Println("Video capture not configured")
		http.Error(w, "video capture not configured", http.StatusBadRequest)
		return
	}

	// Send MJPEG stream
	usbCaptureInstance.ServeVideoStream(w, r)

}

var wsUpgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

func HandleHidWebsocket(w http.ResponseWriter, r *http.Request) {
	if usbHidController == nil {
		http.Error(w, "HID controller not configured", http.StatusBadRequest)
		return
	}

	// Capture local reference to prevent nil pointer dereference if disconnected
	serialPort := usbHidController

	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("WebSocket upgrade failed:", err)
		return
	}
	defer conn.Close()

	// Serial → WebSocket: read from serial port and forward to WebSocket
	done := make(chan struct{})
	go func() {
		defer close(done)
		buf := make([]byte, 8) //Must be a small buffer to reduce latency
		for {
			// Check if serial port is still valid
			if serialPort == nil {
				return
			}

			n, err := serialPort.Read(buf)
			if err != nil {
				// Exit gracefully if port was closed (expected during disconnect)
				if strings.Contains(err.Error(), "file already closed") {
					return
				}
				log.Println("Serial read error:", err)
				// Close WebSocket to trigger cleanup
				conn.Close()
				return
			}
			if n > 0 {
				if err := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); err != nil {
					log.Println("WebSocket write error:", err)
					return
				}
			}
		}
	}()

	// WebSocket → Serial: read from WebSocket and forward to serial port
	for {
		_, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Println("WebSocket read error:", err)
			}
			break
		}
		// Check if serial port is still valid before writing
		if serialPort != nil {
			if _, err := serialPort.Write(message); err != nil {
				log.Println("Serial write error:", err)
				break
			}
		} else {
			log.Println("Serial port no longer available")
			break
		}
	}

	<-done
}
