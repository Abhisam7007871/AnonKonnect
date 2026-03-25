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
}

module.exports = { initSignaling };
