/*
    DezKVM-Go - Offline USB KVM Client

    Author: tobychui

    Note: This require HTTPS and user interaction to request serial port access.

    This file is part of DezKVM-Go.
    DezKVM-Go is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.
*/

/*
    USB Serial Communication
*/
let serialPort = null;
let serialReader = null;
let serialWriter = null;
let serialReadBuffer = [];
let selectingSerialPort = false;
let productId = "Generic"; //Generation of DezKVM GO

// Get selected baudrate from radio buttons
function getSelectedBaudrate() {
    const baudrateRadio = document.querySelector('input[name="baudrate"]:checked');
    return baudrateRadio ? parseInt(baudrateRadio.value) : 115200;
}
// Need a user triggered event to request serial port
document.getElementById('touchscreen').addEventListener('click', function(event) {
    //console.log('Video clicked at', event.clientX, event.clientY);
    if (!serialPort && !selectingSerialPort) {
        selectingSerialPort = true;
        requestSerialPort();
    }
});

// Update selected port display
function updateSelectedPortDisplay(port) {
    const selectedPortElem = document.getElementById('selectedPort');
    if (port && port.getInfo) {
        const info = port.getInfo();
        selectedPortElem.textContent = `VID: ${info.usbVendorId || '-'}, PID: ${info.usbProductId || '-'}`;
    } else if (port) {
        selectedPortElem.textContent = 'KVM Connected';
    } else {
        selectedPortElem.textContent = 'KVM Not Connected';
    }
}

// Request a new serial port
async function requestSerialPort() {
    try {
        // Disconnect previous port if connected
        if (serialPort) {
            await disconnectSerialPort();
        }
        serialPort = await navigator.serial.requestPort();
        const baudRate = getSelectedBaudrate();
        await serialPort.open({ baudRate: baudRate });
        serialReader = serialPort.readable.getReader();
        serialWriter = serialPort.writable.getWriter();
        updateSelectedPortDisplay(serialPort);

        // Change button to indicate connected state
        document.getElementById('selectSerialPort').classList.add('negative');
        document.querySelector('#selectSerialPort i').className = 'unlink icon';

        // Start reading loop for incoming data
        readSerialLoop();

        // Send a softReset command to the CH9329 to ensure it's in a known state
        setTimeout(async () => {
            $.toast({
                message: 'Initializing remote HID device...',
                showProgress: 'bottom',
                classProgress: 'green',
                displayTime: 800,
            })
            await controller.softReset();
        }, 100);
    } catch (e) {
        updateSelectedPortDisplay(null);
        if (e.name !== 'NotFoundError') {
            // Only show alert if not user cancellation
           // alert('Failed to open serial port');
        }
    } finally {
        // Reset the flag regardless of success or failure
        if (typeof selectingSerialPort !== 'undefined') {
            selectingSerialPort = false;
        }
    }
}

// Disconnect serial port
async function disconnectSerialPort() {
    try {
        if (serialReader) {
            await serialReader.cancel();
            serialReader.releaseLock();
            serialReader = null;
        }
        if (serialWriter) {
            serialWriter.releaseLock();
            serialWriter = null;
        }
        if (serialPort) {
            await serialPort.close();
            serialPort = null;
        }
    } catch (e) {}
    updateSelectedPortDisplay(null);
}

// Read loop for incoming serial data, dispatches 'data' events on parent
async function readSerialLoop() {
    while (serialPort && serialReader) {
        try {
            const { value, done } = await serialReader.read();
            if (done) break;
            if (value) {
                // Append to buffer
                serialReadBuffer.push(...value);
                //console.log('Received data:', Array.from(value).map(b => b.toString(16).padStart(2, '0')).join(' '));
            }
        } catch (e) {
            break;
        }
    }
}

// Send data over serial
async function sendSerial(data) {
    if (!serialWriter) throw new Error('Serial port not open');
    await serialWriter.write(data);
}

// Button event to select serial port
document.getElementById('selectSerialPort').addEventListener('click', function(){
    if (serialPort) {
        disconnectSerialPort();
        document.getElementById('selectSerialPort').classList.remove('negative');
        document.querySelector('#selectSerialPort i').className = 'keyboard icon';
    } else {
        requestSerialPort();
    }
});

/*
    CH9329 HID bytecode converter
*/
function resizeTouchscreenToVideo() {
    const video = document.getElementById('video');
    const touchscreen = document.getElementById('touchscreen');
    if (video && touchscreen) {
        const rect = video.getBoundingClientRect();
        const resolution = getResolutionFromCurrentStream();
        // Dynamically get video resolution and aspect ratio
        let aspectRatio = 16 / 9; // default
        if (resolution && resolution.width && resolution.height) {
            aspectRatio = resolution.width / resolution.height;
        }
        let displayWidth = rect.width;
        let displayHeight = rect.height;
        let offsetX = 0;
        let offsetY = 0;

        // Calculate the actual displayed video area (may be letterboxed/pillarboxed)
        if (rect.width / rect.height > aspectRatio) {
            // Pillarbox: black bars left/right
            displayHeight = rect.height;
            displayWidth = rect.height * aspectRatio;
            offsetX = rect.left + (rect.width - displayWidth) / 2;
            offsetY = rect.top;
        } else {
            // Letterbox: black bars top/bottom
            displayWidth = rect.width;
            displayHeight = rect.width / aspectRatio;
            offsetX = rect.left;
            offsetY = rect.top + (rect.height - displayHeight) / 2;
        }

        touchscreen.style.position = 'absolute';
        touchscreen.style.left = offsetX + 'px';
        touchscreen.style.top = offsetY + 'px';
        touchscreen.style.width = displayWidth + 'px';
        touchscreen.style.height = displayHeight + 'px';
        touchscreen.width = displayWidth;
        touchscreen.height = displayHeight;
    }
}

// Call on load and on resize
window.addEventListener('resize', resizeTouchscreenToVideo);
window.addEventListener('DOMContentLoaded', resizeTouchscreenToVideo);
setTimeout(resizeTouchscreenToVideo, 1000); // Also after 1s to ensure video is loaded

class HIDController {
    constructor() {
        this.hidState = {
            MouseButtons: 0x00,
            MousePosition: { x: 0, y: 0 }, //Only use in absolute mode
            Modkey: 0x00,
            KeyboardButtons: [0, 0, 0, 0, 0, 0]
        };
        this.Config = {
            ScrollSensitivity: 1,
            AbsoluteMode: true
        };
    }

    // Calculates checksum for a given array of bytes
    calcChecksum(arr) {
        return arr.reduce((sum, b) => (sum + b) & 0xFF, 0);
    }

    // Soft reset the CH9329 chip
    async softReset() {
        if (!serialPort || !serialPort.readable || !serialPort.writable) {
            throw new Error('Serial port not open');
        }
        const packet = [
            0x57, 0xAB, 0x00, 0x0F, 0x00, 0x00 // checksum placeholder
        ];
        packet[5] = this.calcChecksum(packet.slice(0, 5));
        await this.sendPacketAndWait(packet, 0x0F);
    }

    // Sends a packet over serial and waits for a reply with a specific command code
    async sendPacketAndWait(packet, replyCmd) {
        const timeout = 300; // 300ms timeout
        const succReplyByte = replyCmd | 0x80;
        const errorReplyByte = replyCmd | 0xC0;
        // Success example for cmd 0x04: 57 AB 00 84 01 00 87
        // Header is 57 AB 00, we can skip that
        // then the 0x84 is the replyCmd | 0x80 (or if error, 0xC4)
        // 0x01 is the data length (1 byte)
        // 0x00 is the data (success)
        // 0x87 is the checksum
        serialReadBuffer = [];
        await sendSerial(new Uint8Array(packet));

        // Wait for reply with timeout
        const startTime = Date.now();
        while (Date.now() - startTime < timeout) {
            // Look for reply packet in buffer
            // Expected format: 57 AB 00 [replyByte] [length] [data...] [checksum]
            if (serialReadBuffer.length >= 7) {
                // Find header 57 AB 00
                for (let i = 0; i <= serialReadBuffer.length - 7; i++) {
                    if (serialReadBuffer[i] === 0x57 && 
                        serialReadBuffer[i + 1] === 0xAB && 
                        serialReadBuffer[i + 2] === 0x00) {
                        
                        const replyByte = serialReadBuffer[i + 3];
                        const dataLength = serialReadBuffer[i + 4];
                        
                        // Check if we have the complete packet
                        const packetLength = 5 + dataLength + 1; // header(3) + replyByte(1) + length(1) + data + checksum(1)
                        if (i + packetLength <= serialReadBuffer.length) {
                            // Verify checksum
                            const checksumIndex = i + packetLength - 1;
                            const receivedChecksum = serialReadBuffer[checksumIndex];
                            const calculatedChecksum = this.calcChecksum(serialReadBuffer.slice(i, checksumIndex));
                            
                            if (receivedChecksum === calculatedChecksum) {
                                // Check if it's the expected reply
                                if (replyByte === succReplyByte) {
                                    // Success reply
                                    const data = serialReadBuffer.slice(i + 5, i + 5 + dataLength);
                                    // Clear processed bytes from buffer
                                    serialReadBuffer.splice(0, i + packetLength);
                                    return Promise.resolve({ success: true, data });
                                } else if (replyByte === errorReplyByte) {
                                    // Error reply
                                    const errorCode = dataLength > 0 ? serialReadBuffer[i + 5] : 0xFF;
                                    serialReadBuffer.splice(0, i + packetLength);
                                    return Promise.reject(new Error(`HID command error: 0x${errorCode.toString(16)}`))
                                }
                            }
                        }
                    }
                }
            }
            // Wait a bit before checking again
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        
        // Timeout - clear buffer and resolve (fallback to old behavior)
        serialReadBuffer = [];
        return Promise.resolve({ success: false, timeout: true });
    }

    // Mouse move absolute
    async MouseMoveAbsolute(xLSB, xMSB, yLSB, yMSB) {
        if (!serialPort || !serialPort.readable || !serialPort.writable) {
            return;
        }
        let packet = [
            0x57, 0xAB, 0x00, 0x04, 0x07, 0x02,
            this.hidState.MouseButtons,
            xLSB,
            xMSB,
            yLSB,
            yMSB,
            0x00, // Scroll
            0x00  // Checksum placeholder
        ];
        packet[12] = this.calcChecksum(packet.slice(0, 12));
        await this.sendPacketAndWait(packet, 0x04);
    }

    // Mouse move relative
    async MouseMoveRelative(dx, dy, wheel) {
         if (!serialPort || !serialPort.readable || !serialPort.writable) {
            return;
        }
        // Ensure 0x80 is not used
        if (dx === 0x80) dx = 0x81;
        if (dy === 0x80) dy = 0x81;
        let packet = [
            0x57, 0xAB, 0x00, 0x05, 0x05, 0x01,
            this.hidState.MouseButtons,
            dx,
            dy,
            wheel,
            0x00 // Checksum placeholder
        ];
        packet[10] = this.calcChecksum(packet.slice(0, 10));
        await this.sendPacketAndWait(packet, 0x05);
    }

    // Mouse button press
    async MouseButtonPress(button) {
        switch (button) {
            case 0x01: // Left
                this.hidState.MouseButtons |= 0x01;
                break;
            case 0x02: // Right
                this.hidState.MouseButtons |= 0x02;
                break;
            case 0x03: // Middle
                this.hidState.MouseButtons |= 0x04;
                break;
            default:
                throw new Error("invalid opcode for mouse button press");
        }
        if (this.Config.AbsoluteMode) {
            await this.MouseMoveAbsolute(this.hidState.MousePosition.x & 0xFF, (this.hidState.MousePosition.x >> 8) & 0xFF, this.hidState.MousePosition.y & 0xFF, (this.hidState.MousePosition.y >> 8) & 0xFF);
        }else{
            await this.MouseMoveRelative(0, 0, 0);
        }
    }

    // Mouse button release
    async MouseButtonRelease(button) {
        switch (button) {
            case 0x00: // Release all
                this.hidState.MouseButtons = 0x00;
                break;
            case 0x01: // Left
                this.hidState.MouseButtons &= ~0x01;
                break;
            case 0x02: // Right
                this.hidState.MouseButtons &= ~0x02;
                break;
            case 0x03: // Middle
                this.hidState.MouseButtons &= ~0x04;
                break;
            default:
                throw new Error("invalid opcode for mouse button release");
        }
        if (this.Config.AbsoluteMode) {
            await this.MouseMoveAbsolute(this.hidState.MousePosition.x & 0xFF, (this.hidState.MousePosition.x >> 8) & 0xFF, this.hidState.MousePosition.y & 0xFF, (this.hidState.MousePosition.y >> 8) & 0xFF);
        }else{
            await this.MouseMoveRelative(0, 0, 0);
        }
    }

    // Mouse scroll
    async MouseScroll(tilt) {
        if (tilt === 0) return;
        let wheel;
        if (tilt < 0) {
            wheel = this.Config.ScrollSensitivity;
        } else {
            wheel = 0xFF - this.Config.ScrollSensitivity;
        }
        await this.MouseMoveRelative(0, 0, wheel);
    }

    // --- Keyboard Emulation ---

    // Set modifier key (Ctrl, Shift, Alt, GUI)
    async SetModifierKey(keycode, isRight) {
        const MOD_LCTRL = 0x01, MOD_LSHIFT = 0x02, MOD_LALT = 0x04, MOD_LGUI = 0x08;
        const MOD_RCTRL = 0x10, MOD_RSHIFT = 0x20, MOD_RALT = 0x40, MOD_RGUI = 0x80;
        let modifierBit = 0;
        switch (keycode) {
            case 17: modifierBit = isRight ? MOD_RCTRL : MOD_LCTRL; break;
            case 16: modifierBit = isRight ? MOD_RSHIFT : MOD_LSHIFT; break;
            case 18: modifierBit = isRight ? MOD_RALT : MOD_LALT; break;
            case 91: modifierBit = isRight ? MOD_RGUI : MOD_LGUI; break;
            default: throw new Error("Not a modifier key");
        }
        this.hidState.Modkey |= modifierBit;
        await this.keyboardSendKeyCombinations();
    }

    // Unset modifier key (Ctrl, Shift, Alt, GUI)
    async UnsetModifierKey(keycode, isRight) {
        const MOD_LCTRL = 0x01, MOD_LSHIFT = 0x02, MOD_LALT = 0x04, MOD_LGUI = 0x08;
        const MOD_RCTRL = 0x10, MOD_RSHIFT = 0x20, MOD_RALT = 0x40, MOD_RGUI = 0x80;
        let modifierBit = 0;
        switch (keycode) {
            case 17: modifierBit = isRight ? MOD_RCTRL : MOD_LCTRL; break;
            case 16: modifierBit = isRight ? MOD_RSHIFT : MOD_LSHIFT; break;
            case 18: modifierBit = isRight ? MOD_RALT : MOD_LALT; break;
            case 91: modifierBit = isRight ? MOD_RGUI : MOD_LGUI; break;
            default: throw new Error("Not a modifier key");
        }
        this.hidState.Modkey &= ~modifierBit;
        await this.keyboardSendKeyCombinations();
    }

    // Send a keyboard press by JavaScript keycode
    async SendKeyboardPress(keycode) {
        const hid = this.javaScriptKeycodeToHIDOpcode(keycode);
        if (hid === 0x00) throw new Error("Unsupported keycode: " + keycode);
        // Already pressed?
        for (let i = 0; i < 6; i++) {
            if (this.hidState.KeyboardButtons[i] === hid) return;
        }
        // Find empty slot
        for (let i = 0; i < 6; i++) {
            if (this.hidState.KeyboardButtons[i] === 0x00) {
                this.hidState.KeyboardButtons[i] = hid;
                await this.keyboardSendKeyCombinations();
                return;
            }
        }
        throw new Error("No space left in keyboard state to press key: " + keycode);
    }

    // Send a keyboard release by JavaScript keycode
    async SendKeyboardRelease(keycode) {
        const hid = this.javaScriptKeycodeToHIDOpcode(keycode);
        if (hid === 0x00) throw new Error("Unsupported keycode: " + keycode);
        for (let i = 0; i < 6; i++) {
            if (this.hidState.KeyboardButtons[i] === hid) {
                this.hidState.KeyboardButtons[i] = 0x00;
                await this.keyboardSendKeyCombinations();
                return;
            }
        }
        // Not pressed, do nothing
    }

    // Send the current key combinations (modifiers + up to 6 keys)
    async keyboardSendKeyCombinations() {
        const packet = [
            0x57, 0xAB, 0x00, 0x02, 0x08,
            this.hidState.Modkey, 0x00,
            0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
            0x00
        ];
        for (let i = 0; i < 6; i++) {
            packet[7 + i] = this.hidState.KeyboardButtons[i] || 0x00;
        }
        packet[13] = this.calcChecksum(packet.slice(0, 13));
        await this.sendPacketAndWait(packet, 0x02);
    }

    // Convert JavaScript keycode to HID keycode
    javaScriptKeycodeToHIDOpcode(keycode) {
        // Letters A-Z
        if (keycode >= 65 && keycode <= 90) return (keycode - 65) + 0x04;
        // Numbers 1-9 (top row, not numpad)
        if (keycode >= 49 && keycode <= 57) return (keycode - 49) + 0x1E;
        // F1 to F12
        if (keycode >= 112 && keycode <= 123) return (keycode - 112) + 0x3A;
        switch (keycode) {
            case 8: return 0x2A; // Backspace
            case 9: return 0x2B; // Tab
            case 13: return 0x28; // Enter
            case 16: return 0xE1; // Left shift
            case 17: return 0xE0; // Left Ctrl
            case 18: return 0xE6; // Left Alt
            case 19: return 0x48; // Pause
            case 20: return 0x39; // Caps Lock
            case 27: return 0x29; // Escape
            case 32: return 0x2C; // Spacebar
            case 33: return 0x4B; // Page Up
            case 34: return 0x4E; // Page Down
            case 35: return 0x4D; // End
            case 36: return 0x4A; // Home
            case 37: return 0x50; // Left Arrow
            case 38: return 0x52; // Up Arrow
            case 39: return 0x4F; // Right Arrow
            case 40: return 0x51; // Down Arrow
            case 44: return 0x46; // Print Screen or F13 (Firefox)
            case 45: return 0x49; // Insert
            case 46: return 0x4C; // Delete
            case 48: return 0x27; // 0 (not Numpads)
            case 59: return 0x33; // ';'
            case 61: return 0x2E; // '='
            case 91: return 0xE3; // Left GUI (Windows)
            case 92: return 0xE7; // Right GUI
            case 93: return 0x65; // Menu key
            case 96: return 0x62; // 0 (Numpads)
            case 97: return 0x59; // 1 (Numpads)
            case 98: return 0x5A; // 2 (Numpads)
            case 99: return 0x5B; // 3 (Numpads)
            case 100: return 0x5C; // 4 (Numpads)
            case 101: return 0x5D; // 5 (Numpads)
            case 102: return 0x5E; // 6 (Numpads)
            case 103: return 0x5F; // 7 (Numpads)
            case 104: return 0x60; // 8 (Numpads)
            case 105: return 0x61; // 9 (Numpads)
            case 106: return 0x55; // * (Numpads)
            case 107: return 0x57; // + (Numpads)
            case 109: return 0x56; // - (Numpads)
            case 110: return 0x63; // dot (Numpads)
            case 111: return 0x54; // divide (Numpads)
            case 144: return 0x53; // Num Lock
            case 145: return 0x47; // Scroll Lock
            case 146: return 0x58; // Numpad enter
            case 173: return 0x2D; // -
            case 186: return 0x33; // ';'
            case 187: return 0x2E; // '='
            case 188: return 0x36; // ','
            case 189: return 0x2D; // '-'
            case 190: return 0x37; // '.'
            case 191: return 0x38; // '/'
            case 192: return 0x35; // '`'
            case 219: return 0x2F; // '['
            case 220: return 0x31; // backslash
            case 221: return 0x30; // ']'
            case 222: return 0x34; // '\''
            default: return 0x00;
        }
    }
}

// Instantiate HID controller
const controller = new HIDController();
const videoOverlayElement = document.getElementById('touchscreen');

let isMouseDown = false;
let lastX = 0;
let lastY = 0;

// Mouse down
videoOverlayElement.addEventListener('mousedown', async (e) => {
    isMouseDown = true;
    lastX = e.clientX;
    lastY = e.clientY;
    if (e.button === 0) {
        await controller.MouseButtonPress(0x01); // Left
    } else if (e.button === 2) {
        await controller.MouseButtonPress(0x02); // Right
    } else if (e.button === 1) {
        await controller.MouseButtonPress(0x03); // Middle
    }
});

// Mouse up
videoOverlayElement.addEventListener('mouseup', async (e) => {
    isMouseDown = false;
    if (e.button === 0) {
        await controller.MouseButtonRelease(0x01); // Left
    } else if (e.button === 2) {
        await controller.MouseButtonRelease(0x02); // Right
    } else if (e.button === 1) {
        await controller.MouseButtonRelease(0x03); // Middle
    }
});

// Relative mouse mode flag (toggled from settings.html)
let relativeMouseEnabled = false;
let relativeMouseSensitivity = 1.0;

// CTRL ↔ CMD swap flag
let ctrlCmdSwapEnabled = false;

// Swap Ctrl (17) and Meta/CMD (91) keycodes when swap is enabled
function swapCtrlCmd(keyCode) {
    if (!ctrlCmdSwapEnabled) return keyCode;
    if (keyCode === 17) return 91;
    if (keyCode === 91) return 17;
    return keyCode;
}

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

// Re-request pointer lock on click when in relative mode
videoOverlayElement.addEventListener('click', function () {
    if (!controller.Config.AbsoluteMode && document.pointerLockElement !== videoOverlayElement) {
        videoOverlayElement.requestPointerLock();
    }
});

// Mouse move – supports both absolute and relative modes
videoOverlayElement.addEventListener('mousemove', async (e) => {
    if (controller.Config.AbsoluteMode) {
        // Absolute positioning
        const rect = videoOverlayElement.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;
        const width = rect.width;
        const height = rect.height;
        const offsetX = x / width;
        const offsetY = y / height;

        const absX = Math.round(offsetX * 4095);
        const absY = Math.round(offsetY * 4095);
        controller.hidState.MousePosition.x = absX;
        controller.hidState.MousePosition.y = absY;
        await controller.MouseMoveAbsolute(absX & 0xFF, (absX >> 8) & 0xFF, absY & 0xFF, (absY >> 8) & 0xFF);
    } else {
        // Relative positioning – use movementX/Y for pointer-locked delta
        let dx = Math.round(e.movementX * relativeMouseSensitivity);
        let dy = Math.round(e.movementY * relativeMouseSensitivity);

        // Clamp to signed-byte range (-127 to 127, skip 0x80)
        dx = Math.max(-127, Math.min(127, dx));
        dy = Math.max(-127, Math.min(127, dy));

        // Convert to unsigned byte for the HID packet
        if (dx < 0) dx = 256 + dx;
        if (dy < 0) dy = 256 + dy;

        await controller.MouseMoveRelative(dx, dy, 0);
    }
});

// Context menu disable (for right click)
videoOverlayElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});

// Mouse wheel (scroll)
let invertScrollEnabled = false; // toggled from settings.html
let scrollSensitivity = 2; // Default scroll sensitivity
videoOverlayElement.addEventListener('wheel', async (e) => {
    e.preventDefault();
    let tilt = e.deltaY > 0 ? scrollSensitivity : -scrollSensitivity;
    
    // Check if scroll inversion is enabled
    if (invertScrollEnabled) {
        tilt = -tilt;
    }
    
    await controller.MouseScroll(tilt);
});

// Check if the event target is a text input element
function isTypingInInput(e) {
    const tag = e.target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target.isContentEditable;
}

// Keyboard events for HID emulation
window.addEventListener('keydown', async (e) => {
    // Skip HID forwarding when typing in input fields
    if (isTypingInInput(e)) return;

    // Stacked Keys interception (must run before Ctrl+V passthrough so that
    // keys can be stacked even when a modifier is part of the combination)
    if (handleStackKeydown(e)) return;

    // Allow Ctrl+V to be handled by paste-box.js
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        return; // Don't prevent default, let paste event fire
    }
    
    // Ignore repeated events
    //if (e.repeat) return;
    try {
        e.preventDefault();
        // Modifier keys
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
            await controller.SetModifierKey(swapCtrlCmd(e.keyCode), e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        } else {
            await controller.SendKeyboardPress(e.keyCode);
        }
       
    } catch (err) {
        // Ignore unsupported keys
    }
});

window.addEventListener('keyup', async (e) => {
    // Skip HID forwarding when typing in input fields
    if (isTypingInInput(e)) return;

    // Stacked Keys interception
    if (handleStackKeyup(e)) return;

    // Allow Ctrl+V to be handled by paste-box.js
    if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
        return; // Don't prevent default
    }
    
    try {
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
            await controller.UnsetModifierKey(swapCtrlCmd(e.keyCode), e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        } else {
            await controller.SendKeyboardRelease(e.keyCode);
        }
        e.preventDefault();
    } catch (err) {
        // Ignore unsupported keys
    }
});

// Baudrate change handler - reconnect with new baudrate
function setupBaudrateChangeHandler() {
    const baudrateRadios = document.querySelectorAll('input[name="baudrate"]');
    baudrateRadios.forEach(radio => {
        radio.addEventListener('change', async () => {
            if (serialPort) {
                const newBaudrate = parseInt(radio.value);
                try {
                    $('body').toast({
                        message: `<i class="blue sync icon"></i> Reconnecting with baudrate ${newBaudrate}...`,
                    });
                    
                    // Disconnect and reconnect with new baudrate
                    await disconnectSerialPort();
                    
                    // Small delay to ensure clean disconnect
                    await new Promise(resolve => setTimeout(resolve, 100));
                    
                    // Reconnect with new baudrate
                    await requestSerialPort();
                    
                    $('body').toast({
                        message: `<i class="green check circle icon"></i> Reconnected with baudrate ${newBaudrate}`,
                    });
                } catch (e) {
                    console.error('Failed to reconnect with new baudrate:', e);
                    $('body').toast({
                        message: '<i class="exclamation icon"></i> Failed to reconnect. Please try refreshing the page.',
                        class: 'error'
                    });
                }
            }
        });
    });
}

// Initialize baudrate change handler when page loads
setTimeout(() => {
    setupBaudrateChangeHandler();
}, 500);

// Reset HID - called from settings.html
async function resetRemoteHID() {
    try {
        await controller.softReset();
        $('body').toast({
            message: '<i class="green check circle icon"></i> HID soft reset sent.'
        });
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        await delay(50);
        await controller.SetModifierKey(16, false);
        await delay(50);
        await controller.UnsetModifierKey(16, false);
        await delay(100);
        await controller.SetModifierKey(17, false);
        await delay(50);
        await controller.UnsetModifierKey(17, false);
        await delay(100);
        await controller.SetModifierKey(18, false);
        await delay(50);
        await controller.UnsetModifierKey(18, false);
    } catch (e) {
        $('body').toast({
            message: '<i class="red exclamation icon"></i> Failed to reset HID: ' + e.message,
            class: 'error'
        });
    }
}

function sendKeyPress(keycode, needsShift = false) {
    if (!controller) return;
    
    if (needsShift) {
        controller.KeyboardButtonPress(16);
    }
    
    controller.KeyboardButtonPress(keycode);
    controller.KeyboardButtonRelease(keycode);
    
    if (needsShift) {
        controller.KeyboardButtonRelease(16);
    }
}

function cancelPasteText() {
    pasteCancelled = true;
    $('body').toast({
        message: '<i class="orange exclamation icon"></i> Paste operation cancelled'
    });
}

/*
    Mouse Jiggler
    When enabled, after 30 seconds of no user activity the mouse will
    jiggle left/right every 5 seconds to prevent the remote machine from
    going to sleep.  Any user interaction stops the jiggle immediately
    and restarts the inactivity timer.
*/
(function () {
    const IDLE_TIMEOUT_MS = 30000;   // 30 seconds of inactivity before jiggling
    const JIGGLE_INTERVAL_MS = 5000; // jiggle every 5 seconds
    const JIGGLE_AMOUNT = 10;         // pixels to move left / right

    let jiggleEnabled = false;
    let idleTimer = null;
    let jiggleTimer = null;
    let jiggleDirection = 1;          // 1 = right, -1 = left

    // ---- helpers ----

    function stopJiggle() {
        if (jiggleTimer) {
            clearInterval(jiggleTimer);
            jiggleTimer = null;
        }
    }

    function resetIdleTimer() {
        // Stop any ongoing jiggle
        stopJiggle();

        // Clear previous idle timer
        if (idleTimer) {
            clearTimeout(idleTimer);
            idleTimer = null;
        }

        // Only start the idle countdown when the feature is enabled
        if (!jiggleEnabled) return;

        idleTimer = setTimeout(() => {
            // Start jiggling
            jiggleDirection = 1;
            doJiggle(); // immediate first jiggle
            jiggleTimer = setInterval(doJiggle, JIGGLE_INTERVAL_MS);
        }, IDLE_TIMEOUT_MS);
    }

    async function doJiggle() {
        if (!serialPort || !serialPort.readable || !serialPort.writable) return;
        try {
            // Move in the current direction
            let dx = JIGGLE_AMOUNT * jiggleDirection;
            if (dx < 0) dx = 256 + dx; // convert to unsigned byte
            await controller.MouseMoveRelative(dx, 0, 0);

            // Flip direction for next time so the cursor returns
            jiggleDirection *= -1;
        } catch (e) {
            // Ignore – serial port may have been closed
        }
    }

    // ---- toggle (called from settings.html) ----
    window.setMouseJigglerEnabled = function(enabled) {
        jiggleEnabled = enabled;
        if (jiggleEnabled) {
            resetIdleTimer();
        } else {
            stopJiggle();
            if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
        }
    };

    // ---- user-activity listeners (reset idle timer) ----

    const activityEvents = ['mousemove', 'mousedown', 'mouseup', 'wheel', 'touchstart', 'touchmove'];
    activityEvents.forEach(evt => {
        videoOverlayElement.addEventListener(evt, () => {
            if (jiggleEnabled) resetIdleTimer();
        });
    });

    // Keyboard activity
    window.addEventListener('keydown', () => {
        if (jiggleEnabled) resetIdleTimer();
    });
    window.addEventListener('keyup', () => {
        if (jiggleEnabled) resetIdleTimer();
    });
})();


/* 
    Video and Audio Capture with Single Permission Request
*/

const MODE_LIST = [
    { width: 1920, height: 1080, frameRate: 30 },
    // MS2109 may output 25FPS when connected to a USB hub
    { width: 1920, height: 1080, frameRate: 25 },
];

async function requestMediaDevicePermission() {
    // Request any media device to trigger the permission popup
    const stream = await window.navigator.mediaDevices.getUserMedia({
        video: true,
        audio: true,
    });

    // Stop all tracks so they can be requested again
    for (const track of stream.getTracks()) {
        track.stop();
    }
}

function isLinuxChromium() {
    const ua = navigator.userAgent;
    return /Linux/.test(ua) && /Chrome\//.test(ua) && !/Android/.test(ua);
}

/*
    Device matching tiers, ordered from most to least confident.

    Each tier is tried against *every* supported VID:PID pair before moving on to
    the next one. Matching pair-by-pair instead would let the first pair grab a
    device via a low confidence fallback (e.g. PID only, which is shared between
    the Original and the Gen2) and hide the exact match available on a later pair.
*/
const MATCH_TIERS = ['exact', 'pid', 'any'];

function findDevice(devices, type, vid, pid, tier) {
    // Temporary workaround for #1 - not sure why this check can't pass Ubuntu 26.04 Chrome
    // The "any" tier hands over the first device of the requested kind, so only allow
    // it on the hosts that actually need it.
    if (tier === 'any' && !isLinuxChromium()) {
        return null;
    }

    // Chrome appends (vid:pid) to the device label, the spec doesn't define
    // how to find a device with a specified VID/PID so this is all we have
    const labelSuffix = ('(' + vid + ':' + pid + ')').toLowerCase();
    const pidOnly = pid.toLowerCase();

    for (const device of devices) {
        if (device.kind !== type) {
            continue;
        }

        // Labels are compared in lower case, and trailing spaces are dropped so a
        // label like "USB Video (534d:2109) " still matches the suffix
        const label = (device.label || '').toLowerCase().trimEnd();
        if (tier === 'exact') {
            if (label.endsWith(labelSuffix)) {
                return device;
            }
        } else if (tier === 'pid') {
            // Some host drivers (e.g. RaspiOS/V4L2 on Argon ONE UP CM5, see #8) don't pass the
            // USB vid:pid through to the browser at all, labeling the device as just "2109 (V4L2)"
            // or "2109 Analog Stereo". Fall back to matching the PID alone in the label.
            if (label.includes(pidOnly)) {
                return device;
            }
        } else if (tier === 'any') {
            return device;
        }
    }
    return null;
}

async function startStream() {
    try {
        // Only getUserMedia triggers the permission popup, enumerateDevices won't
        await requestMediaDevicePermission();

        const devices = await window.navigator.mediaDevices.enumerateDevices();
        const supportedVidPidPairs = [
            { vid: '534d', pid: '2109' , product: "DezKVM-Go Original"}, // MS2109, original DezKVM-Go
            { vid: '345f', pid: '2109' , product: "DezKVM-Go Gen2"}, // DezKVM-Go gen2
        ]
        let videoDevice = null;
        let audioDevice = null;
        let fuzzyMatch = false;
        // Give every supported VID:PID pair a chance at the current tier before
        // degrading to a less confident match, see MATCH_TIERS above.
        matching:
        for (const tier of MATCH_TIERS) {
            for (const { vid, pid, product } of supportedVidPidPairs) {
                const videoMatch = findDevice(devices, 'videoinput', vid, pid, tier);
                const audioMatch = findDevice(devices, 'audioinput', vid, pid, tier);
                if (videoMatch && audioMatch) {
                    videoDevice = videoMatch;
                    audioDevice = audioMatch;
                    fuzzyMatch = tier !== 'exact';
                    console.log(`Found video device with VID:PID ${vid}:${pid} (matched by ${tier})`);
                    productId = product;
                    break matching;
                }
            }
        }

        if (!videoDevice) {
            console.error('MS2109 video device not found');
            $('body').toast({
                message: '<i class="red exclamation triangle icon"></i> MS2109 video capture device not found. Please connect the device and try again.'
            });

            // Print all connected video devices for debugging
            console.log('Connected video devices:');
            devices.filter(d => d.kind === 'videoinput').forEach(d => console.log(`- ${d.label} (id: ${d.deviceId})`));
            return;
        }

        if (!audioDevice) {
            console.warn('MS2109 audio device not found');
        }

        if (fuzzyMatch) {
            // See #1: some host drivers (RaspiOS/V4L2) don't expose the vid:pid in the
            // device label, so the device was matched by PID substring / heuristic only.
            console.warn(`Video/audio device VID:PID could not be confirmed from the device label (label was "${videoDevice.label}"). Matched by fallback heuristic - this may not be the correct capture device.`);
            $('body').toast({
                message: '<i class="yellow warning sign icon"></i> Capture device VID:PID could not be confirmed. If this is the wrong device, please disconnect other v4l2 devices and reload the page.'
            });
        }

        // Try different video modes
        let videoStream = null;
        for (const mode of MODE_LIST) {
            try {
                videoStream = await window.navigator.mediaDevices.getUserMedia({
                    video: {
                        deviceId: { exact: videoDevice.deviceId },
                        width: { exact: mode.width },
                        height: { exact: mode.height },
                        frameRate: { exact: mode.frameRate },
                    },
                });
                console.log(`Video stream started: ${mode.width}x${mode.height} @ ${mode.frameRate}fps`);
                break;
            } catch (e) {
                console.log(`Failed to start video stream with mode ${mode.width}x${mode.height}@${mode.frameRate}fps:`, e);
                // Continue to next mode
            }
        }

        if (!videoStream) {
            console.error('Failed to start video stream with all modes');
            alert('Failed to start video stream. Please check the device connection.');
            return;
        }

        document.getElementById('video').srcObject = videoStream;
        window.currentStream = videoStream;

        // Log actual video settings
        const videoTrack = videoStream.getVideoTracks()[0];
        const videoSettings = videoTrack.getSettings();
        console.log(`Video stream settings: ${videoSettings.width}x${videoSettings.height} @ ${videoSettings.frameRate}fps`);

        // Start audio stream if audio device is found
        if (audioDevice) {
            try {
                const audioStream = await window.navigator.mediaDevices.getUserMedia({
                    audio: {
                        groupId: { exact: audioDevice.groupId },
                        sampleRate: 96000,
                        sampleSize: 16,
                        echoCancellation: false,
                        noiseSuppression: false,
                        autoGainControl: false,
                    },
                });

                // Create audio context for processing
                window.kvmAudioContext = new AudioContext({ sampleRate: 96000 });
                const source = window.kvmAudioContext.createMediaStreamSource(audioStream);

                // Extra Gain: boost quiet capture card audio sources
                window.kvmGainNode = window.kvmAudioContext.createGain();
                const initialGain = (typeof extraGain === 'number' && !isNaN(extraGain)) ? extraGain : 1.0;
                window.kvmGainNode.gain.value = initialGain;

                // Add audio worklet processor for channel splitting
                await window.kvmAudioContext.audioWorklet.addModule('data:application/javascript;charset=utf8,' + encodeURIComponent(`
                    class SplitProcessor extends AudioWorkletProcessor {
                        process (inputs, outputs, parameters) {
                            const input = inputs[0][0];
                            const leftOutput = outputs[0][0];
                            const rightOutput = outputs[0][1];

                            // Separate interleaved stereo audio into left and right channels
                            let i = 0;
                            while (i < input.length) {
                                // Web Audio API doesn't support sample rate conversion
                                // So we have to duplicate the samples
                                leftOutput[i] = input[i + 1];
                                leftOutput[i + 1] = input[i + 1];

                                rightOutput[i] = input[i];
                                rightOutput[i + 1] = input[i];

                                i += 2;
                            }

                            return true;
                        }
                    }

                    registerProcessor('split-processor', SplitProcessor)
                `));
                
                const processor = new AudioWorkletNode(window.kvmAudioContext, 'split-processor', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                });
                source.connect(window.kvmGainNode);
                window.kvmGainNode.connect(processor);
                processor.connect(window.kvmAudioContext.destination);

                console.log('Audio stream started successfully');
            } catch (e) {
                console.error('Failed to start audio stream:', e);
                // Continue without audio
            }
        }

        // Resize touchscreen overlay after a short delay to ensure video is loaded
        setTimeout(resizeTouchscreenToVideo, 500);
    } catch (e) {
        console.error('Unable to access media devices:', e);
        alert('Unable to access media devices: ' + e.message);
    }
}

function getResolutionFromCurrentStream() {
    if (window.currentStream) {
        const track = window.currentStream.getVideoTracks()[0];
        const settings = track.getSettings();
        return { width: settings.width, height: settings.height };
    }
    return null;
}

document.getElementById('fullscreenBtn').addEventListener('click', () => {
    if (
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
    ) {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        } else if (document.mozCancelFullScreen) {
            document.mozCancelFullScreen();
        } else if (document.msExitFullscreen) {
            document.msExitFullscreen();
        }
        document.querySelector('#fullscreenBtn i').className = 'expand icon';
        
    } else {
        if (document.body.requestFullscreen) {
            document.body.requestFullscreen();
        } else if (document.body.webkitRequestFullscreen) {
            document.body.webkitRequestFullscreen();
        } else if (document.body.mozRequestFullScreen) {
            document.body.mozRequestFullScreen();
        } else if (document.body.msRequestFullscreen) {
            document.body.msRequestFullscreen();
        }
        document.querySelector('#fullscreenBtn i').className = 'compress icon';
        
    }
});

// KVM Connect Prompt logic
const SKIP_CONNECT_PROMPT_KEY = 'dezkvm_skip_connect_prompt';

function showKvmConnectPrompt() {
    const prompt = document.getElementById('kvmConnectPrompt');
    if (!prompt) {
        // Fallback if element doesn't exist
        startStream();
        return;
    }
    prompt.style.display = 'flex';
    requestAnimationFrame(() => prompt.classList.add('visible'));
}

function hideKvmConnectPrompt() {
    const prompt = document.getElementById('kvmConnectPrompt');
    if (!prompt) return;
    prompt.classList.remove('visible');
    setTimeout(() => { prompt.style.display = 'none'; }, 260);
}

// Handle "Start Capture" button click
document.getElementById('kvmConnectBtn').addEventListener('click', () => {
    // Save "do not show" preference
    const skipChk = document.getElementById('chkSkipConnectPrompt');
    if (skipChk && skipChk.checked) {
        try { localStorage.setItem(SKIP_CONNECT_PROMPT_KEY, 'true'); } catch (e) {}
    }
    hideKvmConnectPrompt();
    startStream();
});

// Start stream: either show prompt or auto-start
(function initCapture() {
    let skipPrompt = false;
    try { skipPrompt = localStorage.getItem(SKIP_CONNECT_PROMPT_KEY) === 'true'; } catch (e) {}
    if (skipPrompt) {
        startStream();
    } else {
        showKvmConnectPrompt();
    }
})();

navigator.mediaDevices.addEventListener('devicechange', () => {
   startStream();
});

/*
    Test-Pattern (Color-Bar) Detection
    The MS2109 capture card generates a 7-stripe colour-bar test signal when
    no HDMI source is connected.  We sample the centre of each stripe and
    compare against the known colours.  When the pattern is detected the
    global flag `videoCaptureOngoing` is set to false and a black overlay
    with an informational message is shown.
*/
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
    const COLOR_TOLERANCE = 45;      // per-channel tolerance
    const CHECK_INTERVAL_MS = 1000;  // check every 1 second

    const video = document.getElementById('video');
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
        const BLACK_THRESHOLD = 30; // pixels darker than this are "black"
        let left = 0;
        let right = width - 1;

        // Scan from the left
        for (let x = 0; x < width; x++) {
            const idx = x * 4;
            if (rowData[idx] > BLACK_THRESHOLD ||
                rowData[idx + 1] > BLACK_THRESHOLD ||
                rowData[idx + 2] > BLACK_THRESHOLD) {
                left = x;
                break;
            }
        }

        // Scan from the right
        for (let x = width - 1; x >= left; x--) {
            const idx = x * 4;
            if (rowData[idx] > BLACK_THRESHOLD ||
                rowData[idx + 1] > BLACK_THRESHOLD ||
                rowData[idx + 2] > BLACK_THRESHOLD) {
                right = x;
                break;
            }
        }

        return { left, right };
    }

    function isTestPattern() {
        if (!video.srcObject || video.videoWidth === 0 || video.videoHeight === 0) {
            return false; // no stream at all – don't treat as test pattern
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const stripeCount = EXPECTED_COLORS.length;

        // Sample multiple rows to be more robust
        const sampleRows = [
            Math.floor(canvas.height * 0.25),
            Math.floor(canvas.height * 0.5),
            Math.floor(canvas.height * 0.75),
        ];

        for (const row of sampleRows) {
            // Get the full row of pixels so we can find the actual content area
            const rowData = ctx.getImageData(0, row, canvas.width, 1).data;
            const bounds = findContentBounds(rowData, canvas.width);
            const contentWidth = bounds.right - bounds.left + 1;

            // Content must be at least 25% of frame width to be meaningful
            if (contentWidth < canvas.width * 0.25) return false;

            const stripeWidth = contentWidth / stripeCount;
            let allMatch = true;
            for (let i = 0; i < stripeCount; i++) {
                const sampleX = Math.floor(bounds.left + stripeWidth * i + stripeWidth / 2);
                const idx = sampleX * 4;
                const actual = { r: rowData[idx], g: rowData[idx + 1], b: rowData[idx + 2] };

                if (!colorMatch(actual, EXPECTED_COLORS[i])) {
                    allMatch = false;
                    break;
                }
            }
            if (!allMatch) return false; // one row failed – not the test pattern
        }

        return true; // all sampled rows matched
    }

    function updateOverlay(showOverlay) {
        if (showOverlay) {
            overlay.style.display = 'flex';
        } else {
            overlay.style.display = 'none';
        }
    }

    setInterval(() => {
        const testPatternDetected = isTestPattern();
        videoCaptureOngoing = !testPatternDetected;
        updateOverlay(testPatternDetected);
    }, CHECK_INTERVAL_MS);
})();


/*
    Settings Overlay
*/

// Show / hide the settings overlay
function toggleSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) {
        overlay.classList.toggle('visible');
        // Update capture properties when opening
        if (overlay.classList.contains('visible')) {
            updateCapturePropertiesTable();
        }
    }
}

function closeSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    if (overlay) {
        overlay.classList.remove('visible');
    }
}

// Close overlay when clicking outside the panel
document.addEventListener('click', function(e) {
    const overlay = document.getElementById('settings-overlay');
    if (overlay && overlay.classList.contains('visible')) {
        // Only close if the click is directly on the overlay background (not the panel)
        if (e.target === overlay) {
            closeSettingsOverlay();
        }
    }
});

// Toggle fullscreen (used by settings.html)
function toggleFullScreen() {
    if (
        document.fullscreenElement ||
        document.webkitFullscreenElement ||
        document.mozFullScreenElement ||
        document.msFullscreenElement
    ) {
        if (document.exitFullscreen) document.exitFullscreen();
        else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
        else if (document.mozCancelFullScreen) document.mozCancelFullScreen();
        else if (document.msExitFullscreen) document.msExitFullscreen();
        document.querySelector('#fullscreenBtn i').className = 'expand icon';
    } else {
        if (document.body.requestFullscreen) document.body.requestFullscreen();
        else if (document.body.webkitRequestFullscreen) document.body.webkitRequestFullscreen();
        else if (document.body.mozRequestFullScreen) document.body.mozRequestFullScreen();
        else if (document.body.msRequestFullscreen) document.body.msRequestFullscreen();
        document.querySelector('#fullscreenBtn i').className = 'compress icon';
    }
}

// Update capture properties table in settings
function updateCapturePropertiesTable() {
    const tbody = document.getElementById('capturePropsBody');
    if (!tbody) return;
    tbody.innerHTML = '';

    const video = document.getElementById('video');
    const stream = window.currentStream;

    const addRow = (label, value) => {
        const tr = document.createElement('tr');
        const td1 = document.createElement('td');
        td1.textContent = label;
        td1.style.fontWeight = '600';
        const td2 = document.createElement('td');
        td2.textContent = value;
        tr.appendChild(td1);
        tr.appendChild(td2);
        tbody.appendChild(tr);
    };

    if (!stream || stream.getVideoTracks().length === 0) {
        addRow('Status', 'No video stream');
        return;
    }

    const track = stream.getVideoTracks()[0];
    const settings = track.getSettings();
    const capabilities = typeof track.getCapabilities === 'function' ? track.getCapabilities() : {};

    addRow('Status', track.readyState === 'live' ? 'Active' : track.readyState);
    addRow('Resolution', (settings.width || '-') + ' × ' + (settings.height || '-'));
    addRow('Frame Rate', (settings.frameRate ? settings.frameRate + ' fps' : '-'));
    addRow('Device', track.label || '-');
    if (settings.deviceId) addRow('Device ID', settings.deviceId.substring(0, 16) + '…');
    if (settings.groupId) addRow('Group ID', settings.groupId.substring(0, 16) + '…');
    if (settings.aspectRatio) addRow('Aspect Ratio', settings.aspectRatio.toFixed(4));
    if (capabilities.width) addRow('Max Resolution', capabilities.width.max + ' × ' + capabilities.height.max);
    if (capabilities.frameRate) addRow('Max Frame Rate', capabilities.frameRate.max + ' fps');
}

// Extra audio gain (multiplier) applied to the capture card audio feed.
// Useful for devices whose source audio output is quiet.
var extraGain = 1.0;
function setExtraGain(value) {
    let gain = parseFloat(value);
    if (isNaN(gain)) gain = 1.0;
    gain = Math.max(0, Math.min(3, gain));
    extraGain = gain;
    if (window.kvmGainNode && window.kvmAudioContext) {
        // Ramp smoothly to avoid audible clicks/pops on change
        const now = window.kvmAudioContext.currentTime;
        window.kvmGainNode.gain.setTargetAtTime(extraGain, now, 0.02);
    }
}

// Toggle audio enable/disable
let audioEnabled = true;
function toggleEnableAudio() {
    const chk = document.getElementById('chkSettingsEnableAudio');
    audioEnabled = chk ? chk.checked : true;
    if (window.kvmAudioContext) {
        if (audioEnabled) {
            window.kvmAudioContext.resume();
            $('body').toast({ message: '<i class="volume up icon"></i> Audio enabled' });
        } else {
            window.kvmAudioContext.suspend();
            $('body').toast({ message: '<i class="volume off icon"></i> Audio disabled' });
        }
    }
}

// Toggle local cursor visibility
let showLocalCursor = true;
function toggleShowLocalCursor() {
    const chk = document.getElementById('chkSettingsShowLocalCursor');
    showLocalCursor = chk ? chk.checked : true;
    const ts = document.getElementById('touchscreen');
    if (ts) {
        ts.style.cursor = showLocalCursor ? '' : 'none';
    }
    $('body').toast({
        message: showLocalCursor
            ? '<i class="mouse pointer icon"></i> Local cursor visible'
            : '<i class="mouse pointer icon"></i> Local cursor hidden'
    });
}

// Toggle invert scrollwheel
function toggleInvertScrollwheel() {
    const chk = document.getElementById('chkSettingsInvertScrollwheel');
    invertScrollEnabled = chk ? chk.checked : false;
    $('body').toast({
        message: invertScrollEnabled
            ? '<i class="exchange icon"></i> Scroll direction inverted'
            : '<i class="exchange icon"></i> Scroll direction normal'
    });
}

// Toggle relative mouse mode
function toggleRelativeMouseMode() {
    const chk = document.getElementById('chkSettingsRelativeMouseMode');
    relativeMouseEnabled = chk ? chk.checked : false;
    controller.Config.AbsoluteMode = !relativeMouseEnabled;
    if (relativeMouseEnabled) {
        videoOverlayElement.requestPointerLock();
        $('body').toast({ message: '<i class="arrows alternate icon"></i> Relative mouse mode enabled' });

        //Also hide the settings overlay to prevent confusion about mouse position when pointer is locked
        closeSettingsOverlay();
    } else {
        if (document.pointerLockElement === videoOverlayElement) {
            document.exitPointerLock();
        }
        $('body').toast({ message: '<i class="mouse pointer icon"></i> Absolute mouse mode enabled' });
    }
}

// Toggle CTRL ↔ CMD swap
function toggleCtrlCmdSwap() {
    ctrlCmdSwapEnabled = !ctrlCmdSwapEnabled;
    const btn = document.getElementById('btnCtrlCmdSwap');
    if (btn) {
        if (ctrlCmdSwapEnabled) {
            btn.classList.remove('grey');
            btn.classList.add('green');
        } else {
            btn.classList.remove('green');
            btn.classList.add('grey');
        }
    }
    $('body').toast({
        message: ctrlCmdSwapEnabled
            ? '<i class="exchange icon"></i> CTRL ↔ CMD swap enabled'
            : '<i class="exchange icon"></i> CTRL ↔ CMD swap disabled'
    });
    if (typeof saveSettingsToLocalStorage === 'function') {
        saveSettingsToLocalStorage();
    }
}

// Ask on Paste flag (toggled from settings.html)
let askOnPasteEnabled = false;

// Toggle ask on paste
function toggleAskOnPaste() {
    const chk = document.getElementById('chkSettingsAskOnPaste');
    askOnPasteEnabled = chk ? chk.checked : false;
    $('body').toast({
        message: askOnPasteEnabled
            ? '<i class="clipboard icon"></i> Ask on paste enabled'
            : '<i class="clipboard icon"></i> Ask on paste disabled'
    });
}

// Toggle mouse jiggler
function toggleMouseJiggler() {
    const chk = document.getElementById('chkSettingsMouseJiggler');
    const enabled = chk ? chk.checked : false;
    if (typeof window.setMouseJigglerEnabled === 'function') {
        window.setMouseJigglerEnabled(enabled);
    }
    $('body').toast({
        message: enabled
            ? '<i class="mouse pointer icon"></i> Mouse jiggler enabled (activates after 30 s idle)'
            : '<i class="mouse pointer icon"></i> Mouse jiggler disabled'
    });
}

//  Image Sharpening Pipeline 
/*
 * GPU-accelerated Gaussian unsharp-mask sharpening.
 *
 * Algorithm:
 *   1. Each video frame is uploaded to a WebGL texture.
 *   2. A GLSL fragment shader approximates a Gaussian blur with the 3×3
 *      kernel  G = [1 2 1 / 2 4 2 / 1 2 1] / 16  (σ ≈ 0.85 px, separable).
 *   3. The unsharp mask is computed per-pixel entirely on the GPU:
 *        sharpened = clamp( original + strength × (original − G*original), 0, 1 )
 *   4. The result is rendered onto a canvas that overlays the <video> element.
 *      The canvas has pointer-events:none so all mouse/keyboard events pass
 *      through to the touchscreen overlay underneath.
 *
 * When WebGL is unavailable the pipeline falls back to a Canvas-2D separable
 * Gaussian implementation (slower, but functionally identical).
 */
let imageSharpeningEnabled = false;
let _sharpenRafId = null;

/* Helper: compute canvas position matching the actual video content area */
function _getSharpenCanvasRect(video) {
    const rect = video.getBoundingClientRect();
    const resolution = getResolutionFromCurrentStream();
    let aspectRatio = 16 / 9;
    if (resolution && resolution.width && resolution.height) {
        aspectRatio = resolution.width / resolution.height;
    }
    let displayWidth, displayHeight, offsetX, offsetY;
    if (rect.width / rect.height > aspectRatio) {
        displayHeight = rect.height;
        displayWidth  = rect.height * aspectRatio;
        offsetX = rect.left + (rect.width - displayWidth) / 2;
        offsetY = rect.top;
    } else {
        displayWidth  = rect.width;
        displayHeight = rect.width / aspectRatio;
        offsetX = rect.left;
        offsetY = rect.top + (rect.height - displayHeight) / 2;
    }
    return { left: offsetX, top: offsetY, width: displayWidth, height: displayHeight };
}

(function initSharpeningPipeline() {
    const video = document.getElementById('video');
    if (!video) return;

    /* Overlay canvas – sits between <video> and the touchscreen div */
    const canvas = document.createElement('canvas');
    canvas.id = 'sharpenCanvas';
    canvas.style.cssText = 'display:none;position:absolute;pointer-events:none;z-index:1;';
    video.insertAdjacentElement('afterend', canvas);

    /* Try WebGL first (GPU path), fall back to Canvas 2D (CPU path) */
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (gl) {
        _initWebGLSharpener(video, canvas, gl);
    } else {
        _init2DSharpener(video, canvas);
    }
})();

/*  WebGL implementation  */
function _initWebGLSharpener(video, canvas, gl) {
    /* Vertex shader – full-screen clip-space quad */
    const VS = `
        attribute vec2 a_pos;
        varying   vec2 v_uv;
        void main() {
            /* video textures are flipped in WebGL; un-flip Y */
            v_uv        = vec2(a_pos.x * 0.5 + 0.5, 0.5 - a_pos.y * 0.5);
            gl_Position = vec4(a_pos, 0.0, 1.0);
        }`;

    /* Fragment shader – 3×3 Gaussian unsharp mask */
    const FS = `
        precision mediump float;
        uniform sampler2D u_tex;
        uniform vec2      u_px;   /* (1/width, 1/height) */
        uniform float     u_str;  /* sharpening strength  */
        varying vec2 v_uv;
        void main() {
            vec3 c  = texture2D(u_tex, v_uv).rgb;
            vec3 tl = texture2D(u_tex, v_uv + vec2(-u_px.x, -u_px.y)).rgb;
            vec3 t  = texture2D(u_tex, v_uv + vec2( 0.0,    -u_px.y)).rgb;
            vec3 tr = texture2D(u_tex, v_uv + vec2( u_px.x, -u_px.y)).rgb;
            vec3 l  = texture2D(u_tex, v_uv + vec2(-u_px.x,  0.0   )).rgb;
            vec3 r  = texture2D(u_tex, v_uv + vec2( u_px.x,  0.0   )).rgb;
            vec3 bl = texture2D(u_tex, v_uv + vec2(-u_px.x,  u_px.y)).rgb;
            vec3 b  = texture2D(u_tex, v_uv + vec2( 0.0,     u_px.y)).rgb;
            vec3 br = texture2D(u_tex, v_uv + vec2( u_px.x,  u_px.y)).rgb;
            /* Gaussian weights: corner=1, edge=2, centre=4  (sum=16) */
            vec3 blur = (tl + 2.0*t + tr + 2.0*l + 4.0*c + 2.0*r + bl + 2.0*b + br) / 16.0;
            gl_FragColor = vec4(clamp(c + u_str * (c - blur), 0.0, 1.0), 1.0);
        }`;

    function makeShader(type, src) {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
            console.error('[Sharpen] shader compile:', gl.getShaderInfoLog(s));
            return null;
        }
        return s;
    }

    const prog = gl.createProgram();
    gl.attachShader(prog, makeShader(gl.VERTEX_SHADER,   VS));
    gl.attachShader(prog, makeShader(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
        console.error('[Sharpen] shader link:', gl.getProgramInfoLog(prog));
        return;
    }

    /* Full-screen triangle strip */
    const quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);

    /* Video texture */
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

    const aPos = gl.getAttribLocation(prog,  'a_pos');
    const uTex = gl.getUniformLocation(prog, 'u_tex');
    const uPx  = gl.getUniformLocation(prog, 'u_px');
    const uStr = gl.getUniformLocation(prog, 'u_str');

    function positionCanvas() {
        const cr = _getSharpenCanvasRect(video);
        canvas.style.left   = cr.left   + 'px';
        canvas.style.top    = cr.top    + 'px';
        canvas.style.width  = cr.width  + 'px';
        canvas.style.height = cr.height + 'px';
    }

    function renderFrame() {
        if (!imageSharpeningEnabled) return;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) { _sharpenRafId = requestAnimationFrame(renderFrame); return; }

        if (canvas.width !== vw || canvas.height !== vh) {
            canvas.width  = vw;
            canvas.height = vh;
            gl.viewport(0, 0, vw, vh);
        }

        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);

        gl.useProgram(prog);
        gl.uniform1i(uTex, 0);
        gl.uniform2f(uPx, 1.0 / vw, 1.0 / vh);
        gl.uniform1f(uStr, 1.0);

        gl.bindBuffer(gl.ARRAY_BUFFER, quad);
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        positionCanvas();
        _sharpenRafId = requestAnimationFrame(renderFrame);
    }

    window.startSharpeningPipeline = function () {
        positionCanvas();
        canvas.style.display = 'block';
        if (_sharpenRafId) cancelAnimationFrame(_sharpenRafId);
        _sharpenRafId = requestAnimationFrame(renderFrame);
    };

    window.stopSharpeningPipeline = function () {
        if (_sharpenRafId) { cancelAnimationFrame(_sharpenRafId); _sharpenRafId = null; }
        canvas.style.display = 'none';
    };

    window.addEventListener('resize', () => { if (imageSharpeningEnabled) positionCanvas(); });
}

/*  Canvas-2D fallback (CPU)  */
function _init2DSharpener(video, canvas) {
    const srcCanvas = document.createElement('canvas');
    const srcCtx    = srcCanvas.getContext('2d', { willReadFrequently: true });
    const outCtx    = canvas.getContext('2d');

    let _tmpBuf  = null;   /* horizontal-pass buffer  */
    let _blurBuf = null;   /* vertical-pass output    */

    function ensureBuffers(len) {
        if (!_tmpBuf || _tmpBuf.length !== len) {
            _tmpBuf  = new Uint8ClampedArray(len);
            _blurBuf = new Uint8ClampedArray(len);
        }
    }

    /*
     * In-place Gaussian unsharp mask.
     * Blur kernel (separable): horizontal [1 2 1]/4 then vertical [1 2 1]/4
     * Combined 2D kernel:  [1 2 1 / 2 4 2 / 1 2 1] / 16  (σ ≈ 0.85 px)
     * Unsharp mask:  sharpened[i] = clamp(orig[i] + strength*(orig[i] − blur[i]))
     */
    function applyUnsharpMask(data, w, h, strength) {
        const len = w * h * 4;
        ensureBuffers(len);
        const tmp  = _tmpBuf;
        const blur = _blurBuf;

        /* Horizontal pass */
        for (let y = 0; y < h; y++) {
            const rowBase = y * w;
            for (let x = 0; x < w; x++) {
                const i  = (rowBase + x) * 4;
                const il = x > 0     ? i - 4 : i;
                const ir = x < w - 1 ? i + 4 : i;
                tmp[i    ] = (data[il    ] + (data[i    ] << 1) + data[ir    ]) >> 2;
                tmp[i + 1] = (data[il + 1] + (data[i + 1] << 1) + data[ir + 1]) >> 2;
                tmp[i + 2] = (data[il + 2] + (data[i + 2] << 1) + data[ir + 2]) >> 2;
                tmp[i + 3] = 255;
            }
        }

        /* Vertical pass */
        for (let y = 0; y < h; y++) {
            const row  =  y          * w;
            const rowT = (y > 0     ? y - 1 : 0    ) * w;
            const rowB = (y < h - 1 ? y + 1 : h - 1) * w;
            for (let x = 0; x < w; x++) {
                const i  = (row  + x) * 4;
                const it = (rowT + x) * 4;
                const ib = (rowB + x) * 4;
                blur[i    ] = (tmp[it    ] + (tmp[i    ] << 1) + tmp[ib    ]) >> 2;
                blur[i + 1] = (tmp[it + 1] + (tmp[i + 1] << 1) + tmp[ib + 1]) >> 2;
                blur[i + 2] = (tmp[it + 2] + (tmp[i + 2] << 1) + tmp[ib + 2]) >> 2;
                blur[i + 3] = 255;
            }
        }

        /* Unsharp mask */
        for (let i = 0; i < len; i += 4) {
            data[i    ] = Math.max(0, Math.min(255, data[i    ] + strength * (data[i    ] - blur[i    ])));
            data[i + 1] = Math.max(0, Math.min(255, data[i + 1] + strength * (data[i + 1] - blur[i + 1])));
            data[i + 2] = Math.max(0, Math.min(255, data[i + 2] + strength * (data[i + 2] - blur[i + 2])));
        }
    }

    function positionCanvas() {
        const cr = _getSharpenCanvasRect(video);
        canvas.style.left   = cr.left   + 'px';
        canvas.style.top    = cr.top    + 'px';
        canvas.style.width  = cr.width  + 'px';
        canvas.style.height = cr.height + 'px';
    }

    function renderFrame() {
        if (!imageSharpeningEnabled) return;
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) { _sharpenRafId = requestAnimationFrame(renderFrame); return; }

        if (srcCanvas.width !== vw || srcCanvas.height !== vh) {
            srcCanvas.width = vw; srcCanvas.height = vh;
            canvas.width    = vw; canvas.height    = vh;
        }

        srcCtx.drawImage(video, 0, 0, vw, vh);
        const frame = srcCtx.getImageData(0, 0, vw, vh);
        applyUnsharpMask(frame.data, vw, vh, 1.0);
        outCtx.putImageData(frame, 0, 0);

        positionCanvas();
        _sharpenRafId = requestAnimationFrame(renderFrame);
    }

    window.startSharpeningPipeline = function () {
        positionCanvas();
        canvas.style.display = 'block';
        if (_sharpenRafId) cancelAnimationFrame(_sharpenRafId);
        _sharpenRafId = requestAnimationFrame(renderFrame);
    };

    window.stopSharpeningPipeline = function () {
        if (_sharpenRafId) { cancelAnimationFrame(_sharpenRafId); _sharpenRafId = null; }
        canvas.style.display = 'none';
    };

    window.addEventListener('resize', () => { if (imageSharpeningEnabled) positionCanvas(); });
}

/* Called from settings.html */
function toggleImageSharpening() {
    const chk = document.getElementById('chkSettingsImageSharpening');
    imageSharpeningEnabled = chk ? chk.checked : false;
    if (imageSharpeningEnabled) {
        if (typeof window.startSharpeningPipeline === 'function') window.startSharpeningPipeline();
        $('body').toast({ message: '<i class="magic icon"></i> Image sharpening enabled' });
    } else {
        if (typeof window.stopSharpeningPipeline === 'function') window.stopSharpeningPipeline();
        $('body').toast({ message: '<i class="magic icon"></i> Image sharpening disabled' });
    }
}
