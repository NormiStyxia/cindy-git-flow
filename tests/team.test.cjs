'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createRelay } = require('../relay/server.cjs');
const { randomBytes } = require('node:crypto');
test('two members, room isolation, offline expiry, authorization and input filtering',async t=>{
  let now=Date.now();const token=randomBytes(24).toString('hex');const server=createRelay(token,{now:()=>now});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url='http://127.0.0.1:'+server.address().port+'/v1/presence';
  const member=(id)=>({id,name:'测试成员',branch:'feature/test',head:'a'.repeat(40),subject:'最新本地提交',dirty:3,ahead:1,sampledAt:new Date(now).toISOString()});
  async function send(id,room='a'.repeat(64),auth=token,extra={}) {return fetch(url,{method:'POST',headers:{Authorization:'Bearer '+auth},body:JSON.stringify({repo:room,member:{...member(id),...extra}})});}
  assert.equal((await send('member-one','a'.repeat(64),'wrong')).status,401);
  await send('member-one');let data=await (await send('member-two')).json();assert.equal(data.members.length,2);assert(data.members.every(m=>m.online));
  data=await (await send('member-three','b'.repeat(64))).json();assert.equal(data.members.length,1);
  now+=91000;data=await (await send('member-two')).json();assert.equal(data.members.find(m=>m.id==='member-one').online,false);
  assert.equal((await send('member-one','a'.repeat(64),token,{dirty:-1})).status,400);
  data=await (await send('member-one','a'.repeat(64),token,{secret:'never return this',path:'/private'})).json();assert(!JSON.stringify(data).includes('never return'));assert(!JSON.stringify(data).includes('/private'));
  now+=86400001;data=await (await send('member-two')).json();assert.equal(data.members.length,1);
});
test('two real local repositories report different branches and unpushed commits',async t=>{
 const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
 const git=require('../node/git.cjs').git;const {sync}=require('../node/team.cjs');
 const base=await fs.mkdtemp(path.join(os.tmpdir(),'git-flow-team-'));t.after(()=>fs.rm(base,{recursive:true,force:true}));
 const first=path.join(base,'alice'),second=path.join(base,'bob');await fs.mkdir(first);await git(first,['init','-b','main']);await git(first,['config','user.name','Alice']);await git(first,['config','user.email','alice@example.invalid']);await fs.writeFile(path.join(first,'file'),'one');await git(first,['add','.']);await git(first,['commit','-m','first']);await git(first,['clone',first,second]);await git(second,['checkout','-b','feature/bob']);await git(second,['config','user.name','Bob']);await git(second,['config','user.email','bob@example.invalid']);await fs.writeFile(path.join(second,'file'),'two');await git(second,['add','.']);await git(second,['commit','-m','only local']);
 const token=randomBytes(24).toString('hex');const server=createRelay(token);await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port;await sync({dir:first,url,room:'team-test',memberId:'alice-device'},token);const result=await sync({dir:second,url,room:'team-test',memberId:'bob-device'},token);
 assert.equal(result.members.length,2);assert(result.members.some(m=>m.branch==='feature/bob'&&m.subject==='only local'));assert(!JSON.stringify(result).includes(token));assert(!JSON.stringify(result).includes(base));
 await assert.rejects(sync({dir:first,url:'http://public.example.invalid',room:'test',memberId:'alice-device'},token));
});
test('relay accepts newer observations after client clock rollback and split UTF-8',async t=>{
 const http=require('node:http');const token=randomBytes(24).toString('hex');let now=Date.now();const server=createRelay(token,{now:()=>now});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
 const url='http://127.0.0.1:'+server.address().port+'/v1/presence';
 const m={id:'clock-test',name:'中文昵称',branch:'旧分支',head:'a'.repeat(40),subject:'中文提交',dirty:0,ahead:null,sampledAt:new Date(now).toISOString()};
 const send=member=>fetch(url,{method:'POST',headers:{Authorization:'Bearer '+token},body:JSON.stringify({repo:'a'.repeat(64),member})});
 await send(m);now+=1000;let data=await (await send({...m,branch:'新分支',sampledAt:new Date(now-86400000).toISOString()})).json();assert.equal(data.members[0].branch,'新分支');assert.equal(data.members[0].seenAt,now);
 const payload=Buffer.from(JSON.stringify({repo:'b'.repeat(64),member:m}));const boundary=payload.indexOf(Buffer.from('中文'))+1;
 data=await new Promise((resolve,reject)=>{const req=http.request(url,{method:'POST',headers:{Authorization:'Bearer '+token}},res=>{const chunks=[];res.on('data',b=>chunks.push(b));res.on('end',()=>resolve(JSON.parse(Buffer.concat(chunks))));});req.on('error',reject);req.write(payload.subarray(0,boundary));setTimeout(()=>req.end(payload.subarray(boundary)),20);});
 assert.equal(data.members[0].name,'中文昵称');assert.equal(data.members[0].subject,'中文提交');
});
test('untrusted presence responses are validated member by member',()=>{
 const {parsePresence}=require('../node/team.cjs');const good={id:'member-one',name:'Name',head:null,branch:'main',subject:'s',dirty:0,ahead:null,seenAt:1000};
 for(const bad of [null,{...good,dirty:'<b>9</b>'},{...good,name:5},{...good,head:'<img>'},{...good,ahead:'4'},{...good,seenAt:Infinity}])assert.throws(()=>parsePresence({serverTime:1000,members:[bad]}));
 const r=parsePresence({serverTime:1000,members:[{...good,untrusted:'drop'}],unexpected:'drop'});assert.equal(r.members[0].online,true);assert.equal(r.members[0].untrusted,undefined);assert.equal(r.unexpected,undefined);
});
