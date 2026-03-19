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
let waitingCountdownInterval = null;
let lastSeenMessageId = null;
let isGuestMode = true;
let activeHubTab = 'match';
let activeCatalogRoom = null;
let roomDirectory = [];
let roomMessagesEl = null;
let roomMessageInput = null;
let roomTypingIndicatorEl = null;
let aiMessagesEl = null;
let selectedAiPersona = 'general';
const aiConversation = [];
const aiPersonaPresets = {
    general: {
        name: 'General Assistant',
        replies: [
            'I can help keep the conversation going. Ask me for ideas, prompts, or quick advice.',
            'Try opening with a specific question about hobbies, travel, or what someone is building right now.',
            'If you want better matches, keep your profile location accurate so country-first routing works well.'
        ]
    },
    joke: {
        name: 'Joke Bot',
        replies: [
            'Why do realtime apps make great friends? They are always in sync.',
            'I told Socket.IO to slow down. It said, "Sorry, I only know how to emit."',
            'Premium glassmorphism means your bugs look stylish while you fix them.'
        ]
    },
    roleplay: {
        name: 'Roleplay AI',
        replies: [
            'The neon city hums around us. I am the concierge of AnonKonnect. Who just entered the lounge?',
            'A private room request blinks on the wall. Do you admit the traveler or keep the door sealed?',
            'You step into a violet-lit chat hub. Describe your character and I will continue the scene.'
        ]
    }
};

// DOM Elements updated to match new HTML
let connectionStatusEl, localVideo, remoteVideo, messagesContainer;
let peerNameEl, peerStatusEl, typingIndicator, messageInput;
let mainContent, joinFormSection, waitingScreen, chatScreen, mediaContainer;

// State flags
let isChatOpen = false;

// Private room state
let isRoomMode = false;
let roomId = null;
let roomParticipants = [];
let roomPeerConnections = new Map();
let pendingInviteCode = null;
let createdRoomId = null;
let roomScreenStream = null;
let isSharingScreen = false;

// Auth state (required)
let auth0Client = null;
let authToken = null;
let authUser = null;

async function initAuth() {
    const cfg = window.AUTH0_CONFIG || {};
    if (!cfg.domain || !cfg.clientId) {
        return false;
    }
    if (!window.auth0 || typeof window.auth0.createAuth0Client !== 'function') {
        return false;
    }
    auth0Client = await window.auth0.createAuth0Client({
        domain: cfg.domain,
        clientId: cfg.clientId,
        authorizationParams: {
            audience: cfg.audience || undefined,
            redirect_uri: cfg.redirectUri || window.location.origin
        },
        cacheLocation: 'localstorage',
        useRefreshTokens: true
    });

    // Handle Auth0 redirect
    const params = new URLSearchParams(window.location.search || '');
    if (params.get('code') && params.get('state')) {
        await auth0Client.handleRedirectCallback();
        window.history.replaceState({}, document.title, window.location.pathname + window.location.hash);
    }

    const isAuthed = await auth0Client.isAuthenticated();
    if (!isAuthed) return false;

    authUser = await auth0Client.getUser();
    authToken = await auth0Client.getTokenSilently().catch(() => null);
    return !!authToken;
}

// Expose login/logout for buttons (called from HTML)
window.login = async function login() {
    if (!auth0Client) await initAuth();
    if (!auth0Client) {
        showConnectionToast('Login is not configured yet.');
        return;
    }
    await auth0Client.loginWithRedirect();
};

window.logout = async function logout() {
    try {
        if (socket) socket.disconnect();
    } catch (e) {}
    authToken = null;
    authUser = null;
    if (auth0Client) {
        auth0Client.logout({ logoutParams: { returnTo: window.location.origin } });
    }
};

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
    roomMessagesEl = document.getElementById('roomMessages');
    roomMessageInput = document.getElementById('roomMessageInput');
    roomTypingIndicatorEl = document.getElementById('roomTypingIndicator');
    aiMessagesEl = document.getElementById('aiMessages');

    // Start with Start button disabled until signaling is connected
    const startBtn = document.getElementById('startChatBtn');
    if (startBtn) startBtn.disabled = true;

    renderAiWelcome();

    (async () => {
        const ok = await initAuth();
        const loginBtn = document.getElementById('loginBtn');
        const logoutBtn = document.getElementById('logoutBtn');
        if (ok) {
            isGuestMode = false;
            if (loginBtn) loginBtn.classList.add('hidden');
            if (logoutBtn) logoutBtn.classList.remove('hidden');
        } else {
            isGuestMode = true;
            if (loginBtn) loginBtn.classList.remove('hidden');
            if (logoutBtn) logoutBtn.classList.add('hidden');
        }
        applyGuestExperience();
        connectToServer();
    })();

    // Deep-link handling: ?mode=text|audio|video → pre-select + scroll to form
    try {
        const params = new URLSearchParams(window.location.search || '');
        const rawMode = (params.get('mode') || '').toLowerCase();
        const allowedModes = ['text', 'audio', 'video'];
        if (allowedModes.includes(rawMode) && typeof scrollToForm === 'function') {
            // Defer slightly to ensure layout is ready before scrolling
            setTimeout(() => {
                scrollToForm(rawMode);
            }, 0);
        }
    } catch (e) {
        console.warn('[CLIENT] Failed to apply mode deep-link:', e);
    }

    // Keep marketing \"Designed for Connection\" video card time in sync with user's local clock
    try {
        const timerEls = document.querySelectorAll('.video-timer');
        if (timerEls.length) {
            const updateClock = () => {
                const now = new Date();
                const hours = now.getHours().toString().padStart(2, '0');
                const minutes = now.getMinutes().toString().padStart(2, '0');
                timerEls.forEach(el => el.textContent = `${hours}:${minutes}`);
            };
            updateClock();
            setInterval(updateClock, 60 * 1000);
        }
    } catch (e) {
        console.warn('[CLIENT] Failed to update preview video clock:', e);
    }
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
    applyGuestExperience();
}

function hideAllScreens() {
    mainContent.classList.add('hidden');
    waitingScreen.classList.add('hidden');
    chatScreen.classList.add('hidden');
}

function applyGuestExperience() {
    const roomOverlay = document.getElementById('roomGuestOverlay');
    const directOverlay = document.getElementById('directGuestOverlay');
    if (roomOverlay) roomOverlay.classList.toggle('hidden', !isGuestMode);
    if (directOverlay) directOverlay.classList.toggle('hidden', !isGuestMode);
}

function switchHubTab(tabName) {
    activeHubTab = tabName;
    document.querySelectorAll('.platform-tab').forEach((tab) => {
        tab.classList.toggle('active', tab.getAttribute('data-tab') === tabName);
    });
    document.getElementById('hubPanelMatch')?.classList.toggle('hidden', tabName !== 'match');
    document.getElementById('hubPanelRooms')?.classList.toggle('hidden', tabName !== 'rooms');
    document.getElementById('hubPanelAi')?.classList.toggle('hidden', tabName !== 'ai');
}

function renderRoomDirectory() {
    const container = document.getElementById('roomsDirectory');
    if (!container) return;

    container.innerHTML = '';
    roomDirectory.forEach((room) => {
        const card = document.createElement('div');
        card.className = `room-card ${isGuestMode ? 'room-card-blurred' : ''}`;
        card.innerHTML = `
            <div class="room-card-top">
                <span class="room-badge">${escapeHtml(room.label || room.category || 'Room')}</span>
                <span class="room-count">${room.memberCount || 0} online</span>
            </div>
            <h4>${escapeHtml(room.name || 'Room')}</h4>
            <p>${escapeHtml(room.description || '')}</p>
            <button class="btn btn-primary" type="button">Join room</button>
        `;
        card.querySelector('button').addEventListener('click', () => joinPublicRoom(room.id));
        container.appendChild(card);
    });
}

function renderActiveRoomHeader(room, members) {
    const title = document.getElementById('activeRoomTitle');
    const meta = document.getElementById('activeRoomMeta');
    if (!room) {
        if (title) title.textContent = 'No room selected';
        if (meta) meta.textContent = 'Join a public room or request access to a hidden one.';
        return;
    }
    if (title) title.textContent = isGuestMode ? 'Premium room' : room.name;
    if (meta) meta.textContent = isGuestMode
        ? 'Login to reveal room details and member names.'
        : `${members.length} members online${room.slug ? ` • ${room.slug}` : ''}`;
}

function renderRoomMessages(messages) {
    if (!roomMessagesEl) return;
    roomMessagesEl.innerHTML = '';
    messages.forEach((message) => appendRoomMessage(message, message.authorId === userId ? 'sent' : 'received'));
}

function appendRoomSystemMessage(text) {
    if (!roomMessagesEl) return;
    const item = document.createElement('div');
    item.className = 'system-message info';
    item.textContent = text;
    roomMessagesEl.appendChild(item);
    roomMessagesEl.scrollTop = roomMessagesEl.scrollHeight;
}

function appendRoomMessage(message, direction) {
    if (!roomMessagesEl) return;
    const item = document.createElement('div');
    item.className = `message ${direction}${isGuestMode ? ' blurred-message' : ''}`;
    item.innerHTML = `
        <div class="message-author">${escapeHtml(message.authorName || 'Member')}</div>
        <div class="message-content">${escapeHtml(message.text || '')}</div>
        <div class="message-time">${new Date(message.createdAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
    `;
    roomMessagesEl.appendChild(item);
    roomMessagesEl.scrollTop = roomMessagesEl.scrollHeight;
}

function setRoomStatus(text) {
    const status = document.getElementById('roomDirectoryStatus');
    if (status) status.textContent = text;
}

function refreshRoomDirectory() {
    if (socket && socket.connected) socket.emit('rooms:list');
}

function joinPublicRoom(roomIdToJoin) {
    if (!socket || !socket.connected) return;
    if (activeCatalogRoom && activeCatalogRoom.id && activeCatalogRoom.id !== roomIdToJoin) {
        socket.emit('leave_catalog_room', { roomId: activeCatalogRoom.id });
    }
    socket.emit('join_public_room', { roomId: roomIdToJoin, profile: userPreferences });
}

function createHiddenRoom() {
    if (isGuestMode) {
        setRoomStatus('Login to create hidden private rooms.');
        return;
    }
    const name = document.getElementById('hiddenRoomName')?.value || '';
    const slug = document.getElementById('hiddenRoomSlug')?.value || '';
    socket.emit('create_hidden_room', {
        name,
        slug,
        profile: userPreferences
    });
}

function requestPrivateRoomAccess() {
    if (isGuestMode) {
        setRoomStatus('Login to request private room access.');
        return;
    }
    const slug = document.getElementById('privateAccessSlug')?.value || '';
    socket.emit('request_private_room_access', {
        slug,
        profile: userPreferences
    });
}

function sendRoomMessage() {
    if (!socket || !socket.connected || !activeCatalogRoom || !roomMessageInput) return;
    const text = roomMessageInput.value.trim();
    if (!text) return;
    socket.emit('catalog_room_message', {
        roomId: activeCatalogRoom.id,
        text
    });
    roomMessageInput.value = '';
}

function handleRoomMessageKeyPress(event) {
    if (event.key === 'Enter') {
        sendRoomMessage();
        return;
    }
    if (socket && socket.connected && activeCatalogRoom) {
        socket.emit('catalog_room_typing', {
            roomId: activeCatalogRoom.id,
            isTyping: true
        });
        clearTimeout(window.roomTypingTimeout);
        window.roomTypingTimeout = setTimeout(() => {
            socket.emit('catalog_room_typing', {
                roomId: activeCatalogRoom.id,
                isTyping: false
            });
        }, 1200);
    }
}

function renderAiWelcome() {
    if (!aiMessagesEl) return;
    aiMessagesEl.innerHTML = '';
    appendAiMessage('assistant', `You are chatting with ${aiPersonaPresets[selectedAiPersona].name}.`);
}

function appendAiMessage(role, text) {
    if (!aiMessagesEl) return;
    const item = document.createElement('div');
    item.className = `message ${role === 'assistant' ? 'received' : 'sent'}`;
    item.innerHTML = `<div class="message-content">${escapeHtml(text)}</div>`;
    aiMessagesEl.appendChild(item);
    aiMessagesEl.scrollTop = aiMessagesEl.scrollHeight;
}

function selectAiPersona(persona) {
    selectedAiPersona = persona;
    document.querySelectorAll('.ai-persona').forEach((button) => {
        button.classList.toggle('active', button.getAttribute('data-persona') === persona);
    });
    renderAiWelcome();
}

function sendAiMessage() {
    const input = document.getElementById('aiMessageInput');
    if (!input) return;
    const text = input.value.trim();
    if (!text) return;
    aiConversation.push({ role: 'user', text });
    appendAiMessage('user', text);
    input.value = '';

    const preset = aiPersonaPresets[selectedAiPersona];
    const seed = (text.length + aiConversation.length) % preset.replies.length;
    window.setTimeout(() => {
        appendAiMessage('assistant', preset.replies[seed]);
    }, 400);
}

function handleAiKeyPress(event) {
    if (event.key === 'Enter') sendAiMessage();
}

// Server connection
function connectToServer() {
    // Safety: Verify Socket.IO client loaded from CDN
    if (typeof io === 'undefined') {
        console.error('[CLIENT] FATAL: Socket.IO client library not loaded. Check CDN script tag.');
        alert('Failed to load networking library. Please refresh the page.');
        return;
    }

    // Dynamically determine signaling server URL
    // LOCAL: http://localhost:3000
    // PRODUCTION: Your persistent server URL (Render, Railway, etc.)
    const signalingUrl = (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
        ? 'http://localhost:3000'
        : 'https://anonkonnect.onrender.com'; // Replace with your actual Render URL

    // #region agent log
    const _hostname = window.location.hostname;
    const _origin = window.location.origin;
    fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:connectToServer', message: 'signaling connection attempt', data: { signalingUrl, hostname: _hostname, origin: _origin }, timestamp: Date.now(), hypothesisId: 'H4' }) }).catch(() => { });
    // #endregion

    console.log(`[CLIENT] Connecting to signaling server: ${signalingUrl}`);
    socket = io(signalingUrl, {
        transports: ['polling', 'websocket'], // Try polling first (works when WebSocket is blocked e.g. Render/proxy)
        reconnection: true,
        reconnectionAttempts: 15,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 45000, // Allow time for Render cold start (~30–60s on free tier)
        auth: {
            token: authToken || null
        }
    });

    socket.on('connect', () => {
        // #region agent log
        fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:connect', message: 'signaling connected', data: {}, timestamp: Date.now(), hypothesisId: 'H1' }) }).catch(() => { });
        // #endregion
        console.log('[CLIENT] Connected to signaling server');
        updateConnectionStatus(true);
        socket.emit('rooms:list');
    });

    socket.on('connected', (data) => {
        userId = data.userId;
        console.log('[CLIENT] Assigned User ID:', userId);
    });

    socket.on('connect_error', (err) => {
        // #region agent log
        fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:connect_error', message: 'signaling connect_error', data: { message: err?.message || String(err), type: err?.type }, timestamp: Date.now(), hypothesisId: 'H5' }) }).catch(() => { });
        // #endregion
        console.error('[CLIENT] Signaling connect_error:', err?.message || err);
        updateConnectionStatus(false, 'Connection failed – retrying…');
    });
    socket.on('disconnect', (reason) => {
        // #region agent log
        fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:disconnect', message: 'signaling disconnected', data: { reason: reason || 'unknown' }, timestamp: Date.now(), hypothesisId: 'H3' }) }).catch(() => { });
        // #endregion
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
    socket.on('queue-update', handleQueueUpdate);
    socket.on('message-seen', handleMessageSeen);

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

    socket.on('room_created', (data) => {
        createdRoomId = data.roomId || data.code;
        const el = document.getElementById('privateRoomCreated');
        const codeEl = document.getElementById('privateRoomCodeDisplay');
        if (el && codeEl) {
            codeEl.textContent = data.code || data.roomId;
            el.classList.remove('hidden');
        }
        document.getElementById('privateRoomError').classList.add('hidden');
    });

    socket.on('room_joined', (data) => {
        handleRoomJoined(data);
    });

    socket.on('room_error', (data) => {
        const errEl = document.getElementById('privateRoomError');
        if (errEl) {
            errEl.textContent = data.message || 'Room error';
            errEl.classList.remove('hidden');
        }
    });

    socket.on('rooms:list', (data) => {
        roomDirectory = data.publicRooms || [];
        renderRoomDirectory();
    });

    socket.on('room:joined', (data) => {
        activeCatalogRoom = data.room;
        renderActiveRoomHeader(data.room, data.members || []);
        renderRoomMessages(data.messages || []);
        setRoomStatus(`Joined ${data.room.name}.`);
        switchHubTab('rooms');
    });

    socket.on('room:left', () => {
        activeCatalogRoom = null;
        renderActiveRoomHeader(null, []);
        renderRoomMessages([]);
        setRoomStatus('You left the room.');
    });

    socket.on('room:members', (data) => {
        if (activeCatalogRoom && data.roomId === activeCatalogRoom.id) {
            renderActiveRoomHeader(activeCatalogRoom, data.members || []);
        }
    });

    socket.on('room:message', (data) => {
        if (!activeCatalogRoom || data.roomId !== activeCatalogRoom.id) return;
        appendRoomMessage(data.message, data.message.authorId === userId ? 'sent' : 'received');
    });

    socket.on('room:system', (data) => {
        if (!activeCatalogRoom || data.roomId !== activeCatalogRoom.id) return;
        appendRoomSystemMessage(data.text);
    });

    socket.on('room:typing', (data) => {
        if (!activeCatalogRoom || data.roomId !== activeCatalogRoom.id || !roomTypingIndicatorEl) return;
        roomTypingIndicatorEl.textContent = data.isTyping ? `${data.nickname} is typing...` : '';
    });

    socket.on('room:error', (data) => {
        setRoomStatus(data.message || 'Room action failed.');
    });

    socket.on('room:request-pending', (data) => {
        setRoomStatus(`Access request sent to ${data.roomName}.`);
    });

    socket.on('room:request-response', (data) => {
        setRoomStatus(data.admitted ? `Access granted for ${data.roomName}.` : `Access declined for ${data.roomName}.`);
    });

    socket.on('room:access-request', (data) => {
        const requesterName = data.requester?.nickname || 'User';
        const approve = window.confirm(`User ${requesterName} wants to join ${data.roomName}. Admit?`);
        socket.emit('respond_private_room_request', {
            requestId: data.requestId,
            admit: approve
        });
    });

    socket.on('private-room:created', (data) => {
        const slug = data.room?.slug || 'private room';
        setRoomStatus(`Hidden room created. Share slug: ${slug}`);
        socket.emit('rooms:list');
    });

    socket.on('participant_joined', (data) => {
        const newId = data.socketId;
        if (isRoomMode && roomId) {
            if (!roomPeerConnections.has(newId)) {
                handleRoomNewParticipant(newId, data.preferences || {});
            }
            if (data.participants) roomParticipants = data.participants;
            return;
        }
        if (createdRoomId && data.participants) {
            roomId = createdRoomId;
            roomParticipants = data.participants;
            isRoomMode = true;
            createdRoomId = null;
            const mode = currentMode;
            (async () => {
                if (mode === 'video' || mode === 'audio') {
                    try {
                        const constraints = { audio: true, video: mode === 'video' };
                        localStream = await navigator.mediaDevices.getUserMedia(constraints);
                        if (mode === 'video' && localVideo) {
                            localVideo.srcObject = localStream;
                            localVideo.onloadedmetadata = () => localVideo.play().catch(() => {});
                        }
                    } catch (e) {
                        console.error('Media error:', e);
                        alert('Please allow camera/microphone to join.');
                        return;
                    }
                }
                await enterRoomCallView(roomId, roomParticipants, mode);
                await handleRoomNewParticipant(newId, data.preferences || {});
            })();
        }
    });

    socket.on('participant_left', (data) => {
        if (roomId && data.socketId) {
            const pc = roomPeerConnections.get(data.socketId);
            if (pc) {
                pc.close();
                roomPeerConnections.delete(data.socketId);
            }
            if (data.participants) roomParticipants = data.participants;
        }
    });

    socket.on('private_room_invite', (data) => {
        pendingInviteCode = data.code;
        const modal = document.getElementById('privateRoomInviteModal');
        const msgEl = document.getElementById('privateRoomInviteMessage');
        const codeEl = document.getElementById('privateRoomInviteCode');
        if (modal && msgEl && codeEl) {
            msgEl.textContent = data.message || 'You both have the same code. You can join this private call anytime using this ID. Max 4 people.';
            codeEl.textContent = data.code || '';
            modal.classList.remove('hidden');
        }
    });

    socket.on('room-offer', handleRoomOffer);
    socket.on('room-answer', handleRoomAnswer);
    socket.on('room-ice-candidate', handleRoomIceCandidate);
    socket.on('room-chat-message', handleRoomChatMessage);
    socket.on('room-typing', handleRoomTyping);
    socket.on('room_mode_switched', handleRoomModeSwitched);
}

function createPrivateRoom() {
    if (!socket || !socket.connected) {
        alert('Not connected. Please try again.');
        return;
    }
    const choiceEl = document.getElementById('privateRoomModeChoice');
    if (choiceEl) {
        choiceEl.classList.remove('hidden');
    }
}

function closePrivateRoomModeChoice() {
    const choiceEl = document.getElementById('privateRoomModeChoice');
    if (choiceEl) choiceEl.classList.add('hidden');
}

function createPrivateRoomWithMode(mode) {
    if (!socket || !socket.connected) return;
    closePrivateRoomModeChoice();
    currentMode = mode;
    userPreferences = {
        nickname: document.getElementById('nickname').value || 'Stranger',
        gender: document.getElementById('gender').value || 'unspecified',
        purpose: document.getElementById('purpose').value || 'chat',
        country: document.getElementById('country').value || '',
        state: document.getElementById('state').value || '',
        city: document.getElementById('city').value || ''
    };
    socket.emit('create_private_room', { mode, preferences: userPreferences });
}

function joinPrivateRoom() {
    if (!socket || !socket.connected) {
        alert('Not connected. Please try again.');
        return;
    }
    const input = document.getElementById('privateRoomCode');
    const code = (input && input.value || '').trim().toUpperCase();
    if (!code) {
        const errEl = document.getElementById('privateRoomError');
        if (errEl) { errEl.textContent = 'Enter a room code'; errEl.classList.remove('hidden'); }
        return;
    }
    userPreferences = {
        nickname: document.getElementById('nickname').value || 'Stranger',
        gender: document.getElementById('gender').value || 'unspecified',
        purpose: document.getElementById('purpose').value || 'chat',
        country: document.getElementById('country').value || '',
        state: document.getElementById('state').value || '',
        city: document.getElementById('city').value || ''
    };
    document.getElementById('privateRoomError').classList.add('hidden');
    socket.emit('join_private_room', { code, preferences: userPreferences });
}

function copyRoomCode() {
    const el = document.getElementById('privateRoomCodeDisplay');
    if (el && el.textContent) {
        navigator.clipboard.writeText(el.textContent).then(() => showConnectionToast('Code copied!')).catch(() => {});
    }
}

function createPrivateRoomFromCall() {
    if (!socket || !socket.connected || !currentPeerId || !currentSessionId) return;
    socket.emit('create_private_room', {
        mode: currentMode,
        preferences: userPreferences,
        fromCall: true,
        peerId: currentPeerId
    });
}

function copyInviteRoomCode() {
    if (pendingInviteCode) {
        navigator.clipboard.writeText(pendingInviteCode).then(() => showConnectionToast('Code copied!')).catch(() => {});
    }
}

function closePrivateRoomInviteModal() {
    const modal = document.getElementById('privateRoomInviteModal');
    if (modal) modal.classList.add('hidden');
    pendingInviteCode = null;
}

async function handleRoomJoined(data) {
    roomId = data.roomId || data.code;
    roomParticipants = data.participants || [];
    isRoomMode = true;
    currentMode = data.mode || 'text';
    const others = roomParticipants.filter(p => p.id !== socket.id);
    if (others.length === 0) {
        showChatScreen();
        applyRoomLayout(currentMode);
        return;
    }
    if (currentMode === 'video' || currentMode === 'audio') {
        try {
            const constraints = { audio: true, video: currentMode === 'video' };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            if (currentMode === 'video' && localVideo) {
                localVideo.srcObject = localStream;
                localVideo.onloadedmetadata = () => localVideo.play().catch(() => {});
            }
        } catch (e) {
            console.error('Media error:', e);
            alert('Please allow camera/microphone to join.');
            return;
        }
    }
    await enterRoomCallView(roomId, roomParticipants, currentMode);
    for (const p of others) {
        await handleRoomNewParticipant(p.id, p.preferences || {});
    }
}

async function enterRoomCallView(rId, participants, mode) {
    currentSessionId = rId;
    const chatLayout = document.querySelector('.chat-layout');
    const mediaContainer = document.getElementById('mediaContainer');
    const chatContainer = document.getElementById('chatContainer');
    const sessionTopBar = document.getElementById('sessionTopBar');
    const sessionTopBarPeerName = document.getElementById('sessionTopBarPeerName');
    const roomModeSwitchEl = document.getElementById('roomModeSwitch');
    const screenShareBtn = document.getElementById('toggleScreenShareBtn');
    if (chatLayout) {
        chatLayout.classList.remove('text-mode', 'audio-mode', 'video-mode');
        chatLayout.classList.add(`${mode}-mode`);
    }
    if (mode === 'video' || mode === 'audio') {
        if (mediaContainer) mediaContainer.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('has-media');
        if (chatContainer) chatContainer.classList.add('chat-collapsed');
        isChatOpen = false;
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        if (sessionTopBarPeerName) sessionTopBarPeerName.textContent = 'Private room (' + participants.length + ')';
    } else {
        if (mediaContainer) mediaContainer.classList.add('hidden');
        if (chatLayout) chatLayout.classList.remove('has-media');
        if (chatContainer) chatContainer.classList.remove('chat-collapsed');
        if (sessionTopBar) sessionTopBar.classList.add('hidden');
    }
    if (isRoomMode && sessionTopBar) sessionTopBar.classList.remove('hidden');
    if (isRoomMode && sessionTopBarPeerName) sessionTopBarPeerName.textContent = 'Private room (' + participants.length + ')';
    if (roomModeSwitchEl) roomModeSwitchEl.classList.toggle('hidden', !isRoomMode);
    if (screenShareBtn) screenShareBtn.style.display = isRoomMode ? '' : 'none';
    updateRoomModeSwitchActive(mode);
    const toolMic = document.getElementById('tool-mic');
    const toolCam = document.getElementById('tool-cam');
    const toolChat = document.getElementById('tool-chat');
    const toolChatBtn = document.getElementById('chatToggleBtn');
    if (mode === 'text') {
        if (toolMic) toolMic.style.display = 'none';
        if (toolCam) toolCam.style.display = 'none';
        if (toolChat) toolChat.style.display = isRoomMode ? '' : 'none';
        if (toolChatBtn) toolChatBtn.style.display = isRoomMode ? '' : 'none';
    } else {
        if (toolMic) toolMic.style.display = '';
        if (toolCam) toolCam.style.display = mode === 'video' ? '' : 'none';
        if (toolChat) toolChat.style.display = '';
        if (toolChatBtn) toolChatBtn.style.display = '';
    }
    const createPrivateBtn = document.getElementById('createPrivateRoomInCallBtn');
    if (createPrivateBtn) createPrivateBtn.style.display = 'none';
    showChatScreen();
}

function updateRoomModeSwitchActive(mode) {
    document.querySelectorAll('.room-mode-switch .btn-mode').forEach(btn => {
        btn.classList.toggle('active', (btn.getAttribute('data-mode') || '') === mode);
    });
}

function switchRoomMode(mode) {
    if (!isRoomMode || !roomId || mode === currentMode) return;
    if (!socket || !socket.connected) return;
    socket.emit('room_switch_mode', { roomId, mode });
}

async function handleRoomModeSwitched(data) {
    const mode = data.mode || 'text';
    if (mode === currentMode) return;
    const prevMode = currentMode;
    currentMode = mode;
    updateRoomModeSwitchActive(mode);
    const chatLayout = document.querySelector('.chat-layout');
    const mediaContainer = document.getElementById('mediaContainer');
    const chatContainer = document.getElementById('chatContainer');
    const sessionTopBar = document.getElementById('sessionTopBar');
    const sessionTopBarPeerName = document.getElementById('sessionTopBarPeerName');
    if (chatLayout) {
        chatLayout.classList.remove('text-mode', 'audio-mode', 'video-mode');
        chatLayout.classList.add(`${mode}-mode`);
    }
    if (mode === 'video' || mode === 'audio') {
        if (mediaContainer) mediaContainer.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('has-media');
        if (chatContainer) chatContainer.classList.add('chat-collapsed');
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        if (sessionTopBarPeerName) sessionTopBarPeerName.textContent = 'Private room (' + (roomParticipants.length || 0) + ')';
        try {
            const constraints = { audio: true, video: mode === 'video' };
            localStream = await navigator.mediaDevices.getUserMedia(constraints);
            if (localStream && mode === 'video' && localVideo) {
                localVideo.srcObject = localStream;
                localVideo.onloadedmetadata = () => localVideo.play().catch(() => {});
            }
            roomPeerConnections.forEach((pc) => {
                if (localStream) {
                    pc.getSenders().forEach(s => { if (s.track) pc.removeTrack(s); });
                    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
                }
            });
            for (const [peerId, pc] of roomPeerConnections) {
                try {
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    socket.emit('room-offer', { to: peerId, offer: pc.localDescription, roomId });
                } catch (e) { console.error('Renegotiate offer error:', e); }
            }
        } catch (e) {
            console.error('Media error on mode switch:', e);
            currentMode = prevMode;
            updateRoomModeSwitchActive(prevMode);
        }
    } else {
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }
        if (localVideo && localVideo.srcObject) localVideo.srcObject = null;
        if (mediaContainer) mediaContainer.classList.add('hidden');
        if (chatLayout) chatLayout.classList.remove('has-media');
        if (chatContainer) chatContainer.classList.remove('chat-collapsed');
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        roomPeerConnections.forEach((pc) => {
            pc.getSenders().forEach(s => { if (s.track) pc.removeTrack(s); });
        });
        for (const [peerId, pc] of roomPeerConnections) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('room-offer', { to: peerId, offer: pc.localDescription, roomId });
            } catch (e) { console.error('Renegotiate offer error:', e); }
        }
    }
    const toolMic = document.getElementById('tool-mic');
    const toolCam = document.getElementById('tool-cam');
    const toolChat = document.getElementById('tool-chat');
    const toolChatBtn = document.getElementById('chatToggleBtn');
    if (mode === 'text') {
        if (toolMic) toolMic.style.display = 'none';
        if (toolCam) toolCam.style.display = 'none';
        if (toolChat) toolChat.style.display = '';
        if (toolChatBtn) toolChatBtn.style.display = '';
    } else {
        if (toolMic) toolMic.style.display = '';
        if (toolCam) toolCam.style.display = mode === 'video' ? '' : 'none';
        if (toolChat) toolChat.style.display = '';
        if (toolChatBtn) toolChatBtn.style.display = '';
    }
}

function applyRoomLayout(mode) {
    const chatLayout = document.querySelector('.chat-layout');
    const mediaContainer = document.getElementById('mediaContainer');
    const chatContainer = document.getElementById('chatContainer');
    if (mode === 'video' || mode === 'audio') {
        if (mediaContainer) mediaContainer.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('has-media');
        if (chatContainer) chatContainer.classList.add('chat-collapsed');
    }
}

const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }], iceCandidatePoolSize: 10 };

async function handleRoomNewParticipant(peerSocketId, preferences) {
    if (roomPeerConnections.has(peerSocketId)) return;
    const pc = new RTCPeerConnection(ICE_SERVERS);
    roomPeerConnections.set(peerSocketId, pc);
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    if (roomScreenStream) {
        roomScreenStream.getTracks().forEach(track => pc.addTrack(track, roomScreenStream));
    }
    pc.ontrack = (e) => {
        const track = e.track;
        const stream = e.streams[0];
        const isScreen = track.kind === 'video' && track.label && track.label.toLowerCase().includes('screen');
        if (isScreen && stream) {
            const remoteScreenEl = document.getElementById('remoteScreen');
            const container = document.getElementById('remoteScreenContainer');
            if (remoteScreenEl && container) {
                remoteScreenEl.srcObject = stream;
                remoteScreenEl.play().catch(() => {});
                container.classList.remove('hidden');
            }
        } else if (stream) {
            if (remoteVideo && track.kind === 'video') {
                remoteVideo.srcObject = stream;
                remoteVideo.play().catch(() => {});
            }
            const remoteAudioEl = document.getElementById('remoteAudio');
            if (remoteAudioEl && track.kind === 'audio') {
                remoteAudioEl.srcObject = stream;
                remoteAudioEl.play().catch(() => {});
            }
            const overlay = document.getElementById('remoteMediaState');
            if (overlay) overlay.style.display = 'none';
        }
    };
    pc.onicecandidate = (e) => {
        if (e.candidate) {
            socket.emit('room-ice-candidate', { to: peerSocketId, candidate: e.candidate, roomId });
        }
    };
    try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('room-offer', { to: peerSocketId, offer: pc.localDescription, roomId });
    } catch (err) {
        console.error('Room offer error:', err);
    }
}

async function handleRoomOffer(data) {
    const { from, offer } = data;
    let pc = roomPeerConnections.get(from);
    if (!pc) {
        pc = new RTCPeerConnection(ICE_SERVERS);
        roomPeerConnections.set(from, pc);
        if (localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
        if (roomScreenStream) roomScreenStream.getTracks().forEach(track => pc.addTrack(track, roomScreenStream));
        pc.ontrack = (e) => {
            const track = e.track;
            const stream = e.streams[0];
            const isScreen = track.kind === 'video' && track.label && track.label.toLowerCase().includes('screen');
            if (isScreen && stream) {
                const remoteScreenEl = document.getElementById('remoteScreen');
                const container = document.getElementById('remoteScreenContainer');
                if (remoteScreenEl && container) {
                    remoteScreenEl.srcObject = stream;
                    remoteScreenEl.play().catch(() => {});
                    container.classList.remove('hidden');
                }
            } else if (stream) {
                if (remoteVideo && track.kind === 'video') {
                    remoteVideo.srcObject = stream;
                    remoteVideo.play().catch(() => {});
                }
                const remoteAudioEl = document.getElementById('remoteAudio');
                if (remoteAudioEl && track.kind === 'audio') {
                    remoteAudioEl.srcObject = stream;
                    remoteAudioEl.play().catch(() => {});
                }
                const overlay = document.getElementById('remoteMediaState');
                if (overlay) overlay.style.display = 'none';
            }
        };
        pc.onicecandidate = (e) => {
            if (e.candidate) socket.emit('room-ice-candidate', { to: from, candidate: e.candidate, roomId });
        };
    }
    try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('room-answer', { to: from, answer: pc.localDescription, roomId });
    } catch (err) {
        console.error('Room answer error:', err);
    }
}

async function handleRoomAnswer(data) {
    const { from, answer } = data;
    const pc = roomPeerConnections.get(from);
    if (pc) {
        try {
            await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
            console.error('Room setRemoteDescription error:', err);
        }
    }
}

async function handleRoomIceCandidate(data) {
    const { from, candidate } = data;
    const pc = roomPeerConnections.get(from);
    if (pc && candidate) {
        try {
            await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.error('Room addIceCandidate error:', err);
        }
    }
}

async function toggleRoomScreenShare() {
    if (!isRoomMode || !roomId) return;
    const btn = document.getElementById('toggleScreenShareBtn');
    if (isSharingScreen) {
        if (roomScreenStream) {
            roomScreenStream.getTracks().forEach(t => t.stop());
            roomScreenStream = null;
        }
        isSharingScreen = false;
        if (btn) {
            btn.innerHTML = '<i class="ph ph-monitor"></i> Share screen';
            btn.classList.remove('danger');
        }
        roomPeerConnections.forEach((pc, peerId) => {
            pc.getSenders().forEach(sender => {
                if (sender.track && sender.track.label && sender.track.label.toLowerCase().includes('screen')) {
                    pc.removeTrack(sender);
                }
            });
        });
        for (const [peerId, pc] of roomPeerConnections) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('room-offer', { to: peerId, offer: pc.localDescription, roomId });
            } catch (e) { console.error('Screen share renegotiate error:', e); }
        }
        const container = document.getElementById('remoteScreenContainer');
        if (container) container.classList.add('hidden');
        const remoteScreenEl = document.getElementById('remoteScreen');
        if (remoteScreenEl) remoteScreenEl.srcObject = null;
        return;
    }
    try {
        roomScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        isSharingScreen = true;
        if (btn) {
            btn.innerHTML = '<i class="ph ph-monitor-slash"></i> Stop share';
            btn.classList.add('danger');
        }
        roomPeerConnections.forEach((pc) => {
            roomScreenStream.getTracks().forEach(track => pc.addTrack(track, roomScreenStream));
        });
        for (const [peerId, pc] of roomPeerConnections) {
            try {
                const offer = await pc.createOffer();
                await pc.setLocalDescription(offer);
                socket.emit('room-offer', { to: peerId, offer: pc.localDescription, roomId });
            } catch (e) { console.error('Screen share offer error:', e); }
        }
        roomScreenStream.getTracks()[0].onended = () => toggleRoomScreenShare();
    } catch (e) {
        console.error('getDisplayMedia error:', e);
        if (btn) btn.innerHTML = '<i class="ph ph-monitor"></i> Share screen';
    }
}

function handleRoomChatMessage(data) {
    displayMessage(data.message, 'received');
}

function handleRoomTyping(data) {
    if (typingIndicator) {
        typingIndicator.textContent = data.isTyping ? 'Someone is typing...' : '';
    }
}

function updateConnectionStatus(connected, disconnectMessage) {
    const statusEl = document.getElementById('connectionStatus');
    const startBtn = document.getElementById('startChatBtn');
    if (connected) {
        statusEl.classList.add('connected');
        statusEl.innerHTML = '<span class="dot"></span> Connected';
        if (startBtn) startBtn.disabled = false;
    } else {
        statusEl.classList.remove('connected');
        statusEl.innerHTML = '<span class="dot"></span> ' + (disconnectMessage || 'Disconnected');
        if (startBtn) startBtn.disabled = true;
    }
}

// User info form handler
function handleInfoSubmit(event) {
    event.preventDefault();

    userPreferences = {
        nickname: document.getElementById('nickname').value || 'Stranger',
        gender: document.getElementById('gender').value || 'unspecified',
        purpose: document.getElementById('purpose').value || 'chat',
        country: document.getElementById('country').value || '',
        state: document.getElementById('state').value || '',
        city: document.getElementById('city').value || ''
    };

    const mode = document.getElementById('selectedMode').value;
    if (!mode) {
        alert("Please select a connection mode.");
        return;
    }

    currentMode = mode;

    // #region agent log
    const _hasSocket = !!socket;
    const _connected = socket ? !!socket.connected : false;
    const _timeSinceLoad = typeof performance !== 'undefined' && performance.timing ? Date.now() - performance.timing.navigationStart : -1;
    fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:handleInfoSubmit', message: 'submit connection check', data: { hasSocket: _hasSocket, socketConnected: _connected, timeSinceLoadMs: _timeSinceLoad }, timestamp: Date.now(), hypothesisId: 'H2' }) }).catch(() => { });
    // #endregion

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

    // Enable submit button only when signaling is connected
    const startBtn = document.getElementById('startChatBtn');
    if (startBtn) startBtn.disabled = !(socket && socket.connected);
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
    const waitingMessageEl = document.getElementById('waitingMessage');
    const waitingTextEl = document.getElementById('waitingText');
    const queueInfoEl = document.getElementById('queueInfo');
    const searchScopeEl = document.getElementById('searchScope');
    const searchTimerEl = document.getElementById('searchTimer');

    if (waitingMessageEl) waitingMessageEl.textContent = data.message || 'Searching for your best match...';
    if (waitingTextEl) waitingTextEl.textContent = `Searching for matches in ${data.country || 'your country'}...`;
    if (queueInfoEl) queueInfoEl.textContent = `Queue position ${data.position || 1} of ${data.totalInQueue || 1}`;
    if (searchScopeEl) searchScopeEl.textContent = data.scopeLabel || 'same country';

    if (waitingCountdownInterval) {
        clearInterval(waitingCountdownInterval);
        waitingCountdownInterval = null;
    }

    if (searchTimerEl) {
        const updateCountdown = () => {
            const nextMs = Math.max(0, Number(data.nextExpandInMs || 0) - ((Date.now() - startAt)));
            searchTimerEl.textContent = nextMs > 0 ? `${Math.ceil(nextMs / 1000)}s` : 'live';
        };
        const startAt = Date.now();
        updateCountdown();
        if ((data.nextExpandInMs || 0) > 0) {
            waitingCountdownInterval = setInterval(updateCountdown, 1000);
        }
    }
}

// Match found
async function handleMatchFound(data) {
    console.log('Match found!', data);

    currentSessionId = data.sessionId;
    currentPeerId = data.peerId;

    // Start call timer
    window.__anonCallStartedAt = Date.now();
    startSessionTimer();

    if (peerNameEl) {
        peerNameEl.textContent = data.peerPreferences?.nickname || 'Stranger';
    }

    // Initialize WebRTC connection
    await initializeWebRTC(data);

    // Show media container for non-text modes
    const mediaContainer = document.getElementById('mediaContainer');
    const chatLayout = document.querySelector('.chat-layout');
    const chatContainer = document.getElementById('chatContainer');

    // ISSUE 3 FIX: Apply mode class to layout for CSS targeting
    if (chatLayout) {
        chatLayout.classList.remove('text-mode', 'audio-mode', 'video-mode');
        chatLayout.classList.add(`${data.mode}-mode`);
    }

    const sessionTopBar = document.getElementById('sessionTopBar');
    const sessionTopBarPeerName = document.getElementById('sessionTopBarPeerName');

    if (data.mode === 'video' || data.mode === 'audio') {
        mediaContainer.classList.remove('hidden');
        chatLayout.classList.add('has-media');
        chatContainer.classList.add('chat-collapsed');
        isChatOpen = false;
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        if (sessionTopBarPeerName) sessionTopBarPeerName.textContent = data.peerPreferences?.nickname || 'Stranger';

        if (data.mode === 'audio') {
            document.querySelectorAll('.video-wrapper').forEach(el => el.style.background = '#2d3748');
        }

        // Reset overlay for new session
        const overlay = document.getElementById('remoteMediaState');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.textContent = 'Waiting for partner...';
        }
    } else {
        mediaContainer.classList.add('hidden');
        chatLayout.classList.remove('has-media');
        chatContainer.classList.remove('chat-collapsed');
        if (sessionTopBar) sessionTopBar.classList.add('hidden');
    }

    // ISSUE 3 FIX: Show/hide toolbar buttons based on mode
    const toolMic = document.getElementById('tool-mic');
    const toolCam = document.getElementById('tool-cam');
    const toolChat = document.getElementById('tool-chat');
    const chatToggleBtn = document.getElementById('chatToggleBtn');

    if (data.mode === 'text') {
        // Text mode: hide media controls
        if (toolMic) toolMic.style.display = 'none';
        if (toolCam) toolCam.style.display = 'none';
        if (toolChat) toolChat.style.display = 'none';
        if (chatToggleBtn) chatToggleBtn.style.display = 'none';
    } else {
        // Audio/Video mode: show all controls
        if (toolMic) toolMic.style.display = '';
        if (toolCam) toolCam.style.display = data.mode === 'video' ? '' : 'none';
        if (toolChat) toolChat.style.display = '';
        if (chatToggleBtn) chatToggleBtn.style.display = '';
    }

    showChatScreen();
}

let sessionTimerInterval = null;

function startSessionTimer() {
    clearInterval(sessionTimerInterval);
    const timerEl = document.getElementById('sessionTimer');
    if (!timerEl) return;
    const startedAt = window.__anonCallStartedAt || Date.now();
    const format = (n) => (n < 10 ? '0' + n : '' + n);
    sessionTimerInterval = setInterval(() => {
        const diffMs = Date.now() - startedAt;
        const totalSec = Math.max(0, Math.floor(diffMs / 1000));
        const hours = Math.floor(totalSec / 3600);
        const minutes = Math.floor((totalSec % 3600) / 60);
        const seconds = totalSec % 60;
        timerEl.textContent = hours > 0
            ? `${format(hours)}:${format(minutes)}:${format(seconds)}`
            : `${format(minutes)}:${format(seconds)}`;
    }, 1000);
}

async function initializeWebRTC(data) {
    const configuration = {
        iceServers: data.iceServers.iceServers,
        iceCandidatePoolSize: data.iceServers.iceCandidatePoolSize || 10
    };

    peerConnection = new RTCPeerConnection(configuration);
    console.log('[CLIENT] RTCPeerConnection created');

    // Add local stream IMMEDIATELY for fastest negotiation
    if (localStream) {
        const tracks = localStream.getTracks();
        console.log('[CLIENT] Attaching local tracks:', tracks.map(t => `${t.kind}:${t.enabled}`));
        tracks.forEach(track => {
            peerConnection.addTrack(track, localStream);
        });
        console.log('[CLIENT] Local tracks added to peer connection');
    } else {
        console.warn('[CLIENT] No localStream present when initializing WebRTC – audio/video may not flow');
    }

    // ── Handle incoming tracks: video + audio playback (audio element for reliable remote audio) ──
    peerConnection.ontrack = (event) => {
        console.log('[CLIENT] Remote track received:', event.track.kind);
        const stream = event.streams[0];
        if (!stream) return;
        if (remoteVideo) {
            remoteVideo.srcObject = stream;
            remoteVideo.play().catch(() => {});
        }
        const remoteAudioEl = document.getElementById('remoteAudio');
        if (remoteAudioEl) {
            remoteAudioEl.srcObject = stream;
            remoteAudioEl.play().catch(() => {});
        }
        const overlay = document.getElementById('remoteMediaState');
        if (overlay) {
            overlay.style.display = 'none';
            console.log('[CLIENT] Overlay hidden — remote stream active');
        }
    };

    // ── ICE candidate buffering ──
    const candidateBuffer = [];
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            socket.emit('ice-candidate', {
                to: currentPeerId,
                candidate: event.candidate,
                sessionId: currentSessionId
            });
        }
    };

    // ── Signal handling: Buffer candidates if remoteDescription is not set ──
    socket.off('ice-candidate').on('ice-candidate', async (data) => {
        if (!peerConnection) return;
        try {
            if (peerConnection.remoteDescription && peerConnection.remoteDescription.type) {
                await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
            } else {
                candidateBuffer.push(data.candidate);
                console.log('[CLIENT] ICE candidate buffered (remoteDescription not set)');
            }
        } catch (e) {
            console.error('[CLIENT] ICE candidate error:', e);
        }
    });

    socket.off('offer').on('offer', async (data) => {
        console.log('[CLIENT] Offer received');
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.offer));
            const answer = await peerConnection.createAnswer();
            await peerConnection.setLocalDescription(answer);
            socket.emit('answer', {
                to: currentPeerId,
                answer: peerConnection.localDescription,
                sessionId: currentSessionId
            });

            // Process buffered candidates
            while (candidateBuffer.length > 0) {
                const cand = candidateBuffer.shift();
                await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                console.log('[CLIENT] Buffered ICE candidate processed');
            }
        } catch (e) {
            console.error('[CLIENT] Offer handling error:', e);
        }
    });

    socket.off('answer').on('answer', async (data) => {
        console.log('[CLIENT] Answer received');
        if (!peerConnection) return;
        try {
            await peerConnection.setRemoteDescription(new RTCSessionDescription(data.answer));
            // Process buffered candidates
            while (candidateBuffer.length > 0) {
                const cand = candidateBuffer.shift();
                await peerConnection.addIceCandidate(new RTCIceCandidate(cand));
                console.log('[CLIENT] Buffered ICE candidate processed');
            }
        } catch (e) {
            console.error('[CLIENT] Answer handling error:', e);
        }
    });

    // ── ICE connection state tracking (fast failure detection) ──
    peerConnection.oniceconnectionstatechange = () => {
        const state = peerConnection.iceConnectionState;
        console.log('[CLIENT] ICE state:', state);
        if (peerStatusEl) {
            const labels = { checking: 'Connecting…', connected: 'Connected', completed: 'Connected', failed: 'Failed', disconnected: 'Reconnecting…' };
            peerStatusEl.textContent = labels[state] || state;
        }
        if (state === 'connected' || state === 'completed') {
            const overlay = document.getElementById('remoteMediaState');
            if (overlay) overlay.style.display = 'none';
            if (remoteVideo && remoteVideo.srcObject) remoteVideo.play().catch(() => {});
            const remoteAudioEl = document.getElementById('remoteAudio');
            if (remoteAudioEl && remoteAudioEl.srcObject) remoteAudioEl.play().catch(() => {});
        }
    };

    // ── Connection state for UI ──
    peerConnection.onconnectionstatechange = () => {
        console.log('[CLIENT] Connection state:', peerConnection.connectionState);
    };

    // ── If initiator, create and send offer IMMEDIATELY ──
    if (data.initiator) {
        const offer = await peerConnection.createOffer({ iceRestart: true });
        await peerConnection.setLocalDescription(offer);
        // Send offer instantly (trickle ICE — don't wait for ICE gathering to finish)
        socket.emit('offer', {
            to: currentPeerId,
            offer: peerConnection.localDescription,
            sessionId: currentSessionId
        });
        console.log('[CLIENT] Offer sent immediately (trickle ICE)');
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
    let payload = {
        id: `msg-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        type,
        content
    };

    if (type === 'text') {
        const message = messageInput.value.trim();
        if (!message) return;
        payload.content = message;
        messageInput.value = '';
    }

    // Display own message locally
    displayMessage(payload, 'sent');
    console.log(`[CLIENT] Sending message: ${type}`);

    if (isRoomMode && roomId) {
        socket.emit('room-chat-message', { roomId, message: payload });
    } else {
        socket.emit('chat-message', {
            to: currentPeerId,
            message: payload,
            sessionId: currentSessionId
        });
    }
}

function handleIncomingMessage(data) {
    displayMessage(data.message, 'received');
    if (data?.message?.id && socket && currentPeerId && currentSessionId) {
        socket.emit('message-seen', {
            to: currentPeerId,
            messageId: data.message.id,
            sessionId: currentSessionId
        });
    }
}

function displayMessage(payload, type) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}${isGuestMode ? ' blurred-message' : ''}`;
    if (payload && typeof payload === 'object' && payload.id) {
        messageEl.dataset.messageId = payload.id;
    }

    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    let contentHtml = '';
    let statusHtml = '';

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
            case 'image':
                contentHtml = `<div class="image-message"><img src="${payload.content}" alt="Shared image"></div>`;
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

    if (type === 'sent') {
        statusHtml = `<div class="message-status" data-status-for="${payload.id || ''}">Sent</div>`;
    }

    messageEl.innerHTML = `
        <div class="message-content">${contentHtml}</div>
        <div class="message-time">${time}</div>
        ${statusHtml}
    `;

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function handleMessageSeen(data) {
    if (!data?.messageId) return;
    lastSeenMessageId = data.messageId;
    const statusEl = document.querySelector(`[data-status-for="${data.messageId}"]`);
    if (statusEl) {
        statusEl.textContent = 'Seen';
    }
}

function sendImageMessage(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
        sendMessage('image', reader.result);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function handleMessageKeyPress(event) {
    if (event.key === 'Enter') {
        sendMessage();
    }

    if (isRoomMode && roomId) {
        socket.emit('room-typing', { roomId, isTyping: true });
        clearTimeout(window.typingTimeout);
        window.typingTimeout = setTimeout(() => {
            socket.emit('room-typing', { roomId, isTyping: false });
        }, 2000);
    } else {
        socket.emit('typing', {
            to: currentPeerId,
            isTyping: true,
            sessionId: currentSessionId
        });
        clearTimeout(window.typingTimeout);
        window.typingTimeout = setTimeout(() => {
            socket.emit('typing', {
                to: currentPeerId,
                isTyping: false,
                sessionId: currentSessionId
            });
        }, 2000);
    }
}

function handleTyping(data) {
    if (data.isTyping) {
        typingIndicator.textContent = `${peerNameEl?.textContent || 'Stranger'} is typing...`;
    } else {
        typingIndicator.textContent = '';
    }
}

// Session management
function skipUser() {
    if (isRoomMode && roomId) {
        socket.emit('leave_private_room', { roomId });
        fullyCleanupSession();
        showMainContent();
        return;
    }
    if (!currentSessionId) return;
    console.log(`[CLIENT] Skip Button Clicked. Current Session: ${currentSessionId}`);
    socket.emit('skip', {
        sessionId: currentSessionId
    });
}

function exitToHome() {
    if (isRoomMode && roomId) {
        console.log(`[CLIENT] Leaving private room: ${roomId}`);
        socket.emit('leave_private_room', { roomId });
        fullyCleanupSession();
        showMainContent();
        return;
    }
    if (currentSessionId) {
        console.log(`[CLIENT] Leave Button Clicked. Ending session: ${currentSessionId}`);
        socket.emit('leave_session', { sessionId: currentSessionId });
    } else {
        cancelWaiting();
    }
}

function fullyCleanupSession() {
    console.log(`[CLIENT] Executing full session cleanup...`);

    if (waitingCountdownInterval) {
        clearInterval(waitingCountdownInterval);
        waitingCountdownInterval = null;
    }

    // 1. Stop all media tracks
    if (localStream) {
        localStream.getTracks().forEach(track => {
            track.stop();
            console.log(`[CLIENT] Stopped track: ${track.kind}`);
        });
        localStream = null;
    }
    if (roomScreenStream) {
        roomScreenStream.getTracks().forEach(t => t.stop());
        roomScreenStream = null;
    }
    isSharingScreen = false;
    const remoteScreenContainer = document.getElementById('remoteScreenContainer');
    if (remoteScreenContainer) remoteScreenContainer.classList.add('hidden');
    const remoteScreenEl = document.getElementById('remoteScreen');
    if (remoteScreenEl) remoteScreenEl.srcObject = null;

    // 2. Destroy peer connection
    if (peerConnection) {
        peerConnection.close();
        peerConnection = null;
        console.log(`[CLIENT] WebRTC Connection closed.`);
    }

    // 3. Clear UI & Video
    if (localVideo) localVideo.srcObject = null;
    if (remoteVideo) remoteVideo.srcObject = null;
    const remoteAudioEl = document.getElementById('remoteAudio');
    if (remoteAudioEl) remoteAudioEl.srcObject = null;

    const screenShareBtn = document.getElementById('toggleScreenShareBtn');
    if (screenShareBtn) {
        screenShareBtn.style.display = 'none';
        screenShareBtn.innerHTML = '<i class="ph ph-monitor"></i> Share screen';
        screenShareBtn.classList.remove('danger');
    }

    const sessionTopBar = document.getElementById('sessionTopBar');
    if (sessionTopBar) sessionTopBar.classList.add('hidden');

    messagesContainer.innerHTML = '<div class="system-message info">You are now chatting with a random stranger. Say hi!</div>';
    typingIndicator.textContent = '';

    currentSessionId = null;
    currentPeerId = null;
    lastSeenMessageId = null;

    isRoomMode = false;
    roomId = null;
    roomParticipants = [];
    roomPeerConnections.forEach(pc => { try { pc.close(); } catch (e) {} });
    roomPeerConnections.clear();
    createdRoomId = null;
    const privateRoomCreated = document.getElementById('privateRoomCreated');
    if (privateRoomCreated) privateRoomCreated.classList.add('hidden');

    if (brightnessInterval) {
        clearInterval(brightnessInterval);
        brightnessInterval = null;
    }

    if (sessionTimerInterval) {
        clearInterval(sessionTimerInterval);
        sessionTimerInterval = null;
        const timerEl = document.getElementById('sessionTimer');
        if (timerEl) timerEl.textContent = '00:00';
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

// 1. Emoji Picker (loaded dynamically to avoid ESM database.js default-export error on some hosts)
function initEmojiPicker() {
    if (typeof window.loadEmojiPicker !== 'function') return;
    window.loadEmojiPicker().then(function () {
        const el = document.querySelector('emoji-picker');
        if (el) {
            el.addEventListener('emoji-click', function (event) {
                if (messageInput) messageInput.value += event.detail.unicode;
                toggleEmojiPicker();
            });
        }
    });
}
initEmojiPicker();

function insertQuickEmoji(emoji) {
    if (messageInput) {
        messageInput.value += emoji;
        messageInput.focus();
    }
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
    toast.textContent = String(partnerName || 'Updated');
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 4000);
}

function showReconnectBanner(partnerName) {
    showConnectionToast(`Connected to ${partnerName}`);

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
