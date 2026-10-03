package main

/*
	device.go

	Device node auto detection.

	The kernel hands out /dev/videoN, /dev/snd/pcmCxDyc and /dev/ttyUSBn in
	probe order, so the numbers shift whenever the Pi boots with a different
	set of USB devices attached. Rather than hard coding them we walk sysfs
	and match on the USB vendor/product IDs of the two chips a DezKVM board
	carries:

	  - MacroSilicon MS2109 / MS2109S / MS2130 HDMI capture card
	    (video capture + USB audio, exposed as one USB device)
	  - WCH CH340 / CH341 USB-serial bridge that fronts the CH9329 HID chip

	The capture card exposes both a video and an audio interface on the *same*
	USB device, so once the video node is found the matching PCM capture node
	is simply the sound card hanging off the same USB device directory. The
	CH341 is a separate USB device, but on a DezKVM board it sits on the same
	internal hub as the capture card, which is used as a tie breaker when more
	than one CH341 is plugged in.
*/

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const sysUSBDevices = "/sys/bus/usb/devices"

// usbID is a USB vendor/product pair, lowercase hex without the 0x prefix.
type usbID struct {
	VID string
	PID string
}

// knownCaptureCards are the HDMI capture chips shipped on DezKVM boards.
// 345f is the VID MacroSilicon uses on newer (MS2109S / MS2130) silicon,
// 534d is the one used by the original MS2109 batches.
var knownCaptureCards = []usbID{
	{"345f", "2109"}, // MS2109S
	{"345f", "2130"}, // MS2130
	{"534d", "2109"}, // MS2109
	{"534d", "2130"}, // MS2130
}

// knownSerialBridges are the WCH USB-serial chips that front the CH9329.
var knownSerialBridges = []usbID{
	{"1a86", "7523"}, // CH340
	{"1a86", "5523"}, // CH341
	{"1a86", "7522"}, // CH340K
	{"1a86", "55d4"}, // CH9102
}

// DetectedDevices is the outcome of a detection pass, with each field either
// taken from a command line flag or discovered by walking sysfs.
type DetectedDevices struct {
	VideoNode  string // e.g. /dev/video0
	AudioNode  string // e.g. /dev/snd/pcmC3D0c
	SerialNode string // e.g. /dev/ttyUSB0

	VideoSource  string // how the node was picked: "flag" or a description
	AudioSource  string
	SerialSource string
}

/* ---------------------------------------------------------------------------
   sysfs helpers
--------------------------------------------------------------------------- */

// readSysAttr reads a single-line sysfs attribute, trimmed.
func readSysAttr(path string) string {
	data, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(data))
}

// usbDeviceOf walks up from a sysfs path (usually a USB *interface* directory
// such as .../1-1.3.2:1.0) until it reaches the USB *device* directory that
// carries the idVendor / idProduct attributes. It returns the absolute sysfs
// path of that directory, or "" if the path does not belong to a USB device.
func usbDeviceOf(sysPath string) string {
	current, err := filepath.EvalSymlinks(sysPath)
	if err != nil {
		return ""
	}
	for current != "/" && current != "." && current != "" {
		if readSysAttr(filepath.Join(current, "idVendor")) != "" &&
			readSysAttr(filepath.Join(current, "idProduct")) != "" {
			return current
		}
		current = filepath.Dir(current)
	}
	return ""
}

// usbIDOf returns the vendor and product ID of a USB device sysfs directory.
func usbIDOf(usbDevPath string) usbID {
	return usbID{
		VID: strings.ToLower(readSysAttr(filepath.Join(usbDevPath, "idVendor"))),
		PID: strings.ToLower(readSysAttr(filepath.Join(usbDevPath, "idProduct"))),
	}
}

func (id usbID) matches(list []usbID) bool {
	for _, known := range list {
		if id.VID == known.VID && id.PID == known.PID {
			return true
		}
	}
	return false
}

func (id usbID) String() string {
	if id.VID == "" {
		return "unknown"
	}
	return id.VID + ":" + id.PID
}

// usbBusPath turns a USB device sysfs directory into its bus path name,
// e.g. /sys/devices/.../usb1/1-1/1-1.3/1-1.3.2 -> "1-1.3.2".
func usbBusPath(usbDevPath string) string {
	return filepath.Base(usbDevPath)
}

// usbParentHub returns the bus path of the hub a device is plugged into,
// e.g. "1-1.3.2" -> "1-1.3". Returns "" for root ports.
func usbParentHub(busPath string) string {
	idx := strings.LastIndex(busPath, ".")
	if idx < 0 {
		return ""
	}
	return busPath[:idx]
}

/* ---------------------------------------------------------------------------
   Video capture node
--------------------------------------------------------------------------- */

var videoNodeRegex = regexp.MustCompile(`^video(\d+)$`)

// videoCandidate is a /dev/videoN node together with the USB device it hangs off.
type videoCandidate struct {
	Node     string // /dev/videoN
	Name     string // the v4l2 friendly name
	USBPath  string // sysfs path of the owning USB device, "" if not USB
	USBID    usbID
	IsKnown  bool // VID/PID is a known capture chip
	HasMJPEG bool // node advertises an MJPEG capture format
}

// listVideoCandidates enumerates every /dev/videoN node that can actually
// deliver MJPEG frames, annotated with its USB identity.
func listVideoCandidates() []videoCandidate {
	entries, err := os.ReadDir("/sys/class/video4linux")
	if err != nil {
		return nil
	}

	var candidates []videoCandidate
	for _, entry := range entries {
		if !videoNodeRegex.MatchString(entry.Name()) {
			continue
		}
		classPath := filepath.Join("/sys/class/video4linux", entry.Name())
		node := "/dev/" + entry.Name()
		if _, err := os.Stat(node); err != nil {
			continue
		}

		candidate := videoCandidate{
			Node: node,
			Name: readSysAttr(filepath.Join(classPath, "name")),
		}
		if usbDev := usbDeviceOf(filepath.Join(classPath, "device")); usbDev != "" {
			candidate.USBPath = usbDev
			candidate.USBID = usbIDOf(usbDev)
			candidate.IsKnown = candidate.USBID.matches(knownCaptureCards)
		}

		// A UVC capture card exposes two nodes: the streaming node and a
		// metadata node. Only the streaming one lists an MJPEG format, so
		// this doubles as the filter that picks the right one.
		candidate.HasMJPEG = nodeSupportsMJPEG(node)
		if !candidate.HasMJPEG {
			continue
		}
		candidates = append(candidates, candidate)
	}

	// Known capture chips first, then by node number so the result is stable.
	sort.SliceStable(candidates, func(a, b int) bool {
		if candidates[a].IsKnown != candidates[b].IsKnown {
			return candidates[a].IsKnown
		}
		return candidates[a].Node < candidates[b].Node
	})
	return candidates
}

/* ---------------------------------------------------------------------------
   Audio capture node
--------------------------------------------------------------------------- */

var soundCardRegex = regexp.MustCompile(`^card(\d+)$`)
var pcmCaptureRegex = regexp.MustCompile(`^pcmC(\d+)D(\d+)c$`)

// audioCandidate is an ALSA capture PCM node with its USB identity.
type audioCandidate struct {
	Node    string // /dev/snd/pcmCxDyc
	CardID  string // ALSA card id, e.g. U0x345f0x2109
	USBPath string
	USBID   usbID
	IsKnown bool
}

// listAudioCandidates enumerates the ALSA capture PCM nodes on the system.
func listAudioCandidates() []audioCandidate {
	entries, err := os.ReadDir("/sys/class/sound")
	if err != nil {
		return nil
	}

	var candidates []audioCandidate
	for _, entry := range entries {
		if !soundCardRegex.MatchString(entry.Name()) {
			continue
		}
		cardPath := filepath.Join("/sys/class/sound", entry.Name())

		// Each capture PCM shows up as a pcmCxDyc subdirectory of the card.
		pcms, err := os.ReadDir(cardPath)
		if err != nil {
			continue
		}
		for _, pcm := range pcms {
			if !pcmCaptureRegex.MatchString(pcm.Name()) {
				continue
			}
			node := "/dev/snd/" + pcm.Name()
			if _, err := os.Stat(node); err != nil {
				continue
			}
			candidate := audioCandidate{
				Node:   node,
				CardID: readSysAttr(filepath.Join(cardPath, "id")),
			}
			if usbDev := usbDeviceOf(filepath.Join(cardPath, "device")); usbDev != "" {
				candidate.USBPath = usbDev
				candidate.USBID = usbIDOf(usbDev)
				candidate.IsKnown = candidate.USBID.matches(knownCaptureCards)
			}
			candidates = append(candidates, candidate)
		}
	}

	sort.SliceStable(candidates, func(a, b int) bool {
		if candidates[a].IsKnown != candidates[b].IsKnown {
			return candidates[a].IsKnown
		}
		return candidates[a].Node < candidates[b].Node
	})
	return candidates
}

/* ---------------------------------------------------------------------------
   Serial (CH340/CH341 -> CH9329) node
--------------------------------------------------------------------------- */

var ttyUSBRegex = regexp.MustCompile(`^tty(USB|ACM)\d+$`)

type serialCandidate struct {
	Node    string // /dev/ttyUSBn
	USBPath string
	USBID   usbID
	IsKnown bool
}

// listSerialCandidates enumerates USB serial ports with their USB identity.
func listSerialCandidates() []serialCandidate {
	entries, err := os.ReadDir("/sys/class/tty")
	if err != nil {
		return nil
	}

	var candidates []serialCandidate
	for _, entry := range entries {
		if !ttyUSBRegex.MatchString(entry.Name()) {
			continue
		}
		node := "/dev/" + entry.Name()
		if _, err := os.Stat(node); err != nil {
			continue
		}
		candidate := serialCandidate{Node: node}
		if usbDev := usbDeviceOf(filepath.Join("/sys/class/tty", entry.Name(), "device")); usbDev != "" {
			candidate.USBPath = usbDev
			candidate.USBID = usbIDOf(usbDev)
			candidate.IsKnown = candidate.USBID.matches(knownSerialBridges)
		}
		candidates = append(candidates, candidate)
	}

	sort.SliceStable(candidates, func(a, b int) bool {
		if candidates[a].IsKnown != candidates[b].IsKnown {
			return candidates[a].IsKnown
		}
		return candidates[a].Node < candidates[b].Node
	})
	return candidates
}

/* ---------------------------------------------------------------------------
   Detection entry point
--------------------------------------------------------------------------- */

// DetectDevices resolves the three device nodes the IP KVM needs. Any of the
// override arguments that is non-empty is taken as-is; the rest are detected.
func DetectDevices(videoOverride, audioOverride, serialOverride string) (*DetectedDevices, error) {
	result := &DetectedDevices{}

	/* Video */
	var captureUSBPath string
	if videoOverride != "" {
		if _, err := os.Stat(videoOverride); err != nil {
			return nil, fmt.Errorf("video device %s not found: %w", videoOverride, err)
		}
		result.VideoNode = videoOverride
		result.VideoSource = "flag"
		// Still resolve the USB device so audio detection can be anchored to it.
		if name := filepath.Base(videoOverride); videoNodeRegex.MatchString(name) {
			captureUSBPath = usbDeviceOf(filepath.Join("/sys/class/video4linux", name, "device"))
		}
	} else {
		candidates := listVideoCandidates()
		if len(candidates) == 0 {
			return nil, fmt.Errorf("no MJPEG capable video capture device found, pass -video to select one manually")
		}
		picked := candidates[0]
		result.VideoNode = picked.Node
		captureUSBPath = picked.USBPath
		if picked.IsKnown {
			result.VideoSource = fmt.Sprintf("auto (capture card %s, %s)", picked.USBID, picked.Name)
		} else {
			result.VideoSource = fmt.Sprintf("auto (first MJPEG device %s, %s)", picked.USBID, picked.Name)
		}
	}

	/* Audio - prefer the sound card on the same USB device as the video node */
	if audioOverride != "" {
		if _, err := os.Stat(audioOverride); err != nil {
			return nil, fmt.Errorf("audio device %s not found: %w", audioOverride, err)
		}
		result.AudioNode = audioOverride
		result.AudioSource = "flag"
	} else {
		candidates := listAudioCandidates()
		for _, candidate := range candidates {
			if captureUSBPath != "" && candidate.USBPath == captureUSBPath {
				result.AudioNode = candidate.Node
				result.AudioSource = fmt.Sprintf("auto (same USB device as video, card %s)", candidate.CardID)
				break
			}
		}
		if result.AudioNode == "" && len(candidates) > 0 {
			// No sibling match: fall back to the highest ranked capture PCM.
			picked := candidates[0]
			result.AudioNode = picked.Node
			if picked.IsKnown {
				result.AudioSource = fmt.Sprintf("auto (capture card %s, card %s)", picked.USBID, picked.CardID)
			} else {
				result.AudioSource = fmt.Sprintf("auto (first ALSA capture device, card %s)", picked.CardID)
			}
		}
		if result.AudioNode == "" {
			// Audio is optional, the KVM is still usable without it.
			result.AudioSource = "not found"
		}
	}

	/* Serial - prefer a CH34x on the same internal hub as the capture card */
	if serialOverride != "" {
		if _, err := os.Stat(serialOverride); err != nil {
			return nil, fmt.Errorf("serial device %s not found: %w", serialOverride, err)
		}
		result.SerialNode = serialOverride
		result.SerialSource = "flag"
	} else {
		candidates := listSerialCandidates()
		captureHub := ""
		if captureUSBPath != "" {
			captureHub = usbParentHub(usbBusPath(captureUSBPath))
		}
		for _, candidate := range candidates {
			if !candidate.IsKnown || captureHub == "" || candidate.USBPath == "" {
				continue
			}
			if usbParentHub(usbBusPath(candidate.USBPath)) == captureHub {
				result.SerialNode = candidate.Node
				result.SerialSource = fmt.Sprintf("auto (%s on the same hub as the capture card)", candidate.USBID)
				break
			}
		}
		if result.SerialNode == "" && len(candidates) > 0 {
			picked := candidates[0]
			result.SerialNode = picked.Node
			if picked.IsKnown {
				result.SerialSource = fmt.Sprintf("auto (USB-serial bridge %s)", picked.USBID)
			} else {
				result.SerialSource = fmt.Sprintf("auto (first USB serial port %s)", picked.USBID)
			}
		}
		if result.SerialNode == "" {
			result.SerialSource = "not found"
		}
	}

	return result, nil
}

// PrintDetectionReport dumps every candidate node found on the system. Handy
// when the automatic pick is wrong and the user needs to know what to pass to
// -video / -audio / -tty.
func PrintDetectionReport() {
	fmt.Println("Video capture devices (MJPEG capable):")
	videos := listVideoCandidates()
	if len(videos) == 0 {
		fmt.Println("  (none)")
	}
	for _, candidate := range videos {
		marker := " "
		if candidate.IsKnown {
			marker = "*"
		}
		fmt.Printf("  %s %-14s %-12s %s\n", marker, candidate.Node, candidate.USBID, candidate.Name)
	}

	fmt.Println("\nAudio capture devices:")
	audios := listAudioCandidates()
	if len(audios) == 0 {
		fmt.Println("  (none)")
	}
	for _, candidate := range audios {
		marker := " "
		if candidate.IsKnown {
			marker = "*"
		}
		fmt.Printf("  %s %-22s %-12s %s\n", marker, candidate.Node, candidate.USBID, candidate.CardID)
	}

	fmt.Println("\nSerial ports:")
	serials := listSerialCandidates()
	if len(serials) == 0 {
		fmt.Println("  (none)")
	}
	for _, candidate := range serials {
		marker := " "
		if candidate.IsKnown {
			marker = "*"
		}
		fmt.Printf("  %s %-14s %s\n", marker, candidate.Node, candidate.USBID)
	}
	fmt.Println("\n  (* = recognised DezKVM hardware)")
}
