package kvmhid

import (
	"errors"
	"fmt"
	"log"
	"time"
)

func (c *Controller) ConfigureChipTo115200() error {
	// Send the command to get chip configuration and info
	currentConfig, err := c.GetChipCurrentConfiguration()
	if err != nil {
		fmt.Printf("Error getting current configuration: %v\n", err)
		return errors.New("failed to get current configuration")
	}

	// Modify baudrate bytes in the response
	currentConfig[0] = 0x02 // Set mode to 2 (Standard mouse & keyboard mode) as required for 115200 baudrate
	currentConfig[3] = 0x00 // Baudrate byte 1
	currentConfig[4] = 0x01 // Baudrate byte 2
	currentConfig[5] = 0xC2 // Baudrate byte 3
	currentConfig[6] = 0x00 // Baudrate byte 4

	time.Sleep(1 * time.Second) // Wait for a second before sending the command
	// Prepare the command to set the new configuration
	setCmd := append([]byte{0x57, 0xAB, 0x00, 0x09, 0x32}, currentConfig[:50]...)
	setCmd = append(setCmd, calcChecksum(setCmd[:len(setCmd)-1]))

	err = c.Send(setCmd)
	if err != nil {
		fmt.Printf("Error sending configuration command: %v\n", err)
		return errors.New("failed to send configuration command")
	}

	// Wait for the reply
	resp, err := c.WaitForReply(0x09)
	if err != nil {
		fmt.Printf("Error waiting for reply: %v\n", err)
		return errors.New("failed to get reply")
	}

	fmt.Println()
	fmt.Print("Reply: ")
	for _, b := range resp {
		fmt.Printf("0x%02X ", b)
	}
	fmt.Println()
	fmt.Println("Baudrate updated to 115200 successfully")
	return nil
}

func (c *Controller) ConfigureChipToMode2() error {
	// Send the command to get chip configuration and info
	currentConfig, err := c.GetChipCurrentConfiguration()
	if err != nil {
		fmt.Printf("Error getting current configuration: %v\n", err)
		return errors.New("failed to get current configuration")
	}

	// Modify mode setting in the response
	currentConfig[0] = 0x02

	time.Sleep(1 * time.Second) // Wait for a second before sending the command
	// Prepare the command to set the new configuration
	setCmd := append([]byte{0x57, 0xAB, 0x00, 0x09, 0x32}, currentConfig[:50]...)
	setCmd = append(setCmd, calcChecksum(setCmd[:len(setCmd)-1]))
	err = c.Send(setCmd)
	if err != nil {
		fmt.Printf("Error sending configuration command: %v\n", err)
		return errors.New("failed to send configuration command")
	}

	// Wait for the reply
	resp, err := c.WaitForReply(0x09)
	if err != nil {
		fmt.Printf("Error waiting for reply: %v\n", err)
		return errors.New("failed to get reply")
	}

	fmt.Println()
	fmt.Print("Reply: ")
	for _, b := range resp {
		fmt.Printf("0x%02X ", b)
	}
	fmt.Println()
	fmt.Println("Chip mode updated to 2 successfully")
	return nil
}

func (c *Controller) WriteChipProperties() ([]byte, error) {
	manufacturerString := []byte{
		0x57, 0xAB, 0x00, 0x0B,
		0x09, // Length of payload
		0x00, // Set manufacturer string
		0x07, // Length of the USB manufacturer string
		'i', 'm', 'u', 's', 'l', 'a', 'b',
		0x00, // Checksum placeholder
	}

	manufacturerString[14] = calcChecksum(manufacturerString[:14])
	// Send set manufacturer string
	err := c.Send(manufacturerString)
	if err != nil {
		return nil, fmt.Errorf("failed to send manufacturer string: %v", err)
	}
	_, err = c.WaitForReply(0x0B)
	if err != nil {
		return nil, fmt.Errorf("failed to get manufacturer string response: %v", err)
	}

	productString := []byte{
		0x57, 0xAB, 0x00, 0x0B,
		0x08, // Length of the payload
		0x01, // Set product string
		0x06, // Length of the USB product string
		'D', 'e', 'z', 'K', 'V', 'M',
		0x00, // Checksum placeholder
	}

	productString[13] = calcChecksum(productString[:13])
	// Send set product string
	err = c.Send(productString)
	if err != nil {
		return nil, fmt.Errorf("failed to send product string: %v", err)
	}
	_, err = c.WaitForReply(0x0B)
	if err != nil {
		return nil, fmt.Errorf("failed to get product string response: %v", err)
	}

	return []byte("OK"), nil
}

// GetChipCurrentConfiguration retrieves the current configuration of the chip.
// It sends a command to the chip and waits for a reply.
// Note only the data portion of the response is returned, excluding the header and checksum.
func (c *Controller) GetChipCurrentConfiguration() ([]byte, error) {
	//Send the command to get chip configuration and info
	cmd := []byte{0x57, 0xAB,
		0x00, 0x08, 0x00,
		0x00, //placeholder for checksum
	}

	cmd[5] = calcChecksum(cmd[:5])
	err := c.Send(cmd)
	if err != nil {
		fmt.Printf("Error sending command: %v\n", err)
		return nil, errors.New("failed to send command")
	}

	resp, err := c.WaitForReply(0x08)
	if err != nil {
		fmt.Printf("Error waiting for reply: %v\n", err)
		return nil, errors.New("failed to get reply")
	}

	if len(resp) < 50 {
		fmt.Println("Invalid response length")
		return nil, errors.New("invalid response length")
	}

	fmt.Print("Response: ")
	for _, b := range resp {
		fmt.Printf("0x%02X ", b)
	}
	fmt.Println()

	return resp, nil
}

func (c *Controller) ChipSoftReset() error {
	//Send the command to get chip configuration and info
	cmd := []byte{0x57, 0xAB,
		0x00, 0x0F, 0x00,
		0x00, //placeholder for checksum
	}

	cmd[5] = calcChecksum(cmd[:5])
	err := c.Send(cmd)
	if err != nil {
		fmt.Printf("Error sending command: %v\n", err)
		return errors.New("failed to send command")
	}

	_, err = c.WaitForReply(0x0F)
	if err != nil {
		fmt.Printf("Error waiting for reply: %v\n", err)
		return errors.New("failed to get reply")
	}

	log.Println("Chip soft reset successfully, releasing all modifier keys to ensure clean state")
	return nil
}



func (c *Controller) IsModifierKeys(keycode int) bool {
	// Modifier keycodes for JavaScript
	modifierKeys := []int{16, 17, 18, 91} // Shift, Ctrl, Alt, Meta (Windows/Command key)
	for _, key := range modifierKeys {
		if keycode == key {
			return true
		}
	}
	return false
}

// ConstructAndSendCmd constructs a HID command based on the provided HIDCommand and sends it.
func (c *Controller) ConstructAndSendCmd(HIDCommand *HIDCommand) ([]byte, error) {
	switch HIDCommand.Event {
	case EventTypeKeyPress:
		if IsModifierKey(uint8(HIDCommand.Keycode)) {
			//modifier keys
			return c.SetModifierKey(uint8(HIDCommand.Keycode), HIDCommand.IsRightModKey)
		} else if HIDCommand.Keycode == 13 && HIDCommand.IsRightModKey {
			// Numpad enter
			return c.SendKeyboardPress(uint8(146))
		}
		return c.SendKeyboardPress(uint8(HIDCommand.Keycode))
	case EventTypeKeyRelease:
		if IsModifierKey(uint8(HIDCommand.Keycode)) {
			//modifier keys
			return c.UnsetModifierKey(uint8(HIDCommand.Keycode), HIDCommand.IsRightModKey)
		} else if HIDCommand.Keycode == 13 && HIDCommand.IsRightModKey {
			// Numpad enter
			return c.SendKeyboardRelease(uint8(146))
		}
		return c.SendKeyboardRelease(uint8(HIDCommand.Keycode))
	case EventTypeMouseMove:
		//Map mouse button state to HID state
		leftPressed := (HIDCommand.MouseMoveButtonState & 0x01) != 0
		middlePressed := (HIDCommand.MouseMoveButtonState & 0x02) != 0
		rightPressed := (HIDCommand.MouseMoveButtonState & 0x04) != 0
		if leftPressed {
			c.hidState.MouseButtons |= 0x01
		} else {
			c.hidState.MouseButtons &^= 0x01
		}

		if middlePressed {
			c.hidState.MouseButtons |= 0x04
		} else {
			c.hidState.MouseButtons &^= 0x04
		}

		if rightPressed {
			c.hidState.MouseButtons |= 0x02
		} else {
			c.hidState.MouseButtons &^= 0x02
		}

		// Update mouse position
		c.lastCursorEventTime = time.Now().UnixMilli()
		if HIDCommand.MouseAbsX != 0 || HIDCommand.MouseAbsY != 0 {
			xLSB := byte(HIDCommand.MouseAbsX & 0xFF)        // Extract LSB of X
			xMSB := byte((HIDCommand.MouseAbsX >> 8) & 0xFF) // Extract MSB of X
			yLSB := byte(HIDCommand.MouseAbsY & 0xFF)        // Extract LSB of Y
			yMSB := byte((HIDCommand.MouseAbsY >> 8) & 0xFF) // Extract MSB of Y
			return c.MouseMoveAbsolute(xLSB, xMSB, yLSB, yMSB)
		} else if HIDCommand.MouseRelX != 0 || HIDCommand.MouseRelY != 0 {
			dx := int8(HIDCommand.MouseRelX)
			dy := int8(HIDCommand.MouseRelY)
			return c.MouseMoveRelative(uint8(dx), uint8(dy), 0)
		}
		return []byte{}, nil
	case EventTypeMousePress:
		if HIDCommand.MouseButton < 1 || HIDCommand.MouseButton > 3 {
			return nil, fmt.Errorf("invalid mouse button: %d", HIDCommand.MouseButton)
		}
		button := uint8(HIDCommand.MouseButton)
		return c.MouseButtonPress(button)
	case EventTypeMouseRelease:
		if HIDCommand.MouseButton < 1 || HIDCommand.MouseButton > 3 {
			return nil, fmt.Errorf("invalid mouse button: %d", HIDCommand.MouseButton)
		}
		button := uint8(HIDCommand.MouseButton)
		return c.MouseButtonRelease(button)
	case EventTypeMouseScroll:
		if time.Now().UnixMilli()-c.lastCursorEventTime < MinCusorEventInterval {
			// Ignore mouse move events that are too close together
			return []byte{}, nil
		}
		c.lastCursorEventTime = time.Now().UnixMilli()
		return c.MouseScroll(HIDCommand.MouseScroll)
	case EventTypeHIDReset:
		err := c.ChipSoftReset()
		if err != nil {
			return nil, fmt.Errorf("failed to reset chip: %v", err)
		}
		err = c.UnsetModifierKeysWithRetry(5)
		if err != nil {
			return nil, fmt.Errorf("failed to unset modifier keys: %v", err)
		}
		return []byte{}, nil
	default:
		return nil, fmt.Errorf("unsupported HID command event type: %d", HIDCommand.Event)
	}
}
