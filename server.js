require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { verifyInitData } = require('./telegramAuth');
const db = require('./db');

const BOT_TOKEN = process.env.BOT_TOKEN;
const CURE_PRICE_STARS = Number(process.env.CURE_PRICE_STARS || 50);
const PORT = process.env.PORT || 3000;
const TEASE_COOLDOWN_MS = 24 * 60 * 60 * 1000;

if (!BOT_TOKEN) {
  console.error('BOT_TOKEN is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

const app = express();
app.use(cors());
app.use(express.json());

/* ---------- helpers ---------- */

function displayName(tgUser) {
  return [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') || 'Игрок';
}

function getOrCreatePlayer(tgUser) {
  const id = String(tgUser.id);
  const existing = db.get(`players.${id}`).value();
  if (!existing) {
    const fresh = {
      id,
      name: displayName(tgUser),
      username: tgUser.username || '',
      length: 10,
      lastTease: 0,
      disease: null
    };
    db.set(`players.${id}`, fresh).write();
    return fresh;
  }
  db.set(`players.${id}.name`, displayName(tgUser)).write();
  if (tgUser.username) db.set(`players.${id}.username`, tgUser.username).write();
  return db.get(`players.${id}`).value();
}

function requireAuth(req, res, next) {
  const initData = req.body.initData || req.query.initData;
  const result = verifyInitData(initData, BOT_TOKEN);
  if (!result) return res.status(401).json({ error: 'invalid_init_data' });
  req.tgUser = result.user;
  next();
}

/* ---------- REST API used by the Mini App ---------- */

// Identify / register the caller and return their current stats.
app.post('/api/me', requireAuth, (req, res) => {
  const player = getOrCreatePlayer(req.tgUser);
  res.json({ player });
});

// Public leaderboard, top 20 by length.
app.get('/api/leaderboard', (req, res) => {
  const players = Object.values(db.get('players').value());
  const top = players.sort((a, b) => b.length - a.length).slice(0, 20);
  res.json({ players: top });
});

// "Потеребонькать" — server enforces the 24h cooldown so it can't be bypassed
// by clearing local storage.
app.post('/api/tease', requireAuth, (req, res) => {
  const player = getOrCreatePlayer(req.tgUser);
  const now = Date.now();
  if (now < (player.lastTease || 0) + TEASE_COOLDOWN_MS) {
    return res.status(429).json({ error: 'cooldown', retryAt: player.lastTease + TEASE_COOLDOWN_MS });
  }
  const delta = Math.round((Math.random() * 2.8 - 0.8) * 10) / 10;
  const newLength = Math.max(0, Math.round((player.length + delta) * 10) / 10);
  db.set(`players.${player.id}.length`, newLength).write();
  db.set(`players.${player.id}.lastTease`, now).write();
  res.json({ delta, player: db.get(`players.${player.id}`).value() });
});

// Apply the outcome of a finished Battleship duel. The battle itself is
// played client-side; this just persists the shared result.
app.post('/api/duel/result', requireAuth, (req, res) => {
  const { opponentId, won } = req.body;
  const player = getOrCreatePlayer(req.tgUser);
  const delta = won ? 3 : -2;
  const newLength = Math.max(0, Math.round((player.length + delta) * 10) / 10);
  db.set(`players.${player.id}.length`, newLength).write();

  if (opponentId && db.get(`players.${opponentId}`).value()) {
    const opp = db.get(`players.${opponentId}`).value();
    const oppDelta = won ? -1.2 : 1.2;
    const oppNew = Math.max(0, Math.round((opp.length + oppDelta) * 10) / 10);
    db.set(`players.${opponentId}.length`, oppNew).write();
  }
  res.json({ player: db.get(`players.${player.id}`).value() });
});

// Create a Telegram Stars invoice link for curing the current disease.
app.post('/api/cure/invoice', requireAuth, async (req, res) => {
  try {
    const player = getOrCreatePlayer(req.tgUser);
    const link = await bot.createInvoiceLink(
      'Лечение — GrowYouPencil',
      'Снимает текущее состояние болезни',
      JSON.stringify({ type: 'cure', tgId: player.id }),
      '', // provider_token is empty for Telegram Stars
      'XTR',
      [{ label: 'Лечение', amount: CURE_PRICE_STARS }]
    );
    res.json({ link, price: CURE_PRICE_STARS });
  } catch (err) {
    console.error('createInvoiceLink failed:', err.message);
    res.status(500).json({ error: 'invoice_failed' });
  }
});

/* ---------- Telegram bot: Stars payment flow ---------- */

bot.on('pre_checkout_query', (query) => {
  bot.answerPreCheckoutQuery(query.id, true).catch((e) => console.error('pre_checkout error:', e.message));
});

bot.on('message', (msg) => {
  if (!msg.successful_payment) return;
  try {
    const payload = JSON.parse(msg.successful_payment.invoice_payload);
    if (payload.type === 'cure' && payload.tgId) {
      db.set(`players.${payload.tgId}.disease`, null).write();
      bot.sendMessage(msg.chat.id, 'Оплата получена, вы вылечены! ✅');
    }
  } catch (err) {
    console.error('Failed to process successful_payment:', err.message);
  }
});

bot.on('polling_error', (err) => console.error('polling_error:', err.message));

app.listen(PORT, () => console.log(`GrowYouPencil API listening on :${PORT}`));
