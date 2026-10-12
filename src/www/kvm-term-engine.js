/*
    kvm-term-engine.js

    Text reconstruction engine for Terminal Mode (ported from the kvmterm Go
    tool). It recovers the text of a monospace terminal shown in the HDMI
    capture by slicing each frame into the terminal's cell grid and matching
    every cell bitmap against glyph templates learned during calibration.

    Pure computation, no DOM access: this file is loaded on the page (for
    calibration) and also started as a Web Worker (for per-frame rendering).

    Calibration flow:
      1. LATTICE_CMD fills the remote screen with 'X'  -> measureGrid()
      2. REFERENCE_CMD prints all printable ASCII     -> learnGlyphs()
*/
(function (root) {
    'use strict';

    const MIN_CELL_W = 4, MAX_CELL_W = 24;
    const MIN_CELL_H = 8, MAX_CELL_H = 40;

    // Reference grid layout: rows alternate between segment A (codes 32..79)
    // and segment B (codes 80..126) so it fits on terminals >= 48 columns.
    const SEG_A_START = 32, SEG_A_LEN = 48;
    const SEG_B_START = 80, SEG_B_LEN = 47;

    // Lines longer than any terminal wrap to its full width and enough of
    // them scroll the whole screen, so the lattice ink outlines the terminal
    const LATTICE_CMD = "awk 'BEGIN{for(i=0;i<150;i++){for(j=0;j<500;j++)printf \"X\";printf \"\\n\"}}'";
    const REFERENCE_CMD = "awk 'BEGIN{for(r=0;r<50;r++){s=r%2?80:32;e=r%2?126:79;for(c=s;c<=e;c++)printf \"%c\",c;printf \"\\n\"}}'";

    // Inverse-video glyphs are often rendered thinner or thicker than the
    // learned ones, so their matching leans on the thickness-tolerant distance
    const INVERSE_TOL_WEIGHT = 8;

    // Color index meaning "use the terminal's default foreground"
    const DEFAULT_COLOR = 255;

    /* ---- bit helpers ---- */

    function popcount(v) {
        v = v - ((v >>> 1) & 0x55555555);
        v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
        return Math.imul((v + (v >>> 4)) & 0x0F0F0F0F, 0x01010101) >>> 24;
    }

    function rowsDistance(a, aOff, b, bOff, len) {
        let d = 0;
        for (let i = 0; i < len; i++) d += popcount(a[aOff + i] ^ b[bOff + i]);
        return d;
    }

    /* ---- binarization ---- */

    // Finds a brightness threshold separating background from text, plus the
    // polarity (dark = bright text on a dark background). Brightness is the
    // max RGB channel so colored text counts as bright.
    function detectThreshold(px) {
        const hist = new Uint32Array(256);
        for (let i = 0; i < px.length; i += 4) {
            let b = px[i];
            if (px[i + 1] > b) b = px[i + 1];
            if (px[i + 2] > b) b = px[i + 2];
            hist[b]++;
        }
        let bg = 0;
        for (let i = 1; i < 256; i++) if (hist[i] > hist[bg]) bg = i;
        const dark = bg < 128;

        // Mean text brightness. Pixels within NOISE_MARGIN of the background
        // are capture noise (MJPEG ringing) and would drag the mean down.
        const NOISE_MARGIN = 32;
        let sum = 0, cnt = 0;
        for (let b = 0; b < 256; b++) {
            if (!hist[b]) continue;
            if (dark ? b > bg + NOISE_MARGIN : b < bg - NOISE_MARGIN) {
                sum += b * hist[b];
                cnt += hist[b];
            }
        }
        let threshold;
        if (cnt === 0) {
            threshold = dark ? bg + 60 : bg - 60;
        } else {
            threshold = (bg + Math.floor(sum / cnt)) >> 1;
        }

        // Solid text level: 90th percentile of the text pixels, i.e. the
        // stroke cores rather than their anti-aliased edges. Levels are
        // stored as ink strength (brightness, or inverted brightness on a
        // light background) so inverse video works with either polarity.
        let fg = dark ? 255 : 0;
        if (cnt > 0) {
            let seen = 0;
            for (let i = 0; i < 256; i++) {
                const b = dark ? i : 255 - i;
                if (!(dark ? b > bg + NOISE_MARGIN : b < bg - NOISE_MARGIN)) continue;
                seen += hist[b];
                if (seen >= cnt * 0.9) {
                    fg = b;
                    break;
                }
            }
        }
        const level = (b) => dark ? b : 255 - b;
        return {
            threshold: Math.max(0, Math.min(255, threshold)),
            dark,
            bgLevel: level(bg),
            fgLevel: level(fg)
        };
    }

    function binarize(px, threshold, dark) {
        const mask = new Uint8Array(px.length >> 2);
        for (let i = 0, j = 0; i < px.length; i += 4, j++) {
            let b = px[i];
            if (px[i + 1] > b) b = px[i + 1];
            if (px[i + 2] > b) b = px[i + 2];
            mask[j] = (dark ? b >= threshold : b <= threshold) ? 1 : 0;
        }
        return mask;
    }

    /* ---- grid detection ---- */

    function colProjection(mask, w, h) {
        const p = new Float64Array(w);
        for (let y = 0; y < h; y++) {
            const base = y * w;
            for (let x = 0; x < w; x++) p[x] += mask[base + x];
        }
        return p;
    }

    function rowProjection(mask, w, h) {
        const p = new Float64Array(h);
        for (let y = 0; y < h; y++) {
            const base = y * w;
            let s = 0;
            for (let x = 0; x < w; x++) s += mask[base + x];
            p[y] = s;
        }
        return p;
    }

    // Dominant period of a projection via autocorrelation. A periodic signal
    // also correlates at multiples of its period, so prefer the smallest
    // divisor of the best lag that scores nearly as well.
    function autocorrPitch(proj, minPitch, maxPitch) {
        const scores = [];
        let bestPitch = 0, bestScore = -1;
        for (let k = minPitch; k <= maxPitch; k++) {
            let sum = 0, n = 0;
            for (let i = 0; i + k < proj.length; i++) {
                sum += proj[i] * proj[i + k];
                n++;
            }
            const score = n ? sum / n : 0;
            scores[k] = score;
            if (score > bestScore) {
                bestScore = score;
                bestPitch = k;
            }
        }
        for (let k = minPitch; k < bestPitch; k++) {
            if (bestPitch % k === 0 && scores[k] >= bestScore * 0.9) return k;
        }
        return bestPitch;
    }

    // Grid origin within one cell: the offset whose grid lines cross the
    // least ink (lines in the padding between glyphs). The score separates
    // into independent column and row terms. The padding is often several
    // pixels wide, so take the middle of the (circular) run of near-minimal
    // offsets to leave room for ascenders and descenders on both sides.
    function detectPhase(proj, pitch) {
        const scores = new Float64Array(pitch);
        let min = Infinity, max = -Infinity;
        for (let o = 0; o < pitch; o++) {
            let s = 0;
            for (let i = o; i < proj.length; i += pitch) s += proj[i];
            scores[o] = s;
            if (s < min) min = s;
            if (s > max) max = s;
        }
        const limit = min + (max - min) * 0.05;
        let bestStart = 0, bestLen = 0;
        for (let o = 0; o < pitch; o++) {
            if (scores[o] > limit || scores[(o - 1 + pitch) % pitch] <= limit) continue; // not a run start
            let len = 0;
            while (len < pitch && scores[(o + len) % pitch] <= limit) len++;
            if (len > bestLen) {
                bestLen = len;
                bestStart = o;
            }
        }
        if (bestLen === 0) return 0; // every offset is minimal: no structure
        return (bestStart + (bestLen >> 1)) % pitch;
    }

    // Recomputes the grid origin from a frame of text (keeps the cell size)
    function withPhase(geom, mask) {
        const w = geom.imgW, h = geom.imgH;
        const originX = detectPhase(colProjection(mask, w, h), geom.cellW);
        const originY = detectPhase(rowProjection(mask, w, h), geom.cellH);
        return Object.assign({}, geom, {
            originX,
            originY,
            cols: Math.floor((w - originX) / geom.cellW),
            rows: Math.floor((h - originY) / geom.cellH)
        });
    }

    // Measures the terminal grid from a frame filled with the lattice
    // (LATTICE_CMD output). Returns the geometry part of a calibration.
    // Pixel bounds of the lattice ink, i.e. the part of the capture covered
    // by the remote terminal. Relative limits ignore capture noise; the row
    // limit is low enough to keep a lone prompt line at the bottom.
    function inkBounds(cp, rp) {
        const span = (proj, frac) => {
            let max = 0;
            for (let i = 0; i < proj.length; i++) if (proj[i] > max) max = proj[i];
            const limit = max * frac;
            let first = 0, last = proj.length - 1;
            while (first < last && proj[first] <= limit) first++;
            while (last > first && proj[last] <= limit) last--;
            return [first, last];
        };
        const [x0, x1] = span(cp, 0.2);
        const [y0, y1] = span(rp, 0.02);
        return { x0, x1, y0, y1 };
    }

    // Terminal area in cells for a geometry carrying the lattice inkBox
    function terminalArea(geom) {
        const b = geom.inkBox;
        const clamp = (v, max) => Math.max(0, Math.min(max - 1, v));
        const col0 = clamp(Math.floor((b.x0 - geom.originX) / geom.cellW), geom.cols);
        const col1 = clamp(Math.floor((b.x1 - geom.originX) / geom.cellW), geom.cols);
        const row0 = clamp(Math.floor((b.y0 - geom.originY) / geom.cellH), geom.rows);
        const row1 = clamp(Math.floor((b.y1 - geom.originY) / geom.cellH), geom.rows);
        return { col0, row0, cols: col1 - col0 + 1, rows: row1 - row0 + 1 };
    }

    function measureGrid(px, w, h) {
        const { threshold, dark, bgLevel, fgLevel } = detectThreshold(px);
        const mask = binarize(px, threshold, dark);

        let ink = 0;
        for (let i = 0; i < mask.length; i++) ink += mask[i];
        if (ink === 0 || ink > mask.length * 0.6) {
            throw new Error('No text detected on screen; is the remote machine at a text terminal?');
        }

        const cp = colProjection(mask, w, h);
        const rp = rowProjection(mask, w, h);
        const cellW = autocorrPitch(cp, MIN_CELL_W, MAX_CELL_W);
        const cellH = autocorrPitch(rp, MIN_CELL_H, MAX_CELL_H);
        if (cellW < MIN_CELL_W || cellW > MAX_CELL_W || cellH < MIN_CELL_H || cellH > MAX_CELL_H) {
            throw new Error('Grid detection failed (cell ' + cellW + 'x' + cellH + '); is the remote machine at a text terminal?');
        }

        // The lattice only gives a rough origin: 'X' has no ascenders or
        // descenders. learnGlyphs() refines it from the reference frame.
        const inkBox = inkBounds(cp, rp);
        return withPhase({ imgW: w, imgH: h, threshold, dark, bgLevel, fgLevel, cellW, cellH, inkBox }, mask);
    }

    /* ---- glyph learning ---- */

    function extractGlyph(mask, w, x0, y0, cw, ch) {
        const rows = new Array(ch);
        for (let r = 0; r < ch; r++) {
            let bits = 0;
            const base = (y0 + r) * w + x0;
            for (let c = 0; c < cw; c++) {
                if (mask[base + c]) bits |= 1 << c;
            }
            rows[r] = bits;
        }
        return rows;
    }

    function inkOf(rows) {
        let n = 0;
        for (let i = 0; i < rows.length; i++) n += popcount(rows[i]);
        return n;
    }

    // Finds the reference grid: four consecutive rows alternating A,B,A,B.
    // Returns { aRows, bRows }, every visible copy of the A and B rows, or
    // null when the grid is not on screen.
    function findReferenceRows(mask, w, g) {
        const n = Math.min(SEG_A_LEN, SEG_B_LEN);
        const cells = (r) => {
            const out = [];
            for (let c = 0; c < n; c++) {
                out.push(extractGlyph(mask, w, g.originX + c * g.cellW, g.originY + r * g.cellH, g.cellW, g.cellH));
            }
            return out;
        };
        const cache = [];
        const rowCells = (r) => cache[r] || (cache[r] = cells(r));
        const inkedCells = (r) => rowCells(r).filter(cell => inkOf(cell) > 0).length;
        const same = (r1, r2) => {
            const a = rowCells(r1), b = rowCells(r2);
            let ok = 0;
            for (let c = 0; c < n; c++) {
                if (rowsDistance(a[c], 0, b[c], 0, g.cellH) <= 2) ok++;
            }
            return ok / n > 0.9;
        };

        for (let r = 0; r + 3 < g.rows; r++) {
            if (inkedCells(r) < n - 4 || inkedCells(r + 1) < n - 4) continue;
            if (same(r, r + 1)) continue;
            if (!same(r, r + 2) || !same(r + 1, r + 3)) continue;
            // Segment A starts with a space, segment B with 'P'
            const blank0 = inkOf(rowCells(r)[0]) === 0;
            const blank1 = inkOf(rowCells(r + 1)[0]) === 0;
            if (blank0 === blank1) continue;
            const a = blank0 ? r : r + 1, b = blank0 ? r + 1 : r;
            const copies = (first) => {
                const rows = [];
                for (let k = first; k < g.rows && same(first, k); k += 2) rows.push(k);
                return rows;
            };
            return { aRows: copies(a), bRows: copies(b) };
        }
        return null;
    }

    // Learns glyph templates from a frame showing the REFERENCE_CMD output.
    // Returns { calibration, accuracy } where accuracy is a self-check of a
    // second copy of the reference rows read back with the new templates.
    function learnGlyphs(px, w, h, lattice) {
        if (w !== lattice.imgW || h !== lattice.imgH) {
            throw new Error('Video resolution changed during calibration');
        }
        const mask = binarize(px, lattice.threshold, lattice.dark);
        // The reference frame shows every glyph, so its padding lines give
        // the true cell boundaries
        const geom = withPhase(lattice, mask);
        const area = terminalArea(geom);
        delete geom.inkBox;
        if (area.cols < SEG_A_LEN) {
            throw new Error('Remote terminal is too narrow (' + area.cols + ' columns, need ' + SEG_A_LEN + ')');
        }
        const ref = findReferenceRows(mask, w, geom);
        if (!ref) throw new Error('Could not locate the reference character grid on screen');

        // Hold out the last copy of each segment for the self-check
        const holdOut = (rows) => rows.length > 1 ? rows.pop() : -1;
        const checkA = holdOut(ref.aRows), checkB = holdOut(ref.bRows);

        // Each template is a per-pixel majority vote over all copies of its
        // reference row, which averages out capture noise
        const glyphs = {};
        const learn = (rows, start, len) => {
            const ch = geom.cellH, cw = geom.cellW;
            for (let c = 0; c < len; c++) {
                const votes = new Uint16Array(cw * ch);
                for (const row of rows) {
                    const cell = extractGlyph(mask, w, geom.originX + c * cw, geom.originY + row * ch, cw, ch);
                    for (let y = 0; y < ch; y++) {
                        for (let x = 0; x < cw; x++) votes[y * cw + x] += (cell[y] >>> x) & 1;
                    }
                }
                const tpl = new Array(ch);
                for (let y = 0; y < ch; y++) {
                    let bits = 0;
                    for (let x = 0; x < cw; x++) {
                        if (votes[y * cw + x] * 2 > rows.length) bits |= 1 << x;
                    }
                    tpl[y] = bits;
                }
                glyphs[start + c] = tpl;
            }
        };
        learn(ref.aRows, SEG_A_START, SEG_A_LEN);
        learn(ref.bRows, SEG_B_START, SEG_B_LEN);

        const calibration = Object.assign({ version: 2 }, geom, { area, glyphs });

        // Self-check: read the held-out copies back with the new templates
        const text = new Renderer(calibration).render(px, w, h);
        let ok = 0, total = 0;
        const verify = (row, start, len) => {
            if (row < 0) return;
            for (let c = 0; c < len; c++) {
                total++;
                if (text.chars[row * text.cols + c] === start + c) ok++;
            }
        };
        verify(checkA, SEG_A_START, SEG_A_LEN);
        verify(checkB, SEG_B_START, SEG_B_LEN);

        return { calibration, accuracy: total ? ok / total : 1 };
    }

    /* ---- color ---- */

    // Maps the mean color of a cell's ink to a 64-color index (2 bits per
    // channel, brightness-normalized), or DEFAULT_COLOR for grey text.
    function quantizeColor(r, g, b) {
        const max = Math.max(r, g, b), min = Math.min(r, g, b);
        if (max < 1 || max - min < 24 || max - min < max * 0.25) return DEFAULT_COLOR;
        const s = 255 / max;
        const q = (v) => Math.min(3, Math.round(v * s / 85));
        return (q(r) << 4) | (q(g) << 2) | q(b);
    }

    /* ---- rendering ---- */

    // Grows a glyph bitmap by one pixel in every direction
    function dilate(src, srcOff, dst, dstOff, ch, full) {
        for (let y = 0; y < ch; y++) {
            let v = 0;
            for (let k = y - 1; k <= y + 1; k++) {
                if (k < 0 || k >= ch) continue;
                const r = src[srcOff + k];
                v |= r | (r << 1) | (r >>> 1);
            }
            dst[dstOff + y] = v & full;
        }
    }

    // Renderer converts frames to text grids for one calibration. It caches
    // every cell bitmap so unchanged cells skip template matching.
    function Renderer(cal) {
        this.cal = cal;
        const ch = cal.cellH;
        const full = (1 << cal.cellW) - 1;
        const codes = Object.keys(cal.glyphs).map(Number).sort((a, b) => a - b);
        this.codes = Uint8Array.from(codes);
        this.tpl = new Uint32Array(codes.length * ch);
        this.dtpl = new Uint32Array(codes.length * ch);
        codes.forEach((code, i) => {
            const rows = cal.glyphs[code];
            for (let y = 0; y < ch; y++) this.tpl[i * ch + y] = (rows[y] || 0) >>> 0;
            dilate(this.tpl, i * ch, this.dtpl, i * ch, ch, full);
        });
        this.full = full;
        this.cell = new Uint32Array(ch);
        this.dcell = new Uint32Array(ch);
        this.inv = new Uint32Array(ch);
        this.levels = new Uint8Array(cal.cellW * ch);
        this.dist = 0;
        this.tol = 0;
        this.prevRows = null;
    }

    // Best template for a cell bitmap. Two distances are combined:
    //   exact - pixels that differ
    //   tol   - differing pixels farther than 1 px from the other bitmap's
    //           ink, which ignores stroke-thickness changes (bright or
    //           colored text, capture blur) but not real shape differences
    // Both distances of the best match are left in this.dist / this.tol.
    // tolWeight (default 2) sets how much the tolerant distance counts.
    Renderer.prototype.match = function (cell, tolWeight) {
        const ch = this.cal.cellH, tpl = this.tpl, dtpl = this.dtpl, n = this.codes.length;
        const dcell = this.dcell;
        const tw = tolWeight || 2;
        dilate(cell, 0, dcell, 0, ch, this.full);
        let best = 0, bestScore = Infinity, bestExact = 0, bestTol = 0;
        for (let i = 0; i < n; i++) {
            const base = i * ch;
            let exact = 0, tol = 0;
            for (let y = 0; y < ch && exact + tw * tol < bestScore; y++) {
                const c = cell[y], t = tpl[base + y];
                exact += popcount(c ^ t);
                tol += popcount(c & ~dtpl[base + y]) + popcount(t & ~dcell[y]);
            }
            const score = exact + tw * tol;
            if (score < bestScore) {
                bestScore = score;
                bestExact = exact;
                bestTol = tol;
                best = i;
                if (score === 0) break;
            }
        }
        this.dist = bestExact;
        this.tol = bestTol;
        return this.codes[best];
    };

    // Whether the last match() is close enough to trust for a cell with ink
    // pixels; poor matches are unknown glyphs (e.g. box drawing)
    Renderer.prototype.goodMatch = function (ink) {
        return this.dist <= Math.floor(ink / 3) || this.tol <= Math.max(1, Math.floor(ink / 8));
    };

    // Reads a mostly-ink cell as inverse video (highlight bars such as the
    // header in top, selections, block cursor). Returns the matched code,
    // or -1 when nothing matches well; this.dist / this.tol hold the match
    // distances.
    //
    // The block spans from the first to the last row/column that is at
    // least a quarter ink, so a bar or cursor offset from our grid by a
    // pixel leaves no stray border; interior rows and columns are always
    // kept, since in inverse video the glyph strokes are the parts with
    // little ink.
    //
    // The cell is re-binarized with its own threshold: the global one sits
    // close to the background, which would cut dark-on-light strokes much
    // thinner than the learned templates. Dark-on-light text is also often
    // rendered at a different stroke weight, so a few thresholds between
    // bar and background are tried and the best matching reading wins.
    Renderer.prototype.matchInverse = function (px, w, x0, y0, cell, barLevel) {
        const cal = this.cal, cw = cal.cellW, ch = cal.cellH, dark = cal.dark;
        let r0 = -1, r1 = -1;
        for (let y = 0; y < ch; y++) {
            if (popcount(cell[y]) * 4 > cw) {
                if (r0 < 0) r0 = y;
                r1 = y;
            }
        }
        let c0 = -1, c1 = -1;
        for (let x = 0; x < cw; x++) {
            let n = 0;
            for (let y = 0; y < ch; y++) n += (cell[y] >>> x) & 1;
            if (n * 4 > ch) {
                if (c0 < 0) c0 = x;
                c1 = x;
            }
        }
        if (r0 < 0 || c0 < 0) return -1;

        // Ink strength of every pixel in the block
        const levels = this.levels;
        for (let y = r0; y <= r1; y++) {
            let p = ((y0 + y) * w + x0 + c0) * 4;
            for (let x = c0; x <= c1; x++, p += 4) {
                let b = px[p];
                if (px[p + 1] > b) b = px[p + 1];
                if (px[p + 2] > b) b = px[p + 2];
                levels[y * cw + x] = dark ? b : 255 - b;
            }
        }

        // First candidate: the threshold at the same relative position
        // between bar and background as the global one between text and
        // background (exact for pixel-inverted bitmap fonts). Calibrations
        // from before the levels were stored fall back to halfway.
        const thrLevel = dark ? cal.threshold : 255 - cal.threshold;
        const bgLevel = cal.bgLevel !== undefined ? cal.bgLevel : 0;
        const fgLevel = cal.fgLevel !== undefined ? cal.fgLevel : 2 * thrLevel - bgLevel;
        const kCal = Math.max(0.2, Math.min(0.8, (thrLevel - bgLevel) / Math.max(1, fgLevel - bgLevel)));

        const out = this.inv;
        let bestCode = -1, bestScore = Infinity, bestDist = 0, bestTol = 0;
        let anyInk = false;
        for (const k of [kCal, 0.25, 0.5, 0.7]) {
            const t = barLevel - k * (barLevel - bgLevel);
            out.fill(0);
            let ink = 0;
            for (let y = r0; y <= r1; y++) {
                let bits = 0;
                for (let x = c0; x <= c1; x++) {
                    if (levels[y * cw + x] < t) bits |= 1 << x;
                }
                out[y] = bits;
                ink += popcount(bits);
            }
            // A strict threshold can lose a thin glyph entirely; only an
            // empty reading at every threshold means a blank cell
            if (ink === 0) continue;
            anyInk = true;
            const code = this.match(out, INVERSE_TOL_WEIGHT);
            if (code !== 32 && !this.goodMatch(ink)) continue;
            const score = this.dist + INVERSE_TOL_WEIGHT * this.tol;
            if (score < bestScore) {
                bestScore = score;
                bestCode = code;
                bestDist = this.dist;
                bestTol = this.tol;
                // Clear match (same shape, near-identical weight): done
                if (this.tol === 0 && this.dist <= ink >> 3) break;
            }
        }
        if (!anyInk) {
            this.dist = this.tol = 0;
            return 32;
        }
        this.dist = bestDist;
        this.tol = bestTol;
        return bestCode;
    };

    // Copies a cell into out with solid lines on its edges cleared (at most
    // a quarter of the cell from each side), e.g. a sliver of a neighbouring
    // highlight bar when our grid is a pixel off. Returns the ink count of
    // out, or -1 when there was nothing to clear.
    Renderer.prototype.stripEdges = function (cell, out) {
        const cw = this.cal.cellW, ch = this.cal.cellH;
        for (let y = 0; y < ch; y++) out[y] = cell[y];
        let changed = false;
        const solidRow = (y) => popcount(out[y]) * 4 >= cw * 3;
        for (let y = 0; y < ch >> 2 && solidRow(y); y++) {
            out[y] = 0;
            changed = true;
        }
        for (let y = ch - 1; y >= ch - (ch >> 2) && solidRow(y); y--) {
            out[y] = 0;
            changed = true;
        }
        const solidCol = (x) => {
            let n = 0;
            for (let y = 0; y < ch; y++) n += (out[y] >>> x) & 1;
            return n * 4 >= ch * 3;
        };
        let clearMask = 0;
        for (let x = 0; x < cw >> 2 && solidCol(x); x++) clearMask |= 1 << x;
        for (let x = cw - 1; x >= cw - (cw >> 2) && solidCol(x); x--) clearMask |= 1 << x;
        if (!changed && !clearMask) return -1;
        let ink = 0;
        for (let y = 0; y < ch; y++) {
            out[y] &= ~clearMask;
            ink += popcount(out[y]);
        }
        return ink;
    };

    // Renders a frame (RGBA pixels) into a text grid:
    //   chars[i]  - ASCII code ('?' for unknown glyphs)
    //   colors[i] - quantized ink color index or DEFAULT_COLOR
    //   flags[i]  - 1 when the cell is shown in inverse video (e.g. cursor)
    Renderer.prototype.render = function (px, w, h) {
        const cal = this.cal;
        if (w !== cal.imgW || h !== cal.imgH) {
            throw new Error('Calibrated at ' + cal.imgW + 'x' + cal.imgH + ' but the video is ' + w + 'x' + h + '; please recalibrate');
        }
        const cols = cal.cols, rows = cal.rows;
        const cw = cal.cellW, ch = cal.cellH, ox = cal.originX, oy = cal.originY;
        const thr = cal.threshold, dark = cal.dark;
        const total = cols * rows;
        const area = cw * ch;

        if (!this.prevRows) {
            this.prevRows = new Uint32Array(total * ch);
            this.prevChars = new Uint8Array(total);
            this.prevFlags = new Uint8Array(total);
            this.hasPrev = false;
        }
        const prevRows = this.prevRows, prevChars = this.prevChars, prevFlags = this.prevFlags;
        const chars = new Uint8Array(total), colors = new Uint8Array(total), flags = new Uint8Array(total);
        const cell = this.cell, inv = this.inv;

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                const idx = r * cols + c;
                const cacheBase = idx * ch;
                let same = this.hasPrev;
                let ink = 0, sr = 0, sg = 0, sb = 0, sl = 0;

                for (let y = 0; y < ch; y++) {
                    let p = ((oy + r * ch + y) * w + ox + c * cw) * 4;
                    let bits = 0;
                    for (let x = 0; x < cw; x++, p += 4) {
                        const R = px[p], G = px[p + 1], B = px[p + 2];
                        let b = R;
                        if (G > b) b = G;
                        if (B > b) b = B;
                        if (dark ? b >= thr : b <= thr) {
                            bits |= 1 << x;
                            ink++;
                            sl += b;
                            sr += R;
                            sg += G;
                            sb += B;
                        }
                    }
                    cell[y] = bits;
                    if (same && prevRows[cacheBase + y] !== bits) same = false;
                }

                colors[idx] = ink ? quantizeColor(sr / ink, sg / ink, sb / ink) : DEFAULT_COLOR;
                if (same) {
                    chars[idx] = prevChars[idx];
                    flags[idx] = prevFlags[idx];
                    continue;
                }
                for (let y = 0; y < ch; y++) prevRows[cacheBase + y] = cell[y];

                let code = 32, flag = 0;
                if (ink * 2 > area) {
                    // Mostly ink: inverse video (highlight bars such as the
                    // header in top, selections, block cursor). Glyphs never
                    // fill half their cell, so try the inverted reading first.
                    const barLevel = dark ? sl / ink : 255 - sl / ink;
                    const invCode = this.matchInverse(px, w, ox + c * cw, oy + r * ch, cell, barLevel);
                    if (invCode >= 0) {
                        code = invCode;
                        flag = 1;
                    }
                }
                if (ink > 0 && !flag) {
                    code = this.match(cell);
                    // A best match of the blank glyph means capture noise
                    if (code !== 32 && !this.goodMatch(ink)) {
                        code = 63; // '?'
                        const stripped = this.stripEdges(cell, inv);
                        if (stripped === 0) {
                            code = 32;
                        } else if (stripped > 0) {
                            const c2 = this.match(inv);
                            if (c2 === 32 || this.goodMatch(stripped)) code = c2;
                        }
                    }
                }
                chars[idx] = code;
                flags[idx] = flag;
                prevChars[idx] = code;
                prevFlags[idx] = flag;
            }
        }
        this.hasPrev = true;
        return { cols, rows, chars, colors, flags };
    };

    // Plain text of a rectangular range of cells (trailing spaces trimmed).
    function textOf(text, c0, r0, c1, r1) {
        const lines = [];
        for (let r = r0; r < r1; r++) {
            let s = '';
            for (let c = c0; c < c1; c++) s += String.fromCharCode(text.chars[r * text.cols + c]);
            lines.push(s.replace(/\s+$/, ''));
        }
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        while (lines.length && lines[0] === '') lines.shift();
        return lines.join('\n');
    }

    const api = {
        LATTICE_CMD,
        REFERENCE_CMD,
        DEFAULT_COLOR,
        measureGrid,
        learnGlyphs,
        Renderer,
        textOf
    };
    root.KvmTermEngine = api;

    /* ---- Web Worker entry point ---- */
    const isWorker = typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope;
    if (!isWorker) return;

    let renderer = null;
    let canvas = null, ctx = null;
    root.onmessage = function (e) {
        const msg = e.data;
        if (msg.type === 'calibration') {
            renderer = msg.calibration ? new Renderer(msg.calibration) : null;
            return;
        }
        if (msg.type !== 'frame') return;
        try {
            if (!renderer) throw new Error('Not calibrated');
            let px, w, h;
            if (msg.bitmap) {
                w = msg.bitmap.width;
                h = msg.bitmap.height;
                if (!canvas || canvas.width !== w || canvas.height !== h) {
                    canvas = new OffscreenCanvas(w, h);
                    ctx = canvas.getContext('2d', { willReadFrequently: true });
                }
                ctx.drawImage(msg.bitmap, 0, 0);
                msg.bitmap.close();
                px = ctx.getImageData(0, 0, w, h).data;
            } else {
                w = msg.width;
                h = msg.height;
                px = new Uint8ClampedArray(msg.buffer);
            }
            const t0 = performance.now();
            const text = renderer.render(px, w, h);
            text.ms = performance.now() - t0;
            root.postMessage({ type: 'text', id: msg.id, text }, [text.chars.buffer, text.colors.buffer, text.flags.buffer]);
        } catch (err) {
            if (msg.bitmap) msg.bitmap.close();
            root.postMessage({ type: 'error', id: msg.id, message: err.message });
        }
    };
})(typeof self !== 'undefined' ? self : this);
