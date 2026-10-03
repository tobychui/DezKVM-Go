/*
    DezKVM-Go - IP KVM Client

    Author: tobychui

    The local KVM client (../src/www/local-kvm.js) drives the hardware straight
    from the browser: WebSerial for the CH9329 and getUserMedia for the capture
    card. In IP KVM mode the hardware hangs off the Pi instead, so this client
    talks to the Pi over three channels:

      - an <img> fed by the multipart MJPEG endpoint  /api/video/stream
      - a WebSocket carrying raw S16LE PCM            /ws/audio
      - a WebSocket carrying JSON HID events          /ws/hid

    HIDController below keeps the exact method names the local client exposes
    (SendKeyboardPress, MouseMoveAbsolute, ...) so paste-box.js,
    onscreen-keyboard.js and quick-access.js work here unmodified. What changed
    is the body of those methods: instead of building CH9329 packets they post
    an event to the backend, which owns the packet format.

    This file is part of DezKVM-Go.
    DezKVM-Go is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

/* ===========================================================================
   HID WebSocket transport
   ======================================================================== */

// Event codes, must stay in sync with EventType in mod/kvmhid/typedef.go
const HID_EVENT = {
    KEY_PRESS: 0,
    KEY_RELEASE: 1,
    MOUSE_MOVE: 2,
    MOUSE_PRESS: 3,
    MOUSE_RELEASE: 4,
    MOUSE_SCROLL: 5,
    RESET: 0xFF,
};

// Button bitmask used by the mouse_move_button_state field. This is the
// backend's ordering (bit 1 = middle), which is NOT the same as the ordering
// in MouseEvent.buttons, so masks are always built explicitly.
const HID_BTN = { LEFT: 0x01, MIDDLE: 0x02, RIGHT: 0x04 };

let hidSocket = null;
let hidReconnectTimer = null;
let hidReconnectDelay = 500;      // grows up to HID_RECONNECT_MAX on repeated failure
const HID_RECONNECT_MAX = 5000;
let hidPendingAcks = new Map();   // rid -> {resolve, reject, timer}
let hidRidCounter = 0;

function wsURL(path) {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${scheme}//${window.location.host}${path}`;
}

// isHIDConnected is also called by quick-access.js before sending a hotkey.
function isHIDConnected() {
    return hidSocket !== null && hidSocket.readyState === WebSocket.OPEN;
}

function connectHIDSocket() {
    if (hidSocket && (hidSocket.readyState === WebSocket.OPEN || hidSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }

    setConnectionState('hid', 'connecting');
    hidSocket = new WebSocket(wsURL('/ws/hid'));

    hidSocket.onopen = () => {
        hidReconnectDelay = 500;
        setConnectionState('hid', 'online');
        console.log('HID WebSocket connected');
    };

    hidSocket.onmessage = (event) => {
        // The backend only ever sends ACKs for commands that carried a rid
        let reply;
        try {
            reply = JSON.parse(event.data);
        } catch (e) {
            return;
        }
        const pending = hidPendingAcks.get(reply.rid);
        if (!pending) return;
        hidPendingAcks.delete(reply.rid);
        clearTimeout(pending.timer);
        if (reply.status === 'ok') {
            pending.resolve(reply);
        } else {
            pending.reject(new Error('HID command rejected by device'));
        }
    };

    hidSocket.onclose = () => {
        setConnectionState('hid', 'offline');
        rejectAllPendingAcks(new Error('HID connection closed'));
        scheduleHIDReconnect();
    };

    hidSocket.onerror = () => {
        // onclose always follows, the reconnect is scheduled there
        setConnectionState('hid', 'offline');
    };
}

function scheduleHIDReconnect() {
    if (hidReconnectTimer) return;
    hidReconnectTimer = setTimeout(() => {
        hidReconnectTimer = null;
        hidReconnectDelay = Math.min(hidReconnectDelay * 2, HID_RECONNECT_MAX);
        connectHIDSocket();
    }, hidReconnectDelay);
}

function rejectAllPendingAcks(err) {
    for (const [, pending] of hidPendingAcks) {
        clearTimeout(pending.timer);
        pending.reject(err);
    }
    hidPendingAcks.clear();
}

/*
    sendHIDEvent posts one event to the backend.

    Keyboard events and mouse clicks ask for an ACK so that callers which send
    a sequence (paste box, hotkeys, stacked keys) stay in order and don't race
    ahead of the serial link. Mouse movement is fire-and-forget: the backend
    drops the oldest queued move when it falls behind, and waiting for an ACK
    on every move would make the cursor lag badly on a slow link.
*/
function sendHIDEvent(payload, wantAck = false) {
    if (!isHIDConnected()) {
        return Promise.reject(new Error('HID not connected'));
    }

    if (!wantAck) {
        hidSocket.send(JSON.stringify(payload));
        return Promise.resolve();
    }

    const rid = 'r' + (++hidRidCounter);
    payload.rid = rid;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            hidPendingAcks.delete(rid);
            // A missing ACK is not fatal, the chip may simply be slow; resolve
            // so a long paste doesn't abort halfway through.
            resolve({ rid, status: 'timeout' });
        }, 1000);
        hidPendingAcks.set(rid, { resolve, reject, timer });
        try {
            hidSocket.send(JSON.stringify(payload));
        } catch (e) {
            clearTimeout(timer);
            hidPendingAcks.delete(rid);
            reject(e);
        }
    });
}

/* ===========================================================================
   HID controller

   Same public surface as the HIDController in local-kvm.js so the shared UI
   components keep working, but every method turns into a backend event.
   ======================================================================== */

class HIDController {
    constructor() {
        this.hidState = {
            MouseButtons: 0x00,                 // HID_BTN mask
            MousePosition: { x: 0, y: 0 },      // 0-4095, absolute mode only
            Modkey: 0x00,
            KeyboardButtons: [0, 0, 0, 0, 0, 0],
        };
        this.Config = {
            ScrollSensitivity: 1,   // magnitude lives on the backend, kept for API parity
            AbsoluteMode: true,
        };
    }

    // Ask the backend to soft reset the CH9329 and clear any stuck modifier.
    async softReset() {
        const res = await fetch('/api/hid/reset', { method: 'POST' });
        if (!res.ok) {
            const body = await res.json().catch(() => ({}));
            throw new Error(body.error || 'HID reset failed');
        }
        this.hidState.MouseButtons = 0x00;
        this.hidState.Modkey = 0x00;
        this.hidState.KeyboardButtons = [0, 0, 0, 0, 0, 0];
    }

    /* --- Mouse ------------------------------------------------------- */

    // Signature kept byte-oriented to match the local client. The backend
    // wants plain integers, so the bytes are recombined here.
    async MouseMoveAbsolute(xLSB, xMSB, yLSB, yMSB) {
        const x = ((xMSB & 0xFF) << 8) | (xLSB & 0xFF);
        const y = ((yMSB & 0xFF) << 8) | (yLSB & 0xFF);
        await this.sendAbsoluteMove(x, y);
    }

    // sendAbsoluteMove is the path every absolute-mode action goes through,
    // including clicks: the backend reads the button mask off the move event,
    // so a click is "move to where we already are, with the button held".
    async sendAbsoluteMove(x, y) {
        // The backend treats (0,0) as "no absolute position supplied", so the
        // very top-left pixel is nudged by one step.
        const clampedX = Math.max(1, Math.min(4095, Math.round(x)));
        const clampedY = Math.max(1, Math.min(4095, Math.round(y)));
        this.hidState.MousePosition.x = clampedX;
        this.hidState.MousePosition.y = clampedY;

        await sendHIDEvent({
            event: HID_EVENT.MOUSE_MOVE,
            mouse_x: clampedX,
            mouse_y: clampedY,
            mouse_move_button_state: this.hidState.MouseButtons,
        });
    }

    // dx/dy arrive as unsigned bytes (the CH9329 wire encoding used by the
    // local client); the backend wants signed values, so they are converted.
    async MouseMoveRelative(dx, dy, wheel) {
        const signedX = dx > 127 ? dx - 256 : dx;
        const signedY = dy > 127 ? dy - 256 : dy;
        if (signedX === 0 && signedY === 0) {
            // A zero relative move only exists to push the button state out;
            // the backend has a dedicated event pair for that.
            return;
        }
        await sendHIDEvent({
            event: HID_EVENT.MOUSE_MOVE,
            mouse_rel_x: signedX,
            mouse_rel_y: signedY,
            mouse_move_button_state: this.hidState.MouseButtons,
        });
    }

    async MouseButtonPress(button) {
        switch (button) {
            case 0x01: this.hidState.MouseButtons |= HID_BTN.LEFT; break;
            case 0x02: this.hidState.MouseButtons |= HID_BTN.RIGHT; break;
            case 0x03: this.hidState.MouseButtons |= HID_BTN.MIDDLE; break;
            default: throw new Error('invalid opcode for mouse button press');
        }
        await this.flushMouseButtons(HID_EVENT.MOUSE_PRESS, button);
    }

    async MouseButtonRelease(button) {
        switch (button) {
            case 0x00: this.hidState.MouseButtons = 0x00; break;
            case 0x01: this.hidState.MouseButtons &= ~HID_BTN.LEFT; break;
            case 0x02: this.hidState.MouseButtons &= ~HID_BTN.RIGHT; break;
            case 0x03: this.hidState.MouseButtons &= ~HID_BTN.MIDDLE; break;
            default: throw new Error('invalid opcode for mouse button release');
        }
        await this.flushMouseButtons(HID_EVENT.MOUSE_RELEASE, button);
    }

    /*
        In absolute mode the button state has to ride along with a position,
        otherwise the CH9329 emits a relative report and the host loses track
        of where the pointer is. In relative mode the dedicated press/release
        events are used, which the backend turns into a zero-delta report.
    */
    async flushMouseButtons(event, button) {
        if (this.Config.AbsoluteMode) {
            await sendHIDEvent({
                event: HID_EVENT.MOUSE_MOVE,
                mouse_x: this.hidState.MousePosition.x,
                mouse_y: this.hidState.MousePosition.y,
                mouse_move_button_state: this.hidState.MouseButtons,
            }, true);
            return;
        }
        if (button === 0x00) {
            // "Release everything" has no single-button event; release each.
            await sendHIDEvent({ event: HID_EVENT.MOUSE_RELEASE, mouse_button: 1 }, true);
            await sendHIDEvent({ event: HID_EVENT.MOUSE_RELEASE, mouse_button: 2 }, true);
            await sendHIDEvent({ event: HID_EVENT.MOUSE_RELEASE, mouse_button: 3 }, true);
            return;
        }
        await sendHIDEvent({ event: event, mouse_button: button }, true);
    }

    // tilt is signed: negative scrolls up, positive scrolls down. The step
    // size is applied by the backend from its -scroll-sensitivity flag.
    async MouseScroll(tilt) {
        if (tilt === 0) return;
        await sendHIDEvent({ event: HID_EVENT.MOUSE_SCROLL, mouse_scroll: tilt });
    }

    /* --- Keyboard ---------------------------------------------------- */

    async SetModifierKey(keycode, isRight) {
        await sendHIDEvent({
            event: HID_EVENT.KEY_PRESS,
            keycode: keycode,
            is_right_modifier_key: !!isRight,
        }, true);
    }

    async UnsetModifierKey(keycode, isRight) {
        await sendHIDEvent({
            event: HID_EVENT.KEY_RELEASE,
            keycode: keycode,
            is_right_modifier_key: !!isRight,
        }, true);
    }

    async SendKeyboardPress(keycode, isRight = false) {
        await sendHIDEvent({
            event: HID_EVENT.KEY_PRESS,
            keycode: keycode,
            is_right_modifier_key: !!isRight,
        }, true);
    }

    async SendKeyboardRelease(keycode, isRight = false) {
        await sendHIDEvent({
            event: HID_EVENT.KEY_RELEASE,
            keycode: keycode,
            is_right_modifier_key: !!isRight,
        }, true);
    }
}

// Instantiate HID controller
const controller = new HIDController();
const videoOverlayElement = document.getElementById('touchscreen');

/* ===========================================================================
   Video stream

   /api/video/stream is a never-ending multipart/x-mixed-replace response, so
   the <img> element stays "loading" for the whole session and the usual
   load/error contract does not hold. Stream health is therefore tracked from
   three independent signals: the error event, the /api/status poll, and (where
   the browser provides them) per-frame load events - see watchStreamHealth().
   ======================================================================== */

const videoElement = document.getElementById('video');
let streamGeneration = 0;      // bumped on every reload so stale handlers bail out
let lastFrameDecodeTime = 0;   // performance.now() of the last decoded frame
let streamStarted = false;
let frameLoadEvents = 0;       // how many load events this stream has produced

function videoStreamURL() {
    // The cache buster forces a fresh multipart response; without it Chrome
    // will happily reattach to the dead one after a resolution change.
    return `/api/video/stream?t=${Date.now()}`;
}

function startVideoStream() {
    const generation = ++streamGeneration;
    streamStarted = false;
    frameLoadEvents = 0;
    setConnectionState('video', 'connecting');
    showStreamOverlay('Connecting to video stream…', 'Waiting for the first frame from the capture card.');

    videoElement.onload = () => {
        if (generation !== streamGeneration) return;
        frameLoadEvents++;
        lastFrameDecodeTime = performance.now();
        if (!streamStarted) {
            streamStarted = true;
            setConnectionState('video', 'online');
            hideStreamOverlay();
            resizeTouchscreenToVideo();
        }
    };

    videoElement.onerror = () => {
        if (generation !== streamGeneration) return;
        setConnectionState('video', 'offline');
        showStreamOverlay('Video stream lost', 'Reconnecting…');
        setTimeout(() => {
            if (generation === streamGeneration) startVideoStream();
        }, 2000);
    };

    videoElement.src = videoStreamURL();
}

function reloadVideoStream() {
    // Point the element at a blank source first so the browser tears down the
    // old multipart connection; the backend hands the capture device to
    // whichever client connected last, and two live connections from the same
    // tab would fight over it.
    videoElement.removeAttribute('src');
    setTimeout(startVideoStream, 150);
}

/*
    watchStreamHealth notices a stalled stream. A dead TCP connection to the
    Pi does not fire onerror on an <img> that already produced frames, so the
    only signal left is that frames stopped arriving.

    Whether an <img> fed a multipart/x-mixed-replace response fires `load` per
    part or only for the first one is not specified and differs between
    browsers. So the watchdog calibrates itself: it stays disarmed until this
    stream has produced more than one load event, which proves the browser
    reports every frame. Where it does not, we simply fall back to the error
    event and the /api/status poll rather than restarting a healthy stream in
    a loop.
*/
function watchStreamHealth() {
    const STALL_TIMEOUT_MS = 6000;
    setInterval(() => {
        if (!streamStarted) return;
        if (frameLoadEvents < 2) return;
        if (performance.now() - lastFrameDecodeTime < STALL_TIMEOUT_MS) return;

        console.warn('No video frames for %dms, restarting the stream', STALL_TIMEOUT_MS);
        streamStarted = false;
        setConnectionState('video', 'connecting');
        showStreamOverlay('Video stream stalled', 'No frames received, reconnecting…');
        reloadVideoStream();
    }, 2000);
}

function showStreamOverlay(title, detail) {
    const overlay = document.getElementById('streamOverlay');
    if (!overlay) return;
    overlay.querySelector('.overlay-title').textContent = title;
    overlay.querySelector('.overlay-detail').textContent = detail || '';
    overlay.style.display = 'flex';
}

function hideStreamOverlay() {
    const overlay = document.getElementById('streamOverlay');
    if (overlay) overlay.style.display = 'none';
}

// getResolutionFromCurrentStream mirrors the helper of the same name in the
// local client; the shared UI code calls it to map pointer coordinates.
function getResolutionFromCurrentStream() {
    if (videoElement && videoElement.naturalWidth > 0) {
        return { width: videoElement.naturalWidth, height: videoElement.naturalHeight };
    }
    if (kvmStatus && kvmStatus.width > 0) {
        return { width: kvmStatus.width, height: kvmStatus.height };
    }
    return null;
}

/*
    resizeTouchscreenToVideo lines the invisible input overlay up with the
    letterboxed video area, so a click at the edge of the picture maps to the
    edge of the remote screen rather than to the black bar next to it.
*/
function resizeTouchscreenToVideo() {
    if (!videoElement || !videoOverlayElement) return;

    const rect = videoElement.getBoundingClientRect();
    const resolution = getResolutionFromCurrentStream();
    let aspectRatio = 16 / 9;
    if (resolution && resolution.width && resolution.height) {
        aspectRatio = resolution.width / resolution.height;
    }

    let displayWidth = rect.width;
    let displayHeight = rect.height;
    let offsetX = rect.left;
    let offsetY = rect.top;

    if (rect.width / rect.height > aspectRatio) {
        // Pillarbox: black bars left and right
        displayHeight = rect.height;
        displayWidth = rect.height * aspectRatio;
        offsetX = rect.left + (rect.width - displayWidth) / 2;
    } else {
        // Letterbox: black bars top and bottom
        displayWidth = rect.width;
        displayHeight = rect.width / aspectRatio;
        offsetY = rect.top + (rect.height - displayHeight) / 2;
    }

    videoOverlayElement.style.position = 'absolute';
    videoOverlayElement.style.left = offsetX + 'px';
    videoOverlayElement.style.top = offsetY + 'px';
    videoOverlayElement.style.width = displayWidth + 'px';
    videoOverlayElement.style.height = displayHeight + 'px';
}

window.addEventListener('resize', resizeTouchscreenToVideo);
window.addEventListener('DOMContentLoaded', resizeTouchscreenToVideo);

/* ===========================================================================
   Backend status
   ======================================================================== */

let kvmStatus = null;

async function refreshStatus() {
    try {
        const res = await fetch('/api/status');
        if (!res.ok) throw new Error('status request failed');
        kvmStatus = await res.json();
        applyStatusToUI(kvmStatus);
    } catch (e) {
        kvmStatus = null;
        setConnectionState('server', 'offline');
    }
    return kvmStatus;
}

function applyStatusToUI(status) {
    setConnectionState('server', 'online');

    const streamInfo = document.getElementById('streamInfoLabel');
    if (streamInfo) {
        streamInfo.textContent = status.stream_info || 'No signal';
    }

    // Second, browser-independent stall signal: if the capture device is not
    // running there is nothing to wait for, no matter what the <img> reports.
    if (!status.capturing && streamStarted) {
        streamStarted = false;
        setConnectionState('video', 'offline');
        showStreamOverlay('Capture stopped', 'The capture device is no longer streaming on the server.');
    }

    // The HID pill reflects the WebSocket, but if the backend has no serial
    // port at all that is the more useful thing to show.
    if (!status.hid_available) {
        setConnectionState('hid', 'offline', 'No CH9329 serial port');
    }

    updateDeviceTable(status);
}

// Connection indicator pills in the menu bar
function setConnectionState(which, state, title) {
    const dot = document.querySelector(`.conn-status[data-conn="${which}"] .dot`);
    if (!dot) return;
    dot.classList.remove('online', 'offline', 'connecting');
    dot.classList.add(state);
    const wrapper = dot.parentElement;
    if (title) {
        wrapper.setAttribute('title', title);
    } else {
        wrapper.setAttribute('title', which + ': ' + state);
    }
}

/* ===========================================================================
   Audio

   /ws/audio delivers raw interleaved stereo S16LE. The backend downsamples by
   dropping frames, so the ?quality parameter also decides the sample rate:
   high = 48kHz (no drop), standard = 24kHz (every 2nd), low = 16kHz (every 3rd).
   ======================================================================== */

const AUDIO_SAMPLE_RATES = { high: 48000, standard: 24000, low: 16000 };
const AUDIO_CHANNELS = 2;

let audioSocket = null;
let audioReconnectTimer = null;
let audioQuality = 'standard';
let audioEnabled = true;
let extraGain = 1.0;
let audioGainNode = null;
let audioNextPlayTime = 0;

// Target buffer ahead of the playback clock. Too small and every network
// hiccup is audible, too large and the audio drifts behind the picture.
const AUDIO_TARGET_LATENCY = 0.12; // seconds
const AUDIO_MAX_LATENCY = 0.5;     // resync when we drift past this

function audioSampleRate() {
    return AUDIO_SAMPLE_RATES[audioQuality] || AUDIO_SAMPLE_RATES.standard;
}

function ensureAudioContext() {
    if (!window.kvmAudioContext) {
        window.kvmAudioContext = new (window.AudioContext || window.webkitAudioContext)();
        audioGainNode = window.kvmAudioContext.createGain();
        audioGainNode.gain.value = extraGain;
        audioGainNode.connect(window.kvmAudioContext.destination);
        audioNextPlayTime = 0;
    }
    return window.kvmAudioContext;
}

function connectAudioSocket() {
    if (audioSocket && (audioSocket.readyState === WebSocket.OPEN || audioSocket.readyState === WebSocket.CONNECTING)) {
        return;
    }
    if (kvmStatus && !kvmStatus.audio_available) {
        setConnectionState('audio', 'offline', 'No audio capture device');
        return;
    }

    setConnectionState('audio', 'connecting');
    audioSocket = new WebSocket(wsURL('/ws/audio?quality=' + audioQuality));
    audioSocket.binaryType = 'arraybuffer';

    audioSocket.onopen = () => {
        setConnectionState('audio', 'online');
        audioNextPlayTime = 0;
        console.log('Audio WebSocket connected at %dHz', audioSampleRate());
    };

    audioSocket.onmessage = (event) => {
        if (!audioEnabled) return;
        playPCMChunk(event.data);
    };

    audioSocket.onclose = () => {
        setConnectionState('audio', 'offline');
        scheduleAudioReconnect();
    };

    audioSocket.onerror = () => {
        setConnectionState('audio', 'offline');
    };
}

function disconnectAudioSocket() {
    if (audioReconnectTimer) {
        clearTimeout(audioReconnectTimer);
        audioReconnectTimer = null;
    }
    if (audioSocket) {
        // The backend watches for this message and releases the ALSA device;
        // the socket close alone leaves arecord running until its next write.
        try { audioSocket.send('exit'); } catch (e) { /* already closing */ }
        audioSocket.onclose = null;
        audioSocket.close();
        audioSocket = null;
    }
    setConnectionState('audio', 'offline');
}

function scheduleAudioReconnect() {
    if (!audioEnabled || audioReconnectTimer) return;
    audioReconnectTimer = setTimeout(() => {
        audioReconnectTimer = null;
        connectAudioSocket();
    }, 2000);
}

// Restarting the socket is the only way to change the sample rate, since the
// rate is decided by the backend's downsampling.
function setAudioQuality(quality) {
    if (!AUDIO_SAMPLE_RATES[quality] || quality === audioQuality) return;
    audioQuality = quality;
    if (audioEnabled) {
        disconnectAudioSocket();
        connectAudioSocket();
    }
}

function playPCMChunk(arrayBuffer) {
    const ctx = ensureAudioContext();
    if (ctx.state === 'suspended') {
        // Autoplay policy: nothing plays until the user has interacted with
        // the page. The click handler further down resumes the context.
        return;
    }

    // Interleaved stereo S16LE -> planar float32 per channel
    const samples = new Int16Array(arrayBuffer);
    const frameCount = Math.floor(samples.length / AUDIO_CHANNELS);
    if (frameCount === 0) return;

    const buffer = ctx.createBuffer(AUDIO_CHANNELS, frameCount, audioSampleRate());
    for (let channel = 0; channel < AUDIO_CHANNELS; channel++) {
        const channelData = buffer.getChannelData(channel);
        for (let frame = 0; frame < frameCount; frame++) {
            channelData[frame] = samples[frame * AUDIO_CHANNELS + channel] / 32768;
        }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(audioGainNode);

    // Keep a small, bounded lead over the playback clock. Falling behind means
    // a dropout, running too far ahead means growing lip-sync delay; both are
    // corrected by resetting the schedule.
    const now = ctx.currentTime;
    if (audioNextPlayTime < now + 0.01 || audioNextPlayTime > now + AUDIO_MAX_LATENCY) {
        audioNextPlayTime = now + AUDIO_TARGET_LATENCY;
    }
    source.start(audioNextPlayTime);
    audioNextPlayTime += buffer.duration;
}

// Called from settings.html
function setExtraGain(value) {
    extraGain = parseFloat(value);
    if (isNaN(extraGain)) extraGain = 1.0;
    if (audioGainNode) {
        audioGainNode.gain.value = extraGain;
    }
}

// Called from settings.html
function toggleEnableAudio() {
    const chk = document.getElementById('chkSettingsEnableAudio');
    audioEnabled = chk ? chk.checked : true;
    if (audioEnabled) {
        ensureAudioContext().resume();
        connectAudioSocket();
    } else {
        disconnectAudioSocket();
    }
}

// Called from settings.html
function onAudioQualityChange() {
    const select = document.getElementById('audioQualityDropdown');
    if (select) setAudioQuality(select.value);
}

// Browsers refuse to start an AudioContext before a gesture, so the first
// interaction anywhere on the page kicks it off.
function resumeAudioOnFirstGesture() {
    const resume = () => {
        if (!audioEnabled) return;
        ensureAudioContext().resume().catch(() => {});
    };
    window.addEventListener('pointerdown', resume, { once: true });
    window.addEventListener('keydown', resume, { once: true });
}

/* ===========================================================================
   Pointer input
   ======================================================================== */

let relativeMouseEnabled = false;
let relativeMouseSensitivity = 1.0;
let invertScrollEnabled = false;
let scrollSensitivity = 2;
let showLocalCursor = true;
let ctrlCmdSwapEnabled = false;

// Absolute moves are throttled: the CH9329 link runs at 115200 baud and a
// browser happily fires several hundred mousemove events per second, which
// would queue up faster than the serial port can drain them.
const MOUSE_MOVE_INTERVAL_MS = 20;
let lastMouseMoveSent = 0;
let pendingMouseMove = null;
let pendingMouseMoveTimer = null;

// Swap Ctrl (17) and Meta/CMD (91) keycodes when swap is enabled
function swapCtrlCmd(keyCode) {
    if (!ctrlCmdSwapEnabled) return keyCode;
    if (keyCode === 17) return 91;
    if (keyCode === 91) return 17;
    return keyCode;
}

function queueAbsoluteMove(x, y) {
    pendingMouseMove = { x, y };
    const now = performance.now();
    const elapsed = now - lastMouseMoveSent;

    if (elapsed >= MOUSE_MOVE_INTERVAL_MS) {
        flushPendingMouseMove();
        return;
    }
    // Make sure the final position of a fast drag still gets delivered, even
    // if the pointer stops moving before the next tick.
    if (!pendingMouseMoveTimer) {
        pendingMouseMoveTimer = setTimeout(flushPendingMouseMove, MOUSE_MOVE_INTERVAL_MS - elapsed);
    }
}

function flushPendingMouseMove() {
    if (pendingMouseMoveTimer) {
        clearTimeout(pendingMouseMoveTimer);
        pendingMouseMoveTimer = null;
    }
    if (!pendingMouseMove) return;
    const { x, y } = pendingMouseMove;
    pendingMouseMove = null;
    lastMouseMoveSent = performance.now();
    controller.sendAbsoluteMove(x, y).catch(() => {});
}

videoOverlayElement.addEventListener('mousedown', async (e) => {
    e.preventDefault();
    // Send the position first so the click lands where the pointer is, even
    // if the throttle swallowed the last move event.
    if (controller.Config.AbsoluteMode) {
        flushPendingMouseMove();
    }
    try {
        if (e.button === 0) await controller.MouseButtonPress(0x01);       // Left
        else if (e.button === 2) await controller.MouseButtonPress(0x02);  // Right
        else if (e.button === 1) await controller.MouseButtonPress(0x03);  // Middle
    } catch (err) { /* HID offline */ }
});

videoOverlayElement.addEventListener('mouseup', async (e) => {
    try {
        if (e.button === 0) await controller.MouseButtonRelease(0x01);
        else if (e.button === 2) await controller.MouseButtonRelease(0x02);
        else if (e.button === 1) await controller.MouseButtonRelease(0x03);
    } catch (err) { /* HID offline */ }
});

// Re-request pointer lock on click when in relative mode
videoOverlayElement.addEventListener('click', function () {
    if (!controller.Config.AbsoluteMode && document.pointerLockElement !== videoOverlayElement) {
        videoOverlayElement.requestPointerLock();
    }
});

videoOverlayElement.addEventListener('mousemove', async (e) => {
    if (controller.Config.AbsoluteMode) {
        const rect = videoOverlayElement.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return;
        const offsetX = (e.clientX - rect.left) / rect.width;
        const offsetY = (e.clientY - rect.top) / rect.height;
        queueAbsoluteMove(Math.round(offsetX * 4095), Math.round(offsetY * 4095));
        return;
    }

    // Relative mode: movementX/Y carries the pointer-locked delta
    let dx = Math.round(e.movementX * relativeMouseSensitivity);
    let dy = Math.round(e.movementY * relativeMouseSensitivity);
    if (dx === 0 && dy === 0) return;

    // Clamp to the signed byte range the CH9329 accepts
    dx = Math.max(-127, Math.min(127, dx));
    dy = Math.max(-127, Math.min(127, dy));
    if (dx < 0) dx = 256 + dx;
    if (dy < 0) dy = 256 + dy;

    try {
        await controller.MouseMoveRelative(dx, dy, 0);
    } catch (err) { /* HID offline */ }
});

// Context menu disable (for right click)
videoOverlayElement.addEventListener('contextmenu', (e) => e.preventDefault());

videoOverlayElement.addEventListener('wheel', async (e) => {
    e.preventDefault();
    let tilt = e.deltaY > 0 ? scrollSensitivity : -scrollSensitivity;
    if (invertScrollEnabled) tilt = -tilt;
    try {
        await controller.MouseScroll(tilt);
    } catch (err) { /* HID offline */ }
}, { passive: false });

// Touch support: a tap maps to a left click at the tapped position.
videoOverlayElement.addEventListener('touchstart', async (e) => {
    if (!controller.Config.AbsoluteMode || e.touches.length !== 1) return;
    e.preventDefault();
    const rect = videoOverlayElement.getBoundingClientRect();
    const touch = e.touches[0];
    const offsetX = (touch.clientX - rect.left) / rect.width;
    const offsetY = (touch.clientY - rect.top) / rect.height;
    try {
        await controller.sendAbsoluteMove(offsetX * 4095, offsetY * 4095);
        await controller.MouseButtonPress(0x01);
    } catch (err) { /* HID offline */ }
}, { passive: false });

videoOverlayElement.addEventListener('touchmove', async (e) => {
    if (!controller.Config.AbsoluteMode || e.touches.length !== 1) return;
    e.preventDefault();
    const rect = videoOverlayElement.getBoundingClientRect();
    const touch = e.touches[0];
    const offsetX = (touch.clientX - rect.left) / rect.width;
    const offsetY = (touch.clientY - rect.top) / rect.height;
    queueAbsoluteMove(offsetX * 4095, offsetY * 4095);
}, { passive: false });

videoOverlayElement.addEventListener('touchend', async (e) => {
    if (!controller.Config.AbsoluteMode) return;
    e.preventDefault();
    try {
        await controller.MouseButtonRelease(0x01);
    } catch (err) { /* HID offline */ }
}, { passive: false });

/* =======================================================================
 * Stacked Keys
 * Lets the user build a key combination one key at a time (press & release
 * each key) and then send them all together in a single HID report. This
 * makes it possible to send combos the local OS would otherwise capture
 * itself (e.g. Ctrl + Alt + Del) without the host browser intercepting them.
 * ===================================================================== */
let stackKeysEnabled = true;            // master on/off for the Stacked Keys feature
let stackKeyToggleCode = 'ShiftRight';  // e.code of the toggle key (configurable)
let stackKeyLongPressMs = 1000;         // long-press to enter; 0 = short press enters
let stackModeActive = false;
let stackedKeys = [];                   // [{keyCode, location, isModifier, label}]
let _stackToggleDown = false;
let _stackToggleTimer = null;
let _stackActivatedByHold = false;
let _stackToggleModifierForwarded = false; // toggle key forwarded live as a modifier
let _stackToggleModInfo = null;            // {keyCode, isRight} of the forwarded modifier
const MAX_STACKED_REGULAR_KEYS = 6;     // HID report supports up to 6 simultaneous keys

function setStackKeysEnabled(enabled) {
    stackKeysEnabled = !!enabled;
    if (!stackKeysEnabled) {
        // Cancel any in-progress trigger or active session when disabling
        if (_stackToggleTimer) {
            clearTimeout(_stackToggleTimer);
            _stackToggleTimer = null;
        }
        hideStackTrigger();
        if (stackModeActive) exitStackMode(false);
        _stackToggleDown = false;
        _stackToggleModifierForwarded = false;
    }
}

function setStackKeyToggle(code) {
    if (typeof code === 'string' && code.length > 0) {
        stackKeyToggleCode = code;
    }
    // Changing the toggle key cancels any in-progress stack session
    if (stackModeActive) exitStackMode(false);
}

function setStackKeyLongPress(seconds) {
    let s = parseFloat(seconds);
    if (isNaN(s) || s < 0) s = 0;
    stackKeyLongPressMs = Math.round(s * 1000);
}

function isStackToggleEvent(e) {
    return e.code === stackKeyToggleCode;
}

function isModifierKeyName(key) {
    return key === 'Control' || key === 'Shift' || key === 'Alt' || key === 'Meta';
}

function formatStackKeyLabel(e) {
    const right = e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
    switch (e.key) {
        case 'Control': return right ? 'RCtrl' : 'Ctrl';
        case 'Shift':   return right ? 'RShift' : 'Shift';
        case 'Alt':     return right ? 'RAlt' : 'Alt';
        case 'Meta':    return right ? 'RWin' : 'Win';
        case ' ':       return 'Space';
        case 'Delete':  return 'Del';
        case 'Escape':  return 'Esc';
        case 'Enter':   return 'Enter';
        case 'Tab':     return 'Tab';
        case 'Backspace': return 'Bksp';
        case 'ArrowUp':    return '↑';
        case 'ArrowDown':  return '↓';
        case 'ArrowLeft':  return '←';
        case 'ArrowRight': return '→';
    }
    if (typeof e.key === 'string' && e.key.length === 1) return e.key.toUpperCase();
    return e.key;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function renderStackedKeys() {
    const disp = document.getElementById('stackedKeysDisplay');
    if (!disp) return;
    let chips;
    if (stackedKeys.length === 0) {
        chips = '<span class="stacked-keys-empty">Press keys to stack…</span>';
    } else {
        chips = stackedKeys.map(k =>
            `<span class="stacked-key-chip">${escapeHtml(k.label)}</span>`
        ).join('');
    }
    disp.innerHTML =
        '<div class="stacked-keys-title"><span class="dot"></span> Stacked Keys</div>' +
        `<div class="stacked-keys-chips">${chips}</div>` +
        '<div class="stacked-keys-hint">Toggle key: send · Backspace: undo · Esc: cancel</div>';
}

// Show the long-press trigger indicator and animate its fill over `duration` ms.
function showStackTrigger(duration) {
    const el = document.getElementById('stackTriggerIndicator');
    if (!el) return;
    const fill = el.querySelector('.fill');
    el.style.display = 'block';
    if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '0%';
        void fill.offsetWidth; // force reflow so the transition restarts
        fill.style.transition = `width ${duration}ms linear`;
        fill.style.width = '100%';
    }
}

function hideStackTrigger() {
    const el = document.getElementById('stackTriggerIndicator');
    if (!el) return;
    const fill = el.querySelector('.fill');
    el.style.display = 'none';
    if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '0%';
    }
}

function enterStackMode() {
    stackModeActive = true;
    stackedKeys = [];
    renderStackedKeys();
    const disp = document.getElementById('stackedKeysDisplay');
    if (disp) disp.style.display = 'flex';
}

async function exitStackMode(send) {
    const keys = stackedKeys.slice();
    stackModeActive = false;
    stackedKeys = [];
    _stackActivatedByHold = false;
    const disp = document.getElementById('stackedKeysDisplay');
    if (disp) disp.style.display = 'none';
    if (send && keys.length > 0) {
        await sendStackedKeys(keys);
    }
}

function addStackedKey(e) {
    const isModifier = isModifierKeyName(e.key);
    if (!isModifier) {
        const regularCount = stackedKeys.filter(k => !k.isModifier).length;
        if (regularCount >= MAX_STACKED_REGULAR_KEYS) {
            $('body').toast({
                message: `<i class="exclamation triangle icon"></i> Maximum ${MAX_STACKED_REGULAR_KEYS} non-modifier keys can be stacked`,
                class: 'warning'
            });
            return;
        }
    }
    stackedKeys.push({
        keyCode: e.keyCode,
        location: e.location,
        isModifier: isModifier,
        label: formatStackKeyLabel(e),
    });
    renderStackedKeys();
}

function undoStackedKey() {
    stackedKeys.pop();
    renderStackedKeys();
}

// Press all stacked keys together, then release them.
async function sendStackedKeys(keys) {
    if (!controller) return;
    const mods = keys.filter(k => k.isModifier);
    const regular = keys.filter(k => !k.isModifier).slice(0, MAX_STACKED_REGULAR_KEYS);
    try {
        for (const m of mods) {
            await controller.SetModifierKey(swapCtrlCmd(m.keyCode), m.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        }
        for (const r of regular) {
            await controller.SendKeyboardPress(r.keyCode);
        }
        // Brief hold so the host registers the combination
        await new Promise(res => setTimeout(res, 50));
        for (const r of regular) {
            await controller.SendKeyboardRelease(r.keyCode);
        }
        for (const m of mods) {
            await controller.UnsetModifierKey(swapCtrlCmd(m.keyCode), m.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        }
    } catch (err) {
        console.error('Failed to send stacked keys:', err);
    }
}

// Forward the toggle key as a normal tap (used when a short tap doesn't reach
// the long-press threshold, so the configured key still works normally).
async function forwardToggleKeyTap(e) {
    if (!controller) return;
    try {
        if (isModifierKeyName(e.key)) {
            const isRight = e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT;
            await controller.SetModifierKey(swapCtrlCmd(e.keyCode), isRight);
            await controller.UnsetModifierKey(swapCtrlCmd(e.keyCode), isRight);
        } else {
            await controller.SendKeyboardPress(e.keyCode);
            await controller.SendKeyboardRelease(e.keyCode);
        }
    } catch (err) {
        // Ignore unsupported keys
    }
}

// Returns true if the keydown was consumed by the Stacked Keys feature.
function handleStackKeydown(e) {
    if (!stackKeysEnabled) return false;
    if (isStackToggleEvent(e)) {
        e.preventDefault();
        if (_stackToggleDown) return true; // ignore auto-repeat
        _stackToggleDown = true;
        if (!stackModeActive && stackKeyLongPressMs > 0) {
            // In long-press mode the toggle key keeps working normally for short
            // presses. If it is a modifier (e.g. Right Shift) forward it live so
            // combos like Right Shift + letter still produce capitals.
            if (isModifierKeyName(e.key) && controller) {
                _stackToggleModifierForwarded = true;
                _stackToggleModInfo = {
                    keyCode: e.keyCode,
                    isRight: e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT,
                };
                controller.SetModifierKey(swapCtrlCmd(e.keyCode), _stackToggleModInfo.isRight).catch(() => {});
            }
            // Show the filling pill indicator while the long-press is in progress
            showStackTrigger(stackKeyLongPressMs);
            _stackToggleTimer = setTimeout(() => {
                _stackToggleTimer = null;
                hideStackTrigger();
                // Release the live-forwarded modifier before entering stack mode
                if (_stackToggleModifierForwarded && controller) {
                    controller.UnsetModifierKey(swapCtrlCmd(_stackToggleModInfo.keyCode), _stackToggleModInfo.isRight).catch(() => {});
                    _stackToggleModifierForwarded = false;
                }
                enterStackMode();
                _stackActivatedByHold = true;
            }, stackKeyLongPressMs);
        }
        return true;
    }
    if (stackModeActive) {
        e.preventDefault();
        if (e.repeat) return true;
        if (e.key === 'Escape') {
            exitStackMode(false);
        } else if (e.key === 'Backspace') {
            undoStackedKey();
        } else {
            addStackedKey(e);
        }
        return true;
    }
    return false;
}

// Returns true if the keyup was consumed by the Stacked Keys feature.
function handleStackKeyup(e) {
    if (!stackKeysEnabled) return false;
    if (isStackToggleEvent(e)) {
        e.preventDefault();
        _stackToggleDown = false;
        if (_stackToggleTimer) {
            clearTimeout(_stackToggleTimer);
            _stackToggleTimer = null;
        }
        hideStackTrigger();
        if (stackModeActive) {
            if (_stackActivatedByHold) {
                // Release of the activating long-press; stay in stack mode
                _stackActivatedByHold = false;
            } else {
                // Short press while in stack mode -> send the stack
                exitStackMode(true);
            }
        } else if (stackKeyLongPressMs === 0) {
            // Long-press disabled: a tap enters stack mode
            enterStackMode();
        } else if (_stackToggleModifierForwarded) {
            // Short tap of a modifier toggle key -> complete its normal release
            if (controller) {
                controller.UnsetModifierKey(swapCtrlCmd(_stackToggleModInfo.keyCode), _stackToggleModInfo.isRight).catch(() => {});
            }
            _stackToggleModifierForwarded = false;
        } else {
            // Short tap of a non-modifier toggle key -> forward as a normal tap
            forwardToggleKeyTap(e);
        }
        return true;
    }
    if (stackModeActive) {
        e.preventDefault();
        return true; // keys are recorded on keydown; swallow the keyup
    }
    return false;
}


/* ===========================================================================
   Keyboard input
   ======================================================================== */

// Check if the event target is a text input element
function isTypingInInput(e) {
    const tag = e.target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
}

window.addEventListener('keydown', async (e) => {
    // Skip HID forwarding when typing in input fields
    if (isTypingInInput(e)) return;

    // Stacked Keys interception (must run before Ctrl+V passthrough so that
    // keys can be stacked even when a modifier is part of the combination)
    if (handleStackKeydown(e)) return;

    // Allow Ctrl+V to be handled by paste-box.js
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') return;

    try {
        e.preventDefault();
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
            await controller.SetModifierKey(swapCtrlCmd(e.keyCode), e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        } else {
            await controller.SendKeyboardPress(e.keyCode, e.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD);
        }
    } catch (err) {
        // Unsupported key, or the HID link is down
    }
});

window.addEventListener('keyup', async (e) => {
    if (isTypingInInput(e)) return;
    if (handleStackKeyup(e)) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') return;

    try {
        e.preventDefault();
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
            await controller.UnsetModifierKey(swapCtrlCmd(e.keyCode), e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        } else {
            await controller.SendKeyboardRelease(e.keyCode, e.location === KeyboardEvent.DOM_KEY_LOCATION_NUMPAD);
        }
    } catch (err) {
        // Unsupported key, or the HID link is down
    }
});

// Called from settings.html
async function resetRemoteHID() {
    try {
        await controller.softReset();
        $('body').toast({
            message: '<i class="green check circle icon"></i> HID soft reset sent, modifier keys released.'
        });
    } catch (e) {
        $('body').toast({
            message: '<i class="red exclamation icon"></i> Failed to reset HID: ' + e.message,
            class: 'error'
        });
    }
}

/* ===========================================================================
   No-signal (colour bar) detection

   The MS2109 emits a seven stripe colour bar test pattern when no HDMI source
   is attached. Sampling a few rows of the decoded frame is enough to tell that
   apart from real content. Same approach as the local client, but reading from
   the MJPEG <img> instead of a <video>.
   ======================================================================== */

let videoCaptureOngoing = true;

(function () {
    const EXPECTED_COLORS = [
        { r: 255, g: 255, b: 255 }, // #ffffff
        { r: 255, g: 255, b: 0   }, // #ffff00
        { r: 0,   g: 234, b: 255 }, // #00eaff
        { r: 0,   g: 234, b: 0   }, // #00ea00
        { r: 255, g: 32,  b: 255 }, // #ff20ff
        { r: 255, g: 32,  b: 0   }, // #ff2000
        { r: 0,   g: 24,  b: 255 }, // #0018ff
    ];
    const COLOR_TOLERANCE = 45;
    const CHECK_INTERVAL_MS = 1000;

    const overlay = document.getElementById('noSignalOverlay');
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    function colorMatch(actual, expected) {
        return Math.abs(actual.r - expected.r) <= COLOR_TOLERANCE &&
               Math.abs(actual.g - expected.g) <= COLOR_TOLERANCE &&
               Math.abs(actual.b - expected.b) <= COLOR_TOLERANCE;
    }

    // Find the actual video content boundaries on a given row by scanning
    // inward from each edge until a non-black pixel is found.
    function findContentBounds(rowData, width) {
        const BLACK_THRESHOLD = 30;
        let left = 0;
        let right = width - 1;
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            if (rowData[idx] > BLACK_THRESHOLD || rowData[idx + 1] > BLACK_THRESHOLD || rowData[idx + 2] > BLACK_THRESHOLD) {
                left = x;
                break;
            }
        }
        for (let x = width - 1; x >= left; x--) {
            const idx = x * 4;
            if (rowData[idx] > BLACK_THRESHOLD || rowData[idx + 1] > BLACK_THRESHOLD || rowData[idx + 2] > BLACK_THRESHOLD) {
                right = x;
                break;
            }
        }
        return { left, right };
    }

    function isTestPattern() {
        if (!streamStarted || !videoElement.naturalWidth || !videoElement.naturalHeight) {
            return false; // no frames at all, the stream overlay covers this case
        }

        canvas.width = videoElement.naturalWidth;
        canvas.height = videoElement.naturalHeight;
        try {
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
        } catch (e) {
            return false; // frame not decodable yet
        }

        const stripeCount = EXPECTED_COLORS.length;
        const sampleRows = [
            Math.floor(canvas.height * 0.25),
            Math.floor(canvas.height * 0.5),
            Math.floor(canvas.height * 0.75),
        ];

        for (const row of sampleRows) {
            const rowData = ctx.getImageData(0, row, canvas.width, 1).data;
            const bounds = findContentBounds(rowData, canvas.width);
            const contentWidth = bounds.right - bounds.left + 1;
            if (contentWidth < canvas.width * 0.25) return false;

            const stripeWidth = contentWidth / stripeCount;
            for (let i = 0; i < stripeCount; i++) {
                const sampleX = Math.floor(bounds.left + stripeWidth * i + stripeWidth / 2);
                const idx = sampleX * 4;
                const actual = { r: rowData[idx], g: rowData[idx + 1], b: rowData[idx + 2] };
                if (!colorMatch(actual, EXPECTED_COLORS[i])) return false;
            }
        }
        return true;
    }

    setInterval(() => {
        const testPatternDetected = isTestPattern();
        videoCaptureOngoing = !testPatternDetected;
        overlay.style.display = testPatternDetected ? 'flex' : 'none';
    }, CHECK_INTERVAL_MS);
})();

/* ===========================================================================
   Settings overlay and the toggles it drives
   ======================================================================== */

function toggleSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    overlay.classList.toggle('visible');
    if (overlay.classList.contains('visible')) {
        refreshStatus().then(() => refreshResolutionSelector());
    }
}

function closeSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) overlay.classList.remove('visible');
}

// Close overlay when clicking the backdrop, but not the panel itself
document.addEventListener('click', function (e) {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.classList.contains('visible') && e.target === overlay) {
        closeSettingsOverlay();
    }
});

function toggleFullScreen() {
    if (document.fullscreenElement || document.webkitFullscreenElement) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        document.querySelector('#fullscreenBtn i').className = 'expand icon';
    } else {
        if (document.body.requestFullscreen) document.body.requestFullscreen();
        else if (document.body.webkitRequestFullscreen) document.body.webkitRequestFullscreen();
        document.querySelector('#fullscreenBtn i').className = 'compress icon';
    }
}

function toggleShowLocalCursor() {
    const chk = document.getElementById('chkSettingsShowLocalCursor');
    showLocalCursor = chk ? chk.checked : true;
    videoOverlayElement.style.cursor = showLocalCursor ? '' : 'none';
}

function toggleInvertScrollwheel() {
    const chk = document.getElementById('chkSettingsInvertScrollwheel');
    invertScrollEnabled = chk ? chk.checked : false;
}

function toggleRelativeMouseMode() {
    const chk = document.getElementById('chkSettingsRelativeMouseMode');
    relativeMouseEnabled = chk ? chk.checked : false;
    controller.Config.AbsoluteMode = !relativeMouseEnabled;
    if (!relativeMouseEnabled && document.pointerLockElement === videoOverlayElement) {
        document.exitPointerLock();
    }
    $('body').toast({
        message: relativeMouseEnabled
            ? '<i class="mouse pointer icon"></i> Relative mouse mode on, click the screen to capture the pointer'
            : '<i class="mouse pointer icon"></i> Absolute mouse mode on'
    });
}

function toggleCtrlCmdSwap() {
    ctrlCmdSwapEnabled = !ctrlCmdSwapEnabled;
    const btn = document.getElementById('btnCtrlCmdSwap');
    if (btn) {
        btn.classList.toggle('green', ctrlCmdSwapEnabled);
        btn.classList.toggle('grey', !ctrlCmdSwapEnabled);
    }
    if (typeof saveSettingsToLocalStorage === 'function') saveSettingsToLocalStorage();
}

let askOnPasteEnabled = false;
function toggleAskOnPaste() {
    const chk = document.getElementById('chkSettingsAskOnPaste');
    askOnPasteEnabled = chk ? chk.checked : false;
}

// The jiggler runs on the backend so it keeps the remote machine awake even
// when no browser is connected.
async function toggleMouseJiggler() {
    const chk = document.getElementById('chkSettingsMouseJiggler');
    const enable = chk ? chk.checked : false;
    try {
        await fetch('/api/hid/jiggler?enable=' + (enable ? 'true' : 'false'), { method: 'POST' });
        $('body').toast({
            message: enable
                ? '<i class="green check icon"></i> Mouse jiggler enabled'
                : '<i class="grey pause icon"></i> Mouse jiggler disabled'
        });
    } catch (e) {
        $('body').toast({ message: '<i class="red exclamation icon"></i> Failed to toggle the jiggler', class: 'error' });
    }
}

// setMouseJigglerEnabled is what settings.html calls when restoring the saved
// state, and must not raise a toast.
window.setMouseJigglerEnabled = function (enabled) {
    fetch('/api/hid/jiggler?enable=' + (enabled ? 'true' : 'false'), { method: 'POST' }).catch(() => {});
};

/* --- Capture resolution ---------------------------------------------- */

let availableResolutions = [];

async function refreshResolutionSelector() {
    const select = document.getElementById('resolutionDropdown');
    if (!select) return;

    try {
        const res = await fetch('/api/video/resolutions');
        availableResolutions = await res.json();
    } catch (e) {
        select.innerHTML = '<option>Failed to read device formats</option>';
        return;
    }

    const current = kvmStatus ? `${kvmStatus.width}x${kvmStatus.height}@${kvmStatus.fps}` : '';
    select.innerHTML = '';
    for (const entry of availableResolutions) {
        for (const fps of entry.fps) {
            const value = `${entry.width}x${entry.height}@${fps}`;
            const option = document.createElement('option');
            option.value = value;
            option.textContent = `${entry.width} × ${entry.height} @ ${fps}fps`;
            if (value === current) option.selected = true;
            select.appendChild(option);
        }
    }
}

async function applySelectedResolution() {
    const select = document.getElementById('resolutionDropdown');
    if (!select || !select.value) return;

    const match = /^(\d+)x(\d+)@(\d+)$/.exec(select.value);
    if (!match) return;
    const [, width, height, fps] = match;

    const button = document.getElementById('applyResolutionBtn');
    if (button) button.classList.add('loading');

    // Drop our own stream first: the backend hands the capture device to the
    // most recent client, and it cannot reopen the V4L2 device while this tab
    // is still pulling frames from the old one.
    videoElement.removeAttribute('src');
    streamStarted = false;

    try {
        const res = await fetch(`/api/video/resolution?width=${width}&height=${height}&fps=${fps}`, { method: 'POST' });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'resolution change failed');
        $('body').toast({ message: `<i class="green check icon"></i> Capturing at ${width} × ${height} @ ${fps}fps` });
    } catch (e) {
        $('body').toast({ message: '<i class="red exclamation icon"></i> ' + e.message, class: 'error' });
    } finally {
        if (button) button.classList.remove('loading');
        startVideoStream();
        refreshStatus();
    }
}

/* --- Device table in settings ---------------------------------------- */

function updateDeviceTable(status) {
    const tbody = document.getElementById('deviceTableBody');
    if (!tbody) return;

    const rows = [
        ['Video', status.video_device || '(none)', status.video_source],
        ['Audio', status.audio_device || '(none)', status.audio_source],
        ['Serial', status.serial_device || '(none)', status.serial_source],
        ['Stream', status.stream_info || '(not capturing)', status.capturing ? 'active' : 'stopped'],
    ];

    tbody.innerHTML = '';
    for (const [label, value, source] of rows) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${escapeHtml(label)}</td><td><code>${escapeHtml(value)}</code></td>` +
                       `<td class="device-source">${escapeHtml(source || '')}</td>`;
        tbody.appendChild(tr);
    }
}

/* ===========================================================================
   Screenshot
   ======================================================================== */

async function takeScreenshot() {
    if (!streamStarted || !videoElement.naturalWidth) {
        $('body').toast({ message: '<i class="warning icon"></i> No video stream available', class: 'warning' });
        return;
    }

    const canvas = document.createElement('canvas');
    canvas.width = videoElement.naturalWidth;
    canvas.height = videoElement.naturalHeight;
    canvas.getContext('2d').drawImage(videoElement, 0, 0);

    canvas.toBlob((blob) => {
        if (!blob) {
            $('body').toast({ message: '<i class="exclamation icon"></i> Failed to capture screenshot', class: 'error' });
            return;
        }
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
        link.href = url;
        link.download = `KVM-Screenshot-${timestamp}.png`;
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        $('body').toast({ message: '<i class="download icon"></i> Screenshot downloaded' });
    }, 'image/png');
}

/* ===========================================================================
   Startup
   ======================================================================== */

(async function init() {
    await refreshStatus();
    startVideoStream();
    watchStreamHealth();
    connectHIDSocket();
    resumeAudioOnFirstGesture();
    if (kvmStatus && kvmStatus.audio_available) {
        connectAudioSocket();
    } else {
        setConnectionState('audio', 'offline', 'No audio capture device');
    }

    // Poll the backend so the pills and the settings tables stay honest even
    // when another client takes the stream over.
    setInterval(refreshStatus, 5000);

    // The MJPEG image has no metadata event, so keep the overlay geometry in
    // sync as frames of a new size start arriving.
    setInterval(resizeTouchscreenToVideo, 1000);
})();
