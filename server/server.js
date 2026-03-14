const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const cors = require('cors');
require('dotenv').config();

const { initMatchmaking, handleDisconnect } = require('./matchmaking');
const { initSignaling } = require('./signaling');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*', // For dev/testing
        methods: ['GET', 'POST']
    }
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
    initMatchmaking(io, socket, sessions);
    initSignaling(io, socket, sessions);

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        handleDisconnect(io, socket, sessions);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`AnonKonnect Server running on port ${PORT}`);
});
