'use strict';
/*
 * 블록 월드 RPG 서버 (index.html 최신 버전용)
 *
 * 필요 패키지: npm i express helmet express-rate-limit ws
 * 폴더 구조:   server.js  /  public/index.html
 * 환경변수:    PORT, DATA_DIR, SESSION_SECRET, ALLOWED_ORIGINS(콤마 구분), ADMIN_PASSWORD
 */
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { WebSocketServer, WebSocket } = require('ws');

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT) || 10000;
const HOST = '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'accounts.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14;
const MAX_PLAYERS = 80;
const WORLD_LIMIT = 340; // 클라이언트 월드 반경(약 327) + 여유
const ALLOWED_ORIGINS = new Set((process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));

fs.mkdirSync(DATA_DIR, { recursive: true });
let db = { users: {}, states: {}, bans: {} };
try {
  const parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (parsed && parsed.users && parsed.states) db = parsed;
} catch (e) { if (e.code !== 'ENOENT') console.error('Account store could not be read:', e.message); }
if (!db.bans) db.bans = {};
function persist() { const tmp = DB_FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db)); fs.renameSync(tmp, DB_FILE); }

const appLimiter = rateLimit({ windowMs: 60000, limit: 240, standardHeaders: 'draft-7', legacyHeaders: false });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: '로그인/가입 시도가 너무 많습니다. 잠시 후 다시 시도하세요.' } });

/* ===== 상점 (클라이언트 WP / AR / PT 와 인덱스 일치) ===== */
const SHOP_W = [null,
  { name: '철검', cost: 80 }, { name: '강철검', cost: 300 }, { name: '미스릴검', cost: 900 }, { name: '용사검', cost: 2500 },
  { name: '마검', cost: 7000 }, { name: '드래곤 슬레이어', cost: 18000 }, { name: '신검', cost: 45000 }];
const SHOP_A = [null,
  { name: '가죽갑옷', cost: 80 }, { name: '사슬갑옷', cost: 250 }, { name: '철갑옷', cost: 700 }, { name: '강철갑옷', cost: 1800 },
  { name: '미스릴 갑옷', cost: 4500 }, { name: '용비늘 갑옷', cost: 11000 }, { name: '성기사 갑옷', cost: 28000 }, { name: '암흑왕 갑옷', cost: 65000 }];
const SHOP_P = [{ name: '체력 물약', cost: 15 }, { name: '고급 물약', cost: 45 }, { name: '대형 물약', cost: 120 }, { name: '엘릭서', cost: 500 }];

/* ===== 퀘스트 (클라이언트 QD 와 동일: need / coin / xp) ===== */
const QUESTS = {};
[
  ['s1', 5, 80, 40], ['m1', 6, 150, 90], ['w1', 8, 300, 180], ['b1', 5, 550, 350], ['g1', 10, 900, 700],
  ['o1', 6, 1500, 1100], ['k1', 10, 2400, 1800], ['h1', 8, 3800, 3000], ['l1', 3, 6500, 5500], ['d1', 1, 150000, 150000],
  ['a1', 15, 100, 60], ['a2', 40, 700, 500], ['a3', 300, 20000, 15000], ['z6', 1, 1500, 1500], ['f1', 10, 3000, 2500],
  ['f2', 6, 4500, 4000], ['z7', 1, 3000, 3000], ['c1', 10, 6000, 5500], ['c2', 8, 9000, 8000], ['z8', 1, 6000, 6000],
  ['t1', 12, 12000, 11000], ['t2', 8, 18000, 16000], ['z9', 1, 12000, 12000], ['i1', 12, 25000, 22000], ['i2', 8, 35000, 30000],
  ['z10', 1, 25000, 25000], ['n1', 6, 60000, 50000], ['dl', 1, 200000, 200000],
  ['ci1', 10, 120, 70], ['ci2', 8, 200, 120], ['ci3', 10, 450, 280], ['ci4', 6, 900, 600], ['ci5', 10, 1500, 1100],
  ['ci6', 6, 2400, 1800], ['ci7', 12, 3800, 3000], ['ci8', 8, 6000, 5000], ['ci9', 3, 10000, 9000],
  ['cj1', 10, 5000, 4500], ['cj2', 6, 8000, 7000], ['cj3', 10, 11000, 10000], ['cj4', 8, 16000, 14000], ['cj5', 10, 22000, 20000],
  ['cj6', 8, 32000, 28000], ['cj7', 10, 45000, 40000], ['cj8', 8, 65000, 55000], ['cj9', 6, 100000, 90000],
  ['bk1', 1, 1500, 1200], ['bk2', 1, 6000, 4500], ['bk3', 1, 14000, 11000], ['bk4', 1, 40000, 30000], ['bk5', 1, 500000, 500000],
  ['bk6', 1, 80000, 60000], ['bk7', 1, 120000, 90000], ['bk8', 1, 200000, 150000], ['bk9', 1, 350000, 250000]
].forEach(([id, need, coin, xp]) => { QUESTS[id] = { need, coin, xp }; });

/* ===== 서버 공유 몬스터 (클라이언트의 확장된 맵 / 강화된 스탯 기준) ===== */
const MT = {
  slime:    { hp: 30,  dmg: 6,  xp: 12,  g: 3,   sp: 3.6, r: [22.5, 51],   n: 12, reach: 1.8 },
  wolf:     { hp: 55,  dmg: 10, xp: 20,  g: 6,   sp: 8,   r: [60, 81],     n: 10, reach: 2.2 },
  goblin:   { hp: 135, dmg: 18, xp: 51,  g: 16,  sp: 5,   r: [90, 108],    n: 8,  reach: 2.3 },
  skeleton: { hp: 252, dmg: 30, xp: 88,  g: 28,  sp: 5.5, r: [115.5, 126], n: 7,  reach: 2.4 },
  golem:    { hp: 1250, dmg: 76, xp: 352, g: 144, sp: 3,   r: [132, 138],   n: 3,  reach: 4.4 }
};
const VILLAGE_R = 18;
const monsters = new Map();
let monsterSeq = 0;
const rnd = (a, b) => a + Math.random() * (b - a);
function spawnMonster(type) {
  const d = MT[type]; if (!d) return null;
  const a = Math.random() * Math.PI * 2, r = rnd(d.r[0], d.r[1]);
  const id = 'm' + (++monsterSeq);
  const m = { id, type, x: Math.cos(a) * r, z: Math.sin(a) * r, hp: d.hp, mhp: d.hp, dead: false, rt: 0, face: 0 };
  monsters.set(id, m);
  return m;
}
for (const [type, d] of Object.entries(MT)) for (let i = 0; i < d.n; i++) spawnMonster(type);
console.log('Server monsters spawned:', monsters.size);
const monView = m => ({ id: m.id, type: m.type, x: +m.x.toFixed(2), z: +m.z.toFixed(2), hp: Math.ceil(m.hp), mhp: m.mhp, dead: !!m.dead, face: +(m.face || 0).toFixed(3) });
const monsterSnapshot = () => [...monsters.values()].map(monView);

/* ===== 미들웨어 ===== */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", 'https://cdnjs.cloudflare.com'],
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      connectSrc: ["'self'", 'ws:', 'wss:'],
      imgSrc: ["'self'", 'data:'],
      fontSrc: ["'self'", 'data:'],
      objectSrc: ["'none'"],
      baseUri: ["'self'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: null
    }
  },
  crossOriginEmbedderPolicy: false,
  referrerPolicy: { policy: 'no-referrer' }
}));
app.use(appLimiter);
app.use(express.json({ limit: '32kb', strict: true }));
app.use(express.text({ type: 'text/plain', limit: '32kb' }));

/* ===== 인증 유틸 ===== */
function safeEqual(a, b) { const aa = Buffer.from(a), bb = Buffer.from(b); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); }
function hashPassword(password, salt) { return crypto.scryptSync(password, salt, 64).toString('hex'); }
function validUsername(s) { return typeof s === 'string' && /^[A-Za-z0-9_가-힣.-]{3,24}$/.test(s); }
function usernameKey(s) { return s.toLocaleLowerCase('en-US'); }
function validPassword(s) { return typeof s === 'string' && s.length >= 8 && s.length <= 128; }
function sign(payload) { const body = Buffer.from(JSON.stringify(payload)).toString('base64url'); const sig = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url'); return body + '.' + sig; }
function unsign(token) {
  if (typeof token !== 'string') return null;
  const [body, sig] = token.split('.'); if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(body).digest('base64url');
  if (!safeEqual(sig, expected)) return null;
  try { const p = JSON.parse(Buffer.from(body, 'base64url').toString()); if (!p.u || !p.exp || p.exp < Date.now()) return null; return p; } catch { return null; }
}
function isSecureReq(req) { return req.secure || String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https'; }
function setCookie(req, res, token) {
  res.setHeader('Set-Cookie', `rpg_session=${token}; Path=/; HttpOnly; ${isSecureReq(req) ? 'Secure; ' : ''}SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}
function clearCookie(req, res) {
  res.setHeader('Set-Cookie', `rpg_session=; Path=/; HttpOnly; ${isSecureReq(req) ? 'Secure; ' : ''}SameSite=Lax; Max-Age=0`);
}
function sessionKeyFromHeader(cookieHeader) {
  const item = String(cookieHeader || '').split(';').map(x => x.trim()).find(x => x.startsWith('rpg_session='));
  if (!item) return null;
  const payload = unsign(decodeURIComponent(item.slice('rpg_session='.length)));
  return payload && db.users[payload.u] ? payload.u : null;
}
const userFromReq = req => sessionKeyFromHeader(req.headers.cookie);
const isBanned = key => !!(db.users[key] && (db.users[key].banned || db.bans[key]));
function requireUser(req, res, next) {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (isBanned(u)) return res.status(403).json({ error: '차단된 계정입니다.' });
  req.userKey = u; next();
}
const publicName = key => db.users[key].username;

/* ===== 관리자 계정 시드 =====
 * 비밀번호를 코드에 박아두지 않습니다. ADMIN_PASSWORD 환경변수를 설정하세요.
 * (이미 ADMIN 계정이 data/accounts.json 에 있으면 비밀번호는 그대로 유지됩니다.) */
(function seedAdmin() {
  const key = usernameKey('ADMIN');
  if (!db.users[key]) {
    let password = process.env.ADMIN_PASSWORD;
    let generated = false;
    if (!password || password.length < 8) { password = crypto.randomBytes(12).toString('base64url'); generated = true; }
    const salt = crypto.randomBytes(16).toString('hex');
    db.users[key] = { username: 'ADMIN', passwordHash: hashPassword(password, salt), salt, createdAt: Date.now(), isAdmin: true, banned: false };
    db.states[key] = null;
    try {
      persist();
      console.log('Admin account seeded: ADMIN');
      if (generated) console.log('ADMIN_PASSWORD 미설정 → 임시 비밀번호(이번 한 번만 표시):', password);
    } catch (e) { console.error('Admin seed failed', e.message); }
  } else {
    db.users[key].isAdmin = true;
    db.users[key].banned = false;
  }
})();

/* ===== 플레이어 상태 ===== */
function newPlayer() {
  return { x: 0, z: 8, y: 0, hp: 100, mhp: 100, lv: 1, xp: 0, nx: 30, coin: 0, at: 0, face: 0, inv: 0, w: 0, a: 0, pot: [2, 0, 0, 0], rg: 0, ow: [0], oa: [0], qa: {}, qd: [], questProgress: {} };
}
function ensurePlayer(key) {
  if (!db.states[key] || !db.states[key].player) db.states[key] = { version: 1, player: newPlayer(), camera: {}, savedAt: Date.now() };
  const p = db.states[key].player;
  if (!Array.isArray(p.pot)) p.pot = [2, 0, 0, 0];
  while (p.pot.length < 4) p.pot.push(0);
  if (!Array.isArray(p.ow)) p.ow = [0];
  if (!Array.isArray(p.oa)) p.oa = [0];
  if (!p.qa || typeof p.qa !== 'object' || Array.isArray(p.qa)) p.qa = {};
  if (!Array.isArray(p.qd)) p.qd = [];
  if (!p.questProgress || typeof p.questProgress !== 'object' || Array.isArray(p.questProgress)) p.questProgress = {};
  return p;
}
function cleanState(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const p = input.player, c = input.camera;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return null;
  const fields = ['x', 'z', 'y', 'hp', 'mhp', 'lv', 'xp', 'nx', 'coin', 'at', 'face', 'inv', 'w', 'a', 'rg'], player = {};
  for (const k of fields) { const v = p[k]; if (typeof v === 'number' && Number.isFinite(v)) player[k] = Math.max(-1e9, Math.min(1e9, v)); }
  player.x = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, Number(player.x) || 0));
  player.z = Math.max(-WORLD_LIMIT, Math.min(WORLD_LIMIT, Number(player.z) || 0));
  player.lv = Math.max(1, Math.min(999, Math.floor(Number(player.lv) || 1)));
  player.mhp = Math.max(1, Math.min(1e7, Number(player.mhp) || 100));
  player.hp = Math.max(0, Math.min(player.mhp, Number(player.hp) || 0));
  player.coin = Math.max(0, Math.min(1e9, Math.floor(Number(player.coin) || 0)));
  player.xp = Math.max(0, Math.min(1e9, Math.floor(Number(player.xp) || 0)));
  player.w = Math.max(0, Math.min(19, Math.floor(Number(player.w) || 0)));
  player.a = Math.max(0, Math.min(19, Math.floor(Number(player.a) || 0)));
  player.pot = Array.isArray(p.pot) ? p.pot.slice(0, 8).map(v => Math.max(0, Math.min(999, Math.floor(Number(v) || 0)))) : [2, 0, 0, 0];
  while (player.pot.length < 4) player.pot.push(0);
  player.ow = Array.isArray(p.ow) ? p.ow.filter(v => Number.isInteger(v) && v >= 0 && v < 20).slice(0, 20) : [0];
  player.oa = Array.isArray(p.oa) ? p.oa.filter(v => Number.isInteger(v) && v >= 0 && v < 20).slice(0, 20) : [0];
  if (!player.ow.includes(0)) player.ow.push(0);
  if (!player.oa.includes(0)) player.oa.push(0);
  player.qa = {};
  if (p.qa && typeof p.qa === 'object' && !Array.isArray(p.qa)) {
    let n = 0;
    for (const [id, v] of Object.entries(p.qa)) {
      if (!QUESTS[id] || n >= 5) continue;
      const num = Number(v); if (!Number.isFinite(num)) continue;
      player.qa[id] = Math.max(0, Math.min(QUESTS[id].need, Math.floor(num))); n++;
    }
  }
  player.qd = Array.isArray(p.qd) ? [...new Set(p.qd.filter(v => typeof v === 'string' && QUESTS[v]))].slice(0, 100) : [];
  player.questProgress = {};
  if (p.questProgress && typeof p.questProgress === 'object' && !Array.isArray(p.questProgress)) {
    for (const [id, v] of Object.entries(p.questProgress)) if (QUESTS[id] && Number.isFinite(Number(v))) player.questProgress[id] = Math.max(0, Math.min(QUESTS[id].need, Math.floor(Number(v))));
  }
  const camera = {};
  if (c && typeof c === 'object') for (const k of ['yaw', 'pit', 'dist']) if (Number.isFinite(c[k])) camera[k] = Math.max(-1000, Math.min(1000, c[k]));
  return { version: 1, player, camera, savedAt: Date.now() };
}

/* ===== 계정 API ===== */
app.post('/api/register', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (!validUsername(username)) return res.status(400).json({ error: '아이디는 한글/영문/숫자/._- 조합으로 3~24자 입력하세요.' });
  if (!validPassword(password)) return res.status(400).json({ error: '비밀번호는 8~128자로 입력하세요.' });
  const key = usernameKey(username);
  if (db.users[key]) return res.status(409).json({ error: '이미 사용 중인 아이디입니다.' });
  const salt = crypto.randomBytes(16).toString('hex');
  db.users[key] = { username, passwordHash: hashPassword(password, salt), salt, createdAt: Date.now() };
  db.states[key] = null;
  try { persist(); } catch (e) { delete db.users[key]; delete db.states[key]; return res.status(500).json({ error: '서버 저장에 실패했습니다.' }); }
  setCookie(req, res, sign({ u: key, exp: Date.now() + SESSION_TTL_MS }));
  res.status(201).json({ user: username, state: null, isAdmin: false });
});
app.post('/api/login', authLimiter, (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string') return res.status(400).json({ error: '아이디와 비밀번호를 입력하세요.' });
  const key = usernameKey(username), u = db.users[key];
  const salt = u ? u.salt : '00000000000000000000000000000000';
  const actual = hashPassword(password, salt), expected = u ? u.passwordHash : '0'.repeat(128);
  if (!u || !safeEqual(actual, expected)) return res.status(401).json({ error: '아이디 또는 비밀번호가 올바르지 않습니다.' });
  if (isBanned(key)) return res.status(403).json({ error: '차단된 계정입니다.' });
  setCookie(req, res, sign({ u: key, exp: Date.now() + SESSION_TTL_MS }));
  res.json({ user: u.username, state: db.states[key] || null, isAdmin: !!u.isAdmin });
});
app.get('/api/me', (req, res) => {
  const key = userFromReq(req);
  if (!key) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (isBanned(key)) return res.status(403).json({ error: '차단된 계정입니다.' });
  res.json({ user: publicName(key), state: db.states[key] || null, isAdmin: !!db.users[key].isAdmin });
});
app.post('/api/save', requireUser, (req, res) => {
  const state = cleanState(req.body && req.body.state);
  if (!state) return res.status(400).json({ error: '저장 데이터 형식이 올바르지 않습니다.' });
  db.states[req.userKey] = state;
  try { persist(); res.json({ ok: true, savedAt: state.savedAt }); }
  catch (e) { console.error('Persist failed', e); res.status(500).json({ error: '서버 저장에 실패했습니다.' }); }
});
app.post('/api/save-beacon', (req, res) => {
  const key = userFromReq(req);
  if (!key || isBanned(key)) return res.status(401).end();
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).end(); } }
  const state = cleanState(body && body.state);
  if (!state) return res.status(400).end();
  db.states[key] = state;
  try { persist(); res.status(204).end(); } catch (e) { res.status(500).end(); }
});
app.post('/api/logout', (req, res) => { clearCookie(req, res); res.json({ ok: true }); });

/* ===== 상점 / 퀘스트 API ===== */
app.post('/api/buy', requireUser, (req, res) => {
  const body = req.body || {};
  const type = body.type, index = body.index;
  let amount = body.amount == null ? 1 : body.amount;
  if (type !== 'w' && type !== 'a' && type !== 'p') return res.status(400).json({ error: '상품 종류가 올바르지 않습니다.' });
  if (!Number.isInteger(index) || index < 0) return res.status(400).json({ error: '상품 번호가 올바르지 않습니다.' });
  if (!Number.isInteger(amount) || amount < 1 || amount > 99) return res.status(400).json({ error: '수량이 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  let cost = 0, name = '';
  if (type === 'p') {
    if (!SHOP_P[index]) return res.status(400).json({ error: '존재하지 않는 물약입니다.' });
    cost = SHOP_P[index].cost * amount; name = SHOP_P[index].name;
  } else if (type === 'w') {
    if (!SHOP_W[index]) return res.status(400).json({ error: '존재하지 않는 무기입니다.' });
    if (player.ow.includes(index)) return res.status(400).json({ error: '이미 보유한 무기입니다.' });
    cost = SHOP_W[index].cost; name = SHOP_W[index].name; amount = 1;
  } else {
    if (!SHOP_A[index]) return res.status(400).json({ error: '존재하지 않는 방어구입니다.' });
    if (player.oa.includes(index)) return res.status(400).json({ error: '이미 보유한 방어구입니다.' });
    cost = SHOP_A[index].cost; name = SHOP_A[index].name; amount = 1;
  }
  if ((player.coin || 0) < cost) return res.status(400).json({ error: '코인이 부족합니다.', need: cost, have: player.coin || 0 });
  player.coin -= cost;
  if (type === 'p') player.pot[index] = Math.min(999, (player.pot[index] || 0) + amount);
  else if (type === 'w') { player.ow.push(index); player.w = index; }
  else { player.oa.push(index); player.a = index; }
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok: true, type, index, amount, name, coin: player.coin, pot: player.pot, w: player.w, a: player.a, ow: player.ow, oa: player.oa }); }
  catch (e) { res.status(500).json({ error: '저장 실패' }); }
});

app.post('/api/quest/accept', requireUser, (req, res) => {
  const { questId } = req.body || {};
  if (typeof questId !== 'string' || !QUESTS[questId]) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  if (player.qa[questId] !== undefined) return res.status(400).json({ error: '이미 수락한 퀘스트입니다.' });
  if (Object.keys(player.qa).length >= 5) return res.status(400).json({ error: '퀘스트는 동시에 5개까지 받을 수 있습니다.' });
  player.qa[questId] = 0; player.questProgress[questId] = 0;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok: true, questId, qa: player.qa }); } catch (e) { res.status(500).json({ error: '저장 실패' }); }
});
app.post('/api/quest/progress', requireUser, (req, res) => {
  const { questId, progress } = req.body || {};
  if (typeof questId !== 'string' || !QUESTS[questId]) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  if (!Number.isInteger(progress) || progress < 0 || progress > 100000) return res.status(400).json({ error: '진행도가 올바르지 않습니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qa[questId] === undefined) return res.status(400).json({ error: '수락하지 않은 퀘스트입니다.' });
  const need = QUESTS[questId].need;
  const next = Math.max(player.questProgress[questId] || 0, Math.min(progress, need));
  player.questProgress[questId] = next; player.qa[questId] = next;
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok: true, questId, progress: next }); } catch (e) { res.status(500).json({ error: '저장 실패' }); }
});
app.post('/api/quest/complete', requireUser, (req, res) => {
  const { questId } = req.body || {};
  if (typeof questId !== 'string' || !QUESTS[questId]) return res.status(400).json({ error: '존재하지 않는 퀘스트입니다.' });
  const player = ensurePlayer(req.userKey);
  if (player.qa[questId] === undefined) return res.status(400).json({ error: '수락하지 않은 퀘스트입니다.' });
  if (player.qd.includes(questId)) return res.status(400).json({ error: '이미 완료한 퀘스트입니다.' });
  const def = QUESTS[questId];
  const prog = Math.max(player.questProgress[questId] || 0, player.qa[questId] || 0);
  if (prog < def.need) return res.status(400).json({ error: '아직 퀘스트 조건을 충족하지 않았습니다.', progress: prog, need: def.need });
  // 경험치는 클라이언트(gain)에서 레벨업과 함께 처리하므로 서버는 코인만 지급하고 xp 보상값을 알려줍니다.
  player.coin = Math.min(1e9, (player.coin || 0) + def.coin);
  delete player.qa[questId]; delete player.questProgress[questId];
  player.qd.push(questId);
  db.states[req.userKey].savedAt = Date.now();
  try { persist(); res.json({ ok: true, questId, reward: { coin: def.coin, xp: def.xp }, coin: player.coin, qa: player.qa, qd: player.qd }); }
  catch (e) { res.status(500).json({ error: '저장 실패' }); }
});

/* ===== 관리자 API ===== */
function requireAdmin(req, res, next) {
  const key = userFromReq(req);
  if (!key) return res.status(401).json({ error: '로그인이 필요합니다.' });
  if (!db.users[key] || !db.users[key].isAdmin) return res.status(403).json({ error: '관리자 권한이 없습니다.' });
  req.userKey = key; next();
}
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const list = [];
  for (const [key, u] of Object.entries(db.users)) {
    const st = db.states[key] && db.states[key].player;
    list.push({ key, username: u.username, isAdmin: !!u.isAdmin, banned: isBanned(key), createdAt: u.createdAt || 0, lv: st ? st.lv : 1, coin: st ? st.coin : 0, xp: st ? st.xp : 0 });
  }
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  res.json({ users: list });
});
app.post('/api/admin/ban', requireAdmin, (req, res) => {
  const { username, banned = true } = req.body || {};
  if (typeof username !== 'string') return res.status(400).json({ error: '아이디가 필요합니다.' });
  const key = usernameKey(username), u = db.users[key];
  if (!u) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  if (u.isAdmin) return res.status(400).json({ error: '관리자는 차단할 수 없습니다.' });
  u.banned = !!banned;
  if (banned) db.bans[key] = Date.now(); else delete db.bans[key];
  try {
    persist();
    if (banned) for (const c of wss.clients) if (c._userKey === key) try { c.close(1008, 'banned'); } catch { }
    res.json({ ok: true, username: u.username, banned: !!u.banned });
  } catch (e) { res.status(500).json({ error: '저장 실패' }); }
});
app.post('/api/admin/set-level', requireAdmin, (req, res) => {
  const { username, level } = req.body || {};
  if (typeof username !== 'string') return res.status(400).json({ error: '아이디가 필요합니다.' });
  const lv = Math.floor(Number(level));
  if (!Number.isFinite(lv) || lv < 1 || lv > 999) return res.status(400).json({ error: '레벨은 1~999입니다.' });
  const key = usernameKey(username);
  if (!db.users[key]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  const p = ensurePlayer(key);
  p.lv = lv; p.xp = 0;
  let nx = 30; for (let i = 1; i < lv; i++) nx = Math.floor(nx * 1.32); // 클라이언트 경험치 곡선과 동일
  p.nx = Math.min(1e9, nx);
  db.states[key].savedAt = Date.now();
  try { persist(); res.json({ ok: true, username: db.users[key].username, lv: p.lv }); } catch (e) { res.status(500).json({ error: '저장 실패' }); }
});
app.post('/api/admin/give-coin', requireAdmin, (req, res) => {
  const { username, amount } = req.body || {};
  if (typeof username !== 'string') return res.status(400).json({ error: '아이디가 필요합니다.' });
  const amt = Math.floor(Number(amount));
  if (!Number.isFinite(amt) || amt === 0 || Math.abs(amt) > 1e9) return res.status(400).json({ error: '코인 수량이 올바르지 않습니다.' });
  const key = usernameKey(username);
  if (!db.users[key]) return res.status(404).json({ error: '사용자를 찾을 수 없습니다.' });
  const p = ensurePlayer(key);
  p.coin = Math.max(0, Math.min(1e9, (p.coin || 0) + amt));
  db.states[key].savedAt = Date.now();
  try { persist(); res.json({ ok: true, username: db.users[key].username, coin: p.coin }); } catch (e) { res.status(500).json({ error: '저장 실패' }); }
});

app.get('/healthz', (_req, res) => res.json({ ok: true, monsters: monsters.size }));
app.use(express.static(path.join(__dirname, 'public'), {
  index: 'index.html', dotfiles: 'deny', maxAge: '1h',
  setHeaders(res, p) { if (p.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache'); res.setHeader('X-Content-Type-Options', 'nosniff'); }
}));
app.use((err, _req, res, _next) => { if (res.headersSent) return; res.status(400).json({ error: '요청을 처리할 수 없습니다.' }); });

/* ===== WebSocket (멀티플레이 / 서버 몬스터 / PvP) ===== */
const server = app.listen(PORT, HOST, () => console.log(`RPG server listening on ${HOST}:${PORT}; data=${DB_FILE}`));
const wss = new WebSocketServer({ noServer: true, maxPayload: 2048, perMessageDeflate: false });
const players = new Map(), socketsByIp = new Map();

function allowedOrigin(origin, req) {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  try {
    const u = new URL(origin), secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
    return u.host === req.headers.host && u.protocol === (secure ? 'https:' : 'http:');
  } catch { return false; }
}
function broadcast(data, except) { const raw = JSON.stringify(data); for (const c of wss.clients) if (c !== except && c.readyState === WebSocket.OPEN) try { c.send(raw); } catch { } }
function broadcastAll(data) { const raw = JSON.stringify(data); for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) try { c.send(raw); } catch { } }

server.on('upgrade', (req, socket, head) => {
  let pathname; try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { socket.destroy(); return; }
  if (pathname !== '/ws' || !allowedOrigin(req.headers.origin, req)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if ((socketsByIp.get(ip) || 0) >= 4 || players.size >= MAX_PLAYERS) { socket.write('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  const key = sessionKeyFromHeader(req.headers.cookie);
  if (key && isBanned(key)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, ws => {
    ws._ip = ip;
    socketsByIp.set(ip, (socketsByIp.get(ip) || 0) + 1);
    ws._userKey = key;
    ws._username = key ? db.users[key].username : null;
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', ws => {
  ws.isAlive = true; ws.last = 0;
  const id = crypto.randomUUID();
  const displayName = ws._username || ('플레이어-' + id.slice(0, 4));
  const p = { id, name: displayName, x: 0, z: 8, y: 0, face: 0, pvp: false, hp: 100, mhp: 100 };
  players.set(id, p); ws.player = p;

  ws.send(JSON.stringify({ type: 'welcome', id, name: displayName, players: [...players.values()].filter(x => x.id !== id), monsters: monsterSnapshot() }));
  broadcast({ type: 'join', player: p }, ws);
  broadcastAll({ type: 'count', count: players.size });

  ws.on('pong', () => ws.isAlive = true);
  ws.on('message', (data, binary) => {
    const now = Date.now();
    if (binary || data.length > 2048 || now - ws.last < 40) { ws.strikes = (ws.strikes || 0) + 1; if (ws.strikes > 20) ws.close(1008, 'rate limit'); return; }
    ws.last = now;
    let m; try { m = JSON.parse(data.toString()); } catch { ws.close(1007, 'json'); return; }
    if (!m || typeof m.type !== 'string') return;

    if (m.type === 'move') {
      if (!Number.isFinite(m.x) || !Number.isFinite(m.z) || !Number.isFinite(m.y) || !Number.isFinite(m.face) ||
        Math.abs(m.x) > WORLD_LIMIT || Math.abs(m.z) > WORLD_LIMIT || m.y < 0 || m.y > 60) {
        ws.strikes = (ws.strikes || 0) + 1; if (ws.strikes >= 20) ws.close(1008, 'state'); return;
      }
      Object.assign(p, { x: m.x, z: m.z, y: m.y, face: m.face });
      if (typeof m.pvp === 'boolean') p.pvp = m.pvp;
      if (Number.isFinite(m.hp)) p.hp = Math.max(0, Math.min(1e7, m.hp));
      if (Number.isFinite(m.mhp)) p.mhp = Math.max(1, Math.min(1e7, m.mhp));
      broadcast({ type: 'state', player: p }, ws);
      return;
    }

    // PvP: 양쪽 모두 PvP ON, 거리 8 이내
    if (m.type === 'pvp_hit') {
      if (typeof m.targetId !== 'string' || !Number.isFinite(m.dmg)) return;
      if (!p.pvp) return;
      const target = players.get(m.targetId);
      if (!target || target.id === p.id || !target.pvp) return;
      if (Math.hypot(target.x - p.x, target.z - p.z) > 8) return;
      const dmg = Math.max(1, Math.min(100000, Math.floor(m.dmg)));
      target.hp = Math.max(0, (target.hp || 100) - dmg);
      broadcastAll({ type: 'pvp_damage', from: p.id, to: target.id, dmg, hp: target.hp, name: p.name });
      return;
    }

    // 공유 몬스터 공격
    if (m.type === 'hit') {
      if (typeof m.id !== 'string' || !Number.isFinite(m.dmg)) return;
      const mon = monsters.get(m.id);
      if (!mon || mon.dead) return;
      const dmg = Math.max(1, Math.min(1e7, Math.floor(m.dmg)));
      const def = MT[mon.type];
      if (Math.hypot(mon.x - p.x, mon.z - p.z) > (def ? def.reach : 2) + 6) return;
      mon.hp -= dmg;
      if (mon.hp <= 0) {
        mon.hp = 0; mon.dead = true; mon.rt = def ? def.rt || 10 : 10;
        try { ws.send(JSON.stringify({ type: 'kill', id: mon.id, reward: { coin: def ? def.g : 0, xp: def ? def.xp : 0, type: mon.type } })); } catch { }
        broadcastAll({ type: 'monster', monster: monView(mon) });
      } else {
        broadcastAll({ type: 'monster', monster: monView(mon) });
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ws._heartbeat);
    players.delete(p.id);
    broadcast({ type: 'leave', id: p.id });
    broadcastAll({ type: 'count', count: players.size });
    const n = (socketsByIp.get(ws._ip) || 1) - 1;
    if (n > 0) socketsByIp.set(ws._ip, n); else socketsByIp.delete(ws._ip);
  });
  ws.on('error', () => { });
  ws._heartbeat = setInterval(() => {
    if (!ws.isAlive) { ws.terminate(); clearInterval(ws._heartbeat); return; }
    ws.isAlive = false; try { ws.ping(); } catch { }
  }, 30000);
});

// 리스폰 시간 기본값 (MT 정의에 rt 추가)
const RT = { slime: 8, wolf: 8, goblin: 10, skeleton: 12, golem: 30 };
for (const [t, d] of Object.entries(MT)) d.rt = RT[t] || 10;

/* ===== 몬스터 AI / 리스폰 루프 (100ms) ===== */
setInterval(() => {
  const dt = 0.1, plist = [...players.values()];
  for (const mon of monsters.values()) {
    const def = MT[mon.type]; if (!def) continue;
    if (mon.dead) {
      mon.rt -= dt;
      if (mon.rt <= 0) {
        const a = Math.random() * Math.PI * 2, r = rnd(def.r[0], def.r[1]);
        mon.x = Math.cos(a) * r; mon.z = Math.sin(a) * r;
        mon.hp = def.hp; mon.mhp = def.hp; mon.dead = false; mon.rt = 0;
        broadcastAll({ type: 'monster', monster: monView(mon) });
      }
      continue;
    }
    let nearest = null, nd = 1e9;
    for (const pl of plist) { const d = Math.hypot(pl.x - mon.x, pl.z - mon.z); if (d < nd) { nd = d; nearest = pl; } }
    // 마을 안 플레이어는 쫓지 않음
    if (nearest && nd < 18 && nd > def.reach * 0.6 && Math.hypot(nearest.x, nearest.z) > VILLAGE_R) {
      const ang = Math.atan2(nearest.x - mon.x, nearest.z - mon.z);
      mon.face = ang;
      mon.x += Math.sin(ang) * def.sp * dt;
      mon.z += Math.cos(ang) * def.sp * dt;
      const r = Math.hypot(mon.x, mon.z);
      if (r < VILLAGE_R) { mon.x *= VILLAGE_R / r; mon.z *= VILLAGE_R / r; }
    }
  }
}, 100);

let snapTick = 0;
setInterval(() => {
  if (players.size === 0) return;
  snapTick++;
  if (snapTick % 20 === 0) {
    broadcastAll({ type: 'monsters', monsters: monsterSnapshot() });
  } else {
    const live = [...monsters.values()].filter(m => !m.dead).map(monView);
    if (live.length) broadcastAll({ type: 'monsters', monsters: live, partial: true });
  }
}, 100);

server.on('close', () => { for (const ws of wss.clients) ws.terminate(); });
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
