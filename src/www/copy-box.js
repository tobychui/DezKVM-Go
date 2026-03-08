/*
    copy-box.js

    Implements the Copy Box feature: area-select screenshot from the video
    viewport, OCR via Tesseract.js, and display/copy the extracted text.
*/

/* Global debug flag – set to false to suppress debug logs */
let cb_debug = true;
function cbLog(...args) { if (cb_debug) console.log('[CopyBox]', ...args); }

let copyBoxRawText = ''; // stores original OCR text before any processing
let copyBoxSelecting = false;
let copyBoxStartX = 0;
let copyBoxStartY = 0;
let copyBoxEndX = 0;
let copyBoxEndY = 0;
let copyBoxRect = null; // {x, y, w, h} in canvas coords

/* ── Activate area selection ── */
function startCopyBoxSelection() {
    cbLog('startCopyBoxSelection called');
    const overlay = document.getElementById('copyBoxOverlay');
    const canvas  = document.getElementById('copyBoxCanvas');
    if (!overlay || !canvas) {
        console.error('[CopyBox] Overlay or canvas element not found – HTML not loaded yet?');
        return;
    }
    // Size canvas to the full viewport
    canvas.width  = window.innerWidth;
    canvas.height = window.innerHeight;
    overlay.style.display = 'flex';
    copyBoxSelecting = false;
    copyBoxRect = null;
    clearCopyBoxCanvas();
    cbLog('Overlay shown, canvas sized to', canvas.width, 'x', canvas.height);
}

function clearCopyBoxCanvas() {
    const canvas = document.getElementById('copyBoxCanvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // Draw semi-transparent mask
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
}

function drawCopyBoxSelection(x, y, w, h) {
    const canvas = document.getElementById('copyBoxCanvas');
    const ctx = canvas.getContext('2d');
    clearCopyBoxCanvas();
    // Cut out selected area (clear the rectangle to reveal video underneath)
    ctx.clearRect(x, y, w, h);
    // Draw border
    ctx.strokeStyle = '#2185d0';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 3]);
    ctx.strokeRect(x, y, w, h);
    ctx.setLineDash([]);
}

/* ── Canvas mouse events ──
   Registered immediately (not inside DOMContentLoaded) because this script
   is loaded via AJAX after the DOM is already ready.
   We use event delegation on `document` so it works even if the canvas
   element is added/removed dynamically.
*/
(function initCopyBoxEvents() {
    cbLog('Registering copy-box event listeners');

    document.addEventListener('mousedown', function (e) {
        const overlay = document.getElementById('copyBoxOverlay');
        if (!overlay || overlay.style.display === 'none') return;
        // Only start selection on the canvas itself
        if (e.target.id !== 'copyBoxCanvas') {
            cbLog('mousedown ignored – target is', e.target.id || e.target.tagName);
            return;
        }
        copyBoxSelecting = true;
        copyBoxStartX = e.clientX;
        copyBoxStartY = e.clientY;
        copyBoxEndX = e.clientX;
        copyBoxEndY = e.clientY;
        cbLog('mousedown – selection started at', copyBoxStartX, copyBoxStartY);
    });

    document.addEventListener('mousemove', function (e) {
        if (!copyBoxSelecting) return;
        copyBoxEndX = e.clientX;
        copyBoxEndY = e.clientY;
        const x = Math.min(copyBoxStartX, copyBoxEndX);
        const y = Math.min(copyBoxStartY, copyBoxEndY);
        const w = Math.abs(copyBoxEndX - copyBoxStartX);
        const h = Math.abs(copyBoxEndY - copyBoxStartY);
        drawCopyBoxSelection(x, y, w, h);
    });

    document.addEventListener('mouseup', function (e) {
        if (!copyBoxSelecting) return;
        copyBoxSelecting = false;
        copyBoxEndX = e.clientX;
        copyBoxEndY = e.clientY;
        const x = Math.min(copyBoxStartX, copyBoxEndX);
        const y = Math.min(copyBoxStartY, copyBoxEndY);
        const w = Math.abs(copyBoxEndX - copyBoxStartX);
        const h = Math.abs(copyBoxEndY - copyBoxStartY);
        cbLog('mouseup – selection rect:', { x, y, w, h });
        if (w < 10 || h < 10) {
            cbLog('Selection too small (< 10px), ignoring');
            return;
        }

        copyBoxRect = { x, y, w, h };
        cbLog('Selection confirmed, showing language popup');
        showCopyBoxLangPopup(x, y + h); // position below the selection
    });

    /* ── Language popup buttons ── */
    document.addEventListener('click', function (e) {
        if (e.target.closest('#copyBoxCancel')) {
            cbLog('Cancel button clicked');
            closeCopyBoxLangPopup();
            closeCopyBoxOverlay();
        }
        if (e.target.closest('#copyBoxOk')) {
            cbLog('OK button clicked – starting OCR');
            closeCopyBoxLangPopup();
            closeCopyBoxOverlay();
            performOCR();
        }
        if (e.target.closest('#copyBoxCopyBtn')) {
            cbLog('Copy button clicked');
            copyBoxCopyText();
        }
        if (e.target.closest('#copyBoxCloseBtn')) {
            cbLog('Close result button clicked');
            closeCopyBoxResult();
        }
    });

    /* ── Escape key to cancel ── */
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') {
            const overlay = document.getElementById('copyBoxOverlay');
            const popup   = document.getElementById('copyBoxLangPopup');
            if (popup && popup.style.display !== 'none') {
                cbLog('Escape pressed – closing language popup');
                closeCopyBoxLangPopup();
                closeCopyBoxOverlay();
            } else if (overlay && overlay.style.display !== 'none') {
                cbLog('Escape pressed – closing overlay');
                closeCopyBoxOverlay();
            }
        }
    });

    /* ── Trim spaces checkbox toggle ── */
    document.addEventListener('change', function (e) {
        if (e.target.id === 'copyBoxTrimSpaces') {
            const textarea = document.getElementById('copyBoxTextarea');
            if (!textarea || !copyBoxRawText) return;
            if (e.target.checked) {
                cbLog('Trim spaces enabled');
                textarea.value = copyBoxRawText.replace(/ /g, '');
            } else {
                cbLog('Trim spaces disabled – restoring original');
                textarea.value = copyBoxRawText;
            }
        }
    });

    cbLog('All event listeners registered successfully');
})();

/* ── Show / hide helpers ── */
function showCopyBoxLangPopup(left, top) {
    cbLog('showCopyBoxLangPopup at', left, top);
    const popup = document.getElementById('copyBoxLangPopup');
    if (!popup) { cbLog('Language popup element not found!'); return; }

    // Clamp position so it doesn't overflow viewport
    const popupWidth = 260;
    const popupHeight = 120;
    if (left + popupWidth > window.innerWidth) left = window.innerWidth - popupWidth - 10;
    if (top + popupHeight > window.innerHeight) top = top - copyBoxRect.h - popupHeight - 10;
    if (left < 0) left = 10;
    if (top < 0) top = 10;

    popup.style.left = left + 'px';
    popup.style.top  = top + 'px';
    popup.style.display = 'block';
    cbLog('Language popup displayed at', left, top);
}

function closeCopyBoxLangPopup() {
    cbLog('closeCopyBoxLangPopup');
    const popup = document.getElementById('copyBoxLangPopup');
    if (popup) popup.style.display = 'none';
}

function closeCopyBoxOverlay() {
    cbLog('closeCopyBoxOverlay');
    const overlay = document.getElementById('copyBoxOverlay');
    if (overlay) overlay.style.display = 'none';
}

function closeCopyBoxResult() {
    cbLog('closeCopyBoxResult');
    const result = document.getElementById('copyBoxResult');
    if (result) result.style.display = 'none';
}

/* ── Capture the selected rectangle from the video ── */
function captureSelectedArea() {
    cbLog('captureSelectedArea – copyBoxRect:', copyBoxRect);
    const video = document.getElementById('video');
    if (!video || !video.srcObject) { cbLog('No video or srcObject'); return null; }

    // Map viewport coords → video pixel coords
    const videoRect = video.getBoundingClientRect();
    const resolution = (typeof getResolutionFromCurrentStream === 'function')
        ? getResolutionFromCurrentStream() : null;
    const vidW = resolution ? resolution.width  : video.videoWidth;
    const vidH = resolution ? resolution.height : video.videoHeight;

    // The video may be letterboxed/pillarboxed inside the element
    let aspectRatio = vidW / vidH;
    let displayW = videoRect.width;
    let displayH = videoRect.height;
    let offsetX = 0;
    let offsetY = 0;

    if (videoRect.width / videoRect.height > aspectRatio) {
        displayW = videoRect.height * aspectRatio;
        offsetX = (videoRect.width - displayW) / 2;
    } else {
        displayH = videoRect.width / aspectRatio;
        offsetY = (videoRect.height - displayH) / 2;
    }

    // Convert selection coords (viewport-relative) to video-pixel coords
    const selX = (copyBoxRect.x - videoRect.left - offsetX) / displayW * vidW;
    const selY = (copyBoxRect.y - videoRect.top  - offsetY) / displayH * vidH;
    const selW = copyBoxRect.w / displayW * vidW;
    const selH = copyBoxRect.h / displayH * vidH;

    // Clamp
    const sx = Math.max(0, Math.round(selX));
    const sy = Math.max(0, Math.round(selY));
    const sw = Math.min(vidW - sx, Math.round(selW));
    const sh = Math.min(vidH - sy, Math.round(selH));
    cbLog('Capture area – video coords:', { sx, sy, sw, sh }, '  video size:', vidW, 'x', vidH);
    if (sw <= 0 || sh <= 0) { cbLog('Capture area is empty after clamping'); return null; }

    // Draw the cropped region to a temporary canvas
    const canvas = document.createElement('canvas');
    canvas.width  = sw;
    canvas.height = sh;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, sw, sh);
    return canvas;
}

/* ── OCR with Tesseract.js ── */
async function performOCR() {
    cbLog('performOCR called');
    const croppedCanvas = captureSelectedArea();
    if (!croppedCanvas) {
        $('body').toast({ message: '<i class="warning icon"></i> Could not capture the selected area', class: 'warning' });
        return;
    }

    const lang = document.getElementById('copyBoxLangSelect').value || 'eng';
    cbLog('OCR language:', lang);

    // Show result container with loading state
    const resultContainer = document.getElementById('copyBoxResult');
    const textarea        = document.getElementById('copyBoxTextarea');
    const statusDiv       = document.getElementById('copyBoxStatus');
    const statusText      = document.getElementById('copyBoxStatusText');
    textarea.value = '';
    statusDiv.style.display = 'flex';
    resultContainer.style.display = 'flex';

    try {
        // Lazy-load Tesseract.js from CDN if not already loaded
        if (typeof Tesseract === 'undefined') {
            statusText.textContent = 'Loading Tesseract.js…';
            await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js');
        }

        statusText.textContent = 'Recognizing text…';

        const result = await Tesseract.recognize(croppedCanvas, lang, {
            logger: m => {
                if (m.status) {
                    statusText.textContent = m.status + (m.progress != null ? ' (' + Math.round(m.progress * 100) + '%)' : '');
                }
            }
        });

        copyBoxRawText = result.data.text;
        const trimCheckbox = document.getElementById('copyBoxTrimSpaces');
        textarea.value = (trimCheckbox && trimCheckbox.checked) ? copyBoxRawText.replace(/ /g, '') : copyBoxRawText;
        statusDiv.style.display = 'none';
        cbLog('OCR complete – extracted', copyBoxRawText.length, 'characters');

        if (!result.data.text.trim()) {
            $('body').toast({ message: '<i class="info circle icon"></i> No text detected in the selected area', class: 'info' });
        }
    } catch (err) {
        console.error('OCR error:', err);
        statusDiv.style.display = 'none';
        textarea.value = '';
        $('body').toast({ message: '<i class="exclamation icon"></i> OCR failed: ' + err.message, class: 'error' });
    }
}

/* ── Copy text to clipboard ── */
function copyBoxCopyText() {
    cbLog('copyBoxCopyText called');
    const textarea = document.getElementById('copyBoxTextarea');
    if (!textarea || !textarea.value) {
        $('body').toast({ message: '<i class="info circle icon"></i> Nothing to copy', class: 'info' });
        return;
    }
    navigator.clipboard.writeText(textarea.value).then(function () {
        $('body').toast({ message: '<i class="green check icon"></i> Copied to clipboard' });
    }).catch(function () {
        // Fallback
        textarea.select();
        document.execCommand('copy');
        $('body').toast({ message: '<i class="green check icon"></i> Copied to clipboard' });
    });
}

/* ── Utility: dynamically load a script ── */
function loadScript(src) {
    return new Promise(function (resolve, reject) {
        const s = document.createElement('script');
        s.src = src;
        s.onload = resolve;
        s.onerror = function () { reject(new Error('Failed to load ' + src)); };
        document.head.appendChild(s);
    });
}
