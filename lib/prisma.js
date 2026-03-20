const globalForPrisma = globalThis;

function createPrismaClient() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  try {
    const { PrismaClient } = require("@prisma/client");
    return new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  } catch {
    return null;
  }
}

export const prisma = globalForPrisma.__prisma || createPrismaClient();

if (process.env.NODE_ENV !== "production" && prisma) {
  globalForPrisma.__prisma = prisma;
}
