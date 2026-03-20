import bcrypt from "bcryptjs";
import { NextResponse } from "next/server";
import { z } from "zod";

import { signSessionToken } from "@/lib/auth";
import { fallbackStore } from "@/lib/fallback-store";
import { prisma } from "@/lib/prisma";

const schema = z.object({
  identifier: z.string().min(3),
  password: z.string().min(6),
});

export async function POST(request) {
  const parsed = schema.safeParse(await request.json());

  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid credentials." }, { status: 400 });
  }

  const rawIdentifier = parsed.data.identifier.trim();
  const isEmail = rawIdentifier.includes("@");
  const email = isEmail ? rawIdentifier.toLowerCase() : null;
  const phone = isEmail ? null : rawIdentifier;

  if (process.env.DATABASE_URL) {
    const user = await prisma.user.findFirst({
      where: email ? { email } : { phone },
    });

    if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
      return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
    }

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

  const user = fallbackStore.users.find((entry) =>
    email ? entry.email === email : entry.phone === phone,
  );

  if (!user || !(await bcrypt.compare(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: "Incorrect email or password." }, { status: 401 });
  }

  return NextResponse.json({
    user: {
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
