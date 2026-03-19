const { PrismaClient } = require("@prisma/client");

let prisma;

function getPrisma() {
  if (!process.env.DATABASE_URL) {
    return null;
  }

  if (!prisma) {
    prisma = new PrismaClient({
      log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
    });
  }

  return prisma;
}

module.exports = { getPrisma };
