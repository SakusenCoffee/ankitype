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
// 1mb rather than the 100kb default: the workshop sends whole subtitle files to
// /api/tokenize, and a long one exceeds the default several times over in UTF-8.
app.use(express.json({ limit: '1mb' }));

// Body-parser rejections would otherwise return an HTML page with a stack trace
app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
        return res.status(413).json({ error: 'That text is too large to send.' });
    }
    if (err instanceof SyntaxError && 'body' in err) {
        return res.status(400).json({ error: 'Malformed request.' });
    }
    next(err);
});
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

CREATE TABLE IF NOT EXISTS test_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    test_type TEXT,
    duration_sec INTEGER DEFAULT 0,
    cpm INTEGER DEFAULT 0,
    wpm INTEGER DEFAULT 0,
    total_chars INTEGER DEFAULT 0,
    correct_chars INTEGER DEFAULT 0,
    mistakes INTEGER DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_test_history_user
    ON test_history (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS avatar_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    filename TEXT NOT NULL,
    created_at INTEGER DEFAULT (strftime('%s','now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
);

`);

// Databases created before a column existed need it added; CREATE TABLE IF NOT EXISTS
// above only covers fresh installs.
function addColumnIfMissing(table, column, definition) {
    const existing = db.prepare(`PRAGMA table_info(${table})`).all();
    if (existing.some(c => c.name === column)) return false;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
    return true;
}

/* Tests recorded before this existed have no word list, which the client reads as "this one
   can't be reopened or replayed" rather than as an error. Nothing is backfilled: the words
   were never sent, so there is nothing to backfill them from. */
addColumnIfMissing('test_history', 'words', 'TEXT');

/* This one was only ever added to the CREATE above, which fresh installs get and existing
   databases don't — so any database predating the column was answering /api/profile,
   /api/users/:name and /api/profile/sync with a 500 from "no such column: total_mistakes".
   Found on a dev database that was in exactly that state. */
addColumnIfMissing('users', 'total_mistakes', 'INTEGER DEFAULT 0');

if (addColumnIfMissing('users', 'created_at', 'INTEGER')) {
    // Accounts predating this column have no recorded join date. The earliest thing they
    // did that was recorded is the closest honest estimate; where there is nothing it
    // stays null and the profile omits the field rather than inventing a date.
    db.exec(`
        UPDATE users SET created_at = (
            SELECT MIN(t) FROM (
                SELECT MIN(created_at) AS t FROM avatar_history WHERE user_id = users.id
                UNION ALL
                SELECT MIN(created_at) AS t FROM test_history WHERE user_id = users.id
            )
        )
        WHERE created_at IS NULL
    `);
}

const MAX_AVATAR_HISTORY = 5;

/* The words a run was typed from, kept so a result can be reopened later and so somebody
   else can be handed the same list to type. Two caps rather than one: a count, because a
   max-length run can be several hundred words and nobody replays that far, and a byte
   length, because a word's fields are free text and the count alone doesn't bound the row. */
const MAX_STORED_TEST_WORDS = 200;
const MAX_STORED_TEST_WORDS_BYTES = 20000;

// A row's words as the client should see them: parsed, or null if there are none to show
function readStoredWords(raw) {
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        return Array.isArray(parsed) && parsed.length ? parsed : null;
    } catch {
        return null;
    }
}

/* Trusted only for shape, never for content: these are three display strings per word and
   they go back out to other people's browsers, so each is clamped to a sane length here and
   inserted as text on the client rather than as markup. */
function serialiseTestWords(words) {
    if (!Array.isArray(words) || !words.length) return null;

    const cleaned = words.slice(0, MAX_STORED_TEST_WORDS).map(w => {
        const [kanji, romaji, meaning] = Array.isArray(w) ? w : [];
        return [
            String(kanji ?? "").slice(0, 60),
            String(romaji ?? "").slice(0, 60),
            String(meaning ?? "").slice(0, 120)
        ];
    }).filter(([kanji, romaji]) => kanji || romaji);

    if (!cleaned.length) return null;

    let json = JSON.stringify(cleaned);
    // Still too big after the count cap: drop words off the end until it fits
    while (json.length > MAX_STORED_TEST_WORDS_BYTES && cleaned.length > 1) {
        cleaned.splice(Math.ceil(cleaned.length / 2));
        json = JSON.stringify(cleaned);
    }
    return json.length > MAX_STORED_TEST_WORDS_BYTES ? null : json;
}

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
    const result = db.prepare("INSERT INTO users (username, password, created_at) VALUES (?, ?, strftime('%s','now'))").run(username, hashedPassword);
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
        created_at: user.created_at || null,
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
    const user = db.prepare('SELECT id, username, avatar, created_at, playtime, highest_cpm, avg_cpm, total_mistakes FROM users WHERE id = ?').get(req.user.id);
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(getPublicProfile(user));
});

// Public: view another user's profile (same shape as /api/profile)
app.get('/api/users/:username', (req, res) => {
    const user = db.prepare('SELECT id, username, avatar, created_at, playtime, highest_cpm, avg_cpm, total_mistakes FROM users WHERE username = ?').get(req.params.username);
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

// Drop one picture from the history. If it was the one in use, the next most recent
// takes over; with nothing left, the bundled default does.
app.post('/api/profile/avatar/delete', authenticateToken, (req, res) => {
    const { avatar } = req.body;
    if (!avatar) return res.status(400).json({ error: 'Missing avatar' });

    const filename = String(avatar).replace(/^\/uploads\//, '');
    // A row has to exist for this user before anything is unlinked, and the name has to
    // be a plain filename — belt and braces, since this one touches the filesystem.
    if (!filename || filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return res.status(400).json({ error: 'Invalid avatar' });
    }

    const owned = db.prepare('SELECT id FROM avatar_history WHERE user_id = ? AND filename = ?')
        .get(req.user.id, filename);
    if (!owned) return res.status(403).json({ error: 'Not your avatar' });

    db.prepare('DELETE FROM avatar_history WHERE id = ?').run(owned.id);
    fs.unlink(path.join(uploadDir, filename), () => {});

    const user = db.prepare('SELECT avatar FROM users WHERE id = ?').get(req.user.id);
    let current = user.avatar;

    if (current === `/uploads/${filename}`) {
        const next = db.prepare(
            'SELECT filename FROM avatar_history WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
        ).get(req.user.id);
        current = next ? `/uploads/${next.filename}` : '/uploads/default.png';
        db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(current, req.user.id);
    }

    res.json({ avatar: current });
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

/* ---- Japanese tokenisation --------------------------------------------------------
   Segmenting text and reading kanji needs kuromoji's dictionary. Building it costs
   ~300MB of resident memory and, in a browser, an 18MB download plus a long main-thread
   stall — enough to lock up a machine for a two-word seed. Tokenising itself takes about
   2ms. So the dictionary is built here, once, and shared by every request.

   It is built on demand rather than at boot, and dropped again once the workshop has
   been idle, so an instance that nobody is using doesn't hold 300MB. Rebuilding costs
   roughly 200ms on the next request. */

const kuromoji = require('kuromoji');
const KUROMOJI_DICT = path.join(__dirname, 'node_modules', 'kuromoji', 'dict');
const TOKENIZER_IDLE_MS = 10 * 60 * 1000;
const MAX_TOKENIZE_CHARS = 100000;

let tokenizerPromise = null;
let tokenizerIdleTimer = null;

function releaseTokenizerWhenIdle() {
    clearTimeout(tokenizerIdleTimer);
    tokenizerIdleTimer = setTimeout(() => { tokenizerPromise = null; }, TOKENIZER_IDLE_MS);
    if (tokenizerIdleTimer.unref) tokenizerIdleTimer.unref();
}

function getTokenizer() {
    if (!tokenizerPromise) {
        tokenizerPromise = new Promise((resolve, reject) => {
            kuromoji.builder({ dicPath: KUROMOJI_DICT })
                .build((err, tokenizer) => err ? reject(err) : resolve(tokenizer));
        });
        // Don't cache a failure; the next request should be free to try again
        tokenizerPromise.catch(() => { tokenizerPromise = null; });
    }
    releaseTokenizerWhenIdle();
    return tokenizerPromise;
}

const MAX_SEGMENT_CHARS = 400;

/* kuromoji builds one Viterbi lattice over whatever string it is handed, and the cost
   grows quadratically: 50k characters in one call takes ~16s, the same text split per
   line takes ~220ms for the same words. Lines are independent in Japanese, so the text
   is cut into segments first — on newlines, then on sentence enders, and finally by
   length for input that has neither. */
function segmentText(text) {
    const segments = [];

    for (const line of text.split(/\r?\n/)) {
        if (!line.trim()) continue;
        if (line.length <= MAX_SEGMENT_CHARS) {
            segments.push(line);
            continue;
        }

        let buffer = '';
        for (const sentence of line.split(/(?<=[。！？!?])/)) {
            if (buffer && (buffer + sentence).length > MAX_SEGMENT_CHARS) {
                segments.push(buffer);
                buffer = '';
            }
            buffer += sentence;
            // Still oversized means one unbroken run with no punctuation; cut it
            while (buffer.length > MAX_SEGMENT_CHARS) {
                segments.push(buffer.slice(0, MAX_SEGMENT_CHARS));
                buffer = buffer.slice(MAX_SEGMENT_CHARS);
            }
        }
        if (buffer) segments.push(buffer);
    }

    return segments;
}

// Readings only. Romaji conversion and the JLPT gloss lookup stay on the client, which
// already has wanakana and the word lists, and keeps this response small.
app.post('/api/tokenize', async (req, res) => {
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text.trim()) return res.status(400).json({ error: 'No text supplied' });
    if (text.length > MAX_TOKENIZE_CHARS) {
        return res.status(413).json({ error: `Text is too long (limit ${MAX_TOKENIZE_CHARS} characters)` });
    }

    try {
        const tokenizer = await getTokenizer();
        const segments = segmentText(text);
        const tokens = [];

        for (let i = 0; i < segments.length; i++) {
            for (const t of tokenizer.tokenize(segments[i])) {
                tokens.push({
                    surface: t.surface_form,
                    reading: t.reading && t.reading !== '*' ? t.reading : null,
                    basic: t.basic_form && t.basic_form !== '*' ? t.basic_form : null,
                    pos: t.pos
                });
            }
            // tokenize() is synchronous, so without handing the loop back a long
            // document would stall every other request on this instance
            if (i % 100 === 99) await new Promise(resolve => setImmediate(resolve));
        }

        res.json({ tokens });
    } catch (err) {
        console.error('Tokenizer failed:', err);
        res.status(500).json({ error: 'Tokenizer unavailable' });
    }
});

// One page of history; the full record is kept and paged through
const HISTORY_PAGE_SIZE = 10;

// Record one completed test. The client withholds seeded and idled-out runs.
app.post('/api/profile/history', authenticateToken, (req, res) => {
    const { testType, durationSec, cpm, wpm, totalChars, correctChars, mistakes, words } = req.body;
    const userId = req.user.id;
    const int = v => Math.max(0, Math.round(Number(v) || 0));

    db.prepare(`
        INSERT INTO test_history
            (user_id, test_type, duration_sec, cpm, wpm, total_chars, correct_chars, mistakes, words)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
        userId,
        String(testType || 'unknown').slice(0, 40),
        int(durationSec), int(cpm), int(wpm),
        int(totalChars), int(correctChars), int(mistakes),
        serialiseTestWords(words)
    );

    // Kept in full: it is the player's record, and the client pages through it
    res.json({ success: true });
});

app.get('/api/profile/history', authenticateToken, (req, res) => {
    const limit = Math.max(1, Math.min(100, Math.round(Number(req.query.limit) || HISTORY_PAGE_SIZE)));
    const offset = Math.max(0, Math.round(Number(req.query.offset) || 0));

    const { total } = db.prepare('SELECT COUNT(*) AS total FROM test_history WHERE user_id = ?')
        .get(req.user.id);

    /* The words themselves are not in the list — a page of ten runs would carry a few
       thousand of them for the sake of a button. Each row says whether it has any, and the
       words are fetched by id if the run is actually opened. */
    const rows = db.prepare(`
        SELECT id, created_at, test_type, duration_sec, cpm, wpm, total_chars, correct_chars,
               mistakes, (words IS NOT NULL) AS has_words
        FROM test_history WHERE user_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT ? OFFSET ?
    `).all(req.user.id, limit, offset);

    res.json({ history: rows, total, limit, offset });
});

/* Everyone's runs, newest first. Public, like the profile pages it links to: the same
   numbers are already on /user/<name>, this only puts them in one place. */
app.get('/api/tests/recent', (req, res) => {
    const limit = Math.max(1, Math.min(50, Math.round(Number(req.query.limit) || HISTORY_PAGE_SIZE)));
    const offset = Math.max(0, Math.min(5000, Math.round(Number(req.query.offset) || 0)));

    const { total } = db.prepare('SELECT COUNT(*) AS total FROM test_history').get();

    const rows = db.prepare(`
        SELECT t.id, t.created_at, t.test_type, t.duration_sec, t.cpm, t.wpm,
               t.total_chars, t.correct_chars, t.mistakes,
               (t.words IS NOT NULL) AS has_words,
               u.username, u.avatar
        FROM test_history t
        JOIN users u ON u.id = t.user_id
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ? OFFSET ?
    `).all(limit, offset);

    res.json({ history: rows, total, limit, offset });
});

/* One run in full, words included, for reopening its result or replaying it. Public for the
   same reason the feed is, and it carries the owner so the client knows whether the replay
   button should say "again" or "type these words". */
app.get('/api/tests/:id', (req, res) => {
    const id = Math.round(Number(req.params.id));
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'Bad test id' });

    const row = db.prepare(`
        SELECT t.id, t.created_at, t.test_type, t.duration_sec, t.cpm, t.wpm,
               t.total_chars, t.correct_chars, t.mistakes, t.words,
               u.username, u.avatar
        FROM test_history t
        JOIN users u ON u.id = t.user_id
        WHERE t.id = ?
    `).get(id);

    if (!row) return res.status(404).json({ error: 'No such test' });

    res.json({ ...row, words: readStoredWords(row.words) });
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



/* ---- Multiplayer rooms -------------------------------------------------------------
   Rooms live in memory only. They are ephemeral by nature — everyone is connected at
   once or the room is over — so a restart dropping them is the right behaviour, and it
   keeps races off the disk the database is on.

   The race itself reuses the seed format the SEED tab already speaks: the host builds a
   seed from its own settings and the server relays it, so every player is guaranteed the
   identical word list in the identical order without the server knowing anything about
   Japanese. */

const http = require('http');
const { WebSocketServer } = require('ws');

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const rooms = new Map();
// No 0/O/1/I/5/S: these get read aloud and typed in by hand
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRTUVWXYZ23467889';
const ROOM_CODE_LENGTH = 5;
const MAX_ROOM_MEMBERS = 16;
const HEARTBEAT_MS = 30000;

function makeRoomCode() {
    let code;
    do {
        code = Array.from({ length: ROOM_CODE_LENGTH },
            () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    } while (rooms.has(code));
    return code;
}

function roster(room) {
    return [...room.members.values()].map(m => ({
        id: m.id,
        name: m.name,
        avatar: m.avatar,
        isHost: m.id === room.hostId,
        progress: m.progress,
        finished: m.finished,
        result: m.result
    }));
}

function send(ws, payload) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcast(room, payload) {
    for (const m of room.members.values()) send(m.ws, payload);
}

function broadcastRoster(room) {
    broadcast(room, { type: 'roster', hostId: room.hostId, members: roster(room) });
}

function leaveRoom(ws) {
    const room = rooms.get(ws.roomCode);

    /* Cleared up front, and whatever else happens below. Leaving used to null the room
       code but leave the member id on the socket, so a connection carried its old
       identity around after it was no longer anybody. */
    const memberId = ws.memberId;
    ws.roomCode = null;
    ws.memberId = null;

    if (!room || !memberId) return;

    /* Only if the seat is still this socket's. Deleting by id alone meant a close
       arriving late — or any other path that reached this with a stale id — could evict
       whoever was holding that id by then, which on screen reads as a new player
       replacing an existing one instead of taking a row of their own. */
    const seated = room.members.get(memberId);
    if (!seated || seated.ws !== ws) return;

    room.members.delete(memberId);

    if (room.members.size === 0) {
        rooms.delete(room.code);
        return;
    }
    // Host left: the longest-present remaining player takes over rather than the room dying
    if (room.hostId === memberId) {
        room.hostId = room.members.keys().next().value;
    }
    broadcastRoster(room);
}

let nextMemberId = 1;

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch {
            return send(ws, { type: 'error', message: 'Malformed message' });
        }

        const name = String(msg.name || 'Guest').trim().slice(0, 24) || 'Guest';
        // Relayed as-is for the race track; only ever a path this server already serves
        const avatar = typeof msg.avatar === 'string' && msg.avatar.startsWith('/uploads/')
            ? msg.avatar.slice(0, 200)
            : null;

        if (msg.type === 'create') {
            leaveRoom(ws);
            const code = makeRoomCode();
            ws.memberId = nextMemberId++;
            ws.roomCode = code;

            // The number the host typed is the room's total, themselves included, so a
            // limit of 7 leaves room for 6 others.
            const limit = Math.max(2, Math.min(MAX_ROOM_MEMBERS, Math.round(Number(msg.limit) || 5)));

            const room = {
                code,
                hostId: ws.memberId,
                members: new Map(),
                config: null,
                settings: null,
                racing: false,
                limit
            };
            room.members.set(ws.memberId, {
                id: ws.memberId, name, ws, avatar, progress: 0, finished: false, result: null
            });
            rooms.set(code, room);

            send(ws, { type: 'joined', code, youId: ws.memberId, isHost: true, limit });
            broadcastRoster(room);
            return;
        }

        if (msg.type === 'join') {
            const code = String(msg.code || '').trim().toUpperCase();
            const room = rooms.get(code);
            if (!room) return send(ws, { type: 'error', message: 'No room with that code.' });

            // Give up the old seat before counting, or re-joining a room you are already
            // in is refused for being full by your own presence in it
            leaveRoom(ws);

            if (room.members.size >= room.limit) {
                return send(ws, { type: 'error', message: `That room is full (${room.limit} players).` });
            }

            ws.memberId = nextMemberId++;
            ws.roomCode = code;
            room.members.set(ws.memberId, {
                id: ws.memberId, name, ws, avatar, progress: 0, finished: false, result: null
            });

            send(ws, { type: 'joined', code, youId: ws.memberId,
                       isHost: room.hostId === ws.memberId, limit: room.limit });
            if (room.config) send(ws, { type: 'config', config: room.config });
            if (room.settings) send(ws, { type: 'settings', settings: room.settings });
            broadcastRoster(room);
            return;
        }

        const room = rooms.get(ws.roomCode);
        if (!room) return;
        const me = room.members.get(ws.memberId);
        if (!me) return;

        switch (msg.type) {
            case 'config':
                if (room.hostId !== ws.memberId) return;
                room.config = msg.config || null;
                broadcast(room, { type: 'config', config: room.config });
                break;

            case 'start': {
                if (room.hostId !== ws.memberId) return;
                if (!msg.seed) return send(ws, { type: 'error', message: 'Nothing to race on.' });

                for (const m of room.members.values()) {
                    m.progress = 0;
                    m.finished = false;
                    m.result = null;
                }
                room.racing = true;
                // A moment in the future so everyone starts together despite differing latency
                broadcast(room, {
                    type: 'start',
                    seed: msg.seed,
                    config: room.config,
                    startsIn: 3000
                });
                broadcastRoster(room);
                break;
            }

            case 'settings':
                // Only the host's screen is authoritative; everyone else mirrors it
                if (room.hostId !== ws.memberId) return;
                room.settings = msg.settings || null;
                for (const m of room.members.values()) {
                    if (m.id !== ws.memberId) send(m.ws, { type: 'settings', settings: room.settings });
                }
                break;

            case 'granthost': {
                if (room.hostId !== ws.memberId) return;
                const target = room.members.get(Number(msg.to));
                if (!target) return send(ws, { type: 'error', message: 'That player has left.' });
                room.hostId = target.id;
                broadcastRoster(room);
                break;
            }

            case 'progress':
                me.progress = Math.max(0, Math.min(100, Number(msg.progress) || 0));
                broadcast(room, { type: 'progress', id: me.id, progress: me.progress });
                break;

            case 'finished':
                me.finished = true;
                me.progress = 100;
                me.result = {
                    cpm: Math.round(Number(msg.cpm) || 0),
                    wpm: Math.round(Number(msg.wpm) || 0),
                    accuracy: Math.round(Number(msg.accuracy) || 0),
                    seconds: Math.round(Number(msg.seconds) || 0)
                };
                broadcastRoster(room);
                if ([...room.members.values()].every(m => m.finished)) {
                    room.racing = false;
                    broadcast(room, { type: 'raceover' });
                }
                break;

            case 'leave':
                leaveRoom(ws);
                break;
        }
    });

    ws.on('close', () => leaveRoom(ws));
    ws.on('error', () => leaveRoom(ws));
});

// Drop connections that have gone away without closing cleanly, so rosters don't fill
// with ghosts
setInterval(() => {
    for (const ws of wss.clients) {
        if (!ws.isAlive) {
            ws.terminate();
            continue;
        }
        ws.isAlive = false;
        ws.ping();
    }
}, HEARTBEAT_MS).unref();

server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
