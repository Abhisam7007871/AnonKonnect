import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { signSessionToken } from "@/lib/auth";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

export async function POST(request) {
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 400 });
  }

  const email = parsed.data.email.toLowerCase();

  if (process.env.DATABASE_URL) {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
    }

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

  const user = fallbackStore.users.find((entry) => entry.email === email);

  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }

  return NextResponse.json({
    user: {
      id: user.id,
      email: user.email,
      nickname: user.nickname,
      accessLevel: "registered",
      country: user.country,
      state: user.state,
      city: user.city,
      gender: user.gender,
      purpose: user.purpose,
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
