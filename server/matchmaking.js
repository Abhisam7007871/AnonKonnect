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
}

module.exports = { initMatchmaking, handleDisconnect };
