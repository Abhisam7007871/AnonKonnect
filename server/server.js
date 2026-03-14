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
const io = new Server(server, {
    cors: {
        origin: '*', // For dev/testing
        methods: ['GET', 'POST']
    }
});

// Redis Setup for scalability
const pubClient = createClient({ url: process.env.REDIS_URL || 'redis://localhost:6379' });
const subClient = pubClient.duplicate();

Promise.all([pubClient.connect(), subClient.connect()]).then(() => {
    io.adapter(createAdapter(pubClient, subClient));
    console.log('[SERVER] Redis Adapter connected');
}).catch(err => {
    console.error('[SERVER] Redis connection error:', err);
});

app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

// Store active sessions globally for signaling reference
const sessions = new Map();

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // Assign ID back to client
    socket.emit('connected', { userId: socket.id });

    // Initialize module handlers
    initMatchmaking(io, socket, sessions, pubClient);
    initSignaling(io, socket, sessions, pubClient);

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        handleDisconnect(io, socket, sessions, pubClient);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AnonKonnect Server running on port ${PORT}`);
});
