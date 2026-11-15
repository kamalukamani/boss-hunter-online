const {spawn}=require('child_process');const fs=require('fs');
eval(fs.readFileSync('netshim.js','utf8')+';globalThis.makeClaudeShim=makeClaudeShim;');
const PORT=3457;
const srv=spawn('node',['server.js'],{env:{...process.env,PORT}});srv.stdout.on('data',()=>{});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
  await sleep(500);
  const ok=(c,m)=>{console.log((c?'PASS ':'FAIL ')+m);if(!c)process.exitCode=1;};
  const r=await fetch('http://localhost:'+PORT+'/healthz');ok((await r.json()).ok,'healthz');
  const page=await fetch('http://localhost:'+PORT+'/');ok(page.status===200&&(await page.text()).includes('<'),'serves index');
  const a=makeClaudeShim('ws://localhost:'+PORT+'/ws',WebSocket),b=makeClaudeShim('ws://localhost:'+PORT+'/ws',WebSocket),c=makeClaudeShim('ws://localhost:'+PORT+'/ws',WebSocket);
  const ra=await(await a.use('room')).join('bh-test1'),rb=await(await b.use('room')).join('bh-test1');
  ra.presence({nm:'A',x:1.5,E:[{q:1,t:'start'}]});rb.presence({nm:'B',hp:150});
  await sleep(300);
  const pa=ra.peers(),pb=rb.peers();
  ok(pa.length===2&&pb.length===2,'both see 2 peers ('+pa.length+','+pb.length+')');
  ok(pb.find(p=>!p.isMe).presence.nm==='A'&&pb.find(p=>!p.isMe).presence.E[0].q===1,'B sees A presence incl. nested events');
  ok(pa.find(p=>p.isMe).presence.nm==='A'&&pa.filter(p=>p.isMe).length===1,'A sees itself once');
  ra.presence({x:null});await sleep(200);ok(!('x' in rb.peers().find(p=>!p.isMe).presence),'null removes field');
  const rc=await(await c.use('room')).join('bh-other');await sleep(100);ok(rc.peers().length===1,'rooms are isolated');
  await rb.leave();await sleep(200);ok(ra.peers().length===1,'leave removes peer');
  // capacity
  const extra=[];for(let i=0;i<8;i++){const s=makeClaudeShim('ws://localhost:'+PORT+'/ws',WebSocket);try{extra.push(await(await s.use('room')).join('bh-full'));}catch(e){extra.push(e);}}
  ok(extra.filter(x=>x&&x.code==='limit_reached').length===0,'8 fit in a room');
  const s9=makeClaudeShim('ws://localhost:'+PORT+'/ws',WebSocket);let err=null;try{await(await s9.use('room')).join('bh-full');}catch(e){err=e;}
  ok(err&&err.code==='limit_reached','9th rejected');
  // bad origin
  const bad=new WebSocket('ws://localhost:'+PORT+'/ws',{headers:{Origin:'http://evil.example'}});
  const res=await new Promise(r=>{bad.onerror=()=>r('rejected');bad.onopen=()=>r('open');setTimeout(()=>r('timeout'),1500);});
  ok(res!=='open','foreign origin handled ('+res+')');
  srv.kill();process.exit(process.exitCode||0);
})().catch(e=>{console.log('ERR',e);srv.kill();process.exit(1);});
