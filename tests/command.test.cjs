'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { runCommand } = require('../node/command.cjs');
const { gitError, progressReader } = require('../node/git.cjs');
test('流式读取不破坏分块中文，错误诊断不泄漏远端凭证', async () => {
  const result = await runCommand(process.execPath, ['-e', "const b=Buffer.from('中文提交');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),20)"]);
  assert.equal(result.stdout, '中文提交');
  for (const [stderr, phrase] of [['fatal: Authentication failed for https://user:secret@example.invalid/repo', '未获授权'], ['Could not resolve host: private.example', '解析'], ['Operation too slow', '长时间无响应'], ['SSL certificate problem', '安全连接失败']]) {
    const message = gitError({ stderr }, true); assert(message.includes(phrase)); assert(!message.includes('secret')); assert(!message.includes('example'));
  }
  assert(gitError({ killed: true }, true).includes('14 分钟'));
  assert(gitError({ killed: true }, false).includes('本地仓库'));
});
test('下载进度按真实字节和阶段解析，不把 Git 原始输出传到界面', () => {
  const events = [], read = progressReader(value => events.push(value));
  read(Buffer.from('remote: Counting objects: 50% (5/10)\rReceiv'));
  read(Buffer.from('ing objects: 17% (7/40), 42.50 MiB | 1.2 MiB/s\rhttps://secret@example.invalid\nResolving deltas: 100% (1/1)\n'));
  assert.deepEqual(events, [{ phase: 'counting', percent: 50 }, { phase: 'receiving', percent: 17, bytes: 44564480 }, { phase: 'resolving', percent: 100 }]);
});
test('超时停止 Git 整个进程组，包括忽略 SIGTERM 的孙进程', { skip: process.platform === 'win32' }, async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'git-flow-process-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'child.pid');
  const grandchild = "require('node:fs').writeFileSync(process.argv[1],String(process.pid));process.on('SIGTERM',()=>{});setInterval(()=>{},1000)";
  const script = "require('node:child_process').spawn(process.execPath,['-e',process.argv[1],process.argv[2]],{stdio:'inherit'});setInterval(()=>{},1000)";
  await assert.rejects(runCommand(process.execPath, ['-e', script, grandchild, file], { timeout: 700 }), e => e.killed && e.code === 'ETIMEDOUT');
  const pid = Number(await fs.readFile(file, 'utf8'));
  let stopped = false;
  for (let i = 0; i < 40; i++) { try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') { stopped = true; break; } } await new Promise(r => setTimeout(r, 50)); }
  assert(stopped, 'grandchild survived the request timeout');
});
