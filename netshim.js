/* Provides window.claude.use('room') on a normal website, backed by the /ws relay. */
function makeClaudeShim(url,WS){
  let ws=null,ready=null,myId=null;const rooms={};
  const fail=(code)=>{for(const n in rooms){const r=rooms[n];r.errs.slice().forEach(f=>{try{f({code,message:code});}catch(e){}});r.dead=true;}for(const n in rooms)delete rooms[n];ready=null;ws=null;};
  function connect(){
    if(ready)return ready;
    ready=new Promise((res,rej)=>{
      let done=false;
      try{ws=new WS(url);}catch(e){ready=null;return rej({code:'upstream_error'});}
      const t=setTimeout(()=>{if(!done){try{ws.close();}catch(e){}rej({code:'upstream_error'});}},10000);
      ws.onmessage=ev=>{let m;try{m=JSON.parse(ev.data);}catch(e){return;}
        if(m.t==='hello'){myId=m.id;done=true;clearTimeout(t);res();return;}
        dispatch(m);};
      ws.onerror=()=>{};
      ws.onclose=()=>{clearTimeout(t);if(!done){ready=null;ws=null;rej({code:'upstream_error'});}else fail('upstream_error');};
    });
    ready.catch(()=>{ready=null;});
    return ready;
  }
  function send(o){if(ws&&ws.readyState===1)ws.send(JSON.stringify(o));}
  function merge(p,patch){for(const k in patch){if(patch[k]===null)delete p[k];else p[k]=patch[k];}}
  function touch(r){r.dirty=true;if(r.pending)return;r.pending=true;setTimeout(()=>{r.pending=false;if(r.dead)return;const ps=r.snapshot();r.subs.slice().forEach(f=>{try{f({peers:ps,joined:[],left:[],updated:[]});}catch(e){}});},0);}
  function dispatch(m){
    const r=rooms[m.room]||Object.values(rooms)[0];if(!r)return;
    if(m.t==='snap'){r.map.clear();for(const id in m.peers)r.map.set(id,{presence:m.peers[id]||{},at:Date.now()});r.map.set(myId,{presence:{},at:Date.now()});if(r.onSnap){r.onSnap();r.onSnap=null;}touch(r);}
    else if(m.t==='join'){r.map.set(m.id,{presence:{},at:Date.now()});touch(r);}
    else if(m.t==='pres'){let e=r.map.get(m.id);if(!e){e={presence:{},at:0};r.map.set(m.id,e);}const p=Object.assign({},e.presence);merge(p,m.patch||{});e.presence=p;e.at=Date.now();touch(r);}
    else if(m.t==='left'){r.map.delete(m.id);touch(r);}
    else if(m.t==='err'){if(r.onErr){r.onErr({code:m.code||'upstream_error'});r.onErr=null;}}
  }
  function makeRoom(name){
    const r={name,map:new Map(),subs:[],errs:[],dirty:true,cache:[],pending:false,dead:false,onSnap:null,onErr:null};
    r.snapshot=()=>{
      if(!r.dirty)return r.cache;
      r.cache=Array.from(r.map,([id,e])=>Object.freeze({peer:id,by:null,isMe:id===myId,sameTab:id===myId,kind:'viewer',guest:false,presence:e.presence,updatedAt:e.at}));
      r.dirty=false;return r.cache;};
    return r;
  }
  const NamedRoom=r=>({
    name:r.name,
    emit:()=>Promise.resolve(),on:()=>()=>{},
    presence(patch){if(r.dead)return Promise.reject({code:'upstream_error'});const e=r.map.get(myId);if(e){const p=Object.assign({},e.presence);merge(p,patch);e.presence=p;e.at=Date.now();r.dirty=true;}send({t:'pres',patch});return Promise.resolve();},
    peers:()=>r.snapshot(),
    onPeers(h,onErr){r.subs.push(h);if(onErr)r.errs.push(onErr);return()=>{r.subs=r.subs.filter(x=>x!==h);if(onErr)r.errs=r.errs.filter(x=>x!==onErr);};},
    connected:()=>!!ws&&ws.readyState===1,
    onConnection(h){setTimeout(()=>h(!!ws&&ws.readyState===1),0);return()=>{};},
    leave(){send({t:'leave'});r.dead=true;delete rooms[r.name];return Promise.resolve();}
  });
  const room={
    async join(name){
      if(!/^[a-z0-9][a-z0-9_.-]{0,47}$/.test(name))throw {code:'invalid_argument'};
      await connect();
      if(rooms[name])return NamedRoom(rooms[name]);
      for(const n in rooms){send({t:'leave'});rooms[n].dead=true;delete rooms[n];}
      const r=makeRoom(name);rooms[name]=r;
      await new Promise((res,rej)=>{
        const t=setTimeout(()=>rej({code:'upstream_error'}),10000);
        r.onSnap=()=>{clearTimeout(t);res();};r.onErr=e=>{clearTimeout(t);rej(e);};
        send({t:'join',room:name});
      }).catch(e=>{delete rooms[name];throw e;});
      return NamedRoom(r);
    }
  };
  return{use:async name=>name==='room'?room:null};
}
