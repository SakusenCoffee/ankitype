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
const JWT_SECRET = 'anki-type-secret-key-change-me';

// Setup Uploads Directory
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

// Middleware
app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(uploadDir));
app.use(express.static(__dirname));

// Database Initialization
const db = new Database('ankitype.db');
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

`);

// Multer Storage Configuration for Profile Pictures
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
                                   filename: (req, file, cb) => cb(null, `avatar_${req.user.id}_${Date.now()}${path.extname(file.originalname)}`)
});
const upload = multer({ storage });

// JWT Authentication Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
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

// Get Profile & Stats
app.get('/api/profile', authenticateToken, (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, playtime, highest_cpm, avg_cpm, total_mistakes FROM users WHERE id = ?').get(req.user.id);
    const stats = db.prepare('SELECT * FROM character_stats WHERE user_id = ?').get(req.user.id);
    res.json({ ...user, stats });
});

// Upload Profile Picture
app.post('/api/profile/avatar', authenticateToken, upload.single('avatar'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const avatarUrl = `/uploads/${req.file.filename}`;
    db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(avatarUrl, req.user.id);
    res.json({ avatar: avatarUrl });
});

// Sync Playtime & Stats Endpoint
app.post('/api/profile/sync', authenticateToken, (req, res) => {
    const { playtime, cpm, typedChars, mistakes } = req.body;
    const userId = req.user.id;

    const user = db.prepare('SELECT playtime, highest_cpm, avg_cpm, test_count, total_mistakes FROM users WHERE id = ?').get(userId);
    const newPlaytime = (user.playtime || 0) + (playtime || 0);
    const newHighest = Math.max(user.highest_cpm || 0, cpm || 0);
    const newTestCount = user.test_count + (cpm ? 1 : 0);
    const newAvg = newTestCount > 0 ? Math.round(((user.avg_cpm * user.test_count) + (cpm || 0)) / newTestCount) : 0;

    // Update the query to include total_mistakes
    db.prepare('UPDATE users SET playtime = ?, highest_cpm = ?, avg_cpm = ?, test_count = ?, total_mistakes = total_mistakes + ? WHERE id = ?')
    .run(newPlaytime, newHighest, newAvg, newTestCount, mistakes || 0, userId);

    /* ... keep character_stats update logic ... */
    res.json({ success: true });
});



app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
