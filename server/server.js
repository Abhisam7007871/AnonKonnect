const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const cors = require('cors');
const multer = require('multer');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
require('dotenv').config();

const { initMatchmaking, handleDisconnect } = require('./matchmaking');
const { initSignaling } = require('./signaling');
const { initRooms, handleRoomDisconnect } = require('./rooms');
const { initRoomSignaling } = require('./roomSignaling');
const { generateNoteAiPdf, ensureNotesDir } = require('./noteai');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', true);

// Security: Rate limiting
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: 'Too many requests from this IP, please try again after 15 minutes',
    // Socket.IO long-polling hits /socket.io frequently; throttling it breaks live sessions.
    skip: (req) => typeof req.path === 'string' && req.path.startsWith('/socket.io/')
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

// Serve main app shell at the root. The older marketing-heavy landing page
// has been retired so there is a single entry experience.
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, '../public/index.html'));
});

app.use(express.static(path.join(__dirname, '../public')));
ensureNotesDir();

const uploadsDir = path.join(__dirname, '../tmp/uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });
const upload = multer({ dest: uploadsDir, limits: { fileSize: 25 * 1024 * 1024 } });

// Health check endpoint (required for Render/Railway)
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'ok', uptime: process.uptime(), redis: !!pubClient });
});

// Store active sessions globally for signaling reference
const sessions = new Map();
const geoCache = new Map();
const analytics = {
    totalVisits: 0,
    byState: new Map(),
    byGender: new Map(),
    byPurpose: new Map(),
    byMode: new Map(),
    lastUpdatedAt: null
};

function bumpMetric(map, key) {
    const normalized = (key || 'Unknown').toString().trim() || 'Unknown';
    map.set(normalized, (map.get(normalized) || 0) + 1);
}

function mapToTopArray(map, limit = 10) {
    return [...map.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, limit)
        .map(([value, count]) => ({ value, count }));
}

function recordAnalyticsProfile(profile, geo) {
    if (!profile) return;
    analytics.totalVisits += 1;
    bumpMetric(analytics.byGender, profile.gender || 'unspecified');
    bumpMetric(analytics.byPurpose, profile.purpose || 'casual');
    bumpMetric(analytics.byMode, profile.mode || 'unknown');
    bumpMetric(analytics.byState, geo?.state || 'Unknown');
    analytics.lastUpdatedAt = new Date().toISOString();
}

function getClientIp(socket) {
    const xff = socket.handshake?.headers?.['x-forwarded-for'];
    const rawIp = (Array.isArray(xff) ? xff[0] : (xff || socket.handshake?.address || '')).toString();
    return rawIp.split(',')[0].trim().replace('::ffff:', '');
}

function isPrivateIp(ip) {
    return !ip
        || ip === '::1'
        || ip === '127.0.0.1'
        || ip.startsWith('10.')
        || ip.startsWith('192.168.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(ip);
}

async function resolveGeo(ip) {
    if (!ip || isPrivateIp(ip)) return null;
    if (geoCache.has(ip)) return geoCache.get(ip);
    try {
        const response = await fetch(`http://ip-api.com/json/${encodeURIComponent(ip)}?fields=status,country,regionName,city,query`, { method: 'GET' });
        const data = await response.json();
        if (data && data.status === 'success') {
            const geo = {
                ip: data.query || ip,
                country: data.country || 'Unknown',
                state: data.regionName || 'Unknown',
                city: data.city || 'Unknown'
            };
            geoCache.set(ip, geo);
            return geo;
        }
    } catch (_e) {
        // Ignore geo lookup failures; app should keep running.
    }
    return null;
}

app.get('/admin/analytics', (req, res) => {
    const adminKey = process.env.ADMIN_API_KEY;
    if (adminKey) {
        const supplied = req.header('x-admin-key') || req.query.key;
        if (supplied !== adminKey) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
    }
    return res.status(200).json({
        totalVisits: analytics.totalVisits,
        topStates: mapToTopArray(analytics.byState),
        topGenders: mapToTopArray(analytics.byGender),
        topPurposes: mapToTopArray(analytics.byPurpose),
        topModes: mapToTopArray(analytics.byMode),
        lastUpdatedAt: analytics.lastUpdatedAt
    });
});

app.post('/api/noteai/generate', upload.single('audio'), async (req, res) => {
    const roomId = (req.body?.roomId || '').toString().trim();
    const startedAt = req.body?.startedAt ? String(req.body.startedAt) : null;
    const endedAt = req.body?.endedAt ? String(req.body.endedAt) : null;
    let chatNotes = [];
    if (req.body?.chatNotes) {
        try {
            const parsed = JSON.parse(req.body.chatNotes);
            if (Array.isArray(parsed)) chatNotes = parsed;
        } catch (_e) {
            chatNotes = [];
        }
    }
    const audioFile = req.file;
    if (!roomId) {
        return res.status(400).json({ ok: false, error: 'Missing roomId.' });
    }
    if (!audioFile?.path) {
        return res.status(400).json({ ok: false, error: 'Missing audio file.' });
    }
    try {
        const result = await generateNoteAiPdf({
            filePath: audioFile.path,
            roomId,
            chatNotes,
            metadata: { startedAt, endedAt }
        });
        return res.status(200).json({
            ok: true,
                fileName: result.fileName,
            downloadUrl: result.downloadUrl,
            summary: result.summary
        });
    } catch (e) {
        return res.status(500).json({ ok: false, error: e.message || 'Failed to generate NoteAI PDF.' });
    } finally {
        fs.promises.unlink(audioFile.path).catch(() => {});
    }
});

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);
    const ip = getClientIp(socket);
    socket.data.clientIp = ip;
    resolveGeo(ip).then((geo) => {
        socket.data.geo = geo || null;
        if (geo) {
            console.log(`[VISIT] ${socket.id} ip=${geo.ip} country=${geo.country} state=${geo.state} city=${geo.city}`);
        } else {
            console.log(`[VISIT] ${socket.id} ip=${ip || 'unknown'} geo=unavailable`);
        }
    });

    // Assign ID back to client
    socket.emit('connected', { userId: socket.id });

    // Initialize module handlers
    initMatchmaking(io, socket, sessions, pubClient, { recordAnalyticsProfile });
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
