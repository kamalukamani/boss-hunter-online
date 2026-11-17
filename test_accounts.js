// Usage: PORT=8127 DATA_DIR=/tmp/bh-test node server.js &  then  node test_accounts.js
const B='http://localhost:'+(process.env.PORT||8127);
const j=async(m,p,b,t)=>{const r=await fetch(B+p,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});return[r.status,await r.json().catch(()=>({}))];};
(async()=>{
const out=[];const P=(n,v)=>out.push(n+': '+v);
P('config',JSON.stringify((await j('GET','/api/config'))[1]));
P('weak',(await j('POST','/api/auth/register',{username:'hero1',email:'a@b.co',password:'abc',confirm:'abc'}))[1].err);
P('mismatch',(await j('POST','/api/auth/register',{username:'hero1',email:'a@b.co',password:'abcd1234',confirm:'x'}))[1].err);
P('bademail',(await j('POST','/api/auth/register',{username:'hero1',email:'nope',password:'abcd1234',confirm:'abcd1234'}))[1].err);
const [s1,r1]=await j('POST','/api/auth/register',{username:'Hero1',email:'Hero@Mail.com',password:'abcd1234',confirm:'abcd1234',remember:true});P('register',s1+' '+r1.profile.playerId+' '+r1.profile.username);
P('dupuser',(await j('POST','/api/auth/register',{username:'hero1',email:'o@o.co',password:'abcd1234',confirm:'abcd1234'}))[1].err);
P('dupemail',(await j('POST','/api/auth/register',{username:'hero2',email:'hero@mail.com',password:'abcd1234',confirm:'abcd1234'}))[1].err);
const [s2,r2]=await j('POST','/api/auth/login',{id:'hero@mail.com',password:'abcd1234'});P('login by email',s2);
const [s3,r3]=await j('POST','/api/auth/login',{id:'HERO1',password:'abcd1234'});P('login by user',s3);
const T=r3.token,T1=r1.token;
P('save',(await j('PUT','/api/save',{save:{xp:500,money:1234,x:{a:1}}},T))[0]);
const g=await j('GET','/api/save',null,T);P('load',JSON.stringify(g[1].save)+' lv='+g[1].profile.level+' exp='+g[1].profile.exp+' money='+g[1].profile.money);
P('no auth',(await j('GET','/api/save'))[0]);
P('bad token',(await j('GET','/api/save',null,'s_'+'0'.repeat(64)))[0]);
P('win',(await j('POST','/api/event',{type:'win'},T))[1].profile.wins);P('win2 rate',(await j('POST','/api/event',{type:'win'},T))[0]);
P('loss',(await j('POST','/api/event',{type:'loss'},T))[1].profile.losses);
await j('POST','/api/ping',{},T);await new Promise(r=>setTimeout(r,2100));P('ping',(await j('POST','/api/ping',{},T))[0]);
const [,pf]=await j('GET','/api/auth/profile',null,T);P('profile',JSON.stringify(pf.profile));
// second account isolation
const [,r4]=await j('POST','/api/auth/register',{username:'other9',email:'o9@o.co',password:'zzzz9999',confirm:'zzzz9999'});
P('isolation other save',JSON.stringify((await j('GET','/api/save',null,r4.token))[1].save));
P('logout',(await j('POST','/api/auth/logout',{},T))[0]);P('after logout',(await j('GET','/api/save',null,T))[0]);
for(let i=0;i<5;i++)await j('POST','/api/auth/login',{id:'other9',password:'wrong'+i});
const lk=await j('POST','/api/auth/login',{id:'other9',password:'zzzz9999'});P('brute lock',lk[0]+' '+lk[1].err);
console.log(out.join('\n'));})();
