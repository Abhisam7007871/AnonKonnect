import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { signSessionToken } from "@/lib/auth";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  nickname: z.string().min(2),
  gender: z.string().optional(),
  purpose: z.string().optional(),
  country: z.string().optional(),
  state: z.string().optional(),
  city: z.string().optional(),
});

export async function POST(request) {
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please provide a valid email, nickname, and password." },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const email = data.email.toLowerCase();

  if (process.env.DATABASE_URL) {
    const existing = await prisma.user.findUnique({ where: { email } });

    if (existing) {
      return NextResponse.json({ error: "Email already registered." }, { status: 409 });
    }

    const user = await prisma.user.create({
      data: {
        email,
        nickname: data.nickname,
        passwordHash: await bcrypt.hash(data.password, 10),
        accessLevel: "REGISTERED",
        gender: data.gender,
        purpose: data.purpose,
        country: data.country,
        state: data.state,
        city: data.city,
      },
    });

    const session = {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      accessLevel: "registered",
      country: user.country,
      state: user.state,
      city: user.city,
      gender: user.gender,
      purpose: user.purpose,
    };

    return NextResponse.json({ user: session, token: signSessionToken(session) });
  }

  const existing = fallbackStore.users.find((user) => user.email === email);

  if (existing) {
    return NextResponse.json({ error: "Email already registered." }, { status: 409 });
  }

  const user = {
    id: crypto.randomUUID(),
    email,
    nickname: data.nickname,
    passwordHash: await bcrypt.hash(data.password, 10),
    accessLevel: "registered",
    gender: data.gender,
    purpose: data.purpose,
    country: data.country,
    state: data.state,
    city: data.city,
  };

  fallbackStore.users.push(user);

  return NextResponse.json({
    user: {
      ...user,
      passwordHash: undefined,
    },
    token: signSessionToken({
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      accessLevel: "registered",
      country: user.country,
      state: user.state,
      city: user.city,
      gender: user.gender,
      purpose: user.purpose,
    }),
  });
}
