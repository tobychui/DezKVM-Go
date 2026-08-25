package kvmhid

import (
	"sync"
	"time"
)

const (
	jigglerIdleTimeout = 30 * time.Second
	jigglerMoveAmount  = 10 // pixels to jiggle
)

// jigglerState tracks the mouse jiggler for a controller.
type jigglerState struct {
	mu      sync.Mutex
	enabled bool
	stopCh  chan struct{}
}

// StartMouseJiggler enables the mouse jiggler. It moves the mouse by a tiny
// amount every jigglerIdleTimeout if no HID commands have been sent recently.
func (c *Controller) StartMouseJiggler() {
	c.jiggler.mu.Lock()
	defer c.jiggler.mu.Unlock()

	if c.jiggler.enabled {
		return // already running
	}

	c.jiggler.enabled = true
	c.jiggler.stopCh = make(chan struct{})
	stopCh := c.jiggler.stopCh

	go func() {
		moveRight := true
		ticker := time.NewTicker(jigglerIdleTimeout)
		defer ticker.Stop()

		for {
			select {
			case <-stopCh:
				return
			case <-ticker.C:
				// Only jiggle if idle long enough
				if time.Since(c.getLastActivityTime()) < jigglerIdleTimeout {
					continue
				}
				// 0x00 - 0x80 is the range of relative movement
				// values above 0x80 are interpreted as negative movement
				// See ch9329 datasheet for more info
				var dx uint8
				if moveRight {
					dx = jigglerMoveAmount
				} else {
					dx = 0xFF - jigglerMoveAmount
				}
				c.MouseMoveRelative(dx, 0, 0)
				moveRight = !moveRight
			}
		}
	}()
}

// StopMouseJiggler disables the mouse jiggler.
func (c *Controller) StopMouseJiggler() {
	c.jiggler.mu.Lock()
	defer c.jiggler.mu.Unlock()

	if !c.jiggler.enabled {
		return
	}

	c.jiggler.enabled = false
	close(c.jiggler.stopCh)
}

// IsMouseJigglerEnabled returns whether the mouse jiggler is running.
func (c *Controller) IsMouseJigglerEnabled() bool {
	c.jiggler.mu.Lock()
	defer c.jiggler.mu.Unlock()
	return c.jiggler.enabled
}

// RecordActivity notes that a HID command was sent, resetting the idle timer.
func (c *Controller) RecordActivity() {
	c.activityMu.Lock()
	c.lastActivityTime = time.Now()
	c.activityMu.Unlock()
}

func (c *Controller) getLastActivityTime() time.Time {
	c.activityMu.Lock()
	defer c.activityMu.Unlock()
	return c.lastActivityTime
}
