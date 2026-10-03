package kvmhid

import "errors"
import "time"
import "log"

const (
	MOD_LCTRL  = 0x01
	MOD_LSHIFT = 0x02
	MOD_LALT   = 0x04
	MOD_LGUI   = 0x08
	MOD_RCTRL  = 0x10
	MOD_RSHIFT = 0x20
	MOD_RALT   = 0x40
	MOD_RGUI   = 0x80
	MOD_RENTER = 0x58
)

// IsModifierKey checks if the given JavaScript keycode corresponds to a modifier key
func IsModifierKey(keycode uint8) bool {
	switch keycode {
	case 16: // Shift
		return true
	case 17: // Control
		return true
	case 18: // Alt
		return true
	case 91: // Meta (Windows/Command key)
		return true
	default:
		return false
	}
}

func (c *Controller) SetModifierKey(keycode uint8, isRight bool) ([]byte, error) {
	// Determine the modifier bit based on HID keycode
	var modifierBit uint8
	switch keycode {
	case 17:
		if isRight {
			modifierBit = MOD_RCTRL
		} else {
			modifierBit = MOD_LCTRL
		}
	case 16:
		if isRight {
			modifierBit = MOD_RSHIFT
		} else {
			modifierBit = MOD_LSHIFT
		}
	case 18:
		if isRight {
			modifierBit = MOD_RALT
		} else {
			modifierBit = MOD_LALT
		}
	case 91:
		if isRight {
			modifierBit = MOD_RGUI
		} else {
			modifierBit = MOD_LGUI
		}
	default:
		// Not a modifier key
		return nil, errors.ErrUnsupported
	}

	c.hidState.Modkey |= modifierBit

	return keyboardSendKeyCombinations(c)
}

func (c *Controller) UnsetModifierKey(keycode uint8, isRight bool) ([]byte, error) {
	// Determine the modifier bit based on HID keycode
	var modifierBit uint8
	switch keycode {
	case 17:
		if isRight {
			modifierBit = MOD_RCTRL
		} else {
			modifierBit = MOD_LCTRL
		}
	case 16:
		if isRight {
			modifierBit = MOD_RSHIFT
		} else {
			modifierBit = MOD_LSHIFT
		}
	case 18:
		if isRight {
			modifierBit = MOD_RALT
		} else {
			modifierBit = MOD_LALT
		}
	case 91:
		if isRight {
			modifierBit = MOD_RGUI
		} else {
			modifierBit = MOD_LGUI
		}
	default:
		// Not a modifier key
		return nil, errors.ErrUnsupported
	}

	c.hidState.Modkey &^= modifierBit
	return keyboardSendKeyCombinations(c)
}

// UnsetAllModifierKeys releases all modifier keys (Shift, Ctrl, Alt, GUI)
func (c *Controller) UnsetAllModifierKeys() error {
	var err error
	_, err = c.UnsetModifierKey(16, false) // Left Shift
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(16, true)
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(17, false) // Left Ctrl
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(17, true)
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(18, false) // Left Alt
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(18, true)
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(91, false) // Left GUI
	if err != nil {
		return err
	}
	_, err = c.UnsetModifierKey(91, true)
	if err != nil {
		return err
	}
	return nil
}

// UnsetModifierKeysWithRetry attempts to release all modifier keys with retries in case of failure
// which commonly happens if this is called after Chip soft reset
func (c *Controller) UnsetModifierKeysWithRetry(maxRetryCount int) error{
	var err error
	retryCount := 0
	succ := false
	for(succ == false && retryCount < maxRetryCount) {
		err = c.UnsetAllModifierKeys()
		if err != nil {
			retryCount++
			time.Sleep(1 * time.Second) // Wait before retrying
		} else {
			succ = true
		}
	}
	if !succ {
		log.Printf("Error unsetting modifier keys: %v\n", err)
	}
	return nil
}

// SendKeyboardPress sends a keyboard press by JavaScript keycode
func (c *Controller) SendKeyboardPress(keycode uint8) ([]byte, error) {
	// Convert JavaScript keycode to HID
	keycode = javaScriptKeycodeToHIDOpcode(keycode)
	if keycode == 0x00 {
		// Not supported
		return nil, errors.New("Unsupported keycode: " + string(keycode))
	}

	// Already pressed? Skip
	for i := 0; i < 6; i++ {
		if c.hidState.KeyboardButtons[i] == keycode {
			return nil, nil
		}
	}

	// Get the empty slot in the current HID list
	for i := 0; i < 6; i++ {
		if c.hidState.KeyboardButtons[i] == 0x00 {
			c.hidState.KeyboardButtons[i] = keycode
			return keyboardSendKeyCombinations(c)
		}
	}

	// No space left
	return nil, errors.New("No space left in keyboard state to press key: " + string(keycode))
}

// SendKeyboardRelease sends a keyboard release by JavaScript keycode
func (c *Controller) SendKeyboardRelease(keycode uint8) ([]byte, error) {
	// Convert JavaScript keycode to HID
	keycode = javaScriptKeycodeToHIDOpcode(keycode)
	if keycode == 0x00 {
		// Not supported
		return nil, errors.New("Unsupported keycode: " + string(keycode))
	}

	// Find the position where the key is pressed
	for i := 0; i < 6; i++ {
		if c.hidState.KeyboardButtons[i] == keycode {
			c.hidState.KeyboardButtons[i] = 0x00
			return keyboardSendKeyCombinations(c)
		}
	}

	// That key is not pressed
	return nil, nil
}

// keyboardSendKeyCombinations simulates sending the current key combinations
func keyboardSendKeyCombinations(c *Controller) ([]byte, error) {
	// Prepare the packet
	packet := []uint8{
		0x57, 0xAB, 0x00, 0x02, 0x08,
		c.hidState.Modkey, 0x00,
		0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00,
	}

	// Populate the HID keycodes
	for i := 0; i < len(c.hidState.KeyboardButtons); i++ {
		packet[7+i] = c.hidState.KeyboardButtons[i]
	}

	// Calculate checksum
	packet[13] = calcChecksum(packet[:13])

	err := c.Send(packet)
	if err != nil {
		return nil, errors.New("failed to send mouse move command: " + err.Error())
	}

	// Wait for a reply from the device
	return c.WaitForReply(0x02)
}

// JavaScriptKeycodeToHIDOpcode converts JavaScript keycode into HID keycode
func javaScriptKeycodeToHIDOpcode(keycode uint8) uint8 {
	// Letters A-Z
	if keycode >= 65 && keycode <= 90 {
		return (keycode - 65) + 0x04 // 'A' is 0x04
	}

	// Numbers 1-9 (top row, not numpad)
	if keycode >= 49 && keycode <= 57 {
		return (keycode - 49) + 0x1E // '1' is 0x1E
	}

	// F1 to F12
	if keycode >= 112 && keycode <= 123 {
		return (keycode - 112) + 0x3A // 'F1' is 0x3A
	}

	switch keycode {
	case 8:
		return 0x2A // Backspace
	case 9:
		return 0x2B // Tab
	case 13:
		return 0x28 // Enter
	case 16:
		return 0xE1 // Left shift
	case 17:
		return 0xE0 // Left Ctrl
	case 18:
		return 0xE6 // Left Alt
	case 19:
		return 0x48 // Pause
	case 20:
		return 0x39 // Caps Lock
	case 27:
		return 0x29 // Escape
	case 32:
		return 0x2C // Spacebar
	case 33:
		return 0x4B // Page Up
	case 34:
		return 0x4E // Page Down
	case 35:
		return 0x4D // End
	case 36:
		return 0x4A // Home
	case 37:
		return 0x50 // Left Arrow
	case 38:
		return 0x52 // Up Arrow
	case 39:
		return 0x4F // Right Arrow
	case 40:
		return 0x51 // Down Arrow
	case 44:
		return 0x46 // Print Screen or F13 (Firefox)
	case 45:
		return 0x49 // Insert
	case 46:
		return 0x4C // Delete
	case 48:
		return 0x27 // 0 (not Numpads)
	case 59:
		return 0x33 // ';'
	case 61:
		return 0x2E // '='
	case 91:
		return 0xE3 // Left GUI (Windows)
	case 92:
		return 0xE7 // Right GUI
	case 93:
		return 0x65 // Menu key
	case 96:
		return 0x62 // 0 (Numpads)
	case 97:
		return 0x59 // 1 (Numpads)
	case 98:
		return 0x5A // 2 (Numpads)
	case 99:
		return 0x5B // 3 (Numpads)
	case 100:
		return 0x5C // 4 (Numpads)
	case 101:
		return 0x5D // 5 (Numpads)
	case 102:
		return 0x5E // 6 (Numpads)
	case 103:
		return 0x5F // 7 (Numpads)
	case 104:
		return 0x60 // 8 (Numpads)
	case 105:
		return 0x61 // 9 (Numpads)
	case 106:
		return 0x55 // * (Numpads)
	case 107:
		return 0x57 // + (Numpads)
	case 109:
		return 0x56 // - (Numpads)
	case 110:
		return 0x63 // dot (Numpads)
	case 111:
		return 0x54 // divide (Numpads)
	case 144:
		return 0x53 // Num Lock
	case 145:
		return 0x47 // Scroll Lock
	case 146:
		return 0x58 // Numpad enter
	case 173:
		return 0x2D // -
	case 186:
		return 0x33 // ';'
	case 187:
		return 0x2E // '='
	case 188:
		return 0x36 // ','
	case 189:
		return 0x2D // '-'
	case 190:
		return 0x37 // '.'
	case 191:
		return 0x38 // '/'
	case 192:
		return 0x35 // '`'
	case 219:
		return 0x2F // '['
	case 220:
		return 0x31 // backslash
	case 221:
		return 0x30 // ']'
	case 222:
		return 0x34 // '\''
	default:
		return 0x00 // Unknown / unsupported
	}
}
