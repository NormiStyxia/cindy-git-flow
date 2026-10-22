'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const repo = require('../node/git.cjs');
const { layout } = require('../graph.js');
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'git-flow-test-'));
  t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  await repo.git(dir,['init','-b','main']); await repo.git(dir,['config','user.name','测试者']); await repo.git(dir,['config','user.email','test@example.invalid']);
  return dir;
}
async function commit(dir,file,text,message) { await fs.writeFile(path.join(dir,file),text); await repo.git(dir,['add','--',file]); await repo.git(dir,['commit','-m',message]); return (await repo.git(dir,['rev-parse','HEAD'])).trim(); }
test('empty repo, unicode file, staged rename and detached HEAD',async t=>{
  const dir=await fixture(t); let s=await repo.snapshot(dir);assert.equal(s.unborn,true);assert.equal(s.branch,'main');assert.deepEqual(s.commits,[]);
  await commit(dir,'名字 with spaces.txt','hello','首次提交');
  await repo.git(dir,['mv','名字 with spaces.txt','新文件.txt']);
  s=await repo.snapshot(dir);assert.equal(s.status.count,1);assert.equal(s.status.files[0].from,'名字 with spaces.txt');assert.equal(s.status.files[0].path,'新文件.txt');
  await repo.git(dir,['commit','-m','rename']); await repo.git(dir,['checkout','--detach']);s=await repo.snapshot(dir);assert.equal(s.detached,true);assert.equal(s.branch,null);
  await assert.rejects(repo.detail(dir,'--output=/tmp/evil'));
});
test('divergence, merge graph, diff, worktree and clean read-only snapshots',async t=>{
  const dir=await fixture(t);const base=await commit(dir,'base','base','base');
  await repo.git(dir,['checkout','-b','feature']);const feature=await commit(dir,'feature','feature','feature');
  await repo.git(dir,['checkout','main']);await commit(dir,'main','main','main');
  let c=await repo.compare(dir,'feature');assert.equal(c.relation,'diverged');assert.equal(c.ahead,1);assert.equal(c.behind,1);assert.equal(c.base,base);
  const before=await repo.git(dir,['status','--porcelain=v2','-z']);const branchState=await repo.snapshot(dir);assert(!branchState.currentCommits.some(c=>c.sha===feature));assert.equal(await repo.git(dir,['status','--porcelain=v2','-z']),before);
  await repo.git(dir,['merge','--no-ff','feature','-m','merge']);
  const wt=dir+'-worktree';t.after(()=>fs.rm(wt,{recursive:true,force:true}));await repo.git(dir,['worktree','add',wt,'feature']);
  const s=await repo.snapshot(dir);assert.equal(s.worktrees.length,2);assert.equal(s.commits[0].parents.length,2);assert(s.currentCommits.some(c=>c.sha===feature));assert.equal(s.currentCommits[0].parents.length,2);
  const g=layout(s.commits);assert.equal(g.links.length,s.commits.reduce((n,c)=>n+c.parents.length,0));
  for(const edge of g.links){assert(s.commits[edge.fromRow].parents.includes(edge.to));if(!edge.boundary){assert.equal(s.commits[edge.toRow].sha,edge.to);assert(edge.toRow>edge.fromRow);assert.equal(g.rows[edge.toRow].lane,edge.toLane);}}
  const d=await repo.detail(dir,feature);assert(d.patch.includes('+feature'));c=await repo.compare(dir,'feature');assert.equal(c.relation,'contains');
});
test('fetch updates cached refs without changing worktree or HEAD',async t=>{
  const dir=await fixture(t);await commit(dir,'file','one','one');
  const clone=dir+'-clone';t.after(()=>fs.rm(clone,{recursive:true,force:true}));await repo.git(dir,['clone',dir,clone]);
  const before=await repo.snapshot(clone);await commit(dir,'file','two','two');const after=await repo.fetchRemote(clone,'origin');
  assert.equal(before.head,after.head);assert.equal(after.behind,1);assert.equal(after.fetchedRemote,'origin');assert(Number.isFinite(Date.parse(after.fetchCompletedAt)));assert.equal(await fs.readFile(path.join(clone,'file'),'utf8'),'one');
  await assert.rejects(repo.fetchRemote(clone,'--all'));
});
test('remote identity removes secrets and normalizes SSH/HTTPS',()=>{
 assert.equal(repo.canonicalRemote('git@github.com:Team/repo.git'),'github.com/Team/repo');
 assert.equal(repo.canonicalRemote('https://user:secret@github.com/Team/repo.git'),'github.com/Team/repo');
 assert.equal(repo.canonicalRemote('/tmp/repo'),null);
});
test('boundary graph retains parent beyond visible window',()=>{
 const g=layout([{sha:'a',parents:['b','c']},{sha:'b',parents:['z']}]);assert.equal(g.links.filter(e=>e.boundary).length,2);
});
test('分叉分支沿自己的泳道走到父提交才汇入，不和主干叠线', () => {
  // main: m2 → m1 → base；feature: f1 → base
  const g = layout([{ sha: 'm2', parents: ['m1'] }, { sha: 'f1', parents: ['base'] }, { sha: 'm1', parents: ['base'] }, { sha: 'base', parents: [] }]);
  const lane = sha => g.rows.find(r => r.sha === sha).lane;
  assert.notEqual(lane('f1'), lane('m1'));
  const fork = g.links.find(l => l.from === 'f1');
  assert.equal(fork.lane, lane('f1'));
  assert.equal(fork.toLane, lane('base'));
  assert.equal(g.reach[2], Math.max(lane('m1'), lane('f1')));
});

test('当前分支读取自己的历史，其他分支超过 180 条也不丢失当前历史', async t => {
  const dir = await fixture(t), base = await commit(dir, 'file', 'base', 'quiet base');
  await repo.git(dir, ['branch', 'quiet']);
  const { spawn } = require('node:child_process');
  const timestamp = Math.floor(Date.now() / 1000);
  const input = Array.from({ length: 200 }, (_, i) => {
    const subject = 'noisy ' + i;
    return 'commit refs/heads/main\nmark :' + (i + 1) + '\nauthor Test <test@example.invalid> ' + (timestamp + i) + ' +0000\ncommitter Test <test@example.invalid> ' + (timestamp + i) + ' +0000\ndata ' + subject.length + '\n' + subject + '\nfrom ' + (i ? ':' + i : base) + '\nM 100644 inline file\ndata 1\nx\n\n';
  }).join('');
  await new Promise((resolve, reject) => {
    const child = spawn('git', ['-C', dir, 'fast-import', '--quiet'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = ''; child.stderr.on('data', b => stderr += b); child.on('error', reject); child.on('close', code => code ? reject(new Error(stderr)) : resolve()); child.stdin.end(input);
  });
  await repo.git(dir, ['checkout', 'quiet']);
  const before = await repo.git(dir, ['status', '--porcelain=v2', '-z']);
  const state = await repo.snapshot(dir);
  assert.equal(state.commits.length, 180); assert.equal(state.truncated, true);
  assert(!state.commits.some(c => c.sha === base));
  assert.deepEqual(state.currentCommits.map(c => c.sha), [base]); assert.equal(state.currentTruncated, false);
  assert.equal(state.branch, 'quiet'); assert.equal(state.head, base);
  assert.equal(await repo.git(dir, ['status', '--porcelain=v2', '-z']), before);
  await repo.git(dir, ['checkout', '--detach']);
  assert.equal((await repo.snapshot(dir)).currentCommits[0].sha, base);
  await repo.git(dir, ['checkout', '--orphan', 'empty-current']);
  const empty = await repo.snapshot(dir); assert(empty.commits.length > 0); assert.deepEqual(empty.currentCommits, []);
});
