<<<<<<< HEAD
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
async function initMatchmaking(io, socket, localSessions, redis, analyticsHooks = {}) {

    socket.on('join-queue', async (data) => {
        const { mode, preferences } = data;

        if (!['text', 'audio', 'video'].includes(mode)) {
            socket.emit('error', { message: 'Invalid mode selected' });
            return;
        }

        const user = { id: socket.id, mode, preferences };
        const userStr = JSON.stringify(user);
        socket.data.profile = {
            userId: socket.id,
            nickname: preferences?.nickname || 'Stranger',
            gender: preferences?.gender || 'unspecified',
            purpose: preferences?.purpose || 'casual',
            mode
        };
        if (typeof analyticsHooks.recordAnalyticsProfile === 'function') {
            analyticsHooks.recordAnalyticsProfile(socket.data.profile, socket.data?.geo || null);
        }

        await removeFromAllQueues(socket.id, redis);
        await queuePush(mode, userStr, redis);
        const geo = socket.data?.geo || null;
        console.log('[USER_JOIN]', JSON.stringify({
            userId: socket.id,
            nickname: socket.data.profile.nickname,
            gender: socket.data.profile.gender,
            purpose: socket.data.profile.purpose,
            mode,
            geo
        }));

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

    const iceServerList = [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' }
    ];
    if (process.env.TURN_URL && process.env.TURN_USERNAME && process.env.TURN_CREDENTIAL) {
        iceServerList.push({
            urls: process.env.TURN_URL,
            username: process.env.TURN_USERNAME,
            credential: process.env.TURN_CREDENTIAL
        });
    }
    const iceServers = {
        iceServers: iceServerList,
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

    console.log('[MATCHED]', JSON.stringify({
        sessionId,
        mode,
        user1: {
            userId: user1.id,
            nickname: user1.preferences?.nickname || 'Stranger',
            gender: user1.preferences?.gender || 'unspecified',
            purpose: user1.preferences?.purpose || 'casual',
            geo: s1?.data?.geo || null
        },
        user2: {
            userId: user2.id,
            nickname: user2.preferences?.nickname || 'Stranger',
            gender: user2.preferences?.gender || 'unspecified',
            purpose: user2.preferences?.purpose || 'casual',
            geo: s2?.data?.geo || null
        }
    }));
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
        // Remaining user always goes back to queue.
        await queuePush(mode, JSON.stringify(peerData), redis);
        io.to(peerId).emit('rejoining-queue');

        if (type === 'skip') {
            // Skip means "find next partner"; skip actor also requeues.
            await queuePush(mode, JSON.stringify(actionUserData), redis);
            io.to(socket.id).emit('rejoining-queue');
        }

        // Leave actor is sent home (already emitted left-to-home) and is not requeued.
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
=======
const crypto = require("crypto");

const { allowsTier, getGeoTier, getStage, getStatusLabel } = require("./geo");

const memQueues = { text: [], audio: [], video: [] };
const memReconnect = new Map();
let tickerStarted = false;

async function queuePush(mode, userStr, redis) {
  if (redis) {
    await redis.rPush(`queue:${mode}`, userStr);
  } else {
    memQueues[mode].push(userStr);
  }
}

async function queueGetAll(mode, redis) {
  if (redis) {
    return await redis.lRange(`queue:${mode}`, 0, -1);
  }

  return [...memQueues[mode]];
}

async function queueRemove(mode, userStr, redis) {
  if (redis) {
    await redis.lRem(`queue:${mode}`, 0, userStr);
  } else {
    memQueues[mode] = memQueues[mode].filter((entry) => entry !== userStr);
  }
}

async function setReconnect(socketId, data, redis) {
  if (redis) {
    await redis.set(`reconnect:${socketId}`, JSON.stringify(data), { EX: 60 });
  } else {
    memReconnect.set(socketId, data);
    setTimeout(() => memReconnect.delete(socketId), 60_000);
  }
}

async function getReconnect(socketId, redis) {
  if (redis) {
    const data = await redis.get(`reconnect:${socketId}`);
    return data ? JSON.parse(data) : null;
  }

  return memReconnect.get(socketId) || null;
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
    const persisted = await redis.get(`session:${sessionId}`);
    if (persisted) {
      session = JSON.parse(persisted);
    }
  }

  return session;
}

async function delSession(sessionId, localSessions, redis) {
  localSessions.delete(sessionId);
  if (redis) {
    await redis.del(`session:${sessionId}`);
  }
}

function ensureTicker(io, localSessions, redis) {
  if (tickerStarted) {
    return;
  }

  tickerStarted = true;
  setInterval(async () => {
    for (const mode of ["text", "audio", "video"]) {
      await emitQueueUpdate(io, mode, redis);
      await tryMatch(io, mode, localSessions, redis);
    }
  }, 5000);
}

function buildCandidate(socketId, mode, profile) {
  return {
    id: socketId,
    mode,
    profile,
    joinedAt: Date.now(),
  };
}

function matchRank(tier) {
  return {
    country: 0,
    region: 1,
    global: 2,
  }[tier];
}

async function initMatchmaking(io, socket, localSessions, redis) {
  ensureTicker(io, localSessions, redis);

  socket.on("join-queue", async (data = {}) => {
    const { mode, profile = {} } = data;

    if (!["text", "audio", "video"].includes(mode)) {
      socket.emit("error", { message: "Invalid mode selected" });
      return;
    }

    const candidate = buildCandidate(socket.id, mode, profile);
    await removeFromAllQueues(socket.id, redis);
    await queuePush(mode, JSON.stringify(candidate), redis);
    await emitQueueUpdate(io, mode, redis);
    await tryMatch(io, mode, localSessions, redis);
  });

  socket.on("leave-queue", async () => {
    await removeFromAllQueues(socket.id, redis);
  });

  socket.on("skip", (data) => {
    terminateSession(socket, data.sessionId, "skip", io, localSessions, redis);
  });

  socket.on("leave_session", (data) => {
    terminateSession(socket, data.sessionId, "leave", io, localSessions, redis);
  });

  socket.on("reconnect_request", async () => {
    const recentData = await getReconnect(socket.id, redis);

    if (!recentData) {
      socket.emit("reconnect_failed", { message: "Session expired or not found." });
      return;
    }

    const queue = await queueGetAll(recentData.mode, redis);
    const partnerEntry = queue.find((entry) => JSON.parse(entry).id === recentData.partnerId);

    if (!partnerEntry) {
      await delReconnect(socket.id, redis);
      socket.emit("reconnect_failed", { message: "User is no longer available." });
      return;
    }

    await queueRemove(recentData.mode, partnerEntry, redis);
    await delReconnect(socket.id, redis);
    await forceMatch(
      io,
      buildCandidate(socket.id, recentData.mode, recentData.profile || {}),
      JSON.parse(partnerEntry),
      recentData.mode,
      localSessions,
      redis,
      "global",
    );
  });
}

async function tryMatch(io, mode, localSessions, redis) {
  const entries = (await queueGetAll(mode, redis))
    .map((raw) => ({ raw, user: JSON.parse(raw) }))
    .sort((left, right) => left.user.joinedAt - right.user.joinedAt);

  if (entries.length < 2) {
    return;
  }

  let chosen = null;
  const now = Date.now();

  for (let index = 0; index < entries.length; index += 1) {
    const left = entries[index];

    for (let inner = index + 1; inner < entries.length; inner += 1) {
      const right = entries[inner];
      const leftStage = getStage(now - left.user.joinedAt);
      const rightStage = getStage(now - right.user.joinedAt);
      const tier = getGeoTier(left.user.profile, right.user.profile);

      if (!allowsTier(leftStage, tier) || !allowsTier(rightStage, tier)) {
        continue;
      }

      const score =
        matchRank(tier) * 1_000_000 + Math.max(left.user.joinedAt, right.user.joinedAt);

      if (!chosen || score < chosen.score) {
        chosen = { left, right, tier, score };
      }
    }
  }

  if (!chosen) {
    return;
  }

  await queueRemove(mode, chosen.left.raw, redis);
  await queueRemove(mode, chosen.right.raw, redis);
  await forceMatch(
    io,
    chosen.left.user,
    chosen.right.user,
    mode,
    localSessions,
    redis,
    chosen.tier,
  );
  await emitQueueUpdate(io, mode, redis);
  await tryMatch(io, mode, localSessions, redis);
}

async function forceMatch(io, user1, user2, mode, localSessions, redis, matchTier) {
  const sessionId = crypto.randomUUID();
  const session = {
    id: sessionId,
    mode,
    user1,
    user2,
    matchTier,
    startTime: Date.now(),
  };

  localSessions.set(sessionId, session);
  await setSession(sessionId, session, redis);

  const socket1 = io.sockets.sockets.get(user1.id);
  const socket2 = io.sockets.sockets.get(user2.id);

  if (socket1) {
    socket1.join(sessionId);
  }
  if (socket2) {
    socket2.join(sessionId);
  }

  io.to(user1.id).emit("matched", {
    sessionId,
    peerId: user2.id,
    mode,
    matchTier,
    peerProfile: user2.profile,
  });
  io.to(user2.id).emit("matched", {
    sessionId,
    peerId: user1.id,
    mode,
    matchTier,
    peerProfile: user1.profile,
  });
}

async function terminateSession(socket, sessionId, type, io, localSessions, redis) {
  const session = await getSession(sessionId, localSessions, redis);

  if (!session) {
    return;
  }

  const isUser1 = session.user1.id === socket.id;
  const peerId = isUser1 ? session.user2.id : session.user1.id;
  const peerData = isUser1 ? session.user2 : session.user1;
  const actionUserData = isUser1 ? session.user1 : session.user2;

  if (type === "skip") {
    io.to(peerId).emit("session:skip", {
      message: "Your partner skipped. Searching for a new match...",
    });
    io.to(socket.id).emit("session:skip", {
      message: "Skipping... searching for a new match.",
      isSelfAction: true,
    });
  } else if (type === "leave" || type === "disconnect") {
    io.to(peerId).emit("session:partner_left", {
      message:
        type === "disconnect" ? "Your partner disconnected." : "Your partner left the chat.",
    });
  }

  await delSession(sessionId, localSessions, redis);

  setTimeout(async () => {
    await queuePush(session.mode, JSON.stringify(peerData), redis);
    io.to(peerId).emit("rejoining-queue");

    if (type === "skip") {
      await queuePush(session.mode, JSON.stringify(actionUserData), redis);
      io.to(socket.id).emit("rejoining-queue");
    } else if (type === "leave") {
      await setReconnect(
        socket.id,
        {
          partnerId: peerId,
          mode: session.mode,
          profile: actionUserData.profile,
        },
        redis,
      );
    }

    await emitQueueUpdate(io, session.mode, redis);
    await tryMatch(io, session.mode, localSessions, redis);
  }, 300);
}

async function emitQueueUpdate(io, mode, redis) {
  const queue = (await queueGetAll(mode, redis))
    .map((raw) => JSON.parse(raw))
    .sort((left, right) => left.joinedAt - right.joinedAt);

  const now = Date.now();

  queue.forEach((user, index) => {
    const waitMs = now - user.joinedAt;
    const stage = getStage(waitMs);
    const nextExpansionAt =
      stage === "country"
        ? user.joinedAt + 60_000
        : stage === "region"
          ? user.joinedAt + 120_000
          : null;
    const progressPercent =
      stage === "country"
        ? Math.min(100, (waitMs / 60_000) * 100)
        : stage === "region"
          ? Math.min(100, ((waitMs - 60_000) / 60_000) * 100)
          : 100;

    io.to(user.id).emit("queue-update", {
      position: index + 1,
      totalInQueue: queue.length,
      stage,
      nextExpansionAt,
      progressPercent,
      message: getStatusLabel(stage, user.profile?.country),
    });
  });
}

async function removeFromAllQueues(socketId, redis) {
  for (const mode of ["text", "audio", "video"]) {
    const queue = await queueGetAll(mode, redis);
    for (const entry of queue) {
      if (JSON.parse(entry).id === socketId) {
        await queueRemove(mode, entry, redis);
      }
    }
  }
}

async function handleDisconnect(io, socket, localSessions, redis) {
  await removeFromAllQueues(socket.id, redis);

  for (const [sessionId, session] of localSessions.entries()) {
    if (session.user1.id === socket.id || session.user2.id === socket.id) {
      await terminateSession(socket, sessionId, "disconnect", io, localSessions, redis);
      break;
    }
  }
>>>>>>> d15c4d21d7788a0d467ee13ff7c6eaf594078490
}

module.exports = { initMatchmaking, handleDisconnect };
