'use strict';
const $ = s => document.querySelector(s);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const rpc = GitBridge.request;
let translationBusy = false, translationError = '', activeCommitSubject = '';
// Keep the actual change readable while translation is pending or unavailable.
const subjectLabel = value => GitLabels.subject(value);
const fetchSchedule = new GitFetchSchedule.FetchSchedule(), fetchErrors = new Map(), fetchProgress = new Map(), fetchSuccessAt = new Map();
let autoFetchMinutes = 5, timelineScope = 'all';
const visibleCommits = () => timelineScope === 'current' ? state?.currentCommits || [] : state?.commits || [];
function renderScope() {
  GitChoices.set($('#timeline-scope'), [{ value: 'all', label: '全仓库', detail: '所有分支的最近 180 条提交' }, { value: 'current', label: state?.detached ? '当前提交' : '当前分支', detail: '当前历史的最近 180 条提交，含已经合入的提交' }], timelineScope);
  $('#timeline-scope').hidden = tab !== 'timeline';
  $('#pull-handle .pull-label').textContent = controlsCollapsed ? '展开工具栏' + (timelineScope === 'current' ? ' · ' + (state?.detached ? '当前提交' : '当前分支') : '') : '收起工具栏';
}
function setTimelineScope(value) {
  timelineScope = value === 'current' ? 'current' : 'all';
  selected = null; graphKey = '';
  renderScope(); if (state) render();
  $('#graph-scroll').scrollTop = 0;
}
let config = {}, state = null, dir = null, busy = false, generation = 0, tab = 'timeline', team = null, teamError = '', teamBusy = false, nextTeamAt = 0, teamFailures = 0, graphKey = '', teamEditing = false, teamGeneration = 0, connecting = false;
let activeFocus = null, lastFocusRevision = -1, followingSession = true;
let repositoryLocked = false, lockSaving = false, configReady = false, pendingFocus = null;
let graph = null, selected = null, controlsCollapsed = false, collapseSaving = false;
const short = sha => sha ? sha.slice(0, 7) : '尚无提交';
function age(value) {
  if (!value) return '未知';
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return '未知';
  return seconds < 60 ? '刚刚' : seconds < 3600 ? Math.floor(seconds / 60) + ' 分钟前' : seconds < 86400 ? Math.floor(seconds / 3600) + ' 小时前' : Math.floor(seconds / 86400) + ' 天前';
}
function error(message) { $('#error').textContent = message || ''; $('#error').hidden = !message; renderAttention(); }
function renderAttention() {
  const issue = !$('#error').hidden || !!translationError || !$('#preferences-toggle .sync-dot').hidden;
  $('#pull-handle .attention-dot').hidden = !issue;
  renderScope();
  $('#pull-handle').title = controlsCollapsed ? (issue ? '有更新提示 · 点击或向下拖动查看' : '点击或向下拖动，展开工具栏') : '点击或向上拖动，收起工具栏';
}
function showPreferences(open, restoreFocus = false) {
  GitChoices.close();
  $('#preferences').hidden = !open;
  $('#preferences-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#close-preferences').focus({ preventScroll: true });
  else if (restoreFocus) $('#preferences-toggle').focus({ preventScroll: true });
}
function toggleSearch(open) {
  if (open) switchTab('timeline');
  $('#searchbar').hidden = !open;
  $('#search-toggle').setAttribute('aria-expanded', String(open));
  if (open) $('#search').focus();
  else { $('#search').value = ''; filterGraph(); $('#search-toggle').focus({ preventScroll: true }); }
}
function applyControls(collapsed) {
  if (controlsCollapsed === collapsed) return;
  controlsCollapsed = collapsed;
  GitChoices.close(); showPreferences(false);
  if (collapsed && state && tab !== 'timeline') switchTab('timeline');
  const hadFocus = $('#controls').contains(document.activeElement);
  $('#controls').inert = collapsed;
  $('#controls').setAttribute('aria-hidden', String(collapsed));
  $('#app').classList.toggle('controls-collapsed', collapsed);
  $('#pull-handle').setAttribute('aria-expanded', String(!collapsed));
  $('#pull-handle .pull-label').textContent = collapsed ? '展开工具栏' : '收起工具栏';
  if (hadFocus) $('#pull-handle').focus({ preventScroll: true });
  renderAttention();
}
async function setControlsCollapsed(collapsed) {
  if (!state || collapseSaving || collapsed === controlsCollapsed) return;
  const previous = controlsCollapsed; applyControls(collapsed); collapseSaving = true;
  try { const saved = await rpc('ui/update', { headerCollapsed: collapsed }); config.headerCollapsed = saved.headerCollapsed; }
  catch (e) { applyControls(previous); error(e.message); }
  finally { collapseSaving = false; }
}
function options() {
  GitLabels.loadTranslations(config.translationCache);
  const paths = [...new Set([dir, ...(config.repositories || [])].filter(Boolean))];
  $('#repo-select').dataset.empty = '选择仓库';
  GitChoices.set($('#repo-select'), [...(!dir ? [{ value: '', label: '选择仓库', detail: '自动跟随项目对话，也可手动选择' }] : []), ...paths.map(p => ({ value: p, label: p.split('/').pop(), detail: p }))], dir || '');
  $('#repo-select').title = (repositoryLocked ? '仓库已锁定 · 不随对话切换' : followingSession ? activeFocus ? '跟随当前对话' : '等待对话切换通知' : '已手动选择 · 下次切换对话时恢复跟随') + (dir ? ' · ' + dir : '');
  renderFollow();
  document.body.classList.toggle('no-motion', config.motion === false);
  $('#motion').setAttribute('aria-pressed', String(config.motion !== false));
  $('#motion').title = config.motion === false ? '开启路径流光，方便追踪选中提交的历史' : '关闭路径流光';
  const nextMinutes = GitFetchSchedule.minutes(config.autoFetchMinutes);
  if (nextMinutes !== autoFetchMinutes) fetchSchedule.reconfigure(nextMinutes * 60000);
  autoFetchMinutes = nextMinutes;
  GitChoices.set($('#auto-fetch'), [0, 1, 5, 10].map(n => ({ value: String(n), label: n ? '每 ' + n + ' 分钟' : '仅手动' })), String(autoFetchMinutes));
  applyControls(config.headerCollapsed === true && !!state);
  renderFetchStatus();
}
function untranslatedSubjects() {
  return [...new Set([...visibleCommits(), ...(state?.refs || []), ...(team?.members || []), { subject: activeCommitSubject }].map(c => c.subject).filter(s => s && s.length <= 1500 && GitLabels.needsTranslation(s)))];
}
function renderTranslationStatus() {
  const missing = untranslatedSubjects().length;
  $('#translation-row').hidden = !missing;
  $('#translation-status').textContent = translationError || (translationBusy ? '正在生成中文说明…' : '等待生成中文说明…');
  $('#retry-translation').hidden = !translationError;
  $('#retry-translation').disabled = translationBusy; renderAttention();
}
function repaintTranslations() {
  if (!state) return;
  const scroll = $('#graph-scroll'), top = scroll.scrollTop;
  const anchor = geometry?.elements.find(el => el.offsetTop + el.offsetHeight > top);
  const sha = anchor?.dataset.sha, offset = anchor ? top - anchor.offsetTop : 0;
  const activeSha = document.activeElement?.closest?.('.commit-row')?.dataset.sha;
  if (tab === 'timeline') {
    renderGraph();
    const restored = geometry?.elements.find(el => el.dataset.sha === sha);
    scroll.scrollTop = restored ? restored.offsetTop + offset : top;
    geometry?.elements.find(el => el.dataset.sha === activeSha)?.focus({ preventScroll: true });
  } else { graphKey = ''; if (tab === 'branches') renderBranches(); if (tab === 'team') renderTeam(); }
  if (!$('#detail').hidden && activeCommitSubject) {
    $('#detail-title').textContent = subjectLabel(activeCommitSubject);
    const title = $('#detail-body .patch-head .msg');
    if (title) title.textContent = subjectLabel(activeCommitSubject);
  }
  renderTranslationStatus();
}
async function translatePending(retry = false) {
  if (translationBusy || (translationError && !retry) || document.hidden) return;
  const pending = untranslatedSubjects();
  if (!pending.length) { renderTranslationStatus(); return; }
  const subjects = []; let size = 0;
  for (const source of pending) {
    if (subjects.length === 20 || size + source.length > 16000) break;
    subjects.push(source); size += source.length;
  }
  translationBusy = true; translationError = ''; const revision = generation, requestDir = dir;
  renderTranslationStatus();
  try {
    const result = await rpc('text/translate', { subjects, retry });
    GitLabels.loadTranslations(result.translations);
    if (revision === generation && requestDir === dir) repaintTranslations();
  } catch (e) { translationError = e.message; repaintTranslations(); }
  finally { translationBusy = false; renderTranslationStatus(); }
  if (!translationError) translatePending();
}
function renderFollow() {
  $('#follow-session').disabled = repositoryLocked || lockSaving;
  $('#follow-session').setAttribute('aria-pressed', String(!repositoryLocked && followingSession));
  const label = repositoryLocked ? '仓库已锁定 · 先关闭右侧锁定按钮，再跟随对话' : followingSession ? activeFocus ? '正在跟随对话 · 点击重新读取项目' : '等待对话切换 · 也可手动选择仓库' : '已手动选择 · 点击恢复跟随对话，下次切换对话也会自动恢复';
  $('#follow-session').title = label; $('#follow-session').setAttribute('aria-label', label);
  $('#repository-lock').disabled = lockSaving || (!repositoryLocked && (!state || busy));
  $('#repository-lock').setAttribute('aria-pressed', String(repositoryLocked));
  const lockLabel = repositoryLocked ? '已锁定仓库 · 点击解锁并恢复跟随对话' : '锁定当前仓库 · 切换对话时保持此仓库';
  $('#repository-lock').title = state || repositoryLocked ? lockLabel : '选择仓库后可以锁定';
  $('#repository-lock').setAttribute('aria-label', lockLabel);
  $('#repository-lock use').setAttribute('href', repositoryLocked ? '#i-lock' : '#i-unlock');
}
function clearRepository(title, message) {
  ++generation; ++teamGeneration; ++detailRevision;
  state = null; dir = null; busy = false; connecting = false; selected = null;
  team = null; teamError = ''; teamEditing = false; nextTeamAt = 0; teamFailures = 0;
  activeCommitSubject = ''; graphKey = ''; timelineScope = 'all';
  GitChoices.close(); showPreferences(false); $('#detail').hidden = true; $('#sheet').hidden = true;
  $('#searchbar').hidden = true; $('#search-toggle').setAttribute('aria-expanded', 'false'); $('#search').value = '';
  $('#graph').replaceChildren(); $('#branches').replaceChildren(); $('#team').replaceChildren();
  $('#translation-row').hidden = true; $('#refresh').disabled = true;
  $('#fetch').disabled = true; $('#remote-select').disabled = true;
  $('#preferences-toggle .sync-dot').hidden = true; $('#preferences-toggle').title = '远端与显示';
  $('#welcome-title').textContent = title; $('#welcome-message').textContent = message;
  applyControls(false); error(''); options(); render();
}
async function followConversation(focus, revision = focus?.revision, force = false) {
  if (!Number.isInteger(revision) || revision < lastFocusRevision || (revision === lastFocusRevision && !force)) return;
  lastFocusRevision = revision; activeFocus = focus;
  if (repositoryLocked) { followingSession = false; renderFollow(); return; }
  followingSession = true;
  clearRepository(focus?.workdir ? '正在读取对话项目' : '这个对话未关联本地项目', focus?.workdir ? '读取仓库后，流线会显示在这里。' : '可以手动选择仓库；切换到项目对话后会继续自动跟随。');
  if (focus?.workdir) await connect(focus.workdir, false, 'follow', focus);
}
async function connect(nextDir, pick = false, mode = 'manual', focus = activeFocus) {
  if (mode === 'manual' && lockSaving) return;
  const previousFollowing = followingSession;
  if (mode === 'manual') followingSession = false;
  GitChoices.close(); showPreferences(false); renderFollow();
  if (!pick) clearRepository('正在读取仓库', '读取完成后，流线会显示在这里。');
  const revision = ++generation; ++teamGeneration; ++detailRevision;
  activeCommitSubject = ''; $('#detail').hidden = true; connecting = true; busy = true; error(''); $('#refresh').disabled = true;
  try {
    const data = await rpc(mode === 'follow' ? 'session/connect' : pick ? 'repo/pick' : 'repo/connect', mode === 'follow' ? { revision: focus.revision } : pick ? {} : { dir: nextDir });
    if (revision !== generation) return;
    if (!data) { followingSession = previousFollowing; options(); render(); return; }
    const latest = await rpc('config/read');
    if (revision !== generation) return;
    dir = data.dir; state = data; config = latest; repositoryLocked = !!config.repositoryLock?.dir; if (repositoryLocked) followingSession = false; timelineScope = 'all'; selected = null;
    teamEditing = false; team = null; teamError = ''; nextTeamAt = 0; graphKey = '';
    options(); render(); syncTeam();
  } catch (e) {
    if (revision === generation) {
      $('#welcome-title').textContent = mode === 'follow' ? '这个对话的仓库暂时无法读取' : '仓库暂时无法读取';
      $('#welcome-message').textContent = '可以选择其他仓库，或点击左上角分支图标重新跟随对话。';
      error(e.message);
    }
  }
  finally {
    if (revision === generation) {
      busy = false; connecting = false; $('#refresh').disabled = !state; $('#fetch').disabled = !state?.remotes.length; $('#remote-select').disabled = !state?.remotes.length;
      renderFollow(); syncTeam(); maybeFetch();
    }
  }
}
async function refresh(fetchRemote = false, automatic = false) {
  if (!dir || busy) return;
  const requestedDir = dir, remote = $('#remote-select').value;
  if (fetchRemote && (!state?.remotes.some(r => r.name === remote) || !fetchSchedule.begin(requestedDir, remote))) return;
  busy = true; renderFollow(); const revision = generation; error(''); $('#refresh').disabled = true; $('#fetch').disabled = true;
  if (fetchRemote) { fetchProgress.delete(fetchSchedule.key(requestedDir, remote)); $('#remote-select').disabled = true; renderFetchStatus(); }
  let success = false;
  try {
    const result = await rpc(fetchRemote ? 'repo/fetch' : 'repo/snapshot', { dir: requestedDir, remote });
    success = true;
    if (fetchRemote) { fetchErrors.delete(fetchSchedule.key(requestedDir, remote)); fetchSuccessAt.set(fetchSchedule.key(requestedDir, remote), result.fetchCompletedAt || new Date().toISOString()); }
    if (revision === generation) { state = result; render(); }
  } catch (e) {
    if (fetchRemote) fetchErrors.set(fetchSchedule.key(requestedDir, remote), e.message);
    if (revision === generation && !automatic) error(e.message + (state ? ' 下方保留的是上次读取结果。' : ''));
  }
  finally {
    if (fetchRemote) fetchSchedule.finish(requestedDir, remote, Math.max(1, autoFetchMinutes) * 60000, success);
    if (revision === generation) { busy = false; $('#refresh').disabled = !state; $('#fetch').disabled = !state?.remotes.length; $('#remote-select').disabled = !state?.remotes.length; renderFetchStatus(); renderFollow(); }
  }
}
async function maybeFetch() {
  if (document.hidden || connecting || busy || !dir || !state?.remotes.length || !autoFetchMinutes) return false;
  const remote = $('#remote-select').value;
  if (!state.remotes.some(r => r.name === remote)) return false;
  fetchSchedule.seed(dir, remote, fetchSuccessAt.get(fetchSchedule.key(dir, remote)) || config.fetchTimes?.[fetchSchedule.key(dir, remote)] || state.fetchedAt, autoFetchMinutes * 60000);
  if (!fetchSchedule.due(dir, remote, autoFetchMinutes)) return false;
  await refresh(true, true);
  return true;
}
async function tick() {
  if (document.hidden) return;
  if (!await maybeFetch()) await refresh();
  syncTeam(); renderFetchStatus();
}
function renderFetchStatus() {
  if (!state) return;
  $('#auto-fetch-row').hidden = !state.remotes.length;
  const remote = $('#remote-select').value, label = $('#fetch-status');
  if (!remote) { label.textContent = ''; $('#fetch-reason').hidden = true; $('#preferences-toggle .sync-dot').hidden = true; renderAttention(); return; }
  fetchSchedule.seed(dir, remote, fetchSuccessAt.get(fetchSchedule.key(dir, remote)) || config.fetchTimes?.[fetchSchedule.key(dir, remote)] || state.fetchedAt, autoFetchMinutes * 60000);
  const entry = fetchSchedule.entry(dir, remote), failure = fetchErrors.get(fetchSchedule.key(dir, remote));
  const showFailure = !!failure && !entry.pending;
  label.classList.toggle('failed', showFailure);
  $('#fetch-reason').textContent = showFailure ? failure : ''; $('#fetch-reason').hidden = !showFailure;
  $('#preferences-toggle .sync-dot').hidden = !showFailure;
  $('#preferences-toggle').title = showFailure ? '远端更新失败 · 查看原因与重试' : '远端与显示';
  label.title = showFailure ? failure + '；保留上次记录，可手动重试。' : '正在获取时显示真实下载进度；面板隐藏时暂停下一次自动获取，不会合并代码。';
  const completedAt = fetchSuccessAt.get(fetchSchedule.key(dir, remote)) || config.fetchTimes?.[fetchSchedule.key(dir, remote)];
  $('#fetched').textContent = completedAt ? '上次成功更新：' + age(completedAt) : state.fetchedAt ? '缓存文件更新于 ' + age(state.fetchedAt) : '尚未获取远端记录';
  $('#fetched').title = completedAt ? '这个远端上次成功完成获取的时间。' : '缓存文件也可能在失败获取或其他工具操作时变化，不代表远端更新成功。';
  if (entry.pending) {
    const progress = fetchProgress.get(fetchSchedule.key(dir, remote));
    const phases = { counting: '检查远端记录', compressing: '远端准备文件', receiving: '下载新文件', resolving: '整理新记录', reading: '刷新本地视图' };
    const phase = phases[progress?.phase] || (failure ? '正在重新连接远端' : '连接远端');
    const percent = Number.isFinite(progress?.percent) ? ' ' + progress.percent + '%' : '…';
    const size = progress?.bytes > 0 ? ' · ' + (progress.bytes / 1048576).toFixed(1) + ' MB' : '';
    label.textContent = phase + percent + size;
  } else if (!autoFetchMinutes) label.textContent = failure ? '更新失败 · 请重试' : '自动更新已关闭';
  else {
    const wait = Math.max(0, Math.ceil((entry.next - performance.now()) / 60000));
    label.textContent = (failure ? '更新失败 · ' : '') + (wait ? wait + ' 分钟后' + (failure ? '重试' : '更新') : '即将更新');
  }
  renderAttention();
}

function renderStatus() {
  const branch = state.branch || (state.unborn ? '尚无提交' : '游离提交 ' + short(state.head));
  $('#current-branch').textContent = branch;
  $('#current-branch').title = '当前分支：' + branch + ' · 点击定位';
  $('#current-branch').setAttribute('aria-label', '定位当前分支 ' + branch);
  $('#sampled').textContent = '本地记录更新于 ' + age(state.sampledAt);
  $('#tracking').textContent = state.unborn ? '完成首次提交后，流线会显示在这里。' : state.upstream ? '跟踪分支：' + state.upstream + (state.upstreamExists ? '' : ' · 远端记录已缺失') : '未设置跟踪分支，暂时无法比较待推送和待拉取数量。';
  const dirty = $('#dirty'), count = state.status.count;
  dirty.className = 'pill ' + (count ? 'warn' : 'good');
  dirty.innerHTML = count ? '<b>' + count + '</b> 个改动' + (state.status.conflicts ? ' · 冲突 ' + state.status.conflicts : '') : '无改动';
  dirty.title = count ? count + ' 个文件尚未提交，点击查看' : '工作区没有未提交的文件';
  const ahead = $('#ahead'), behind = $('#behind');
  ahead.hidden = !state.ahead; behind.hidden = !state.behind;
  ahead.className = 'pill good'; ahead.innerHTML = '↑ <b>' + (state.ahead || 0) + '</b>'; ahead.title = (state.ahead || 0) + ' 个提交待推送';
  behind.className = 'pill warn'; behind.innerHTML = '↓ <b>' + (state.behind || 0) + '</b>'; behind.title = (state.behind || 0) + ' 个提交待拉取';
  renderRemote();
}
function renderRemote() {
  const remoteSelected = $('#remote-select').value;
  $('#remote-select').dataset.empty = '未配置';
  GitChoices.set($('#remote-select'), state.remotes.map(r => ({ value: r.name, label: r.name, detail: r.url })), remoteSelected);
  $('#remote-select').disabled = !state.remotes.length || (busy && fetchSchedule.entry(dir, remoteSelected || '').pending);
  $('#fetch').disabled = !state.remotes.length || busy;
  $('#fetched').textContent = state.remotes.length ? (state.fetchedAt ? '上次获取：' + age(state.fetchedAt) : '尚未获取远端记录') : '这个仓库还没有配置远端。';
  $('#fetched').title = '分支页显示已获取的远端记录；点击「立即更新」从服务器重新获取。';
  renderFetchStatus();
}
function render() {
  $('#welcome').hidden = !!state; $('#workspace').hidden = !state;
  $('#overview').hidden = !state; $('#viewbar').hidden = !state; $('#pull-handle').hidden = !state;
  $('#preferences-toggle').disabled = !state;
  if (!state) return;
  renderStatus(); renderScope();
  if (state.unstable) error('仓库正在被其他操作更新，当前快照可能变化，请稍后刷新。');
  $('#branch-count').textContent = state.refs.length;
  const key = JSON.stringify([state.dir, state.head, state.refs, timelineScope, visibleCommits()]);
  if (key !== graphKey) { graphKey = key; if (selected && !visibleCommits().some(c => c.sha === selected)) selected = null; renderGraph(); }
  if (tab === 'branches') renderBranches();
  if (tab === 'team') renderTeam();
  renderTranslationStatus(); translatePending();
}

// 同名的本地分支和各远端分支合成一枚标签，减少每行的字数。
function refGroups(sha) {
  const groups = new Map();
  for (const r of state.refs.filter(r => r.sha === sha)) {
    const name = r.remote ? r.name.slice(r.name.indexOf('/') + 1) : r.name;
    const g = groups.get(name) || { name, local: null, remotes: [] };
    if (r.remote) g.remotes.push(r.name); else g.local = r;
    groups.set(name, g);
  }
  const current = g => g.local && g.local.full === 'refs/heads/' + state.branch;
  return [...groups.values()].sort((a, b) => current(b) - current(a) || !!b.local - !!a.local);
}
function chip(g, lane) {
  const here = g.local && g.local.full === 'refs/heads/' + state.branch;
  const title = [g.local ? '本地分支 ' + g.name : null, ...g.remotes.map(r => '远端记录（本机缓存） ' + r)].filter(Boolean).join('\n');
  return '<span class="chip ' + (g.local ? 'local c' + lane : '') + (here ? ' here' : '') + '" title="' + escapeHtml(title) + '">' + (g.local ? '' : icon('cloud')) + '<span>' + escapeHtml(g.name) + '</span>' + (g.local && g.remotes.length ? icon('cloud') : '') + '</span>';
}
function chips(row, limit) {
  const groups = refGroups(row.sha);
  let html = groups.slice(0, limit).map(g => chip(g, row.color)).join('');
  if (groups.length > limit) html += '<span class="chip more" title="' + escapeHtml(groups.slice(limit).map(g => g.name).join('\n')) + '">+' + (groups.length - limit) + '</span>';
  if (row.sha === state.head && !groups.some(g => g.local?.full === 'refs/heads/' + state.branch)) html = '<span class="chip here"><span>当前提交</span></span>' + html;
  return html;
}

let geometry = null;
function renderGraph() {
  const host = $('#graph');
  const commits = visibleCommits();
  if (!commits.length) { graph = null; geometry = null; host.innerHTML = '<p class="empty">' + (timelineScope === 'current' ? '当前分支尚无提交。' : '首次提交后，分支故事从这里开始。') + '</p>'; $('#graph-foot').textContent = ''; renderSheet(); return; }
  graph = GitGraph.layout(commits);
  const width = host.clientWidth || innerWidth;
  const spacing = Math.max(13, Math.min(18, (width * 0.42 - 22) / graph.lanes));
  const x = lane => 22 + lane * spacing;
  host.innerHTML = graph.rows.map(row => {
    const head = row.sha === state.head;
    return '<button class="commit-row' + (head ? ' head' : '') + '" data-sha="' + row.sha + '" title="' + escapeHtml(subjectLabel(row.subject)) + '"><div class="commit-title">' + escapeHtml(subjectLabel(row.subject)) + '</div><div class="commit-meta">' + chips(row, 2) + '<span class="author" title="提交作者：' + escapeHtml(row.author) + '（提交时填写的 Git 姓名，不是账号认证）">' + escapeHtml(row.author) + '</span><span class="dot">·</span><span class="when">' + age(row.date) + '</span></div></button>';
  }).join('');
  const elements = [...host.querySelectorAll('.commit-row')];
  elements.forEach((el, i) => el.style.setProperty('--indent', Math.round(x(graph.reach[i]) + 16 - 8) + 'px'));
  geometry = { x, y: elements.map(el => el.offsetTop + 20), height: host.scrollHeight, elements };
  drawGraph();
  $('#graph-foot').textContent = (timelineScope === 'current' ? (state.detached ? '当前提交' : '当前分支') : '全仓库') + ' · ' + commits.length + ' 条提交' + ((timelineScope === 'current' ? state.currentTruncated : state.truncated) ? ' · 虚线连接更早的记录' : ' · 点击看摘要，再点查看改动');
  filterGraph(); renderSheet();
}
// 折线拐点做小圆角，线条读起来更顺。
function polyline(points, radius = 7) {
  const p = points.filter((pt, i) => i === 0 || pt[0] !== points[i - 1][0] || pt[1] !== points[i - 1][1]);
  let d = 'M' + p[0][0] + ' ' + p[0][1];
  for (let i = 1; i < p.length - 1; i++) {
    const [ax, ay] = p[i - 1], [bx, by] = p[i], [cx, cy] = p[i + 1];
    const l1 = Math.hypot(bx - ax, by - ay), l2 = Math.hypot(cx - bx, cy - by), r = Math.min(radius, l1 / 2, l2 / 2);
    d += 'L' + (bx - (bx - ax) / l1 * r).toFixed(1) + ' ' + (by - (by - ay) / l1 * r).toFixed(1) + 'Q' + bx + ' ' + by + ' ' + (bx + (cx - bx) / l2 * r).toFixed(1) + ' ' + (by + (cy - by) / l2 * r).toFixed(1);
  }
  const last = p[p.length - 1];
  return d + 'L' + last[0] + ' ' + last[1];
}
function edgePoints(link) {
  const { x, y } = geometry, x1 = x(link.fromLane), y1 = y[link.fromRow], xl = x(link.lane);
  if (link.boundary) return [[x1, y1], [xl, y1 + 18], [xl, y1 + 34]];
  const x2 = x(link.toLane), y2 = y[link.toRow], gap = y2 - y1;
  const bend = dx => Math.min(gap / 2, Math.max(16, Math.abs(dx) * .8));
  const points = [[x1, y1]];
  if (xl !== x1) points.push([xl, y1 + bend(xl - x1)]);
  if (x2 !== xl) points.push([xl, y2 - bend(x2 - xl)]);
  points.push([x2, y2]);
  return points;
}
function drawGraph() {
  if (!graph) return;
  const { x, y, height } = geometry, focus = selected || state.head;
  const chain = GitGraph.trunk(graph, focus), onTrunk = new Set(chain);
  let svg = '<svg width="' + (x(graph.lanes) + 10) + '" height="' + height + '" aria-hidden="true">';
  for (const link of graph.links) if (!onTrunk.has(link)) svg += '<path class="edge c' + link.color + (link.boundary ? ' boundary' : '') + '" d="' + polyline(edgePoints(link)) + '"/>';
  const focusRow = graph.rows.find(r => r.sha === focus);
  if (chain.length && focusRow) {
    // 主线从旧到新拼成一条路径，流光沿时间方向往上走。
    const points = [];
    for (const link of chain) for (const pt of edgePoints(link)) points.push(pt);
    const d = polyline(points.reverse());
    for (const link of chain) svg += '<path class="edge on c' + link.color + (link.boundary ? ' boundary' : '') + '" d="' + polyline(edgePoints(link)) + '"/>';
    svg += '<path class="flow-glow c' + focusRow.color + '" d="' + d + '"/><path class="flow c' + focusRow.color + '" d="' + d + '"/>';
  }
  for (const row of graph.rows) {
    const cx = x(row.lane), cy = y[row.row];
    if (row.sha === state.head || row.sha === selected) svg += '<circle class="node-ring c' + row.color + '" cx="' + cx + '" cy="' + cy + '" r="' + (row.sha === state.head ? 10 : 9) + '"/>';
    svg += '<circle class="node c' + row.color + (row.parents.length > 1 ? ' merge' : '') + '" cx="' + cx + '" cy="' + cy + '" r="' + (row.parents.length > 1 ? 4.6 : 5.2) + '"/>';
  }
  $('#graph').querySelector(':scope > svg')?.remove();
  $('#graph').insertAdjacentHTML('beforeend', svg + '</svg>');
  for (const el of geometry.elements) el.classList.toggle('selected', el.dataset.sha === selected);
}
function filterGraph() {
  if (!graph) return;
  const q = $('#search').value.trim().toLowerCase();
  geometry.elements.forEach((el, i) => {
    const c = graph.rows[i];
    const haystack = [c.sha, c.subject, subjectLabel(c.subject), c.author, ...state.refs.filter(r => r.sha === c.sha).map(r => r.name)].join(' ').toLowerCase();
    el.classList.toggle('dimmed', !!q && !haystack.includes(q));
    el.classList.toggle('search-match', !!q && haystack.includes(q));
  });
}
function select(sha, scroll = false) {
  selected = sha; drawGraph(); renderSheet();
  const el = sha && geometry?.elements.find(el => el.dataset.sha === sha);
  if (el) el.scrollIntoView({ block: scroll ? 'center' : 'nearest', behavior: 'smooth' });
}
function originalSubject(subject) {
  return subjectLabel(subject) !== subject ? '<details class="original-subject"><summary>查看提交原文</summary><p>' + escapeHtml(subject) + '</p></details>' : '';
}
function renderSheet() {
  const sheet = $('#sheet'), row = graph?.rows.find(r => r.sha === selected);
  sheet.hidden = !row;
  if (!row) return;
  const refs = refGroups(row.sha);
  sheet.innerHTML = '<div class="sheet-head"><div class="sheet-title">' + escapeHtml(subjectLabel(row.subject)) + '</div><button class="icon-button" data-sheet="close" title="关闭" aria-label="关闭">' + icon('close') + '</button></div>' +
    '<div class="sheet-meta"><span>提交作者：' + escapeHtml(row.author) + '</span><span>' + age(row.date) + '</span><span class="mono" title="提交编号：这条记录的唯一标识">编号 ' + short(row.sha) + '</span>' + (row.parents.length > 1 ? '<span>合并提交</span>' : '') + '</div>' +
    (refs.length || row.sha === state.head ? '<div class="sheet-refs">' + chips(row, 6) + '</div>' : '') +
    originalSubject(row.subject) + '<div class="sheet-actions"><button class="main" data-sheet="detail" title="查看这次提交修改了哪些文件和代码">查看改动</button>' + (row.sha === state.head ? '' : '<button data-sheet="compare" title="只查看提交数量和文件差异，不执行合并或切换">和当前分支比较</button>') + '</div>';
}

function renderBranches() {
  let html = '';
  for (const remote of [false, true]) {
    const refs = state.refs.filter(r => r.remote === remote);
    html += '<div class="section-label">' + (remote ? '远端分支（本机缓存）' : '本地分支') + '<span>' + refs.length + '</span></div>';
    for (const r of refs) {
      const current = r.full === 'refs/heads/' + state.branch;
      const worktrees = state.worktrees.filter(w => w.branch === r.name && !r.remote);
      html += '<div class="branch-item"><span class="branch-dot' + (remote ? '' : ' local') + '"></span><div class="branch-main"><div class="branch-name"><span>' + escapeHtml(r.name) + '</span>' + (current ? '<span class="chip here"><span>当前</span></span>' : '') + '</div><div class="branch-description" title="' + escapeHtml(subjectLabel(r.subject)) + '">' + escapeHtml(subjectLabel(r.subject)) + '</div><div class="branch-meta">' + escapeHtml(r.author) + ' · ' + age(r.date) + (worktrees.length ? ' · 已在 ' + worktrees.length + ' 个本机工作区检出' : '') + '</div></div><div class="branch-actions"><button class="text-button" data-locate="' + r.sha + '" title="在提交图中找到分支指向的最新提交">定位</button>' + (current ? '' : '<button class="text-button" data-compare="' + escapeHtml(r.full) + '" title="查看与当前分支的差距和文件差异，不执行合并或切换">比较</button>') + '</div></div>';
    }
  }
  $('#branches').innerHTML = html;
}
function locate(sha) {
  if (!visibleCommits().some(c => c.sha === sha)) {
    if (state.commits.some(c => c.sha === sha)) setTimelineScope('all');
    else if (state.currentCommits?.some(c => c.sha === sha)) setTimelineScope('current');
    else { error('这个提交不在当前可显示的最近 180 条记录里，暂时没法在流线上定位。'); return; }
  }
  error(''); switchTab('timeline'); select(sha, true);
}
function renderTeam() {
  if (!$('#team-setup')) $('#team').innerHTML = '<div id="team-worktrees"></div><div id="team-setup"></div><div id="team-live"></div>';
  const cfg = config.teamRepos?.[dir] || {};
  let html = '<div class="section-label">同机工作区<span>' + state.worktrees.length + '</span></div>';
  for (const w of state.worktrees) html += '<div class="worktree"><div>' + escapeHtml(w.branch || '未检出分支') + ' <span class="mono muted">' + short(w.sha) + '</span></div><div class="path">' + escapeHtml(w.path) + '</div></div>';
  html += '<div class="section-label">队友状态<span>由队友插件上报</span></div>';
  $('#team-worktrees').innerHTML = html; html = '';
  if (!config.teamUrl) {
    html += '<div class="team-intro"><p>接入团队服务后，可以看到队友正在用的分支、还没推送的提交和改动数量。</p><p>在「插件 → Git 流线 → 设置」填写服务地址和访问令牌，队友也要连接同一个服务。</p><p class="small">提交作者不代表当前分支的使用者；远端分支请看「分支」页。</p></div>';
    if (!teamEditing) $('#team-setup').innerHTML = html; html = '';
  } else {
    html += '<div class="team-control"><label><input id="share-enabled" type="checkbox" ' + (cfg.enabled ? 'checked' : '') + '>共享当前仓库的状态</label><input type="text" id="room" maxlength="120" aria-label="团队项目代号" placeholder="团队项目代号，留空按默认远端识别" value="' + escapeHtml(cfg.room || '') + '"><div class="small">使用各自派生仓库协作时，大家填同一个代号。只分享昵称、分支、提交摘要和改动数量。</div><button id="save-team" class="text-button">保存并同步</button></div>';
    if (!teamEditing) $('#team-setup').innerHTML = html; html = '';
    if (teamError) html += '<div class="notice error">' + escapeHtml(teamError) + '</div>';
    if (cfg.enabled && !team && !teamError) html += '<p class="empty">正在等待团队状态…</p>';
    if (!cfg.enabled) html += '<p class="empty">当前仓库还没开启共享</p>';
    if (cfg.enabled && team) {
      for (const m of team.members) {
        const elapsed = team.serverTime + performance.now() - team.receivedMonotonic - m.seenAt;
        const online = !teamError && elapsed < 90000;
        const known = [...state.commits, ...(state.currentCommits || [])].some(c => c.sha === m.head);
        html += '<button class="person"' + (known ? ' data-locate="' + escapeHtml(m.head) + '" title="在流线上定位"' : ' title="这个提交还没推送或不在本机记录里"') + '><div class="person-head"><span class="avatar">' + escapeHtml(m.name.slice(0, 1)) + '</span><span class="person-name">' + escapeHtml(m.name) + (m.id === team.me ? '（我）' : '') + '</span><span class="status ' + (online ? 'online' : '') + '">' + (online ? '● 在线' : '最后上报 ' + age(Date.now() - elapsed)) + '</span></div><div class="branch">' + (online ? '' : '最后使用 ') + escapeHtml(m.branch || '未检出分支') + '</div><div class="line"><span class="mono">' + short(m.head) + '</span> ' + escapeHtml(subjectLabel(m.subject)) + '</div><div class="line faint">' + escapeHtml(m.dirty) + ' 项未提交 · ' + (m.ahead === null ? '未关联上游' : escapeHtml(m.ahead) + ' 个提交待推送') + (online ? ' · ' + age(Date.now() - elapsed) + '上报' : '') + '</div></button>';
      }
      html += '<div class="team-intro small">面板打开时约每 25 秒同步一次；超过 90 秒没有上报就显示最后状态。</div>';
    }
  }
  $('#team-live').innerHTML = html;
  const count = team?.members.filter(m => !teamError && team.serverTime + performance.now() - team.receivedMonotonic - m.seenAt < 90000).length;
  $('#team-count').textContent = count || '';
}
async function syncTeam(force = false) {
  if (connecting || !dir || !config.teamRepos?.[dir]?.enabled || !config.teamUrl || teamBusy || (!force && performance.now() < nextTeamAt) || document.hidden) return;
  const revision = generation, teamRevision = teamGeneration, requestDir = dir; teamBusy = true;
  try { const data = await rpc('team/sync', { dir: requestDir }); if (revision === generation && teamRevision === teamGeneration && requestDir === dir) { team = { ...data, receivedMonotonic: performance.now() }; teamError = ''; teamFailures = 0; } }
  catch (e) { if (revision === generation && teamRevision === teamGeneration && requestDir === dir) { teamError = e.message; teamFailures++; } }
  finally { teamBusy = false; if (revision === generation && teamRevision === teamGeneration && requestDir === dir) { nextTeamAt = performance.now() + Math.min(120000, 25000 * 2 ** teamFailures); if (tab === 'team') renderTeam(); translatePending(); } else syncTeam(true); }
}

let detailRevision = 0;
function openDetail(title) { GitChoices.close(); showPreferences(false); activeCommitSubject = ''; $('#detail').hidden = false; $('#detail-title').textContent = title; $('#detail-body').innerHTML = '<p class="empty">正在读取…</p>'; $('#detail-body').scrollTop = 0; return ++detailRevision; }
function patchHead(text, row) {
  const lines = text.split('\n'); let i = 0, author = '';
  for (; i < lines.length && lines[i]; i++) if (lines[i].startsWith('Author:')) author = lines[i].replace(/^Author:\s*/, '').replace(/\s*<[^>]*>$/, '');
  const message = [];
  for (i++; i < lines.length && (lines[i].startsWith('    ') || !lines[i]); i++) message.push(lines[i].slice(4));
  const [subject = '', ...body] = message.join('\n').trim().split('\n');
  const stats = [], rest = lines.slice(i); let summary = '';
  for (const line of rest) {
    const m = line.match(/^ (.+?)\s+\|\s+(\d+) ?(\+*)(-*)\s*$/), bin = line.match(/^ (.+?)\s+\|\s+Bin/);
    if (m) stats.push({ file: m[1], n: m[2], add: m[3].length, remove: m[4].length });
    else if (bin) stats.push({ file: bin[1], n: '二进制', add: 0, remove: 0 });
    else if (/files? changed/.test(line)) summary = line.trim().replace(/(\d+) files? changed/, '$1 个文件').replace(/(\d+) insertions?\(\+\)/, '+$1 行').replace(/(\d+) deletions?\(-\)/, '-$1 行').replace(/,/g, ' ·');
  }
  const max = Math.max(1, ...stats.map(s => s.add + s.remove));
  const when = row ? new Date(row.date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  let html = '<div class="patch-head"><div class="msg">' + escapeHtml(subjectLabel(subject)) + '</div>' + originalSubject(subject) + (body.join('\n').trim() ? '<div class="body">' + escapeHtml(body.join('\n').trim()) + '</div>' : '');
  html += '<div class="meta"><span>' + '提交作者：' + escapeHtml(row?.author || author) + '</span>' + (when ? '<span>' + when + '</span>' : '') + (row ? '<span class="mono" title="提交编号：这条记录的唯一标识">编号 ' + short(row.sha) + '</span>' : '') + (row?.parents.length > 1 ? '<span>合并提交</span>' : '') + '</div>';
  if (stats.length) {
    html += '<div class="stat">' + stats.map(s => '<div class="stat-row" title="' + escapeHtml(s.file) + '"><span class="file"><bdi>' + escapeHtml(s.file) + '</bdi></span><span class="n">' + s.n + '</span><span class="stat-bar"><i class="a" data-w="' + (s.add / max * 100).toFixed(1) + '"></i><i class="r" data-w="' + (s.remove / max * 100).toFixed(1) + '"></i></span></div>').join('') + '</div>';
    if (summary) html += '<div class="stat-sum">' + escapeHtml(summary) + '</div>';
  }
  return html + '</div>';
}
function patchBody(text) {
  return '<pre class="patch">' + text.split('\n').map(line => {
    if (line.startsWith('diff --git ')) return '<span class="patch-line file">' + escapeHtml(line.replace(/^diff --git a\/(.*) b\/.*$/, '$1')) + '</span>';
    if (/^(index |--- |\+\+\+ )/.test(line)) return '';
    const kind = line.startsWith('@@') ? 'hunk' : line.startsWith('+') ? 'add' : line.startsWith('-') ? 'remove' : /^(new|deleted) file mode|^Binary files/.test(line) ? 'meta' : '';
    return '<span class="patch-line ' + kind + '">' + (escapeHtml(line) || ' ') + '</span>';
  }).filter(Boolean).join('') + '</pre>';
}
async function showCommit(sha) {
  const row = graph?.rows.find(r => r.sha === sha);
  const rev = openDetail(row ? subjectLabel(row.subject) : '提交编号 ' + short(sha));
  activeCommitSubject = row?.subject || '';
  try {
    const data = await rpc('repo/detail', { dir, ref: sha }); if (rev !== detailRevision) return;
    const split = data.patch.indexOf('\ndiff --git ');
    if (!activeCommitSubject) {
      const match = data.patch.match(/\n\n    ([^\n]+)/);
      activeCommitSubject = match?.[1] || '';
      if (activeCommitSubject) $('#detail-title').textContent = subjectLabel(activeCommitSubject);
    }
    $('#detail-body').innerHTML = patchHead(split < 0 ? data.patch : data.patch.slice(0, split), row) + (split < 0 ? '' : patchBody(data.patch.slice(split + 1))) + (data.truncated ? '<p class="empty">补丁太长，只显示了前 180,000 字符。</p>' : '');
    for (const bar of $('#detail-body').querySelectorAll('[data-w]')) bar.style.width = bar.dataset.w + '%';
    translatePending();
  } catch (e) { if (rev === detailRevision) $('#detail-body').innerHTML = '<p class="empty">' + escapeHtml(e.message) + '</p>'; }
}
async function showCompare(target) {
  const label = /^[0-9a-f]{40}$/.test(target) ? short(target) : target.replace(/^refs\/(heads|remotes)\//, '');
  const rev = openDetail('当前分支 ↔ ' + label);
  try {
    const d = await rpc('repo/compare', { dir, target }); if (rev !== detailRevision) return;
    const relation = { equal: '两边在同一次提交', 'fast-forward': '当前分支可以直接快进到它', contains: '当前分支已经包含它的全部提交', diverged: '两边各自有新的提交', unrelated: '两边没有共同历史' }[d.relation];
    $('#detail-body').innerHTML = '<div class="comparison"><h3>' + relation + '</h3><div class="nums"><div class="num"><b>' + d.ahead + '</b>当前分支独有</div><div class="num"><b>' + d.behind + '</b>' + escapeHtml(label) + ' 独有</div></div><p>' + (d.dirty ? '工作区还有 ' + d.dirty + ' 项未提交改动，切换或合并前要先处理。' : '工作区没有未提交改动。') + '</p><p class="small">' + escapeHtml(d.note) + '</p></div>' + (d.diff ? patchBody(d.diff) : '<p class="empty">两边的文件内容一致。</p>');
  } catch (e) { if (rev === detailRevision) $('#detail-body').innerHTML = '<p class="empty">' + escapeHtml(e.message) + '</p>'; }
}
function closeDetail() { ++detailRevision; activeCommitSubject = ''; $('#detail').hidden = true; }
function showReadingGuide() {
  openDetail('怎么看提交图');
  const colors = ['绿色', '紫色', '黄色', '蓝色', '粉色', '草绿色', '橙色', '青色'];
  const colorRows = colors.map((name, color) => {
    const rows = graph?.rows.filter(r => r.color === color) || [];
    if (!rows.length) return '';
    const labels = rows.flatMap(r => refGroups(r.sha).map(g => (g.local ? g.name : g.remotes.join('、')) + (g.local?.full === 'refs/heads/' + state.branch ? '（当前分支）' : !g.local ? '（仅远端记录）' : '')));
    return '<li><span class="guide-dot c' + color + '"></span><b>' + name + '</b><span>' + (labels.length ? '标签落在这条颜色的泳道上：' + escapeHtml([...new Set(labels)].join('、')) : '这条历史泳道上没有分支末端标签') + '</span></li>';
  }).join('');
  $('#detail-body').innerHTML = '<article class="reading-guide">' +
    '<h3>先看每一行</h3><p>一行代表一次提交，也就是一次已保存的代码版本。标题是这次改动的说明；下面的姓名是提交作者，时间是作者记录的提交时间距今多久。</p>' +
    '<p><b>xd、shiyu、LX.. 等是提交时填写的 Git 作者姓名。</b>它们不一定是平台账号，也不说明这个人当前在哪个分支，更不表示在线状态。真正的队友当前状态要看「协作」页的插件上报。</p>' +
    '<h3>为什么原来有中文也有英文</h3><p>提交说明由提交者或其工具填写，所以仓库里的原文会混用中英文。面板会将新增的英文提交标题自动翻译为中文并缓存；生成期间会显示「正在翻译」。点提交后可展开「查看提交原文」，版本记录不会被修改。翻译只发送标题到 Cindy 的轻量任务模型，不发送代码或补丁；失败时会提示原因，处理后可点「重试中文翻译」。</p>' +
    '<p>新增功能表示加入能力；修复问题表示修正错误；样式调整表示外观变化；合并更新表示整合不同历史；性能优化表示提升运行效率。括号里是改动涉及的模块，例如剧情、界面或输入控制。</p>' +
    '<h3>圆点、连线和颜色</h3><p>实心圆点是普通提交；空心圆点是合并提交，连接两个或更多父提交。沿线向下看更早的历史，分开再汇合的线表示分支历史的关系。外圈标记当前提交或选中的提交，白色流光沿选中路径移动。</p>' +
    '<p><b>颜色区分历史泳道，没有固定的“某颜色＝某分支”规则。</b>同一条泳道可能承载多个分支标签，颜色也会复用；刷新后布局变化时颜色可能改变。准确的分支名称以节点旁标签为准。</p>' +
    '<ul class="guide-colors">' + colorRows + '</ul>' +
    '<p>绿色实心标签表示当前分支，独立于连线颜色。灰色带云朵的标签表示只有远端记录；彩色标签旁带云朵表示同名本地和远端分支指向同一次提交。云朵是本机缓存记录，不是实时在线。</p>' +
    '<h3>按钮分别做什么</h3><dl><dt>收起工具栏</dt><dd>点击或向上拖动把手，只看流线。收起后点击或向下拖动把手恢复；收起时点提交可直接查看改动。</dd><dt>搜索（放大镜）</dt><dd>展开搜索框，按提交说明、作者或分支名高亮匹配记录。</dd>' +
    '<dt>全仓库／当前分支</dt><dd>只切换流线显示范围，不切换 Git 工作分支。默认全仓库；当前分支显示它的历史，包括已经合入的提交。两种范围分别读取最近 180 条记录。</dd><dt>连接仓库（＋）</dt><dd>选择本机已有项目文件夹，让面板读取它的版本记录。</dd>' +
    '<dt>刷新本地记录（圆箭头）</dt><dd>重新读取本机提交、分支和未提交文件。</dd>' +
    '<dt>立即更新（远端与显示）</dt><dd>连接服务器，更新本机缓存的远端分支记录；不会合并代码或修改工作文件。</dd>' +
    '<dt>自动更新（远端与显示）</dt><dd>默认每 5 分钟获取上方所选远端，可改为每 1 或 10 分钟，也可关闭。面板隐藏时暂停，重新显示后检查是否到期。失败会保留上次记录并延后重试。</dd>' +
    '<dt>改动数量</dt><dd>查看尚未保存为提交的文件，以及已暂存、未暂存、未跟踪或冲突状态。</dd>' +
    '<dt>↑／↓ 数量</dt><dd>与已获取的上游记录相比，本地独有／上游独有的提交数量。这两个数字是状态，不是执行按钮。</dd>' +
    '<dt>点一次提交／查看改动</dt><dd>点一次打开摘要；再点一次或点「查看改动」，查看这次提交修改的文件和代码。差异里绿色带＋是新增行，红色带－是删除行。</dd>' +
    '<dt>定位</dt><dd>在图中找到这个分支指向的最新提交，不切换工作分支。</dd>' +
    '<dt>比较／和当前分支比较</dt><dd>查看两边各自独有的提交数和文件差异，不执行合并或切换。</dd>' +
    '<dt>路径流光（远端与显示）</dt><dd>开启或关闭选中历史路径上的流光。</dd>' +
    '<dt>保存并同步（协作页）</dt><dd>保存共享设置，开启共享时向已配置的团队服务上报昵称、分支、最新提交和未提交数量。</dd>' +
    '</dl><h3>分支名和编号</h3><p>ui/story-bg-grid、huhutest、2026-10-12 都是仓库里真实的分支名，名称本身由创建者决定。分支标签指向该分支目前的末端提交，不代表这行的作者拥有整个分支。编号是提交的唯一标识，方便找到同一次记录。</p></article>';
}
function switchTab(next) {
  tab = next; renderScope();
  for (const b of document.querySelectorAll('[data-tab]')) { const active = b.dataset.tab === tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); }
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== tab;
  if (tab === 'timeline' && state && (!graphKey || (geometry && geometry.height !== $('#graph').scrollHeight))) renderGraph();
  if (tab === 'branches') renderBranches();
  if (tab === 'team') { renderTeam(); syncTeam(); }
}

async function resumeFollowing() {
  const focus = await rpc('session/current');
  followingSession = true;
  if (focus) await followConversation(focus, focus.revision, true);
  else { renderFollow(); error('尚未收到当前对话的项目信息，请切换一次对话后再试。'); }
}
async function syncRepositoryLock(latest) {
  const previous = repositoryLocked;
  config.repositoryLock = latest.repositoryLock;
  if (lockSaving) return;
  repositoryLocked = !!latest.repositoryLock?.dir;
  if (repositoryLocked) {
    followingSession = false; renderFollow();
    if (latest.repositoryLock.dir !== dir && !connecting) await connect(latest.repositoryLock.dir, false, 'restore');
  } else if (previous) await resumeFollowing();
  else renderFollow();
}
async function toggleRepositoryLock() {
  if (lockSaving || (!repositoryLocked && (!state || busy))) return;
  const previous = repositoryLocked, previousFollowing = followingSession;
  let saved = false;
  repositoryLocked = !previous; lockSaving = true;
  if (repositoryLocked) followingSession = false;
  renderFollow();
  try {
    const latest = await rpc('ui/repository-lock', { locked: repositoryLocked, dir });
    saved = true;
    config.repositoryLock = latest.repositoryLock;
    if (!repositoryLocked) await resumeFollowing();
    options();
  } catch (e) {
    if (saved) { error(e.message); return; }
    repositoryLocked = previous; followingSession = previousFollowing;
    if (previous && config.repositoryLock?.dir && config.repositoryLock.dir !== dir) {
      try { await connect(config.repositoryLock.dir, false, 'restore'); } catch {}
    }
    // Focus may have changed while saving; a failed lock must not leave follow paused.
    if (!previous && previousFollowing) { try { await resumeFollowing(); } catch {} }
    options(); error(e.message);
  } finally { lockSaving = false; renderFollow(); }
}
$('#repository-lock').onclick = toggleRepositoryLock;
$('#follow-session').onclick = async () => {
  if (repositoryLocked || lockSaving) return;
  try { await resumeFollowing(); } catch (e) { error(e.message); }
};
$('#pick').onclick = $('#welcome-pick').onclick = () => connect(null, true);
$('#preferences-toggle').onclick = () => showPreferences($('#preferences').hidden);
$('#close-preferences').onclick = () => showPreferences(false, true);
$('#search-toggle').onclick = () => toggleSearch($('#searchbar').hidden);
$('#close-search').onclick = () => toggleSearch(false);
$('#current-branch').onclick = () => { if (state?.head) locate(state.head); };
document.addEventListener('choice-opening', event => { if (!$('#preferences').contains(event.target)) showPreferences(false); });
let handleGesture = null, ignoreHandleClick = false;
$('#pull-handle').onpointerdown = event => {
  if (event.button !== 0 || collapseSaving) return;
  handleGesture = { id: event.pointerId, y: event.clientY };
  $('#pull-handle').setPointerCapture(event.pointerId);
};
$('#pull-handle').onpointerup = event => {
  if (!handleGesture || event.pointerId !== handleGesture.id) return;
  const distance = event.clientY - handleGesture.y; handleGesture = null;
  if (Math.abs(distance) >= 24) {
    ignoreHandleClick = true; setTimeout(() => { ignoreHandleClick = false; }, 0);
    setControlsCollapsed(distance < 0);
  }
};
$('#pull-handle').onpointercancel = () => { handleGesture = null; };
$('#pull-handle').onclick = () => { if (!ignoreHandleClick) setControlsCollapsed(!controlsCollapsed); };
document.addEventListener('pointerdown', event => {
  if (!$('#preferences').hidden && !$('#preferences').contains(event.target) && !$('#choice-menu').contains(event.target) && !$('#preferences-toggle').contains(event.target)) showPreferences(false);
});
document.addEventListener('focusin', event => {
  if (!$('#preferences').hidden && !$('#preferences').contains(event.target) && !$('#choice-menu').contains(event.target) && !$('#preferences-toggle').contains(event.target)) showPreferences(false);
});
$('#repo-select').onchange = event => { if (event.target.value) connect(event.target.value); };
$('#refresh').onclick = () => refresh(); $('#fetch').onclick = () => refresh(true);
$('#remote-select').onchange = () => { fetchSchedule.seed(dir, $('#remote-select').value, null, autoFetchMinutes * 60000); renderFetchStatus(); maybeFetch(); };
$('#auto-fetch').onchange = async event => {
  const select = event.target, minutes = Number(select.value), hadFocus = document.activeElement === select; select.disabled = true;
  try { config = await rpc('config/update', { autoFetchMinutes: minutes }); options(); maybeFetch(); }
  catch (e) { options(); error(e.message); }
  finally { select.disabled = false; if (hadFocus && document.activeElement === document.body && !$('#preferences').hidden) select.focus({ preventScroll: true }); }
};
$('#search').oninput = filterGraph;
$('#timeline-scope').onchange = () => setTimelineScope($('#timeline-scope').value);
$('#motion').onclick = async () => { try { config = await rpc('config/update', { motion: config.motion === false }); options(); } catch (e) { error(e.message); } };
$('#close-detail').onclick = closeDetail;
$('#reading-guide').onclick = showReadingGuide;
$('#retry-translation').onclick = () => translatePending(true);
$('#dirty').onclick = () => {
  openDetail('工作区改动 · ' + state.status.count + ' 项');
  $('#detail-body').innerHTML = state.status.files.map(f => '<div class="file-item"><span class="file-status">' + escapeHtml(GitLabels.fileStatus(f)) + '</span><span>' + escapeHtml(f.path) + (f.from ? ' ← ' + escapeHtml(f.from) : '') + (f.conflict ? ' · 冲突待处理' : '') + '</span></div>').join('') + (state.status.truncated ? '<p class="empty">只显示前 300 项。</p>' : '') || '<p class="empty">工作区干净。</p>';
};
$('.tabs').onclick = event => { const button = event.target.closest('[data-tab]'); if (button) switchTab(button.dataset.tab); };
$('#graph').onclick = event => {
  const row = event.target.closest('[data-sha]'); if (!row) return;
  if (controlsCollapsed) { selected = row.dataset.sha; drawGraph(); showCommit(selected); }
  else if (row.dataset.sha === selected) showCommit(selected); else select(row.dataset.sha);
};
$('#graph').onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !geometry) return;
  const i = geometry.elements.findIndex(el => el.dataset.sha === (selected || state.head));
  const next = geometry.elements[Math.max(0, Math.min(geometry.elements.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))];
  if (next) { event.preventDefault(); next.focus(); select(next.dataset.sha, true); }
};
$('#sheet').onclick = event => {
  const action = event.target.closest('[data-sheet]')?.dataset.sheet;
  if (action === 'close') select(null);
  if (action === 'detail') showCommit(selected);
  if (action === 'compare') showCompare(selected);
};
$('#branches').onclick = event => {
  const compare = event.target.closest('[data-compare]'); if (compare) return showCompare(compare.dataset.compare);
  const target = event.target.closest('[data-locate]'); if (target) locate(target.dataset.locate);
};
$('#team').oninput = () => { teamEditing = true; };
$('#team').onclick = async event => {
  const person = event.target.closest('[data-locate]'); if (person) return locate(person.dataset.locate);
  if (event.target.id !== 'save-team') return;
  const enabled = $('#share-enabled').checked, room = $('#room').value.trim(); ++teamGeneration;
  try { config = await rpc('config/update', { teamRepo: { dir, enabled, room } }); team = null; teamError = ''; teamEditing = false; renderTeam(); syncTeam(true); }
  catch (e) { error(e.message); }
};
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (!$('#preferences').hidden) showPreferences(false, true);
  else if (!$('#detail').hidden) closeDetail();
  else if (!$('#searchbar').hidden && !controlsCollapsed) toggleSearch(false);
  else if (selected) select(null);
});
const scrollTimers = new WeakMap();
document.addEventListener('scroll', event => { const el = event.target; if (!el.classList?.contains('scroll')) return; el.classList.add('is-scrolling'); clearTimeout(scrollTimers.get(el)); scrollTimers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 2000)); }, true);
GitBridge.on(async message => {
  if (message.type === 'session-focus') {
    if (!configReady) { if (!pendingFocus || message.revision > pendingFocus.revision) pendingFocus = message; return; }
    await followConversation(message.focus, message.revision); return;
  }
  if (message.type === 'repository-lock-changed') {
    try { await syncRepositoryLock(await rpc('config/read')); } catch (e) { error(e.message); }
    return;
  }
  if (message.type === 'fetch-progress' && typeof message.dir === 'string' && typeof message.remote === 'string') {
    const key = fetchSchedule.key(message.dir, message.remote);
    if (fetchSchedule.entry(message.dir, message.remote).pending) fetchProgress.set(key, message);
    if (message.dir === dir && message.remote === $('#remote-select').value) renderFetchStatus();
  }
  if (message.type === 'fetch-times-changed') {
    try { const latest = await rpc('config/read'); config.fetchTimes = latest.fetchTimes; renderFetchStatus(); } catch {}
  }
  if (message.type === 'translations-changed') {
    try { const latest = await rpc('config/read'); GitLabels.loadTranslations(latest.translationCache); repaintTranslations(); }
    catch (e) { translationError = e.message; renderTranslationStatus(); }
  }
  if (message.type === 'ui-changed') {
    try { const latest = await rpc('config/read'); config.headerCollapsed = latest.headerCollapsed; if (!collapseSaving) applyControls(config.headerCollapsed === true && !!state); } catch (e) { error(e.message); }
  }
  if (message.type === 'config-changed') {
    ++teamGeneration; team = null; teamError = ''; nextTeamAt = 0; teamFailures = 0;
    try { config = await rpc('config/read'); if (configReady) await syncRepositoryLock(config); options(); if (state && tab === 'team') renderTeam(); } catch (e) { error(e.message); }
  }
  if (message.type === 'repo-connected' && message.dir !== dir && (!activeFocus || !message.sessionId || message.sessionId === activeFocus.sessionId)) connect(message.dir);
});
setInterval(tick, 12000);
setInterval(() => { if (!document.hidden && state) { $('#sampled').textContent = '本地记录更新于 ' + age(state.sampledAt); renderFetchStatus(); if (tab === 'team') renderTeam(); } }, 15000);
let resizeTimer, lastWidth = innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state && tab === 'timeline' && innerWidth !== lastWidth) { lastWidth = innerWidth; renderGraph(); } }, 100); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); translatePending(); } });
(async () => {
  const revision = generation;
  try {
    const [latest, focus] = await Promise.all([rpc('config/read'), rpc('session/current')]);
    if (revision !== generation) return;
    config = latest; repositoryLocked = !!config.repositoryLock?.dir; configReady = true; options();
    const current = pendingFocus && (!focus || pendingFocus.revision >= focus.revision) ? pendingFocus : focus ? { focus, revision: focus.revision } : null; pendingFocus = null;
    if (repositoryLocked) {
      followingSession = false;
      if (current) await followConversation(current.focus, current.revision);
      await connect(config.repositoryLock.dir, false, 'restore');
    } else if (current) await followConversation(current.focus, current.revision);
    else if (config.lastDir) await connect(config.lastDir, false, 'restore');
  } catch (e) { configReady = true; if (revision === generation) error(e.message); }
})();
