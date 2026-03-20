import bcrypt from "bcryptjs";
import NextAuth from "next-auth";
import AppleProvider from "next-auth/providers/apple";
import GoogleProvider from "next-auth/providers/google";
import FacebookProvider from "next-auth/providers/facebook";
import TwitterProvider from "next-auth/providers/twitter";
import { randomUUID } from "crypto";

import { prisma } from "@/lib/prisma";
import { fallbackStore } from "@/lib/fallback-store";
import { signSessionToken } from "@/lib/auth";

const providers = [
  process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET
    ? GoogleProvider({
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      })
    : null,
  process.env.FACEBOOK_CLIENT_ID && process.env.FACEBOOK_CLIENT_SECRET
    ? FacebookProvider({
        clientId: process.env.FACEBOOK_CLIENT_ID,
        clientSecret: process.env.FACEBOOK_CLIENT_SECRET,
      })
    : null,
  process.env.X_CLIENT_ID && process.env.X_CLIENT_SECRET
    ? TwitterProvider({
        clientId: process.env.X_CLIENT_ID,
        clientSecret: process.env.X_CLIENT_SECRET,
        authorization: {
          params: {
            // Helps get email when available.
            include_email: "true",
            scope: "profile email",
          },
        },
      })
    : null,
  process.env.APPLE_CLIENT_ID && process.env.APPLE_CLIENT_SECRET
    ? AppleProvider({
        clientId: process.env.APPLE_CLIENT_ID,
        clientSecret: process.env.APPLE_CLIENT_SECRET,
      })
    : null,
].filter(Boolean);

function normalizeEmail(profile, account) {
  const email = profile?.email;
  if (email) return String(email).toLowerCase();

  const provider = account?.provider || "oauth";
  const profileId = profile?.id || profile?.sub || account?.providerAccountId || randomUUID();
  return `${provider}_${profileId}@anonkonnect.local`.toLowerCase();
}

function normalizeNickname(profile, email) {
  const nickname =
    profile?.name ||
    profile?.preferred_username ||
    profile?.login ||
    profile?.username ||
    String(email || "anon");

  const cleaned = String(nickname).trim().replace(/\s+/g, " ");
  if (cleaned.length >= 2) return cleaned;
  return `User${Math.floor(Math.random() * 10000)}`;
}

function buildAnonKonnectSessionUser(user) {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone || "",
    nickname: user.nickname,
    accessLevel: "registered",
    gender: user.gender || "",
    purpose: user.purpose || "chat",
    country: user.country || "United States",
    state: user.state || "",
    city: user.city || "",
  };
}

async function findOrCreateUserFromOAuth({ account, profile }) {
  const email = normalizeEmail(profile, account);
  const nickname = normalizeNickname(profile, email);

  const gender = profile?.gender || "";
  const purpose = "";
  const country = "United States";
  const state = "";
  const city = "";
  const phone = "";

  if (process.env.DATABASE_URL) {
    const passwordHash = await bcrypt.hash(randomUUID(), 10);

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        nickname,
        phone,
        gender,
        purpose,
        country,
        state,
        city,
      },
      create: {
        email,
        nickname,
        phone,
        passwordHash,
        accessLevel: "REGISTERED",
        gender,
        purpose,
        country,
        state,
        city,
      },
    });

    return user;
  }

  // Fallback-store mode
  const existing = fallbackStore.users.find((u) => u.email === email);
  if (existing) {
    existing.nickname = nickname;
    existing.phone = existing.phone || phone;
    existing.gender = gender;
    existing.purpose = purpose;
    existing.country = country;
    existing.state = state;
    existing.city = city;
    return existing;
  }

  const user = {
    id: randomUUID(),
    email,
    phone,
    nickname,
    passwordHash: await bcrypt.hash(randomUUID(), 10),
    accessLevel: "registered",
    gender,
    purpose,
    country,
    state,
    city,
  };

  fallbackStore.users.push(user);
  return user;
}

export const runtime = "nodejs";

const authOptions = {
  providers,
  // NextAuth requires a secret for JWT strategy. If NEXTAUTH_SECRET is missing,
  // fall back to JWT_SECRET (already used elsewhere) to prevent /api/auth/session 500s.
  secret: process.env.NEXTAUTH_SECRET || process.env.JWT_SECRET || "anonkonnect-nextauth-dev-secret",
  session: {
    strategy: "jwt",
  },
  callbacks: {
    async jwt({ token, account, profile }) {
      if (!account || !profile) return token;

      const user = await findOrCreateUserFromOAuth({ account, profile });
      const anonUser = buildAnonKonnectSessionUser(user);

      token.anonkonnectUser = anonUser;
      token.anonkonnectToken = signSessionToken(anonUser);

      return token;
    },
    async session({ session, token }) {
      if (token?.anonkonnectToken && token?.anonkonnectUser) {
        session.token = token.anonkonnectToken;
        session.user = token.anonkonnectUser;
      }
      return session;
    },
  },
};

const handler = NextAuth(authOptions);

export { handler as GET, handler as POST };

