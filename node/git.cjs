'use strict';
const { runCommand: run } = require('./command.cjs');
const { StringDecoder } = require('node:string_decoder');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const hash = value => createHash('sha256').update(value).digest('hex');
async function git(dir, args, options = {}) {
  try {
    const { stdout } = await run('git', ['--no-pager', '-c', 'core.quotepath=false', '-c', 'core.fsmonitor=false', '-C', dir, ...args], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 15000,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }, ...options
    });
    return stdout;
  } catch (e) {
    const error = new Error(gitError(e, args.includes('fetch')));
    error.code = e.code;
    throw error;
  }
}
async function optional(dir, args) { try { return (await git(dir, args)).trim(); } catch (e) { if (e.code === 1 || e.code === 128) return null; throw e; } }
async function root(dir) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('请选择本机仓库文件夹。');
  const base = await fs.realpath(dir);
  return (await git(base, ['rev-parse', '--show-toplevel'])).trim();
}
function canonicalRemote(raw) {
  try {
    if (/^[^/@:]+@[^/:]+:/.test(raw)) raw = 'ssh://' + raw.replace(':', '/');
    const u = new URL(raw);
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(u.protocol)) return null;
    return u.hostname.toLowerCase() + (u.port ? ':' + u.port : '') + u.pathname.replace(/\/$/, '').replace(/\.git$/, '');
  } catch { return null; }
}
function displayRemote(raw) {
  try { const u = new URL(raw); u.username = ''; u.password = ''; u.search = ''; u.hash = ''; return u.toString(); }
  catch { return raw.replace(/^[^@]+@/, '').slice(0, 400); }
}
function parseStatus(raw) {
  const parts = raw.split('\0'); const files = [];
  for (let i = 0; i < parts.length; i++) {
    const row = parts[i]; if (!row) continue;
    const type = row[0]; if (type === '#' || type === '!') continue;
    const fields = row.split(' ');
    if (type === '?') files.push({ status: '??', path: row.slice(2), untracked: true, conflict: false });
    else if (type === '1' || type === '2' || type === 'u') {
      const offset = type === '1' ? 8 : type === '2' ? 9 : 10;
      files.push({ status: fields[1], path: fields.slice(offset).join(' '), ...(type === '2' ? { from: parts[++i] } : {}), untracked: false, conflict: type === 'u' });
    }
  }
  return { count: files.length, conflicts: files.filter(f => f.conflict).length, staged: files.filter(f => !f.untracked && f.status[0] !== '.').length, untracked: files.filter(f => f.untracked).length, files: files.slice(0, 300), truncated: files.length > 300 };
}
async function resolve(dir, ref) {
  if (typeof ref !== 'string' || !ref || ref.length > 1024) throw new Error('请选择有效分支或提交。');
  return (await git(dir, ['rev-parse', '--verify', '--end-of-options', ref + '^{commit}'])).trim();
}
async function snapshot(input, attempt = 0) {
  const dir = await root(input);
  const startHead = await optional(dir, ['rev-parse', '--verify', 'HEAD']);
  const branch = await optional(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const [statusText, refText, remoteNames, worktreeText, userName] = await Promise.all([
    git(dir, ['status', '--porcelain=v2', '-z', '--untracked-files=normal']),
    git(dir, ['for-each-ref', '--sort=-committerdate', '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(symref)%00%(authorname)%00%(committerdate:iso-strict)%00%(subject)', 'refs/heads', 'refs/remotes']),
    git(dir, ['remote']), git(dir, ['worktree', 'list', '--porcelain', '-z']), optional(dir, ['config', 'user.name'])
  ]);
  const refs = refText.trim().split('\n').filter(Boolean).map(line => {
    const [full, sha, upstream, symref, author, date, subject] = line.split('\0');
    return { full, sha, name: full.replace(/^refs\/(heads|remotes)\//, ''), remote: full.startsWith('refs/remotes/'), upstream, symref, author, date, subject };
  }).filter(r => !r.symref);
  const remotes = await Promise.all(remoteNames.trim().split('\n').filter(Boolean).map(async name => {
    const url = (await git(dir, ['remote', 'get-url', name])).trim();
    return { name, url: displayRemote(url), identity: canonicalRemote(url) };
  }));
  const readLog = async revisions => {
    const log = await git(dir, ['log', ...revisions, '--topo-order', '-n', '180', '-z', '--format=%H%x00%P%x00%an%x00%aI%x00%s']);
    const fields = log.split('\0'), rows = [];
    for (let i = 0; i + 4 < fields.length; i += 5) rows.push({ sha: fields[i], parents: fields[i + 1].split(' ').filter(Boolean), author: fields[i + 2], date: fields[i + 3], subject: fields[i + 4] });
    return rows;
  };
  // Read HEAD history separately: filtering the global 180 rows would lose older current-branch commits.
  const [commits, currentCommits] = await Promise.all([
    startHead || refs.length ? readLog(['--all', ...(startHead ? [startHead] : [])]) : [],
    startHead ? readLog([startHead]) : []
  ]);
  const current = refs.find(r => r.full === 'refs/heads/' + branch);
  const upstreamSha = current?.upstream ? await optional(dir, ['rev-parse', '--verify', '--end-of-options', current.upstream + '^{commit}']) : null;
  let ahead = null, behind = null;
  if (startHead && upstreamSha) {
    [ahead, behind] = (await git(dir, ['rev-list', '--left-right', '--count', startHead + '...' + upstreamSha])).trim().split(/\s+/).map(Number);
  }
  const worktrees = []; let wt = {};
  for (const line of worktreeText.split('\0')) {
    if (!line) { if (wt.path) worktrees.push(wt); wt = {}; }
    else if (line.startsWith('worktree ')) wt.path = line.slice(9);
    else if (line.startsWith('HEAD ')) wt.sha = line.slice(5);
    else if (line.startsWith('branch ')) wt.branch = line.slice(7).replace('refs/heads/', '');
    else if (line === 'detached') wt.detached = true;
  }
  let fetchedAt = null;
  try { const p = (await git(dir, ['rev-parse', '--git-path', 'FETCH_HEAD'])).trim(); fetchedAt = (await fs.stat(path.resolve(dir, p))).mtime.toISOString(); } catch {}
  const endHead = await optional(dir, ['rev-parse', '--verify', 'HEAD']);
  const endBranch = await optional(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if ((startHead !== endHead || branch !== endBranch) && attempt < 1) return snapshot(dir, attempt + 1);
  return { dir, name: path.basename(dir), branch, head: startHead, detached: !!startHead && !branch, unborn: !startHead, userName, status: parseStatus(statusText), refs, commits, currentCommits, currentTruncated: currentCommits.length === 180, remotes, worktrees, upstream: current?.upstream || null, upstreamExists: !!upstreamSha, ahead, behind, fetchedAt, sampledAt: new Date().toISOString(), unstable: startHead !== endHead || branch !== endBranch, truncated: commits.length === 180 };
}
async function detail(input, ref) {
  const dir = await root(input); const sha = await resolve(dir, ref);
  const output = await git(dir, ['show', '--format=fuller', '--stat', '--patch', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', sha, '--'], { maxBuffer: 16 * 1024 * 1024 });
  return { sha, patch: output.slice(0, 180000), truncated: output.length > 180000 };
}
async function compare(input, target) {
  const dir = await root(input);
  const [head, other, state] = await Promise.all([resolve(dir, 'HEAD'), resolve(dir, target), git(dir, ['status', '--porcelain=v2', '-z'])]);
  const counts = (await git(dir, ['rev-list', '--left-right', '--count', head + '...' + other])).trim().split(/\s+/).map(Number);
  const base = await optional(dir, ['merge-base', head, other]);
  const diff = await git(dir, ['diff', '--stat', '--no-ext-diff', '--no-textconv', head, other, '--']);
  const dirty = parseStatus(state);
  return { head, target, targetSha: other, ahead: counts[0], behind: counts[1], base, dirty: dirty.count, relation: !base ? 'unrelated' : head === other ? 'equal' : base === head ? 'fast-forward' : base === other ? 'contains' : 'diverged', diff: diff.slice(0, 40000), note: '这是提交关系预览；未执行切换或合并，也未判定文本冲突。' };
}
function gitError(e, network = false) {
  const stderr = String(e.stderr || '');
  if (e.code === 'ENOENT') return '找不到 Git，请先安装 Git 后重新连接仓库。';
  if (e.killed) return network ? '远端获取超过 14 分钟，已停止本次下载；请检查网络后重试。' : '本地仓库读取超时，请稍后刷新。';
  if (!network) return 'Git 操作失败，请确认仓库路径和分支是否仍存在。';
  if (/authentication failed|permission denied|could not read Username|terminal prompts disabled|HTTP.*\b(?:401|403)\b/i.test(stderr)) return '远端访问未获授权，请先在终端登录 Git 或检查仓库权限，再点击立即更新。';
  if (/repository not found|does not appear to be a git repository/i.test(stderr)) return '远端仓库不存在或当前账号无权访问，请检查远端地址和账号权限。';
  if (/could not resolve|couldn't resolve|name or service not known/i.test(stderr)) return '无法解析远端地址，请检查网络或代理后重试。';
  if (/certificate|SSL.*(?:error|problem)/i.test(stderr)) return '远端安全连接失败，请检查系统证书或代理设置后重试。';
  if (/timed out|timeout|operation too slow/i.test(stderr)) return '远端连接超时或下载长时间无响应，已停止本次获取；请检查网络或代理后重试。';
  if (/failed to connect|connection refused|connection reset|unable to access|remote end hung up|unexpected disconnect|early EOF/i.test(stderr)) return '远端连接中断，请检查网络或代理后重试。';
  return '远端获取失败，请检查网络、远端地址和账号权限后重试。';
}
function progressReader(notify) {
  const decoder = new StringDecoder('utf8'); let pending = '';
  const phases = { Counting: 'counting', Compressing: 'compressing', Receiving: 'receiving', Resolving: 'resolving' };
  return buf => {
    pending += decoder.write(buf);
    const lines = pending.split(/[\r\n]/); pending = lines.pop().slice(-2048);
    for (const line of lines) {
      const match = line.match(/(Counting|Compressing|Receiving|Resolving) (?:objects|deltas):\s*(\d+)%/);
      if (!match) continue;
      const size = line.match(/,\s*([\d.]+) (KiB|MiB|GiB)\s*\|/);
      notify({ phase: phases[match[1]], percent: Math.min(100, Number(match[2])), ...(size ? { bytes: Math.round(Number(size[1]) * { KiB: 1024, MiB: 1048576, GiB: 1073741824 }[size[2]]) } : {}) });
    }
  };
}
const fetches = new Map();
async function fetchRemote(input, remote, notify = () => {}) {
  const dir = await root(input); const names = (await git(dir, ['remote'])).trim().split('\n');
  if (typeof remote !== 'string' || !names.includes(remote) || remote.startsWith('-')) throw new Error('请选择仓库中已有的远端。');
  const key = JSON.stringify([dir, remote]);
  let task = fetches.get(key);
  if (!task) {
    task = { listeners: new Set(), latest: { dir, remote, phase: 'connecting' }, lastSent: 0 };
    fetches.set(key, task);
    const publish = (value, force = false) => {
      task.latest = { dir, remote, ...value };
      if (!force && Date.now() - task.lastSent < 1000) return;
      task.lastSent = Date.now(); for (const listener of task.listeners) listener(task.latest);
    };
    task.promise = (async () => {
      const heartbeat = setInterval(() => publish(task.latest, true), 10000);
      try {
        const ssh = await optional(dir, ['config', '--get', 'core.sshCommand']);
        const env = { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', LC_ALL: 'C' };
        if (!ssh && !env.GIT_SSH_COMMAND && !env.GIT_SSH) env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4';
        await git(dir, ['-c', 'fetch.recurseSubmodules=false', '-c', 'http.lowSpeedLimit=1024', '-c', 'http.lowSpeedTime=60', 'fetch', '--no-tags', '--no-auto-maintenance', '--progress', '--', remote], { timeout: 840000, env, onStderr: progressReader(publish) });
        const fetchCompletedAt = new Date().toISOString();
        publish({ phase: 'reading' }, true);
        try { return { ...await snapshot(dir), fetchCompletedAt, fetchedRemote: remote }; }
        catch (e) { throw new Error('远端记录已获取，但本地视图未能刷新。' + e.message); }
      } finally { clearInterval(heartbeat); fetches.delete(key); }
    })();
  }
  task.listeners.add(notify); notify(task.latest);
  try { return await task.promise; } finally { task.listeners.delete(notify); }
}
module.exports = { git, root, snapshot, detail, compare, fetchRemote, parseStatus, canonicalRemote, hash, gitError, progressReader };
