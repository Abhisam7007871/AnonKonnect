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
let unreadChatCount = 0;
const sentMessageStatus = new Map();
const pendingSeenMessageIds = new Set();
let typingPopupTimeout = null;
let speakerWatchInterval = null;
let speakerAudioContext = null;
let localSpeakerAnalyser = null;
let remoteSpeakerAnalyser = null;
let localSpeakerSource = null;
let remoteSpeakerSource = null;
let localSpeechHoldMs = 0;
let remoteSpeechHoldMs = 0;
let mediaMenuCloseTimer = null;
let incomingTypingMessageEl = null;

function createMessageId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function clearMediaMenuCloseTimer() {
    if (mediaMenuCloseTimer) {
        clearTimeout(mediaMenuCloseTimer);
        mediaMenuCloseTimer = null;
    }
}

function getCurrentPreferencesForRoomJoin() {
    return {
        nickname: (document.getElementById('nickname')?.value || userPreferences.nickname || 'Stranger'),
        gender: (document.getElementById('gender')?.value || userPreferences.gender || 'unspecified'),
        purpose: (document.getElementById('purpose')?.value || userPreferences.purpose || 'casual')
    };
}

function joinPrivateRoomByCode(code) {
    if (!socket || !socket.connected || !code) return;
    const normalizedCode = String(code).trim().toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    if (!normalizedCode) return;
    userPreferences = getCurrentPreferencesForRoomJoin();
    const errEl = document.getElementById('privateRoomError');
    if (errEl) errEl.classList.add('hidden');
    socket.emit('join_private_room', { code: normalizedCode, preferences: userPreferences });
}

function joinPendingInviteRoom() {
    if (!pendingInviteCode) return;
    joinPrivateRoomByCode(pendingInviteCode);
    closePrivateRoomInviteModal();
}

function appendPrivateRoomInviteCard(data) {
    if (!messagesContainer || !data?.code) return;
    const code = String(data.code).trim().toLowerCase();
    const wrapper = document.createElement('div');
    wrapper.className = 'system-message info private-invite-card';
    wrapper.innerHTML = `
        <div class="private-invite-title">Private room invite</div>
        <div class="private-invite-text">${escapeHtml(data.message || 'Join the shared private room directly from here.')}</div>
        <div class="private-invite-code">${escapeHtml(code)}</div>
        <button type="button" class="private-invite-join-btn">Join private room</button>
    `;
    const joinBtn = wrapper.querySelector('.private-invite-join-btn');
    if (joinBtn) {
        joinBtn.addEventListener('click', () => {
            joinPrivateRoomByCode(code);
            showConnectionToast('Joining private room...');
        });
    }
    messagesContainer.appendChild(wrapper);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function showIncomingTypingMessage(text = 'Typing...') {
    if (!messagesContainer) return;
    if (!incomingTypingMessageEl) {
        incomingTypingMessageEl = document.createElement('div');
        incomingTypingMessageEl.className = 'message received typing-temp-message';
        incomingTypingMessageEl.setAttribute('data-typing-temp', 'true');
        messagesContainer.appendChild(incomingTypingMessageEl);
    }
    incomingTypingMessageEl.textContent = text;
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function clearIncomingTypingMessage() {
    if (incomingTypingMessageEl?.parentNode) {
        incomingTypingMessageEl.parentNode.removeChild(incomingTypingMessageEl);
    }
    incomingTypingMessageEl = null;
}

function updateNoteAiControlsVisibility() {
    const controls = document.getElementById('noteAiControls');
    const startBtn = document.getElementById('noteAiStartBtn');
    const stopBtn = document.getElementById('noteAiStopBtn');
    const generateBtn = document.getElementById('noteAiGenerateBtn');
    if (!controls || !startBtn || !stopBtn || !generateBtn) return;
    const show = Boolean(isRoomMode && roomId);
    controls.classList.toggle('hidden', !show);
    startBtn.classList.toggle('hidden', !show || noteAiIsRecording);
    stopBtn.classList.toggle('hidden', !show || !noteAiIsRecording);
    generateBtn.classList.toggle('hidden', !show || noteAiIsRecording || !noteAiHasRecording);
}

function appendNoteAiSystemMessage(text) {
    if (!messagesContainer) return;
    const el = document.createElement('div');
    el.className = 'system-message info';
    el.textContent = text;
    messagesContainer.appendChild(el);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
}

function resetNoteAiState() {
    noteAiIsRecording = false;
    noteAiHasRecording = false;
    noteAiChunks = [];
    noteAiStartedAt = null;
    noteAiEndedAt = null;
    if (noteAiRecorder && noteAiRecorder.state !== 'inactive') {
        try { noteAiRecorder.stop(); } catch (_e) {}
    }
    noteAiRecorder = null;
    if (noteAiMixedStream) {
        noteAiMixedStream.getTracks().forEach((track) => {
            try { track.stop(); } catch (_e) {}
        });
        noteAiMixedStream = null;
    }
    if (noteAiAudioContext) {
        noteAiAudioContext.close().catch(() => {});
        noteAiAudioContext = null;
    }
    updateNoteAiControlsVisibility();
}

function createMixedRoomAudioStream() {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    noteAiAudioContext = new Ctx();
    const destination = noteAiAudioContext.createMediaStreamDestination();

    let hasTrack = false;
    if (localStream) {
        const localAudioTracks = localStream.getAudioTracks();
        if (localAudioTracks.length) {
            const localAudioStream = new MediaStream([localAudioTracks[0]]);
            const localSource = noteAiAudioContext.createMediaStreamSource(localAudioStream);
            localSource.connect(destination);
            hasTrack = true;
        }
    }

    const remoteAudioEl = document.getElementById('remoteAudio');
    const remoteAudioStream = remoteAudioEl?.srcObject;
    if (remoteAudioStream && typeof remoteAudioStream.getAudioTracks === 'function') {
        const remoteTracks = remoteAudioStream.getAudioTracks();
        if (remoteTracks.length) {
            const remoteStream = new MediaStream([remoteTracks[0]]);
            const remoteSource = noteAiAudioContext.createMediaStreamSource(remoteStream);
            remoteSource.connect(destination);
            hasTrack = true;
        }
    }

    if (!hasTrack) {
        noteAiAudioContext.close().catch(() => {});
        noteAiAudioContext = null;
        return null;
    }
    return destination.stream;
}

function startNoteAiRecording() {
    if (!isRoomMode || !roomId) {
        showConnectionToast('NoteAI is only available in private rooms.');
        return;
    }
    if (typeof MediaRecorder === 'undefined') {
        showConnectionToast('NoteAI recording is not supported in this browser.');
        return;
    }
    if (noteAiIsRecording) return;
    const mixedStream = createMixedRoomAudioStream();
    if (!mixedStream) {
        showConnectionToast('No room audio detected for NoteAI.');
        return;
    }
    const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : 'audio/webm';
    noteAiChunks = [];
    noteAiMixedStream = mixedStream;
    noteAiRecorder = new MediaRecorder(mixedStream, { mimeType });
    noteAiRecorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) noteAiChunks.push(event.data);
    };
    noteAiRecorder.onstop = () => {
        noteAiIsRecording = false;
        noteAiHasRecording = noteAiChunks.length > 0;
        noteAiEndedAt = new Date().toISOString();
        if (noteAiMixedStream) {
            noteAiMixedStream.getTracks().forEach((track) => {
                try { track.stop(); } catch (_e) {}
            });
            noteAiMixedStream = null;
        }
        if (noteAiAudioContext) {
            noteAiAudioContext.close().catch(() => {});
            noteAiAudioContext = null;
        }
        updateNoteAiControlsVisibility();
    };
    noteAiRecorder.start(1000);
    noteAiStartedAt = new Date().toISOString();
    noteAiEndedAt = null;
    noteAiIsRecording = true;
    updateNoteAiControlsVisibility();
    appendNoteAiSystemMessage('NoteAI recording started for this private room.');
}

function stopNoteAiRecording() {
    if (!noteAiRecorder || noteAiRecorder.state === 'inactive') return;
    noteAiRecorder.stop();
    appendNoteAiSystemMessage('NoteAI recording stopped. Click Generate PDF to create meeting notes.');
}

async function generateNoteAiSummary() {
    if (!isRoomMode || !roomId) {
        showConnectionToast('Join a private room first.');
        return;
    }
    if (noteAiIsRecording) {
        showConnectionToast('Stop NoteAI recording before generating PDF.');
        return;
    }
    if (!noteAiChunks.length) {
        showConnectionToast('No NoteAI recording available yet.');
        return;
    }
    try {
        showConnectionToast('Generating NoteAI summary and PDF...');
        const audioBlob = new Blob(noteAiChunks, { type: 'audio/webm' });
        const formData = new FormData();
        const chatNotes = Array.from(document.querySelectorAll('#messages .message'))
            .filter((el) => !el.classList.contains('typing-temp-message'))
            .map((el) => ({
                role: el.classList.contains('sent') ? 'you' : 'stranger',
                text: (el.textContent || '').trim()
            }))
            .filter((row) => row.text);
        formData.append('audio', audioBlob, `noteai-${Date.now()}.webm`);
        formData.append('roomId', roomId);
        formData.append('mode', currentMode || 'audio');
        formData.append('chatNotes', JSON.stringify(chatNotes.slice(-80)));
        if (noteAiStartedAt) formData.append('startedAt', noteAiStartedAt);
        if (noteAiEndedAt) formData.append('endedAt', noteAiEndedAt);
        const response = await fetch('/api/noteai/generate', {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        if (!response.ok || !data?.ok) {
            throw new Error(data?.error || 'NoteAI failed to generate notes.');
        }
        const absoluteLink = `${window.location.origin}${data.downloadUrl}`;
        const a = document.createElement('a');
        a.href = absoluteLink;
        a.download = data.fileName || `noteai-${roomId || 'room'}-${Date.now()}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        appendNoteAiSystemMessage(`NoteAI PDF generated and downloaded: ${absoluteLink}`);
        sendMessage('text', `NoteAI meeting notes are ready: ${absoluteLink}`);
        noteAiHasRecording = false;
        noteAiChunks = [];
        updateNoteAiControlsVisibility();
    } catch (err) {
        showConnectionToast(err.message || 'Failed to generate NoteAI notes.');
    }
}

// Private room state
let isRoomMode = false;
let roomId = null;
let roomParticipants = [];
let roomPeerConnections = new Map();
let pendingInviteCode = null;
let createdRoomId = null;
let roomScreenStream = null;
let isSharingScreen = false;
let isPrivacyShieldOn = false;
let privacyBlackTrack = null;
const roomScreenSenders = new Map();
let noteAiRecorder = null;
let noteAiAudioContext = null;
let noteAiMixedStream = null;
let noteAiChunks = [];
let noteAiIsRecording = false;
let noteAiHasRecording = false;
let noteAiStartedAt = null;
let noteAiEndedAt = null;

function getRoomParticipantNameById(socketId) {
    if (!socketId) return 'Participant';
    if (socket && socket.id && socketId === socket.id) return 'You';
    const row = (roomParticipants || []).find((p) => p.id === socketId);
    const name = row?.preferences?.nickname;
    return name && String(name).trim() ? String(name).trim() : 'Stranger';
}

function updateRoomChatSizeByParticipants() {
    const chatLayout = document.querySelector('.chat-layout');
    if (!chatLayout || !isRoomMode) return;
    const count = Math.max(1, Number(roomParticipants?.length || 1));
    const size = Math.max(20, Math.min(65, 65 - (count - 1) * 9));
    chatLayout.style.setProperty('--room-chat-size', `${size}%`);
    chatLayout.style.setProperty('--room-chat-size-vh', `${size}vh`);
}

function renderParticipantsPanel() {
    const wrap = document.getElementById('participantsWrap');
    const listEl = document.getElementById('participantsList');
    const btn = document.getElementById('participantsBtn');
    if (wrap) wrap.classList.toggle('hidden', !isRoomMode);
    if (!listEl || !btn || !isRoomMode) return;
    const rows = (roomParticipants || []).slice();
    listEl.innerHTML = rows.map((p) => {
        const name = getRoomParticipantNameById(p.id);
        const you = socket && p.id === socket.id ? '<span class="participants-you">you</span>' : '';
        return `<div class="participants-item"><span class="participants-name">${escapeHtml(name)}</span>${you}</div>`;
    }).join('') || '<div class="participants-empty">No participants</div>';
    btn.innerHTML = `<i class="ph ph-users-three"></i> Participants (${rows.length})`;
}

function toggleParticipantsPanel() {
    if (!isRoomMode) return;
    const panel = document.getElementById('participantsPanel');
    if (!panel) return;
    renderParticipantsPanel();
    panel.classList.toggle('hidden');
}

function closeParticipantsPanel() {
    const panel = document.getElementById('participantsPanel');
    if (!panel) return;
    panel.classList.add('hidden');
}

const roomRemoteStreams = new Map();
let roomActivePeerId = null;
let roomSpeakerWatchInterval = null;
let roomSpeakerAudioContext = null;
const roomSpeakerAnalyserByPeer = new Map();

function updatePrivateRoomButtonsVisibility() {
    const canCreate = Boolean(socket?.connected && currentSessionId);
    const ids = ['createPrivateRoomInCallBtn', 'createPrivateRoomHeaderBtn', 'createPrivateRoomToolbarBtn'];
    ids.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.display = canCreate ? '' : 'none';
    });
}

function updateRoomIdBadge() {
    const badge = document.getElementById('roomIdBadge');
    if (!badge) return;
    if (isRoomMode && roomId) {
        badge.textContent = `Room ID: ${roomId}`;
        badge.classList.remove('hidden');
    } else {
        badge.textContent = '';
        badge.classList.add('hidden');
    }
}

function setActiveRoomPeer(peerId) {
    roomActivePeerId = peerId || null;
    const activeVideo = document.getElementById('roomActiveVideo');
    const activeLabel = document.getElementById('roomActiveLabel');
    const row = roomActivePeerId ? roomRemoteStreams.get(roomActivePeerId) : null;
    if (activeVideo) {
        activeVideo.srcObject = row?.stream || null;
        if (row?.stream) activeVideo.play().catch(() => {});
    }
    if (activeLabel) {
        activeLabel.textContent = roomActivePeerId ? getRoomParticipantNameById(roomActivePeerId) : 'Waiting for participants...';
    }
}

function renderRoomRemoteStrip() {
    const strip = document.getElementById('roomRemoteStrip');
    if (!strip) return;
    const others = [...roomRemoteStreams.entries()].filter(([peerId]) => peerId !== roomActivePeerId);
    strip.innerHTML = '';
    others.forEach(([peerId, row]) => {
        const tile = document.createElement('button');
        tile.type = 'button';
        tile.className = 'room-strip-tile';
        tile.onclick = () => setActiveRoomPeer(peerId);
        const video = document.createElement('video');
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        video.srcObject = row.stream;
        video.play().catch(() => {});
        const label = document.createElement('span');
        label.className = 'room-strip-label';
        label.textContent = getRoomParticipantNameById(peerId);
        tile.appendChild(video);
        tile.appendChild(label);
        strip.appendChild(tile);
    });
}

function renderRoomVideoLayout() {
    const layout = document.getElementById('roomVideoLayout');
    const defaultGrid = document.querySelector('.video-grid-premium');
    const shouldUse = Boolean(isRoomMode && currentMode === 'video');
    if (layout) layout.classList.toggle('hidden', !shouldUse);
    if (defaultGrid) defaultGrid.classList.toggle('hidden', shouldUse);
    if (!shouldUse) return;
    if (!roomActivePeerId || !roomRemoteStreams.has(roomActivePeerId)) {
        const first = roomRemoteStreams.keys().next().value || null;
        setActiveRoomPeer(first);
    } else {
        setActiveRoomPeer(roomActivePeerId);
    }
    renderRoomRemoteStrip();
}

function stopRoomSpeakerWatch() {
    if (roomSpeakerWatchInterval) {
        clearInterval(roomSpeakerWatchInterval);
        roomSpeakerWatchInterval = null;
    }
    roomSpeakerAnalyserByPeer.clear();
    if (roomSpeakerAudioContext) {
        roomSpeakerAudioContext.close().catch(() => {});
        roomSpeakerAudioContext = null;
    }
}

function rebuildRoomSpeakerAnalysers() {
    if (!isRoomMode || currentMode !== 'video') return;
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    stopRoomSpeakerWatch();
    roomSpeakerAudioContext = new Ctx();
    roomRemoteStreams.forEach((row, peerId) => {
        try {
            const source = roomSpeakerAudioContext.createMediaStreamSource(row.stream);
            const analyser = roomSpeakerAudioContext.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.75;
            source.connect(analyser);
            roomSpeakerAnalyserByPeer.set(peerId, analyser);
        } catch (_e) {}
    });
    roomSpeakerWatchInterval = setInterval(() => {
        let topPeer = null;
        let topLevel = 0;
        roomSpeakerAnalyserByPeer.forEach((analyser, peerId) => {
            const lvl = getAudioLevel(analyser);
            if (lvl > topLevel) {
                topLevel = lvl;
                topPeer = peerId;
            }
        });
        if (topPeer && topLevel > 16 && topPeer !== roomActivePeerId) {
            setActiveRoomPeer(topPeer);
            renderRoomRemoteStrip();
        }
    }, 240);
}

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

    // Start with Start button disabled until signaling is connected
    const startBtn = document.getElementById('startChatBtn');
    if (startBtn) startBtn.disabled = true;
    // Connect to signaling server
    connectToServer();

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

    // Animate "Users Online Now" with high-volume fluctuation (>= 900)
    initOnlineCountFluctuation();

    // Private room code input formatting/validation
    initPrivateRoomCodeInput();

    document.addEventListener('visibilitychange', () => {
        if (document.hidden && isSharingScreen && !isPrivacyShieldOn) {
            setPrivacyShield(true);
            showToast('Screen hidden while app in background for privacy.');
        }
    });
    document.addEventListener('click', (event) => {
        const menu = document.getElementById('mediaToolsMenu');
        const trigger = document.getElementById('mediaToolsBtn');
        const emojiPicker = document.getElementById('emojiPickerContainer');
        const gifPicker = document.getElementById('gifPickerContainer');
        const stickerPicker = document.getElementById('stickerPickerContainer');
        const target = event.target;
        const clickedInsideAttachmentUi =
            (menu && menu.contains(target)) ||
            (trigger && trigger.contains(target)) ||
            (emojiPicker && emojiPicker.contains(target)) ||
            (gifPicker && gifPicker.contains(target)) ||
            (stickerPicker && stickerPicker.contains(target));
        if (!clickedInsideAttachmentUi) {
            closeAllAttachmentUi();
        }

        const participantsBtn = document.getElementById('participantsBtn');
        const participantsPanel = document.getElementById('participantsPanel');
        const insideParticipants =
            (participantsBtn && participantsBtn.contains(target)) ||
            (participantsPanel && participantsPanel.contains(target));
        if (!insideParticipants) {
            closeParticipantsPanel();
        }
    });
    const mediaToolbar = document.querySelector('.input-area .chat-toolbar');
    const mediaMenu = document.getElementById('mediaToolsMenu');
    if (mediaToolbar && mediaMenu) {
        const openMenu = () => {
            clearMediaMenuCloseTimer();
            mediaMenu.classList.remove('hidden');
        };
        const closeMenuWithDelay = () => {
            clearMediaMenuCloseTimer();
            mediaMenuCloseTimer = setTimeout(() => {
                mediaMenu.classList.add('hidden');
            }, 220);
        };

        mediaToolbar.addEventListener('mouseenter', openMenu);
        mediaToolbar.addEventListener('mouseleave', closeMenuWithDelay);
        mediaMenu.addEventListener('mouseenter', openMenu);
        mediaMenu.addEventListener('mouseleave', closeMenuWithDelay);
        mediaToolbar.addEventListener('focusin', openMenu);
        mediaToolbar.addEventListener('focusout', () => {
            setTimeout(() => {
                if (!mediaToolbar.contains(document.activeElement) && !mediaMenu.contains(document.activeElement)) {
                    closeMenuWithDelay();
                }
            }, 0);
        });
    }
    if (messageInput) {
        const hideAttachments = () => closeAllAttachmentUi();
        messageInput.addEventListener('focus', hideAttachments);
        messageInput.addEventListener('click', hideAttachments);
    }
    renderParticipantsPanel();
    updatePrivateRoomButtonsVisibility();
    updateRoomIdBadge();
});

function initOnlineCountFluctuation() {
    const onlineCountEl = document.getElementById('onlineCount');
    if (!onlineCountEl) return;

    let current = 900 + Math.floor(Math.random() * 1201); // 900..2100
    onlineCountEl.textContent = String(current);

    setInterval(() => {
        const delta = Math.floor(Math.random() * 1001) - 500; // -500..+500
        current = Math.max(900, Math.min(5000, current + delta));
        onlineCountEl.textContent = String(current);
    }, 1500);
}

function toggleMediaToolsMenu() {
    const menu = document.getElementById('mediaToolsMenu');
    if (!menu) return;
    clearMediaMenuCloseTimer();
    menu.classList.toggle('hidden');
}

function closeMediaToolsMenu() {
    const menu = document.getElementById('mediaToolsMenu');
    if (!menu) return;
    menu.classList.add('hidden');
}

function closeAllPickers() {
    document.getElementById('emojiPickerContainer')?.classList.add('hidden');
    document.getElementById('gifPickerContainer')?.classList.add('hidden');
    document.getElementById('stickerPickerContainer')?.classList.add('hidden');
}

function closeAllAttachmentUi() {
    closeMediaToolsMenu();
    closeAllPickers();
}

function initPrivateRoomCodeInput() {
    const input = document.getElementById('privateRoomCode');
    if (!input) return;

    const normalize = (value) => {
        const cleaned = String(value || '')
            .toLowerCase()
            .replace(/[^a-z0-9-]/g, '')
            .replace(/-+/g, '-')
            .replace(/^-|-$/g, '');
        return cleaned.slice(0, 19);
    };

    input.addEventListener('input', () => {
        const normalized = normalize(input.value);
        if (input.value !== normalized) {
            input.value = normalized;
        }
    });

    input.addEventListener('paste', () => {
        setTimeout(() => {
            input.value = normalize(input.value);
        }, 0);
    });
}

function getMediaConstraints(mode) {
    const wantsVideo = mode === 'video';
    return {
        audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true
        },
        video: wantsVideo ? {
            width: { ideal: 1280, max: 1920 },
            height: { ideal: 720, max: 1080 },
            frameRate: { ideal: 24, max: 30 },
            facingMode: 'user'
        } : false
    };
}

async function ensureLocalMediaForMode(mode) {
    if (mode !== 'audio' && mode !== 'video') return true;
    if (localStream && localStream.getTracks().length > 0) return true;
    try {
        const constraints = getMediaConstraints(mode);
        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (mode === 'video' && localVideo) {
            localVideo.srcObject = localStream;
            localVideo.onloadedmetadata = () => localVideo.play().catch(() => {});
        }
        return true;
    } catch (err) {
        console.error('[CLIENT] Failed to acquire media for matched session:', err);
        showConnectionToast('Camera/Microphone permission is required to continue.');
        return false;
    }
}

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
    updateWaitingUI('Looking for a stranger...', 'Connecting you to the global network.');
}

function updateWaitingUI(title, details) {
    const waitingTitleEl = document.getElementById('waitingText');
    const queueInfoEl = document.getElementById('queueInfo');
    if (waitingTitleEl && title) waitingTitleEl.textContent = title;
    if (queueInfoEl && details) queueInfoEl.textContent = details;
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
    // Safety: Verify Socket.IO client loaded from CDN
    if (typeof io === 'undefined') {
        console.error('[CLIENT] FATAL: Socket.IO client library not loaded. Check CDN script tag.');
        alert('Failed to load networking library. Please refresh the page.');
        return;
    }

    // Dynamically determine signaling server URL
    // LOCAL: http://localhost:3000
    // PRODUCTION: Your persistent server URL (Render, Railway, etc.)
    const explicitSignalingUrl = window.ANONKONNECT_SIGNALING_URL;
    const signalingUrl = explicitSignalingUrl
        || (window.location.protocol === 'file:' ? 'http://localhost:3000' : window.location.origin);

    // #region agent log
    const _hostname = window.location.hostname;
    const _origin = window.location.origin;
    fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:connectToServer', message: 'signaling connection attempt', data: { signalingUrl, hostname: _hostname, origin: _origin }, timestamp: Date.now(), hypothesisId: 'H4' }) }).catch(() => { });
    // #endregion

    console.log(`[CLIENT] Connecting to signaling server: ${signalingUrl}`);
    socket = io(signalingUrl, {
        transports: ['websocket', 'polling'],
        reconnection: true,
        reconnectionAttempts: 15,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 5000,
        timeout: 45000 // Allow time for Render cold start (~30–60s on free tier)
    });

    socket.on('connect', () => {
        // #region agent log
        fetch('http://127.0.0.1:7626/ingest/aec485ed-3800-4bdd-96c5-3b55a8f6fa64', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Debug-Session-Id': '5c1abb' }, body: JSON.stringify({ sessionId: '5c1abb', location: 'app.js:connect', message: 'signaling connected', data: {}, timestamp: Date.now(), hypothesisId: 'H1' }) }).catch(() => { });
        // #endregion
        console.log('[CLIENT] Connected to signaling server');
        updateConnectionStatus(true);
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
    socket.on('queue-update', handleQueueUpdate);

    socket.on('offer', handleOffer);
    socket.on('answer', handleAnswer);
    socket.on('ice-candidate', handleIceCandidate);
    socket.on('chat-message', handleIncomingMessage);
    socket.on('chat-message-delivered', (data) => {
        if (!data?.messageId) return;
        updateSentMessageStatus(data.messageId, 'delivered');
    });
    socket.on('chat-message-seen', (data) => {
        if (!data?.messageId) return;
        updateSentMessageStatus(data.messageId, 'seen');
    });
    socket.on('typing', handleTyping);
    socket.on('chat-message-blocked', (data) => {
        showConnectionToast(data?.message || 'Image blocked by safety policy.');
    });

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

    socket.on('participant_joined', (data) => {
        const newId = data.socketId;
        if (isRoomMode && roomId) {
            if (!roomPeerConnections.has(newId)) {
                handleRoomNewParticipant(newId, data.preferences || {});
            }
            if (data.participants) roomParticipants = data.participants;
            renderParticipantsPanel();
            updateRoomChatSizeByParticipants();
            updateRoomIdBadge();
            renderRoomVideoLayout();
            return;
        }
        if (createdRoomId && data.participants) {
            roomId = createdRoomId;
            roomParticipants = data.participants;
            isRoomMode = true;
            renderParticipantsPanel();
            updateRoomChatSizeByParticipants();
            updateRoomIdBadge();
            renderRoomVideoLayout();
            createdRoomId = null;
            const mode = currentMode;
            (async () => {
                if (mode === 'video' || mode === 'audio') {
                    try {
                        const constraints = getMediaConstraints(mode);
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
            roomRemoteStreams.delete(data.socketId);
            if (roomActivePeerId === data.socketId) roomActivePeerId = null;
            renderParticipantsPanel();
            updateRoomChatSizeByParticipants();
            renderRoomVideoLayout();
            rebuildRoomSpeakerAnalysers();
        }
    });

    socket.on('private_room_invite', (data) => {
        pendingInviteCode = data.code;
        const modal = document.getElementById('privateRoomInviteModal');
        const msgEl = document.getElementById('privateRoomInviteMessage');
        const codeEl = document.getElementById('privateRoomInviteCode');
        if (modal && msgEl && codeEl) {
            msgEl.textContent = data.message || 'You both have the same code. You can join this private call anytime using this ID. Max 6 people.';
            codeEl.textContent = data.code || '';
            modal.classList.remove('hidden');
        }
        appendPrivateRoomInviteCard(data);
    });

    socket.on('room-offer', handleRoomOffer);
    socket.on('room-answer', handleRoomAnswer);
    socket.on('room-ice-candidate', handleRoomIceCandidate);
    socket.on('room-chat-message', handleRoomChatMessage);
    socket.on('room-chat-message-delivered', (data) => {
        if (!data?.messageId) return;
        updateSentMessageStatus(data.messageId, 'delivered');
    });
    socket.on('room-chat-message-seen', (data) => {
        if (!data?.messageId) return;
        updateSentMessageStatus(data.messageId, 'seen');
    });
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
        purpose: document.getElementById('purpose').value || 'casual'
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
    const normalizedCode = code.toLowerCase().replace(/[^a-z0-9-]/g, '').replace(/-+/g, '-').replace(/^-|-$/g, '');
    const codePattern = /^[a-z0-9]{2,4}(?:-[a-z0-9]{2,4}){2,3}$/;

    if (!code) {
        const errEl = document.getElementById('privateRoomError');
        if (errEl) { errEl.textContent = 'Enter a room code'; errEl.classList.remove('hidden'); }
        return;
    }
    if (!codePattern.test(normalizedCode)) {
        const errEl = document.getElementById('privateRoomError');
        if (errEl) { errEl.textContent = 'Invalid code format. Use grouped code like asd-fewa-sdas'; errEl.classList.remove('hidden'); }
        return;
    }
    userPreferences = getCurrentPreferencesForRoomJoin();
    document.getElementById('privateRoomError').classList.add('hidden');
    socket.emit('join_private_room', { code: normalizedCode, preferences: userPreferences });
}

function copyRoomCode() {
    const el = document.getElementById('privateRoomCodeDisplay');
    if (el && el.textContent) {
        navigator.clipboard.writeText(el.textContent).then(() => showConnectionToast('Code copied!')).catch(() => {});
    }
}

function createPrivateRoomFromCall() {
    if (!socket || !socket.connected || !currentSessionId) return;
    const payload = {
        mode: currentMode,
        preferences: userPreferences
    };
    if (currentPeerId) {
        payload.fromCall = true;
        payload.peerId = currentPeerId;
    }
    socket.emit('create_private_room', payload);
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
    updateRoomIdBadge();
    updatePrivateRoomButtonsVisibility();
    renderParticipantsPanel();
    updateRoomChatSizeByParticipants();
    currentMode = data.mode || 'text';
    const others = roomParticipants.filter(p => p.id !== socket.id);
    if (others.length === 0) {
        showChatScreen();
        applyRoomLayout(currentMode);
        return;
    }
    if (currentMode === 'video' || currentMode === 'audio') {
        try {
            const constraints = getMediaConstraints(currentMode);
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
    updateRoomIdBadge();
    updatePrivateRoomButtonsVisibility();
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
        chatLayout.classList.toggle('room-mode', !!isRoomMode);
    }
    if (mode === 'video' || mode === 'audio') {
        if (mediaContainer) mediaContainer.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('has-media');
        setChatPanelState(false);
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        if (sessionTopBarPeerName) sessionTopBarPeerName.textContent = 'Private room (' + participants.length + ')';
        if (mode === 'audio') applyAdaptiveChatContrastFromContainer();
    } else {
        if (mediaContainer) mediaContainer.classList.add('hidden');
        if (chatLayout) chatLayout.classList.remove('has-media');
        setChatPanelState(true);
        if (sessionTopBar) sessionTopBar.classList.add('hidden');
        applyAdaptiveChatContrastFromContainer();
    }
    if (isRoomMode && sessionTopBar) sessionTopBar.classList.remove('hidden');
    if (isRoomMode && sessionTopBarPeerName) sessionTopBarPeerName.textContent = 'Private room (' + participants.length + ')';
    if (roomModeSwitchEl) roomModeSwitchEl.classList.toggle('hidden', !isRoomMode);
    if (screenShareBtn) screenShareBtn.style.display = isRoomMode ? '' : 'none';
    updateNoteAiControlsVisibility();
    renderParticipantsPanel();
    updateRoomChatSizeByParticipants();
    renderRoomVideoLayout();
    rebuildRoomSpeakerAnalysers();
    updateRoomModeSwitchActive(mode);
    const toolMic = document.getElementById('tool-mic');
    const toolCam = document.getElementById('tool-cam');
    const toolChat = document.getElementById('tool-chat');
    const toolChatBtn = document.getElementById('chatToggleBtn');
    const mobileSkip = document.getElementById('tool-skip-mobile');
    const mobileLeave = document.getElementById('tool-leave-mobile');
    if (mode === 'text') {
        if (toolMic) toolMic.style.display = 'none';
        if (toolCam) toolCam.style.display = 'none';
        if (toolChat) toolChat.style.display = isRoomMode ? '' : 'none';
        if (toolChatBtn) toolChatBtn.style.display = isRoomMode ? '' : 'none';
        if (mobileSkip) mobileSkip.style.display = 'none';
        if (mobileLeave) mobileLeave.style.display = 'none';
    } else {
        if (toolMic) toolMic.style.display = '';
        if (toolCam) toolCam.style.display = mode === 'video' ? '' : 'none';
        if (toolChat) toolChat.style.display = '';
        if (toolChatBtn) toolChatBtn.style.display = '';
        if (mobileSkip) mobileSkip.style.display = '';
        if (mobileLeave) mobileLeave.style.display = '';
    }
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
        chatLayout.classList.toggle('room-mode', !!isRoomMode);
    }
    if (mode === 'video' || mode === 'audio') {
        if (mediaContainer) mediaContainer.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('has-media');
        setChatPanelState(false);
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        if (sessionTopBarPeerName) sessionTopBarPeerName.textContent = 'Private room (' + (roomParticipants.length || 0) + ')';
        if (mode === 'audio') applyAdaptiveChatContrastFromContainer();
        try {
            const constraints = getMediaConstraints(mode);
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
        setChatPanelState(true);
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        applyAdaptiveChatContrastFromContainer();
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
    const mobileSkip = document.getElementById('tool-skip-mobile');
    const mobileLeave = document.getElementById('tool-leave-mobile');
    if (mode === 'text') {
        if (toolMic) toolMic.style.display = 'none';
        if (toolCam) toolCam.style.display = 'none';
        if (toolChat) toolChat.style.display = '';
        if (toolChatBtn) toolChatBtn.style.display = '';
        if (mobileSkip) mobileSkip.style.display = 'none';
        if (mobileLeave) mobileLeave.style.display = 'none';
    } else {
        if (toolMic) toolMic.style.display = '';
        if (toolCam) toolCam.style.display = mode === 'video' ? '' : 'none';
        if (toolChat) toolChat.style.display = '';
        if (toolChatBtn) toolChatBtn.style.display = '';
        if (mobileSkip) mobileSkip.style.display = '';
        if (mobileLeave) mobileLeave.style.display = '';
    }
    renderRoomVideoLayout();
    rebuildRoomSpeakerAnalysers();
    updatePrivateRoomButtonsVisibility();
}

function applyRoomLayout(mode) {
    const chatLayout = document.querySelector('.chat-layout');
    const mediaContainer = document.getElementById('mediaContainer');
    const chatContainer = document.getElementById('chatContainer');
    if (mode === 'video' || mode === 'audio') {
        if (mediaContainer) mediaContainer.classList.remove('hidden');
        if (chatLayout) chatLayout.classList.add('has-media');
        setChatPanelState(false);
    }
    renderParticipantsPanel();
    updateRoomChatSizeByParticipants();
    renderRoomVideoLayout();
    rebuildRoomSpeakerAnalysers();
    updateNoteAiControlsVisibility();
}

const ICE_SERVERS = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }, { urls: 'stun:stun1.l.google.com:19302' }], iceCandidatePoolSize: 10 };

function handleIncomingRoomTrack(peerSocketId, track, stream) {
    if (!stream) return;
    roomRemoteStreams.set(peerSocketId, {
        stream,
        nickname: getRoomParticipantNameById(peerSocketId)
    });
    renderRoomVideoLayout();
    if (track?.kind === 'audio') {
        rebuildRoomSpeakerAnalysers();
    }
    const overlay = document.getElementById('remoteMediaState');
    if (overlay) overlay.style.display = roomRemoteStreams.size ? 'none' : 'flex';
}

async function handleRoomNewParticipant(peerSocketId, preferences) {
    if (roomPeerConnections.has(peerSocketId)) return;
    const pc = new RTCPeerConnection(ICE_SERVERS);
    roomPeerConnections.set(peerSocketId, pc);
    if (localStream) {
        localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }
    if (roomScreenStream) {
        const screenTrack = roomScreenStream.getVideoTracks()[0];
        if (screenTrack) {
            const sender = pc.addTrack(screenTrack, roomScreenStream);
            roomScreenSenders.set(peerSocketId, sender);
        }
    }
    pc.ontrack = (e) => {
        const track = e.track;
        const stream = e.streams[0];
        handleIncomingRoomTrack(peerSocketId, track, stream);
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
        if (roomScreenStream) {
            const screenTrack = roomScreenStream.getVideoTracks()[0];
            if (screenTrack) {
                const sender = pc.addTrack(screenTrack, roomScreenStream);
                roomScreenSenders.set(from, sender);
            }
        }
        pc.ontrack = (e) => {
            const track = e.track;
            const stream = e.streams[0];
            handleIncomingRoomTrack(from, track, stream);
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
        isPrivacyShieldOn = false;
        if (btn) {
            btn.innerHTML = '<i class="ph ph-monitor"></i> Share screen';
            btn.classList.remove('danger');
        }
        updatePrivacyButtonUI(false, false);
        const cameraTrack = localStream ? localStream.getVideoTracks()[0] : null;
        for (const [peerId, pc] of roomPeerConnections) {
            const sender = roomScreenSenders.get(peerId)
                || pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!sender) continue;
            try {
                if (cameraTrack) {
                    await sender.replaceTrack(cameraTrack);
                } else {
                    sender.replaceTrack(null);
                }
            } catch (e) {
                console.error('Screen share restore error:', e);
            }
        }
        roomScreenSenders.clear();
        const container = document.getElementById('remoteScreenContainer');
        if (container) container.classList.add('hidden');
        const remoteScreenEl = document.getElementById('remoteScreen');
        if (remoteScreenEl) remoteScreenEl.srcObject = null;
        return;
    }
    try {
        roomScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = roomScreenStream.getVideoTracks()[0];
        if (!screenTrack) throw new Error('No screen track available');
        isSharingScreen = true;
        isPrivacyShieldOn = false;
        if (btn) {
            btn.innerHTML = '<i class="ph ph-monitor-slash"></i> Stop share';
            btn.classList.add('danger');
        }
        updatePrivacyButtonUI(true, false);
        showToast('Use "Hide" before opening sensitive apps while sharing.');
        for (const [peerId, pc] of roomPeerConnections) {
            const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (sender) {
                try {
                    await sender.replaceTrack(screenTrack);
                    roomScreenSenders.set(peerId, sender);
                } catch (e) {
                    console.error('replaceTrack(screen) error:', e);
                }
            } else {
                try {
                    const newSender = pc.addTrack(screenTrack, roomScreenStream);
                    roomScreenSenders.set(peerId, newSender);
                    const offer = await pc.createOffer();
                    await pc.setLocalDescription(offer);
                    socket.emit('room-offer', { to: peerId, offer: pc.localDescription, roomId });
                } catch (e) {
                    console.error('Screen share addTrack error:', e);
                }
            }
        }
        screenTrack.onended = () => {
            if (isSharingScreen) toggleRoomScreenShare();
        };
    } catch (e) {
        console.error('getDisplayMedia error:', e);
        if (btn) btn.innerHTML = '<i class="ph ph-monitor"></i> Share screen';
    }
}

async function toggleDirectScreenShare() {
    if (!peerConnection) return;
    const btn = document.getElementById('toggleScreenShareBtn');
    if (isSharingScreen) {
        if (roomScreenStream) {
            roomScreenStream.getTracks().forEach(t => t.stop());
            roomScreenStream = null;
        }
        isSharingScreen = false;
        isPrivacyShieldOn = false;
        if (btn) {
            btn.innerHTML = '<i class="ph ph-monitor"></i> Share screen';
            btn.classList.remove('danger');
        }
        updatePrivacyButtonUI(false, false);

        const cameraTrack = localStream ? localStream.getVideoTracks()[0] : null;
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            try {
                await sender.replaceTrack(cameraTrack || null);
            } catch (e) {
                console.error('Direct screen restore error:', e);
            }
        }
        return;
    }

    try {
        roomScreenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        const screenTrack = roomScreenStream.getVideoTracks()[0];
        if (!screenTrack) throw new Error('No screen track');

        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            await sender.replaceTrack(screenTrack);
        } else {
            peerConnection.addTrack(screenTrack, roomScreenStream);
            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);
            socket.emit('offer', { to: currentPeerId, offer: peerConnection.localDescription, sessionId: currentSessionId });
        }

        isSharingScreen = true;
        isPrivacyShieldOn = false;
        if (btn) {
            btn.innerHTML = '<i class="ph ph-monitor-slash"></i> Stop share';
            btn.classList.add('danger');
        }
        updatePrivacyButtonUI(true, false);
        showToast('Use "Hide" before opening sensitive apps while sharing.');
        screenTrack.onended = () => {
            if (isSharingScreen) toggleDirectScreenShare();
        };
    } catch (e) {
        console.error('Direct getDisplayMedia error:', e);
    }
}

function toggleScreenShare() {
    if (isRoomMode && roomId) {
        return toggleRoomScreenShare();
    }
    if (currentMode === 'audio' || currentMode === 'video') {
        return toggleDirectScreenShare();
    }
}

function createBlackTrack() {
    const canvas = document.createElement('canvas');
    canvas.width = 1280;
    canvas.height = 720;
    const ctx = canvas.getContext('2d');
    if (ctx) {
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
    }
    const stream = canvas.captureStream(5);
    return stream.getVideoTracks()[0] || null;
}

async function applySharedVideoTrack(track) {
    if (!track) return;
    if (isRoomMode && roomId) {
        for (const [peerId, pc] of roomPeerConnections) {
            const sender = roomScreenSenders.get(peerId) || pc.getSenders().find(s => s.track && s.track.kind === 'video');
            if (!sender) continue;
            try {
                await sender.replaceTrack(track);
            } catch (e) {
                console.error('applySharedVideoTrack(room) error:', e);
            }
        }
        return;
    }
    if (peerConnection) {
        const sender = peerConnection.getSenders().find(s => s.track && s.track.kind === 'video');
        if (sender) {
            try {
                await sender.replaceTrack(track);
            } catch (e) {
                console.error('applySharedVideoTrack(direct) error:', e);
            }
        }
    }
}

function updatePrivacyButtonUI(visible, active) {
    const btn = document.getElementById('tool-privacy');
    if (!btn) return;
    btn.style.display = visible ? '' : 'none';
    btn.innerHTML = active
        ? '<i class="ph ph-eye"></i> Show'
        : '<i class="ph ph-eye-slash"></i> Hide';
    btn.classList.toggle('danger', !!active);
}

async function setPrivacyShield(enable) {
    if (!isSharingScreen || !roomScreenStream) return;
    const screenTrack = roomScreenStream.getVideoTracks()[0];
    if (!screenTrack) return;
    if (enable) {
        if (!privacyBlackTrack || privacyBlackTrack.readyState === 'ended') {
            privacyBlackTrack = createBlackTrack();
        }
        if (!privacyBlackTrack) return;
        await applySharedVideoTrack(privacyBlackTrack);
        isPrivacyShieldOn = true;
        updatePrivacyButtonUI(true, true);
    } else {
        await applySharedVideoTrack(screenTrack);
        isPrivacyShieldOn = false;
        updatePrivacyButtonUI(true, false);
    }
}

function togglePrivacyShield() {
    return setPrivacyShield(!isPrivacyShieldOn);
}

function handleRoomChatMessage(data) {
    clearIncomingTypingMessage();
    if (!isChatOpen) {
        unreadChatCount += 1;
        updateUnreadChatBadge();
    }
    displayMessage(data.message, 'received', { senderName: getRoomParticipantNameById(data?.from) });
    markMessageSeen(data?.message?.messageId);
}

function handleRoomTyping(data) {
    if (typingIndicator) {
        typingIndicator.textContent = data.isTyping ? 'Someone is typing...' : '';
    }
    if (data.isTyping) {
        showIncomingTypingMessage('Typing...');
    } else {
        clearIncomingTypingMessage();
    }
    showTypingPopup(data.isTyping ? 'Typing...' : 'Stopped typing');
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
        purpose: document.getElementById('purpose').value || 'casual'
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
        const constraints = getMediaConstraints(mode);

        localStream = await navigator.mediaDevices.getUserMedia(constraints);
        console.log(`[CLIENT] Media permissions granted. Mode: ${mode}`);
        if (mode === 'video') {
            const v = localStream.getVideoTracks()[0];
            if (v) v.contentHint = 'detail';
        }

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
let chatContrastInterval = null;

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

function initAdaptiveChatContrast(videoElement) {
    if (chatContrastInterval) {
        clearInterval(chatContrastInterval);
        chatContrastInterval = null;
    }
    if (!videoElement) return;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    chatContrastInterval = setInterval(() => {
        if (!videoElement.videoWidth || !videoElement.videoHeight) return;
        if (videoElement.readyState < 2) return;

        canvas.width = Math.max(1, Math.floor(videoElement.videoWidth / 4));
        canvas.height = Math.max(1, Math.floor(videoElement.videoHeight / 4));

        try {
            ctx.drawImage(videoElement, 0, 0, canvas.width, canvas.height);
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const data = imageData.data;
            let brightnessAcc = 0;
            let samples = 0;

            for (let i = 0; i < data.length; i += 16) {
                const r = data[i];
                const g = data[i + 1];
                const b = data[i + 2];
                brightnessAcc += 0.2126 * r + 0.7152 * g + 0.0722 * b;
                samples++;
            }

            if (!samples) return;
            const avgBrightness = brightnessAcc / samples; // 0..255
            // Map brightness to shadow strength: darker -> lighter shadow, brighter -> stronger.
            const strength = Math.max(0.45, Math.min(0.9, 0.45 + (avgBrightness / 255) * 0.45));
            document.documentElement.style.setProperty('--chat-text-shadow-alpha', strength.toFixed(2));
            // Also adapt bubble background opacity for readability on bright video.
            const receivedBgAlpha = Math.max(0.12, Math.min(0.42, 0.12 + (avgBrightness / 255) * 0.30));
            const sentBgAlpha = Math.max(0.56, Math.min(0.88, 0.56 + (avgBrightness / 255) * 0.32));
            document.documentElement.style.setProperty('--chat-received-bg-alpha', receivedBgAlpha.toFixed(2));
            document.documentElement.style.setProperty('--chat-sent-bg-alpha', sentBgAlpha.toFixed(2));
            // Opposite-style text color against bright/dark video background.
            const textColor = avgBrightness > 145 ? '#0b1020' : '#ffffff';
            document.documentElement.style.setProperty('--chat-text-color', textColor);
        } catch (_e) {
            // Fail gracefully; keep existing shadow value
        }
    }, 1200);
}

function applyAdaptiveChatContrastFromContainer() {
    const chatContainer = document.getElementById('chatContainer');
    const style = chatContainer ? window.getComputedStyle(chatContainer) : null;
    const bg = (style && style.backgroundColor) ? style.backgroundColor : 'rgb(11, 16, 32)';
    const match = bg.match(/rgba?\(([^)]+)\)/i);
    if (!match) return;
    const parts = match[1].split(',').map(v => Number.parseFloat(v.trim()));
    const r = Number.isFinite(parts[0]) ? parts[0] : 11;
    const g = Number.isFinite(parts[1]) ? parts[1] : 16;
    const b = Number.isFinite(parts[2]) ? parts[2] : 32;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const textColor = luminance > 145 ? '#0b1020' : '#ffffff';
    document.documentElement.style.setProperty('--chat-text-color', textColor);
    document.documentElement.style.setProperty('--chat-text-shadow-alpha', luminance > 145 ? '0.35' : '0.75');
    document.documentElement.style.setProperty('--chat-received-bg-alpha', luminance > 145 ? '0.12' : '0.20');
    document.documentElement.style.setProperty('--chat-sent-bg-alpha', luminance > 145 ? '0.58' : '0.70');
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
    const message = data?.message || 'Waiting for a partner...';
    const details = `Queue: #${data?.position || '-'} of ${data?.totalInQueue || '-'}`;
    updateWaitingUI(message, details);
}

// Match found
async function handleMatchFound(data) {
    console.log('Match found!', data);

    currentSessionId = data.sessionId;
    currentPeerId = data.peerId;
    updateRoomIdBadge();
    updatePrivateRoomButtonsVisibility();

    // Start call timer
    window.__anonCallStartedAt = Date.now();
    startSessionTimer();

    if (peerNameEl) {
        peerNameEl.textContent = data.peerPreferences?.nickname || 'Stranger';
    }
    const remoteLabel = document.getElementById('remoteLabel');
    if (remoteLabel) {
        remoteLabel.textContent = data.peerPreferences?.nickname || 'Stranger';
    }
    const remoteAudioName = document.getElementById('remoteAudioName');
    if (remoteAudioName) {
        remoteAudioName.textContent = data.peerPreferences?.nickname || 'Stranger';
    }

    // Ensure local media exists on rematch after skip/leave transitions.
    const mediaReady = await ensureLocalMediaForMode(data.mode);
    if (!mediaReady) {
        showMainContent();
        return;
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
        setChatPanelState(false);
        if (sessionTopBar) sessionTopBar.classList.remove('hidden');
        if (sessionTopBarPeerName) sessionTopBarPeerName.textContent = data.peerPreferences?.nickname || 'Stranger';

        if (data.mode === 'audio') {
            document.querySelectorAll('.video-wrapper').forEach(el => el.style.background = '#2d3748');
            applyAdaptiveChatContrastFromContainer();
        }
        const screenShareBtn = document.getElementById('toggleScreenShareBtn');
        if (screenShareBtn) screenShareBtn.style.display = '';

        // Reset overlay for new session
        const overlay = document.getElementById('remoteMediaState');
        if (overlay) {
            overlay.style.display = 'flex';
            overlay.textContent = 'Waiting for partner...';
        }
    } else {
        mediaContainer.classList.add('hidden');
        chatLayout.classList.remove('has-media');
        setChatPanelState(true);
        if (sessionTopBar) sessionTopBar.classList.add('hidden');
        const screenShareBtn = document.getElementById('toggleScreenShareBtn');
        if (screenShareBtn) screenShareBtn.style.display = 'none';
        applyAdaptiveChatContrastFromContainer();
    }

    // ISSUE 3 FIX: Show/hide toolbar buttons based on mode
    const toolMic = document.getElementById('tool-mic');
    const toolCam = document.getElementById('tool-cam');
    const toolChat = document.getElementById('tool-chat');
    const chatToggleBtn = document.getElementById('chatToggleBtn');
    const mobileSkip = document.getElementById('tool-skip-mobile');
    const mobileLeave = document.getElementById('tool-leave-mobile');

    if (data.mode === 'text') {
        // Text mode: hide media controls
        if (toolMic) toolMic.style.display = 'none';
        if (toolCam) toolCam.style.display = 'none';
        if (toolChat) toolChat.style.display = 'none';
        if (chatToggleBtn) chatToggleBtn.style.display = 'none';
        if (mobileSkip) mobileSkip.style.display = 'none';
        if (mobileLeave) mobileLeave.style.display = 'none';
        updatePrivacyButtonUI(false, false);
    } else {
        // Audio/Video mode: show all controls
        if (toolMic) toolMic.style.display = '';
        if (toolCam) toolCam.style.display = data.mode === 'video' ? '' : 'none';
        if (toolChat) toolChat.style.display = '';
        if (chatToggleBtn) chatToggleBtn.style.display = '';
        if (mobileSkip) mobileSkip.style.display = '';
        if (mobileLeave) mobileLeave.style.display = '';
        updatePrivacyButtonUI(isSharingScreen, isPrivacyShieldOn);
    }

    showChatScreen();
    updatePrivateRoomButtonsVisibility();
    if (data.mode === 'audio') {
        setTimeout(startSpeakerWatch, 250);
    } else {
        stopSpeakerWatch();
    }
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
        tuneSenderQuality(peerConnection);
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
            initAdaptiveChatContrast(remoteVideo);
        }
        const remoteAudioEl = document.getElementById('remoteAudio');
        if (remoteAudioEl) {
            remoteAudioEl.srcObject = stream;
            remoteAudioEl.play().catch(() => {});
        }
        if (currentMode === 'audio') {
            setTimeout(startSpeakerWatch, 120);
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

function tuneSenderQuality(pc) {
    if (!pc) return;
    pc.getSenders().forEach((sender) => {
        if (!sender.track || sender.track.kind !== 'video' || typeof sender.getParameters !== 'function') return;
        try {
            const params = sender.getParameters() || {};
            if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
            params.encodings[0].maxBitrate = 2_500_000;
            params.encodings[0].maxFramerate = 30;
            params.degradationPreference = 'maintain-resolution';
            sender.setParameters(params).catch(() => {});
        } catch (_e) {
            // Ignore browser-specific limitations.
        }
    });
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

function setChatPanelState(open) {
    isChatOpen = !!open;
    const chatContainer = document.getElementById('chatContainer');
    const chatLayout = document.querySelector('.chat-layout');
    if (chatContainer) {
        chatContainer.classList.toggle('chat-collapsed', !isChatOpen);
    }
    if (chatLayout) {
        chatLayout.classList.toggle('chat-hidden', !isChatOpen);
    }
    if (isChatOpen) {
        unreadChatCount = 0;
        updateUnreadChatBadge();
        flushPendingSeenMessages();
    }
}

function toggleChatPanel() {
    setChatPanelState(!isChatOpen);
}

// Chat functions
function sendMessage(type = 'text', content = null) {
    closeMediaToolsMenu();
    closeAllPickers();
    let payload = { type, content, messageId: createMessageId() };

    if (type === 'text') {
        const message = messageInput.value.trim();
        if (!message) return;
        payload.content = message;
        messageInput.value = '';
    }

    // Display own message locally
    displayMessage(payload, 'sent', { status: 'sent' });
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

function triggerImageUpload() {
    closeMediaToolsMenu();
    closeAllPickers();
    const input = document.getElementById('imageUploadInput');
    if (input) input.click();
}

function handleImageUpload(event) {
    const file = event?.target?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
        showConnectionToast('Only image files are allowed.');
        event.target.value = '';
        return;
    }
    // Limit upload payload to keep socket chat responsive.
    const maxBytes = 2 * 1024 * 1024; // 2MB
    if (file.size > maxBytes) {
        showConnectionToast('Image too large. Max 2MB.');
        event.target.value = '';
        return;
    }

    const reader = new FileReader();
    reader.onload = () => {
        const dataUrl = reader.result;
        if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
            sendMessage('image', dataUrl);
        } else {
            showConnectionToast('Failed to read image.');
        }
        event.target.value = '';
    };
    reader.onerror = () => {
        showConnectionToast('Failed to read image.');
        event.target.value = '';
    };
    reader.readAsDataURL(file);
}

function handleIncomingMessage(data) {
    clearIncomingTypingMessage();
    if (!isChatOpen) {
        unreadChatCount += 1;
        updateUnreadChatBadge();
    }
    // Handle both new payloads and legacy data objects seamlessly
    displayMessage(data.message, 'received');
    markMessageSeen(data?.message?.messageId);
}

function updateUnreadChatBadge() {
    const targets = [
        document.getElementById('tool-chat'),
        document.getElementById('chatToggleBtn')
    ].filter(Boolean);
    const hasUnread = unreadChatCount > 0;
    targets.forEach((el) => {
        el.classList.toggle('has-unread', hasUnread);
        if (hasUnread) {
            el.setAttribute('data-unread', String(Math.min(unreadChatCount, 99)));
        } else {
            el.removeAttribute('data-unread');
        }
    });
}

function clearSpeakerHighlights() {
    document.querySelector('.video-item.local')?.classList.remove('speaking');
    document.querySelector('.video-item.remote')?.classList.remove('speaking');
}

function stopSpeakerWatch() {
    if (speakerWatchInterval) {
        clearInterval(speakerWatchInterval);
        speakerWatchInterval = null;
    }
    try { localSpeakerSource?.disconnect(); } catch (_e) {}
    try { remoteSpeakerSource?.disconnect(); } catch (_e) {}
    try { localSpeakerAnalyser?.disconnect(); } catch (_e) {}
    try { remoteSpeakerAnalyser?.disconnect(); } catch (_e) {}
    localSpeakerSource = null;
    remoteSpeakerSource = null;
    localSpeakerAnalyser = null;
    remoteSpeakerAnalyser = null;
    if (speakerAudioContext) {
        speakerAudioContext.close().catch(() => {});
        speakerAudioContext = null;
    }
    localSpeechHoldMs = 0;
    remoteSpeechHoldMs = 0;
    clearSpeakerHighlights();
}

function getAudioLevel(analyser) {
    if (!analyser) return 0;
    const arr = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(arr);
    let sum = 0;
    for (let i = 0; i < arr.length; i += 2) sum += arr[i];
    return sum / (arr.length / 2);
}

function attachSpeakerAnalyser(stream, type) {
    if (!stream || !speakerAudioContext) return;
    const audioTrack = stream.getAudioTracks && stream.getAudioTracks()[0];
    if (!audioTrack) return;
    try {
        const source = speakerAudioContext.createMediaStreamSource(stream);
        const analyser = speakerAudioContext.createAnalyser();
        analyser.fftSize = 256;
        analyser.smoothingTimeConstant = 0.7;
        source.connect(analyser);
        if (type === 'local') {
            localSpeakerSource = source;
            localSpeakerAnalyser = analyser;
        } else {
            remoteSpeakerSource = source;
            remoteSpeakerAnalyser = analyser;
        }
    } catch (_e) {}
}

function startSpeakerWatch() {
    if (currentMode !== 'audio') {
        stopSpeakerWatch();
        return;
    }
    if (!speakerAudioContext) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        speakerAudioContext = new Ctx();
    }
    if (!localSpeakerAnalyser && localStream) {
        attachSpeakerAnalyser(localStream, 'local');
    }
    const remoteAudioEl = document.getElementById('remoteAudio');
    if (!remoteSpeakerAnalyser && remoteAudioEl?.srcObject) {
        attachSpeakerAnalyser(remoteAudioEl.srcObject, 'remote');
    }
    if (speakerWatchInterval) return;
    speakerWatchInterval = setInterval(() => {
        if (currentMode !== 'audio') {
            stopSpeakerWatch();
            return;
        }
        const localLvl = getAudioLevel(localSpeakerAnalyser);
        const remoteLvl = getAudioLevel(remoteSpeakerAnalyser);
        const threshold = 18;
        const holdDuration = 520;
        const tickMs = 180;

        if (localLvl > threshold && localLvl >= remoteLvl * 0.9) {
            localSpeechHoldMs = holdDuration;
        } else {
            localSpeechHoldMs = Math.max(0, localSpeechHoldMs - tickMs);
        }
        if (remoteLvl > threshold && remoteLvl >= localLvl * 0.9) {
            remoteSpeechHoldMs = holdDuration;
        } else {
            remoteSpeechHoldMs = Math.max(0, remoteSpeechHoldMs - tickMs);
        }

        const localSpeaking = localSpeechHoldMs > 0 && localLvl >= remoteLvl * 0.65;
        const remoteSpeaking = remoteSpeechHoldMs > 0 && remoteLvl >= localLvl * 0.65;
        document.querySelector('.video-item.local')?.classList.toggle('speaking', localSpeaking);
        document.querySelector('.video-item.remote')?.classList.toggle('speaking', remoteSpeaking);
    }, 180);
}

function updateSentMessageStatus(messageId, status) {
    const statusEl = sentMessageStatus.get(messageId);
    if (!statusEl) return;
    statusEl.classList.remove('status-sent', 'status-delivered', 'status-seen');
    if (status === 'seen') {
        statusEl.textContent = '✓✓';
        statusEl.classList.add('status-seen');
        return;
    }
    if (status === 'delivered' && statusEl.textContent !== '✓✓') {
        statusEl.textContent = '✓✓';
        statusEl.classList.add('status-delivered');
    }
}

function markMessageSeen(messageId) {
    if (!messageId) return;
    if (!isChatOpen) {
        pendingSeenMessageIds.add(messageId);
        return;
    }
    if (isRoomMode && roomId) {
        socket.emit('room-message-seen', { roomId, messageId });
    } else if (currentPeerId && currentSessionId) {
        socket.emit('message-seen', { to: currentPeerId, sessionId: currentSessionId, messageId });
    }
}

function flushPendingSeenMessages() {
    if (!pendingSeenMessageIds.size) return;
    [...pendingSeenMessageIds].forEach((messageId) => {
        markMessageSeen(messageId);
        pendingSeenMessageIds.delete(messageId);
    });
}

function displayMessage(payload, type, meta = {}) {
    const messageEl = document.createElement('div');
    messageEl.className = `message ${type}`;

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
            case 'image':
                contentHtml = `<div class="image-message"><img src="${payload.content}" alt="Image"></div>`;
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

    const statusHtml = type === 'sent'
        ? `<div class="message-status status-sent">✓</div>`
        : '';
    const senderHtml = type === 'received' && meta?.senderName
        ? `<div class="message-sender">${escapeHtml(meta.senderName)}</div>`
        : '';
    messageEl.innerHTML = `
        ${senderHtml}
        <div class="message-content">${contentHtml}</div>
        ${statusHtml}
    `;

    messagesContainer.appendChild(messageEl);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    if (type === 'sent' && payload?.messageId) {
        const statusEl = messageEl.querySelector('.message-status');
        if (statusEl) {
            sentMessageStatus.set(payload.messageId, statusEl);
        }
    }
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
        typingIndicator.textContent = `${data.from} is typing...`;
        showIncomingTypingMessage('Typing...');
    } else {
        typingIndicator.textContent = '';
        clearIncomingTypingMessage();
    }
    showTypingPopup(data.isTyping ? 'Typing...' : 'Stopped typing');
}

function showTypingPopup(text) {
    const popup = document.getElementById('typingPopup');
    if (!popup) return;
    popup.textContent = text;
    popup.classList.remove('hidden');
    if (typingPopupTimeout) {
        clearTimeout(typingPopupTimeout);
        typingPopupTimeout = null;
    }
    typingPopupTimeout = setTimeout(() => {
        popup.classList.add('hidden');
    }, 1400);
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
    isPrivacyShieldOn = false;
    if (privacyBlackTrack && privacyBlackTrack.readyState !== 'ended') {
        privacyBlackTrack.stop();
    }
    privacyBlackTrack = null;
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
    updatePrivacyButtonUI(false, false);
    closeMediaToolsMenu();
    const mobileSkip = document.getElementById('tool-skip-mobile');
    const mobileLeave = document.getElementById('tool-leave-mobile');
    if (mobileSkip) mobileSkip.style.display = 'none';
    if (mobileLeave) mobileLeave.style.display = 'none';

    const sessionTopBar = document.getElementById('sessionTopBar');
    if (sessionTopBar) sessionTopBar.classList.add('hidden');
    setChatPanelState(true);
    unreadChatCount = 0;
    updateUnreadChatBadge();
    pendingSeenMessageIds.clear();
    sentMessageStatus.clear();
    resetNoteAiState();
    stopSpeakerWatch();
    const typingPopup = document.getElementById('typingPopup');
    if (typingPopup) typingPopup.classList.add('hidden');

    messagesContainer.innerHTML = '<div class="system-message info">You are now chatting with a random stranger. Say hi!</div>';
    typingIndicator.textContent = '';
    incomingTypingMessageEl = null;

    currentSessionId = null;
    currentPeerId = null;

    isRoomMode = false;
    closeParticipantsPanel();
    roomId = null;
    roomParticipants = [];
    roomRemoteStreams.clear();
    roomActivePeerId = null;
    stopRoomSpeakerWatch();
    roomPeerConnections.forEach(pc => { try { pc.close(); } catch (e) {} });
    roomPeerConnections.clear();
    roomScreenSenders.clear();
    updateNoteAiControlsVisibility();
    createdRoomId = null;
    const privateRoomCreated = document.getElementById('privateRoomCreated');
    if (privateRoomCreated) privateRoomCreated.classList.add('hidden');

    if (brightnessInterval) {
        clearInterval(brightnessInterval);
        brightnessInterval = null;
    }

    if (chatContrastInterval) {
        clearInterval(chatContrastInterval);
        chatContrastInterval = null;
    }
    document.documentElement.style.setProperty('--chat-text-shadow-alpha', '0.55');
    document.documentElement.style.setProperty('--chat-received-bg-alpha', '0.12');
    document.documentElement.style.setProperty('--chat-sent-bg-alpha', '0.60');
    document.documentElement.style.setProperty('--chat-text-color', '#ffffff');

    if (sessionTimerInterval) {
        clearInterval(sessionTimerInterval);
        sessionTimerInterval = null;
        const timerEl = document.getElementById('sessionTimer');
        if (timerEl) timerEl.textContent = '00:00';
    }

    // Hide media container if not in video/audio match anyway
    document.getElementById('mediaContainer').classList.add('hidden');
    const chatLayout = document.querySelector('.chat-layout');
    if (chatLayout) {
        chatLayout.classList.remove('room-mode');
        chatLayout.style.removeProperty('--room-chat-size');
        chatLayout.style.removeProperty('--room-chat-size-vh');
    }
    updateRoomIdBadge();
    updatePrivateRoomButtonsVisibility();
    renderRoomVideoLayout();

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

function toggleEmojiPicker() {
    closeMediaToolsMenu();
    const emojiContainer = document.getElementById('emojiPickerContainer');
    const isOpening = emojiContainer?.classList.contains('hidden');
    if (!emojiContainer) return;
    if (isOpening) {
        const bridge = window.EmojiMartBridge;
        if (!bridge || typeof bridge.mountEmojiMart !== 'function') {
            showConnectionToast('Emoji picker failed to load.');
            return;
        }
        const mounted = bridge.mountEmojiMart('emojiMartMount', (emoji) => {
            const chosen = emoji?.native || '';
            if (chosen && messageInput) {
                messageInput.value += chosen;
                messageInput.focus();
            }
            closeAllPickers();
        });
        if (!mounted) {
            showConnectionToast('Emoji picker failed to initialize.');
            return;
        }
    }
    emojiContainer.classList.toggle('hidden');
    document.getElementById('gifPickerContainer').classList.add('hidden');
    document.getElementById('stickerPickerContainer').classList.add('hidden');
}

// 2. GIF Picker (Tenor API)
const TENOR_API_KEY = 'LIVDSRZULELA'; // Standard public test key

function toggleGifPicker() {
    closeMediaToolsMenu();
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
        ? `https://g.tenor.com/v1/trending?key=${TENOR_API_KEY}&limit=24`
        : `https://g.tenor.com/v1/search?q=${query}&key=${TENOR_API_KEY}&limit=24`;

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
                closeAllPickers();
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

// 3. Stickers (dynamic source via Tenor)
let stickerTimeout = null;

async function fetchStickers(query) {
    const url = query === 'trending'
        ? `https://g.tenor.com/v1/featured?key=${TENOR_API_KEY}&limit=30&contentfilter=medium&media_filter=tinygif`
        : `https://g.tenor.com/v1/search?q=${encodeURIComponent(query)}&key=${TENOR_API_KEY}&limit=30&contentfilter=medium&media_filter=tinygif`;

    try {
        const response = await fetch(url);
        const data = await response.json();
        const grid = document.getElementById('stickerGrid');
        if (!grid) return;
        grid.innerHTML = '';

        (data.results || []).forEach((item) => {
            const media = item?.media?.[0];
            const imgUrl = media?.tinygif?.url || media?.nanogif?.url || media?.gif?.url;
            if (!imgUrl) return;
            const img = document.createElement('img');
            img.src = imgUrl;
            img.className = 'picker-item sticker-item';
            img.onclick = () => {
                sendMessage('sticker', imgUrl);
                closeAllPickers();
            };
            grid.appendChild(img);
        });
    } catch (e) {
        console.error('Error fetching stickers', e);
    }
}

function toggleStickerPicker() {
    closeMediaToolsMenu();
    const stickerContainer = document.getElementById('stickerPickerContainer');
    stickerContainer.classList.toggle('hidden');
    document.getElementById('emojiPickerContainer').classList.add('hidden');
    document.getElementById('gifPickerContainer').classList.add('hidden');

    const grid = document.getElementById('stickerGrid');
    const stickerSearchInput = document.getElementById('stickerSearchInput');
    if (!stickerContainer.classList.contains('hidden') && grid && grid.innerHTML === '') {
        fetchStickers('trending');
    }
    if (stickerContainer.classList.contains('hidden') && stickerSearchInput) {
        stickerSearchInput.value = '';
    }
}

function searchStickers(event) {
    clearTimeout(stickerTimeout);
    stickerTimeout = setTimeout(() => {
        const query = event?.target?.value?.trim() || '';
        fetchStickers(query || 'trending');
    }, 350);
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
        const recordingIndicator = document.getElementById('recordingIndicator');
        if (recordingIndicator) recordingIndicator.classList.remove('hidden');
        const voiceBtn = document.getElementById('voiceBtn');
        if (voiceBtn) voiceBtn.style.background = '#ef4444';

    } catch (err) {
        console.error("Microphone denied", err);
    }
}

function stopVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        mediaRecorder.stop();
        const recordingIndicator = document.getElementById('recordingIndicator');
        if (recordingIndicator) recordingIndicator.classList.add('hidden');
        const voiceBtn = document.getElementById('voiceBtn');
        if (voiceBtn) voiceBtn.style.background = '';
    }
}

function cancelVoiceRecording() {
    if (mediaRecorder && mediaRecorder.state === 'recording') {
        cancelPendingVoice = true;
        mediaRecorder.stop();
        const recordingIndicator = document.getElementById('recordingIndicator');
        if (recordingIndicator) recordingIndicator.classList.add('hidden');
        const voiceBtn = document.getElementById('voiceBtn');
        if (voiceBtn) voiceBtn.style.background = '';
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
        updateWaitingUI('Attempting to reconnect...', 'Trying to restore your last chat.');
        showWaitingScreen();
    }
}
