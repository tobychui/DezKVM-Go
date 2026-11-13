// Package tui renders the reconstructed remote terminal and forwards local
// keystrokes to the CH9329, giving an interactive text terminal over the KVM.
package tui

import (
	"fmt"
	"time"

	"github.com/gdamore/tcell/v2"

	"kvmterm/framegrab"
	"kvmterm/hid"
	"kvmterm/screen"
)

// App drives the interactive terminal.
type App struct {
	kb   *hid.Keyboard
	grab *framegrab.Grabber
	cal  *screen.Calibration
	sc   tcell.Screen

	interval time.Duration
	last     *screen.Text
	quit     bool

	// Viewport over the (possibly larger) remote grid.
	viewRow      int  // top remote row shown
	followBottom bool // auto-scroll to keep the last content visible
	lastViewRow  int

	// Last remote cursor position seen; kept while the cursor blinks off.
	cursorRow, cursorCol int
}

// New builds an App. interval is the background frame-poll period.
func New(kb *hid.Keyboard, grab *framegrab.Grabber, cal *screen.Calibration, interval time.Duration) *App {
	return &App{kb: kb, grab: grab, cal: cal, interval: interval, followBottom: true, lastViewRow: -1,
		cursorRow: -1, cursorCol: -1}
}

// frameEvent is posted to the tcell event loop when a fresh frame is ready.
type frameEvent struct {
	when time.Time
	text *screen.Text
}

func (e frameEvent) When() time.Time { return e.when }

// Run starts the event loop and blocks until the user quits (Ctrl+Q).
func (a *App) Run() error {
	sc, err := tcell.NewScreen()
	if err != nil {
		return err
	}
	a.sc = sc
	if err := sc.Init(); err != nil {
		return err
	}
	defer sc.Fini()
	sc.HideCursor()
	sc.SetCursorStyle(tcell.CursorStyleBlinkingUnderline)

	// Fast interactive pacing for forwarded keystrokes.
	a.kb.SetPacing(50*time.Millisecond, 15*time.Millisecond)

	// Frame poller: grab immediately on trigger, otherwise every interval.
	trigger := make(chan struct{}, 1)
	go func() {
		for {
			select {
			case <-trigger:
			case <-time.After(a.interval):
			}
			if a.quit {
				return
			}
			if img, err := a.grab.Grab(); err == nil {
				sc.PostEvent(frameEvent{time.Now(), a.cal.Render(img)})
			}
		}
	}()

	for !a.quit {
		ev := sc.PollEvent()
		switch ev := ev.(type) {
		case *tcell.EventResize:
			sc.Sync()
		case *tcell.EventKey:
			if a.handleKey(ev) {
				// Input was forwarded to the remote; re-grab immediately.
				select {
				case trigger <- struct{}{}:
				default:
				}
			}
		case frameEvent:
			a.draw(ev.text)
		}
	}
	return nil
}

// handleKey forwards a key to the remote terminal. It returns true if the key
// was forwarded (and a frame re-grab is wanted).
func (a *App) handleKey(ev *tcell.EventKey) bool {
	key := ev.Key()
	switch key {
	case tcell.KeyCtrlQ:
		a.quit = true
		return false
	case tcell.KeyPgUp:
		a.scroll(-1)
		return false
	case tcell.KeyPgDn:
		a.scroll(1)
		return false
	}

	switch key {
	case tcell.KeyEnter:
		_ = a.kb.Key(hid.KeyEnter, 50*time.Millisecond)
	case tcell.KeyBackspace, tcell.KeyBackspace2:
		_ = a.kb.Key(hid.KeyBackspace, 50*time.Millisecond)
	case tcell.KeyTab:
		_ = a.kb.Key(hid.KeyTab, 50*time.Millisecond)
	case tcell.KeyUp:
		_ = a.kb.Key(hid.KeyArrowUp, 50*time.Millisecond)
	case tcell.KeyDown:
		_ = a.kb.Key(hid.KeyArrowDown, 50*time.Millisecond)
	case tcell.KeyLeft:
		_ = a.kb.Key(hid.KeyArrowLeft, 50*time.Millisecond)
	case tcell.KeyRight:
		_ = a.kb.Key(hid.KeyArrowRight, 50*time.Millisecond)
	case tcell.KeyHome:
		_ = a.kb.Key(hid.KeyHome, 50*time.Millisecond)
	case tcell.KeyEnd:
		_ = a.kb.Key(hid.KeyEnd, 50*time.Millisecond)
	case tcell.KeyDelete:
		_ = a.kb.Key(hid.KeyDelete, 50*time.Millisecond)
	case tcell.KeyEscape:
		_ = a.kb.Key(hid.KeyEscape, 50*time.Millisecond)
	case tcell.KeyRune:
		if r := ev.Rune(); r >= 32 && r <= 126 {
			_ = a.kb.TypeString(string(r))
		}
	default:
		// Ctrl+<letter> combinations (Ctrl+A .. Ctrl+Z).
		if key >= tcell.KeyCtrlA && key <= tcell.KeyCtrlZ {
			letter := hid.KeyA + byte(key-tcell.KeyCtrlA)
			_ = a.kb.Combo(hid.ModLCtrl, letter, 50*time.Millisecond)
		}
	}
	return true
}

// scroll moves the local viewport by dir pages (-1 up, +1 down). Scrolling to
// the bottom re-enables auto-follow.
func (a *App) scroll(dir int) {
	_, h := a.sc.Size()
	viewH := h - 1
	if viewH < 1 {
		viewH = 1
	}
	step := viewH / 2
	if step < 1 {
		step = 1
	}
	a.viewRow += dir * step
	a.followBottom = false
	if a.last != nil {
		maxRow := a.last.Rows - viewH
		if maxRow < 0 {
			maxRow = 0
		}
		if a.viewRow >= maxRow {
			a.viewRow = maxRow
			a.followBottom = true
		}
	}
	if a.viewRow < 0 {
		a.viewRow = 0
	}
}

func (a *App) draw(t *screen.Text) {
	w, h := a.sc.Size()
	viewH := h - 1
	if viewH < 1 {
		viewH = 1
	}

	// Update the viewport: follow the last line of content, or stay put.
	if a.followBottom {
		last := lastNonBlankRow(t)
		a.viewRow = last - (viewH - 1)
	}
	maxRow := t.Rows - viewH
	if maxRow < 0 {
		maxRow = 0
	}
	if a.viewRow < 0 {
		a.viewRow = 0
	}
	if a.viewRow > maxRow {
		a.viewRow = maxRow
	}

	fullRedraw := a.last == nil || a.lastViewRow != a.viewRow
	a.lastViewRow = a.viewRow
	style := tcell.StyleDefault

	for r := 0; r < viewH; r++ {
		remoteR := a.viewRow + r
		for c := 0; c < w; c++ {
			var ch rune = ' '
			if remoteR < t.Rows && c < t.Cols {
				ch = rune(t.Chars[remoteR][c])
			}
			if !fullRedraw && a.last != nil && remoteR < a.last.Rows && c < a.last.Cols &&
				a.last.Chars[remoteR][c] == t.Chars[remoteR][c] {
				continue
			}
			a.sc.SetContent(c, r, ch, nil, style)
		}
	}
	a.last = t

	if t.CursorRow >= 0 {
		a.cursorRow, a.cursorCol = t.CursorRow, t.CursorCol
	}
	if y := a.cursorRow - a.viewRow; a.cursorRow >= 0 && y >= 0 && y < viewH && a.cursorCol < w {
		a.sc.ShowCursor(a.cursorCol, y)
	} else {
		a.sc.HideCursor()
	}

	// Status bar.
	scrollTag := "follow"
	if !a.followBottom {
		scrollTag = fmt.Sprintf("@%d", a.viewRow)
	}
	status := fmt.Sprintf("remote %dx%d | view %dx%d %s | PgUp/PgDn scroll | Ctrl+Q quit",
		t.Cols, t.Rows, w, viewH, scrollTag)
	statusStyle := tcell.StyleDefault.Reverse(true)
	for c := 0; c < w; c++ {
		ch := ' '
		if c < len(status) {
			ch = rune(status[c])
		}
		a.sc.SetContent(c, viewH, ch, nil, statusStyle)
	}
	a.sc.Show()
}

// lastNonBlankRow returns the index of the last row containing any non-space
// character, or 0 when the grid is empty.
func lastNonBlankRow(t *screen.Text) int {
	last := 0
	for r := 0; r < t.Rows; r++ {
		for _, c := range t.Chars[r] {
			if c != ' ' && c != 0 {
				last = r
				break
			}
		}
	}
	return last
}
