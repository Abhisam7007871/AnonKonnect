const crypto = require("crypto");

const { getPrisma } = require("./prisma");

const rooms = new Map();
let roomsHydrated = false;

const defaultRooms = [
  {
    id: "us-lounge",
    slug: "us-lounge",
    name: "US Night Lounge",
    description: "Late-night conversations, memes, and casual icebreakers.",
    category: "Friendship",
    region: "US",
    isPrivate: false,
    requiresAccess: false,
  },
  {
    id: "uk-spotlight",
    slug: "uk-spotlight",
    name: "UK Spotlight",
    description: "Regional public room for UK-based chatters.",
    category: "Regional",
    region: "UK",
    isPrivate: false,
    requiresAccess: false,
  },
  {
    id: "india-vibes",
    slug: "india-vibes",
    name: "India Vibes",
    description: "Fast-moving public chat around music, cricket, and campus life.",
    category: "Regional",
    region: "India",
    isPrivate: false,
    requiresAccess: false,
  },
  {
    id: "creator-circle",
    slug: "creator-circle",
    name: "Creator Circle",
    description: "Interest-based room for makers, indie builders, and designers.",
    category: "Interests",
    region: "Global",
    isPrivate: false,
    requiresAccess: false,
  },
];

function makeRoom(input) {
  return {
    id: input.id,
    slug: input.slug,
    name: input.name,
    description: input.description,
    category: input.category,
    region: input.region,
    isPrivate: Boolean(input.isPrivate),
    requiresAccess: Boolean(input.requiresAccess),
    ownerId: input.ownerId || null,
    participants: input.participants || [],
    requests: input.requests || [],
    messages:
      input.messages || [
        {
          id: crypto.randomUUID(),
          senderId: "system",
          senderName: "Pulse",
          kind: "text",
          content: "Welcome in. Keep the room respectful and keep the energy alive.",
          timestamp: Date.now(),
        },
      ],
    createdAt: input.createdAt || Date.now(),
  };
}

function isRegisteredUser(profile = {}) {
  return String(profile.accessLevel || "").toLowerCase() === "registered" && profile.id;
}

function toMemberRole(room, profile = {}) {
  if (room.ownerId && profile.id && room.ownerId === profile.id) {
    return "OWNER";
  }
  return "MEMBER";
}

async function upsertMembership(room, profile = {}, overrides = {}) {
  if (!isRegisteredUser(profile)) {
    return;
  }

  const prisma = getPrisma();
  if (!prisma) {
    return;
  }

  try {
    await prisma.roomMember.upsert({
      where: {
        roomId_userId: {
          roomId: room.id,
          userId: profile.id,
        },
      },
      update: {
        role: overrides.role || toMemberRole(room, profile),
        status: overrides.status || "ACTIVE",
        requestedAt: overrides.requestedAt || new Date(),
        joinedAt: overrides.joinedAt === undefined ? new Date() : overrides.joinedAt,
        lastSeenAt: overrides.lastSeenAt || new Date(),
      },
      create: {
        roomId: room.id,
        userId: profile.id,
        role: overrides.role || toMemberRole(room, profile),
        status: overrides.status || "ACTIVE",
        requestedAt: overrides.requestedAt || new Date(),
        joinedAt: overrides.joinedAt === undefined ? new Date() : overrides.joinedAt,
        lastSeenAt: overrides.lastSeenAt || new Date(),
      },
    });
  } catch (error) {
    console.warn("[ROOMS] Failed to upsert membership:", error.message);
  }
}

async function updateMembershipStatus(roomId, userId, status, extra = {}) {
  if (!userId) {
    return;
  }

  const prisma = getPrisma();
  if (!prisma) {
    return;
  }

  try {
    await prisma.roomMember.update({
      where: {
        roomId_userId: {
          roomId,
          userId,
        },
      },
      data: {
        status,
        ...extra,
      },
    });
  } catch (error) {
    if (error.code !== "P2025") {
      console.warn("[ROOMS] Failed to update membership status:", error.message);
    }
  }
}

async function ensureRoomsHydrated() {
  if (roomsHydrated) {
    return;
  }

  defaultRooms.forEach((room) => {
    rooms.set(room.id, makeRoom(room));
  });

  const prisma = getPrisma();

  if (prisma) {
    try {
      const persistedRooms = await prisma.room.findMany({
        include: {
          members: {
            where: {
              status: "ACTIVE",
            },
            include: {
              user: true,
            },
          },
          messages: {
            orderBy: {
              createdAt: "asc",
            },
            take: 50,
          },
        },
      });

      persistedRooms.forEach((room) => {
        for (const [existingId, existingRoom] of rooms.entries()) {
          if (existingRoom.slug === room.slug && existingId !== room.id) {
            rooms.delete(existingId);
          }
        }

        rooms.set(
          room.id,
          makeRoom({
            ...room,
            participants: room.members.map((member) => ({
              id: `persisted:${member.userId}`,
              userId: member.userId,
              nickname: member.user?.nickname || (member.role === "OWNER" ? "Owner" : "Member"),
              accessLevel: (member.user?.accessLevel || "REGISTERED").toLowerCase(),
            })),
            messages:
              room.messages?.map((message) => ({
                id: message.id,
                senderId: message.senderId || "system",
                senderName: message.senderName,
                kind: String(message.kind || "TEXT").toLowerCase(),
                content: message.content,
                metadata: message.metadata || null,
                timestamp: new Date(message.createdAt).getTime(),
              })) || undefined,
          }),
        );
      });
    } catch (error) {
      console.warn("[ROOMS] Failed to hydrate Prisma rooms:", error.message);
    }
  }

  roomsHydrated = true;
}

function getRoom(roomId) {
  return rooms.get(roomId) || null;
}

function isRoomParticipant(roomId, socketId) {
  const room = rooms.get(roomId);
  if (!room) {
    return false;
  }

  return room.participants.some((participant) => participant.id === socketId);
}

function buildRoomList(socketId, userId) {
  return [...rooms.values()]
    .filter(
      (room) =>
        !room.isPrivate ||
        room.ownerId === userId ||
        room.participants.some(
          (participant) => participant.id === socketId || (userId && participant.userId === userId),
        ),
    )
    .map((room) => ({
      id: room.id,
      slug: room.slug,
      name: room.name,
      description: room.description,
      category: room.category,
      region: room.region,
      isPrivate: room.isPrivate,
      requiresAccess: room.requiresAccess,
      memberCount: room.participants.length,
    }));
}

function buildPendingRequests(socketId, userId) {
  return [...rooms.values()].flatMap((room) =>
    room.requests
      .filter(
        () =>
          room.ownerId === socketId ||
          room.ownerId === userId ||
          room.participants.some(
            (participant) => participant.id === socketId || (userId && participant.userId === userId),
          ),
      )
      .map((request) => ({
        roomId: room.id,
        roomName: room.name,
        requesterId: request.requesterId,
        requesterProfile: request.requesterProfile,
      })),
  );
}

function emitRoomsSnapshot(io, socketId, userId) {
  io.to(socketId).emit("rooms_snapshot", {
    rooms: buildRoomList(socketId, userId),
    pendingRequests: buildPendingRequests(socketId, userId),
  });
}

function joinRoom(io, socket, room, profile = {}) {
  const existing = room.participants.find(
    (participant) =>
      participant.id === socket.id || (profile.id && participant.userId && participant.userId === profile.id),
  );

  if (!existing) {
    room.participants.push({
      id: socket.id,
      userId: profile.id || null,
      nickname: profile.nickname || "Anon",
      accessLevel: profile.accessLevel || "guest",
    });
  }

  socket.join(room.id);
  socket.emit("room_joined", {
    room: {
      id: room.id,
      name: room.name,
      slug: room.slug,
      region: room.region,
      category: room.category,
      isPrivate: room.isPrivate,
    },
    messages: room.messages,
  });
  io.emit("rooms_snapshot_broadcast");
  upsertMembership(room, profile, {
    role: toMemberRole(room, profile),
    status: "ACTIVE",
    joinedAt: new Date(),
    lastSeenAt: new Date(),
  });
}

function initRooms(io, socket) {
  socket.on("list_rooms", async () => {
    await ensureRoomsHydrated();
    emitRoomsSnapshot(io, socket.id, socket.user?.id);
  });

  socket.on("create_room", async (data = {}) => {
    await ensureRoomsHydrated();

    const roomPayload = data.room || {};

    if (!roomPayload.id || !roomPayload.name) {
      socket.emit("room_error", { message: "Room details are incomplete." });
      return;
    }

    const room = makeRoom({
      id: roomPayload.id,
      slug: roomPayload.slug,
      name: roomPayload.name,
      description: roomPayload.description,
      category: roomPayload.category || "General",
      region: roomPayload.region || "Global",
      isPrivate: roomPayload.isPrivate,
      requiresAccess: roomPayload.requiresAccess,
      ownerId: roomPayload.ownerId || data.profile?.id || socket.user?.id || socket.id,
    });

    rooms.set(room.id, room);
    joinRoom(io, socket, room, data.profile || socket.user || {});
    emitRoomsSnapshot(io, socket.id, socket.user?.id);
  });

  socket.on("join_public_room", async (data = {}) => {
    await ensureRoomsHydrated();

    const room = rooms.get(data.roomId);

    if (!room) {
      socket.emit("room_error", { message: "Room not found." });
      return;
    }

    if (room.isPrivate) {
      socket.emit("room_error", { message: "This room needs an access request." });
      return;
    }

    joinRoom(io, socket, room, data.profile || socket.user || {});
    emitRoomsSnapshot(io, socket.id, socket.user?.id);
  });

  socket.on("request_join_room", async (data = {}) => {
    await ensureRoomsHydrated();

    const room = rooms.get(data.roomId);

    if (!room || !room.isPrivate) {
      socket.emit("room_error", { message: "Private room not found." });
      return;
    }

    if ((data.profile?.accessLevel || socket.user?.accessLevel) !== "registered") {
      socket.emit("room_error", { message: "Registered access is required for private rooms." });
      return;
    }

    const requesterUserId = data.profile?.id || socket.user?.id || null;
    if (
      room.requests.some(
        (request) =>
          request.requesterId === socket.id ||
          (requesterUserId && request.requesterProfile?.id === requesterUserId),
      )
    ) {
      return;
    }

    const request = {
      requesterId: socket.id,
      requesterProfile: data.profile || socket.user || {},
      requestedAt: Date.now(),
    };

    room.requests.push(request);
    await upsertMembership(room, request.requesterProfile, {
      role: "MEMBER",
      status: "PENDING",
      requestedAt: new Date(request.requestedAt),
      joinedAt: null,
      lastSeenAt: null,
    });

    const recipients = new Set(room.participants.map((participant) => participant.id));
    if (room.ownerId) {
      recipients.add(`user:${room.ownerId}`);
    }

    recipients.forEach((recipientId) => {
      io.to(recipientId).emit("room_access_requested", {
        roomId: room.id,
        roomName: room.name,
        requesterId: request.requesterId,
        requesterProfile: request.requesterProfile,
      });
    });
  });

  socket.on("respond_room_request", async (data = {}) => {
    await ensureRoomsHydrated();

    const room = rooms.get(data.roomId);

    if (!room) {
      return;
    }

    const canModerate =
      room.ownerId === socket.id ||
      room.ownerId === socket.user?.id ||
      room.participants.some(
        (participant) => participant.id === socket.id && participant.userId && participant.userId === room.ownerId,
      );

    if (!canModerate) {
      return;
    }

    const requestIndex = room.requests.findIndex((request) => request.requesterId === data.requesterId);

    if (requestIndex === -1) {
      return;
    }

    const [request] = room.requests.splice(requestIndex, 1);
    io.to(request.requesterId).emit("room_request_resolved", {
      roomId: room.id,
      requesterId: request.requesterId,
      decision: data.decision,
    });

    if (data.decision === "admit") {
      await updateMembershipStatus(room.id, request.requesterProfile?.id, "ACTIVE", {
        joinedAt: new Date(),
        lastSeenAt: new Date(),
      });
      const requesterSocket = io.sockets.sockets.get(request.requesterId);
      if (requesterSocket) {
        joinRoom(io, requesterSocket, room, request.requesterProfile);
        emitRoomsSnapshot(io, requesterSocket.id, requesterSocket.user?.id);
      }
    } else {
      await updateMembershipStatus(room.id, request.requesterProfile?.id, "DECLINED");
    }

    emitRoomsSnapshot(io, socket.id, socket.user?.id);
  });

  socket.on("leave_room", async (data = {}) => {
    await ensureRoomsHydrated();

    const room = rooms.get(data.roomId);

    if (!room) {
      return;
    }

    room.participants = room.participants.filter((participant) => participant.id !== socket.id);
    socket.leave(room.id);
    await updateMembershipStatus(room.id, socket.user?.id, "LEFT");

    if (room.participants.length === 0 && room.isPrivate) {
      rooms.delete(room.id);
    }

    emitRoomsSnapshot(io, socket.id, socket.user?.id);
  });
}

function handleRoomDisconnect(io, socketId) {
  for (const room of rooms.values()) {
    const departing = room.participants.find((participant) => participant.id === socketId);
    room.participants = room.participants.filter((participant) => participant.id !== socketId);
    room.requests = room.requests.filter((request) => request.requesterId !== socketId);
    updateMembershipStatus(room.id, departing?.userId, "LEFT");
  }

  io.emit("rooms_snapshot_broadcast");
}

module.exports = {
  initRooms,
  getRoom,
  isRoomParticipant,
  handleRoomDisconnect,
};
