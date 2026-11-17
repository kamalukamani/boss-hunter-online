'use strict';
/* MongoDB account system: password hashes (scrypt), hashed server sessions, per-player saves. */
const crypto = require('crypto');

const MAXLV = 50;
const expNeed = L => Math.round(100 * Math.pow(L, 1.6));
function lvInfo(xp) {
  let L = 1, r = Math.max(0, +xp || 0);
  while (L < MAXLV && r >= expNeed(L)) { r -= expNeed(L); L++; }
  return { L, r: Math.floor(r), need: L >= MAXLV ? 0 : expNeed(L) };
}
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const scrypt = (pw, salt) => new Promise((ok, no) =>
  crypto.scrypt(pw, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
    (e, k) => e ? no(e) : ok(k.toString('hex'))));

module.exports = async function initMongo() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn('[accounts] MONGODB_URI is not set; server accounts disabled.');
    return null;
  }

  const { MongoClient } = require('mongodb');
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 10000,
    maxPoolSize: 10,
    retryWrites: true
  });
  await client.connect();
  const db = client.db(process.env.MONGODB_DB_NAME || 'BossHunterOnline');
  const users = db.collection('users');
  const playerData = db.collection('player_data');
  const sessions = db.collection('sessions');

  await Promise.all([
    users.createIndex({ username_lc: 1 }, { unique: true, name: 'username_unique' }),
    users.createIndex({ email_lc: 1 }, { unique: true, name: 'email_unique' }),
    users.createIndex({ player_id: 1 }, { unique: true, name: 'player_id_unique' }),
    playerData.createIndex({ user_id: 1 }, { unique: true, name: 'player_user_unique' }),
    sessions.createIndex({ token_hash: 1 }, { unique: true, name: 'session_token_unique' }),
    sessions.createIndex({ expires_at: 1 }, { expireAfterSeconds: 0, name: 'session_ttl' }),
    playerData.createIndex({ level: -1, exp: -1 }, { name: 'lb_level' }),
    playerData.createIndex({ total_damage: -1 }, { name: 'lb_damage' }),
    playerData.createIndex({ money: -1 }, { name: 'lb_money' })
  ]);

  console.log('[accounts] MongoDB connected; database:', db.databaseName);

  const fails = new Map(), hits = new Map();
  const lockLeft = k => {
    const f = fails.get(k);
    return f && f.n >= 5 && f.until > Date.now() ? Math.ceil((f.until - Date.now()) / 1000) : 0;
  };
  const addFail = k => {
    const f = fails.get(k) || { n: 0, until: 0 };
    if (f.until && f.until < Date.now()) f.n = 0;
    f.n++;
    if (f.n >= 5) f.until = Date.now() + 10 * 60e3;
    fails.set(k, f);
  };
  const hitOk = (k, max) => {
    const now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 10 * 60e3);
    a.push(now); hits.set(k, a); return a.length <= max;
  };
  setInterval(() => {
    const n = Date.now();
    for (const [k, f] of fails) if (f.until && f.until < n && n - f.until > 6e5) fails.delete(k);
    for (const [k, a] of hits) if (!a.some(t => n - t < 6e5)) hits.delete(k);
  }, 60e3).unref();

  const strong = pw => pw.length >= 8 && pw.length <= 64 && /[A-Za-z]/.test(pw) && /\d/.test(pw);
  const mkSession = async (uid, remember) => {
    const tok = 's_' + crypto.randomBytes(32).toString('hex'), now = Date.now();
    await sessions.insertOne({
      token_hash: sha(tok), user_id: uid,
      expires_at: new Date(now + (remember ? 30 : 1) * 864e5),
      created_at: new Date(now)
    });
    return tok;
  };
  const profile = async u => {
    const d = await playerData.findOne({ user_id: u._id }) || {};
    return {
      playerId: u.player_id, username: u.username, email: u.email,
      createdAt: u.created_at, level: d.level || 1, exp: d.exp || 0,
      money: d.money || 0, wins: d.wins || 0, losses: d.losses || 0,
      playSeconds: d.play_seconds || 0
    };
  };
  const authReq = async req => {
    const t = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!/^s_[0-9a-f]{64}$/.test(t)) return null;
    const s = await sessions.findOne({ token_hash: sha(t), expires_at: { $gt: new Date() } });
    return s ? { uid: s.user_id, tok: t } : null;
  };
  const clean = (o, depth = 0) => {
    if (depth > 6) return null;
    if (typeof o === 'number') return Number.isFinite(o) ? o : 0;
    if (Array.isArray(o)) return o.slice(0, 400).map(x => clean(x, depth + 1));
    if (o && typeof o === 'object') {
      const r = {}; let n = 0;
      for (const k of Object.keys(o)) {
        if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
        if (++n > 400) break;
        r[k] = clean(o[k], depth + 1);
      }
      return r;
    }
    return o;
  };

  /* ---- anti-tamper: damage / damage-taken accepted only up to a plausible rate (token buckets) ---- */
  const bk = new Map();
  function clampStats(key, d) {
    const now = Date.now(); let b = bk.get(key);
    if (!b) { b = { dm: 3e6, rc: 2e5, t: now, k: 0 }; bk.set(key, b); }
    const dt = Math.min(30, (now - b.t) / 1000); b.t = now;
    b.dm = Math.min(6e6, b.dm + dt * 1.5e6); b.rc = Math.min(4e5, b.rc + dt * 1e5);
    const out = { dealt: Math.max(0, Math.min(+d.dealt || 0, b.dm)), recv: Math.max(0, Math.min(+d.recv || 0, b.rc)), kills: 0, deaths: 0 };
    b.dm -= out.dealt; b.rc -= out.recv;
    if (d.kills && now - b.k > 15000) { out.kills = 1; b.k = now; }
    if (d.deaths) out.deaths = Math.min(1, +d.deaths || 0);
    return out;
  }
  setInterval(() => { const n = Date.now(); for (const [k, b] of bk) if (n - b.t > 3e5) bk.delete(k); }, 6e4).unref();

  /* in-memory copy of each connected player's numbers (scoreboard reads these synchronously) */
  const pdc = new Map();
  const remember = (uid, d) => { if (d) pdc.set(String(uid), { level: d.level || 1, exp: d.exp || 0, money: d.money || 0, total_damage: d.total_damage || 0, last_win: d.last_win || 0, last_ping: d.last_ping || 0 }); };

  const lbCache = {};
  async function leaderboard(type, uid) {
    const now = Date.now(), c = lbCache[type]; let rows;
    if (c && now - c.at < 3000) rows = c.rows;
    else {
      const sort = type === 'damage' ? { total_damage: -1 } : type === 'money' ? { money: -1 } : { level: -1, exp: -1 };
      const docs = await playerData.find({}).sort(sort).limit(100).toArray();
      rows = docs.map((r, i) => ({ rank: i + 1, name: r.username || '?', pid: r.player_id || '', level: r.level || 1, exp: r.exp || 0, money: r.money || 0, damage: r.total_damage || 0 }));
      lbCache[type] = { at: now, rows };
    }
    let me = null;
    if (uid) {
      const d = await playerData.findOne({ user_id: uid });
      if (d) {
        const L = d.level || 1, E = d.exp || 0, D = d.total_damage || 0, M = d.money || 0;
        const better = type === 'damage' ? { total_damage: { $gt: D } } : type === 'money' ? { money: { $gt: M } } : { $or: [{ level: { $gt: L } }, { level: L, exp: { $gt: E } }] };
        me = { rank: (await playerData.countDocuments(better)) + 1, level: L, exp: E, money: M, damage: D };
      }
    }
    return { type, rows, me };
  }

  const handle = async function handle(req, res, u, readBody, jr) {
    const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

    if (u === '/api/auth/register' && req.method === 'POST') {
      if (!hitOk('reg:' + ip, process.env.BH_TEST ? 1000 : 15)) { jr(res, 429, { err: 'rate' }); return true; }
      const b = JSON.parse(await readBody(req, 4000));
      const un = String(b.username || '').trim();
      const em = String(b.email || '').trim().toLowerCase();
      const pw = String(b.password || '');
      if (!/^[A-Za-z0-9_\u0E00-\u0E7F]{3,20}$/.test(un)) { jr(res, 400, { err: 'username' }); return true; }
      if (em.length > 100 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em)) { jr(res, 400, { err: 'email' }); return true; }
      if (pw !== String(b.confirm || '')) { jr(res, 400, { err: 'confirm' }); return true; }
      if (!strong(pw)) { jr(res, 400, { err: 'weak' }); return true; }
      const username_lc = un.toLowerCase(), email_lc = em;
      if (await users.findOne({ $or: [{ username_lc }, { email_lc }] })) {
        const sameUser = await users.findOne({ username_lc });
        jr(res, 409, { err: sameUser ? 'username_taken' : 'email_taken' }); return true;
      }
      const salt = crypto.randomBytes(16).toString('hex');
      const pass_hash = await scrypt(pw, salt);
      const now = Date.now();
      const user = {
        player_id: 'BH-' + crypto.randomBytes(5).toString('hex').toUpperCase(),
        username: un, username_lc, email: em, email_lc,
        pass_salt: salt, pass_hash, created_at: now
      };
      try {
        const ins = await users.insertOne(user);
        user._id = ins.insertedId;
        await playerData.insertOne({ user_id: user._id, username: un, player_id: user.player_id, level: 1, exp: 0, money: 0, wins: 0, losses: 0, play_seconds: 0, last_ping: 0, last_win: 0, total_damage: 0, kills: 0, total_recv: 0, deaths: 0, revives: 0, save_json: null, updated_at: now });
      } catch (e) {
        if (e && e.code === 11000) { jr(res, 409, { err: 'taken' }); return true; }
        throw e;
      }
      const tok = await mkSession(user._id, !!b.remember);
      jr(res, 200, { token: tok, profile: await profile(user) }); return true;
    }

    if (u === '/api/auth/login' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 3000));
      const id = String(b.id || '').trim().slice(0, 100), pw = String(b.password || '').slice(0, 100);
      const k1 = 'ip:' + ip, k2 = 'id:' + id.toLowerCase();
      const L = Math.max(lockLeft(k1), lockLeft(k2));
      if (L) { jr(res, 429, { err: 'locked', wait: L }); return true; }
      const lc = id.toLowerCase();
      const row = await users.findOne(id.includes('@') ? { email_lc: lc } : { username_lc: lc });
      let good = false;
      if (row) {
        const h = await scrypt(pw, row.pass_salt);
        good = h.length === row.pass_hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(row.pass_hash));
      } else await scrypt(pw, '0000000000000000');
      if (!good) { addFail(k1); addFail(k2); jr(res, 401, { err: 'auth' }); return true; }
      fails.delete(k1); fails.delete(k2);
      jr(res, 200, { token: await mkSession(row._id, !!b.remember), profile: await profile(row) }); return true;
    }

    if (u === '/api/leaderboard' && req.method === 'GET') {
      const t = new URL(req.url, 'http://x').searchParams.get('type') || 'level';
      const a0 = String(req.headers.authorization || '').startsWith('Bearer s_') ? await authReq(req) : null;
      jr(res, 200, await leaderboard(['level', 'damage', 'money'].includes(t) ? t : 'level', a0 && a0.uid)); return true;
    }
    const accountPaths = ['/api/auth/logout', '/api/auth/profile', '/api/me', '/api/save', '/api/stats', '/api/event', '/api/ping'];
    if (!accountPaths.includes(u)) return false;
    const bearer = String(req.headers.authorization || '').replace(/^Bearer /, '');
    // Let the legacy Google-token handler in server.js process non-MongoDB tokens.
    if (!bearer.startsWith('s_')) return false;
    const a = await authReq(req);
    if (!a) { jr(res, 401, { err: 'auth' }); return true; }
    const user = await users.findOne({ _id: a.uid });
    if (!user) { jr(res, 401, { err: 'auth' }); return true; }

    if (u === '/api/auth/logout' && req.method === 'POST') {
      await sessions.deleteOne({ token_hash: sha(a.tok) });
      jr(res, 200, { ok: true }); return true;
    }
    if (u === '/api/auth/profile' || u === '/api/me') {
      jr(res, 200, { ok: true, profile: await profile(user) }); return true;
    }
    if (u === '/api/save' && req.method === 'GET') {
      const d = await playerData.findOne({ user_id: a.uid });
      let save = null;
      try { save = d && d.save_json ? JSON.parse(d.save_json) : null; } catch (_) {}
      jr(res, 200, { save, profile: await profile(user) }); return true;
    }
    if (u === '/api/save' && req.method === 'PUT') {
      if (!hitOk('sv:' + String(a.uid), 120)) { jr(res, 429, { err: 'rate' }); return true; }
      const o = JSON.parse(await readBody(req, 300000));
      if (!o || typeof o.save !== 'object' || !o.save || Array.isArray(o.save)) { jr(res, 400, { err: 'bad' }); return true; }
      const save = clean(o.save);
      const xp = Math.min(Math.max(0, save.xp || 0), 1e12), I = lvInfo(xp);
      const money = Math.min(Math.max(0, Math.floor(save.money || 0)), 1e13);
      const js = JSON.stringify(save);
      if (js.length > 250000) { jr(res, 413, { err: 'big' }); return true; }
      await playerData.updateOne({ user_id: a.uid }, {
        $set: { level: I.L, exp: Math.floor(I.r), money, save_json: js, updated_at: Date.now(), username: user.username, player_id: user.player_id }
      }, { upsert: true });
      const cc = pdc.get(String(a.uid)) || {}; cc.level = I.L; cc.exp = Math.floor(I.r); cc.money = money; pdc.set(String(a.uid), cc);
      lbCache.level = lbCache.money = null;
      jr(res, 200, { ok: true, profile: await profile(user) }); return true;
    }
    if (u === '/api/stats' && req.method === 'POST') { /* solo play: batched stat deltas, rate-limited server side */
      const b = JSON.parse(await readBody(req, 600)), o = clampStats('u' + String(a.uid), b);
      await handle.persist(a.uid, o); lbCache.damage = lbCache.level = lbCache.money = null;
      jr(res, 200, { ok: true }); return true;
    }
    if (u === '/api/event' && req.method === 'POST') {
      const b = JSON.parse(await readBody(req, 500)), d = await playerData.findOne({ user_id: a.uid }) || {}, now = Date.now();
      if (b.type === 'win') {
        if (now - (d.last_win || 0) < 20000) { jr(res, 429, { err: 'rate' }); return true; }
        await playerData.updateOne({ user_id: a.uid }, { $inc: { wins: 1 }, $set: { last_win: now } }, { upsert: true });
      } else if (b.type === 'loss') {
        if (!hitOk('ls:' + String(a.uid), 200)) { jr(res, 429, { err: 'rate' }); return true; }
        await playerData.updateOne({ user_id: a.uid }, { $inc: { losses: 1 } }, { upsert: true });
      } else { jr(res, 400, { err: 'bad' }); return true; }
      jr(res, 200, { profile: await profile(user) }); return true;
    }
    if (u === '/api/ping' && req.method === 'POST') {
      const d = await playerData.findOne({ user_id: a.uid }) || {}, now = Date.now();
      const dt = d.last_ping ? Math.min(90, Math.max(0, Math.floor((now - d.last_ping) / 1000))) : 0;
      await playerData.updateOne({ user_id: a.uid }, { $inc: { play_seconds: dt }, $set: { last_ping: now } }, { upsert: true });
      jr(res, 200, { ok: true }); return true;
    }
    return false;
  };
  handle.auth = async tok => {
    tok = String(tok || ''); if (!/^s_[0-9a-f]{64}$/.test(tok)) return null;
    const ses = await sessions.findOne({ token_hash: sha(tok), expires_at: { $gt: new Date() } }); if (!ses) return null;
    const user = await users.findOne({ _id: ses.user_id }); if (!user) return null;
    const d = await playerData.findOne({ user_id: user._id }); remember(user._id, d);
    if (d && !d.username) playerData.updateOne({ user_id: user._id }, { $set: { username: user.username, player_id: user.player_id } }).catch(() => {});
    return { uid: user._id, name: user.username, pid: user.player_id };
  };
  handle.pd = uid => pdc.get(String(uid));
  handle.clamp = clampStats;
  handle.persist = async (uid, o) => {
    try {
      const dm = Math.floor(o.dealt || 0);
      await playerData.updateOne({ user_id: uid }, { $inc: { total_damage: dm, kills: Math.floor(o.kills || 0), total_recv: Math.floor(o.recv || 0), deaths: Math.floor(o.deaths || 0) } });
      const c = pdc.get(String(uid)); if (c) c.total_damage = (c.total_damage || 0) + dm;
    } catch (e) {}
  };
  handle.revive = uid => { playerData.updateOne({ user_id: uid }, { $inc: { revives: 1 } }).catch(() => {}); };
  handle.leaderboard = leaderboard;
  return handle;
};