package usbcapture

import (
	"bufio"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/exec"
	"regexp"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

// upgrader is used to upgrade HTTP connections to WebSocket connections
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// ListCaptureDevices lists all available audio capture devices in the /dev/snd directory.
func ListCaptureDevices() ([]string, error) {
	files, err := os.ReadDir("/dev/snd")
	if err != nil {
		return nil, fmt.Errorf("failed to read /dev/snd: %w", err)
	}

	var captureDevs []string
	for _, file := range files {
		name := file.Name()
		if strings.HasPrefix(name, "pcm") && strings.HasSuffix(name, "c") {
			fullPath := "/dev/snd/" + name
			captureDevs = append(captureDevs, fullPath)
		}
	}

	return captureDevs, nil
}

// FindHDMICaptureCard searches for an HDMI capture card using the `arecord -l` command.
func FindHDMICapturePCMPath() (string, error) {
	out, err := exec.Command("arecord", "-l").Output()
	if err != nil {
		return "", fmt.Errorf("arecord -l failed: %w", err)
	}

	lines := strings.Split(string(out), "\n")
	for _, line := range lines {
		lower := strings.ToLower(line)
		if strings.Contains(lower, "ms2109") || strings.Contains(lower, "ms2130") {
			// Example line:
			// card 1: MS2109 [MS2109], device 0: USB Audio [USB Audio]
			parts := strings.Fields(line)
			var cardNum, devNum string
			for i := range parts {
				if parts[i] == "card" && i+1 < len(parts) {
					cardNum = parts[i+1][:1] // "1"
				}
				if parts[i] == "device" && i+1 < len(parts) {
					devNum = strings.TrimSuffix(parts[i+1], ":") // "0"
				}
			}

			if cardNum != "" && devNum != "" {
				return fmt.Sprintf("/dev/snd/pcmC%vD%vc", cardNum, devNum), nil
			}
		}
	}

	return "", fmt.Errorf("no HDMI capture card found")
}

// Convert a PCM device name to a hardware device name.
// Example: "pcmC1D0c" -> "hw:1,0"
func pcmDeviceToHW(dev string) (string, error) {
	// Regex to extract card and device numbers
	re := regexp.MustCompile(`pcmC(\d+)D(\d+)[cp]`)
	matches := re.FindStringSubmatch(dev)
	if len(matches) < 3 {
		return "", fmt.Errorf("invalid device format")
	}
	card := matches[1]
	device := matches[2]
	return fmt.Sprintf("hw:%s,%s", card, device), nil
}

func GetDefaultAudioConfig() *AudioConfig {
	return &AudioConfig{
		SampleRate:     48000,
		Channels:       2,
		BytesPerSample: 2,    // 16-bit
		FrameSize:      1920, // 1920 samples per frame = 40ms @ 48kHz
	}
}

func GetDefaultAudioDevice() string {
	//Check if the default ALSA device exists
	if _, err := os.Stat("/dev/snd/pcmC0D0c"); err == nil {
		return "/dev/snd/pcmC0D0c"
	}

	//If not, list all capture devices and return the first one
	devs, err := ListCaptureDevices()
	if err != nil || len(devs) == 0 {
		return ""
	}

	return devs[0]
}

// AudioStreamingHandler handles incoming WebSocket connections for audio streaming.
func (i *Instance) AudioStreamingHandler(w http.ResponseWriter, r *http.Request, devicePath string) {
	// Check if the request contains ?quality=low
	quality := r.URL.Query().Get("quality")
	qualityKey := []string{"low", "standard", "high"}
	selectedQuality := "standard"
	for _, q := range qualityKey {
		if quality == q {
			selectedQuality = q
			break
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Failed to upgrade to websocket:", err)
		return
	}
	defer conn.Close()

	if alsa_device_occupied(i.Config.AudioDeviceName) {
		//Another instance already running
		log.Println("Audio pipe already running, stopping previous instance")
		i.audiostopchan <- true
		retryCounter := 0
		for alsa_device_occupied(i.Config.AudioDeviceName) {
			time.Sleep(500 * time.Millisecond) //Wait a bit for the previous instance to stop
			retryCounter++
			if retryCounter > 5 {
				log.Println("Failed to stop previous audio instance")
				return
			}
		}
	}

	pcmdev := devicePath
	if pcmdev == "" {
		//Try finding the HDMI capture card automatically
		pcmdev, err = FindHDMICapturePCMPath()
		if err != nil {
			log.Println("Failed to find HDMI capture PCM path:", err)
			http.Error(w, "Internal Server Error", http.StatusInternalServerError)
			return
		}
	}

	log.Println("Found HDMI capture PCM path:", pcmdev)

	// Convert PCM device to hardware device name
	hwdev, err := pcmDeviceToHW(pcmdev)
	if err != nil {
		log.Println("Failed to convert PCM device to hardware device:", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	log.Println("Using hardware device:", hwdev)

	// Create a buffered reader to read audio data
	log.Println("Starting audio pipe with arecord...")

	// Start arecord with 48kHz, 16-bit, stereo
	cmd := exec.Command("arecord",
		"-f", "S16_LE", // Format: 16-bit little-endian
		"-r", fmt.Sprint(i.Config.AudioConfig.SampleRate),
		"-c", fmt.Sprint(i.Config.AudioConfig.Channels),
		"-D", hwdev, // Use the hardware device
	)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		log.Println("Failed to get arecord stdout pipe:", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	if err := cmd.Start(); err != nil {
		log.Println("Failed to start arecord:", err)
		http.Error(w, "Internal Server Error", http.StatusInternalServerError)
		return
	}

	reader := bufio.NewReader(stdout)
	bufferSize := i.Config.AudioConfig.FrameSize * i.Config.AudioConfig.Channels * i.Config.AudioConfig.BytesPerSample
	log.Printf("Buffer size: %d bytes (FrameSize: %d, Channels: %d, BytesPerSample: %d)",
		bufferSize, i.Config.AudioConfig.FrameSize, i.Config.AudioConfig.Channels, i.Config.AudioConfig.BytesPerSample)
	buf := make([]byte, bufferSize*2)

	// Start a goroutine to handle WebSocket messages
	log.Println("Listening for WebSocket messages...")
	go func() {
		_, msg, err := conn.ReadMessage()
		if err == nil {
			if string(msg) == "exit" {
				log.Println("Received exit command from client")
				i.audiostopchan <- true // Signal to stop the audio pipe
				return
			}
		}
	}()

	log.Println("Starting audio capture loop...")
	i.isAudioStreaming = true
	for {
		select {
		case <-i.audiostopchan:
			log.Println("Audio pipe stopped")
			goto DONE
		default:
			n, err := reader.Read(buf)
			if err != nil {
				log.Println("Read error:", err)
				if i.audiostopchan != nil {
					i.audiostopchan <- true // Signal to stop the audio pipe
				}
				goto DONE
			}

			if n == 0 {
				continue
			}

			downsampled := buf[:n] // Default to original buffer if no downsampling
			switch selectedQuality {
			case "high":
				// Keep original 48kHz stereo

			case "standard":
				// Downsample to 24kHz stereo
				downsampled = downsample48kTo24kStereo(buf[:n]) // Downsample to 24kHz stereo
				copy(buf, downsampled)                          // Copy downsampled data back into buf
				n = len(downsampled)                            // Update n to the new length
			case "low":
				downsampled = downsample48kTo16kStereo(buf[:n]) // Downsample to 16kHz stereo
				copy(buf, downsampled)                          // Copy downsampled data back into buf
				n = len(downsampled)                            // Update n to the new length
			}

			//Send only the bytes read to WebSocket
			err = conn.WriteMessage(websocket.BinaryMessage, downsampled[:n])
			if err != nil {
				log.Println("WebSocket send error:", err)
				goto DONE
			}
		}
	}

DONE:
	i.isAudioStreaming = false
	cmd.Process.Kill()
	log.Println("Audio pipe finished")
}

// StopAudioStreaming stops the audio streaming by sending a stop signal to the audio capture loop
func (i *Instance) StopAudioStreaming() {
	if !i.isAudioStreaming {
		return // Already stopped or not started
	}

	// Send stop signal to the audio capture loop
	select {
	case i.audiostopchan <- true:
		log.Println("Sent stop signal to audio streaming")
	default:
		// Channel might be full or already stopped
		log.Println("Audio streaming already stopping or stopped")
	}

	// Wait for audio streaming to actually stop
	maxWait := 10
	for i.isAudioStreaming && maxWait > 0 {
		time.Sleep(100 * time.Millisecond)
		maxWait--
	}

	if i.isAudioStreaming {
		log.Println("Warning: Audio streaming did not stop in time")
	}
}

// Downsample48kTo24kStereo downsamples a 48kHz stereo audio buffer to 24kHz.
// It assumes the input buffer is in 16-bit stereo format (2 bytes per channel).
// The output buffer will also be in 16-bit stereo format.
func downsample48kTo24kStereo(buf []byte) []byte {
	const frameSize = 4 // 2 bytes per channel × 2 channels
	if len(buf)%frameSize != 0 {
		// Trim incomplete frame (rare case)
		buf = buf[:len(buf)-len(buf)%frameSize]
	}

	out := make([]byte, 0, len(buf)/2)

	for i := 0; i < len(buf); i += frameSize * 2 {
		// Copy every other frame (drop 1 in 2)
		if i+frameSize <= len(buf) {
			out = append(out, buf[i:i+frameSize]...)
		}
	}

	return out
}

// Downsample48kTo16kStereo downsamples a 48kHz stereo audio buffer to 16kHz.
// It assumes the input buffer is in 16-bit stereo format (2 bytes per channel).
// The output buffer will also be in 16-bit stereo format.
func downsample48kTo16kStereo(buf []byte) []byte {
	const frameSize = 4 // 2 bytes per channel × 2 channels
	if len(buf)%frameSize != 0 {
		// Trim incomplete frame (rare case)
		buf = buf[:len(buf)-len(buf)%frameSize]
	}

	out := make([]byte, 0, len(buf)/3)

	for i := 0; i < len(buf); i += frameSize * 3 {
		// Copy every third frame (drop 2 in 3)
		if i+frameSize <= len(buf) {
			out = append(out, buf[i:i+frameSize]...)
		}
	}

	return out
}

func alsa_device_occupied(dev string) bool {
	f, err := os.OpenFile(dev, os.O_RDONLY|syscall.O_NONBLOCK, 0)
	if err != nil {
		//result <- true // Occupied or cannot open
		return true
	}
	f.Close()
	return false
}
