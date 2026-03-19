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
}

module.exports = { initRoomSignaling };
