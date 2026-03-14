const crypto = require('crypto');

// In-memory queues
const queues = {
    text: [],
    audio: [],
    video: []
};

// Reconnect TTL storage
const recentSessions = new Map();

function initMatchmaking(io, socket, sessions) {
    socket.on('join-queue', (data) => {
        const { mode, preferences } = data;

        if (!['text', 'audio', 'video'].includes(mode)) {
            socket.emit('error', { message: 'Invalid mode selected' });
            return;
        }

        const user = {
            id: socket.id,
            mode,
            preferences
        };

        queues[mode].push(user);
        console.log(`User ${socket.id} joined ${mode} queue. Queue length: ${queues[mode].length}`);

        emitQueueUpdate(io, mode);
        tryMatch(io, mode, sessions);
    });

    socket.on('leave-queue', () => {
        removeFromAllQueues(socket.id);
        console.log(`User ${socket.id} manually left queue`);
    });

    socket.on('skip', (data) => {
        console.log(`[SERVER] Skip triggered by ${socket.id} for session ${data.sessionId}`);
        terminateSession(socket, data.sessionId, 'skip');
    });

    socket.on('leave_session', (data) => {
        console.log(`[SERVER] Leave triggered by ${socket.id} for session ${data.sessionId}`);
        terminateSession(socket, data.sessionId, 'leave');
    });

    socket.on('reconnect_request', () => {
        console.log(`[SERVER] Reconnect request from ${socket.id}`);
        const recent = recentSessions.get(socket.id);
        if (!recent) {
            socket.emit('reconnect_failed', { message: 'Session expired or not found.' });
            return;
        }

        const { partnerData, partnerId, mode, timeoutId } = recent;

        // Check if partner is currently in the waiting queue for that mode
        const partnerInQueueIndex = queues[mode].findIndex(u => u.id === partnerId);

        if (partnerInQueueIndex !== -1) {
            // Partner is available! Pull them from the queue
            clearTimeout(timeoutId);
            recentSessions.delete(socket.id);

            const partner = queues[mode].splice(partnerInQueueIndex, 1)[0];

            // The leaver needs to be reconstructed as a user object
            const leaver = {
                id: socket.id,
                mode: mode,
                preferences: {} // Assumed any preferences were default for now or we could store them
            };

            // Force match them instantly
            forceMatch(io, leaver, partner, mode, sessions);
        } else {
            // Partner is no longer in the queue (matched with someone else or disconnected)
            clearTimeout(timeoutId);
            recentSessions.delete(socket.id);
            socket.emit('reconnect_failed', { message: 'User is no longer available.' });
        }
    });

    function terminateSession(socket, sessionId, type) {
        const session = sessions.get(sessionId);

        if (session) {
            const isUser1 = session.user1.id === socket.id;
            const peerId = isUser1 ? session.user2.id : session.user1.id;
            const peerData = isUser1 ? session.user2 : session.user1;
            const actionUserData = isUser1 ? session.user1 : session.user2;
            const mode = session.mode;

            console.log(`[SERVER] Terminating session ${sessionId}. Type: ${type}`);

            if (type === 'skip') {
                io.to(peerId).emit('session:skip', { message: 'Your partner skipped. Searching for a new match...' });
                io.to(socket.id).emit('session:skip', { message: 'Skipping... Searching for a new match.', isSelfAction: true });
            } else if (type === 'leave') {
                io.to(peerId).emit('session:partner_left', { message: 'Your partner left the chat.' });
                const partnerName = peerData.preferences?.nickname || 'Stranger';
                io.to(socket.id).emit('left-to-home', { partnerName });
            } else if (type === 'disconnect') {
                io.to(peerId).emit('session:partner_left', { message: 'Your partner disconnected.' });
            }

            sessions.delete(sessionId);
            console.log(`[SERVER] Session ${sessionId} deleted from store.`);

            setTimeout(() => {
                queues[mode].push(peerData);
                io.to(peerId).emit('rejoining-queue');
                console.log(`[SERVER] User ${peerId} re-added to ${mode} queue.`);

                if (type === 'skip') {
                    queues[mode].push(actionUserData);
                    io.to(socket.id).emit('rejoining-queue');
                    console.log(`[SERVER] User ${socket.id} re-added to ${mode} queue after skip.`);
                } else if (type === 'leave') {
                    const timeoutId = setTimeout(() => {
                        recentSessions.delete(socket.id);
                        console.log(`[SERVER] Reconnect window expired for ${socket.id}`);
                    }, 60000);

                    recentSessions.set(socket.id, {
                        partnerData: peerData,
                        partnerId: peerId,
                        mode: mode,
                        timestamp: Date.now(),
                        timeoutId: timeoutId
                    });
                    console.log(`[SERVER] Reconnect window started for ${socket.id} (60s)`);
                }

                emitQueueUpdate(io, mode);
                tryMatch(io, mode, sessions);
            }, 500);
        }
    }
}

function tryMatch(io, mode, sessions) {
    const queue = queues[mode];

    if (queue.length >= 2) {
        const user1 = queue.shift();
        const user2 = queue.shift();

        const sessionId = crypto.randomUUID();

        const session = {
            id: sessionId,
            mode,
            user1,
            user2,
            startTime: Date.now()
        };

        sessions.set(sessionId, session);

        // Let them join a socket.io room for easy broadcasting (chatting)
        const socket1 = io.sockets.sockets.get(user1.id);
        const socket2 = io.sockets.sockets.get(user2.id);

        if (socket1) socket1.join(sessionId);
        if (socket2) socket2.join(sessionId);

        // Required TURN/STUN servers for WebRTC
        const iceServers = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ],
            iceCandidatePoolSize: 10,
        };

        // Notify User 1 (Initiator)
        io.to(user1.id).emit('matched', {
            sessionId,
            peerId: user2.id,
            mode,
            initiator: true,
            peerPreferences: user2.preferences,
            iceServers
        });

        // Notify User 2 (Receiver)
        io.to(user2.id).emit('matched', {
            sessionId,
            peerId: user1.id,
            mode,
            initiator: false,
            peerPreferences: user1.preferences,
            iceServers
        });

        console.log(`[SERVER] Users Matched! Session: ${sessionId} (${mode})`);
        emitQueueUpdate(io, mode); // Update remaining users in queue
    }
}

function forceMatch(io, user1, user2, mode, sessions) {
    const sessionId = crypto.randomUUID();

    const session = {
        id: sessionId,
        mode,
        user1,
        user2,
        startTime: Date.now()
    };

    sessions.set(sessionId, session);

    // Let them join a socket.io room for easy broadcasting (chatting)
    const socket1 = io.sockets.sockets.get(user1.id);
    const socket2 = io.sockets.sockets.get(user2.id);

    if (socket1) socket1.join(sessionId);
    if (socket2) socket2.join(sessionId);

    // Required TURN/STUN servers for WebRTC
    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        iceCandidatePoolSize: 10,
    };

    io.to(user1.id).emit('matched', {
        sessionId,
        peerId: user2.id,
        mode,
        initiator: true,
        peerPreferences: user2.preferences || {},
        iceServers
    });

    io.to(user2.id).emit('matched', {
        sessionId,
        peerId: user1.id,
        mode,
        initiator: false,
        peerPreferences: user1.preferences || {},
        iceServers
    });

    console.log(`[SERVER] Force Reconnected! Session: ${sessionId} (${mode})`);
    emitQueueUpdate(io, mode);
}

function emitQueueUpdate(io, mode) {
    const queue = queues[mode];
    queue.forEach((user, index) => {
        io.to(user.id).emit('queue-update', {
            position: index + 1,
            totalInQueue: queue.length,
            message: `Waiting for a partner in ${mode} mode...`
        });
    });
}

function removeFromAllQueues(socketId) {
    for (const mode in queues) {
        const initialLength = queues[mode].length;
        queues[mode] = queues[mode].filter(u => u.id !== socketId);
        // Only emit if someone was actually removed
        if (queues[mode].length < initialLength) {
            // In a real app we'd target only that mode, but io emit broadly is okay for small scale or pass mode
        }
    }
}

function handleDisconnect(io, socket, sessions) {
    // 1. Remove from all queues
    removeFromAllQueues(socket.id);

    // 2. Terminate active sessions
    for (const [sessionId, session] of sessions.entries()) {
        if (session.user1.id === socket.id || session.user2.id === socket.id) {
            console.log(`[SERVER] Ending session ${sessionId} due to user disconnect: ${socket.id}`);
            terminateSession(socket, sessionId, 'disconnect');
            break;
        }
    }
}

module.exports = {
    initMatchmaking,
    handleDisconnect,
    queues
};
