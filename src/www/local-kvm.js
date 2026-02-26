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
        await serialPort.open({ baudRate: 115200 });
        serialReader = serialPort.readable.getReader();
        serialWriter = serialPort.writable.getWriter();
        updateSelectedPortDisplay(serialPort);

        // Change button to indicate connected state
        document.getElementById('selectSerialPort').classList.add('negative');
        document.querySelector('#selectSerialPort i').className = 'unlink icon';

        // Start reading loop for incoming data
        readSerialLoop();
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
            0x57, 0xAB, 0x00, 0x0F, 0x00 // checksum placeholder
        ];
        packet[4] = this.calcChecksum(packet.slice(0, 4));
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

// Mouse move (absolute positioning)
videoOverlayElement.addEventListener('mousemove', async (e) => {
    const rect = videoOverlayElement.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const width = rect.width;
    const height = rect.height;
    const offsetX = x / width;
    const offsetY = y / height;
    //console.log('Offset ratio:', { offsetX, offsetY });

    const absX = Math.round(offsetX * 4095);
    const absY = Math.round(offsetY * 4095);
    if (controller.Config.AbsoluteMode) {
        controller.hidState.MousePosition.x = absX;
        controller.hidState.MousePosition.y = absY;
    }
    await controller.MouseMoveAbsolute(absX & 0xFF, (absX >> 8) & 0xFF, absY & 0xFF, (absY >> 8) & 0xFF);
});

// Context menu disable (for right click)
videoOverlayElement.addEventListener('contextmenu', (e) => {
    e.preventDefault();
});

// Mouse wheel (scroll)
let invertScrollCheckboxEle = document.getElementById('invertScroll');
let scrollSensitivity = 2; // Default scroll sensitivity
videoOverlayElement.addEventListener('wheel', async (e) => {
    e.preventDefault();
    let tilt = e.deltaY > 0 ? scrollSensitivity : -scrollSensitivity;
    
    // Check if scroll inversion is enabled
    if (invertScrollCheckboxEle && invertScrollCheckboxEle.checked) {
        tilt = -tilt;  // Invert the scroll direction
    }
    
    await controller.MouseScroll(tilt);
});

// Keyboard events for HID emulation
window.addEventListener('keydown', async (e) => {
    // Check if "Ask on paste" is enabled and user pressed Ctrl+V
    const askOnPasteCheckbox = document.getElementById('askOnPaste');
    if (askOnPasteCheckbox && askOnPasteCheckbox.checked) {
        // Allow Ctrl+V to be handled by paste-box.js
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            return; // Don't prevent default, let paste event fire
        }
    }
    
    // Ignore repeated events
    //if (e.repeat) return;
    try {
        // Modifier keys
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
            await controller.SetModifierKey(e.keyCode, e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        } else {
            await controller.SendKeyboardPress(e.keyCode);
        }
        e.preventDefault();
    } catch (err) {
        // Ignore unsupported keys
    }
});

window.addEventListener('keyup', async (e) => {
    // Check if "Ask on paste" is enabled and user released Ctrl+V
    const askOnPasteCheckbox = document.getElementById('askOnPaste');
    if (askOnPasteCheckbox && askOnPasteCheckbox.checked) {
        // Allow Ctrl+V to be handled by paste-box.js
        if ((e.ctrlKey || e.metaKey) && e.key === 'v') {
            return; // Don't prevent default
        }
    }
    
    try {
        if (e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') {
            await controller.UnsetModifierKey(e.keyCode, e.location === KeyboardEvent.DOM_KEY_LOCATION_RIGHT);
        } else {
            await controller.SendKeyboardRelease(e.keyCode);
        }
        e.preventDefault();
    } catch (err) {
        // Ignore unsupported keys
    }
});

document.getElementById('resetHIDMenuItem').addEventListener('click', async () => {
    try {
        await controller.softReset();
        $('body').toast({
            message: '<i class="green check circle icon"></i> HID soft reset sent.'
        });
        const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
        await delay(50);
        // Simulate Shift press and release
        await controller.SetModifierKey(16, false); // Left Shift
        await delay(50);
        await controller.UnsetModifierKey(16, false);
        await delay(100);

        // Simulate Ctrl press and release
        await controller.SetModifierKey(17, false); // Left Ctrl
        await delay(50);
        await controller.UnsetModifierKey(17, false);
        await delay(100);

        // Simulate Alt press and release
        await controller.SetModifierKey(18, false); // Left Alt
        await delay(50);
        await controller.UnsetModifierKey(18, false);
    } catch (e) {
        alert('Failed to reset HID: ' + e.message);
    }
});

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

function findDevice(devices, type, vid, pid) {
    // Spec doesn't define how to find a device with specified VID/PID
    // Chrome appends (vid:pid) to the device label
    // TODO: make sure it works on Firefox/Safari
    return devices.find(
        x =>
            x.kind === type &&
            x.label.endsWith(`(${vid.toLowerCase()}:${pid.toLowerCase()})`)
    );
}

async function startStream() {
    try {
        // Only getUserMedia triggers the permission popup, enumerateDevices won't
        await requestMediaDevicePermission();

        const devices = await window.navigator.mediaDevices.enumerateDevices();
        const videoDevice = findDevice(devices, 'videoinput', '534d', '2109');
        const audioDevice = findDevice(devices, 'audioinput', '534d', '2109');

        if (!videoDevice) {
            console.error('MS2109 video device not found');
            $('body').toast({
                message: '<i class="red exclamation triangle icon"></i> MS2109 video capture device not found. Please connect the device and try again.'
            });
            return;
        }

        if (!audioDevice) {
            console.warn('MS2109 audio device not found');
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
                const context = new AudioContext({ sampleRate: 96000 });
                const source = context.createMediaStreamSource(audioStream);
                
                // Add audio worklet processor for channel splitting
                await context.audioWorklet.addModule('data:application/javascript;charset=utf8,' + encodeURIComponent(`
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
                
                const processor = new AudioWorkletNode(context, 'split-processor', {
                    numberOfInputs: 1,
                    numberOfOutputs: 1,
                });
                source.connect(processor);
                processor.connect(context.destination);

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

// Start stream on page load
startStream();

navigator.mediaDevices.addEventListener('devicechange', () => {
   startStream();
});


