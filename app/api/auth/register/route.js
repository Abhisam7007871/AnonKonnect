import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { signSessionToken } from "@/lib/auth";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

const schema = z
  .object({
    email: z.string().email().optional().or(z.literal("")),
    phone: z.string().min(6).max(20).optional().or(z.literal("")),
    password: z.string().min(6),
    nickname: z.string().min(2),
    gender: z.string().optional(),
    purpose: z.string().optional(),
    country: z.string().optional(),
    state: z.string().optional(),
    city: z.string().optional(),
  })
  .refine((data) => Boolean(data.email || data.phone), {
    message: "Either email or phone is required.",
  });

export async function POST(request) {
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json(
      { error: "Please provide name, password, country/purpose, and email or phone." },
      { status: 400 },
    );
  }

  const data = parsed.data;
  const email = data.email ? data.email.toLowerCase() : null;
  const phone = data.phone ? data.phone.trim() : null;
  const nickname = data.nickname.trim();

  if (process.env.DATABASE_URL) {
    if (email) {
      const existingByEmail = await prisma.user.findUnique({ where: { email } });
      if (existingByEmail) {
        return NextResponse.json({ error: "Email already registered." }, { status: 409 });
      }
    }
    if (phone) {
      const existingByPhone = await prisma.user.findUnique({ where: { phone } });
      if (existingByPhone) {
        return NextResponse.json({ error: "Phone already registered." }, { status: 409 });
      }
    }

    const user = await prisma.user.create({
      data: {
        email: email || `${phone}@anonkonnect.local`,
        phone,
        nickname,
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
      phone: user.phone,
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

  const existing = fallbackStore.users.find(
    (user) => (email && user.email === email) || (phone && user.phone === phone),
  );

  if (existing) {
    return NextResponse.json({ error: "Email or phone already registered." }, { status: 409 });
  }

  const user = {
    id: crypto.randomUUID(),
    email: email || `${phone}@anonkonnect.local`,
    phone,
    nickname,
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
      phone: user.phone,
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
