/*
    quick-access.js
    
    Quick Access Hotkey Panel for IT professionals
*/

let quickAccessVisible = false;
let quickAccessDragging = false;
let quickAccessOffset = { x: 0, y: 0 };
let quickAccessPos = { x: 0, y: 0 };

// HID keycodes mapping (from local-kvm.js)
const HID_KEYS = {
    CTRL: 17,
    SHIFT: 16,
    ALT: 18,
    WIN: 91,
    CMD: 91, // Same as Windows key
    DEL: 46,
    ENTER: 13,
    ESC: 27,
    TAB: 9,
    SPACE: 32,
    PRINTSCREEN: 44,
    F2: 113,
    F4: 115,
    F5: 116,
    L: 76,
    D: 68,
    E: 69,
    R: 82,
    S: 83,
    T: 84,
    A: 65,
    C: 67,
    V: 86,
    W: 87,
    Y: 89,
    Z: 90,
    F: 70,
    P: 80,
    KEY_3: 51,
    KEY_4: 52
};

function initializeQuickAccess() {
    const $quickAccess = $('#quickAccess');
    const $dragBar = $('.quick-access-drag-bar');
    
    centerQuickAccess();
    
    // Drag functionality
    $dragBar.on('mousedown', function(e) {
        if ($(e.target).closest('button').length > 0) return;
        
        quickAccessDragging = true;
        quickAccessOffset.x = e.clientX - quickAccessPos.x;
        quickAccessOffset.y = e.clientY - quickAccessPos.y;
        e.preventDefault();
    });
    
    $(document).on('mousemove', function(e) {
        if (quickAccessDragging) {
            const newX = e.clientX - quickAccessOffset.x;
            const newY = e.clientY - quickAccessOffset.y;
            
            const maxX = window.innerWidth - $quickAccess.outerWidth();
            const maxY = window.innerHeight - $quickAccess.outerHeight();
            const minX = 0;
            const minY = 0;
            quickAccessPos.x = Math.max(minX, Math.min(newX, maxX));
            quickAccessPos.y = Math.max(minY, Math.min(newY, maxY));
            
            $quickAccess.css({
                left: quickAccessPos.x + 'px',
                top: quickAccessPos.y + 'px',
                bottom: 'auto'
            });
        }
    });
    
    $(document).on('mouseup', function() {
        if (quickAccessDragging) {
            quickAccessDragging = false;
        }
    });
    
    // Close button
    $('#closeQuickAccess').on('click', function() {
        toggleQuickAccess();
    });
    
    // Hotkey buttons
    $('.hotkey-btn').on('click', function(e) {
        e.preventDefault();
        const action = $(this).data('action');
        executeHotkey(action);
        
        // Visual feedback
        $(this).css('opacity', '0.6');
        setTimeout(() => {
            $(this).css('opacity', '1');
        }, 200);
    });
}

function centerQuickAccess() {
    const $quickAccess = $('#quickAccess');
    const quickAccessWidth = $quickAccess.outerWidth();
    const quickAccessHeight = $quickAccess.outerHeight();
    // Position at bottom right corner with 20px margin
    quickAccessPos.x = window.innerWidth - quickAccessWidth;
    quickAccessPos.y = window.innerHeight - quickAccessHeight;
    
    $quickAccess.css({
        left: quickAccessPos.x + 'px',
        top: quickAccessPos.y + 'px',
        bottom: 'auto'
    });
}

function toggleQuickAccess() {
    const $quickAccess = $('#quickAccess');
    quickAccessVisible = !quickAccessVisible;
    
    if (quickAccessVisible) {
        $quickAccess.show();
        centerQuickAccess();
    } else {
        $quickAccess.hide();
    }
}

// Execute hotkey combinations
async function executeHotkey(action) {
    if (!controller) {
        $('body').toast({
            message: '<i class="warning icon"></i> KVM not connected',
            class: 'warning'
        });
        return;
    }
    
    // Check if serial port is connected and ready
    if (!serialPort || !serialWriter) {
        $('body').toast({
            message: '<i class="red circle times icon"></i> HID not connected',
        });
        return;
    }
    
    try {
        switch (action) {
            // Windows Hotkeys
            case 'ctrl-alt-del':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.ALT, HID_KEYS.DEL]);
                break;
            
            case 'win-shift-s':
                await sendKeyCombination([HID_KEYS.WIN, HID_KEYS.SHIFT, HID_KEYS.S]);
                break;
            
            case 'win-l':
                await sendKeyCombination([HID_KEYS.WIN, HID_KEYS.L]);
                break;
            
            case 'win-d':
                await sendKeyCombination([HID_KEYS.WIN, HID_KEYS.D]);
                break;
            
            case 'win-e':
                await sendKeyCombination([HID_KEYS.WIN, HID_KEYS.E]);
                break;
            
            case 'win-r':
                await sendKeyCombination([HID_KEYS.WIN, HID_KEYS.R]);
                break;
            
            case 'ctrl-shift-esc':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.SHIFT, HID_KEYS.ESC]);
                break;
            
            case 'alt-f4':
                await sendKeyCombination([HID_KEYS.ALT, HID_KEYS.F4]);
                break;
            
            // Screenshot Hotkeys
            case 'printscreen':
                await sendKeyCombination([HID_KEYS.PRINTSCREEN]);
                break;
            
            case 'alt-printscreen':
                await sendKeyCombination([HID_KEYS.ALT, HID_KEYS.PRINTSCREEN]);
                break;
            
            case 'mac-cmd-shift-3':
                await sendKeyCombination([HID_KEYS.CMD, HID_KEYS.SHIFT, HID_KEYS.KEY_3]);
                break;
            
            case 'mac-cmd-shift-4':
                await sendKeyCombination([HID_KEYS.CMD, HID_KEYS.SHIFT, HID_KEYS.KEY_4]);
                break;
            
            // Common IT Hotkeys
            case 'alt-tab':
                await sendKeyCombination([HID_KEYS.ALT, HID_KEYS.TAB]);
                break;
            
            case 'f2':
                await sendKeyCombination([HID_KEYS.F2]);
                break;
            
            case 'ctrl-c':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.C]);
                break;
            
            case 'ctrl-v':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.V]);
                break;
            
            case 'ctrl-z':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.Z]);
                break;
            
            case 'ctrl-y':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.Y]);
                break;
            
            case 'ctrl-a':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.A]);
                break;
            
            case 'ctrl-f':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.F]);
                break;
            
            case 'ctrl-s':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.S]);
                break;
            
            case 'ctrl-p':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.P]);
                break;
            
            case 'f5':
                await sendKeyCombination([HID_KEYS.F5]);
                break;
            
            case 'ctrl-w':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.W]);
                break;
            
            // Linux Hotkeys
            case 'ctrl-alt-t':
                await sendKeyCombination([HID_KEYS.CTRL, HID_KEYS.ALT, HID_KEYS.T]);
                break;
            
            case 'super-l':
                await sendKeyCombination([HID_KEYS.WIN, HID_KEYS.L]);
                break;
            
            default:
                console.warn('Unknown hotkey action:', action);
                return;
        }
        
        // Show success toast
        $('body').toast({
            message: '<i class="green circle check icon"></i> Hotkey sent',
            displayTime: 1000
        });
    } catch (error) {
        console.error('Error executing hotkey:', error);
        $('body').toast({
            message: '<i class="exclamation icon"></i> Failed to send hotkey',
            class: 'error'
        });
    }
}

// Send a key combination (press all keys, then release all)
async function sendKeyCombination(keycodes) {
    // Press all keys
    for (const keycode of keycodes) {
        await controller.SendKeyboardPress(keycode);
        await sleep(10); // Small delay between key presses
    }
    
    // Release all keys in reverse order
    for (let i = keycodes.length - 1; i >= 0; i--) {
        await controller.SendKeyboardRelease(keycodes[i]);
        await sleep(10);
    }
}

// Helper function for delays
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Initialize when the component is loaded
$(document).ready(function() {
    // Wait a bit for the HTML to be fully loaded
    setTimeout(initializeQuickAccess, 100);
});
