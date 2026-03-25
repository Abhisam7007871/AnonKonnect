const express = require("express");
const http = require("http");
const next = require("next");
const { Server } = require("socket.io");
const cors = require("cors");
const { createClient } = require("redis");
const { createAdapter } = require("@socket.io/redis-adapter");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { initMatchmaking, handleDisconnect } = require("./matchmaking");
const { initSignaling } = require("./signaling");
const { initRooms, handleRoomDisconnect } = require("./rooms");
const { initRoomSignaling } = require("./roomSignaling");
const {
  verifySocketSessionToken,
  normalizeGuestUser,
  normalizeRegisteredUser,
} = require("./auth");

const dev = process.env.NODE_ENV !== "production";
const nextApp = next({ dev });
const nextHandler = nextApp.getRequestHandler();

const app = express();
const server = http.createServer(app);

app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 250,
    message: "Too many requests from this IP. Please try again soon.",
  }),
);
app.use(cors());

const io = new Server(server, {
  cors: {
    origin: true,
    methods: ["GET", "POST"],
  },
});

const sessions = new Map();
const REDIS_URL = process.env.REDIS_URL;
let pubClient = null;
let subClient = null;

if (REDIS_URL) {
  pubClient = createClient({ url: REDIS_URL });
  subClient = pubClient.duplicate();

  Promise.all([pubClient.connect(), subClient.connect()])
    .then(() => {
      io.adapter(createAdapter(pubClient, subClient));
      console.log("[SERVER] Redis adapter connected");
    })
    .catch((error) => {
      console.warn("[SERVER] Redis adapter failed, using single instance mode:", error.message);
      pubClient = null;
      subClient = null;
    });
}

io.use((socket, nextSocket) => {
  const auth = socket.handshake.auth || {};
  const token = auth.token;

  if (token) {
    const session = verifySocketSessionToken(token);
    if (!session) {
      nextSocket(new Error("Unauthorized"));
      return;
    }

    socket.user = normalizeRegisteredUser(session, socket.id);
    nextSocket();
    return;
  }

  socket.user = normalizeGuestUser(auth, socket.id);
  nextSocket();
});

io.on("connection", (socket) => {
  if (socket.user?.id) {
    socket.join(`user:${socket.user.id}`);
  }

  socket.emit("connected", { userId: socket.id, user: socket.user });

  initMatchmaking(io, socket, sessions, pubClient);
  initSignaling(io, socket, sessions, pubClient);
  initRooms(io, socket);
  initRoomSignaling(io, socket);

  socket.on("disconnect", () => {
    handleRoomDisconnect(io, socket.id);
    handleDisconnect(io, socket, sessions, pubClient);
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({
    status: "ok",
    uptime: process.uptime(),
    redis: Boolean(pubClient),
  });
});

nextApp
  .prepare()
  .then(() => {
    app.use((req, res) => nextHandler(req, res));

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
      console.log(`AnonKonnect server running on http://localhost:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to prepare Next.js:", error);
    process.exit(1);
  });
