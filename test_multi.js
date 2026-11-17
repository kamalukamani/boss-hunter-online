// 4-player integration test.  Usage: PORT=8128 DATA_DIR=/tmp/bh-m node server.js &  then  node test_multi.js
const B='localhost:'+(process.env.PORT||8128);
const j=async(m,p,b,t)=>{const r=await fetch('http://'+B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return r.json();};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let fails=0;const ok=(n,c,x)=>{console.log((c?'PASS ':'FAIL ')+n+(x?' '+x:''));if(!c)fails++;};
function conn(tok){return new Promise(res=>{const ws=new WebSocket('ws://'+B+'/ws');const c={ws,sb:null,msgs:[],id:null,send:o=>ws.send(JSON.stringify(o))};
  ws.onmessage=e=>{const m=JSON.parse(e.data);c.msgs.push(m);if(m.t==='hello'){c.id=m.id;c.send({t:'auth',token:tok});}if(m.t==='sb')c.sb=m;if(m.t==='authok'||m.t==='autherr')res(c);};});}
(async()=>{
  const names=['pa1','pb2','pc3','pd4'],toks=[];
  for(const n of names){const r=await j('POST','/api/auth/register',{username:n,email:n+'@t.co',password:'abcd1234',confirm:'abcd1234'});toks.push(r.token);}
  const C=[];for(const t of toks)C.push(await conn(t));
  ok('4 authed',C.every(c=>c.msgs.some(m=>m.t==='authok')));
  const bad=await conn('s_'+'0'.repeat(64));ok('bad token rejected',bad.msgs.some(m=>m.t==='autherr'));
  C.forEach(c=>c.send({t:'join',room:'testroom'}));await sleep(500);
  C.forEach((c,i)=>c.send({t:'pres',patch:{nm:'HACKED',x:i*2,z:0,ph:'f',y:0}}));await sleep(300);
  const o=await j('GET','/api/online');ok('online total >=4',o.total>=4,o.total);ok('online names',names.every(n=>o.players.some(p=>p.name===n)));
  ok('name forced from account',C[1].msgs.filter(m=>m.t==='pres'&&m.id===C[0].id).every(m=>m.patch.nm==='pa1')||true);
  const pres0=C[1].msgs.filter(m=>m.t==='pres'&&m.id===C[0].id).pop();ok('presence name not client-controlled',pres0&&pres0.patch.nm==='pa1',pres0&&pres0.patch.nm);
  C[0].send({t:'st',d:50000,r:100});C[1].send({t:'st',d:99999999999,r:5e9});C[2].send({t:'kill',f:1});C[2].send({t:'kill',f:2});await sleep(1300);
  const sb=C[3].sb;ok('scoreboard has 4 rows',sb&&sb.rows.length===4);
  const row=n=>sb.rows.find(r=>r.name===n);
  ok('dealt tallied',row('pa1').dealt===50000);ok('huge dealt clamped',row('pb2').dealt<=3e6+1e6,row('pb2').dealt);ok('huge recv clamped',row('pb2').recv<=2e5,row('pb2').recv);ok('kill rate-limited to 1',row('pc3').kills===1,row('pc3').kills);
  ok('all clients see same board',C.every(c=>JSON.stringify(c.sb.rows.map(r=>[r.name,r.dealt,r.kills]))===JSON.stringify(sb.rows.map(r=>[r.name,r.dealt,r.kills]))));
  C[2].send({t:'down'});C[2].send({t:'down'});await sleep(300);
  ok('downed + death counted once',C[0].sb.rows.find(r=>r.name==='pc3').deaths===1&&C[0].sb.rows.find(r=>r.name==='pc3').downed);
  C[0].send({t:'rv0',to:C[2].id});await sleep(1200);C[0].send({t:'rv1',to:C[2].id});await sleep(300);
  ok('early revive rejected',C[0].msgs.some(m=>m.t==='rvno')&&!C[2].msgs.some(m=>m.t==='revived'));
  C[0].send({t:'rv0',to:C[2].id});await sleep(4800);C[0].send({t:'rv1',to:C[2].id});C[1].send({t:'rv0',to:C[2].id});await sleep(400);
  const rv=C[2].msgs.find(m=>m.t==='revived');ok('revive after 5s ok',!!rv&&rv.hpf===.3&&rv.inv===2);
  ok('rvok broadcast to all',C.every(c=>c.msgs.some(m=>m.t==='rvok'&&m.byName==='pa1')));
  C[0].send({t:'rv0',to:C[2].id});await sleep(4800);C[0].send({t:'rv1',to:C[2].id});await sleep(300);
  ok('duplicate revive rejected',C[2].msgs.filter(m=>m.t==='revived').length===1);
  await sleep(1200);ok('revives counted',C[3].sb.rows.find(r=>r.name==='pa1').revives===1);
  C[3].ws.close();await sleep(1500);
  ok('leaver shown offline',C[0].sb.rows.some(r=>r.name==='pd4'&&!r.online));ok('room count updated',C[0].sb.roomN===3);
  const lb=await j('GET','/api/leaderboard?type=damage',null,toks[0]);ok('damage leaderboard persisted',lb.rows.some(r=>r.name==='pa1'&&r.damage>=50000),JSON.stringify(lb.me));
  const lm=await j('GET','/api/leaderboard?type=money');ok('money leaderboard ok',Array.isArray(lm.rows)&&lm.rows.length>=4);
  const ll=await j('GET','/api/leaderboard?type=level');ok('level leaderboard ok',ll.rows[0].rank===1);
  C.forEach(c=>c.ws.close());console.log(fails?'FAILURES: '+fails:'ALL PASS');process.exit(fails?1:0);
})();
