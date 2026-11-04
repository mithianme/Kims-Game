const express = require('express');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const rateLimit = require('express-rate-limit');
const dotenv = require('dotenv');

dotenv.config();

if (!process.env.SESSION_SECRET) {
    console.error('SESSION_SECRET is not set. Copy .env.example to .env and fill it in.');
    process.exit(1);
}

const app = express();

if (process.env.TRUST_PROXY) {
    app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);
}

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

app.use(session({
    secret: process.env.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.COOKIE_SECURE === 'true',
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
        sameSite: 'lax'
    }
}));

const pool = mysql.createPool({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

const DIFFICULTIES = {
    easy: { items: 6, seconds: 45 },
    medium: { items: 10, seconds: 30 },
    hard: { items: 15, seconds: 20 }
};

const USERNAME_RE = /^[A-Za-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 12;
const DUMMY_HASH = bcrypt.hashSync('timing-placeholder', BCRYPT_ROUNDS);

function usernameError(username) {
    if (!USERNAME_RE.test(username)) {
        return 'Username must be 3 to 20 characters: letters, numbers and underscores only';
    }
    return null;
}

function emailError(email) {
    if (email.length > 100 || !EMAIL_RE.test(email)) return 'Enter a valid email address';
    return null;
}

function passwordError(password) {
    const ok = password.length >= 8
        && /[A-Z]/.test(password)
        && /[a-z]/.test(password)
        && /\d/.test(password)
        && /[!@#$%^&*]/.test(password);
    if (!ok) {
        return 'Password needs at least 8 characters, an uppercase letter, a lowercase letter, a number and one of !@#$%^&*';
    }
    return null;
}

function text(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function requireLogin(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Not logged in' });
    next();
}

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'Too many attempts. Try again in 15 minutes.' }
});

app.use(express.static(path.join(__dirname, 'public'), { index: 'landing.html' }));

app.post('/api/register', authLimiter, async (req, res) => {
    try {
        const username = text(req.body.username);
        const email = text(req.body.email);
        const password = text(req.body.password);

        if (!username || !email || !password) {
            return res.status(400).json({ error: 'All fields are required' });
        }

        const invalid = usernameError(username) || emailError(email) || passwordError(password);
        if (invalid) return res.status(400).json({ error: invalid });

        const [existingUsername] = await pool.query('SELECT id FROM users WHERE username = ?', [username]);
        if (existingUsername.length > 0) return res.status(400).json({ error: 'Username already taken' });

        const [existingEmail] = await pool.query('SELECT id FROM users WHERE email = ?', [email]);
        if (existingEmail.length > 0) return res.status(400).json({ error: 'Email already in use' });

        const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);

        await pool.query(
            'INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)',
            [username, email, passwordHash]
        );

        res.status(201).json({ message: 'Account created successfully' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Username or email already in use' });
        }
        console.error('Register error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/login', authLimiter, async (req, res) => {
    try {
        const email = text(req.body.email);
        const password = text(req.body.password);
        if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

        const [rows] = await pool.query(
            'SELECT id, username, password_hash FROM users WHERE email = ?',
            [email]
        );

        const user = rows[0];
        const match = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH) && Boolean(user);

        if (!match) {
            return res.status(401).json({ error: 'Invalid email or password' });
        }

        req.session.regenerate((err) => {
            if (err) {
                console.error('Session error:', err);
                return res.status(500).json({ error: 'Server error' });
            }
            req.session.userId = user.id;
            req.session.username = user.username;
            res.json({ message: 'Login successful', username: user.username });
        });
    } catch (err) {
        console.error('Login error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: 'Logout failed' });
        res.clearCookie('connect.sid');
        res.json({ message: 'Logged out successfully' });
    });
});

app.get('/api/auth/me', (req, res) => {
    if (req.session.userId) {
        res.json({ loggedIn: true, username: req.session.username });
    } else {
        res.json({ loggedIn: false });
    }
});

app.post('/api/game/save', requireLogin, async (req, res) => {
    const level = DIFFICULTIES[req.body.difficulty];
    const numItems = Number(req.body.num_items);
    const score = Number(req.body.score);

    if (!level || numItems !== level.items || !Number.isInteger(score) || score < 0 || score > numItems) {
        return res.status(400).json({ error: 'Invalid game result' });
    }

    const accuracy = Math.round((score / numItems) * 10000) / 100;

    try {
        await pool.query(
            'INSERT INTO games (user_id, difficulty, score, accuracy, num_items, time_taken_seconds) VALUES (?, ?, ?, ?, ?, ?)',
            [req.session.userId, req.body.difficulty, score, accuracy, numItems, level.seconds]
        );
        res.json({ message: 'Score saved' });
    } catch (err) {
        console.error('Save score error:', err);
        res.status(500).json({ error: 'Failed to save score' });
    }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const [global] = await pool.query(`
            SELECT u.username, g.score, g.accuracy, g.difficulty, g.played_at
            FROM games g JOIN users u ON g.user_id = u.id
            ORDER BY g.score DESC, g.accuracy DESC, g.played_at ASC
            LIMIT 10
        `);
        res.json({ global });
    } catch (err) {
        console.error('Leaderboard error:', err);
        res.status(500).json({ error: 'Failed to fetch leaderboard' });
    }
});

app.get('/api/user/stats', requireLogin, async (req, res) => {
    try {
        const [[stats]] = await pool.query(`
            SELECT
                MAX(score) AS best_score,
                AVG(accuracy) AS avg_accuracy,
                COUNT(*) AS games_played
            FROM games
            WHERE user_id = ?
        `, [req.session.userId]);

        const [[user]] = await pool.query('SELECT created_at FROM users WHERE id = ?', [req.session.userId]);

        res.json({ ...stats, member_since: user ? user.created_at : null });
    } catch (err) {
        console.error('Stats error:', err);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/user/game-history', requireLogin, async (req, res) => {
    try {
        const [history] = await pool.query(`
            SELECT difficulty, score, accuracy, num_items, played_at
            FROM games
            WHERE user_id = ?
            ORDER BY played_at DESC
            LIMIT 10
        `, [req.session.userId]);
        res.json(history);
    } catch (err) {
        console.error('Game history error:', err);
        res.status(500).json({ error: 'Failed to fetch game history' });
    }
});

app.post('/api/user/update-profile', requireLogin, async (req, res) => {
    try {
        const userId = req.session.userId;
        const username = text(req.body.username);
        const email = text(req.body.email);
        const currentPassword = text(req.body.currentPassword);
        const newPassword = text(req.body.newPassword);

        const [[user]] = await pool.query('SELECT username, password_hash FROM users WHERE id = ?', [userId]);
        if (!user) return res.status(404).json({ error: 'User not found' });

        const usernameChanged = username && username !== user.username;

        if (usernameChanged) {
            const invalid = usernameError(username);
            if (invalid) return res.status(400).json({ error: invalid });
        }
        if (email) {
            const invalid = emailError(email);
            if (invalid) return res.status(400).json({ error: invalid });
        }
        if (newPassword) {
            const invalid = passwordError(newPassword);
            if (invalid) return res.status(400).json({ error: invalid });
        }

        if (email || newPassword) {
            if (!currentPassword) return res.status(400).json({ error: 'Current password is required' });
            const match = await bcrypt.compare(currentPassword, user.password_hash);
            if (!match) return res.status(400).json({ error: 'Current password is incorrect' });
        }

        if (usernameChanged) {
            const [existing] = await pool.query('SELECT id FROM users WHERE username = ? AND id != ?', [username, userId]);
            if (existing.length > 0) return res.status(400).json({ error: 'Username already taken' });
        }

        if (email) {
            const [existing] = await pool.query('SELECT id FROM users WHERE email = ? AND id != ?', [email, userId]);
            if (existing.length > 0) return res.status(400).json({ error: 'Email already in use' });
        }

        const updates = [];
        const params = [];
        if (usernameChanged) { updates.push('username = ?'); params.push(username); }
        if (email) { updates.push('email = ?'); params.push(email); }
        if (newPassword) {
            updates.push('password_hash = ?');
            params.push(await bcrypt.hash(newPassword, BCRYPT_ROUNDS));
        }

        if (updates.length === 0) return res.status(400).json({ error: 'No changes provided' });

        await pool.query(`UPDATE users SET ${updates.join(', ')} WHERE id = ?`, [...params, userId]);

        if (usernameChanged) req.session.username = username;

        res.json({ message: 'Profile updated successfully' });
    } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') {
            return res.status(400).json({ error: 'Username or email already in use' });
        }
        console.error('Update profile error:', err);
        res.status(500).json({ error: 'Server error' });
    }
});

app.delete('/api/user/delete-account', requireLogin, async (req, res) => {
    try {
        await pool.query('DELETE FROM users WHERE id = ?', [req.session.userId]);

        req.session.destroy((err) => {
            if (err) console.error('Session destroy error:', err);
            res.clearCookie('connect.sid');
            res.json({ message: 'Account deleted successfully' });
        });
    } catch (err) {
        console.error('Delete account error:', err);
        res.status(500).json({ error: 'Failed to delete account' });
    }
});

const imageCache = new Map();

app.get('/api/image', async (req, res) => {
    const query = text(req.query.q);
    const size = req.query.size === 'thumb' ? 'thumb' : 'small';

    if (!/^[A-Za-z][A-Za-z -]{0,39}$/.test(query)) {
        return res.status(400).json({ error: 'Invalid image query' });
    }
    if (!process.env.UNSPLASH_ACCESS_KEY) {
        return res.status(503).json({ error: 'Image search is not configured' });
    }

    const key = query.toLowerCase();

    try {
        if (!imageCache.has(key)) {
            const url = `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=1&orientation=landscape`;
            const response = await fetch(url, {
                headers: { Authorization: `Client-ID ${process.env.UNSPLASH_ACCESS_KEY}` },
                signal: AbortSignal.timeout(5000)
            });
            if (!response.ok) throw new Error(`Unsplash responded ${response.status}`);
            const data = await response.json();
            const photo = data.results && data.results[0];
            imageCache.set(key, photo ? photo.urls : null);
        }

        const urls = imageCache.get(key);
        if (!urls) return res.status(404).json({ error: 'No image found' });
        res.set('Cache-Control', 'public, max-age=86400');
        res.json({ url: urls[size] });
    } catch (err) {
        console.error(`Image lookup failed for "${query}":`, err.message);
        res.status(502).json({ error: 'Image lookup failed' });
    }
});

app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Not found' });
});

app.use((req, res) => {
    res.status(404).sendFile(path.join(__dirname, 'public', 'landing.html'));
});

app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') {
        return res.status(400).json({ error: 'Invalid request body' });
    }
    console.error('Unhandled error:', err);
    res.status(500).json({ error: 'Server error' });
});

if (require.main === module) {
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, () => console.log(`Kim's Game running on http://localhost:${port}`));
}

module.exports = app;
