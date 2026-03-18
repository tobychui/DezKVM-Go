/*

    DezKVM-Go IP-KVM Mode

    This mode only avaible when running on Linux with root privileges
    in self-host environment

    Note that this is for a temporary setup to enable IP-KVM functionality
    in DezKVM-Go, and is not intended to be a long-term solution.

    Checkout DezKVM (The Full version of the project) for a more complete and 
    robust IP-KVM implementation
*/
let ipKvmSupported = false;

// Resize touchscreen overlay to match the visible content of the MJPEG img element
function resizeTouchscreenToMJPEGImgEle() {
    const img = document.getElementById('ipkvm_mjpeg');
    const touchscreen = document.getElementById('touchscreen');
    if (!img || !touchscreen) return;

    const rect = img.getBoundingClientRect();
    // Known MJPEG stream resolution
    const aspectRatio = 1920 / 1080;

    let displayWidth = rect.width;
    let displayHeight = rect.height;
    let offsetX = 0;
    let offsetY = 0;

    // Calculate the actual displayed image area (may be letterboxed/pillarboxed)
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

function support_ip_kvm_mode() {
    $.ajax({
        url: "/api/ipkvm/check",
        method: "GET",
        success: function(data) {
            if (data) {
                $(".ip-kvm-features").show();
                $(".local-kvm-only").hide();
                document.title += " [IP-KVM Mode]";
                ipKvmSupported = true;

                // Also hide the kvmConnectPrompt if IP-KVM mode is supported, since it's for starting
                // local kvm session
                $("#kvmConnectPrompt").hide();

                // Load device list and sync status
                ipkvmLoadDeviceList();
                ipkvmSyncStatus();
                
                //Change the video streaming from video to image element
                $("#ipkvm_mjpeg").css("display", "block");
                $("#video").hide();
                if (touchscreenResizeFunction){
                    touchscreenResizeFunction = resizeTouchscreenToMJPEGImgEle;
                    // Resize when MJPEG image loads/updates
                    document.getElementById('ipkvm_mjpeg').addEventListener('load', function() {
                        touchscreenResizeFunction();
                    });
                }

                //Hide the local KVM display settings since they don't apply to IP-KVM mode
                $(".settings-tab-content[data-tab='display']").hide();
            } else {
                console.warn("IP-KVM mode not supported on this system");
                $(".ip-kvm-features").hide();
                $(".local-kvm-only").show();
                $("#ipkvm_mjpeg").hide();
            }
        },
        error: function() {
            $(".ip-kvm-features").hide();
            $(".local-kvm-only").show();
            $("#ipkvm_mjpeg").hide();
        }
    })
}

/* ── IP-KVM Status ── */

function ipkvmUpdateStatusUI(status) {
    const icon    = $('#ipkvmStatusIcon');
    const header  = $('#ipkvmStatusHeader');
    const detail  = $('#ipkvmStatusDetail');
    const msgBox  = $('#ipkvmStatusMessage');

    // Remove any previous colour classes
    msgBox.removeClass('positive negative info warning');
    icon.removeClass('notched circle loading green check circle red times circle yellow plug');

    if (status.video_capture_connected && status.hid_controller_connected) {
        msgBox.addClass('positive');
        icon.addClass('green check circle');
        header.text('Connected');
        let detailParts = [];
        if (status.video_device_name) detailParts.push('Video: ' + status.video_device_name);
        if (status.hid_device_name) detailParts.push('HID: /dev/' + status.hid_device_name);
        if (status.baudrate) detailParts.push('Baud: ' + status.baudrate);
        detail.html(detailParts.join('<br>'));

        // Sync buttons
        $('#ipkvmConnectBtn').hide();
        $('#ipkvmDisconnectBtn').show();

        if (!!window.chrome){
            $.toast({
                message: `Connecting MJPEG stream`,
                showProgress: 'bottom',
                classProgress: "blue",
                timeout: 2000,
            })
            setTimeout(function(){
                // There is a bug in Chrome that cannot decode the first frame of MJPEG stream
                // We need to refresh it after 1 sec for it to show up properly
                $("#ipkvm_mjpeg").attr("src","/api/ipkvm/video#" + Date.now());
            }, 2000)
        }else{
            // Sync MJPEG stream
            $("#ipkvm_mjpeg").attr("src","/api/ipkvm/video");
        }
    

        // Resize touchscreen overlay after stream starts (with short delay for rendering)
        setTimeout(function() {
            if (typeof touchscreenResizeFunction === 'function') {
                touchscreenResizeFunction();
            }
        }, 300);

        // Ensure HID WebSocket bridge is active
        ipkvmOverrideSerialIO();
    } else {
        //msgBox.addClass('');
        icon.addClass('unlink');
        header.text('Disconnected');
        detail.text('Select devices below and click Connect to start.');

        // Sync buttons
        $('#ipkvmConnectBtn').show();
        $('#ipkvmDisconnectBtn').hide();

        // Stop MJPEG stream
        $("#ipkvm_mjpeg").attr("src","img/ipkvm.png");
    }
}

function ipkvmSyncStatus() {
    $.get('/api/ipkvm/status', function(raw) {
        const status = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        ipkvmUpdateStatusUI(status);

        // Pre-select dropdowns to match connected devices
        if (status.video_capture_connected && status.video_device_name) {
            // video_device_name is like "/dev/video0", dropdown values are like "video0"
            const videoName = status.video_device_name.replace('/dev/', '');
            $('#ipkvmVideoDeviceSelect').val(videoName);
            ipkvmShowVideoProperties();
        }
        if (status.hid_controller_connected && status.hid_device_name) {
            $('#ipkvmTtyDeviceSelect').val(status.hid_device_name);
            ipkvmShowTtyProperties();
        }
        if (status.baudrate) {
            const radio = document.querySelector('input[name="baudrate"][value="' + status.baudrate + '"]');
            if (radio) radio.checked = true;
        }

    }).fail(function() {
        // If status API fails, show disconnected state
        ipkvmUpdateStatusUI({ video_capture_connected: false, hid_controller_connected: false });
    });
}

/* ── IP-KVM device list & configure ── */

let _ipkvmDeviceList = null;

function ipkvmLoadDeviceList() {
    $.get('/api/ipkvm/device_list', function(raw) {
        const data = (typeof raw === 'string') ? JSON.parse(raw) : raw;
        _ipkvmDeviceList = data;

        // Populate video dropdown
        const vidSel = $('#ipkvmVideoDeviceSelect');
        vidSel.empty();
        if (data.video_dev && data.video_dev.length) {
            data.video_dev.forEach(function(d) {
                vidSel.append($('<option>').val(d.name).text(d.name + ' (' + d.path + ')'));
            });
        } else {
            vidSel.append($('<option value="">No video devices found</option>'));
        }

        // Populate tty dropdown
        const ttySel = $('#ipkvmTtyDeviceSelect');
        ttySel.empty();
        if (data.tty_dev && data.tty_dev.length) {
            data.tty_dev.forEach(function(d) {
                const label = d.properties ? d.name + ' – ' + d.properties : d.name;
                ttySel.append($('<option>').val(d.name).text(label + ' (' + d.path + ')'));
            });
        } else {
            ttySel.append($('<option value="">No TTY devices found</option>'));
        }

        // Show properties for the first selected items
        ipkvmShowVideoProperties();
        ipkvmShowTtyProperties();
    }).fail(function() {
        $('#ipkvmVideoDeviceSelect').empty().append('<option value="">Failed to load</option>');
        $('#ipkvmTtyDeviceSelect').empty().append('<option value="">Failed to load</option>');
    });
}

function ipkvmShowVideoProperties() {
    const name = $('#ipkvmVideoDeviceSelect').val();
    const table = $('#ipkvmVideoPropsTable');
    const body  = $('#ipkvmVideoPropsBody');
    body.empty();

    if (!name || !_ipkvmDeviceList) {
        table.hide();
        return;
    }

    const dev = _ipkvmDeviceList.video_dev.find(function(d){ return d.name === name; });
    if (!dev || !dev.properties) {
        table.hide();
        return;
    }

    // Properties string looks like "MJPG 1920x1080, MJPG 1360x768, ..."
    const entries = dev.properties.split(',').map(function(s){ return s.trim(); }).filter(Boolean);
    if (entries.length === 0) {
        table.hide();
        return;
    }

    entries.forEach(function(entry) {
        const parts = entry.split(/\s+/);
        const fmt = parts[0] || '';
        const res = parts.slice(1).join(' ') || '';
        body.append('<tr><td>' + $('<span>').text(fmt).html() + '</td><td>' + $('<span>').text(res).html() + '</td></tr>');
    });
    table.show();
}

function ipkvmShowTtyProperties() {
    const name = $('#ipkvmTtyDeviceSelect').val();
    const table = $('#ipkvmTtyPropsTable');
    const body  = $('#ipkvmTtyPropsBody');
    body.empty();

    if (!name || !_ipkvmDeviceList) {
        table.hide();
        return;
    }

    const dev = _ipkvmDeviceList.tty_dev.find(function(d){ return d.name === name; });
    if (!dev) {
        table.hide();
        return;
    }

    body.append('<tr><td>Device Name</td><td>' + $('<span>').text(dev.name).html() + '</td></tr>');
    body.append('<tr><td>Device Path</td><td>' + $('<span>').text(dev.path).html() + '</td></tr>');
    if (dev.properties) {
        body.append('<tr><td>Product</td><td>' + $('<span>').text(dev.properties).html() + '</td></tr>');
    }
    table.show();
}

function ipkvmConnect() {
    const video = $('#ipkvmVideoDeviceSelect').val();
    const hid   = $('#ipkvmTtyDeviceSelect').val();

    if (!video) {
        $('body').toast({ message: '<i class="yellow exclamation triangle icon"></i> Please select a video device'});
        return;
    }
    if (!hid) {
        $('body').toast({ message: '<i class="yellow exclamation triangle icon"></i> Please select a TTY device' });
        return;
    }

    // Read baudrate from the Advanced tab radio buttons
    const baudrateRadio = document.querySelector('input[name="baudrate"]:checked');
    const baud = baudrateRadio ? parseInt(baudrateRadio.value) : 115200;

    $('#ipkvmConnectBtn').addClass('loading disabled');

    $.post('/api/ipkvm/configure', { video: video, hid: hid, baud: baud }, function(resp) {
        $('#ipkvmConnectBtn').removeClass('loading disabled');
        $('body').toast({ message: '<i class="green circle check icon"></i> IP-KVM connected' });
        ipkvmSyncStatus();
        ipkvmOverrideSerialIO();
    }).fail(function(xhr) {
        $('#ipkvmConnectBtn').removeClass('loading disabled');
        let msg = 'Connection failed';
        try { msg = JSON.parse(xhr.responseText).error || msg; } catch(e){}
        $('body').toast({ message: '<i class="yellow exclamation circle icon"></i> ' + msg });
    });
}

function ipkvmDisconnect() {
    $('#ipkvmDisconnectBtn').addClass('loading disabled');

    $.ajax({
        url: '/api/ipkvm/disconnect',
        method: 'POST',
        timeout: 5000,
        success: function() {
            $('#ipkvmDisconnectBtn').removeClass('loading disabled');
            $('body').toast({ message: '<i class="blue info circle icon"></i> IP-KVM disconnected' });
            ipkvmDisconnectHidWebSocket();
            serialPort = null;
            serialWriter = null;
            ipkvmSyncStatus();
        },
        error: function(xhr, status, error) {
            $('#ipkvmDisconnectBtn').removeClass('loading disabled');
            // Treat timeout as success since disconnect likely worked
            if (status === 'timeout') {
                $('body').toast({ message: '<i class="blue info circle icon"></i> IP-KVM disconnected' });
                ipkvmDisconnectHidWebSocket();
                serialPort = null;
                serialWriter = null;
                ipkvmSyncStatus();
            } else {
                $('body').toast({ message: '<i class="red times circle icon"></i> Disconnect failed' });
            }
        }
    });
}


/* ── WebSocket HID Bridge (replaces Web Serial in IP-KVM mode) ── */

let hidWebSocket = null;

function ipkvmConnectHidWebSocket() {
    if (hidWebSocket && hidWebSocket.readyState <= WebSocket.OPEN) {
        return; // already connected or connecting
    }

    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = proto + '//' + location.host + '/api/ipkvm/hid';
    hidWebSocket = new WebSocket(wsUrl);
    hidWebSocket.binaryType = 'arraybuffer';

    hidWebSocket.onopen = function () {
        console.log('[IP-KVM] HID WebSocket connected');
    };

    hidWebSocket.onmessage = function (evt) {
        // Push received bytes into the shared serialReadBuffer
        const bytes = new Uint8Array(evt.data);
        serialReadBuffer.push(...bytes);
    };

    hidWebSocket.onclose = function () {
        console.log('[IP-KVM] HID WebSocket closed');
        hidWebSocket = null;
    };

    hidWebSocket.onerror = function (err) {
        console.error('[IP-KVM] HID WebSocket error', err);
    };
}

function ipkvmDisconnectHidWebSocket() {
    if (hidWebSocket) {
        hidWebSocket.close();
        hidWebSocket = null;
    }
}

/**
 * Override the serial reader/writer globals so the existing
 * HIDController in local-kvm.js works transparently over WebSocket.
 */
function ipkvmOverrideSerialIO() {
    // Connect the WebSocket
    ipkvmConnectHidWebSocket();

    // Fake serialPort object so guard checks like
    //   if (!serialPort || !serialPort.readable || !serialPort.writable)
    // pass through.
    serialPort = { readable: true, writable: true };

    // Provide a writer object with a write() method for the
    //   if (!serialWriter) throw ...
    // guard inside sendSerial().
    serialWriter = {
        write: function (data) {
            if (hidWebSocket && hidWebSocket.readyState === WebSocket.OPEN) {
                hidWebSocket.send(data);
            }
        }
    };

    // Override sendSerial so all HID packets go through the WebSocket
    window.sendSerial = async function (data) {
        if (!hidWebSocket || hidWebSocket.readyState !== WebSocket.OPEN) {
            //throw new Error('HID WebSocket not open');
            return; // Silently ignore if WebSocket is not open, to avoid flooding with errors during disconnect
        }
        hidWebSocket.send(data);
    };

    // Suppress the click-to-select-serial-port behaviour
    selectingSerialPort = true;

    console.log('[IP-KVM] Serial I/O overridden to use WebSocket');
}


$(document).ready(function(){
    setTimeout(function(){
        support_ip_kvm_mode();
    }, 1000);
});

