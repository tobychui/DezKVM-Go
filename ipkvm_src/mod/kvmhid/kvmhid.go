package kvmhid

import (
	"fmt"
	"log"
	"time"

	tserial "github.com/tarm/serial"
)

func NewHIDController(config *Config) *Controller {
	// Initialize the HID state with default values
	defaultHidState := HIDState{
		Modkey:          0x00,
		KeyboardButtons: [6]uint8{0x00, 0x00, 0x00, 0x00, 0x00, 0x00},
		Leds:            0x00,
		MouseButtons:    0x00, // No mouse buttons pressed
		MouseX:          0,
		MouseY:          0,
	}

	return &Controller{
		Config:            config,
		serialRunning:     false,
		hidState:          defaultHidState,
		writeQueue:        make(chan []byte, 32),
		incomingDataQueue: make(chan []byte, 1024),
		readCloseChan:     make(chan bool),
		lastActivityTime:  time.Now(),
	}
}

// Connect opens the serial port and starts reading from it
func (c *Controller) Connect() error {
	// Open the serial port
	config := &tserial.Config{
		Name:        c.Config.PortName,
		Baud:        c.Config.BaudRate,
		Size:        8,
		Parity:      tserial.ParityNone,
		ReadTimeout: time.Millisecond * 500,
	}

	port, err := tserial.OpenPort(config)
	if err != nil {
		return err
	}

	c.serialPort = port
	// Start reading from the serial port
	go func() {
		buf := make([]byte, 1024)
		for {
			select {
			case <-c.readCloseChan:
				return
			default:
				n, err := port.Read(buf)
				if err != nil {
					continue
				}
				if n > 0 {
					c.incomingDataQueue <- buf[:n]
				}
			}
		}
	}()

	//Create a loop to write to the serial port
	c.serialRunning = true
	go func() {
		for {
			data := <-c.writeQueue
			_, err := port.Write(data)
			if err != nil {
				log.Println(err.Error())
				return
			}
		}
	}()

	// Not all remote machines are on at the time of hid initiation
	// we can safely ignore the error here
	c.ChipSoftReset()

	return nil
}

func (c *Controller) Send(data []byte) error {
	if !c.serialRunning {
		return fmt.Errorf("serial port is not running")
	}
	select {
	case c.writeQueue <- data:
		return nil
	case <-time.After(30 * time.Millisecond):
		return fmt.Errorf("timeout waiting to send data")
	}
}

func (c *Controller) ClearReadQueue() {
	// Clear the incoming data queue
	for len(c.incomingDataQueue) > 0 {
		<-c.incomingDataQueue
	}
}

func (c *Controller) WaitForReply(cmdByte byte) ([]byte, error) {
	// Wait for a reply from the device
	succReplyByte := cmdByte | 0x80
	errorReplyByte := cmdByte | 0xC0
	timeout := make(chan bool, 1)
	go func() {
		// Timeout after 500ms
		time.Sleep(500 * time.Millisecond)
		timeout <- true
	}()

	var reply []byte
	for {
		select {
		case data := <-c.incomingDataQueue:
			reply = append(reply, data...)
			// Check if we have received enough bytes for a complete packet
			if len(reply) >= 7 {
				// Validate header
				if reply[0] == 0x57 && reply[1] == 0xAB {
					// Extract fields
					//address := reply[2]
					replyByte := reply[3]
					dataLength := reply[4]
					expectedLength := 5 + int(dataLength) + 1 // Header + address + replyByte + dataLength + data + checksum

					// Check if the full packet is received
					if len(reply) >= expectedLength {
						data := reply[5 : 5+dataLength]
						checksum := reply[5+dataLength]

						// Calculate checksum
						sum := byte(0)
						for _, b := range reply[:5+dataLength] {
							sum += b
						}

						// Validate checksum
						if sum == checksum {
							// Check reply byte for success or error
							switch replyByte {
							case succReplyByte:
								return data, nil
							case errorReplyByte:
								fmt.Print("Reply: ")
								for _, b := range reply {
									fmt.Printf("0x%02X ", b)
								}
								return nil, fmt.Errorf("device returned error reply")
							}
						} else {
							return nil, fmt.Errorf("checksum validation failed")
						}
					}
				} else {
					// Invalid header, discard data
					reply = nil
				}
			}
		case <-timeout:
			return nil, fmt.Errorf("timeout waiting for reply")
		}
	}
}

func (c *Controller) Close() {
	c.StopMouseJiggler()
	c.serialRunning = false
	c.readCloseChan <- true
	if c.serialPort != nil {
		done := make(chan struct{})
		go func() {
			c.serialPort.Close()
			close(done)
		}()
		select {
		case <-done:
			// Closed successfully
		case <-time.After(3 * time.Second):
			log.Println("serial port close timeout")
		}
	}

}
