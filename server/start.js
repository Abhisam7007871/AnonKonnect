const fs = require("fs");
const { execSync } = require("child_process");

function fileExists(path) {
  try {
    return fs.existsSync(path);
  } catch {
    return false;
  }
}

function safeRun(cmd) {
  try {
    execSync(cmd, { stdio: "inherit" });
    return true;
  } catch (err) {
    console.warn(`[START] Command failed (${cmd}). Continuing: ${err?.message || err}`);
    return false;
  }
}

async function main() {
  // Ensure Next.js production build exists.
  // Some deploy environments call `npm start` without running `npm run build`.
  if (!fileExists(".next/BUILD_ID")) {
    console.log("[START] Missing .next/BUILD_ID; running `npm run build`...");
    safeRun("npm run build");
  }

  // If a DB URL is provided, best-effort schema sync.
  // This prevents login/rooms routes from failing when tables are missing.
  if (process.env.DATABASE_URL) {
    console.log("[START] DATABASE_URL detected; running `prisma db push` (best-effort)...");
    safeRun("npx prisma db push --accept-data-loss");
  }

  // Launch the existing custom server.
  require("./server");
}

main();

