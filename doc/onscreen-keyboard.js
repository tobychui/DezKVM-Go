/*
    onscreen-keyboard.js
    
    Virtual on-screen keyboard with draggable and resizable features
*/

const MAX_HOLD_KEYS = 6;
let keyboardVisible = false;
let keyboardFullWidth = false;
let keyboardDragging = false;
let keyboardOffset = { x: 0, y: 0 };
let holdModeEnabled = false;
let heldKeys = new Map();
let shiftHeld = false;
let ctrlHeld = false;
let altHeld = false;
let capsLockHeld = false;
let keyboardPos = { x: 0, y: 0 };

function initializeOnscreenKeyboard() {
    const $keyboard = $('#onscreenKeyboard');
    const $dragBar = $('.keyboard-drag-bar');
    
    centerKeyboard();
    
    $dragBar.on('mousedown', function(e) {
        if ($(e.target).closest('button').length > 0) return;
        if (keyboardFullWidth) return;
        
        keyboardDragging = true;
        // Calculate offset based on current position, not getBoundingClientRect
        keyboardOffset.x = e.clientX - keyboardPos.x;
        keyboardOffset.y = e.clientY - keyboardPos.y;
        e.preventDefault();
    });
    
    $(document).on('mousemove', function(e) {
        if (keyboardDragging) {
            const newX = e.clientX - keyboardOffset.x;
            const newY = e.clientY - keyboardOffset.y;
            
            const maxX = window.innerWidth - ($keyboard.outerWidth() / 2);
            const maxY = window.innerHeight - $keyboard.outerHeight();
            const minX = ($keyboard.outerWidth() / 2);
            const minY = 0;
            keyboardPos.x = Math.max(minX, Math.min(newX, maxX));
            keyboardPos.y = Math.max(minY, Math.min(newY, maxY));
            
            $keyboard.css({
                left: keyboardPos.x + 'px',
                top: keyboardPos.y + 'px',
                bottom: 'auto'
            });
        }
    });
    
    $(document).on('mouseup', function() {
        if (keyboardDragging) {
            keyboardDragging = false;
        }
    });
    
    $('.key').on('mousedown', function(e) {
        e.preventDefault();
        handleKeyPress($(this));
    });
    
    $('.key').on('mouseup', function(e) {
        e.preventDefault();
        handleKeyRelease($(this));
    });
    
    $('.key').on('contextmenu', function(e) {
        e.preventDefault();
        return false;
    });
}

function centerKeyboard() {
    const $keyboard = $('#onscreenKeyboard');
    const keyboardWidth = $keyboard.outerWidth();
    const keyboardHeight = $keyboard.outerHeight();
    
    keyboardPos.x = (window.innerWidth - keyboardWidth) / 2;
    keyboardPos.y = window.innerHeight - keyboardHeight - 20;
    
    $keyboard.css({
        left: keyboardPos.x + 'px',
        top: keyboardPos.y + 'px',
        bottom: 'auto'
    });
}

function toggleOnscreenKeyboard() {
    const $keyboard = $('#onscreenKeyboard');
    keyboardVisible = !keyboardVisible;
    
    if (keyboardVisible) {
        $keyboard.show();
        if (!keyboardFullWidth) centerKeyboard();
    } else {
        $keyboard.hide();
        releaseAllModifiers();
    }
}

function toggleKeyboardSize() {
    const $keyboard = $('#onscreenKeyboard');
    const $toggleBtn = $('#btnToggleKeyboardSize i');
    
    keyboardFullWidth = !keyboardFullWidth;
    
    if (keyboardFullWidth) {
        $keyboard.addClass('fullwidth');
        $toggleBtn.removeClass('expand arrows alternate').addClass('compress');
        $keyboard.css({ left: '0', top: 'auto', bottom: '0' });
    } else {
        $keyboard.removeClass('fullwidth');
        $toggleBtn.removeClass('compress').addClass('expand arrows alternate');
        $keyboard.css({ bottom: 'auto' });
        centerKeyboard();
    }
}

function handleKeyPress($key) {
    const keyCode = parseInt($key.attr('data-key'));
    const isModifier = $key.hasClass('modifier-key');
    const isRightKey = $key.hasClass('key-shift-right') || 
                       $key.hasClass('key-ctrl-right') || 
                       $key.hasClass('key-alt-right');
    
    if (isModifier) {
        toggleModifierKey($key, keyCode, isRightKey);
    } else {
        if (holdModeEnabled) {
            const keyIdentifier = keyCode + (isRightKey ? '_right' : '_left');
            
            if (heldKeys.has(keyIdentifier)) {
                const heldData = heldKeys.get(keyIdentifier);
                heldData.$key.removeClass('active held');
                sendVirtualKeyRelease(keyCode, isRightKey);
                heldKeys.delete(keyIdentifier);
            } else {
                if (heldKeys.size >= MAX_HOLD_KEYS) {
                    $('body').toast({
                        message: `Maximum ${MAX_HOLD_KEYS} keys can be held simultaneously`,
                        class: 'warning'
                    });
                    return;
                }
                
                $key.addClass('active held');
                sendVirtualKeyPress(keyCode, isRightKey);
                heldKeys.set(keyIdentifier, { $key: $key, isRightKey: isRightKey });
            }
        } else {
            $key.addClass('active');
            sendVirtualKeyPress(keyCode, isRightKey);
        }
    }
}

function handleKeyRelease($key) {
    const keyCode = parseInt($key.attr('data-key'));
    const isModifier = $key.hasClass('modifier-key');
    const isRightKey = $key.hasClass('key-shift-right') || 
                       $key.hasClass('key-ctrl-right') || 
                       $key.hasClass('key-alt-right');
    
    if (!isModifier && !holdModeEnabled) {
        $key.removeClass('active');
        sendVirtualKeyRelease(keyCode, isRightKey);
    }
}

function toggleModifierKey($key, keyCode, isRightKey = false) {
    if (keyCode === 16) {
        shiftHeld = !shiftHeld;
        updateModifierState($('.key-shift-left, .key-shift-right'), shiftHeld);
        if (shiftHeld) {
            sendVirtualKeyPress(16, isRightKey);
        } else {
            sendVirtualKeyRelease(16, isRightKey);
        }
    } else if (keyCode === 17) {
        ctrlHeld = !ctrlHeld;
        updateModifierState($('.key-ctrl-left, .key-ctrl-right'), ctrlHeld);
        if (ctrlHeld) {
            sendVirtualKeyPress(17, isRightKey);
        } else {
            sendVirtualKeyRelease(17, isRightKey);
        }
    } else if (keyCode === 18) {
        altHeld = !altHeld;
        updateModifierState($('.key-alt-left, .key-alt-right'), altHeld);
        if (altHeld) {
            sendVirtualKeyPress(18, isRightKey);
        } else {
            sendVirtualKeyRelease(18, isRightKey);
        }
    } else if (keyCode === 20) {
        capsLockHeld = !capsLockHeld;
        updateModifierState($('.key-caps'), capsLockHeld);
        sendVirtualKeyPress(20, false);
        setTimeout(() => sendVirtualKeyRelease(20, false), 50);
    } else if (keyCode === 91) {
        sendVirtualKeyPress(91, false);
        setTimeout(() => sendVirtualKeyRelease(91, false), 50);
    }
}

function updateModifierState($keys, isHeld) {
    if (isHeld) {
        $keys.addClass('held');
    } else {
        $keys.removeClass('held');
    }
}

function releaseAllModifiers() {
    if (shiftHeld) {
        sendVirtualKeyRelease(16, false);
        shiftHeld = false;
        updateModifierState($('.key-shift-left, .key-shift-right'), false);
    }
    if (ctrlHeld) {
        sendVirtualKeyRelease(17, false);
        ctrlHeld = false;
        updateModifierState($('.key-ctrl-left, .key-ctrl-right'), false);
    }
    if (altHeld) {
        sendVirtualKeyRelease(18, false);
        altHeld = false;
        updateModifierState($('.key-alt-left, .key-alt-right'), false);
    }
    if (capsLockHeld) {
        capsLockHeld = false;
        updateModifierState($('.key-caps'), false);
    }
}

function releaseAllHeldKeys() {
    heldKeys.forEach((heldData, keyIdentifier) => {
        const keyCode = parseInt(keyIdentifier.split('_')[0]);
        heldData.$key.removeClass('active held');
        sendVirtualKeyRelease(keyCode, heldData.isRightKey);
    });
    heldKeys.clear();
}

function toggleHoldMode() {
    holdModeEnabled = !holdModeEnabled;
    const $btnElement = $('#btnToggleHoldMode');
    
    if (holdModeEnabled) {
        $btnElement.attr('title', 'Hold Mode: ON (Click keys to hold/release)');
        $btnElement.addClass("orange");
    } else {
        $btnElement.attr('title', 'Hold Mode: OFF');
        $btnElement.removeClass("orange");
        releaseAllHeldKeys();
    }
}

function sendVirtualKeyPress(keyCode, isRightModifier = false) {
    if (typeof controller !== 'undefined' && controller) {
        controller.SendKeyboardPress(keyCode);
    }
}

function sendVirtualKeyRelease(keyCode, isRightModifier = false) {
    if (typeof controller !== 'undefined' && controller) {
        controller.SendKeyboardRelease(keyCode);
    }
}

// Event listeners for keyboard buttons
$(document).ready(function() {
    $('#btnOnscreenKeyboard').on('click', toggleOnscreenKeyboard);
    $('#btnCloseKeyboard').on('click', toggleOnscreenKeyboard);
    $('#btnToggleKeyboardSize').on('click', toggleKeyboardSize);
    $('#btnToggleHoldMode').on('click', toggleHoldMode);
    
    // Initialize keyboard after HTML is loaded
    setTimeout(initializeOnscreenKeyboard, 100);
});
