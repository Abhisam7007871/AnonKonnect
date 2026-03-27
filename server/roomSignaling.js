<<<<<<< HEAD
/**
 * Signaling for private rooms: offer, answer, ICE, chat, typing.
 * Verifies room membership before forwarding.
 */

const { getRoom, isInRoom } = require('./rooms');
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

function initRoomSignaling(io, socket) {
    function verifyRoom(roomId, socketId) {
        if (!roomId) return false;
        return isInRoom(roomId, socketId);
    }

    socket.on('room-offer', (data) => {
        const { to, offer, roomId } = data || {};
        if (verifyRoom(roomId, socket.id)) {
            io.to(to).emit('room-offer', { from: socket.id, offer, roomId });
        }
    });

    socket.on('room-answer', (data) => {
        const { to, answer, roomId } = data || {};
        if (verifyRoom(roomId, socket.id)) {
            io.to(to).emit('room-answer', { from: socket.id, answer, roomId });
        }
    });

    socket.on('room-ice-candidate', (data) => {
        const { to, candidate, roomId } = data || {};
        if (verifyRoom(roomId, socket.id)) {
            io.to(to).emit('room-ice-candidate', { from: socket.id, candidate, roomId });
        }
    });

    socket.on('room-chat-message', (data) => {
        (async () => {
            const { message, roomId } = data || {};
            if (verifyRoom(roomId, socket.id)) {
                const moderation = await moderateImagePayload(message);
                if (!moderation.allowed) {
                    socket.emit('chat-message-blocked', {
                        reason: moderation.reason,
                        message: getModerationBlockMessage(moderation.reason)
                    });
                    return;
                }
                socket.to(roomId).emit('room-chat-message', {
                    from: socket.id,
                    message,
                    timestamp: Date.now()
                });
                if (message?.messageId) {
                    socket.emit('room-chat-message-delivered', {
                        roomId,
                        messageId: message.messageId
                    });
                }
            }
        })();
    });

    socket.on('room-message-seen', (data) => {
        const { roomId, messageId } = data || {};
        if (!messageId) return;
        if (verifyRoom(roomId, socket.id)) {
            socket.to(roomId).emit('room-chat-message-seen', {
                roomId,
                messageId,
                by: socket.id
            });
        }
    });

    socket.on('room-typing', (data) => {
        const { isTyping, roomId } = data || {};
        if (verifyRoom(roomId, socket.id)) {
            socket.to(roomId).emit('room-typing', { from: socket.id, isTyping });
        }
    });
=======
const { getRoom, isRoomParticipant } = require("./rooms");
const { getPrisma } = require("./prisma");

const MAX_ROOM_MESSAGES = 100;

function toMessageKind(kind) {
  return {
    text: "TEXT",
    gif: "GIF",
    image: "IMAGE",
    sticker: "TEXT",
    voice: "VOICE",
    system: "SYSTEM",
  }[String(kind || "text").toLowerCase()] || "TEXT";
}

function initRoomSignaling(io, socket) {
  function verifyRoom(roomId) {
    return roomId && isRoomParticipant(roomId, socket.id);
  }

  socket.on("room_message", (data = {}) => {
    if (!verifyRoom(data.roomId) || !data.message) {
      return;
    }

    const room = getRoom(data.roomId);

    if (!room) {
      return;
    }

    room.messages.push(data.message);
    if (room.messages.length > MAX_ROOM_MESSAGES) {
      room.messages.shift();
    }

    const prisma = getPrisma();
    if (prisma) {
      prisma.roomMessage
        .create({
          data: {
            id: data.message.id,
            roomId: data.roomId,
            senderId: socket.user?.accessLevel === "registered" ? socket.user.id : null,
            senderName: data.message.senderName || socket.user?.nickname || "Anon",
            kind: toMessageKind(data.message.kind),
            content: String(data.message.content || ""),
            metadata: {
              timestamp: data.message.timestamp || Date.now(),
            },
          },
        })
        .catch((error) => {
          console.warn("[ROOM SIGNALING] Failed to persist room message:", error.message);
        });
    }

    socket.to(data.roomId).emit("room_message", {
      roomId: data.roomId,
      from: socket.id,
      message: data.message,
    });
  });

  socket.on("room_typing", (data = {}) => {
    if (!verifyRoom(data.roomId)) {
      return;
    }

    socket.to(data.roomId).emit("room_typing", {
      roomId: data.roomId,
      from: socket.id,
      isTyping: data.isTyping,
    });
  });

  socket.on("room_read", (data = {}) => {
    if (!verifyRoom(data.roomId) || !data.messageId) {
      return;
    }

    const prisma = getPrisma();
    if (prisma && socket.user?.accessLevel === "registered" && socket.user?.id) {
      prisma.roomMember
        .update({
          where: {
            roomId_userId: {
              roomId: data.roomId,
              userId: socket.user.id,
            },
          },
          data: {
            lastSeenAt: new Date(),
          },
        })
        .catch(() => {});
    }

    socket.to(data.roomId).emit("room_message_read", {
      roomId: data.roomId,
      messageId: data.messageId,
      readAt: Date.now(),
    });
  });
>>>>>>> d15c4d21d7788a0d467ee13ff7c6eaf594078490
}

module.exports = { initRoomSignaling };
