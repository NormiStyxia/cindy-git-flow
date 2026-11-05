'use strict';
// 仓库切换大弹窗与 GitHub 账号管理。与 panel.js 共用全局状态（dir、config、connect、rpc）。
let accounts = null, accountsError = '', accountBusy = false, accountNotice = '', loginState = null;
let repoScope = 'all', cloudLogin = null, localData = null, localError = '', localLoading = false, cloneState = null;
const cloudData = new Map(), cloudErrors = new Map(), cloudLoading = new Set();
const RENDER_LIMIT = 300;
const baseName = p => String(p).split(/[\\/]/).filter(Boolean).pop() || p;
const avatarLetter = login => login ? login.slice(0, 1).toUpperCase() : '';
const usableAccounts = () => (accounts?.accounts || []).filter(a => a.state !== 'error');

function overlayOpen() { return !$('#repo-dialog').hidden || !$('#account-dialog').hidden; }
function showOverlay(id, open) {
  GitChoices.close(); showPreferences(false);
  const dialog = $('#' + id), trigger = id === 'repo-dialog' ? $('#repo-select') : $('#account-toggle');
  if (open) { for (const other of ['repo-dialog', 'account-dialog']) if (other !== id && !$('#' + other).hidden) showOverlay(other, false); }
  dialog.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
  if (!open && !overlayOpen() && trigger.isConnected && !trigger.closest('[inert]')) trigger.focus({ preventScroll: true });
}

// ---------- 账号 ----------
function renderAccountButton() {
  const active = accounts?.active, button = $('#account-toggle');
  button.querySelector('.avatar-mini').innerHTML = active ? escapeHtml(avatarLetter(active)) : icon('user');
  button.classList.toggle('signed-in', !!active);
  const label = accountsError ? 'GitHub 账号读取失败 · 点击查看' : active ? 'GitHub 当前账号：' + active + ' · 点击管理或切换' : accounts ? '尚未登录 GitHub 账号 · 点击添加' : 'GitHub 账号';
  button.title = label; button.setAttribute('aria-label', label);
}
async function loadAccounts() {
  try { accounts = await rpc('account/list'); accountsError = ''; }
  catch (e) { accountsError = e.message; }
  renderAccountButton();
  if (!$('#account-dialog').hidden) renderAccounts();
  if (!$('#repo-dialog').hidden) renderCloudAccount();
  return accounts;
}
function renderAccounts() {
  $('#account-error').textContent = accountsError; $('#account-error').hidden = !accountsError;
  $('#account-notice').textContent = accountNotice; $('#account-notice').hidden = !accountNotice;
  const body = $('#account-body');
  if (!accounts) { body.innerHTML = accountsError ? '' : '<p class="empty">正在读取本机 GitHub 账号…</p>'; return; }
  const list = accounts.accounts, push = accounts.gitPush, who = accounts.identity;
  let html = '<div class="section-label">已登录的账号<span>' + list.length + ' 个 · github.com</span></div>';
  if (!list.length) html += '<p class="empty">这台电脑还没有登录 GitHub 账号。</p>';
  for (const a of list) {
    html += '<div class="account-row' + (a.active ? ' active' : '') + '"><span class="avatar">' + escapeHtml(avatarLetter(a.login)) + '</span><div class="account-main"><div class="account-name">' + escapeHtml(a.login) + (a.active ? '<span class="badge good">当前账号</span>' : '') + (a.state === 'error' ? '<span class="badge warn">登录已失效</span>' : '') + '</div><div class="account-meta">' + (a.state === 'error' ? '请重新添加这个账号' : '权限：' + escapeHtml(a.scopes || '未知')) + '</div></div><div class="account-actions">' +
      (a.active || a.state === 'error' ? '' : '<button class="text-button" data-account-switch="' + escapeHtml(a.login) + '"' + (accountBusy ? ' disabled' : '') + '>切换到此账号</button>') +
      (a.state === 'error' ? '' : '<button class="text-button subtle" data-account-identity="' + escapeHtml(a.login) + '" title="把全局 user.name / user.email 设为这个账号的 GitHub 名称与隐私邮箱"' + (accountBusy ? ' disabled' : '') + '>设为提交作者</button>') + '</div></div>';
  }
  html += '<div class="section-label">Git 推送凭据配置<span>全局 · HTTPS</span></div><div class="account-card">';
  if (push.globalHttpsUsesGh) html += '<p><b class="good-text">✓ 全局 HTTPS 已配置 GitHub CLI</b></p><p class="small">使用这项配置的 github.com HTTPS 仓库会通过 gh 获取凭据。SSH 远端使用 SSH 密钥，不受这里的账号切换影响；仓库级配置、其他凭据工具或环境变量也可能改变实际使用的账号。这里未核实当前仓库的推送账号。</p>';
  else html += '<p>全局凭据配置：<b>' + escapeHtml(push.label) + '</b>。</p><p class="small">切换账号不会修改 SSH 密钥或其他凭据工具。点击下方按钮会运行 <span class="mono">gh auth setup-git</span>，将 github.com 的全局 HTTPS 凭据配置为 GitHub CLI；仓库级配置仍可能覆盖它。这里未核实当前仓库的推送账号。</p><button class="text-button" data-account-action="setup-git"' + (accountBusy ? ' disabled' : '') + '>为 HTTPS 配置 GitHub CLI 凭据</button>';
  html += '</div><div class="section-label">提交作者（全局）<span>写进提交记录</span></div><div class="account-card">' +
    (who.name || who.email ? '<p>' + escapeHtml(who.name || '未设置姓名') + ' <span class="muted mono">&lt;' + escapeHtml(who.email || '未设置邮箱') + '&gt;</span></p>' : '<p>未设置全局提交作者，仓库可能使用各自的本地配置。</p>') +
    '<p class="small">提交作者只是名字和邮箱，与推送使用哪个账号无关；仓库内的本地配置会优先于这里。</p></div>';
  html += '<div class="section-label">添加账号</div><div class="account-card">';
  if (loginState?.code) html += '<p>在浏览器中确认登录的是要添加的账号，然后输入授权码：</p><div class="device-code mono" aria-label="授权码">' + escapeHtml(loginState.code) + '</div><p><a class="text-button" href="' + escapeHtml(loginState.url) + '">打开 GitHub 授权页 ↗</a></p><p class="small">授权完成后这里会自动刷新；已登录的账号会保留。</p><button class="text-button subtle" data-account-action="login-cancel">取消添加</button>';
  else if (loginState) html += '<p>正在向 GitHub 申请授权码…</p><button class="text-button subtle" data-account-action="login-cancel">取消添加</button>';
  else html += '<p class="small">通过浏览器授权添加另一个 GitHub 账号，多个账号可以同时保留。</p><button class="text-button" data-account-action="login"' + (accountBusy ? ' disabled' : '') + '>添加 GitHub 账号</button>';
  body.innerHTML = html + '</div>';
}
async function accountAction(run, notice) {
  if (accountBusy) return;
  accountBusy = true; accountsError = ''; accountNotice = ''; renderAccounts();
  try { accounts = await run(); accountNotice = typeof notice === 'function' ? notice(accounts) : notice; }
  catch (e) { accountsError = e.message; }
  finally { accountBusy = false; renderAccountButton(); renderAccounts(); }
}
async function addAccount() {
  if (loginState) return;
  loginState = { phase: 'starting' }; accountsError = ''; accountNotice = ''; renderAccounts();
  try {
    const before = new Set((accounts?.accounts || []).map(a => a.login));
    accounts = await rpc('account/login');
    const added = accounts.accounts.find(a => !before.has(a.login));
    accountNotice = added ? '已添加账号 ' + added.login + '，并设为当前账号。' : '授权完成，账号列表已刷新。';
    cloudLogin = accounts.active;
  } catch (e) { if (!/已取消/.test(e.message)) accountsError = e.message; }
  finally { loginState = null; renderAccountButton(); renderAccounts(); }
}
function openAccounts() { accountNotice = ''; showOverlay('account-dialog', true); renderAccounts(); loadAccounts(); $('#close-account-dialog').focus({ preventScroll: true }); }
$('#account-toggle').onclick = () => $('#account-dialog').hidden ? openAccounts() : showOverlay('account-dialog', false);
$('#close-account-dialog').onclick = () => showOverlay('account-dialog', false);
$('#account-refresh').onclick = () => { accountNotice = ''; loadAccounts(); };
$('#account-body').onclick = event => {
  const switchTo = event.target.closest('[data-account-switch]')?.dataset.accountSwitch;
  if (switchTo) return accountAction(() => rpc('account/switch', { login: switchTo }), 'GitHub CLI 已切换到 ' + switchTo + '。实际推送账号取决于仓库的连接方式和凭据配置，详见下方说明。');
  const identity = event.target.closest('[data-account-identity]')?.dataset.accountIdentity;
  if (identity) return accountAction(() => rpc('account/identity', { login: identity }), '全局提交作者已设为 ' + identity + '（GitHub 隐私邮箱）。');
  const action = event.target.closest('[data-account-action]')?.dataset.accountAction;
  if (action === 'setup-git') return accountAction(() => rpc('account/setup-git'), '已为 github.com 配置全局 HTTPS 凭据；SSH 和仓库级覆盖配置仍可能使用其他账号。');
  if (action === 'login') return addAccount();
  if (action === 'login-cancel') rpc('account/login-cancel').catch(e => { accountsError = e.message; renderAccounts(); });
};

// ---------- 仓库弹窗 ----------
function cloudLogins() { return cloudLogin === '*' ? usableAccounts().map(a => a.login) : cloudLogin ? [cloudLogin] : []; }
function renderCloudAccount() {
  const list = usableAccounts();
  if (!cloudLogin || (cloudLogin !== '*' && !list.some(a => a.login === cloudLogin))) cloudLogin = accounts?.active || list[0]?.login || null;
  $('#cloud-account').dataset.empty = accounts ? '未登录' : '读取中';
  GitChoices.set($('#cloud-account'), [...list.map(a => ({ value: a.login, label: a.login, detail: a.active ? '当前账号' : '已登录' })), ...(list.length > 1 ? [{ value: '*', label: '全部账号', detail: '合并显示所有已登录账号的仓库' }] : [])], cloudLogin || '');
  $('#cloud-account').disabled = !list.length;
  $('#cloud-refresh').disabled = !list.length || cloudLogins().some(login => cloudLoading.has(login));
  const logins = cloudLogins(), loading = logins.filter(l => cloudLoading.has(l)), loaded = logins.map(l => cloudData.get(l)).filter(Boolean);
  $('#cloud-status').textContent = !list.length ? (accounts ? '在账号管理中添加 GitHub 账号后显示云端仓库' : '') : loading.length ? '正在读取云端仓库…' : loaded.length ? loaded.reduce((n, d) => n + d.repos.length, 0) + ' 个 · ' + age(loaded.map(d => d.fetchedAt).sort()[0]) + '读取' : '';
}
async function loadCloud(refresh = false) {
  const logins = cloudLogins().filter(l => !cloudLoading.has(l) && (refresh || !cloudData.has(l)));
  if (!logins.length) { renderRepos(); return; }
  await Promise.all(logins.map(async login => {
    cloudLoading.add(login); cloudErrors.delete(login); renderCloudAccount(); renderRepos();
    try { cloudData.set(login, await rpc('cloud/list', { login, refresh })); }
    catch (e) { cloudErrors.set(login, e.message); }
    finally { cloudLoading.delete(login); }
  }));
  renderCloudAccount(); renderRepos();
}
async function loadLocal(refresh = false) {
  localLoading = true; renderRepos();
  try { localData = await rpc('local/list', { refresh }); localError = ''; }
  catch (e) { localError = e.message; }
  finally { localLoading = false; renderRepos(); }
}
function localEntries() {
  const entries = new Map();
  const add = (path, extra) => { const key = path; entries.set(key, { dir: path, ids: [], recent: false, ...entries.get(key), ...extra }); };
  for (const p of config.repositories || []) add(p, { recent: true, ids: config.repoRemotes?.[p] || [] });
  for (const r of localData?.repos || []) add(r.dir, { ids: [...new Set([...(entries.get(r.dir)?.ids || []), ...r.ids])], recent: r.recent || entries.get(r.dir)?.recent || false });
  if (dir) add(dir, { ids: [...new Set([...(entries.get(dir)?.ids || []), ...(state?.remotes || []).map(r => (r.identity || '').toLowerCase()).filter(Boolean)])] });
  return [...entries.values()];
}
function cloudEntries() {
  const merged = new Map();
  for (const login of cloudLogins()) for (const repo of cloudData.get(login)?.repos || []) {
    const entry = merged.get(repo.fullName) || { ...repo, logins: [] };
    entry.logins.push(login); merged.set(repo.fullName, entry);
  }
  return [...merged.values()].sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
}
function matches(tokens, ...fields) { const text = fields.join(' ').toLowerCase(); return tokens.every(t => text.includes(t)); }
function badge(text, kind = '') { return '<span class="badge ' + kind + '">' + escapeHtml(text) + '</span>'; }
function renderRepos() {
  if ($('#repo-dialog').hidden) return;
  const tokens = $('#repo-search').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  for (const b of document.querySelectorAll('[data-repo-scope]')) b.setAttribute('aria-selected', String(b.dataset.repoScope === repoScope));
  $('.cloud-row').hidden = repoScope === 'local';
  const locals = localEntries(), clouds = cloudEntries();
  const localByIdentity = new Map();
  for (const l of locals) for (const id of l.ids) if (!localByIdentity.has(id)) localByIdentity.set(id, l);
  const cloudByIdentity = new Map(clouds.map(c => [c.identity, c]));
  const recentOrder = config.repositories || [];
  const rank = l => l.dir === dir ? -1 : l.recent ? recentOrder.findIndex(p => p === l.dir) : 1000;
  const localShown = repoScope === 'cloud' ? [] : locals.map(l => ({ ...l, cloud: l.ids.map(id => cloudByIdentity.get(id)).find(Boolean), remote: l.ids.find(id => id.startsWith('github.com/')) || l.ids[0] }))
    .filter(l => matches(tokens, baseName(l.dir), l.dir, l.remote || '', l.cloud?.description || ''))
    .sort((a, b) => rank(a) - rank(b) || baseName(a.dir).localeCompare(baseName(b.dir)));
  const cloudShown = repoScope === 'local' ? [] : clouds.map(c => ({ ...c, local: localByIdentity.get(c.identity) }))
    .filter(c => (repoScope === 'cloud' || !c.local) && matches(tokens, c.fullName, c.description, c.logins.join(' ')));
  let html = '';
  if (repoScope !== 'cloud') {
    html += '<div class="section-label">本机仓库<span>' + localShown.length + (localLoading ? ' · 正在扫描…' : '') + '</span></div>';
    if (localError) html += '<div class="notice error">' + escapeHtml(localError) + '</div>';
    for (const f of localData?.failures || []) html += '<div class="notice error">' + escapeHtml(f.root + '：' + f.message) + '</div>';
    if (!localShown.length) html += '<p class="empty">' + (tokens.length ? '没有匹配的本机仓库。' : '还没有本机仓库记录。可以打开文件夹，或扫描存放项目的文件夹。') + '</p>';
    for (const l of localShown.slice(0, RENDER_LIMIT)) {
      html += '<div class="repo-row' + (l.dir === dir ? ' current' : '') + '"><button class="repo-main" data-open-dir="' + escapeHtml(l.dir) + '" title="打开 ' + escapeHtml(l.dir) + '"><span class="repo-name"><b>' + escapeHtml(baseName(l.dir)) + '</b>' + (l.dir === dir ? badge('当前', 'good') : '') + (l.cloud?.private ? badge('私有') : '') + '</span><span class="repo-line">' + escapeHtml(l.dir) + '</span>' + (l.remote ? '<span class="repo-line faint">' + icon('cloud') + escapeHtml(l.cloud?.fullName || l.remote) + '</span>' : '') + '</button></div>';
    }
    if (localShown.length > RENDER_LIMIT) html += '<p class="empty">还有 ' + (localShown.length - RENDER_LIMIT) + ' 个，继续输入以缩小范围。</p>';
  }
  if (repoScope !== 'local') {
    const logins = cloudLogins(), loading = logins.some(l => cloudLoading.has(l));
    html += '<div class="section-label">云端仓库' + (repoScope === 'all' ? '（未在本机）' : '') + '<span>' + cloudShown.length + (loading ? ' · 读取中…' : '') + '</span></div>';
    for (const login of logins) if (cloudErrors.has(login)) html += '<div class="notice error">' + escapeHtml(login + '：' + cloudErrors.get(login)) + '</div>';
    if (!logins.length) html += '<p class="empty">' + (accounts ? '还没有登录 GitHub 账号。<br><button class="text-button" data-repo-action="accounts">添加账号</button>' : accountsError ? escapeHtml(accountsError) : '正在读取 GitHub 账号…') + '</p>';
    else if (!cloudShown.length && !loading) html += '<p class="empty">' + (tokens.length ? '没有匹配的云端仓库。' : '这个账号的云端仓库都已在本机。') + '</p>';
    for (const c of cloudShown.slice(0, RENDER_LIMIT)) {
      const cloning = cloneState?.fullName === c.fullName;
      const progress = cloning ? ({ connecting: '连接中', waiting: '克隆中', counting: '检查记录', compressing: '远端准备', receiving: '下载', resolving: '整理记录' }[cloneState.phase] || '克隆中') + (Number.isFinite(cloneState.percent) ? ' ' + cloneState.percent + '%' : '…') : '';
      const meta = [c.pushedAt ? '更新于 ' + age(c.pushedAt) : '', cloudLogin === '*' ? '账号 ' + c.logins.join('、') : ''].filter(Boolean).join(' · ');
      html += '<div class="repo-row"><button class="repo-main" ' + (c.local ? 'data-open-dir="' + escapeHtml(c.local.dir) + '" title="打开本机克隆 ' + escapeHtml(c.local.dir) + '"' : 'data-clone="' + escapeHtml(c.fullName) + '" title="克隆到本机后打开"') + (cloneState ? ' disabled' : '') + '><span class="repo-name"><b>' + escapeHtml(c.name) + '</b><span class="muted">' + escapeHtml(c.owner) + '</span>' + (c.private ? badge('私有') : '') + (c.fork ? badge('派生') : '') + (c.archived ? badge('已归档', 'warn') : '') + '</span>' + (c.description ? '<span class="repo-line">' + escapeHtml(c.description) + '</span>' : '') + '<span class="repo-line faint">' + (c.local ? '本机：' + escapeHtml(c.local.dir) : escapeHtml(meta)) + '</span></button><span class="repo-action">' + (cloning ? '<span class="cloning" role="status">' + escapeHtml(progress) + '</span>' : c.local ? '<span class="muted">已在本机</span>' : '<button class="text-button" data-clone="' + escapeHtml(c.fullName) + '"' + (cloneState ? ' disabled' : '') + '>克隆</button>') + '</span></div>';
    }
    if (cloudShown.length > RENDER_LIMIT) html += '<p class="empty">还有 ' + (cloudShown.length - RENDER_LIMIT) + ' 个，继续输入以缩小范围。</p>';
  }
  const roots = localData?.roots || [];
  if (repoScope !== 'cloud' && roots.length) html += '<div class="scan-roots"><span>已扫描：</span>' + roots.map(r => '<span class="scan-root" title="' + escapeHtml(r) + '">' + escapeHtml(r) + '<button class="icon-button" data-remove-root="' + escapeHtml(r) + '" title="不再扫描这个文件夹" aria-label="不再扫描 ' + escapeHtml(r) + '">' + icon('close') + '</button></span>').join('') + '</div>';
  const list = $('#repo-list'), top = list.scrollTop;
  list.innerHTML = html; list.scrollTop = top;
  $('#repo-dialog-count').textContent = (localShown.length + cloudShown.length) + ' 个';
  $('#repo-scan').disabled = localLoading;
}
function repoError(message) { $('#repo-dialog-error').textContent = message || ''; $('#repo-dialog-error').hidden = !message; }
function openRepos() {
  repoError(''); showOverlay('repo-dialog', true);
  $('#repo-search').value = ''; $('#repo-list').scrollTop = 0;
  renderCloudAccount(); renderRepos();
  $('#repo-search').focus({ preventScroll: true });
  loadLocal();
  (accounts ? Promise.resolve(accounts) : loadAccounts()).then(() => { renderCloudAccount(); loadCloud(); });
}
async function cloneRepo(fullName) {
  if (cloneState) return;
  const repo = cloudEntries().find(c => c.fullName === fullName); if (!repo) return;
  const login = repo.logins.includes(accounts?.active) ? accounts.active : repo.logins[0];
  cloneState = { fullName, phase: 'connecting' }; repoError(''); renderRepos();
  try {
    const result = await rpc('cloud/clone', { login, fullName });
    if (result) { showOverlay('repo-dialog', false); await connect(result.dir); }
  } catch (e) { repoError(e.message); }
  finally { cloneState = null; if (!$('#repo-dialog').hidden) { loadLocal(); renderRepos(); } }
}
$('#repo-select').onclick = () => $('#repo-dialog').hidden ? openRepos() : showOverlay('repo-dialog', false);
$('#repo-select').addEventListener('keydown', event => { if (event.key === 'ArrowDown') { event.preventDefault(); openRepos(); } });
$('#welcome-browse').onclick = openRepos;
$('#close-repo-dialog').onclick = () => showOverlay('repo-dialog', false);
$('#repo-search').oninput = renderRepos;
$('#repo-search').onkeydown = event => {
  if (event.key === 'Enter') { event.preventDefault(); $('#repo-list .repo-main:not([disabled])')?.click(); }
  if (event.key === 'ArrowDown') { event.preventDefault(); $('#repo-list .repo-main')?.focus(); }
};
$('#repo-list').onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const rows = [...$('#repo-list').querySelectorAll('.repo-main')], i = rows.indexOf(document.activeElement);
  if (i < 0) return;
  event.preventDefault();
  if (event.key === 'ArrowUp' && i === 0) $('#repo-search').focus();
  else rows[Math.max(0, Math.min(rows.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))].focus();
};
document.querySelector('.segmented').onclick = event => {
  const scope = event.target.closest('[data-repo-scope]')?.dataset.repoScope; if (!scope) return;
  repoScope = scope; renderRepos(); if (scope !== 'local') loadCloud();
};
$('#cloud-account').onchange = () => { cloudLogin = $('#cloud-account').value; renderCloudAccount(); loadCloud(); };
$('#cloud-refresh').onclick = () => loadCloud(true);
$('#repo-open-folder').onclick = () => { showOverlay('repo-dialog', false); connect(null, true); };
$('#repo-scan').onclick = async () => {
  localLoading = true; repoError(''); renderRepos();
  try { const result = await rpc('local/scan'); if (result) { localData = result; localError = ''; } }
  catch (e) { repoError(e.message); }
  finally { localLoading = false; renderRepos(); }
};
$('#repo-list').onclick = async event => {
  if (event.target.closest('[data-repo-action="accounts"]')) return openAccounts();
  const remove = event.target.closest('[data-remove-root]')?.dataset.removeRoot;
  if (remove) { try { localData = await rpc('local/remove-root', { root: remove }); } catch (e) { repoError(e.message); } renderRepos(); return; }
  const clone = event.target.closest('[data-clone]')?.dataset.clone;
  if (clone) return cloneRepo(clone);
  const open = event.target.closest('[data-open-dir]')?.dataset.openDir;
  if (open) { showOverlay('repo-dialog', false); if (open !== dir) connect(open); }
};
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !overlayOpen() || GitChoices.isOpen) return;
  event.preventDefault(); event.stopImmediatePropagation();
  showOverlay(!$('#repo-dialog').hidden ? 'repo-dialog' : 'account-dialog', false);
}, true);
GitBridge.on(message => {
  if (message.type === 'auth-progress' && message.phase === 'code' && loginState) { loginState = { code: message.code, url: message.url }; renderAccounts(); }
  if (message.type === 'clone-progress' && cloneState && message.fullName === cloneState.fullName) {
    cloneState = { ...cloneState, phase: message.phase === 'waiting' && cloneState.phase !== 'connecting' ? cloneState.phase : message.phase, ...(Number.isFinite(message.percent) ? { percent: message.percent } : {}) };
    renderRepos();
  }
  if (message.type === 'accounts-changed' && !accountBusy && !loginState) loadAccounts();
  if (message.type === 'config-changed' && !$('#repo-dialog').hidden) renderRepos();
});
loadAccounts();
