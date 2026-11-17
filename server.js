'use strict';
/* BOSS HUNTER ONLINE: static file + WebSocket room relay + MongoDB accounts, scoreboard, leaderboard, revive. */
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto'),zlib=require('zlib');
const PORT=+process.env.PORT||3000;
const MAX_ROOM=16,MAX_CONN=3000,MAX_MSG=16384,MAX_PRES=8192;
const html=fs.readFileSync(path.join(__dirname,'public','index.html'));
const htmlGz=zlib.gzipSync(html,{level:9});
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const rooms=new Map();let conns=0;
/* ---- Google sign-in + cloud save ---- */
const GID=process.env.GOOGLE_CLIENT_ID||'',DATA=process.env.DATA_DIR||path.join(__dirname,'data'),https=require('https');
try{fs.mkdirSync(DATA,{recursive:true});}catch(e){}
let SECRET=process.env.SESSION_SECRET||'';
if(!SECRET){const f=path.join(DATA,'.secret');try{SECRET=fs.readFileSync(f,'utf8');}catch(e){SECRET=crypto.randomBytes(32).toString('hex');try{fs.writeFileSync(f,SECRET);}catch(e2){}}}
const mkTok=sub=>{const exp=Date.now()+30*864e5,b=sub+'.'+exp;return b+'.'+crypto.createHmac('sha256',SECRET).update(b).digest('hex');};
const chkTok=t=>{const p=String(t||'').split('.');if(p.length!==3||!/^\d{5,30}$/.test(p[0]))return null;const b=p[0]+'.'+p[1],h=crypto.createHmac('sha256',SECRET).update(b).digest('hex');
  if(h.length!==p[2].length||!crypto.timingSafeEqual(Buffer.from(h),Buffer.from(p[2])))return null;return +p[1]>Date.now()?p[0]:null;};
const tokOf=req=>chkTok((req.headers.authorization||'').replace(/^Bearer /,''));
const gVerify=cred=>new Promise((ok,no)=>{https.get('https://oauth2.googleapis.com/tokeninfo?id_token='+encodeURIComponent(cred),r=>{let d='';r.on('data',c=>{d+=c;if(d.length>20000)r.destroy();});r.on('end',()=>{try{const j=JSON.parse(d);if(r.statusCode!==200||j.aud!==GID||!/^\d{5,30}$/.test(j.sub||'')||+j.exp*1000<Date.now())return no(new Error('bad'));ok(j);}catch(e){no(e);}});}).on('error',no);});
const readBody=(req,max)=>new Promise((ok,no)=>{let n=0;const a=[];req.on('data',c=>{n+=c.length;if(n>max){no(new Error('big'));req.destroy();}else a.push(c);});req.on('end',()=>ok(Buffer.concat(a).toString()));req.on('error',no);});
const jr=(res,code,o)=>{res.writeHead(code,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(o));};
let ACCT=null,ACCT_DONE=false;
const ACCT_READY=require('./accounts.js')().then(a=>{ACCT=a;ACCT_DONE=true;return a;}).catch(e=>{
  console.error('[accounts] MongoDB connection/setup failed:',e.message);ACCT_DONE=true;
  return null;
});
if(!process.env.DATA_DIR)console.warn('[server] DATA_DIR is not set: legacy Google-login saves use temporary local storage.');
async function api(req,res,u){
  try{
    if(u==='/api/online'){const L=[];for(const c of allClients)if(c.alive&&c.authed)L.push({name:c.uname||'Guest',pid:c.upid,status:'online',inRoom:!!c.room,playing:!!c.room&&c.pres.ph==='f'});return jr(res,200,{total:L.length,players:L.slice(0,200)});}
    await ACCT_READY;
    if(ACCT&&u!=='/api/config'&&await ACCT(req,res,u,readBody,jr))return;
    if(u==='/api/config')return jr(res,200,{gid:GID,acct:!!ACCT,db:!!ACCT});
    if(u==='/api/login'&&req.method==='POST'){if(!GID)return jr(res,503,{err:'no_google'});const b=JSON.parse(await readBody(req,8000)),j=await gVerify(b.credential);return jr(res,200,{token:mkTok(j.sub),name:String(j.name||j.given_name||'Hunter').slice(0,40),pic:String(j.picture||'').slice(0,300)});}
    const sub=tokOf(req);if(!sub)return jr(res,401,{err:'auth'});
    const f=path.join(DATA,sub+'.json');
    if(u==='/api/me')return jr(res,200,{ok:true});
    if(u==='/api/save'&&req.method==='GET'){let d=null;try{d=JSON.parse(fs.readFileSync(f,'utf8'));}catch(e){}return jr(res,200,{save:d});}
    if(u==='/api/save'&&req.method==='PUT'){const o=JSON.parse(await readBody(req,200000));if(!o||typeof o!=='object'||Array.isArray(o)||!o.save||typeof o.save!=='object')return jr(res,400,{err:'bad'});fs.writeFileSync(f+'.tmp',JSON.stringify(o.save));fs.renameSync(f+'.tmp',f);return jr(res,200,{ok:true});}
    jr(res,404,{err:'nf'});
  }catch(e){jr(res,400,{err:'bad'});}
}

const server=http.createServer((req,res)=>{
  const u=req.url.split('?')[0];
  if(u.startsWith('/api/'))return api(req,res,u);
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405);return res.end();}
  if(u==='/'||u==='/index.html'){
    const gz=/\bgzip\b/.test(req.headers['accept-encoding']||'');
    res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-cache','X-Content-Type-Options':'nosniff',...(gz?{'Content-Encoding':'gzip'}:{})});
    return res.end(req.method==='HEAD'?undefined:(gz?htmlGz:html));
  }
  if(u==='/healthz'){ACCT_READY.then(()=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({ok:true,conns,rooms:rooms.size,acct:!!ACCT,persistent:!!process.env.DATA_DIR}));});return;}
  if(u==='/models/red_dragon.glb'){
    const f=path.join(__dirname,'public','models','red_dragon.glb');
    return fs.readFile(f,(e,d)=>{if(e){res.writeHead(404);return res.end();}res.writeHead(200,{'Content-Type':'model/gltf-binary','Cache-Control':'public,max-age=86400','X-Content-Type-Options':'nosniff'});res.end(req.method==='HEAD'?undefined:d);});
  }
  if(u==='/favicon.ico'){res.writeHead(204);return res.end();}
  res.writeHead(404,{'Content-Type':'text/plain'});res.end('not found');
});

function frame(op,payload){
  const len=payload.length;let h;
  if(len<126){h=Buffer.from([0x80|op,len]);}
  else if(len<65536){h=Buffer.alloc(4);h[0]=0x80|op;h[1]=126;h.writeUInt16BE(len,2);}
  else{h=Buffer.alloc(10);h[0]=0x80|op;h[1]=127;h.writeBigUInt64BE(BigInt(len),2);}
  return Buffer.concat([h,payload]);
}
const allClients=new Set();
const near=(a,b)=>{const p=a.pres,q=b.pres;if(typeof p.x!=='number'||typeof q.x!=='number')return true;return Math.hypot(p.x-q.x,p.z-q.z)<=7;};
function rowOf(c){
  const d=ACCT&&c.uid?ACCT.pd(c.uid):null;
  return{id:c.id,name:c.uname||String(c.pres.nm||'Player').slice(0,16),pid:c.upid,level:d?d.level:(c.pres.lv||1),money:d?d.money:0,kills:c.st.kills,dealt:Math.round(c.st.dealt),recv:Math.round(c.st.recv),deaths:c.st.deaths,revives:c.st.revives,downed:!!c.downed,online:true,playing:c.pres.ph==='f'};
}
const hostOf=r=>{for(const k of r.keys())return k;return null;};
function sendHost(r){const o={t:'host',id:hostOf(r)};for(const c of r.values())c.send(o);}
function onlineTotal(){let n=0;for(const c of allClients)if(c.alive&&c.authed)n++;return n;}
function bcastSb(rn){
  const r=rooms.get(rn);if(!r)return;const rows=[];for(const c of r.values())rows.push(rowOf(c));
  if(r.gh){const now=Date.now();for(const [k,g] of r.gh){if(now-g.off>5*60e3||rows.some(x=>x.pid===k))r.gh.delete(k);else rows.push(g);}}
  const out={t:'sb',rows,total:onlineTotal(),roomN:r.size};for(const c of r.values())c.send(out);
}
let onlTimer=null;
function onlineDirty(){if(onlTimer)return;onlTimer=setTimeout(()=>{onlTimer=null;const o={t:'online',total:onlineTotal()};for(const c of allClients)if(c.alive&&c.authed)c.send(o);},250);}
setInterval(()=>{for(const [n,r] of rooms){if(r.dirty||(r.hb=(r.hb||0)+1)>=3){r.hb=0;r.dirty=false;bcastSb(n);}}},1000).unref();
setInterval(()=>{for(const c of allClients)c.flush();},5000).unref();
class Client{
  constructor(socket){
    this.s=socket;this.id=crypto.randomBytes(6).toString('hex');this.room=null;this.pres={};this.uid=0;this.uname='';this.upid='';this.st={dealt:0,recv:0,kills:0,deaths:0,revives:0};this.pend={dealt:0,kills:0,recv:0,deaths:0};this.downed=false;this.invUntil=0;this.rv=null;this.buf=Buffer.alloc(0);this.frag=null;this.alive=true;this.tok=120;this.tAt=Date.now();
    socket.setNoDelay(true);socket.on('data',d=>this.onData(d));socket.on('close',()=>this.close());socket.on('error',()=>this.close());
    allClients.add(this);this.send({t:'hello',id:this.id});
  }
  send(o){if(!this.alive||this.s.destroyed)return;try{this.s.write(frame(1,Buffer.from(JSON.stringify(o))));}catch(e){}}
  onData(d){
    this.buf=Buffer.concat([this.buf,d]);if(this.buf.length>MAX_MSG*4)return this.kill();
    for(;;){
      const b=this.buf;if(b.length<2)return;
      const fin=!!(b[0]&0x80),op=b[0]&15,masked=!!(b[1]&0x80);let len=b[1]&127,off=2;
      if(!masked)return this.kill();
      if(len===126){if(b.length<4)return;len=b.readUInt16BE(2);off=4;}
      else if(len===127){if(b.length<10)return;const big=b.readBigUInt64BE(2);if(big>BigInt(MAX_MSG))return this.kill();len=Number(big);off=10;}
      if(len>MAX_MSG)return this.kill();
      if(b.length<off+4+len)return;
      const mask=b.subarray(off,off+4),data=Buffer.from(b.subarray(off+4,off+4+len));
      for(let i=0;i<len;i++)data[i]^=mask[i&3];
      this.buf=b.subarray(off+4+len);
      if(op===8){this.kill();return;}
      if(op===9){this.s.write(frame(10,data));continue;}
      if(op===10){this.alive=true;continue;}
      if(op===1||op===0){
        this.frag=op===1?[data]:(this.frag?(this.frag.push(data),this.frag):null);
        if(!this.frag)return this.kill();
        if(fin){const msg=Buffer.concat(this.frag).toString('utf8');this.frag=null;if(msg.length<=MAX_MSG)this.onMsg(msg);}
      }
    }
  }
  onMsg(txt){
    const now=Date.now();this.tok=Math.min(120,this.tok+(now-this.tAt)/1000*60);this.tAt=now;if(this.tok<1)return;this.tok--;
    let m;try{m=JSON.parse(txt);}catch(e){return;}
    if(!m||typeof m!=='object')return;
    if(m.t==='auth'){
      this.authP=ACCT_READY.then(async A=>{
        if(A){const a=await A.auth(m.token);if(!a){this.send({t:'autherr'});return;}this.uid=a.uid;this.uname=a.name;this.upid=a.pid;}
        this.authed=true;this.send({t:'authok',name:this.uname,pid:this.upid});onlineDirty();
      }).catch(()=>this.send({t:'autherr'})).then(()=>{this.authP=null;});
      return;
    }
    const gate=this.authP||(ACCT_DONE?null:ACCT_READY);
    if(gate&&m.t!=='leave'){gate.then(()=>this.dispatch(m));return;}
    this.dispatch(m);
  }
  dispatch(m){
    if(!this.alive)return;
    if(m.t==='join'){
      if(ACCT&&!this.uid)return this.send({t:'err',code:'auth_required'});
      const name=String(m.room||'');if(!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name))return this.send({t:'err',code:'invalid_argument'});
      this.leave();let r=rooms.get(name);if(!r){r=new Map();rooms.set(name,r);}
      if(r.size>=MAX_ROOM){if(!r.size)rooms.delete(name);return this.send({t:'err',code:'limit_reached'});}
      this.room=name;this.pres={};r.set(this.id,this);
      const peers={};for(const [id,c] of r)peers[id]=c.pres;
      this.send({t:'snap',room:name,peers});
      for(const [id,c] of r)if(c!==this)c.send({t:'join',id:this.id});
      sendHost(r);
      this.st={dealt:0,recv:0,kills:0,deaths:0,revives:0};this.downed=false;this.invUntil=0;this.rv=null;if(r.gh&&this.upid)r.gh.delete(this.upid);r.dirty=true;bcastSb(name);onlineDirty();
    }else if(m.t==='pres'){
      if(!this.room||!m.patch||typeof m.patch!=='object'||Array.isArray(m.patch))return;
      const next=Object.assign({},this.pres);
      if(this.uname){m.patch.nm=this.uname;m.patch.pid=this.upid;}
      for(const k of Object.keys(m.patch)){if(!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)||k==='__proto__')continue;if(m.patch[k]===null)delete next[k];else next[k]=m.patch[k];}
      if(JSON.stringify(next).length>MAX_PRES)return;
      this.pres=next;const r=rooms.get(this.room);if(!r)return;
      const out={t:'pres',id:this.id,patch:m.patch};
      for(const [id,c] of r)if(c!==this)c.send(out);
    }else if(m.t==='leave'){this.leave();}
    else if(this.room&&(m.t==='st'||m.t==='kill'||m.t==='down'||m.t==='rst'||m.t==='rv0'||m.t==='rv1'||m.t==='rvx'))this.game(m);
  }
  game(m){
    const r=rooms.get(this.room);if(!r)return;const now=Date.now();
    if(m.t==='st'){
      const o=ACCT?ACCT.clamp('u'+this.uid,{dealt:this.downed?0:m.d,recv:now<this.invUntil?0:m.r}):{dealt:this.downed?0:Math.min(5e5,Math.max(0,+m.d||0)),recv:Math.min(1e5,Math.max(0,+m.r||0))};
      this.st.dealt+=o.dealt;this.st.recv+=o.recv;this.pend.dealt+=o.dealt;this.pend.recv+=o.recv;if(o.dealt||o.recv)r.dirty=true;
    }else if(m.t==='kill'){
      const o=ACCT?ACCT.clamp('u'+this.uid,{kills:1}):{kills:(now-(this.lk||0)>15000)?1:0};if(o.kills){this.lk=now;this.st.kills++;this.pend.kills++;r.dirty=true;}
    }else if(m.t==='down'){
      if(!this.downed){this.downed=true;this.rv=null;this.st.deaths++;this.pend.deaths++;r.dirty=true;bcastSb(this.room);}
    }else if(m.t==='rst'){this.downed=false;this.invUntil=0;this.rv=null;r.dirty=true;}
    else if(m.t==='rv0'){
      const t=r.get(String(m.to));this.rv=null;
      if(t&&t!==this&&t.downed&&!this.downed&&near(this,t))this.rv={to:t.id,t0:now};
    }else if(m.t==='rvx'){this.rv=null;}
    else if(m.t==='rv1'){
      const t=r.get(String(m.to));const rv=this.rv;this.rv=null;
      if(!rv||!t||rv.to!==t.id||!t.downed||this.downed||now-rv.t0<4600||!near(this,t))return this.send({t:'rvno',to:String(m.to)});
      t.downed=false;t.invUntil=now+2200;this.st.revives++;if(ACCT&&this.uid)ACCT.revive(this.uid);
      t.send({t:'revived',by:this.id,hpf:.3,inv:2});
      for(const [id,c] of r)c.send({t:'rvok',by:this.id,to:t.id,byName:this.uname||'Player',toName:t.uname||'Player'});
      r.dirty=true;bcastSb(this.room);
    }
  }
  flush(){if(ACCT&&this.uid&&(this.pend.dealt||this.pend.kills||this.pend.recv||this.pend.deaths)){ACCT.persist(this.uid,this.pend);this.pend={dealt:0,kills:0,recv:0,deaths:0};}}
  leave(){
    if(!this.room)return;this.flush();const r=rooms.get(this.room),rn=this.room;this.room=null;this.pres={};this.downed=false;this.rv=null;
    if(r&&this.upid){r.gh=r.gh||new Map();r.gh.set(this.upid,Object.assign(rowOf(this),{online:false,downed:false,off:Date.now()}));}
    if(r){r.delete(this.id);r.dirty=true;for(const [id,c] of r)c.send({t:'left',id:this.id});if(r.size)sendHost(r);bcastSb(rn);if(!r.size){for(const [n,v] of rooms)if(v===r)rooms.delete(n);}}
  }
  kill(){try{this.s.destroy();}catch(e){}this.close();}
  close(){if(!this.alive)return;this.alive=false;conns--;this.leave();this.flush();allClients.delete(this);onlineDirty();}
}
server.on('upgrade',(req,socket)=>{
  const u=req.url.split('?')[0],key=req.headers['sec-websocket-key'];
  let okOrigin=true;const o=req.headers.origin;
  if(o&&!process.env.ALLOW_ANY_ORIGIN){try{okOrigin=new URL(o).host===req.headers.host;}catch(e){okOrigin=false;}}
  if(u!=='/ws'||!key||!okOrigin||conns>=MAX_CONN){socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');return socket.destroy();}
  const acc=crypto.createHash('sha1').update(key+GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+acc+'\r\n\r\n');
  conns++;const c=new Client(socket);c.alive=true;
});
/* keep connections open through proxies and drop dead ones */
const clients=new Set();
setInterval(()=>{for(const r of rooms.values())for(const c of r.values()){if(!c.alive)continue;c.s.write(frame(9,Buffer.from('p')));}},25000).unref();
server.listen(PORT,()=>console.log('Boss Hunter 3D listening on :'+PORT));
module.exports=server;
