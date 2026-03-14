function initSignaling(io, socket, sessions) {
    // 1. WebRTC Offer
    socket.on('offer', (data) => {
        const { to, offer, sessionId } = data;
        const session = sessions.get(sessionId);

        if (session && (session.user1.id === socket.id || session.user2.id === socket.id)) {
            // Forward offer to peer
            io.to(to).emit('offer', {
                from: socket.id,
                offer
            });
        }
    });

    // 2. WebRTC Answer
    socket.on('answer', (data) => {
        const { to, answer, sessionId } = data;
        const session = sessions.get(sessionId);

        if (session && (session.user1.id === socket.id || session.user2.id === socket.id)) {
            // Forward answer to peer
            io.to(to).emit('answer', {
                from: socket.id,
                answer
            });
        }
    });

    // 3. WebRTC ICE Candidates
    socket.on('ice-candidate', (data) => {
        const { to, candidate, sessionId } = data;
        const session = sessions.get(sessionId);

        if (session && (session.user1.id === socket.id || session.user2.id === socket.id)) {
            // Forward ICE candidate to peer
            io.to(to).emit('ice-candidate', {
                from: socket.id,
                candidate
            });
        }
    });

    // 4. Text Chat Messaging
    socket.on('chat-message', (data) => {
        const { to, message, sessionId } = data;
        const session = sessions.get(sessionId);

        if (session && (session.user1.id === socket.id || session.user2.id === socket.id)) {
            // Forward message to peer
            io.to(to).emit('chat-message', {
                from: socket.id,
                message,
                timestamp: Date.now()
            });
        }
    });

    // 5. Typing Indicators
    socket.on('typing', (data) => {
        const { to, isTyping, sessionId } = data;
        const session = sessions.get(sessionId);

        if (session && (session.user1.id === socket.id || session.user2.id === socket.id)) {
            // Forward typing indicator
            io.to(to).emit('typing', {
                from: socket.id,
                isTyping
            });
        }
    });
}

module.exports = {
    initSignaling
};
