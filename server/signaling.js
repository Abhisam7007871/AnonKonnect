<<<<<<< HEAD
/**
 * SCALABLE SIGNALING HANDLER
 * Verifies session membership with graceful Redis fallback.
 */
const crypto = require('crypto');

const moderationCache = new Map();

function isImagePayload(message) {
    const type = message?.type;
    if (!type) return false;
    return type === 'gif' || type === 'sticker' || type === 'image';
}

function getModerationBlockMessage(reason) {
    if (reason === 'violent_image_blocked') {
        return 'Upload blocked. Violent or graphic images are banned on this website.';
    }
    if (reason === 'invalid_image') {
        return 'Upload failed. Please send a valid image.';
    }
    return 'Upload blocked. Nudity or explicit sexual content is banned on this website.';
}

async function moderateImagePayload(message) {
    if (!isImagePayload(message)) return { allowed: true };
    const imageUrl = message?.content;
    if (!imageUrl || typeof imageUrl !== 'string') return { allowed: false, reason: 'invalid_image' };
    const cacheKey = imageUrl.startsWith('data:image/')
        ? crypto.createHash('sha1').update(imageUrl).digest('hex')
        : imageUrl;
    if (moderationCache.has(cacheKey)) return moderationCache.get(cacheKey);

    const user = process.env.SIGHTENGINE_API_USER;
    const secret = process.env.SIGHTENGINE_API_SECRET;
    if (!user || !secret) {
        return { allowed: true, skipped: true };
    }

    try {
        let response;
        if (imageUrl.startsWith('data:image/')) {
            const commaIdx = imageUrl.indexOf(',');
            if (commaIdx <= 0) return { allowed: false, reason: 'invalid_image' };
            const meta = imageUrl.slice(5, commaIdx); // image/png;base64
            const mimeType = meta.split(';')[0] || 'image/jpeg';
            const base64 = imageUrl.slice(commaIdx + 1);
            const buffer = Buffer.from(base64, 'base64');
            const form = new FormData();
            form.append('models', 'nudity-2.1');
            form.append('api_user', user);
            form.append('api_secret', secret);
            form.append('media', new Blob([buffer], { type: mimeType }), `upload.${mimeType.split('/')[1] || 'jpg'}`);
            response = await fetch('https://api.sightengine.com/1.0/check.json', {
                method: 'POST',
                body: form
            });
        } else {
            const qs = new URLSearchParams({
                models: 'nudity-2.1',
                api_user: user,
                api_secret: secret,
                url: imageUrl
            });
            response = await fetch(`https://api.sightengine.com/1.0/check.json?${qs.toString()}`);
        }
        const data = await response.json();
        const sexual = Number(data?.nudity?.sexual_activity || 0);
        const explicit = Number(data?.nudity?.sexual_display || 0);
        const erotic = Number(data?.nudity?.erotica || 0);
        const raw = Number(data?.nudity?.very_suggestive || 0);
        const nsfwScore = Math.max(sexual, explicit, erotic, raw);
        const goreScore = Number(data?.gore?.prob || data?.gore?.probability || 0);
        const weaponScore = Number(data?.weapon?.prob || data?.weapon || 0);
        const violenceScore = Math.max(goreScore, weaponScore);
        const safeScore = Math.max(nsfwScore, violenceScore);

        const result = nsfwScore >= 0.45
            ? { allowed: false, reason: 'nsfw_image_blocked', score: nsfwScore }
            : violenceScore >= 0.5
                ? { allowed: false, reason: 'violent_image_blocked', score: violenceScore }
                : { allowed: true, score: safeScore };
        moderationCache.set(cacheKey, result);
        return result;
    } catch (_e) {
        return { allowed: true, skipped: true };
    }
}

function initSignaling(io, socket, localSessions, redis) {

    async function verifySession(sessionId, socketId) {
        // 1. Check local cache first
        let session = localSessions.get(sessionId);

        // 2. Check Redis if available and not found locally
        if (!session && redis) {
            try {
                const sessionStr = await redis.get(`session:${sessionId}`);
                if (sessionStr) session = JSON.parse(sessionStr);
            } catch (err) {
                console.warn('[SERVER] Redis session lookup failed:', err.message);
            }
        }

        if (session && (session.user1.id === socketId || session.user2.id === socketId)) {
            return session;
        }
        return null;
    }

    // 1. WebRTC Offer
    socket.on('offer', async (data) => {
        const { to, offer, sessionId } = data;
        const session = await verifySession(sessionId, socket.id);
        if (session) {
            io.to(to).emit('offer', { from: socket.id, offer });
        }
    });

    // 2. WebRTC Answer
    socket.on('answer', async (data) => {
        const { to, answer, sessionId } = data;
        const session = await verifySession(sessionId, socket.id);
        if (session) {
            io.to(to).emit('answer', { from: socket.id, answer });
        }
    });

    // 3. WebRTC ICE Candidates
    socket.on('ice-candidate', async (data) => {
        const { to, candidate, sessionId } = data;
        const session = await verifySession(sessionId, socket.id);
        if (session) {
            io.to(to).emit('ice-candidate', { from: socket.id, candidate });
        }
    });

    // 4. Text Chat Messaging
    socket.on('chat-message', async (data) => {
        const { to, message, sessionId } = data;
        const session = await verifySession(sessionId, socket.id);
        if (session) {
            const moderation = await moderateImagePayload(message);
            if (!moderation.allowed) {
                socket.emit('chat-message-blocked', {
                    reason: moderation.reason,
                    message: getModerationBlockMessage(moderation.reason)
                });
                return;
            }
            io.to(to).emit('chat-message', { from: socket.id, message, timestamp: Date.now() });
            if (message?.messageId) {
                io.to(socket.id).emit('chat-message-delivered', {
                    messageId: message.messageId,
                    sessionId,
                    to
                });
            }
        }
    });

    socket.on('message-seen', async (data) => {
        const { to, sessionId, messageId } = data || {};
        if (!messageId) return;
        const session = await verifySession(sessionId, socket.id);
        if (session) {
            io.to(to).emit('chat-message-seen', {
                messageId,
                by: socket.id,
                sessionId
            });
        }
    });

    // 5. Typing Indicators
    socket.on('typing', async (data) => {
        const { to, isTyping, sessionId } = data;
        const session = await verifySession(sessionId, socket.id);
        if (session) {
            io.to(to).emit('typing', { from: socket.id, isTyping });
        }
    });
=======
function initSignaling(io, socket, localSessions, redis) {
  async function verifySession(sessionId, socketId) {
    let session = localSessions.get(sessionId);

    if (!session && redis) {
      try {
        const sessionStr = await redis.get(`session:${sessionId}`);
        if (sessionStr) {
          session = JSON.parse(sessionStr);
        }
      } catch (error) {
        console.warn("[SERVER] Redis session lookup failed:", error.message);
      }
    }

    if (session && (session.user1.id === socketId || session.user2.id === socketId)) {
      return session;
    }

    return null;
  }

  socket.on("offer", async (data) => {
    const session = await verifySession(data.sessionId, socket.id);
    if (session) {
      io.to(data.to).emit("offer", {
        from: socket.id,
        offer: data.offer,
        sessionId: data.sessionId,
      });
    }
  });

  socket.on("answer", async (data) => {
    const session = await verifySession(data.sessionId, socket.id);
    if (session) {
      io.to(data.to).emit("answer", {
        from: socket.id,
        answer: data.answer,
        sessionId: data.sessionId,
      });
    }
  });

  socket.on("ice-candidate", async (data) => {
    const session = await verifySession(data.sessionId, socket.id);
    if (session) {
      io.to(data.to).emit("ice-candidate", {
        from: socket.id,
        candidate: data.candidate,
        sessionId: data.sessionId,
      });
    }
  });

  socket.on("chat-message", async (data) => {
    const session = await verifySession(data.sessionId, socket.id);
    if (session) {
      io.to(data.to).emit("chat-message", {
        from: socket.id,
        sessionId: data.sessionId,
        message: data.message,
      });
    }
  });

  socket.on("typing", async (data) => {
    const session = await verifySession(data.sessionId, socket.id);
    if (session) {
      io.to(data.to).emit("typing", { from: socket.id, isTyping: data.isTyping });
    }
  });

  socket.on("message-read", async (data) => {
    const session = await verifySession(data.sessionId, socket.id);
    if (session && data.messageId) {
      io.to(data.to).emit("message-read", {
        messageId: data.messageId,
        readAt: Date.now(),
      });
    }
  });
>>>>>>> d15c4d21d7788a0d467ee13ff7c6eaf594078490
}

module.exports = { initSignaling };
