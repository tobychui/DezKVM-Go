package screen

import (
	"fmt"
	"image"
	"image/png"
	"os"
	"path/filepath"
	"time"

	"kvmterm/framegrab"
	"kvmterm/hid"
)

// debugSave writes a captured frame to DIR/name when KVMTERM_DEBUG_DIR is set.
func debugSave(name string, img image.Image) {
	dir := os.Getenv("KVMTERM_DEBUG_DIR")
	if dir == "" {
		return
	}
	f, err := os.Create(filepath.Join(dir, name))
	if err != nil {
		return
	}
	defer f.Close()
	_ = png.Encode(f, img)
}

// latticeCmd fills the terminal with 'X' so the monospace grid can be measured.
const latticeCmd = "awk 'BEGIN{for(i=0;i<80;i++){for(j=0;j<200;j++)printf \"X\";printf \"\\n\"}}'"

// referenceCmd prints 50 identical rows of the 95 printable ASCII characters
// (codes 32..126), one character per cell, for glyph learning.
const referenceCmd = "awk 'BEGIN{for(r=0;r<50;r++){for(c=32;c<=126;c++)printf \"%c\",c;printf \"\\n\"}}'"

// Calibrate drives the remote terminal through the measurement and glyph-
// learning sequence and returns a Calibration ready for rendering.
//
// Precondition: the remote machine is at a shell prompt.
func Calibrate(kb *hid.Keyboard, grab *framegrab.Grabber) (*Calibration, error) {
	// 1. Lattice frame -> threshold, cell size, phase.
	fmt.Println("calibrate: printing lattice...")
	if err := kb.CtrlL(); err != nil {
		return nil, fmt.Errorf("ctrl+l: %w", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := kb.Command(latticeCmd); err != nil {
		return nil, fmt.Errorf("lattice command: %w", err)
	}
	time.Sleep(1 * time.Second)

	img, err := grab.Grab()
	if err != nil {
		return nil, fmt.Errorf("grab lattice: %w", err)
	}
	debugSave("lattice.png", img)
	thr, dark := detectThreshold(img)
	mask := binarize(img, thr, dark)
	w, h := img.Rect.Dx(), img.Rect.Dy()
	if inkFraction(mask) < 0.01 {
		return nil, fmt.Errorf("lattice frame has almost no text; is the remote logged in at a shell prompt, and is the video feed live?")
	}

	cellW, cellH := detectGrid(mask, w, h)
	if cellW < 4 || cellW > 24 || cellH < 8 || cellH > 40 {
		return nil, fmt.Errorf("grid detection failed (cellW=%d cellH=%d); is the remote at a text terminal?", cellW, cellH)
	}
	px, py := detectPhase(mask, w, h, cellW, cellH)
	// The boundary-ink minimizer can land on a font's inter-glyph blank column
	// instead of the true cell edge (an off-by-one). Realign to the left edge of
	// the leftmost glyph instead.
	proj := colProjection(mask, w, 0, h)
	for x := 0; x < w; x++ {
		if proj[x] > 0 {
			px = x % cellW
			break
		}
	}
	fmt.Printf("calibrate: grid %dx%d px, cell %dx%d, phase (%d,%d)\n", w, h, cellW, cellH, px, py)

	// 2. Reference frame -> learn glyphs.
	fmt.Println("calibrate: printing reference glyph grid...")
	if err := kb.CtrlL(); err != nil {
		return nil, fmt.Errorf("ctrl+l: %w", err)
	}
	time.Sleep(300 * time.Millisecond)
	if err := kb.Command(referenceCmd); err != nil {
		return nil, fmt.Errorf("reference command: %w", err)
	}
	time.Sleep(1 * time.Second)

	img2, err := grab.Grab()
	if err != nil {
		return nil, fmt.Errorf("grab reference: %w", err)
	}
	debugSave("reference.png", img2)
	mask2 := binarize(img2, thr, dark)
	R := findReferenceStart(mask2, w, h, cellW, cellH, px, py)

	cal := buildCalibration(w, h, cellW, cellH, px, py, thr, dark)
	for c := 0; c <= 94; c++ {
		g := extractGlyph(mask2, w, px+c*cellW, py+R*cellH, cellW, cellH)
		cal.LearnGlyph(byte(32+c), g)
	}
	if err := cal.validate(); err != nil {
		return nil, fmt.Errorf("glyph learning failed: %w", err)
	}
	fmt.Printf("calibrate: learned 95 glyphs (reference row %d)\n", R)

	// 3. Restore a clean terminal.
	if err := kb.CtrlL(); err != nil {
		return nil, fmt.Errorf("ctrl+l: %w", err)
	}
	time.Sleep(300 * time.Millisecond)
	return cal, nil
}

// inkFraction returns the fraction of mask pixels that are ink.
func inkFraction(mask []uint8) float64 {
	if len(mask) == 0 {
		return 0
	}
	n := 0
	for _, v := range mask {
		n += int(v)
	}
	return float64(n) / float64(len(mask))
}

// findReferenceStart returns the index of the first row of the reference grid
// (the first row that is byte-for-byte identical to the row below it).
func findReferenceStart(mask []uint8, w, h, cellW, cellH, px, py int) int {
	rows := h / cellH
	for r := 0; r < rows-1; r++ {
		same, total := 0, 0
		for c := 0; c <= 94; c++ {
			g1 := extractGlyph(mask, w, px+c*cellW, py+r*cellH, cellW, cellH)
			g2 := extractGlyph(mask, w, px+c*cellW, py+(r+1)*cellH, cellW, cellH)
			if glyphDistance(g1, g2) <= 2 {
				same++
			}
			total++
		}
		if total > 0 && float64(same)/float64(total) > 0.9 {
			return r
		}
	}
	return 1
}
