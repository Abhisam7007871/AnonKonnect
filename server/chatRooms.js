const crypto = require('crypto');

const ROOM_NAMESPACE = 'catalog:';
const MAX_ROOM_HISTORY = 60;

const catalogRooms = new Map();
const requestIndex = new Map();

function seedPublicRooms() {
    const seeds = [
        {
            id: 'public-us-lounge',
            slug: 'us-lounge',
            name: 'US Lounge',
            access: 'public',
            category: 'region',
            label: 'United States',
            description: 'Fast-moving conversations across the US.'
        },
        {
            id: 'public-uk-lounge',
            slug: 'uk-lounge',
            name: 'UK Lounge',
            access: 'public',
            category: 'region',
            label: 'United Kingdom',
            description: 'Regional chat for the UK crowd.'
        },
        {
            id: 'public-india-lounge',
            slug: 'india-lounge',
            name: 'India Lounge',
            access: 'public',
            category: 'region',
            label: 'India',
            description: 'Meet people across India in real time.'
        },
        {
            id: 'public-dating-cafe',
            slug: 'dating-cafe',
            name: 'Dating Cafe',
            access: 'public',
            category: 'interest',
            label: 'Dating',
            description: 'Flirty, respectful conversation starters.'
        },
        {
            id: 'public-friendship-hub',
            slug: 'friendship-hub',
            name: 'Friendship Hub',
            access: 'public',
            category: 'interest',
            label: 'Friendship',
            description: 'Low-pressure chat for making new friends.'
        },
        {
            id: 'public-night-owls',
            slug: 'night-owls',
            name: 'Night Owls',
            access: 'public',
            category: 'interest',
            label: 'Late Night',
            description: 'For people who are still online after hours.'
        }
    ];

    seeds.forEach((seed) => {
        catalogRooms.set(seed.id, {
            ...seed,
            members: new Map(),
            messages: []
        });
    });
}

seedPublicRooms();

function roomChannel(roomId) {
    return `${ROOM_NAMESPACE}${roomId}`;
}

function normalizeSlug(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32);
}

function getRoomBySlug(slug) {
    const normalized = normalizeSlug(slug);
    for (const room of catalogRooms.values()) {
        if (room.slug === normalized) return room;
    }
    return null;
}

function memberPayload(socket, profile = {}) {
    const isGuest = !!socket.user?.isGuest;
    return {
        id: socket.id,
        nickname: profile.nickname || socket.user?.nickname || (isGuest ? 'Guest' : 'Member'),
        isGuest,
        country: profile.country || socket.user?.country || '',
        purpose: profile.purpose || ''
    };
}

function roomSummary(room, viewerIsGuest) {
    const memberCount = room.members.size;
    const visibleName = viewerIsGuest ? 'Premium room' : room.name;
    return {
        id: room.id,
        slug: viewerIsGuest ? 'locked-room' : room.slug,
        name: visibleName,
        access: room.access,
        category: room.category,
        label: room.label,
        description: viewerIsGuest ? 'Register to reveal room details.' : room.description,
        memberCount
    };
}

function emitCatalog(io, socket) {
    const viewerIsGuest = !!socket.user?.isGuest;
    const publicRooms = [];

    for (const room of catalogRooms.values()) {
        if (room.access === 'public') {
            publicRooms.push(roomSummary(room, viewerIsGuest));
        }
    }

    socket.emit('rooms:list', {
        publicRooms,
        isGuest: viewerIsGuest
    });
}

function emitRoomState(io, room) {
    const members = Array.from(room.members.values());
    io.to(roomChannel(room.id)).emit('room:members', {
        roomId: room.id,
        members
    });
}

function joinCatalogRoom(io, socket, room, profile = {}) {
    const member = memberPayload(socket, profile);
    room.members.set(socket.id, member);
    socket.join(roomChannel(room.id));

    socket.emit('room:joined', {
        room: roomSummary(room, false),
        messages: room.messages,
        members: Array.from(room.members.values())
    });

    socket.to(roomChannel(room.id)).emit('room:system', {
        roomId: room.id,
        text: `${member.nickname} joined the room.`
    });

    emitRoomState(io, room);
}

function leaveRoom(io, socket, roomId, silent = false) {
    const room = catalogRooms.get(roomId);
    if (!room) return;

    const member = room.members.get(socket.id);
    if (!member) return;

    room.members.delete(socket.id);
    socket.leave(roomChannel(room.id));

    if (!silent) {
        socket.emit('room:left', { roomId: room.id });
        socket.to(roomChannel(room.id)).emit('room:system', {
            roomId: room.id,
            text: `${member.nickname} left the room.`
        });
    }

    emitRoomState(io, room);
}

function createHiddenRoom(io, socket, data) {
    if (socket.user?.isGuest) {
        socket.emit('room:error', { message: 'Register to create hidden private rooms.' });
        return;
    }

    const name = String(data?.name || '').trim().slice(0, 48);
    const slug = normalizeSlug(data?.slug || name);
    const description = String(data?.description || '').trim().slice(0, 120);

    if (!name || !slug) {
        socket.emit('room:error', { message: 'Private room name and slug are required.' });
        return;
    }

    if (getRoomBySlug(slug)) {
        socket.emit('room:error', { message: 'That private room slug is already taken.' });
        return;
    }

    const roomId = `private-${crypto.randomUUID()}`;
    const room = {
        id: roomId,
        slug,
        name,
        access: 'private',
        category: 'private',
        label: 'Private',
        description: description || 'Hidden room with member approval.',
        members: new Map(),
        messages: [],
        ownerId: socket.id
    };

    catalogRooms.set(room.id, room);
    joinCatalogRoom(io, socket, room, data?.profile || {});

    socket.emit('private-room:created', {
        room: roomSummary(room, false)
    });
}

function requestPrivateRoomAccess(io, socket, data) {
    if (socket.user?.isGuest) {
        socket.emit('room:error', { message: 'Register or login to request access to private rooms.' });
        return;
    }

    const room = getRoomBySlug(data?.slug);
    if (!room || room.access !== 'private') {
        socket.emit('room:error', { message: 'Private room not found.' });
        return;
    }

    if (room.members.has(socket.id)) {
        socket.emit('room:error', { message: 'You are already a member of this room.' });
        return;
    }

    if (room.members.size === 0) {
        socket.emit('room:error', { message: 'No active members are available to approve this request.' });
        return;
    }

    const requestId = crypto.randomUUID();
    const requester = memberPayload(socket, data?.profile || {});
    requestIndex.set(requestId, {
        requestId,
        roomId: room.id,
        requesterId: socket.id,
        requester,
        createdAt: Date.now()
    });

    io.to(roomChannel(room.id)).emit('room:access-request', {
        requestId,
        roomId: room.id,
        roomName: room.name,
        requester
    });

    socket.emit('room:request-pending', {
        roomSlug: room.slug,
        roomName: room.name
    });
}

function respondToRoomRequest(io, socket, data) {
    const request = requestIndex.get(data?.requestId);
    if (!request) {
        socket.emit('room:error', { message: 'Access request expired.' });
        return;
    }

    const room = catalogRooms.get(request.roomId);
    if (!room || !room.members.has(socket.id)) {
        socket.emit('room:error', { message: 'You cannot respond to this access request.' });
        return;
    }

    requestIndex.delete(request.requestId);
    const requesterSocket = io.sockets.sockets.get(request.requesterId);
    if (!requesterSocket) return;

    if (!data?.admit) {
        requesterSocket.emit('room:request-response', {
            admitted: false,
            roomName: room.name
        });
        return;
    }

    joinCatalogRoom(io, requesterSocket, room, request.requester);
    requesterSocket.emit('room:request-response', {
        admitted: true,
        roomName: room.name
    });
}

function initChatRooms(io, socket) {
    socket.on('rooms:list', () => {
        emitCatalog(io, socket);
    });

    socket.on('join_public_room', (data) => {
        const room = catalogRooms.get(data?.roomId);
        if (!room || room.access !== 'public') {
            socket.emit('room:error', { message: 'Public room not found.' });
            return;
        }

        joinCatalogRoom(io, socket, room, data?.profile || {});
    });

    socket.on('leave_catalog_room', (data) => {
        leaveRoom(io, socket, data?.roomId);
    });

    socket.on('catalog_room_message', (data) => {
        const room = catalogRooms.get(data?.roomId);
        if (!room || !room.members.has(socket.id)) return;

        const rawText = String(data?.text || '').trim();
        if (!rawText) return;

        const author = room.members.get(socket.id);
        const message = {
            id: crypto.randomUUID(),
            authorId: socket.id,
            authorName: author.nickname,
            text: rawText.slice(0, 1000),
            createdAt: Date.now()
        };

        room.messages.push(message);
        if (room.messages.length > MAX_ROOM_HISTORY) {
            room.messages.shift();
        }

        io.to(roomChannel(room.id)).emit('room:message', {
            roomId: room.id,
            message
        });
    });

    socket.on('catalog_room_typing', (data) => {
        const room = catalogRooms.get(data?.roomId);
        if (!room || !room.members.has(socket.id)) return;

        socket.to(roomChannel(room.id)).emit('room:typing', {
            roomId: room.id,
            nickname: room.members.get(socket.id)?.nickname || 'Member',
            isTyping: !!data?.isTyping
        });
    });

    socket.on('create_hidden_room', (data) => {
        createHiddenRoom(io, socket, data);
    });

    socket.on('request_private_room_access', (data) => {
        requestPrivateRoomAccess(io, socket, data);
    });

    socket.on('respond_private_room_request', (data) => {
        respondToRoomRequest(io, socket, data);
    });
}

function handleChatRoomDisconnect(io, socketId) {
    for (const room of catalogRooms.values()) {
        if (room.members.has(socketId)) {
            const fakeSocket = {
                id: socketId,
                emit() {},
                leave() {}
            };
            leaveRoom(io, fakeSocket, room.id, true);
        }
    }

    for (const [requestId, request] of requestIndex.entries()) {
        if (request.requesterId === socketId) {
            requestIndex.delete(requestId);
        }
    }
}

module.exports = { initChatRooms, handleChatRoomDisconnect };
