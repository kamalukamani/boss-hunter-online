'use strict';
/* Account system: SQLite (node:sqlite) + scrypt password hashing + server-side sessions.
   Tables: users, player_data, sessions.  All queries are prepared statements (no SQL injection). */
const crypto=require('crypto'),path=require('path'),fs=require('fs');
let DatabaseSync=null;try{({DatabaseSync}=require('node:sqlite'));}catch(e){}
const MAXLV=50,expNeed=L=>Math.round(100*Math.pow(L,1.6));
function lvInfo(xp){let L=1,r=Math.max(0,+xp||0);while(L<MAXLV&&r>=expNeed(L)){r-=expNeed(L);L++;}return{L,r:Math.floor(r),need:L>=MAXLV?0:expNeed(L)};}
module.exports=function init(DATA){
  if(!DatabaseSync){console.error('[accounts] node:sqlite unavailable on Node '+process.version+' (need >=22.13). Server accounts DISABLED, game will fall back to browser-only accounts.');return null;}
  const DBFILE=path.join(DATA,'bosshunter.db');
  let db;try{fs.mkdirSync(DATA,{recursive:true});db=new DatabaseSync(DBFILE);}catch(e){console.error('[accounts] cannot open database at '+DBFILE+':',e.message);return null;}
  console.log('[accounts] database ready at '+DBFILE);
  db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
  CREATE TABLE IF NOT EXISTS users(
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    player_id TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    pass_salt TEXT NOT NULL,
    pass_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS player_data(
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    level INTEGER NOT NULL DEFAULT 1,
    exp INTEGER NOT NULL DEFAULT 0,
    money INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    play_seconds INTEGER NOT NULL DEFAULT 0,
    last_ping INTEGER NOT NULL DEFAULT 0,
    last_win INTEGER NOT NULL DEFAULT 0,
    save_json TEXT,
    updated_at INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS sessions(
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL);`);
  const q={
    byUser:db.prepare('SELECT * FROM users WHERE username=?'),
    byEmail:db.prepare('SELECT * FROM users WHERE email=?'),
    byId:db.prepare('SELECT * FROM users WHERE id=?'),
    insU:db.prepare('INSERT INTO users(player_id,username,email,pass_salt,pass_hash,created_at) VALUES(?,?,?,?,?,?)'),
    insP:db.prepare('INSERT INTO player_data(user_id,updated_at) VALUES(?,?)'),
    insS:db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)'),
    selS:db.prepare('SELECT user_id,expires_at FROM sessions WHERE token_hash=?'),
    delS:db.prepare('DELETE FROM sessions WHERE token_hash=?'),
    purge:db.prepare('DELETE FROM sessions WHERE expires_at<?'),
    pd:db.prepare('SELECT * FROM player_data WHERE user_id=?'),
    setSave:db.prepare('UPDATE player_data SET level=?,exp=?,money=?,save_json=?,updated_at=? WHERE user_id=?'),
    win:db.prepare('UPDATE player_data SET wins=wins+1,last_win=? WHERE user_id=?'),
    loss:db.prepare('UPDATE player_data SET losses=losses+1 WHERE user_id=?'),
    ping:db.prepare('UPDATE player_data SET play_seconds=play_seconds+?,last_ping=? WHERE user_id=?'),
  };
  const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
  const scrypt=(pw,salt)=>new Promise((ok,no)=>crypto.scrypt(pw,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024},(e,k)=>e?no(e):ok(k.toString('hex'))));
  /* rate limiting / brute-force lock (in memory) */
  const fails=new Map(),hits=new Map();
  const lockLeft=k=>{const f=fails.get(k);return f&&f.n>=5&&f.until>Date.now()?Math.ceil((f.until-Date.now())/1000):0;};
  const addFail=k=>{const f=fails.get(k)||{n:0,until:0};if(f.until&&f.until<Date.now()){f.n=0;}f.n++;if(f.n>=5)f.until=Date.now()+10*60e3;fails.set(k,f);};
  const hitOk=(k,max)=>{const now=Date.now(),a=(hits.get(k)||[]).filter(t=>now-t<10*60e3);a.push(now);hits.set(k,a);return a.length<=max;};
  setInterval(()=>{const n=Date.now();for(const[k,f]of fails)if(f.until<n&&n-f.until>6e5)fails.delete(k);for(const[k,a]of hits)if(!a.some(t=>n-t<6e5))hits.delete(k);try{q.purge.run(n);}catch(e){}},60e3).unref();
  const strong=pw=>pw.length>=8&&pw.length<=64&&/[A-Za-z]/.test(pw)&&/\d/.test(pw);
  const mkSession=(uid,remember)=>{const tok='s_'+crypto.randomBytes(32).toString('hex'),now=Date.now();q.insS.run(sha(tok),uid,now+(remember?30*864e5:864e5),now);return tok;};
  const profile=u=>{const d=q.pd.get(u.id)||{};return{playerId:u.player_id,username:u.username,email:u.email,createdAt:u.created_at,level:d.level||1,exp:d.exp||0,money:d.money||0,wins:d.wins||0,losses:d.losses||0,playSeconds:d.play_seconds||0};};
  const authReq=req=>{const t=String(req.headers.authorization||'').replace(/^Bearer /,'');if(!/^s_[0-9a-f]{64}$/.test(t))return null;const s=q.selS.get(sha(t));if(!s||s.expires_at<Date.now())return null;return{uid:+s.user_id,tok:t};};
  const clean=(o,depth)=>{ /* strip non-finite numbers / bad shapes from a save */
    if(depth>6)return null;if(typeof o==='number')return Number.isFinite(o)?o:0;if(Array.isArray(o))return o.slice(0,400).map(x=>clean(x,depth+1));
    if(o&&typeof o==='object'){const r={};let n=0;for(const k of Object.keys(o)){if(k==='__proto__'||k==='constructor'||k==='prototype')continue;if(++n>400)break;r[k]=clean(o[k],depth+1);}return r;}return o;};
  /* returns true when the request was handled */
  return async function handle(req,res,u,readBody,jr){
    const ip=String(req.headers['x-forwarded-for']||req.socket.remoteAddress||'').split(',')[0].trim();
    if(u==='/api/auth/register'&&req.method==='POST'){
      if(!hitOk('reg:'+ip,15))return jr(res,429,{err:'rate'}),true;
      const b=JSON.parse(await readBody(req,4000)),un=String(b.username||'').trim(),em=String(b.email||'').trim().toLowerCase(),pw=String(b.password||'');
      if(!/^[A-Za-z0-9_฀-๿]{3,20}$/.test(un))return jr(res,400,{err:'username'}),true;
      if(em.length>100||!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(em))return jr(res,400,{err:'email'}),true;
      if(pw!==String(b.confirm||''))return jr(res,400,{err:'confirm'}),true;
      if(!strong(pw))return jr(res,400,{err:'weak'}),true;
      if(q.byUser.get(un))return jr(res,409,{err:'username_taken'}),true;
      if(q.byEmail.get(em))return jr(res,409,{err:'email_taken'}),true;
      const salt=crypto.randomBytes(16).toString('hex'),h=await scrypt(pw,salt),pid='BH-'+crypto.randomBytes(5).toString('hex').toUpperCase(),now=Date.now();
      let uid;try{uid=+q.insU.run(pid,un,em,salt,h,now).lastInsertRowid;q.insP.run(uid,now);}catch(e){return jr(res,409,{err:'taken'}),true;}
      const tok=mkSession(uid,!!b.remember);return jr(res,200,{token:tok,profile:profile(q.byId.get(uid))}),true;
    }
    if(u==='/api/auth/login'&&req.method==='POST'){
      const b=JSON.parse(await readBody(req,3000)),id=String(b.id||'').trim().slice(0,100),pw=String(b.password||'').slice(0,100);
      const k1='ip:'+ip,k2='id:'+id.toLowerCase();
      const L=Math.max(lockLeft(k1),lockLeft(k2));if(L)return jr(res,429,{err:'locked',wait:L}),true;
      const row=id.includes('@')?q.byEmail.get(id.toLowerCase()):q.byUser.get(id);
      let good=false;if(row){const h=await scrypt(pw,row.pass_salt);good=h.length===row.pass_hash.length&&crypto.timingSafeEqual(Buffer.from(h),Buffer.from(row.pass_hash));}else await scrypt(pw,'0000000000000000');
      if(!good){addFail(k1);addFail(k2);return jr(res,401,{err:'auth'}),true;}
      fails.delete(k1);fails.delete(k2);
      return jr(res,200,{token:mkSession(row.id,!!b.remember),profile:profile(row)}),true;
    }
    if(!u.startsWith('/api/auth/')&&u!=='/api/save'&&u!=='/api/event'&&u!=='/api/ping'&&u!=='/api/me')return false;
    const a=authReq(req);if(!a)return false; /* legacy (Google) tokens fall through to the old handler */
    const user=q.byId.get(a.uid);if(!user)return jr(res,401,{err:'auth'}),true;
    if(u==='/api/auth/logout'&&req.method==='POST'){q.delS.run(sha(a.tok));return jr(res,200,{ok:true}),true;}
    if(u==='/api/auth/profile'||u==='/api/me')return jr(res,200,{ok:true,profile:profile(user)}),true;
    if(u==='/api/save'&&req.method==='GET'){const d=q.pd.get(a.uid);let s=null;try{s=d&&d.save_json?JSON.parse(d.save_json):null;}catch(e){}return jr(res,200,{save:s,profile:profile(user)}),true;}
    if(u==='/api/save'&&req.method==='PUT'){
      if(!hitOk('sv:'+a.uid,120))return jr(res,429,{err:'rate'}),true;
      const o=JSON.parse(await readBody(req,300000));if(!o||typeof o.save!=='object'||!o.save||Array.isArray(o.save))return jr(res,400,{err:'bad'}),true;
      const s=clean(o.save,0),xp=Math.min(Math.max(0,s.xp||0),1e12),I=lvInfo(xp),money=Math.min(Math.max(0,Math.floor(s.money||0)),1e13);
      const js=JSON.stringify(s);if(js.length>250000)return jr(res,413,{err:'big'}),true;
      q.setSave.run(I.L,Math.floor(I.r),money,js,Date.now(),a.uid);return jr(res,200,{ok:true,profile:profile(user)}),true;
    }
    if(u==='/api/event'&&req.method==='POST'){ /* wins / losses are counted by the server only */
      const b=JSON.parse(await readBody(req,500)),d=q.pd.get(a.uid),now=Date.now();
      if(b.type==='win'){if(now-(d.last_win||0)<20e3)return jr(res,429,{err:'rate'}),true;q.win.run(now,a.uid);}
      else if(b.type==='loss'){if(!hitOk('ls:'+a.uid,200))return jr(res,429,{err:'rate'}),true;q.loss.run(a.uid);}
      else return jr(res,400,{err:'bad'}),true;
      return jr(res,200,{profile:profile(user)}),true;
    }
    if(u==='/api/ping'&&req.method==='POST'){ /* play time is measured by the server clock */
      const d=q.pd.get(a.uid),now=Date.now(),dt=d.last_ping?Math.min(90,Math.max(0,Math.floor((now-d.last_ping)/1000))):0;
      q.ping.run(dt,now,a.uid);return jr(res,200,{ok:true}),true;
    }
    return false;
  };
};
