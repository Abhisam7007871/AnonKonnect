const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
require('dotenv').config();

const { initMatchmaking, handleDisconnect } = require('./matchmaking');
const { initSignaling } = require('./signaling');
const { initRooms, handleRoomDisconnect } = require('./rooms');
const { initRoomSignaling } = require('./roomSignaling');
const rateLimit = require('express-rate-limit');

const app = express();

// Security: Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes'
});
app.use(limiter);

const server = http.createServer(app);

// CORS: Allow frontend(s) – use comma-separated FRONTEND_URL for Vercel + Render (e.g. "https://app.vercel.app,https://anonkonnect.onrender.com")
// Normalize: strip trailing slash so env "https://example.com/" matches browser Origin "https://example.com"
const ALLOWED_ORIGINS = process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean)
    : ['*'];
// Allow when origin is in list (normalized), or when origin is missing (e.g. WebSocket upgrade from some clients/proxies). Empty list => allow all.
const CORS_ORIGIN = ALLOWED_ORIGINS.length === 0 || ALLOWED_ORIGINS[0] === '*'
    ? '*'
    : (origin, cb) => {
        const normalized = origin != null ? String(origin).replace(/\/$/, '') : origin;
        cb(null, normalized == null || ALLOWED_ORIGINS.includes(normalized));
    };

const io = new Server(server, {
    cors: {
        origin: CORS_ORIGIN,
        methods: ['GET', 'POST']
    }
});

// Redis Setup for scalability (OPTIONAL - graceful fallback if unavailable)
const REDIS_URL = process.env.REDIS_URL;
let pubClient = null;
let subClient = null;

if (REDIS_URL) {
    pubClient = createClient({ url: REDIS_URL });
    subClient = pubClient.duplicate();

    Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
        io.adapter(createAdapter(pubClient, subClient));
        console.log('[SERVER] Redis Adapter connected successfully');
    }).catch(err => {
        console.warn('[SERVER] Redis connection failed, running in single-instance mode:', err.message);
        pubClient = null;
        subClient = null;
    });
} else {
    console.log('[SERVER] No REDIS_URL set. Running in single-instance mode (in-memory matchmaking).');
}

app.use(cors());

// Serve new light landing page at the root while keeping index.html for the app shell.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/landing.html'));
});

app.use(express.static(path.join(__dirname, '../public')));

// Health check endpoint (required for Render/Railway)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), redis: !!pubClient });
});

// Store active sessions globally for signaling reference
const sessions = new Map();

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Assign ID back to client
    socket.emit('connected', { userId: socket.id });

    // Initialize module handlers
    initMatchmaking(io, socket, sessions, pubClient);
    initSignaling(io, socket, sessions, pubClient);
    initRooms(io, socket);
    initRoomSignaling(io, socket);

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        handleRoomDisconnect(io, socket.id);
        handleDisconnect(io, socket, sessions, pubClient);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AnonKonnect Server running on port ${PORT}`);
});
