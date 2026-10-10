// server.js
require('dotenv').config();
const express = require('express');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const dns = require('dns');

// Принудительно IPv4 (иногда помогает при блокировках)
dns.setDefaultResultOrder('ipv4first');

// ==========================================
// ПРОКСИ (нужен только локально, если есть VPN)
// ==========================================
if (process.env.PROXY_URL) {
    try {
        const { ProxyAgent, setGlobalDispatcher } = require('undici');
        console.log(`🌐 Используем прокси: ${process.env.PROXY_URL}`);
        setGlobalDispatcher(new ProxyAgent(process.env.PROXY_URL));
        console.log('✅ Прокси настроен.');
    } catch (e) {
        console.error('❌ Ошибка прокси:', e.message);
    }
}
// ==========================================

const app = express();
const PORT = process.env.PORT || 3000;

// Доверяем прокси Render (X-Forwarded-For)
app.set('trust proxy', 1);

// ========== НАСТРОЙКИ ИГРЫ ==========
const START_BALANCE = 10_000_000;   // 10 млн PK при входе
const RED_NUMBERS   = [1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36];
const BLACK_NUMBERS = [2,4,6,8,10,11,13,15,17,20,22,24,26,28,29,31,33,35];
const SPIN_COOLDOWN_MS = 1500;
// =====================================

// ========== ХРАНИЛИЩЕ ПОЛЬЗОВАТЕЛЕЙ ==========
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'users.json');
const users = new Map(); // discordId -> {id, username, avatar, balance, totalWon, totalBet, createdAt, lastSpin}

function loadUsers() {
    try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        if (fs.existsSync(DATA_FILE)) {
            const arr = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            for (const u of arr) users.set(u.id, u);
            console.log(`💾 Загружено пользователей: ${users.size}`);
        }
    } catch (e) {
        console.error('Ошибка загрузки users.json:', e.message);
    }
}

let saveTimer = null;
function saveUsers() {
    // Дебаунс сохранения, чтобы не писать файл на каждый чих
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
        saveTimer = null;
        try {
            fs.mkdirSync(DATA_DIR, { recursive: true });
            fs.writeFileSync(DATA_FILE, JSON.stringify([...users.values()], null, 2));
        } catch (e) {
            console.error('Ошибка сохранения users.json:', e.message);
        }
    }, 500);
}
loadUsers();

// ========== MIDDLEWARE ==========
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
    name: 'sid',
    secret: process.env.SESSION_SECRET || 'dev-only-change-me-in-prod',
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 дней
    },
}));

// ========== СТРАНИЦЫ ==========
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ========== DISCORD OAUTH ==========
app.get('/auth/discord/login', (req, res) => {
    const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
    const REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
    const url = `https://discord.com/api/oauth2/authorize?client_id=${CLIENT_ID}&redirect_uri=${encodeURIComponent(REDIRECT_URI)}&response_type=code&scope=identify%20email`;
    res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
    const code = req.query.code;
    if (!code) return res.status(400).send('Ошибка: нет кода.');

    try {
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: process.env.DISCORD_CLIENT_ID,
                client_secret: process.env.DISCORD_CLIENT_SECRET,
                code,
                grant_type: 'authorization_code',
                redirect_uri: process.env.DISCORD_REDIRECT_URI,
            }),
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        });
        const tokenData = await tokenRes.json();
        if (tokenData.error) {
            console.error('Discord token error:', tokenData.error);
            return res.status(500).send('Ошибка обмена кода.');
        }

        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { authorization: `Bearer ${tokenData.access_token}` },
        });
        const userData = await userRes.json();

        // Создаём/обновляем пользователя
        let user = users.get(userData.id);
        if (!user) {
            user = {
                id: userData.id,
                username: userData.username,
                avatar: userData.avatar,
                balance: START_BALANCE,
                totalWon: 0,
                totalBet: 0,
                createdAt: Date.now(),
                lastSpin: 0,
            };
            console.log(`🆕 Новый игрок: ${userData.username}`);
        } else {
            // Обновляем имя/аватар, но не трогаем баланс
            user.username = userData.username;
            user.avatar = userData.avatar;
        }
        users.set(user.id, user);
        saveUsers();

        // Ротация сессии после логина (защита от session fixation)
        req.session.regenerate((err) => {
            if (err) {
                console.error('Session regenerate error:', err);
                return res.status(500).send('Ошибка сессии.');
            }
            req.session.userId = user.id;
            req.session.save(() => res.redirect('/'));
        });
    } catch (e) {
        console.error('Callback error:', e);
        res.status(500).send('Внутренняя ошибка сервера.');
    }
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.clearCookie('sid');
        res.json({ ok: true });
    });
});

// ========== API ==========
function requireAuth(req, res, next) {
    if (!req.session.userId) return res.status(401).json({ error: 'Не авторизован' });
    const user = users.get(req.session.userId);
    if (!user) return res.status(401).json({ error: 'Пользователь не найден' });
    req.user = user;
    next();
}

app.get('/api/me', (req, res) => {
    if (!req.session.userId) return res.json({ loggedIn: false });
    const user = users.get(req.session.userId);
    if (!user) return res.json({ loggedIn: false });

    // Позиция в лидерборде
    const ranked = [...users.values()].sort((a, b) =>
        (b.totalWon - b.totalBet) - (a.totalWon - a.totalBet));
    const rank = ranked.findIndex(u => u.id === user.id) + 1;

    res.json({
        loggedIn: true,
        user: {
            id: user.id,
            username: user.username,
            avatar: user.avatar,
            balance: user.balance,
            netProfit: user.totalWon - user.totalBet,
            totalWon: user.totalWon,
            totalBet: user.totalBet,
            rank,
            totalPlayers: users.size,
        },
    });
});

app.post('/api/spin', requireAuth, (req, res) => {
    const now = Date.now();
    if (now - req.user.lastSpin < SPIN_COOLDOWN_MS) {
        return res.status(429).json({ error: 'Слишком быстро! Подожди немного.' });
    }

    const { color, amount } = req.body || {};
    const bet = Math.floor(Number(amount));
    if (!['red', 'black', 'green'].includes(color)) {
        return res.status(400).json({ error: 'Неверный цвет.' });
    }
    if (!Number.isFinite(bet) || bet < 100 || bet > req.user.balance) {
        return res.status(400).json({ error: 'Неверная ставка.' });
    }

    // Крутим рулетку: 0..36
    const number = Math.floor(Math.random() * 37);
    let resultColor;
    if (number === 0) resultColor = 'green';
    else if (RED_NUMBERS.includes(number)) resultColor = 'red';
    else resultColor = 'black';

    // Выплата
    let payout = 0;
    const won = color === resultColor;
    if (won) {
        payout = color === 'green' ? bet * 36 : bet * 2;
    }

    req.user.balance = req.user.balance - bet + payout;
    req.user.totalBet += bet;
    req.user.totalWon += payout;
    req.user.lastSpin = now;
    saveUsers();

    // Логируем событие БЕЗ секретов
    console.log(`🎰 ${req.user.username}: ставка ${bet} на ${color} → выпало ${number} (${resultColor}) | ${won ? '+' + (payout - bet) : '-' + bet}`);

    res.json({
        number,
        resultColor,
        won,
        payout,
        bet,
        netChange: payout - bet,
        balance: req.user.balance,
    });
});

app.post('/api/refill', requireAuth, (req, res) => {
    if (req.user.balance > 0) {
        return res.status(400).json({ error: 'У тебя ещё есть PK!' });
    }
    req.user.balance = START_BALANCE;
    saveUsers();
    res.json({ balance: req.user.balance });
});

app.get('/api/leaderboard', (req, res) => {
    const list = [...users.values()]
        .map(u => ({
            id: u.id,
            username: u.username,
            avatar: u.avatar,
            balance: u.balance,
            netProfit: u.totalWon - u.totalBet,
            totalWon: u.totalWon,
        }))
        .sort((a, b) => b.netProfit - a.netProfit)
        .slice(0, 20);
    res.json({ leaderboard: list });
});

// ========== СТАРТ ==========
app.listen(PORT, () => {
    console.log(`✅ Сервер запущен: http://localhost:${PORT}`);
});