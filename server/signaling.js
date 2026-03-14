/**
 * SCALABLE SIGNALING HANDLER
 * Verifies session membership with graceful Redis fallback.
 */

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
            io.to(to).emit('chat-message', { from: socket.id, message, timestamp: Date.now() });
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
}

module.exports = { initSignaling };
