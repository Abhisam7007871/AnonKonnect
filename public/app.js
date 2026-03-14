// Global variables
let socket;
let userId = null;
let currentMode = null;
let currentSessionId = null;
let currentPeerId = null;
let peerConnection = null;
let localStream = null;
let userPreferences = {};
let messageHistory = [];

// DOM Elements updated to match new HTML
let connectionStatusEl, localVideo, remoteVideo, messagesContainer;
let peerNameEl, peerStatusEl, typingIndicator, messageInput;
let mainContent, joinFormSection, waitingScreen, chatScreen, mediaContainer;

// State flags
let isChatOpen = false;

// Initialize on page load
document.addEventListener('DOMContentLoaded', () => {
    // Initialize DOM references
    connectionStatusEl = document.getElementById('connectionStatus');
    localVideo = document.getElementById('localVideo');
    remoteVideo = document.getElementById('remoteVideo');
    messagesContainer = document.getElementById('messages');
    peerNameEl = document.getElementById('peerName');
    peerStatusEl = document.getElementById('peerStatus');
    typingIndicator = document.getElementById('typingIndicator');
    messageInput = document.getElementById('messageInput');

    // New UI Element mappings
    mainContent = document.getElementById('mainContent');
    joinFormSection = document.getElementById('join-form');
    waitingScreen = document.getElementById('waitingScreen');
    chatScreen = document.getElementById('chatScreen');
    mediaContainer = document.getElementById('mediaContainer');

    // Connect to signaling server
    connectToServer();
});

// Smooth scrolling for navigation
document.querySelectorAll('a[href^="#"]').forEach(anchor => {
    anchor.addEventListener('click', function (e) {
        e.preventDefault();
        const target = document.querySelector(this.getAttribute('href'));
        if (target) {
            target.scrollIntoView({ behavior: 'smooth' });
        }
    });
});

function scrollToForm(mode) {
    const form = document.getElementById('join-form');
    form.scrollIntoView({ behavior: 'smooth' });

    // Auto-select the corresponding mode card
    const cards = document.querySelectorAll('.mode-card-mini');
    cards.forEach(card => {
        if (card.innerText.toLowerCase() === mode) {
            selectMode(mode, card);
        }
    });
}

// Screen navigation functions
function showMainContent() {
    mainContent.classList.remove('hidden');
    waitingScreen.classList.add('hidden');
    chatScreen.classList.add('hidden');
    window.scrollTo(0, 0);
}

function showWaitingScreen() {
    mainContent.classList.add('hidden');
    chatScreen.classList.add('hidden');
    waitingScreen.classList.remove('hidden');
}

function showChatScreen() {
    mainContent.classList.add('hidden');
    waitingScreen.classList.add('hidden');
    chatScreen.classList.remove('hidden');
}

function hideAllScreens() {
    mainContent.classList.add('hidden');
    waitingScreen.classList.add('hidden');
    chatScreen.classList.add('hidden');
}

// Server connection
function connectToServer() {
    // Dynamically determine signaling server URL
    // LOCAL: http://localhost:3000
    // PRODUCTION: Use your persistent server URL (Render, Railway, etc.)
    const signalingUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:3000'
        : 'https://anonkonnect-server.onrender.com'; // Replace with your actual persistent server URL

    console.log(`[CLIENT] Connecting to signaling server: ${signalingUrl}`);
    socket = io(signalingUrl);

    socket.on('connect', () => {
        console.log('[CLIENT] Connected to signaling server');
        updateConnectionStatus(true);
    });

    socket.on('connected', (data) => {
        userId = data.userId;
        console.log('[CLIENT] Assigned User ID:', userId);
    });

    socket.on('disconnect', () => {
        console.log('[CLIENT] Disconnected from signaling server');
        updateConnectionStatus(false);
    });

    socket.on('matched', (data) => {
        console.log(`[CLIENT] Match found! Session: ${data.sessionId}`);
        handleMatchFound(data);
    });

    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('chat-message', handleIncomingMessage);
    socket.on('typing', handleTyping);

    socket.on('session:skip', (data) => {
        console.log(`[CLIENT] Session skipped. Rejoining queue... ActionUserData: ${data.isSelfAction ? 'Me' : 'Partner'}`);
        showConnectionToast(data.message);
        fullyCleanupSession();
    });

    socket.on('session:partner_left', (data) => {
        console.log(`[CLIENT] Partner left the session.`);
        showConnectionToast(data.message);
        fullyCleanupSession();
    });

    socket.on('rejoining-queue', () => {
        console.log(`[CLIENT] Rejoining queue...`);
        showWaitingScreen();
    });

    socket.on('left-to-home', (data) => {
        console.log(`[CLIENT] Redirecting to home...`);
        fullyCleanupSession();
        showMainContent();

        if (data && data.partnerName) {
            showReconnectBanner(data.partnerName);
        }
    });

    socket.on('reconnect_failed', (data) => {
        console.log(`[CLIENT] Reconnect failed: ${data.message}`);
        alert(data.message || 'Reconnect failed.');
        hideReconnectBanner();
    });
}

function updateConnectionStatus(connected) {
    const statusEl = document.getElementById('connectionStatus');
    if (connected) {
        statusEl.classList.add('connected');
        statusEl.innerHTML = '<span class="dot"></span> Connected';
    } else {
        statusEl.classList.remove('connected');
        statusEl.innerHTML = '<span class="dot"></span> Disconnected';
    }
}

// User info form handler
function handleInfoSubmit(event) {
    event.preventDefault();

    userPreferences = {
        nickname: document.getElementById('nickname').value || 'Stranger',
        gender: document.getElementById('gender').value || 'unspecified',
        purpose: document.getElementById('purpose').value || 'casual'
    };

    const mode = document.getElementById('selectedMode').value;
    if (!mode) {
        alert("Please select a connection mode.");
        return;
    }

    currentMode = mode;

    if (!socket || !socket.connected) {
        alert("Not connected to signaling server. Please try again.");
        return;
    }

    if (currentMode === 'audio' || currentMode === 'video') {
        requestMediaPermissions(currentMode);
    } else {
        joinQueue();
    }
}

// Mode Selection UI Logic
function selectMode(mode, element) {
    // Update Hidden Input
    document.getElementById('selectedMode').value = mode;

    // Update UI Cards
    document.querySelectorAll('.mode-card-mini').forEach(card => {
        card.classList.remove('selected');
    });
    element.classList.add('selected');

    // Enable submit button
    document.getElementById('startChatBtn').disabled = false;
}

async function requestMediaPermissions(mode) {
    try {
        const constraints = {
            audio: true,
            video: mode === 'video'
        };

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log(`[CLIENT] Media permissions granted. Mode: ${mode}`);

        if (mode === 'video' && localVideo) {
            localVideo.srcObject = localStream;

            localVideo.onloadedmetadata = () => {
                localVideo.play().catch(e => console.error("Auto-play prevented", e));
                applyAutoBrightness(localVideo);
            };
        }

        joinQueue();
    } catch (error) {
        console.error('Failed to get media permissions:', error);
        alert('Please grant camera/microphone permissions to continue');
    }
}

let brightnessInterval = null;

function applyAutoBrightness(videoElement) {
    if (brightnessInterval) clearInterval(brightnessInterval);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    brightnessInterval = setInterval(() => {
        if (!videoElement.videoWidth) return;

        canvas.width = videoElement.videoWidth;
        canvas.height = videoElement.videoHeight;

        try {
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            let brightnessAcc = 0;
            let samples = 0;

            // Sample pixels for performance
            for (let i = 0; i < data.length; i += 40) { // skip by 10 pixels (40 values)
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                // Relative luminance formula
                brightnessAcc += 0.2126 * r + 0.7152 * g + 0.0722 * b;
                samples++;
            }

            const avgBrightness = brightnessAcc / samples;

            // Apply brightness boost if too dark
            if (avgBrightness < 90 && avgBrightness > 0) {
                const multiplier = Math.min(130 / avgBrightness, 2.5); // Max 2.5x boost
                videoElement.style.filter = `brightness(1) contrast(1.1)`; // Add a touch of contrast
            } else {
                videoElement.style.filter = 'none';
            }
        } catch (e) {
            // Handle cross-origin or other canvas read errors gracefully
            console.error("Canvas read error during brightness check", e);
            clearInterval(brightnessInterval);
        }
    }, 2000);
}

function joinQueue() {
    socket.emit('join-queue', {
        mode: currentMode,
        preferences: userPreferences
    });

    showWaitingScreen();
}

// Queue handling
function handleQueueUpdate(data) {
    document.getElementById('queuePosition').textContent = data.position;
    document.getElementById('queueTotal').textContent = data.totalInQueue;
    document.getElementById('waitingMessage').textContent = data.message;
}

// Match found
async function handleMatchFound(data) {
    console.log('Match found!', data);

    currentSessionId = data.sessionId;
    currentPeerId = data.peerId;

    if (peerNameEl) {
        peerNameEl.textContent = data.peerPreferences?.nickname || 'Stranger';
    }

    // Initialize WebRTC connection
    await initializeWebRTC(data);

    // Show media container for non-text modes
    const mediaContainer = document.getElementById('mediaContainer');
    const chatLayout = document.querySelector('.chat-layout');
    const chatContainer = document.getElementById('chatContainer');

    if (data.mode === 'video' || data.mode === 'audio') {
        mediaContainer.classList.remove('hidden');
        chatLayout.classList.add('has-media');
        chatContainer.classList.add('chat-collapsed');
        isChatOpen = false;

        if (data.mode === 'audio') {
            // Optional: Hide video wrappers but keep audio tracks
            document.querySelectorAll('.video-wrapper').forEach(el => el.style.background = '#2d3748');
        }
    } else {
        mediaContainer.classList.add('hidden');
        chatLayout.classList.remove('has-media');
        chatContainer.classList.remove('chat-collapsed');
    }

    showChatScreen();
}

async function initializeWebRTC(data) {
    const configuration = {
        iceServers: data.iceServers.iceServers,
        iceCandidatePoolSize: data.iceServers.iceCandidatePoolSize
    };

    peerConnection = new RTCPeerConnection(configuration);

    // Add local stream if available
    if (localStream) {
        localStream.getTracks().forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
    }

    // Handle incoming tracks
    peerConnection.ontrack = (event) => {
        if (remoteVideo && event.streams[0]) {
            remoteVideo.srcObject = event.streams[0];
        }
    };

    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                to: currentPeerId,
                candidate: event.candidate,
                sessionId: currentSessionId
            });
        }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
        if (peerStatusEl) {
            peerStatusEl.textContent = peerConnection.connectionState;
        }
    };

    // If initiator, create offer
    if (data.initiator) {
        const offer = await peerConnection.createOffer();
        await peerConnection.setLocalDescription(offer);

        socket.emit('offer', {
            to: currentPeerId,
            offer: peerConnection.localDescription,
            sessionId: currentSessionId
        });
    }
}

// WebRTC signaling handlers
async function handleOffer(data) {
    console.log('Received offer');

    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));

    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer', {
        to: data.from,
        answer: peerConnection.localDescription,
        sessionId: currentSessionId
    });
}

async function handleAnswer(data) {
    console.log('Received answer');
    await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
}

async function handleIceCandidate(data) {
    console.log('Received ICE candidate');
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
}

// Media controls
function toggleVideo() {
    if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
            videoTrack.enabled = !videoTrack.enabled;
            console.log(`[CLIENT] Video ${videoTrack.enabled ? 'Enabled' : 'Disabled'}`);
            const btn = document.getElementById('tool-cam');
            if (btn) {
                btn.classList.toggle('danger', !videoTrack.enabled);
                btn.innerHTML = videoTrack.enabled ?
                    '<i class="ph-fill ph-video-camera"></i> Cam' :
                    '<i class="ph-fill ph-video-camera-slash"></i> Off';
            }
        }
    }
}

function toggleAudio() {
    if (localStream) {
        const audioTrack = localStream.getAudioTracks()[0];
        if (audioTrack) {
            audioTrack.enabled = !audioTrack.enabled;
            console.log(`[CLIENT] Audio ${audioTrack.enabled ? 'Unmuted' : 'Muted'}`);
            const btn = document.getElementById('tool-mic');
            if (btn) {
                btn.classList.toggle('danger', !audioTrack.enabled);
                btn.innerHTML = audioTrack.enabled ?
                    '<i class="ph-fill ph-microphone"></i> Mute' :
                    '<i class="ph-fill ph-microphone-slash"></i> Unmute';
            }
        }
    }
}

function toggleFullscreen() {
    const mediaContainer = document.getElementById('mediaContainer');
    if (!document.fullscreenElement) {
        if (mediaContainer.requestFullscreen) {
            mediaContainer.requestFullscreen();
        }
    } else {
        if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }
}

function toggleChatPanel() {
    isChatOpen = !isChatOpen;
    const chatContainer = document.getElementById('chatContainer');
    if (isChatOpen) {
        chatContainer.classList.remove('chat-collapsed');
    } else {
        chatContainer.classList.add('chat-collapsed');
    }
}

// Chat functions
function sendMessage(type = 'text', content = null) {
    let payload = { type, content };

    if (type === 'text') {
        const message = messageInput.value.trim();
        if (!message) return;
        payload.content = message;
        messageInput.value = '';
    }

    // Display own message locally
    displayMessage(payload, 'sent');
    console.log(`[CLIENT] Sending message: ${type}`);

    // Send via signaling server
    socket.emit('chat-message', {
        to: currentPeerId,
        message: payload,
        sessionId: currentSessionId
    });
}

function handleIncomingMessage(data) {
    // Handle both new payloads and legacy data objects seamlessly
    displayMessage(data.message, 'received');
}

function displayMessage(payload, type) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let contentHtml = '';

    // Backwards compatibility or direct text
    if (typeof payload === 'string') {
        contentHtml = escapeHtml(payload);
    } else {
        switch (payload.type) {
            case 'text':
                contentHtml = escapeHtml(payload.content);
                break;
            case 'emoji':
                contentHtml = `<span style="font-size: 24px;">${escapeHtml(payload.content)}</span>`;
                break;
            case 'gif':
                contentHtml = `<div class="gif-message"><img src="${payload.content}" alt="GIF"></div>`;
                break;
            case 'sticker':
                contentHtml = `<div class="sticker-message"><img src="${payload.content}" alt="Sticker" style="width: 100px;"></div>`;
                break;
            case 'voice':
                try {
                    let src = payload.content;
                    // If it's an ArrayBuffer received over Socket.IO, convert it back locally
                    if (payload.content instanceof ArrayBuffer) {
                        const blob = new Blob([payload.content], { type: 'audio/webm' });
                        src = URL.createObjectURL(blob);
                    }
                    contentHtml = `<audio class="audio-message" controls src="${src}"></audio>`;
                } catch (e) {
                    console.error("Audio render err:", e);
                    contentHtml = "<i>Voice Note Error</i>";
                }
                break;
            default:
                contentHtml = escapeHtml(String(payload.content || payload));
        }
    }

    messageEl.innerHTML = `
        <div class="message-content">${contentHtml}</div>
        <div class="message-time">${time}</div>
    `;

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function handleMessageKeyPress(event) {
    if (event.key === 'Enter') {
        sendMessage();
    }

    // Send typing indicator
    socket.emit('typing', {
        to: currentPeerId,
        isTyping: true,
        sessionId: currentSessionId
    });

    // Clear typing indicator after 2 seconds
    clearTimeout(window.typingTimeout);
    window.typingTimeout = setTimeout(() => {
        socket.emit('typing', {
            to: currentPeerId,
            isTyping: false,
            sessionId: currentSessionId
        });
    }, 2000);
}

function handleTyping(data) {
    if (data.isTyping) {
        typingIndicator.textContent = `${data.from} is typing...`;
    } else {
        typingIndicator.textContent = '';
    }
}

// Session management
function skipUser() {
    if (!currentSessionId) return;
    console.log(`[CLIENT] Skip Button Clicked. Current Session: ${currentSessionId}`);
    socket.emit('skip', {
        sessionId: currentSessionId
    });
}

function exitToHome() {
    if (currentSessionId) {
        console.log(`[CLIENT] Leave Button Clicked. Ending session: ${currentSessionId}`);
        socket.emit('leave_session', { sessionId: currentSessionId });
    } else {
        cancelWaiting();
    }
}

function fullyCleanupSession() {
    console.log(`[CLIENT] Executing full session cleanup...`);

    // 1. Stop all media tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log(`[CLIENT] Stopped track: ${track.kind}`);
        });
        localStream = null;
    }

    // 2. Destroy peer connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
        console.log(`[CLIENT] WebRTC Connection closed.`);
    }

    // 3. Clear UI & Video
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;

    messagesContainer.innerHTML = '<div class="system-message info">You are now chatting with a random stranger. Say hi!</div>';
    typingIndicator.textContent = '';

    currentSessionId = null;
    currentPeerId = null;

    if (brightnessInterval) {
        clearInterval(brightnessInterval);
        brightnessInterval = null;
    }

    // Hide media container if not in video/audio match anyway
    document.getElementById('mediaContainer').classList.add('hidden');

    // Reset toolbar buttons
    const micBtn = document.getElementById('tool-mic');
    const camBtn = document.getElementById('tool-cam');
    if (micBtn) { micBtn.innerHTML = '<i class="ph-fill ph-microphone"></i> Mute'; micBtn.classList.remove('danger'); }
    if (camBtn) { camBtn.innerHTML = '<i class="ph-fill ph-video-camera"></i> Cam'; camBtn.classList.remove('danger'); }
}

function cancelWaiting() {
    console.log(`[CLIENT] Cancel waiting triggered.`);
    socket.emit('leave-queue');
    fullyCleanupSession();
    showMainContent();
}

// Utility functions
function escapeHtml(unsafe) {
    return unsafe
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// ==========================================
// RICH CHAT FEATURES
// ==========================================

// 1. Emoji Picker
const emojiPicker = document.querySelector('emoji-picker');
if (emojiPicker) {
    emojiPicker.addEventListener('emoji-click', event => {
        messageInput.value += event.detail.unicode;
        toggleEmojiPicker();
    });
}

function toggleEmojiPicker() {
    document.getElementById('emojiPickerContainer').classList.toggle('hidden');
    document.getElementById('gifPickerContainer').classList.add('hidden');
    document.getElementById('stickerPickerContainer').classList.add('hidden');
}

// 2. GIF Picker (Tenor API)
const TENOR_API_KEY = 'LIVDSRZULELA'; // Standard public test key

function toggleGifPicker() {
    const gifContainer = document.getElementById('gifPickerContainer');
    gifContainer.classList.toggle('hidden');
    document.getElementById('emojiPickerContainer').classList.add('hidden');
    document.getElementById('stickerPickerContainer').classList.add('hidden');

    if (!gifContainer.classList.contains('hidden') && document.getElementById('gifGrid').innerHTML === '') {
        fetchGifs('trending');
    }
}

async function fetchGifs(query) {
    const url = query === 'trending'
        ? `https://g.tenor.com/v1/trending?key=${TENOR_API_KEY}&limit=12`
        : `https://g.tenor.com/v1/search?q=${query}&key=${TENOR_API_KEY}&limit=12`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        const grid = document.getElementById('gifGrid');
        grid.innerHTML = '';

        data.results.forEach(gif => {
            const imgUrl = gif.media[0].tinygif.url;
            const img = document.createElement('img');
            img.src = imgUrl;
            img.className = 'picker-item gif-item';
            img.onclick = () => {
                sendMessage('gif', imgUrl);
                toggleGifPicker();
            };
            grid.appendChild(img);
        });
    } catch (e) { console.error('Error fetching GIFs', e); }
}

let gifTimeout = null;
function searchGifs(event) {
    clearTimeout(gifTimeout);
    gifTimeout = setTimeout(() => {
        const query = event.target.value.trim();
        fetchGifs(query || 'trending');
    }, 500);
}

// 3. Stickers
const STICKERS = [
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f600.png',
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f618.png',
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f4af.png',
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f525.png',
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f44d.png',
    'https://raw.githubusercontent.com/googlefonts/noto-emoji/main/png/512/emoji_u1f389.png'
];

function toggleStickerPicker() {
    const stickerContainer = document.getElementById('stickerPickerContainer');
    stickerContainer.classList.toggle('hidden');
    document.getElementById('emojiPickerContainer').classList.add('hidden');
    document.getElementById('gifPickerContainer').classList.add('hidden');

    const grid = document.getElementById('stickerGrid');
    if (grid.innerHTML === '') {
        STICKERS.forEach(url => {
            const img = document.createElement('img');
            img.src = url;
            img.className = 'picker-item sticker-item';
            img.onclick = () => {
                sendMessage('sticker', url);
                toggleStickerPicker();
            };
            grid.appendChild(img);
        });
    }
}

// 4. Voice Notes
let mediaRecorder;
let audioChunks = [];
let cancelPendingVoice = false;

async function startVoiceRecording() {
    cancelPendingVoice = false;
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];

        mediaRecorder.ondataavailable = event => {
            if (event.data.size > 0) audioChunks.push(event.data);
        };

        mediaRecorder.onstop = async () => {
            if (audioChunks.length === 0 || cancelPendingVoice) return;

            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            // For WebSockets, ArrayBuffer gives maximum compatibility
            const arrayBuffer = await audioBlob.arrayBuffer();

            // Send binary packet (handled seamlessly via Socket.IO Buffer parsing)
            sendMessage('voice', arrayBuffer);

            // Turn off microphone if we aren't in video/audio mode to save user's mic icon state
            if (currentMode === 'text') {
                stream.getTracks().forEach(t => t.stop());
            }
        };

        mediaRecorder.start();
        document.getElementById('recordingIndicator').classList.remove('hidden');
        document.getElementById('voiceBtn').style.background = '#ef4444';

    } catch (err) {
        console.error("Microphone denied", err);
    }
}

function stopVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        document.getElementById('recordingIndicator').classList.add('hidden');
        document.getElementById('voiceBtn').style.background = '';
    }
}

function cancelVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        cancelPendingVoice = true;
        mediaRecorder.stop();
        document.getElementById('recordingIndicator').classList.add('hidden');
        document.getElementById('voiceBtn').style.background = '';
    }
}

// ==========================================
// RECONNECT LOGIC
// ==========================================

let reconnectInterval = null;

function showConnectionToast(partnerName) {
    const toast = document.createElement('div');
    toast.className = 'connection-toast';
    toast.textContent = `Connected to ${partnerName}`;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function showReconnectBanner(partnerName) {
    showConnectionToast(partnerName);

    const banner = document.getElementById('reconnectBanner');
    if (!banner) return;

    const title = document.getElementById('reconnectTitle');
    const timerEl = document.getElementById('reconnectTimer');

    title.textContent = `Reconnect to your last chat with ${partnerName}?`;
    banner.classList.remove('hidden');

    let timeLeft = 60;
    timerEl.textContent = `${timeLeft} seconds`;

    clearInterval(reconnectInterval);
    reconnectInterval = setInterval(() => {
        timeLeft--;
        timerEl.textContent = `${timeLeft} seconds`;
        if (timeLeft <= 0) {
            hideReconnectBanner();
        }
    }, 1000);
}

function hideReconnectBanner() {
    clearInterval(reconnectInterval);
    const banner = document.getElementById('reconnectBanner');
    if (banner) banner.classList.add('hidden');
}

function requestReconnect() {
    if (!currentSessionId) {
        hideReconnectBanner();
        socket.emit('reconnect_request');
        document.getElementById('waitingMessage').textContent = "Attempting to reconnect...";
        showWaitingScreen();
    }
}
