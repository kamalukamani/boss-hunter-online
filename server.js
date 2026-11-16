'use strict';
/* BOSS HUNTER 3D: static file + WebSocket room relay. Zero dependencies, Node 18+. */
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
const ACCT=require('./accounts.js')(DATA);
if(!process.env.DATA_DIR)console.warn('[server] DATA_DIR is not set: accounts are stored in '+DATA+' which is wiped on every Render restart/deploy. Attach a Persistent Disk and set DATA_DIR=/data.');
console.log('[server] data dir: '+DATA+' | server accounts: '+(ACCT?'ON':'OFF'));
async function api(req,res,u){
  try{
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
  if(u==='/healthz'){res.writeHead(200,{'Content-Type':'application/json'});return res.end(JSON.stringify({ok:true,conns,rooms:rooms.size,acct:!!ACCT,persistent:!!process.env.DATA_DIR}));}
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
class Client{
  constructor(socket){
    this.s=socket;this.id=crypto.randomBytes(6).toString('hex');this.room=null;this.pres={};this.buf=Buffer.alloc(0);this.frag=null;this.alive=true;this.tok=120;this.tAt=Date.now();
    socket.setNoDelay(true);socket.on('data',d=>this.onData(d));socket.on('close',()=>this.close());socket.on('error',()=>this.close());
    this.send({t:'hello',id:this.id});
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
    if(m.t==='join'){
      const name=String(m.room||'');if(!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name))return this.send({t:'err',code:'invalid_argument'});
      this.leave();let r=rooms.get(name);if(!r){r=new Map();rooms.set(name,r);}
      if(r.size>=MAX_ROOM){if(!r.size)rooms.delete(name);return this.send({t:'err',code:'limit_reached'});}
      this.room=name;this.pres={};r.set(this.id,this);
      const peers={};for(const [id,c] of r)peers[id]=c.pres;
      this.send({t:'snap',room:name,peers});
      for(const [id,c] of r)if(c!==this)c.send({t:'join',id:this.id});
    }else if(m.t==='pres'){
      if(!this.room||!m.patch||typeof m.patch!=='object'||Array.isArray(m.patch))return;
      const next=Object.assign({},this.pres);
      for(const k of Object.keys(m.patch)){if(!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)||k==='__proto__')continue;if(m.patch[k]===null)delete next[k];else next[k]=m.patch[k];}
      if(JSON.stringify(next).length>MAX_PRES)return;
      this.pres=next;const r=rooms.get(this.room);if(!r)return;
      const out={t:'pres',id:this.id,patch:m.patch};
      for(const [id,c] of r)if(c!==this)c.send(out);
    }else if(m.t==='leave'){this.leave();}
  }
  leave(){
    if(!this.room)return;const r=rooms.get(this.room);this.room=null;this.pres={};
    if(r){r.delete(this.id);for(const [id,c] of r)c.send({t:'left',id:this.id});if(!r.size){for(const [n,v] of rooms)if(v===r)rooms.delete(n);}}
  }
  kill(){try{this.s.destroy();}catch(e){}this.close();}
  close(){if(!this.alive)return;this.alive=false;conns--;this.leave();}
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
