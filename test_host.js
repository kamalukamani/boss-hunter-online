// Host = room creator (oldest member), migrates when they leave.  Usage: PORT=3000 node server.js & node test_host.js
const B='localhost:'+(process.env.PORT||3000);
const j=async(p,b)=>(await fetch('http://'+B+p,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)})).json();
const sleep=ms=>new Promise(r=>setTimeout(r,ms));let fails=0;const ok=(n,c)=>{console.log((c?'PASS ':'FAIL ')+n);if(!c)fails++;};
function conn(tok){return new Promise(res=>{const ws=new WebSocket('ws://'+B+'/ws'),c={ws,id:null,host:null,send:o=>ws.send(JSON.stringify(o))};ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.t==='hello'){c.id=m.id;c.send({t:'auth',token:tok});res(c);}if(m.t==='host')c.host=m.id;};});}
(async()=>{
  const mk=async n=>(await j('/api/auth/register',{username:'host'+n+Date.now()%1e6,email:'h'+n+Date.now()+'@t.co',password:'abcd1234',confirm:'abcd1234'})).token;
  const toks=[];for(let i=0;i<3;i++)toks.push(await mk(i));
  // try many orders so a "lowest id" rule would fail at least once
  let allOk=true;
  for(let round=0;round<6;round++){
    const a=await conn(toks[0]),b=await conn(toks[1]);await sleep(150);
    a.send({t:'join',room:'hostroom'+round});await sleep(200);b.send({t:'join',room:'hostroom'+round});await sleep(300);
    if(!(a.host===a.id&&b.host===a.id))allOk=false;
    a.ws.close();await sleep(300);if(b.host!==b.id)allOk=false;
    b.ws.close();await sleep(100);
  }
  ok('creator is host for both players, migrates to remaining player (6 rounds)',allOk);
  process.exit(fails?1:0);
})();
