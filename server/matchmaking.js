const crypto = require('crypto');

/**
 * PRODUCTION MATCHMAKING WITH GRACEFUL REDIS FALLBACK
 * Uses Redis when available, falls back to in-memory queues otherwise.
 * This ensures the server works on Render free tier (no Redis) AND scales with Redis.
 */

// In-memory fallback queues (used when Redis is unavailable)
const memQueues = { text: [], audio: [], video: [] };
const memReconnect = new Map();

// ─── Helpers: Queue abstraction layer ───────────────────────────
async function queuePush(mode, userStr, redis) {
    if (redis) {
        await redis.lPush(`queue:${mode}`, userStr);
    } else {
        memQueues[mode].push(userStr);
    }
}

async function queuePop(mode, redis) {
    if (redis) {
        return await redis.rPop(`queue:${mode}`);
    } else {
        return memQueues[mode].length > 0 ? memQueues[mode].shift() : null;
    }
}

async function queuePushBack(mode, userStr, redis) {
    if (redis) {
        await redis.rPush(`queue:${mode}`, userStr);
    } else {
        memQueues[mode].unshift(userStr);
    }
}

async function queueGetAll(mode, redis) {
    if (redis) {
        return await redis.lRange(`queue:${mode}`, 0, -1);
    } else {
        return [...memQueues[mode]];
    }
}

async function queueRemove(mode, userStr, redis) {
    if (redis) {
        await redis.lRem(`queue:${mode}`, 0, userStr);
    } else {
        memQueues[mode] = memQueues[mode].filter(u => u !== userStr);
    }
}

async function setReconnect(socketId, data, redis) {
    if (redis) {
        await redis.set(`reconnect:${socketId}`, JSON.stringify(data), { EX: 60 });
    } else {
        memReconnect.set(socketId, data);
        setTimeout(() => memReconnect.delete(socketId), 60000);
    }
}

async function getReconnect(socketId, redis) {
    if (redis) {
        const d = await redis.get(`reconnect:${socketId}`);
        return d ? JSON.parse(d) : null;
    } else {
        return memReconnect.get(socketId) || null;
    }
}

async function delReconnect(socketId, redis) {
    if (redis) {
        await redis.del(`reconnect:${socketId}`);
    } else {
        memReconnect.delete(socketId);
    }
}

async function setSession(sessionId, session, redis) {
    if (redis) {
        await redis.set(`session:${sessionId}`, JSON.stringify(session), { EX: 3600 });
    }
}

async function getSession(sessionId, localSessions, redis) {
    let session = localSessions.get(sessionId);
    if (!session && redis) {
        const s = await redis.get(`session:${sessionId}`);
        if (s) session = JSON.parse(s);
    }
    return session;
}

async function delSession(sessionId, localSessions, redis) {
    localSessions.delete(sessionId);
    if (redis) {
        await redis.del(`session:${sessionId}`);
    }
}

// ─── Core matchmaking logic ────────────────────────────────────
async function initMatchmaking(io, socket, localSessions, redis) {

    socket.on('join-queue', async (data) => {
        const { mode, preferences } = data;

        if (!['text', 'audio', 'video'].includes(mode)) {
            socket.emit('error', { message: 'Invalid mode selected' });
            return;
        }

        const user = { id: socket.id, mode, preferences };
        const userStr = JSON.stringify(user);

        await removeFromAllQueues(socket.id, redis);
        await queuePush(mode, userStr, redis);
        console.log(`[SERVER] User ${socket.id} joined ${mode} queue`);

        await emitQueueUpdate(io, mode, redis);
        await tryMatch(io, mode, localSessions, redis);
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
        const recentData = await getReconnect(socket.id, redis);

        if (!recentData) {
            socket.emit('reconnect_failed', { message: 'Session expired or not found.' });
            return;
        }

        const { partnerId, mode } = recentData;
        const queue = await queueGetAll(mode, redis);
        const partnerEntry = queue.find(u => JSON.parse(u).id === partnerId);

        if (partnerEntry) {
            await queueRemove(mode, partnerEntry, redis);
            await delReconnect(socket.id, redis);
            const partner = JSON.parse(partnerEntry);
            const leaver = { id: socket.id, mode, preferences: {} };
            await forceMatch(io, leaver, partner, mode, localSessions, redis);
        } else {
            await delReconnect(socket.id, redis);
            socket.emit('reconnect_failed', { message: 'User is no longer available.' });
        }
    });
}

async function tryMatch(io, mode, localSessions, redis) {
    const user1Str = await queuePop(mode, redis);
    if (!user1Str) return;

    const user2Str = await queuePop(mode, redis);
    if (!user2Str) {
        await queuePushBack(mode, user1Str, redis);
        return;
    }

    const user1 = JSON.parse(user1Str);
    const user2 = JSON.parse(user2Str);
    await forceMatch(io, user1, user2, mode, localSessions, redis);
}

async function forceMatch(io, user1, user2, mode, localSessions, redis) {
    const sessionId = crypto.randomUUID();

    const session = {
        id: sessionId, mode, user1, user2,
        startTime: Date.now()
    };

    localSessions.set(sessionId, session);
    await setSession(sessionId, session, redis);

    // Join Socket.IO room
    const s1 = io.sockets.sockets.get(user1.id);
    const s2 = io.sockets.sockets.get(user2.id);
    if (s1) s1.join(sessionId);
    if (s2) s2.join(sessionId);

    const iceServers = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            // TURN server (uncomment and configure when deployed):
            // { urls: 'turn:YOUR_DOMAIN:3478', username: 'anonkonnect', credential: 'konnect-secret-2026' }
        ],
        iceCandidatePoolSize: 10,
    };

    io.to(user1.id).emit('matched', {
        sessionId, peerId: user2.id, mode,
        initiator: true, peerPreferences: user2.preferences || {}, iceServers
    });

    io.to(user2.id).emit('matched', {
        sessionId, peerId: user1.id, mode,
        initiator: false, peerPreferences: user1.preferences || {}, iceServers
    });

    console.log(`[SERVER] Users Matched! Session: ${sessionId} (${mode})`);
    await emitQueueUpdate(io, mode, redis);
}

async function terminateSession(socket, sessionId, type, io, localSessions, redis) {
    const session = await getSession(sessionId, localSessions, redis);
    if (!session) return;

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
        io.to(socket.id).emit('left-to-home', { partnerName: peerData.preferences?.nickname || 'Stranger' });
    } else if (type === 'disconnect') {
        io.to(peerId).emit('session:partner_left', { message: 'Your partner disconnected.' });
    }

    await delSession(sessionId, localSessions, redis);

    setTimeout(async () => {
        if (type === 'skip') {
            const queue = await queueGetAll(mode, redis);
            if (queue.length === 0) {
                await forceMatch(io, peerData, actionUserData, mode, localSessions, redis);
                return;
            }
        }

        await queuePush(mode, JSON.stringify(peerData), redis);
        io.to(peerId).emit('rejoining-queue');

        if (type === 'skip') {
            await queuePush(mode, JSON.stringify(actionUserData), redis);
            io.to(socket.id).emit('rejoining-queue');
        } else if (type === 'leave') {
            await setReconnect(socket.id, { partnerId: peerId, mode }, redis);
            console.log(`[SERVER] Reconnect window started for ${socket.id}`);
        }

        await emitQueueUpdate(io, mode, redis);
        await tryMatch(io, mode, localSessions, redis);
    }, 500);
}

async function emitQueueUpdate(io, mode, redis) {
    const queue = await queueGetAll(mode, redis);
    queue.forEach((userStr, index) => {
        const user = JSON.parse(userStr);
        io.to(user.id).emit('queue-update', {
            position: index + 1, totalInQueue: queue.length,
            message: `Waiting for a partner in ${mode} mode...`
        });
    });
}

async function removeFromAllQueues(socketId, redis) {
    for (const mode of ['text', 'audio', 'video']) {
        const queue = await queueGetAll(mode, redis);
        for (const userStr of queue) {
            if (JSON.parse(userStr).id === socketId) {
                await queueRemove(mode, userStr, redis);
            }
        }
    }
}

async function handleDisconnect(io, socket, localSessions, redis) {
    await removeFromAllQueues(socket.id, redis);

    for (const [sessionId, session] of localSessions.entries()) {
        if (session.user1.id === socket.id || session.user2.id === socket.id) {
            console.log(`[SERVER] Ending session ${sessionId} due to disconnect: ${socket.id}`);
            await terminateSession(socket, sessionId, 'disconnect', io, localSessions, redis);
            break;
        }
    }
}

module.exports = { initMatchmaking, handleDisconnect };
