import { NextResponse } from "next/server";
import { z } from "zod";

import { signSessionToken, verifySessionToken } from "@/lib/auth";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

const profileSchema = z.object({
  nickname: z.string().min(2),
  phone: z.string().min(6).max(20).optional().nullable(),
  gender: z.string().optional().nullable(),
  purpose: z.string().optional().nullable(),
  country: z.string().optional().nullable(),
  state: z.string().optional().nullable(),
  city: z.string().optional().nullable(),
});

function toSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone || "",
    nickname: user.nickname,
    accessLevel: "registered",
    country: user.country || "",
    state: user.state || "",
    city: user.city || "",
    gender: user.gender || "",
    purpose: user.purpose || "chat",
  };
}

function buildProfileResponse(user) {
  const sessionUser = toSessionUser(user);
  return {
    user: sessionUser,
    token: signSessionToken(sessionUser),
  };
}

export async function GET(request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Missing token." }, { status: 401 });
  }

  const session = verifySessionToken(token);

  if (!session) {
    return NextResponse.json({ error: "Invalid session." }, { status: 401 });
  }

  if (process.env.DATABASE_URL) {
    const user = await prisma.user.findUnique({
      where: { id: session.id },
    });

    if (!user) {
      return NextResponse.json({ error: "User not found." }, { status: 404 });
    }

    return NextResponse.json(buildProfileResponse(user));
  }

  const user = fallbackStore.users.find((entry) => entry.id === session.id);
  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  return NextResponse.json(buildProfileResponse(user));
}

export async function PUT(request) {
  const authHeader = request.headers.get("authorization");
  const token = authHeader?.replace("Bearer ", "");

  if (!token) {
    return NextResponse.json({ error: "Missing token." }, { status: 401 });
  }

  const session = verifySessionToken(token);
  if (!session) {
    return NextResponse.json({ error: "Invalid session." }, { status: 401 });
  }

  const parsed = profileSchema.safeParse(await request.json());
  if (!parsed.success) {
    return NextResponse.json({ error: "Please complete all required profile fields." }, { status: 400 });
  }

  if (process.env.DATABASE_URL) {
    const user = await prisma.user.update({
      where: { id: session.id },
      data: parsed.data,
    });

    return NextResponse.json(buildProfileResponse(user));
  }

  const user = fallbackStore.users.find((entry) => entry.id === session.id);
  if (!user) {
    return NextResponse.json({ error: "User not found." }, { status: 404 });
  }

  Object.assign(user, parsed.data);
  return NextResponse.json(buildProfileResponse(user));
}
