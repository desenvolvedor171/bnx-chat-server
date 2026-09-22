const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const path = require('path');
const db = require('./db');

const PORT = process.env.PORT || 3001;
const SELLER_USER = process.env.SELLER_USER || 'vendedor';
const SELLER_PASSWORD = process.env.SELLER_PASSWORD || 'bnx123';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '1mb' }));

// CORS aberto para o chat do cliente (autenticado pelo código do pedido)
app.use('/api/chat', (req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(session({
  secret: process.env.SESSION_SECRET || 'troque-esta-chave-em-producao',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Banco ----------
const CONV_DDL = db.isPostgres
  ? `CREATE TABLE IF NOT EXISTS conversations (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      buyer_name TEXT NOT NULL,
      items TEXT NOT NULL,
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'novo',
      unread INTEGER NOT NULL DEFAULT 1,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`
  : `CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT UNIQUE NOT NULL,
      buyer_name TEXT NOT NULL,
      items TEXT NOT NULL,
      total REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'novo',
      unread INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )`;

const MSG_DDL = db.isPostgres
  ? `CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT NOW()
    )`
  : `CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      sender TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now', 'localtime'))
    )`;

async function initDb() {
  await db.batch([
    CONV_DDL,
    MSG_DDL,
    `CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL
    )`
  ]);
  const exists = (await db.execute({ sql: 'SELECT 1 FROM users WHERE username = ?', args: [SELLER_USER] })).rows[0];
  if (!exists) {
    await db.execute({
      sql: 'INSERT INTO users (username, password_hash) VALUES (?, ?)',
      args: [SELLER_USER, bcrypt.hashSync(SELLER_PASSWORD, 10)]
    });
    console.log(`Seed: vendedor criado (login: ${SELLER_USER})`);
  }
}

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return 'BNX-' + s;
}

async function getConv(id, code) {
  const rs = await db.execute({ sql: 'SELECT * FROM conversations WHERE id = ?', args: [Number(id)] });
  const conv = rs.rows[0];
  if (!conv || conv.code !== code) return null;
  return conv;
}

// ---------- Chat do cliente ----------
app.post('/api/chat/start', async (req, res) => {
  const { buyerName, items, total } = req.body || {};
  if (!buyerName || String(buyerName).trim().length < 2 || String(buyerName).length > 60) {
    return res.status(400).json({ error: 'Nome inválido.' });
  }
  if (!Array.isArray(items) || !items.length || items.length > 20) {
    return res.status(400).json({ error: 'Itens inválidos.' });
  }
  const t = Number(total);
  if (!Number.isFinite(t) || t <= 0 || t > 100000) {
    return res.status(400).json({ error: 'Total inválido.' });
  }
  const cleanItems = items.map(i => ({ name: String(i.name).slice(0, 80), price: Number(i.price) || 0 }));

  let conv = null;
  for (let i = 0; i < 5 && !conv; i++) {
    const code = makeCode();
    try {
      const r = await db.execute({
        sql: 'INSERT INTO conversations (code, buyer_name, items, total) VALUES (?, ?, ?, ?) RETURNING id',
        args: [code, String(buyerName).trim().slice(0, 60), JSON.stringify(cleanItems), t]
      });
      conv = { id: Number(r.rows[0].id), code };
    } catch (e) { /* código duplicado: tenta de novo */ }
  }
  if (!conv) return res.status(500).json({ error: 'Tente novamente.' });

  await db.execute({
    sql: 'INSERT INTO messages (conversation_id, sender, text) VALUES (?, ?, ?)',
    args: [conv.id, 'seller', `Olá ${String(buyerName).trim().split(' ')[0]}! Recebemos seu pedido ${conv.code}. Envie o comprovante do Pix aqui para liberarmos seu produto. 👊`]
  });
  res.json(conv);
});

app.get('/api/chat/:id/messages', async (req, res) => {
  const conv = await getConv(req.params.id, req.query.code || '');
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada.' });
  const since = Number(req.query.since || 0);
  const rs = await db.execute({
    sql: 'SELECT id, sender, text, created_at FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id',
    args: [conv.id, since]
  });
  res.json(rs.rows);
});

app.post('/api/chat/:id/message', async (req, res) => {
  const { code, text } = req.body || {};
  const conv = await getConv(req.params.id, code || '');
  if (!conv) return res.status(404).json({ error: 'Conversa não encontrada.' });
  if (!text || !String(text).trim() || String(text).length > 1000) {
    return res.status(400).json({ error: 'Mensagem inválida.' });
  }
  await db.execute({
    sql: 'INSERT INTO messages (conversation_id, sender, text) VALUES (?, ?, ?)',
    args: [conv.id, 'client', String(text).trim()]
  });
  await db.execute({ sql: 'UPDATE conversations SET unread = 1 WHERE id = ?', args: [conv.id] });
  res.json({ ok: true });
});

// ---------- Painel do vendedor ----------
function requireAuth(req, res, next) {
  if (req.session && req.session.seller) return next();
  res.status(401).json({ error: 'Não autenticado.' });
}

app.get('/api/seller/me', (req, res) => {
  res.json({ loggedIn: !!(req.session && req.session.seller) });
});

app.post('/api/seller/login', async (req, res) => {
  const { username, password } = req.body || {};
  const rs = username
    ? await db.execute({ sql: 'SELECT * FROM users WHERE username = ?', args: [username] })
    : { rows: [] };
  const user = rs.rows[0];
  if (!user || !bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
  }
  req.session.seller = user.username;
  res.json({ ok: true });
});

app.post('/api/seller/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/seller/conversations', requireAuth, async (req, res) => {
  const rs = await db.execute(
    'SELECT id, code, buyer_name, items, total, status, unread, created_at FROM conversations ORDER BY unread DESC, id DESC'
  );
  res.json(rs.rows.map(r => ({
    id: r.id, code: r.code, buyer_name: r.buyer_name,
    items: JSON.parse(r.items), total: Number(r.total),
    status: r.status, unread: Number(r.unread), created_at: r.created_at
  })));
});

app.get('/api/seller/conversation/:id', requireAuth, async (req, res) => {
  const rs = await db.execute({ sql: 'SELECT * FROM conversations WHERE id = ?', args: [Number(req.params.id)] });
  const conv = rs.rows[0];
  if (!conv) return res.status(404).json({ error: 'Não encontrada.' });
  await db.execute({ sql: 'UPDATE conversations SET unread = 0 WHERE id = ?', args: [conv.id] });
  const msgs = await db.execute({
    sql: 'SELECT id, sender, text, created_at FROM messages WHERE conversation_id = ? ORDER BY id',
    args: [conv.id]
  });
  res.json({
    id: conv.id, code: conv.code, buyer_name: conv.buyer_name,
    items: JSON.parse(conv.items), total: Number(conv.total),
    status: conv.status, created_at: conv.created_at, messages: msgs.rows
  });
});

app.post('/api/seller/conversation/:id/message', requireAuth, async (req, res) => {
  const { text } = req.body || {};
  if (!text || !String(text).trim() || String(text).length > 1000) {
    return res.status(400).json({ error: 'Mensagem inválida.' });
  }
  await db.execute({
    sql: 'INSERT INTO messages (conversation_id, sender, text) VALUES (?, ?, ?)',
    args: [Number(req.params.id), 'seller', String(text).trim()]
  });
  res.json({ ok: true });
});

app.post('/api/seller/conversation/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['novo', 'atendimento', 'finalizado'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }
  await db.execute({ sql: 'UPDATE conversations SET status = ? WHERE id = ?', args: [status, Number(req.params.id)] });
  res.json({ ok: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

async function main() {
  await initDb();
  app.listen(PORT, () => console.log(`Chat BNX no ar: porta ${PORT}`));
}
main().catch(err => { console.error(err); process.exit(1); });
