require('dotenv').config();

const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
    console.error('JWT_SECRET environment variable is required.');
    process.exit(1);
}

// DATA_DIR should point at a persistent volume mount in production
// (the container filesystem is wiped on every redeploy otherwise).
const DATA_DIR = process.env.DATA_DIR || __dirname;

// Setup Uploads Directory
const uploadDir = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

// Seed the default avatar into the (possibly fresh) uploads dir from the
// bundled repo asset, since a new volume mount starts out empty.
const defaultAvatarDest = path.join(uploadDir, 'default.png');
if (!fs.existsSync(defaultAvatarDest)) {
    fs.copyFileSync(path.join(__dirname, 'default-avatar.png'), defaultAvatarDest);
}

// Allowed frontend origins for CORS (comma-separated env override)
const allowedOrigins = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['https://tangotype.com', 'https://www.tangotype.com', 'http://localhost:3000', 'http://127.0.0.1:3000'];

// Middleware
app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
        callback(new Error('Not allowed by CORS'));
    }
}));
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use(express.static(__dirname));

// Database Initialization
const db = new Database(path.join(DATA_DIR, 'ankitype.db'));
db.exec(`
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password TEXT NOT NULL,
    avatar TEXT DEFAULT '/uploads/default.png',
    playtime INTEGER DEFAULT 0,
    highest_cpm INTEGER DEFAULT 0,
    avg_cpm INTEGER DEFAULT 0,
    test_count INTEGER DEFAULT 0,
    total_mistakes INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS character_stats (
    user_id INTEGER PRIMARY KEY,
    kanji_count INTEGER DEFAULT 0,
    hiragana_count INTEGER DEFAULT 0,
    katakana_count INTEGER DEFAULT 0,
    anki_words INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS avatar_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

`);

const MAX_AVATAR_HISTORY = 5;

// Multer Storage Configuration for Profile Pictures
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
                                   filename: (req, file, cb) => cb(null, `avatar_${req.user.id}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// JWT Authentication Middleware
// Falls back to a `token` field in the JSON body since navigator.sendBeacon
// (used to flush progress on tab-close/visibility-hidden) can't set headers.
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = (authHeader && authHeader.split(' ')[1]) || req.body?.token;
    if (!token) return res.status(401).json({ error: 'Unauthorized' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Forbidden' });
        req.user = user;
        next();
    });
}

// Check Username Availability
app.get('/api/check-username/:username', (req, res) => {
    const user = db.prepare('SELECT id FROM users WHERE username = ?').get(req.params.username);
    res.json({ available: !user });
});

// Register Endpoint
app.post('/api/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Missing credentials' });

    const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
    if (existing) return res.status(400).json({ error: 'Username taken' });

    const hashedPassword = await bcrypt.hash(password, 10);
    const result = db.prepare('INSERT INTO users (username, password) VALUES (?, ?)').run(username, hashedPassword);
    db.prepare('INSERT INTO character_stats (user_id) VALUES (?)').run(result.lastInsertRowid);

    const token = jwt.sign({ id: result.lastInsertRowid, username }, JWT_SECRET);
    res.json({ token, username });
});

// Login Endpoint
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (!user || !(await bcrypt.compare(password, user.password))) {
        return res.status(400).json({ error: 'Invalid username or password' });
    }

    const token = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET);
    res.json({ token, username: user.username });
});

// Change Password (requires the current password; existing tokens stay valid)
app.post('/api/profile/password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ error: 'Missing fields' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'New password must be at least 4 characters' });

    const user = db.prepare('SELECT id, password FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (!(await bcrypt.compare(currentPassword, user.password))) {
        return res.status(400).json({ error: 'Current password is incorrect' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    db.prepare('UPDATE users SET password = ? WHERE id = ?').run(hashedPassword, user.id);
    res.json({ success: true });
});

// Shared shape for both the authenticated "my profile" and public "view a user" endpoints
function getPublicProfile(user) {
    const stats = db.prepare('SELECT kanji_count, hiragana_count, katakana_count FROM character_stats WHERE user_id = ?').get(user.id);
    const kanji = stats?.kanji_count || 0;
    const hiragana = stats?.hiragana_count || 0;
    const katakana = stats?.katakana_count || 0;

    return {
        username: user.username,
        avatar: user.avatar,
        playtime: user.playtime,
        highest_cpm: user.highest_cpm,
        avg_cpm: user.avg_cpm,
        total_mistakes: user.total_mistakes,
        stats: {
            kanji_count: kanji,
            hiragana_count: hiragana,
            katakana_count: katakana,
            total_count: kanji + hiragana + katakana
        }
    };
}

// Get Profile & Stats
app.get('/api/profile', authenticateToken, (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, playtime, highest_cpm, avg_cpm, total_mistakes FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(getPublicProfile(user));
});

// Public: view another user's profile (same shape as /api/profile)
app.get('/api/users/:username', (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, playtime, highest_cpm, avg_cpm, total_mistakes FROM users WHERE username = ?').get(req.params.username);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(getPublicProfile(user));
});

// List this user's recent avatar uploads (for the swap-back picker)
app.get('/api/profile/avatar-history', authenticateToken, (req, res) => {
    const rows = db.prepare(
        'SELECT filename FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
    ).all(req.user.id, MAX_AVATAR_HISTORY);
    res.json({ history: rows.map(r => `/uploads/${r.filename}`) });
});

// Swap the active avatar to a previously uploaded one (no re-upload, no history mutation)
app.post('/api/profile/avatar/select', authenticateToken, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: 'Missing avatar' });

    const filename = avatar.replace(/^\/uploads\//, '');
    const owned = db.prepare('SELECT 1 FROM avatar_history WHERE user_id = ? AND filename = ?').get(req.user.id, filename);
    if (!owned) return res.status(403).json({ error: 'Not your avatar' });

    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(`/uploads/${filename}`, req.user.id);
    res.json({ avatar: `/uploads/${filename}` });
});

// Upload Profile Picture (keeps the 5 most recent uploads per user, deletes older ones)
app.post('/api/profile/avatar', authenticateToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    const userId = req.user.id;

    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, userId);
    db.prepare('INSERT INTO avatar_history (user_id, filename) VALUES (?, ?)').run(userId, req.file.filename);

    const stale = db.prepare(
        'SELECT id, filename FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT -1 OFFSET ?'
    ).all(userId, MAX_AVATAR_HISTORY);

    for (const row of stale) {
        fs.unlink(path.join(uploadDir, row.filename), () => {});
        db.prepare('DELETE FROM avatar_history WHERE id = ?').run(row.id);
    }

    res.json({ avatar: avatarUrl });
});

// Sync Playtime & Stats Endpoint (also reachable via sendBeacon on tab-hide/close)
app.post('/api/profile/sync', authenticateToken, (req, res) => {
    const { playtime, cpm, mistakes, kanjiCount, hiraganaCount, katakanaCount } = req.body;
    const userId = req.user.id;

    const user = db.prepare('SELECT playtime, highest_cpm, avg_cpm, test_count, total_mistakes FROM users WHERE id = ?').get(userId);
    const newPlaytime = (user.playtime || 0) + (playtime || 0);
    const newHighest = Math.max(user.highest_cpm || 0, cpm || 0);
    const newTestCount = user.test_count + (cpm ? 1 : 0);
    const newAvg = newTestCount > 0 ? Math.round(((user.avg_cpm * user.test_count) + (cpm || 0)) / newTestCount) : 0;

    db.prepare('UPDATE users SET playtime = ?, highest_cpm = ?, avg_cpm = ?, test_count = ?, total_mistakes = total_mistakes + ? WHERE id = ?')
        .run(newPlaytime, newHighest, newAvg, newTestCount, mistakes || 0, userId);

    if (kanjiCount || hiraganaCount || katakanaCount) {
        db.prepare(`
            UPDATE character_stats
            SET kanji_count = kanji_count + ?,
                hiragana_count = hiragana_count + ?,
                katakana_count = katakana_count + ?
            WHERE user_id = ?
        `).run(kanjiCount || 0, hiraganaCount || 0, katakanaCount || 0, userId);
    }

    res.json({ success: true });
});



app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
