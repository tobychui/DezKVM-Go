/*
    kvm-term.js

    Terminal Mode: reconstructs the remote machine's text console from the
    HDMI capture (see kvm-term-engine.js) and shows it as a crisp, selectable
    text terminal overlaid on the video area. Keystrokes keep flowing to the
    remote machine through the normal HID path; every key press triggers an
    immediate re-read of the screen.

    Terminal mode and image sharpening are mutually exclusive. The enabled
    state and the calibration are stored with the other settings
    (dezkvm_settings in localStorage, see settings.html).
*/

let kvmTermEnabled = false;

const KT_FRAME_INTERVAL = 250;  // ms between screen reads while idle
const KT_KEY_REFRESH = 60;      // ms after a key press before re-reading
const KT_KEY_HOLD = 20;         // ms a typed key is held during calibration
const KT_KEY_GAP = 20;          // ms between typed keys during calibration
const KT_FONT = '"DejaVu Sans Mono", "Cascadia Mono", Consolas, "Liberation Mono", Menlo, monospace';

const kt = {
    cal: null,          // calibration (plain JSON, persisted in settings)
    renderer: null,     // main-thread renderer (fallback + Copy Box)
    worker: null,       // render worker, false when unavailable
    timer: null,
    busy: false,
    kick: false,
    frameId: 0,
    calibrating: false,
    abort: false,
    lastText: null,
    rowHtml: [],
    layoutKey: '',
    view: null,         // current layout, see ktLayout()
    fit: false,         // scale to fit: zoom the terminal area to the window
    charRatio: 0,
    grabCanvas: null,
    grabCtx: null
};

/* ---------- DOM ---------- */

const ktOverlay = document.createElement('div');
ktOverlay.id = 'kvmTermOverlay';
ktOverlay.innerHTML = `
    <div id="kvmTermScreen" class="kvm-term-screen"></div>
    <div id="kvmTermMessage" class="kvm-term-message"></div>
    <div id="kvmTermToolbar" class="kvm-term-toolbar">
        <span id="kvmTermStatus"></span>
        <button id="kvmTermFitBtn" class="ui mini inverted basic icon button" title="Scale to fit" onclick="toggleTerminalScaleToFit()"><i class="expand arrows alternate icon"></i></button>
        <button class="ui mini inverted basic icon button" title="Calibrate terminal" onclick="kvmTermCalibrate()"><i class="crosshairs icon"></i></button>
        <button class="ui mini inverted basic icon button" title="Copy screen text" onclick="kvmTermCopyScreen()"><i class="copy icon"></i></button>
        <button class="ui mini inverted basic icon button" title="Exit terminal mode" onclick="kvmTermExit()"><i class="times icon"></i></button>
    </div>`;
document.body.appendChild(ktOverlay);
const ktScreen = document.getElementById('kvmTermScreen');
ktScreen.style.fontFamily = KT_FONT;

// Pre-escaped character table for row HTML
const KT_CHAR_HTML = (() => {
    const t = [];
    for (let i = 0; i < 256; i++) {
        if (i < 32 || i > 126) t.push('?');
        else if (i === 38) t.push('&amp;');
        else if (i === 60) t.push('&lt;');
        else if (i === 62) t.push('&gt;');
        else t.push(String.fromCharCode(i));
    }
    return t;
})();

// CSS colors for the engine's 64-color index (2 bits per channel)
const KT_COLORS = (() => {
    const lv = [0, 85, 170, 255];
    const t = [];
    for (let i = 0; i < 64; i++) t.push(`rgb(${lv[(i >> 4) & 3]},${lv[(i >> 2) & 3]},${lv[i & 3]})`);
    return t;
})();

/* ---------- Enable / disable ---------- */

function setKvmTermEnabled(enabled, silent) {
    enabled = !!enabled;
    const chk = document.getElementById('chkSettingsTerminalMode');
    if (chk) chk.checked = enabled;
    if (enabled === kvmTermEnabled) return;
    kvmTermEnabled = enabled;

    if (enabled) {
        // Mutually exclusive with image sharpening
        if (typeof imageSharpeningEnabled !== 'undefined' && imageSharpeningEnabled) {
            imageSharpeningEnabled = false;
            if (typeof window.stopSharpeningPipeline === 'function') window.stopSharpeningPipeline();
            const sharpenChk = document.getElementById('chkSettingsImageSharpening');
            if (sharpenChk) sharpenChk.checked = false;
            if (!silent) {
                $('body').toast({ message: '<i class="magic icon"></i> Image sharpening disabled (not compatible with terminal mode)' });
            }
        }
        kt.layoutKey = '';
        ktOverlay.style.display = 'block';
        ktSchedule(0);
    } else {
        clearTimeout(kt.timer);
        kt.timer = null;
        kt.abort = true;
        ktOverlay.style.display = 'none';
    }
    if (!silent) {
        $('body').toast({
            message: enabled
                ? '<i class="terminal icon"></i> Terminal mode enabled'
                : '<i class="terminal icon"></i> Terminal mode disabled'
        });
    }
}

/* Called from settings.html */
function toggleTerminalMode() {
    const chk = document.getElementById('chkSettingsTerminalMode');
    setKvmTermEnabled(chk ? chk.checked : false);
}

function kvmTermExit() {
    setKvmTermEnabled(false);
    if (typeof saveSettingsToLocalStorage === 'function') saveSettingsToLocalStorage();
}

/* ---------- Scale to fit ---------- */

function setKvmTermScaleToFit(enabled) {
    kt.fit = !!enabled;
    const chk = document.getElementById('chkSettingsTerminalScaleToFit');
    if (chk) chk.checked = kt.fit;
    const btn = document.getElementById('kvmTermFitBtn');
    btn.title = kt.fit ? 'Show at video size' : 'Scale to fit';
    btn.querySelector('i').className = kt.fit ? 'compress arrows alternate icon' : 'expand arrows alternate icon';
    kt.layoutKey = '';
    if (kvmTermEnabled) ktLayout();
}

function getKvmTermScaleToFit() {
    return kt.fit;
}

/* Called from the overlay toolbar (settings.html calls setKvmTermScaleToFit) */
function toggleTerminalScaleToFit() {
    setKvmTermScaleToFit(!kt.fit);
    if (typeof saveSettingsToLocalStorage === 'function') saveSettingsToLocalStorage();
}

/* ---------- Calibration storage ---------- */

function getKvmTermCalibration() {
    return kt.cal;
}

function setKvmTermCalibration(cal) {
    kt.cal = (cal && cal.glyphs && cal.cellW && cal.cellH) ? cal : null;
    kt.renderer = kt.cal ? new KvmTermEngine.Renderer(kt.cal) : null;
    kt.lastText = null;
    kt.rowHtml = [];
    kt.layoutKey = '';
    ktScreen.innerHTML = '';
    ktOverlay.classList.toggle('kt-light', !!(kt.cal && !kt.cal.dark));
    if (kt.worker) kt.worker.postMessage({ type: 'calibration', calibration: kt.cal });
    updateKvmTermCalibrationStatus();
    if (kvmTermEnabled) ktSchedule(0);
}

function kvmTermClearCalibration() {
    setKvmTermCalibration(null);
    if (typeof saveSettingsToLocalStorage === 'function') saveSettingsToLocalStorage();
    $('body').toast({ message: '<i class="trash icon"></i> Terminal calibration cleared' });
}

function updateKvmTermCalibrationStatus() {
    const el = document.getElementById('terminalCalibrationStatus');
    if (!el) return;
    const c = kt.cal;
    if (!c) {
        el.textContent = 'Not calibrated';
        return;
    }
    const area = ktArea(c);
    el.textContent = `Calibrated: ${area.cols}×${area.rows} character terminal (${c.cellW}×${c.cellH} px cells) at ${c.imgW}×${c.imgH}`;
}

/* ---------- Frame loop ---------- */

function ktGetWorker() {
    if (kt.worker === null) {
        try {
            kt.worker = new Worker('kvm-term-engine.js');
            kt.worker.onmessage = ktOnWorkerMessage;
            kt.worker.onerror = (e) => {
                console.warn('[KvmTerm] Worker failed, rendering on the main thread:', e.message);
                kt.worker.terminate();
                kt.worker = false;
                kt.busy = false;
                ktSchedule(0);
            };
            kt.worker.postMessage({ type: 'calibration', calibration: kt.cal });
        } catch (e) {
            console.warn('[KvmTerm] Web Worker unavailable, rendering on the main thread:', e);
            kt.worker = false;
        }
    }
    return kt.worker || null;
}

function ktOnWorkerMessage(e) {
    const msg = e.data;
    if (msg.type === 'text') {
        ktOnText(msg.text);
    } else if (msg.type === 'error') {
        kt.busy = false;
        ktShowMessage(msg.message, true);
        ktSchedule(1000);
    }
}

function ktSchedule(delay) {
    if (!kvmTermEnabled || kt.calibrating) return;
    clearTimeout(kt.timer);
    kt.timer = setTimeout(ktRequestFrame, delay);
}

// Re-read the screen soon (called on key presses)
function ktKick() {
    if (!kvmTermEnabled || kt.calibrating) return;
    if (kt.busy) kt.kick = true;
    else ktSchedule(KT_KEY_REFRESH);
}

// Returns a message describing why rendering cannot run, or '' when ready
function ktReadiness() {
    const video = document.getElementById('video');
    if (!video || !video.videoWidth || !video.videoHeight) {
        return { text: 'Waiting for the HDMI video stream…', calibrate: false };
    }
    if (!kt.cal) {
        return {
            text: '<b>Terminal mode is not calibrated.</b><br>Bring the remote machine to a Linux shell prompt, ' +
                'connect the keyboard serial port, then click Calibrate. Calibration types two short commands ' +
                'into the remote terminal to learn its grid and font.',
            calibrate: true
        };
    }
    if (video.videoWidth !== kt.cal.imgW || video.videoHeight !== kt.cal.imgH) {
        return {
            text: `<b>Resolution changed.</b><br>Terminal mode was calibrated at ${kt.cal.imgW}×${kt.cal.imgH} ` +
                `but the video is now ${video.videoWidth}×${video.videoHeight}. Please recalibrate.`,
            calibrate: true
        };
    }
    return null;
}

async function ktRequestFrame() {
    kt.timer = null;
    if (!kvmTermEnabled || kt.calibrating) return;
    if (kt.busy) {
        kt.kick = true;
        return;
    }
    ktLayout();

    const notReady = ktReadiness();
    if (notReady) {
        ktShowMessage(notReady.text, notReady.calibrate);
        ktSchedule(800);
        return;
    }
    ktHideMessage();

    // Do not replace the text while the user is selecting it
    if (ktSelectionActive()) {
        ktSetStatus('paused (selection)');
        ktSchedule(300);
        return;
    }

    kt.busy = true;
    kt.kick = false;
    const id = ++kt.frameId;
    try {
        const video = document.getElementById('video');
        const worker = ktGetWorker();
        if (worker && typeof createImageBitmap === 'function') {
            const bitmap = await createImageBitmap(video);
            worker.postMessage({ type: 'frame', id, bitmap }, [bitmap]);
        } else {
            const f = ktGrabPixels();
            const t0 = performance.now();
            const text = kt.renderer.render(f.data, f.width, f.height);
            text.ms = performance.now() - t0;
            ktOnText(text);
        }
    } catch (err) {
        kt.busy = false;
        ktShowMessage(err.message, true);
        ktSchedule(1000);
    }
}

function ktOnText(text) {
    kt.busy = false;
    if (!kvmTermEnabled || kt.calibrating) return;
    ktDraw(text);
    ktSchedule(kt.kick ? 0 : KT_FRAME_INTERVAL);
}

/* ---------- Drawing ---------- */

// Terminal area in cells (calibrations made before area detection cover
// the whole grid)
function ktArea(cal) {
    return cal.area || { col0: 0, row0: 0, cols: cal.cols, rows: cal.rows };
}

// Positions the overlay and sizes the font so every character lands on its
// cell. Normally the overlay sits exactly over the displayed video; in scale
// to fit mode it covers the window and the terminal area is zoomed to fill it.
function ktLayout() {
    const video = document.getElementById('video');
    if (!video || typeof _getSharpenCanvasRect !== 'function') return;
    const cal = kt.cal;
    const fit = kt.fit && !!cal;
    const menu = document.getElementById('menu');
    const menuBottom = (fit && menu && menu.style.display !== 'none') ? menu.getBoundingClientRect().bottom : 0;
    const box = fit
        ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
        : _getSharpenCanvasRect(video);
    const key = [fit, box.left, box.top, box.width, box.height, menuBottom].join(',');
    if (key === kt.layoutKey) return;
    kt.layoutKey = key;

    ktOverlay.style.left = box.left + 'px';
    ktOverlay.style.top = box.top + 'px';
    ktOverlay.style.width = box.width + 'px';
    ktOverlay.style.height = box.height + 'px';
    if (!cal) {
        kt.view = null;
        return;
    }

    let scale, left, top;
    if (fit) {
        // Uniform zoom of the terminal area, centered below the menu bar
        const pad = 8;
        const area = ktArea(cal);
        const areaW = area.cols * cal.cellW, areaH = area.rows * cal.cellH;
        const availTop = Math.max(pad, menuBottom + pad);
        const availH = box.height - availTop - pad;
        scale = Math.min((box.width - 2 * pad) / areaW, availH / areaH);
        left = (box.width - areaW * scale) / 2 - area.col0 * cal.cellW * scale;
        top = availTop + (availH - areaH * scale) / 2 - area.row0 * cal.cellH * scale;
    } else {
        scale = box.width / cal.imgW;
        left = cal.originX * scale;
        top = cal.originY * scale;
    }
    // Client position of cell (0,0) and px-per-video-pixel, for mapping
    // selections back to the video (Copy Box)
    kt.view = { left: box.left + left, top: box.top + top, scale };

    const cellW = cal.cellW * scale;
    const cellH = cal.cellH * scale;
    const ratio = ktCharRatio();
    const fontSize = Math.min(cellW / ratio, cellH * 0.92);
    ktScreen.style.left = left + 'px';
    ktScreen.style.top = top + 'px';
    ktScreen.style.width = (cal.cols * cellW) + 'px';
    ktScreen.style.fontSize = fontSize + 'px';
    ktScreen.style.letterSpacing = (cellW - fontSize * ratio) + 'px';
    ktScreen.style.setProperty('--kt-row-h', cellH + 'px');
}

// Advance width of the terminal font as a fraction of its size
function ktCharRatio() {
    if (!kt.charRatio) {
        const ctx = document.createElement('canvas').getContext('2d');
        ctx.font = '100px ' + KT_FONT;
        kt.charRatio = ctx.measureText('MMMMMMMMMM').width / 1000 || 0.6;
    }
    return kt.charRatio;
}

function ktSpan(run, color, flag) {
    if (!run) return '';
    const css = color === KvmTermEngine.DEFAULT_COLOR ? '' : KT_COLORS[color];
    if (flag) return `<span class="kt-inv"${css ? ` style="background:${css}"` : ''}>${run}</span>`;
    return css ? `<span style="color:${css}">${run}</span>` : run;
}

function ktRowHtml(t, r) {
    const base = r * t.cols;
    let end = t.cols;
    while (end > 0 && t.chars[base + end - 1] === 32 && !t.flags[base + end - 1]) end--;

    let html = '', run = '', runColor = KvmTermEngine.DEFAULT_COLOR, runFlag = 0;
    for (let c = 0; c < end; c++) {
        const i = base + c;
        const code = t.chars[i], flag = t.flags[i];
        // Blank cells take the current color so runs are not split
        const color = (code === 32 && !flag) ? runColor : t.colors[i];
        if (color !== runColor || flag !== runFlag) {
            html += ktSpan(run, runColor, runFlag);
            run = '';
            runColor = color;
            runFlag = flag;
        }
        run += KT_CHAR_HTML[code];
    }
    return html + ktSpan(run, runColor, runFlag);
}

function ktDraw(text) {
    kt.lastText = text;
    ktLayout();
    if (ktSelectionActive()) {
        ktSetStatus('paused (selection)');
        return;
    }
    while (ktScreen.childElementCount < text.rows) {
        const row = document.createElement('div');
        row.className = 'kvm-term-row';
        ktScreen.appendChild(row);
    }
    while (ktScreen.childElementCount > text.rows) ktScreen.lastChild.remove();

    const rows = ktScreen.children;
    for (let r = 0; r < text.rows; r++) {
        const html = ktRowHtml(text, r);
        if (kt.rowHtml[r] !== html) {
            rows[r].innerHTML = html;
            kt.rowHtml[r] = html;
        }
    }
    const area = kt.cal ? ktArea(kt.cal) : { cols: text.cols, rows: text.rows };
    ktSetStatus(`${area.cols}×${area.rows} · ${Math.round(text.ms || 0)} ms`);
}

function ktSetStatus(s) {
    document.getElementById('kvmTermStatus').textContent = s;
}

function ktShowMessage(html, showCalibrate) {
    const box = document.getElementById('kvmTermMessage');
    box.innerHTML = `<div>${html}</div>` + (showCalibrate
        ? '<div class="kvm-term-message-actions">' +
          '<button class="ui small primary button" onclick="kvmTermCalibrate()"><i class="crosshairs icon"></i> Calibrate</button>' +
          '<button class="ui small basic inverted button" onclick="kvmTermExit()">Exit terminal mode</button></div>'
        : '');
    box.style.display = 'block';
    ktOverlay.classList.add('kt-idle');
    ktSetStatus('');
}

function ktHideMessage() {
    document.getElementById('kvmTermMessage').style.display = 'none';
    ktOverlay.classList.remove('kt-idle');
}

/* ---------- Selection & copy ---------- */

function ktSelectionActive() {
    const sel = window.getSelection();
    return !!(sel && !sel.isCollapsed && sel.rangeCount &&
        ktScreen.contains(sel.getRangeAt(0).commonAncestorContainer));
}

function ktCopy(text) {
    if (!text) {
        $('body').toast({ message: '<i class="blue info circle icon"></i> Nothing to copy' });
        return;
    }
    navigator.clipboard.writeText(text).then(() => {
        $('body').toast({ message: '<i class="green check icon"></i> Copied to clipboard' });
    }).catch((err) => {
        $('body').toast({ message: '<i class="red exclamation icon"></i> Copy failed: ' + err.message, class: 'error' });
    });
}

function kvmTermCopyScreen() {
    const t = kt.lastText;
    ktCopy(t ? KvmTermEngine.textOf(t, 0, 0, t.cols, t.rows) : '');
}

/* ---------- Pixel capture ---------- */

function ktGrabPixels() {
    const video = document.getElementById('video');
    const w = video ? video.videoWidth : 0, h = video ? video.videoHeight : 0;
    if (!w || !h) throw new Error('No video stream');
    if (!kt.grabCanvas) {
        kt.grabCanvas = document.createElement('canvas');
        kt.grabCtx = kt.grabCanvas.getContext('2d', { willReadFrequently: true });
    }
    if (kt.grabCanvas.width !== w || kt.grabCanvas.height !== h) {
        kt.grabCanvas.width = w;
        kt.grabCanvas.height = h;
    }
    kt.grabCtx.drawImage(video, 0, 0, w, h);
    return { data: kt.grabCtx.getImageData(0, 0, w, h).data, width: w, height: h };
}

// Exact text inside a rectangle given in video pixel coordinates (used by
// the Copy Box). Throws when terminal mode is not calibrated for the stream.
function kvmTermRecognizeRect(sx, sy, sw, sh) {
    const cal = kt.cal;
    if (!cal) throw new Error('Terminal mode is not calibrated');
    const f = ktGrabPixels();
    const text = kt.renderer.render(f.data, f.width, f.height);
    const clampC = (v) => Math.max(0, Math.min(cal.cols, v));
    const clampR = (v) => Math.max(0, Math.min(cal.rows, v));
    const c0 = clampC(Math.round((sx - cal.originX) / cal.cellW));
    const c1 = clampC(Math.round((sx + sw - cal.originX) / cal.cellW));
    const r0 = clampR(Math.round((sy - cal.originY) / cal.cellH));
    const r1 = clampR(Math.round((sy + sh - cal.originY) / cal.cellH));
    return KvmTermEngine.textOf(text, c0, r0, c1, r1);
}

// Maps a client-space rectangle over the terminal overlay to video pixel
// coordinates, or returns null when the overlay is not showing text
function kvmTermClientToVideoRect(x, y, w, h) {
    if (!kvmTermEnabled || !kt.cal || !kt.view || ktOverlay.classList.contains('kt-idle')) return null;
    const v = kt.view, c = kt.cal;
    return {
        x: c.originX + (x - v.left) / v.scale,
        y: c.originY + (y - v.top) / v.scale,
        w: w / v.scale,
        h: h / v.scale
    };
}

function kvmTermHasUsableCalibration() {
    const video = document.getElementById('video');
    return !!(kt.cal && video && video.videoWidth === kt.cal.imgW && video.videoHeight === kt.cal.imgH);
}

/* ---------- Calibration ---------- */

// Character -> [HID usage, needs shift] for typing the calibration commands
const KT_KEYMAP = (() => {
    const m = {};
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    for (let i = 0; i < 26; i++) {
        m[letters[i]] = [0x04 + i, false];
        m[letters[i].toUpperCase()] = [0x04 + i, true];
    }
    const digits = '1234567890';
    for (let i = 0; i < 10; i++) m[digits[i]] = [0x1E + i, false];
    const unshifted = {
        ' ': 0x2C, '-': 0x2D, '=': 0x2E, '[': 0x2F, ']': 0x30, '\\': 0x31, ';': 0x33,
        '\'': 0x34, '`': 0x35, ',': 0x36, '.': 0x37, '/': 0x38, '\t': 0x2B, '\n': 0x28
    };
    const shifted = {
        '!': 0x1E, '@': 0x1F, '#': 0x20, '$': 0x21, '%': 0x22, '^': 0x23, '&': 0x24,
        '*': 0x25, '(': 0x26, ')': 0x27, '_': 0x2D, '+': 0x2E, '{': 0x2F, '}': 0x30,
        '|': 0x31, ':': 0x33, '"': 0x34, '~': 0x35, '<': 0x36, '>': 0x37, '?': 0x38
    };
    for (const k in unshifted) m[k] = [unshifted[k], false];
    for (const k in shifted) m[k] = [shifted[k], true];
    return m;
})();

const ktSleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function ktReport(mod, key) {
    const packet = [0x57, 0xAB, 0x00, 0x02, 0x08, mod, 0x00, key, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00];
    packet[13] = controller.calcChecksum(packet.slice(0, 13));
    await controller.sendPacketAndWait(packet, 0x02);
}

async function ktTap(mod, key) {
    if (kt.abort) throw new Error('Calibration cancelled');
    await ktReport(mod, key);
    await ktSleep(KT_KEY_HOLD);
    await ktReport(0x00, 0x00);
    await ktSleep(KT_KEY_GAP);
}

async function ktTypeString(s) {
    for (const ch of s) {
        const def = KT_KEYMAP[ch];
        if (!def) throw new Error('Unsupported character ' + JSON.stringify(ch));
        await ktTap(def[1] ? 0x02 : 0x00, def[0]);
    }
}

function ktClearScreen() {
    return ktTap(0x01, 0x0F); // Ctrl+L
}

function ktCalibrationStep(text) {
    const box = document.getElementById('kvmTermMessage');
    box.innerHTML = `<div class="kvm-term-progress"><div class="ui active inline inverted small loader"></div><span>${text}</span></div>` +
        '<div class="kvm-term-hint">Do not touch the keyboard. Press Esc to cancel.</div>';
    box.style.display = 'block';
}

async function kvmTermCalibrate() {
    if (kt.calibrating) return;
    if (typeof serialPort === 'undefined' || !serialPort) {
        $('body').toast({
            message: '<i class="red keyboard icon"></i> Connect the keyboard serial port (keyboard icon in the menu) before calibrating',
            class: 'error'
        });
        return;
    }
    const video = document.getElementById('video');
    if (!video || !video.videoWidth) {
        $('body').toast({ message: '<i class="warning icon"></i> No video stream available', class: 'warning' });
        return;
    }
    if (typeof closeSettingsOverlay === 'function') closeSettingsOverlay();
    if (!confirm('Terminal calibration will type two short commands into the remote machine.\n\n' +
        'Make sure the remote machine is at a Linux shell prompt (e.g. a TTY console) before continuing.')) {
        return;
    }

    if (!kvmTermEnabled) setKvmTermEnabled(true, true);
    kt.calibrating = true;
    kt.abort = false;
    clearTimeout(kt.timer);
    kt.timer = null;
    ktOverlay.classList.add('kt-idle');
    ktSetStatus('calibrating');

    // Calibration types raw reports; start from a released keyboard
    controller.hidState.Modkey = 0x00;
    controller.hidState.KeyboardButtons = [0, 0, 0, 0, 0, 0];

    try {
        ktCalibrationStep('Step 1/3 – Measuring the character grid…');
        await ktClearScreen();
        await ktSleep(300);
        await ktTypeString(KvmTermEngine.LATTICE_CMD + '\n');
        await ktSleep(1200);
        let f = ktGrabPixels();
        const geom = KvmTermEngine.measureGrid(f.data, f.width, f.height);

        ktCalibrationStep(`Step 2/3 – Learning the font (${geom.cols}×${geom.rows} grid, ${geom.cellW}×${geom.cellH} px cells)…`);
        await ktClearScreen();
        await ktSleep(300);
        await ktTypeString(KvmTermEngine.REFERENCE_CMD + '\n');
        await ktSleep(1200);
        f = ktGrabPixels();
        const result = KvmTermEngine.learnGlyphs(f.data, f.width, f.height, geom);

        ktCalibrationStep('Step 3/3 – Cleaning up…');
        await ktClearScreen();
        await ktSleep(300);

        setKvmTermCalibration(result.calibration);
        if (typeof saveSettingsToLocalStorage === 'function') saveSettingsToLocalStorage();
        const pct = Math.round(result.accuracy * 100);
        $('body').toast({
            message: `<i class="green check circle icon"></i> Terminal calibrated: ${geom.cols}×${geom.rows} characters (self-check ${pct}%)`
        });
        if (result.accuracy < 0.9) {
            $('body').toast({
                message: '<i class="yellow exclamation triangle icon"></i> Low self-check score; the video may be noisy. Try recalibrating.',
                class: 'warning'
            });
        }
    } catch (err) {
        console.error('[KvmTerm] Calibration failed:', err);
        $('body').toast({ message: '<i class="red exclamation icon"></i> Calibration failed: ' + err.message, class: 'error' });
    } finally {
        kt.calibrating = false;
        kt.abort = false;
        ktHideMessage();
        ktSchedule(0);
    }
}

/* ---------- Keyboard ---------- */

// Capture phase: runs before the HID forwarding handlers in local-kvm.js
window.addEventListener('keydown', function (e) {
    if (!kvmTermEnabled) return;
    if (kt.calibrating) {
        if (e.key === 'Escape') kt.abort = true;
        e.preventDefault();
        e.stopImmediatePropagation();
        return;
    }
    if (typeof isTypingInInput === 'function' && isTypingInInput(e)) return;
    // Ctrl+C with text selected in the terminal copies locally instead of
    // sending an interrupt to the remote machine
    if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'c' && ktSelectionActive()) {
        e.preventDefault();
        e.stopImmediatePropagation();
        ktCopy(window.getSelection().toString().replace(/[ \t]+$/gm, ''));
        return;
    }
    ktKick();
}, true);

window.addEventListener('keyup', function (e) {
    if (kvmTermEnabled && kt.calibrating) {
        e.preventDefault();
        e.stopImmediatePropagation();
    }
}, true);

window.addEventListener('resize', () => {
    kt.layoutKey = '';
    if (kvmTermEnabled) ktLayout();
});
