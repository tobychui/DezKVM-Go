package screen

import (
	"encoding/json"
	"os"
)

// calFile is the on-disk representation of a Calibration.
type calFile struct {
	Version                        int
	CellW, CellH, OriginX, OriginY int
	Cols, Rows, ImgW, ImgH         int
	Threshold                      uint8
	Dark                           bool
	Glyphs                         map[string][]uint64 // single-char key -> row bitmasks
}

// Save writes the calibration to a JSON file so it can be reused without
// re-driving the remote terminal.
func (c *Calibration) Save(path string) error {
	cf := calFile{
		Version:   1,
		CellW:     c.CellW,
		CellH:     c.CellH,
		OriginX:   c.OriginX,
		OriginY:   c.OriginY,
		Cols:      c.Cols,
		Rows:      c.Rows,
		ImgW:      c.imgW,
		ImgH:      c.imgH,
		Threshold: c.Threshold,
		Dark:      c.Dark,
		Glyphs:    make(map[string][]uint64),
	}
	for code, g := range c.glyphs {
		cf.Glyphs[string(code)] = g.rows
	}
	data, err := json.MarshalIndent(cf, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o600)
}

// LoadCalibration reads a calibration file written by Save.
func LoadCalibration(path string) (*Calibration, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cf calFile
	if err := json.Unmarshal(data, &cf); err != nil {
		return nil, err
	}
	c := buildCalibration(cf.ImgW, cf.ImgH, cf.CellW, cf.CellH, cf.OriginX, cf.OriginY, cf.Threshold, cf.Dark)
	for k, rows := range cf.Glyphs {
		if len(k) == 0 {
			continue
		}
		c.glyphs[k[0]] = &glyph{w: cf.CellW, h: cf.CellH, rows: rows}
	}
	if err := c.validate(); err != nil {
		return nil, err
	}
	return c, nil
}
