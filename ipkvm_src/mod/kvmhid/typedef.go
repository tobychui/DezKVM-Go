package kvmhid

import (
	"sync"
	"time"

	tserial "github.com/tarm/serial"
)

type EventType int

const (
	EventTypeKeyPress EventType = iota
	EventTypeKeyRelease
	EventTypeMouseMove
	EventTypeMousePress
	EventTypeMouseRelease
	EventTypeMouseScroll
	EventTypeHIDCommand
	EventTypeHIDReset = 0xFF
)

const MinCusorEventInterval = 25 // Minimum interval between cursor events in milliseconds

type Config struct {
	/* Serial port configs */
	PortName              string
	BaudRate              int
	ScrollSensitivity     uint8 // Mouse scroll sensitivity, range 0x00 to 0x7E
	InvertScrollDirection bool  // Invert the scroll direction
}

type HIDState struct {
	/* Keyboard state */
	Modkey          uint8    // Modifier key state
	KeyboardButtons [6]uint8 // Keyboard buttons state
	Leds            uint8    // LED state

	/* Mouse state */
	MouseButtons uint8 // Mouse buttons state
	MouseX       int16 // Mouse X movement
	MouseY       int16 // Mouse Y movement
}

// Controller is a struct that represents a HID controller
type Controller struct {
	Config *Config

	/* Internal state */
	serialPort          *tserial.Port
	hidState            HIDState // Current state of the HID device
	serialRunning       bool
	writeQueue          chan []byte
	incomingDataQueue   chan []byte // Queue for incoming data
	lastCursorEventTime int64
	readCloseChan       chan bool

	/* Mouse Jiggler */
	jiggler          jigglerState
	activityMu       sync.Mutex
	lastActivityTime time.Time
}

type HIDCommand struct {
	Event                EventType `json:"event"`
	Rid                  string    `json:"rid,omitempty"`                    // Reply ID — if set, backend sends an ACK after the command is processed
	Keycode              int       `json:"keycode,omitempty"`
	IsRightModKey        bool      `json:"is_right_modifier_key,omitempty"`   // true if the key is a right modifier key (Ctrl, Shift, Alt, GUI)
	MouseAbsX            int       `json:"mouse_x,omitempty"`                 // Absolute mouse position in X direction
	MouseAbsY            int       `json:"mouse_y,omitempty"`                 // Absolute mouse position in Y direction
	MouseRelX            int       `json:"mouse_rel_x,omitempty"`             // Relative mouse movement in X direction
	MouseRelY            int       `json:"mouse_rel_y,omitempty"`             // Relative mouse movement in Y direction
	MouseMoveButtonState int       `json:"mouse_move_button_state,omitempty"` // Mouse button state during move,
	MouseButton          int       `json:"mouse_button,omitempty"`            //0x01 for left click, 0x02 for right click, 0x03 for middle clicks
	MouseScroll          int       `json:"mouse_scroll,omitempty"`            // Positive for scroll up, negative for scroll down, max 127
}
