package kvmhid

import (
	"bytes"
	"encoding/binary"
	"errors"
)

// calcChecksum calculates the checksum for a given data slice.
func calcChecksum(data []uint8) uint8 {
	var sum uint8 = 0
	for _, value := range data {
		sum += value
	}
	return sum
}

func (c *Controller) MouseMoveAbsolute(xLSB, xMSB, yLSB, yMSB uint8) ([]byte, error) {
	packet := []uint8{
		0x57, 0xAB, 0x00, 0x04, 0x07, 0x02,
		c.hidState.MouseButtons,
		xLSB, // X LSB
		xMSB, // X MSB
		yLSB, // Y LSB
		yMSB, // Y MSB
		0x00, // Scroll
		0x00, // Checksum placeholder
	}

	packet[12] = calcChecksum(packet[:12])

	buf := new(bytes.Buffer)
	if err := binary.Write(buf, binary.LittleEndian, packet); err != nil {
		return nil, errors.New("failed to write packet to buffer")
	}

	err := c.Send(buf.Bytes())
	if err != nil {
		return nil, errors.New("failed to send mouse move command: " + err.Error())
	}

	// Wait for a reply from the device
	return c.WaitForReply(0x04)
}

func (c *Controller) MouseMoveRelative(dx, dy, wheel uint8) ([]byte, error) {
	// Ensure 0x80 is not used
	if dx == 0x80 {
		dx = 0x81
	}
	if dy == 0x80 {
		dy = 0x81
	}

	packet := []uint8{
		0x57, 0xAB, 0x00, 0x05, 0x05, 0x01,
		c.hidState.MouseButtons,
		dx,    // Delta X
		dy,    // Delta Y
		wheel, // Scroll wheel
		0x00,  // Checksum placeholder
	}

	packet[10] = calcChecksum(packet[:10])

	buf := new(bytes.Buffer)
	if err := binary.Write(buf, binary.LittleEndian, packet); err != nil {
		return nil, errors.New("failed to write packet to buffer")
	}

	err := c.Send(buf.Bytes())
	if err != nil {
		return nil, errors.New("failed to send mouse move relative command: " + err.Error())
	}

	return c.WaitForReply(0x05)
}

// Handle mouse button press events
func (c *Controller) MouseButtonPress(button uint8) ([]byte, error) {
	switch button {
	case 0x01: // Left
		c.hidState.MouseButtons |= 0x01
	case 0x02: // Right
		c.hidState.MouseButtons |= 0x02
	case 0x03: // Middle
		c.hidState.MouseButtons |= 0x04
	default:
		return nil, errors.New("invalid opcode for mouse button press")
	}

	// Send updated button state with no movement
	return c.MouseMoveRelative(0, 0, 0)
}

// Handle mouse button release events
func (c *Controller) MouseButtonRelease(button uint8) ([]byte, error) {
	switch button {
	case 0x00: // Release all
		c.hidState.MouseButtons = 0x00
	case 0x01: // Left
		c.hidState.MouseButtons &^= 0x01
	case 0x02: // Right
		c.hidState.MouseButtons &^= 0x02
	case 0x03: // Middle
		c.hidState.MouseButtons &^= 0x04
	default:
		return nil, errors.New("invalid opcode for mouse button release")
	}

	// Send updated button state with no movement
	return c.MouseMoveRelative(0, 0, 0)
}

func (c *Controller) MouseScroll(tilt int) ([]byte, error) {
	if tilt == 0 {
		// No need to scroll
		return nil, nil
	}

	if c.Config.InvertScrollDirection {
		tilt = -tilt
	}

	var wheel uint8
	if tilt < 0 {
		wheel = uint8(c.Config.ScrollSensitivity)
	} else {
		wheel = uint8(0xFF - c.Config.ScrollSensitivity)
	}

	//fmt.Println(tilt, "-->", wheel)
	return c.MouseMoveRelative(0, 0, wheel)
}
