'use strict';
const { runCommand: run } = require('./command.cjs');
const { progressReader } = require('./git.cjs');
const fs = require('node:fs/promises');
const path = require('node:path');
const HOST = 'github.com';
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const FULL_NAME = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
// Tokens only ever live in a child environment; never return, log or persist them.
const baseEnv = () => ({ ...process.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
function ghError(e, fallback) {
  const stderr = String(e.stderr || '');
  if (e.code === 'ENOENT') return '找不到 GitHub CLI（gh），请先安装 https://cli.github.com 后重试。';
  if (e.killed) return '连接 GitHub 超时，请检查网络或代理后重试。';
  if (/not logged in|no oauth token|authentication required/i.test(stderr)) return '这个账号的登录已失效，请重新添加账号。';
  if (/HTTP 401|Bad credentials/i.test(stderr)) return 'GitHub 拒绝了这个账号的登录凭据，请重新添加账号。';
  if (/HTTP 403|rate limit/i.test(stderr)) return 'GitHub 暂时拒绝请求（权限不足或访问频率受限），请稍后重试。';
  if (/could not resolve|connect|timeout|network/i.test(stderr)) return '无法连接 GitHub，请检查网络或代理后重试。';
  return fallback;
}
async function gh(args, options = {}) {
  try { return (await run('gh', args, { timeout: 30000, env: baseEnv(), ...options })).stdout; }
  catch (e) { const error = new Error(ghError(e, options.failure || 'GitHub CLI 执行失败，请稍后重试。')); error.code = e.code; error.stderr = e.stderr; throw error; }
}
async function gitConfig(args) {
  try { return (await run('git', ['config', ...args], { timeout: 10000, env: baseEnv() })).stdout.trim(); }
  catch (e) { if (e.code === 1) return ''; if (e.code === 'ENOENT') throw new Error('找不到 Git，请先安装 Git。'); throw new Error('读取 Git 配置失败。'); }
}
function parseStatusText(text) {
  const accounts = []; let current = null;
  for (const line of text.split(/\r?\n/)) {
    const login = line.match(/Logged in to (\S+) account (\S+)/);
    if (login) { current = { host: login[1], login: login[2], active: false, state: 'success' }; if (current.host === HOST) accounts.push(current); continue; }
    const failed = line.match(/Failed to log in to (\S+) account (\S+)/);
    if (failed) { current = { host: failed[1], login: failed[2], active: false, state: 'error' }; if (current.host === HOST) accounts.push(current); continue; }
    if (current && /Active account:\s*true/.test(line)) current.active = true;
  }
  return accounts;
}
async function listAccounts() {
  let accounts;
  try {
    const raw = await gh(['auth', 'status', '--hostname', HOST, '--json', 'hosts'], { failure: '读取 GitHub 账号失败。' });
    accounts = (JSON.parse(raw).hosts?.[HOST] || []).map(a => ({ login: a.login, active: !!a.active, state: a.state || 'success', scopes: a.scopes || '', protocol: a.gitProtocol || '' }));
  } catch (e) {
    if (e.code === 'ENOENT') throw e;
    // Older gh has no --json; the text form goes to stderr and exits 1 when any account fails.
    let text = String(e.stderr || '');
    if (!/Logged in to|Failed to log in/.test(text)) { try { const r = await run('gh', ['auth', 'status', '--hostname', HOST], { timeout: 20000, env: baseEnv() }); text = r.stdout + r.stderr; } catch (inner) { text = String(inner.stdout || '') + String(inner.stderr || ''); } }
    accounts = parseStatusText(text);
  }
  accounts = accounts.filter(a => LOGIN.test(a.login));
  const [pushHelper, helper, name, email] = await Promise.all([gitConfig(['--global', '--get-all', 'credential.https://github.com.helper']), gitConfig(['--global', '--get-all', 'credential.helper']), gitConfig(['--global', 'user.name']), gitConfig(['--global', 'user.email'])]);
  const followsGh = /gh(\.exe)?["']?\s+auth\s+git-credential/.test(pushHelper);
  const generic = helper.split(/\r?\n/).filter(Boolean).pop() || '';
  return {
    host: HOST, accounts, active: accounts.find(a => a.active)?.login || null,
    // Global configuration does not verify any repository's transport or account.
    gitPush: { followsActive: null, globalHttpsUsesGh: followsGh, scope: 'global-https', note: '未核实当前仓库的推送账号；SSH 密钥、仓库级配置、其他凭据工具和环境变量可能改变实际账号。', helper: followsGh ? 'gh' : /manager/.test(generic) ? 'manager' : generic ? 'other' : 'none', label: followsGh ? 'GitHub CLI（全局 HTTPS 配置）' : /manager/.test(generic) ? 'Git Credential Manager' : generic ? '其他凭据工具：' + generic.slice(0, 80) : '未配置凭据工具' },
    identity: { name: name || null, email: email || null }
  };
}
function checkLogin(login) { if (typeof login !== 'string' || !LOGIN.test(login)) throw new Error('请选择有效的 GitHub 账号。'); return login; }
async function switchAccount(login) {
  checkLogin(login);
  const before = await listAccounts();
  if (!before.accounts.some(a => a.login === login)) throw new Error('本机没有登录这个账号，请先添加账号。');
  if (before.active !== login) await gh(['auth', 'switch', '--hostname', HOST, '--user', login], { failure: '切换账号失败，请稍后重试。' });
  const after = await listAccounts();
  if (after.active !== login) throw new Error('切换未生效，请在终端运行 gh auth status 检查。');
  return after;
}
async function setupGit() {
  await gh(['auth', 'setup-git', '--hostname', HOST], { failure: '配置 Git 推送凭据失败，请稍后重试。' });
  return listAccounts();
}
async function tokenFor(login) {
  checkLogin(login);
  const token = (await gh(['auth', 'token', '--hostname', HOST, '--user', login], { timeout: 15000, failure: '读取账号凭据失败，请重新添加账号。' })).trim();
  if (!token) throw new Error('这个账号没有可用凭据，请重新添加账号。');
  return token;
}
async function setIdentity(login) {
  const token = await tokenFor(login);
  const user = JSON.parse(await gh(['api', 'user'], { env: { ...baseEnv(), GH_TOKEN: token }, failure: '读取账号资料失败。' }));
  if (!Number.isInteger(user.id) || user.login !== login) throw new Error('账号资料不一致，未修改提交作者。');
  const email = user.id + '+' + user.login + '@users.noreply.github.com';
  for (const [key, value] of [['user.name', user.login], ['user.email', email]]) {
    try { await run('git', ['config', '--global', key, value], { timeout: 10000, env: baseEnv() }); }
    catch { throw new Error('写入全局 Git 提交作者失败。'); }
  }
  return listAccounts();
}
async function cloudRepos(login) {
  const token = await tokenFor(login);
  const jq = '.[] | {f: .full_name, n: .name, o: .owner.login, p: .private, d: (.description // ""), u: .html_url, t: (.pushed_at // .updated_at), k: .fork, a: .archived, b: .default_branch}';
  const raw = await gh(['api', '--paginate', '--jq', jq, 'user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member'], { env: { ...baseEnv(), GH_TOKEN: token }, timeout: 90000, maxBuffer: 24 * 1024 * 1024, failure: '读取云端仓库失败，请稍后重试。' });
  const repos = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (typeof r.f !== 'string' || !FULL_NAME.test(r.f)) continue;
      repos.push({ fullName: r.f, name: r.n, owner: r.o, private: !!r.p, description: String(r.d || '').slice(0, 300), url: r.u, pushedAt: r.t, fork: !!r.k, archived: !!r.a, defaultBranch: r.b, identity: (HOST + '/' + r.f).toLowerCase() });
    } catch {}
    if (repos.length >= 5000) break;
  }
  return { login, repos, fetchedAt: new Date().toISOString(), truncated: repos.length >= 5000 };
}
async function clone(params, notify = () => {}) {
  const { login, fullName, parent } = params;
  if (typeof fullName !== 'string' || !FULL_NAME.test(fullName)) throw new Error('仓库名称无效。');
  if (typeof parent !== 'string' || !path.isAbsolute(parent)) throw new Error('请选择本机文件夹。');
  const base = await fs.realpath(parent);
  if (!(await fs.stat(base)).isDirectory()) throw new Error('请选择本机文件夹。');
  const target = path.join(base, fullName.split('/')[1]);
  try { const entries = await fs.readdir(target); if (entries.length) throw Object.assign(new Error('目标文件夹已存在且不为空：' + target + '。请换一个位置。'), { exists: true }); }
  catch (e) { if (e.exists) throw e; if (e.code !== 'ENOENT') throw new Error('无法检查目标文件夹：' + target); }
  const token = await tokenFor(login);
  notify({ phase: 'connecting', fullName });
  const heartbeat = setInterval(() => notify({ phase: 'waiting', fullName }), 10000); let last = 0;
  try {
    await run('gh', ['repo', 'clone', fullName, target, '--', '--progress'], { timeout: 840000, env: { ...baseEnv(), GH_TOKEN: token, LC_ALL: 'C' }, onStderr: progressReader(p => { if (Date.now() - last < 500 && p.percent !== 100) return; last = Date.now(); notify({ ...p, fullName }); }) });
  } catch (e) {
    throw new Error(e.code === 'ENOENT' ? ghError(e) : e.killed ? '克隆超过 14 分钟，已停止；请检查网络后重试。' : /not found|could not read|403|401/i.test(String(e.stderr)) ? '这个账号无权访问该仓库，或仓库已不存在。' : '克隆失败，请检查网络和目标文件夹后重试。');
  } finally { clearInterval(heartbeat); }
  return { dir: slash(target), fullName };
}
let loginChild = null;
async function login(notify = () => {}) {
  if (loginChild) throw new Error('已有一个账号正在登录，请先完成或取消。');
  const { spawn } = require('node:child_process');
  return new Promise((resolve, reject) => {
    const env = baseEnv(); delete env.GH_PROMPT_DISABLED;
    const child = spawn('gh', ['auth', 'login', '--hostname', HOST, '--web', '--git-protocol', 'https'], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    loginChild = child; let output = '', sent = false;
    const heartbeat = setInterval(() => notify({ phase: 'waiting' }), 10000);
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, 840000);
    const read = buf => {
      output = (output + buf.toString('utf8')).slice(-8000);
      const code = output.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i);
      if (code && !sent) { sent = true; notify({ phase: 'code', code: code[1].toUpperCase(), url: 'https://github.com/login/device' }); }
      // Non-TTY gh may still wait for Enter before polling; answer it once.
      if (/Press Enter/i.test(buf.toString('utf8'))) { try { child.stdin.write('\n'); } catch {} }
    };
    child.stdout.on('data', read); child.stderr.on('data', read);
    child.on('error', e => { clearInterval(heartbeat); clearTimeout(timer); loginChild = null; reject(new Error(ghError(e))); });
    child.on('close', async code => {
      clearInterval(heartbeat); clearTimeout(timer); const cancelled = child.cancelled; loginChild = null;
      if (cancelled) { reject(new Error('已取消添加账号。')); return; }
      if (code !== 0) { reject(new Error(/expired/i.test(output) ? '授权码已过期，请重新添加账号。' : '添加账号未完成，请重试。')); return; }
      try { resolve(await listAccounts()); } catch (e) { reject(e); }
    });
  });
}
function cancelLogin() { if (!loginChild) return { cancelled: false }; loginChild.cancelled = true; try { loginChild.kill(); } catch {} return { cancelled: true }; }
const SKIP = new Set(['node_modules', '.git', '.svn', '.hg', 'dist', 'build', 'out', 'target', 'bin', 'obj', 'Library', 'Temp', '$RECYCLE.BIN', 'System Volume Information']);
function remotesFromConfig(text) {
  const ids = [];
  for (const m of text.matchAll(/^\s*url\s*=\s*(.+?)\s*$/gm)) {
    let raw = m[1].replace(/^"|"$/g, '');
    try { if (/^[^/@:]+@[^/:]+:/.test(raw)) raw = 'ssh://' + raw.replace(':', '/'); const u = new URL(raw); ids.push((u.hostname + u.pathname.replace(/\/$/, '').replace(/\.git$/, '')).toLowerCase()); } catch {}
  }
  return [...new Set(ids)];
}
// Git reports Windows roots with forward slashes; keep scan results comparable with snapshots.
const slash = value => process.platform === 'win32' ? value.split(path.sep).join('/') : value;
// Find local clones below a folder without running Git for every directory.
async function scan(root, depth = 4) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('请选择本机文件夹。');
  const start = await fs.realpath(root), found = [], deadline = Date.now() + 20000; let visited = 0;
  async function walk(dir, level) {
    if (found.length >= 400 || visited > 20000 || Date.now() > deadline) return;
    visited++;
    let entries; try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    const git = entries.find(e => e.name === '.git');
    if (git) {
      let ids = [];
      if (git.isDirectory()) { try { ids = remotesFromConfig(await fs.readFile(path.join(dir, '.git', 'config'), 'utf8')); } catch {} }
      found.push({ dir: slash(dir), ids }); return;
    }
    if (level >= depth) return;
    for (const e of entries) if (e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name)) await walk(path.join(dir, e.name), level + 1);
  }
  await walk(start, 0);
  return { root: slash(start), repos: found, truncated: found.length >= 400 || visited > 20000 || Date.now() > deadline };
}
module.exports = { listAccounts, switchAccount, setupGit, setIdentity, cloudRepos, clone, login, cancelLogin, scan, parseStatusText, remotesFromConfig };
