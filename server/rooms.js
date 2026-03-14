/**
 * Private rooms: unique code, max 4 participants.
 * Create / join / leave by code; signaling uses roomId.
 */

const crypto = require('crypto');

const MAX_ROOM_PARTICIPANTS = 4;
const CODE_LENGTH = 8;
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

const rooms = new Map();

function generateCode() {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
    }
    if (rooms.has(code)) return generateCode();
    return code;
}

function getRoom(roomId) {
    return rooms.get(roomId) || null;
}

function isInRoom(roomId, socketId) {
    const room = rooms.get(roomId);
    if (!room) return false;
    return room.participants.some(p => p.id === socketId);
}

function initRooms(io, socket) {
    socket.on('create_private_room', (data) => {
        const { mode, preferences = {}, fromCall, peerId } = data || {};
        if (!['text', 'audio', 'video'].includes(mode)) {
            socket.emit('room_error', { message: 'Invalid mode' });
            return;
        }
        const code = generateCode();
        const roomId = code;
        const participant = { id: socket.id, preferences };
        const room = {
            mode,
            participants: [participant],
            createdAt: Date.now()
        };
        rooms.set(roomId, room);
        socket.join(roomId);
        io.to(socket.id).emit('room_created', { roomId, code });

        if (fromCall && peerId) {
            const peerSocket = io.sockets.sockets.get(peerId);
            if (peerSocket) {
                const invitePayload = {
                    roomId,
                    code,
                    message: 'You both have the same code. You can join this private call anytime using this ID. Max 4 people.'
                };
                io.to(socket.id).emit('private_room_invite', invitePayload);
                io.to(peerId).emit('private_room_invite', invitePayload);
            }
        }
        console.log(`[SERVER] Private room created: ${code} (${mode}), participants: ${room.participants.length}`);
    });

    socket.on('join_private_room', (data) => {
        const { code } = data || {};
        const roomId = (code || '').toString().trim().toUpperCase();
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('room_error', { message: 'Room not found or expired' });
            return;
        }
        if (room.participants.length >= MAX_ROOM_PARTICIPANTS) {
            socket.emit('room_error', { message: 'Room is full (max 4 people)' });
            return;
        }
        if (room.participants.some(p => p.id === socket.id)) {
            socket.emit('room_error', { message: 'Already in this room' });
            return;
        }
        const preferences = (data && data.preferences) || {};
        room.participants.push({ id: socket.id, preferences });
        socket.join(roomId);
        const participantList = room.participants.map(p => ({ id: p.id, preferences: p.preferences }));
        socket.emit('room_joined', { roomId, code: roomId, participants: participantList, mode: room.mode });
        socket.to(roomId).emit('participant_joined', {
            socketId: socket.id,
            preferences,
            participants: participantList
        });
        console.log(`[SERVER] User ${socket.id} joined room ${roomId}, total: ${room.participants.length}`);
    });

    socket.on('leave_private_room', (data) => {
        const { roomId } = data || {};
        const room = rooms.get(roomId);
        if (!room) return;
        const idx = room.participants.findIndex(p => p.id === socket.id);
        if (idx === -1) return;
        room.participants.splice(idx, 1)[0];
        socket.leave(roomId);
        if (room.participants.length === 0) {
            rooms.delete(roomId);
            console.log(`[SERVER] Room ${roomId} deleted (empty)`);
        } else {
            socket.to(roomId).emit('participant_left', { socketId: socket.id, participants: room.participants });
        }
    });

    socket.on('room_switch_mode', (data) => {
        const { roomId, mode } = data || {};
        if (!['text', 'audio', 'video'].includes(mode)) return;
        const room = rooms.get(roomId);
        if (!room || !room.participants.some(p => p.id === socket.id)) return;
        room.mode = mode;
        io.to(roomId).emit('room_mode_switched', { mode });
        console.log(`[SERVER] Room ${roomId} mode switched to ${mode}`);
    });
}

function getRoomsStore() {
    return rooms;
}

function handleRoomDisconnect(io, socketId) {
    for (const [roomId, room] of rooms.entries()) {
        const idx = room.participants.findIndex(p => p.id === socketId);
        if (idx !== -1) {
            room.participants.splice(idx, 1);
            if (room.participants.length === 0) {
                rooms.delete(roomId);
            } else {
                io.to(roomId).emit('participant_left', { socketId, participants: room.participants });
            }
            break;
        }
    }
}

module.exports = { initRooms, getRoom, isInRoom, getRoomsStore, handleRoomDisconnect };
