import { NextResponse } from "next/server";
import { z } from "zod";

import { verifySessionToken } from "@/lib/auth";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

const createRoomSchema = z.object({
  name: z.string().min(2),
  description: z.string().min(4),
  category: z.string().min(2),
  region: z.string().min(2),
  isPrivate: z.boolean().default(false),
});

function slugify(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

export async function GET() {
  if (process.env.DATABASE_URL) {
    const rooms = await prisma.room.findMany({
      where: {
        isPrivate: false,
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        members: {
          where: {
            status: "ACTIVE",
          },
        },
      },
    });

    return NextResponse.json({
      rooms: rooms.map((room) => ({
        id: room.id,
        slug: room.slug,
        name: room.name,
        description: room.description,
        category: room.category,
        region: room.region,
        isPrivate: room.isPrivate,
        requiresAccess: room.requiresAccess,
        memberCount: room.members.length,
      })),
    });
  }

  return NextResponse.json({ rooms: fallbackStore.rooms });
}

export async function POST(request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");
  const session = token ? verifySessionToken(token) : null;

  if (!session?.id) {
    return NextResponse.json({ error: "Registered access required." }, { status: 401 });
  }

  const parsed = createRoomSchema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Please complete all room fields." }, { status: 400 });
  }

  const payload = parsed.data;
  const slug = slugify(`${payload.name}-${payload.region}`);

  if (process.env.DATABASE_URL) {
    const room = await prisma.room.create({
      data: {
        slug: `${slug}-${Date.now()}`,
        name: payload.name,
        description: payload.description,
        category: payload.category,
        region: payload.region,
        isPrivate: payload.isPrivate,
        requiresAccess: payload.isPrivate,
        ownerId: session.id,
        members: {
          create: {
            userId: session.id,
            role: "OWNER",
            status: "ACTIVE",
            joinedAt: new Date(),
          },
        },
      },
      include: {
        members: {
          where: {
            status: "ACTIVE",
          },
        },
      },
    });

    return NextResponse.json({
      room: {
        id: room.id,
        slug: room.slug,
        name: room.name,
        description: room.description,
        category: room.category,
        region: room.region,
        isPrivate: room.isPrivate,
        requiresAccess: room.requiresAccess,
        ownerId: room.ownerId,
        memberCount: room.members.length,
      },
    });
  }

  const room = {
    id: crypto.randomUUID(),
    slug: `${slug}-${Date.now()}`,
    name: payload.name,
    description: payload.description,
    category: payload.category,
    region: payload.region,
    isPrivate: payload.isPrivate,
    requiresAccess: payload.isPrivate,
  };

  fallbackStore.rooms.unshift(room);

  return NextResponse.json({ room });
}
