/**
 * Signaling for private rooms: offer, answer, ICE, chat, typing.
 * Verifies room membership before forwarding.
 */

const { getRoom, isInRoom } = require('./rooms');

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
        const { message, roomId } = data || {};
        if (verifyRoom(roomId, socket.id)) {
            socket.to(roomId).emit('room-chat-message', {
                from: socket.id,
                message,
                timestamp: Date.now()
            });
        }
    });

    socket.on('room-typing', (data) => {
        const { isTyping, roomId } = data || {};
        if (verifyRoom(roomId, socket.id)) {
            socket.to(roomId).emit('room-typing', { from: socket.id, isTyping });
        }
    });
}

module.exports = { initRoomSignaling };
