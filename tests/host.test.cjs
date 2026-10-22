'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs'),crypto=require('node:crypto');
function host(readFailure = false, model = null, nodeImpl = null, initialConfig = {}) {
 let cfg={teamRepos:{'/repo-a':{enabled:false,room:'a'}},memberId:'test-device',...initialConfig},listener,channel;
 const messages=[],calls=[];
 const context={crypto,TextEncoder,setTimeout:(f,ms)=>{const timer=setTimeout(f,ms);timer.unref();return timer;},BroadcastChannel:class{constructor(){channel=this;}postMessage(m){messages.push(m);}},fetch:async(url,opt)=>{if(opt){if(Buffer.byteLength(opt.body)>65536)return{ok:false,status:413};cfg=JSON.parse(opt.body);return{ok:true};}return{ok:!readFailure,json:async()=>readFailure?{error:'storage unavailable'}:structuredClone(cfg)};},cindy:{onHostMessage:fn=>listener=fn,send:async m=>{messages.push(m);if(m.kind==='oneshot_text')return model ? model(m) : {ok:false,errorCode:'NO_CANDIDATE'};},node:{request:async r=>{calls.push(r);return nodeImpl ? await nodeImpl(r) : {ok:true,result:{dir:r.params.dir}};}}}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../main.js'),'utf8'),context);
 function request(id,method,params){channel.onmessage({data:{type:'request',id,method,params}});}
 async function result(id){for(let i=0;i<100;i++){const m=messages.find(m=>m.id===id&&m.type==='response');if(m)return m;await new Promise(r=>setTimeout(r,5));}throw new Error('response timeout');}
 return{request,result,listener,messages,calls,context,get config(){return cfg;}};
}
test('concurrent per-repository settings preserve disabled sharing and unrelated updates',async()=>{
 const h=host();h.request('1','config/update',{teamRepo:{dir:'/repo-b',enabled:true,room:'b'}});h.request('2','config/update',{displayName:'Alice'});h.request('3','config/update',{teamRepo:{dir:'/repo-c',enabled:true,room:'c'}});
 await Promise.all(['1','2','3'].map(id=>h.result(id)));assert.equal(h.config.teamRepos['/repo-a'].enabled,false);assert.equal(h.config.teamRepos['/repo-b'].room,'b');assert.equal(h.config.teamRepos['/repo-c'].room,'c');assert.equal(h.config.displayName,'Alice');
});
test('duplicate broadcast requests execute Git fetch only once',async()=>{
 const h=host();h.request('same','repo/fetch',{dir:'/repo-a',remote:'origin'});h.request('same','repo/fetch',{dir:'/repo-a',remote:'origin'});await h.result('same');assert.equal(h.calls.length,1);
});
test('remote session paths and read-only fetch are rejected before Node access',async()=>{
 const h=host();await h.listener({type:'tool-call',tool:'git_status',callId:'remote',args:{session_context:{workdir_is_local:false,workdir:'/repo-a'}}});await h.listener({type:'tool-call',tool:'git_fetch',callId:'readonly',args:{remote:'origin',session_context:{workdir_is_local:true,workdir_is_read_only:true,workdir:'/repo-a'}}});assert.equal(h.calls.length,0);assert.equal(h.messages.filter(m=>m.type==='tool-result'&&m.ok===false).length,2);
});
test('failed KV read never overwrites existing configuration',async()=>{
 const h=host(true);h.request('bad-read','config/update',{motion:false});const r=await h.result('bad-read');assert(r.error);assert.equal(h.config.memberId,'test-device');assert.equal(h.config.teamRepos['/repo-a'].enabled,false);assert.equal(h.config.motion,undefined);
});
test('自动获取间隔持久保存，不覆盖其他配置并拒绝非法值',async()=>{
 const h=host();h.request('interval','config/update',{autoFetchMinutes:1});await h.result('interval');
 assert.equal(h.config.autoFetchMinutes,1);assert.equal(h.config.teamRepos['/repo-a'].enabled,false);
 h.request('off','config/update',{autoFetchMinutes:0});await h.result('off');assert.equal(h.config.autoFetchMinutes,0);
 h.request('bad','config/update',{autoFetchMinutes:-1});assert((await h.result('bad')).error);assert.equal(h.config.autoFetchMinutes,0);
});
function translateMock(message) {
 const input = JSON.parse(message.prompt.split('输入数据：\n')[1]);
 return {ok:true,text:JSON.stringify(input.map(item=>({id:item.id,text:'修复问题：新增说明的中文译文 '+item.id})))};
}
test('陌生的新提交走真实快问快答协议，翻译缓存与设置并发保存不互相覆盖',async()=>{
 const h=host(false,translateMock),source='fix(camera): eliminate jitter after abrupt zoom';
 h.request('new','text/translate',{subjects:[source]});h.request('setting','config/update',{displayName:'小明'});
 const r=await h.result('new');await h.result('setting');assert.equal(r.result.translations[source],'修复问题：新增说明的中文译文 0');
 assert.equal(h.config.translationCache[source],r.result.translations[source]);assert.equal(h.config.displayName,'小明');assert.equal(h.config.teamRepos['/repo-a'].enabled,false);
 const call=h.messages.find(m=>m.kind==='oneshot_text');assert.equal(call.expectJson,true);assert(!('model' in call));assert(h.messages.some(m=>m.type==='translations-changed'));
});
test('多面板同一提交与重复刷新只翻译一次，支持同内容不同提交复用',async()=>{
 const h=host(false,translateMock),subjects=['feat(editor): add a brand new gizmo'];
 h.request('a','text/translate',{subjects});h.request('b','text/translate',{subjects});await Promise.all(['a','b'].map(id=>h.result(id)));
 h.request('c','text/translate',{subjects});await h.result('c');assert.equal(h.messages.filter(m=>m.kind==='oneshot_text').length,1);
 assert.equal(h.messages.filter(m=>m.type==='config-changed').length,0);
});
test('无模型时暂停自动翻译，不轰炸；明确重试后可恢复',async()=>{
 let ready=false;const h=host(false,m=>ready?translateMock(m):{ok:false,errorCode:'NO_CANDIDATE'}),subjects=['fix: avoid stuck selection'];
 h.request('fail','text/translate',{subjects});assert((await h.result('fail')).error.includes('轻量任务模型'));
 h.request('again','text/translate',{subjects});await h.result('again');assert.equal(h.messages.filter(m=>m.kind==='oneshot_text').length,1);
 ready=true;h.request('retry','text/translate',{subjects,retry:true});assert((await h.result('retry')).result);assert.equal(h.messages.filter(m=>m.kind==='oneshot_text').length,2);
});
test('模型返回错位、重复、英文或不可解析的结果不会污染缓存',async()=>{
 for(const text of ['not json',JSON.stringify([{id:9,text:'错位译文'}]),JSON.stringify([{id:0,text:'untranslated'}]),JSON.stringify([{id:0,text:'译文一'},{id:0,text:'译文二'}])]){
  const h=host(false,()=>({ok:true,text}));h.request('bad','text/translate',{subjects:['fix: unknown source']});assert((await h.result('bad')).error);assert.equal(h.config.translationCache,undefined);
 }
});
test('翻译缓存安全处理特殊键名且有容量上限',async()=>{
 const h=host(false,translateMock);
 h.request('special','text/translate',{subjects:['__proto__','constructor']});const r=await h.result('special');assert(Object.hasOwn(r.result.translations,'__proto__'));assert(Object.hasOwn(h.config.translationCache,'__proto__'));
 for(let i=0;i<22;i++){const id='batch'+i;h.request(id,'text/translate',{subjects:Array.from({length:20},(_,j)=>'change '+i+' '+j)});await h.result(id);}
 assert.equal(Object.keys(h.config.translationCache).length,400);
});
test('翻译只接受受限标题，不会读取仓库且归因到调用',async()=>{
 const h=host(false,translateMock);h.request('limit','text/translate',{subjects:['x'.repeat(1501)]});assert((await h.result('limit')).error);
 await h.listener({type:'tool-call',tool:'git_translate',callId:'translation-tool',args:{subjects:['fix: unexpected new change']}});
 assert.equal(h.calls.length,0);assert.equal(h.messages.find(m=>m.kind==='oneshot_text').callId,'translation-tool');assert(h.messages.some(m=>m.type==='tool-result'&&m.ok));
});
test('工具栏收起持久保存且不会重置团队同步，只接受布尔值',async()=>{
 const h=host();h.request('collapse','ui/update',{headerCollapsed:true});assert((await h.result('collapse')).result);
 assert.equal(h.config.headerCollapsed,true);assert.equal(h.config.teamRepos['/repo-a'].enabled,false);
 assert.equal(h.messages.filter(m=>m.type==='config-changed').length,0);assert.equal(h.messages.filter(m=>m.type==='ui-changed').length,1);
 h.request('invalid','ui/update',{headerCollapsed:'false'});assert((await h.result('invalid')).error);assert.equal(h.config.headerCollapsed,true);
 h.request('expand','ui/update',{headerCollapsed:false});await h.result('expand');assert.equal(h.config.headerCollapsed,false);
});

test('长时间获取使用续期协议，真实进度通知广播到面板，成功时间按远端保存',async()=>{
 const h=host(false,null,async r=>({ok:true,result:{dir:r.params.dir,fetchCompletedAt:'2026-10-13T04:00:00.000Z'}}));
 h.request('long-fetch','repo/fetch',{dir:'/repo-a',remote:'origin'});await h.result('long-fetch');
 assert.equal(h.calls[0].timeoutMs,90000);assert.equal(h.calls[0].maxTotalMs,900000);
 assert.equal(h.config.fetchTimes[JSON.stringify(['/repo-a','origin'])],'2026-10-13T04:00:00.000Z');
 await h.listener({type:'event',name:'node-notification',method:'fetch-progress',params:{dir:'/repo-a',remote:'origin',phase:'receiving',percent:17}});
 assert(h.messages.some(m=>m.type==='fetch-progress'&&m.percent===17));
 assert.equal(h.messages.filter(m=>m.type==='config-changed').length,0);
});
test('获取失败不覆盖成功时间，不冒充本地刷新或权限错误',async()=>{
 const h=host(false,null,async()=>({ok:false,message:'远端访问未获授权'}));
 h.request('failed-fetch','repo/fetch',{dir:'/repo-a',remote:'origin'});const result=await h.result('failed-fetch');
 assert(result.error.includes('未获授权'));assert.equal(h.config.fetchTimes,undefined);
});

test('下载未结束时去重记录不会在两分钟后消失，重发不积累完成通知',async()=>{
 let finish;const h=host(false,null,()=>new Promise(resolve=>finish=resolve)),timers=[];
 h.context.setTimeout=(callback,ms)=>{timers.push({callback,ms});return{unref(){}};};
 h.request('held','repo/fetch',{dir:'/repo-a',remote:'origin'});
 await new Promise(r=>setTimeout(r,10));
 assert.equal(timers.length,0,'in-flight request scheduled expiration');
 for(let i=0;i<20;i++)h.request('held','repo/fetch',{dir:'/repo-a',remote:'origin'});
 finish({ok:true,result:{dir:'/repo-a'}});await h.result('held');
 assert.equal(h.calls.length,1);assert.equal(h.messages.filter(m=>m.type==='response'&&m.id==='held').length,1);
 assert.equal(timers[0].ms,120000);
});

test('只跟随前台对话，重复或乱序通知不打断手动选择，重开面板可读当前焦点',async()=>{
 const h=host();
 await h.listener({type:'event',name:'did-session-created',data:{sessionId:'background',workdir:'/background'}});
 h.request('empty','session/current');assert.equal((await h.result('empty')).result,null);
 await h.listener({type:'event',name:'did-session-switched',seq:5,data:{sessionId:'a',workdir:'/repo-a'}});
 await h.listener({type:'event',name:'did-session-switched',seq:6,data:{sessionId:'a',workdir:'/repo-a'}});
 await h.listener({type:'event',name:'did-session-switched',seq:4,data:{sessionId:'b',workdir:'/repo-b'}});
 h.request('focus','session/current');const focus=(await h.result('focus')).result;
 assert.equal(focus.sessionId,'a');assert.equal(h.messages.filter(m=>m.type==='session-focus').length,1);
 assert.equal(h.calls.length,0);
});
test('自动跟随读取子目录对应仓库，不覆盖手动仓库设置或广播全局切换',async()=>{
 const h=host(false,null,async()=>({ok:true,result:{dir:'/repo-a'}}));
 await h.listener({type:'event',name:'did-session-switched',data:{sessionId:'a',workdir:'/repo-a/src'}});
 h.request('focus','session/current');const focus=(await h.result('focus')).result;
 h.request('follow','session/connect',{revision:focus.revision});assert.equal((await h.result('follow')).result.dir,'/repo-a');
 assert.equal(h.calls[0].params.dir,'/repo-a/src');assert.equal(h.config.lastDir,undefined);
 assert(!h.messages.some(m=>m.type==='repo-connected'||m.type==='config-changed'));
});
test('对话切换期间旧读取被拒绝，缺少项目或明确远程路径不会启动本机 Git',async()=>{
 let finish;const h=host(false,null,()=>new Promise(resolve=>finish=resolve));
 await h.listener({type:'event',name:'did-session-switched',data:{sessionId:'a',workdir:'/repo-a'}});
 h.request('old','session/connect',{revision:1});await new Promise(r=>setTimeout(r,10));
 await h.listener({type:'event',name:'did-session-switched',data:{sessionId:'b'}});
 finish({ok:true,result:{dir:'/repo-a'}});assert((await h.result('old')).error.includes('对话已切换'));
 for(const [i,data] of [{sessionId:'remote',workdir:'/repo-a',workdir_is_local:false},{sessionId:'url',workdir:'ssh://host/repo-a'},{sessionId:'relative',workdir:'repo-a'}].entries()){
  await h.listener({type:'event',name:'did-session-switched',data});
  h.request('current'+i,'session/current');const f=(await h.result('current'+i)).result;assert.equal(f.workdir,null);
  h.request('blocked'+i,'session/connect',{revision:f.revision});assert((await h.result('blocked'+i)).error);
 }
 assert.equal(h.calls.length,1);
});
test('事件丢失时清空焦点，后续通知重新建立跟随；手动面板连接不抢其他面板',async()=>{
 const h=host();
 await h.listener({type:'event',name:'did-session-switched',data:{sessionId:'a',workdir:'/repo-a'}});
 await h.listener({type:'event',name:'did-session-created',dropped:2,data:{sessionId:'background'}});
 h.request('lost','session/current');assert.equal((await h.result('lost')).result,null);
 await h.listener({type:'event',name:'did-session-switched',data:{sessionId:'b',workdir:'/repo-b'}});
 h.request('manual','repo/connect',{dir:'/manual'});await h.result('manual');
 assert(!h.messages.some(m=>m.type==='repo-connected'));
 h.request('still-follow','session/current');assert.equal((await h.result('still-follow')).result.sessionId,'b');
});

test('中文翻译按整份配置的 UTF-8 字节限额淘汰旧缓存，保留新译文和团队设置',async()=>{
 const cache=Object.fromEntries(Array.from({length:200},(_,i)=>['old source '+i,'旧中文译文'.repeat(50)]));
 const repositories=Array.from({length:12},(_,i)=>'/项目'+i+'很长的仓库名字'.repeat(20));
 const h=host(false,translateMock,null,{translationCache:cache,repositories,lastDir:repositories[0],fetchTimes:{'["/repo-a","origin"]':'2026-10-13T00:00:00Z'}});
 const source='art(livery): 涂装角色贴纸按新立绘重新生成';
 h.request('full-cache','text/translate',{subjects:[source]});const result=await h.result('full-cache');
 assert(!result.error,result.error);assert.equal(h.config.translationCache[source],result.result.translations[source]);
 assert(Buffer.byteLength(JSON.stringify(h.config))<=60*1024);
 assert.deepEqual(h.config.repositories,repositories);assert.equal(h.config.lastDir,repositories[0]);
 assert.equal(h.config.teamRepos['/repo-a'].room,'a');assert.equal(Object.keys(h.config.fetchTimes).length,1);
 assert(!Object.hasOwn(h.config.translationCache,'old source 0'));assert(Object.hasOwn(h.config.translationCache,'old source 199'));
 h.request('same-source','text/translate',{subjects:[source]});await h.result('same-source');
 assert.equal(h.messages.filter(m=>m.kind==='oneshot_text').length,1);
});
test('其他设置增长也会先压缩旧译文；非缓存配置超限不会覆盖原设置',async()=>{
 const cache=Object.fromEntries(Array.from({length:100},(_,i)=>['cached '+i,'中文'.repeat(80)]));
 const h=host(false,null,null,{translationCache:cache});
 h.request('grow','config/update',{displayName:'名字'.repeat(1000)});assert(!(await h.result('grow')).error);
 assert(Buffer.byteLength(JSON.stringify(h.config))<=60*1024);assert.equal(h.config.displayName,'名字'.repeat(1000));
 const before=structuredClone(h.config);
 h.request('overflow','config/update',{displayName:'名'.repeat(30000)});assert((await h.result('overflow')).error.includes('存储上限'));
 assert.deepEqual(h.config,before);
});

test('锁定保存根仓库且广播独立事件，解锁保留其他设置',async()=>{
 const h=host(false,null,async()=>({ok:true,result:{dir:'/repo-a'}}));
 h.request('pin','ui/repository-lock',{locked:true,dir:'/repo-a/src'});const pinned=await h.result('pin');
 assert.equal(pinned.result.repositoryLock.dir,'/repo-a');assert.equal(h.config.repositoryLock.dir,'/repo-a');
 assert.equal(h.calls[0].params.dir,'/repo-a/src');assert.equal(h.config.teamRepos['/repo-a'].room,'a');
 assert.equal(h.messages.filter(m=>m.type==='repository-lock-changed').length,1);
 h.request('unpin','ui/repository-lock',{locked:false});await h.result('unpin');
 assert.equal(h.config.repositoryLock,null);assert.equal(h.config.teamRepos['/repo-a'].enabled,false);
});
test('锁定后仍记录最新对话元数据，手动换库更新持久锁定目标',async()=>{
 const h=host();h.request('lock','ui/repository-lock',{locked:true,dir:'/repo-a'});await h.result('lock');
 await h.listener({type:'event',name:'did-session-switched',data:{sessionId:'b',workdir:'/repo-b'}});
 assert.equal(h.config.repositoryLock.dir,'/repo-a');
 h.request('focus','session/current');assert.equal((await h.result('focus')).result.workdir,'/repo-b');
 h.request('manual-switch','repo/connect',{dir:'/manual'});await h.result('manual-switch');
 assert.equal(h.config.repositoryLock.dir,'/manual');assert.equal(h.config.lastDir,'/manual');
});
test('无效锁定及读取失败不改变已存锁定状态',async()=>{
 const h=host(false,null,async()=>({ok:false,message:'选择的目录不是 Git 仓库。'}),{repositoryLock:{dir:'/saved'}});
 for(const [i,params] of [{locked:'true',dir:'/other'},{locked:true},{locked:true,dir:'/not-git'}].entries()){
  h.request('bad-pin'+i,'ui/repository-lock',params);assert((await h.result('bad-pin'+i)).error);
  assert.equal(h.config.repositoryLock.dir,'/saved');
 }
 const storage=host(true,null,null,{repositoryLock:{dir:'/saved'}});
 storage.request('cannot-unlock','ui/repository-lock',{locked:false});assert((await storage.result('cannot-unlock')).error);
 assert.equal(storage.config.repositoryLock.dir,'/saved');
});
