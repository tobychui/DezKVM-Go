/*
    paste-box.js

    This script implements the Paste Box functionality, allowing users to
    input text and send it as simulated keyboard input to the remote system
    via HID.
*/

const PASTE_BOX_MAX_CHARS = 1000;
let pasteBoxActive = false;
let pasteCancelled = false;

const charToKeyCode = {
    '0': 48, '1': 49, '2': 50, '3': 51, '4': 52,
    '5': 53, '6': 54, '7': 55, '8': 56, '9': 57,
    'a': 65, 'b': 66, 'c': 67, 'd': 68, 'e': 69,
    'f': 70, 'g': 71, 'h': 72, 'i': 73, 'j': 74,
    'k': 75, 'l': 76, 'm': 77, 'n': 78, 'o': 79,
    'p': 80, 'q': 81, 'r': 82, 's': 83, 't': 84,
    'u': 85, 'v': 86, 'w': 87, 'x': 88, 'y': 89, 'z': 90,
    '!': {keycode: 49, shift: true}, '@': {keycode: 50, shift: true},
    '#': {keycode: 51, shift: true}, '$': {keycode: 52, shift: true},
    '%': {keycode: 53, shift: true}, '^': {keycode: 54, shift: true},
    '&': {keycode: 55, shift: true}, '*': {keycode: 56, shift: true},
    '(': {keycode: 57, shift: true}, ')': {keycode: 48, shift: true},
    ' ': 32, '-': 189, '_': {keycode: 189, shift: true},
    '=': 187, '+': {keycode: 187, shift: true},
    '[': 219, '{': {keycode: 219, shift: true},
    ']': 221, '}': {keycode: 221, shift: true},
    '\\': 220, '|': {keycode: 220, shift: true},
    ';': 186, ':': {keycode: 186, shift: true},
    "'": 222, '"': {keycode: 222, shift: true},
    ',': 188, '<': {keycode: 188, shift: true},
    '.': 190, '>': {keycode: 190, shift: true},
    '/': 191, '?': {keycode: 191, shift: true},
    '`': 192, '~': {keycode: 192, shift: true},
    '\n': 13, '\t': 9
};

function updatePasteBoxCharCounter() {
    const textarea = document.getElementById('pasteTextarea');
    const counter = document.getElementById('pasteCharCounter');
    const currentLength = textarea.value.length;
    counter.textContent = `${currentLength} / ${PASTE_BOX_MAX_CHARS}`;
    
    if (currentLength >= PASTE_BOX_MAX_CHARS) {
        counter.style.color = '#db2828';
    } else if (currentLength >= PASTE_BOX_MAX_CHARS * 0.9) {
        counter.style.color = '#f2711c';
    } else {
        counter.style.color = '#767676';
    }
}

function showPasteBox() {
    const pasteBox = document.getElementById('pasteBox');
    const textarea = document.getElementById('pasteTextarea');
    
    if (!textarea) {
        console.error('Paste box content not loaded yet');
        return;
    }
    
    pasteBox.style.display = 'flex';
    pasteBoxActive = true;
    
    // Use setTimeout to ensure display is updated before focus
    setTimeout(() => {
        textarea.focus();
    }, 0);
    
    updatePasteBoxCharCounter();
}

function closePasteBox() {
    const pasteBox = document.getElementById('pasteBox');
    pasteBox.style.display = 'none';
    pasteBoxActive = false;
}

function clearPasteBox() {
    document.getElementById('pasteTextarea').value = '';
    updatePasteBoxCharCounter();
}

async function sendKeyPress(keycode, needsShift = false) {
    if (typeof controller === 'undefined' || !controller) return;
    
    if (needsShift) {
        await controller.SendKeyboardPress(16);
    }
    
    await controller.SendKeyboardPress(keycode);
    await controller.SendKeyboardRelease(keycode);
    
    if (needsShift) {
        await controller.SendKeyboardRelease(16);
    }
}

function cancelPasteText() {
    pasteCancelled = true;
    $('body').toast({
        message: '<i class="orange exclamation icon"></i> Paste operation cancelled'
    });
}

async function sendPasteText() {
    const textarea = document.getElementById('pasteTextarea');
    const text = textarea.value;
    const progressBar = document.getElementById('pasteProgressBar');
    const sendButton = document.getElementById('btnSendPaste');
    const clearButton = document.getElementById('btnClearPaste');
    const cancelButton = document.getElementById('btnCancelPaste');
    
    if (!text) {
        $('body').toast({
            message: '<i class="yellow exclamation triangle icon"></i> No text to send',
        });
        return;
    }

    if (typeof controller === 'undefined' || !controller) {
        $('body').toast({
            message: '<i class="red times circle icon"></i> HID not connected',
        });
        return;
    }

    const estimatedTimeMs = text.length * 30;
    if (estimatedTimeMs > 10000) {
        const proceed = confirm(`Sending this text may take approximately ${(estimatedTimeMs / 1000).toFixed(1)} seconds. Do you want to proceed?`);
        if (!proceed) return;
    }

    pasteCancelled = false;
    sendButton.style.display = 'none';
    clearButton.style.display = 'none';
    cancelButton.style.display = 'inline-block';
    textarea.disabled = true;
    progressBar.style.display = 'block';
    $('#pasteProgressBar').progress({ percent: 0 });

    let sentCount = 0;
    let skippedCount = 0;

    for (let i = 0; i < text.length; i++) {
        if (pasteCancelled) break;

        const char = text[i];
        
        if (char >= 'A' && char <= 'Z') {
            await sendKeyPress(char.charCodeAt(0), true);
            sentCount++;
        } else if (char >= 'a' && char <= 'z') {
            await sendKeyPress(char.toUpperCase().charCodeAt(0), false);
            sentCount++;
        } else if (charToKeyCode[char] !== undefined) {
            const mapping = charToKeyCode[char];
            if (typeof mapping === 'object') {
                await sendKeyPress(mapping.keycode, mapping.shift);
            } else {
                await sendKeyPress(mapping, false);
            }
            sentCount++;
        } else {
            skippedCount++;
        }

        const progress = ((i + 1) / text.length) * 100;
        $('#pasteProgressBar').progress('set percent', progress);

        await new Promise(resolve => setTimeout(resolve, 30));
    }

    if (!pasteCancelled) {
        let message = `<i class="green check circle icon"></i> Sent ${sentCount} characters`;
        if (skippedCount > 0) {
            message += `, skipped ${skippedCount} unsupported characters`;
        }
        $('body').toast({ message: message });
    }

    sendButton.style.display = 'inline-block';
    clearButton.style.display = 'inline-block';
    cancelButton.style.display = 'none';
    textarea.disabled = false;
    progressBar.style.display = 'none';

    if (!pasteCancelled) {
        clearPasteBox();
        closePasteBox();
    }
}


// Initialize event listeners after content is loaded
$('#btnClosePaste').on('click', closePasteBox);
$('#btnClearPaste').on('click', clearPasteBox);
$('#btnSendPaste').on('click', sendPasteText);
$('#btnCancelPaste').on('click', cancelPasteText);
$('#pasteTextarea').on('input', updatePasteBoxCharCounter);

// Show paste box button listener
$('#showPasteBox').on('click', function(){
    showPasteBox();
});

