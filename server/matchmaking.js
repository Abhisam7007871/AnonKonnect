const crypto = require('crypto');

/**
 * PRODUCTION REDIS-BACKED MATCHMAKING
 * Uses Redis lists for queues and Redis hashes for session state.
 */

async function initMatchmaking(io, socket, localSessions, redis) {

    socket.on('join-queue', async (data) => {
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

        const queueKey = `queue:${mode}`;

        // 1. Ensure user isn't already in any queue (idempotency)
        await removeFromAllQueues(socket.id, redis);

        // 2. Add to Redis queue
        await redis.lPush(queueKey, JSON.stringify(user));
        console.log(`[SERVER] User ${socket.id} joined Redis queue ${mode}`);

        // 3. Update UI
        await emitQueueUpdate(io, mode, redis);

        // 4. Trigger match check
        tryMatch(io, mode, localSessions, redis);
    });

    socket.on('leave-queue', async () => {
        await removeFromAllQueues(socket.id, redis);
        console.log(`[SERVER] User ${socket.id} manually left queue`);
    });

    socket.on('skip', (data) => {
        console.log(`[SERVER] Skip triggered by ${socket.id} for session ${data.sessionId}`);
        terminateSession(socket, data.sessionId, 'skip', io, localSessions, redis);
    });

    socket.on('leave_session', (data) => {
        console.log(`[SERVER] Leave triggered by ${socket.id} for session ${data.sessionId}`);
        terminateSession(socket, data.sessionId, 'leave', io, localSessions, redis);
    });

    socket.on('reconnect_request', async () => {
        console.log(`[SERVER] Reconnect request from ${socket.id}`);

        const reconnectKey = `reconnect:${socket.id}`;
        const recentData = await redis.get(reconnectKey);

        if (!recentData) {
            socket.emit('reconnect_failed', { message: 'Session expired or not found.' });
            return;
        }

        const { partnerId, mode } = JSON.parse(recentData);
        const queueKey = `queue:${mode}`;

        // Check if partner is still in the queue
        const queue = await redis.lRange(queueKey, 0, -1);
        const partnerIndex = queue.findIndex(u => JSON.parse(u).id === partnerId);

        if (partnerIndex !== -1) {
            // Partner available! Pull them from Redis atomicity is tricky here without Lua, 
            // but for this scale LREM works.
            await redis.lRem(queueKey, 1, queue[partnerIndex]);
            await redis.del(reconnectKey);

            const partner = JSON.parse(queue[partnerIndex]);
            const leaver = { id: socket.id, mode, preferences: {} };

            forceMatch(io, leaver, partner, mode, localSessions, redis);
        } else {
            await redis.del(reconnectKey);
            socket.emit('reconnect_failed', { message: 'User is no longer available.' });
        }
    });
}

/**
 * Attempt to match two users in the same mode.
 * Uses Redis atomicity to prevent double-matching.
 */
async function tryMatch(io, mode, localSessions, redis) {
    const queueKey = `queue:${mode}`;

    // We try to pop 2 users. 
    // In a multi-server setup, we use RPOP to ensure only one server gets the users.
    const user1Str = await redis.rPop(queueKey);
    if (!user1Str) return;

    const user2Str = await redis.rPop(queueKey);
    if (!user2Str) {
        // Only one user found, put them back
        await redis.rPush(queueKey, user1Str);
        return;
    }

    const user1 = JSON.parse(user1Str);
    const user2 = JSON.parse(user2Str);

    forceMatch(io, user1, user2, mode, localSessions, redis);
}

async function forceMatch(io, user1, user2, mode, localSessions, redis) {
    const sessionId = crypto.randomUUID();

    const session = {
        id: sessionId,
        mode,
        user1,
        user2,
        startTime: Date.now()
    };

    // Store in Redis for distributed access if needed, 
    // though WebRTC signaling currently relies on local Socket instances.
    // We'll use localSessions for signaling lookups BUT Redis for global state.
    localSessions.set(sessionId, session);
    await redis.set(`session:${sessionId}`, JSON.stringify(session), { EX: 3600 });

    // Internal Socket.io room join (works across instances due to Redis Adapter)
    io.to(user1.id).socketsJoin(sessionId);
    io.to(user2.id).socketsJoin(sessionId);

    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            {
                urls: 'turn:YOUR_DOMAIN_OR_IP:3478',
                username: 'anonkonnect',
                credential: 'konnect-secret-2026'
            }
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

    console.log(`[SERVER] Users Matched! Session: ${sessionId} (${mode})`);
    emitQueueUpdate(io, mode, redis);
}

async function terminateSession(socket, sessionId, type, io, localSessions, redis) {
    const sessionStr = await redis.get(`session:${sessionId}`);
    const session = sessionStr ? JSON.parse(sessionStr) : localSessions.get(sessionId);

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

        localSessions.delete(sessionId);
        await redis.del(`session:${sessionId}`);

        // Re-queue logic
        setTimeout(async () => {
            await redis.lPush(`queue:${mode}`, JSON.stringify(peerData));
            io.to(peerId).emit('rejoining-queue');

            if (type === 'skip') {
                await redis.lPush(`queue:${mode}`, JSON.stringify(actionUserData));
                io.to(socket.id).emit('rejoining-queue');
            } else if (type === 'leave') {
                // Store reconnect window in Redis (60s)
                await redis.set(`reconnect:${socket.id}`, JSON.stringify({
                    partnerId: peerId,
                    mode: mode
                }), { EX: 60 });
                console.log(`[SERVER] Redis Reconnect window started for ${socket.id}`);
            }

            emitQueueUpdate(io, mode, redis);
            tryMatch(io, mode, localSessions, redis);
        }, 500);
    }
}

async function emitQueueUpdate(io, mode, redis) {
    const queueKey = `queue:${mode}`;
    const queue = await redis.lRange(queueKey, 0, -1);

    queue.forEach((userStr, index) => {
        const user = JSON.parse(userStr);
        io.to(user.id).emit('queue-update', {
            position: index + 1,
            totalInQueue: queue.length,
            message: `Waiting for a partner in ${mode} mode...`
        });
    });
}

async function removeFromAllQueues(socketId, redis) {
    const modes = ['text', 'audio', 'video'];
    for (const mode of modes) {
        const queueKey = `queue:${mode}`;
        const queue = await redis.lRange(queueKey, 0, -1);
        for (const userStr of queue) {
            if (JSON.parse(userStr).id === socketId) {
                await redis.lRem(queueKey, 0, userStr);
            }
        }
    }
}

async function handleDisconnect(io, socket, localSessions, redis) {
    await removeFromAllQueues(socket.id, redis);

    // Distributed session cleanup
    // Note: This is slightly expensive for many sessions, in prod we'd use a reverse map in Redis
    const keys = await redis.keys('session:*');
    for (const key of keys) {
        const sessionStr = await redis.get(key);
        const session = JSON.parse(sessionStr);
        if (session.user1.id === socket.id || session.user2.id === socket.id) {
            const sessionId = key.split(':')[1];
            terminateSession(socket, sessionId, 'disconnect', io, localSessions, redis);
        }
    }
}

module.exports = {
    initMatchmaking,
    handleDisconnect
};
