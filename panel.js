'use strict';
const $ = s => document.querySelector(s);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = name => '<svg aria-hidden="true"><use href="#i-' + name + '"/></svg>';
const rpc = GitBridge.request;
// Interface strings come from the host language, never a plugin preference.
// A function declaration (not a const) keeps every panel script loadable on its
// own: the classic scripts share one global scope, so two const bindings of the
// same name would abort the second script.
function t(key, vars) {
  const i18n = typeof window !== 'undefined' ? window.GitI18n : null;
  return i18n ? i18n.t(key, vars) : key;
}
let translationBusy = false, translationError = '', activeCommitSubject = '';
let translationStalled = new Set();
// Keep the actual change readable while translation is pending or unavailable.
// Interface language: host uiLocale, applied before options() so GitChoices
// renders its label in the same language as the rest of the panel.
const hostLanguage = () => (typeof window !== 'undefined' && window.GitI18n ? window.GitI18n : null);
const subjectLabel = value => config.showOriginal === true ? String(value ?? '') : GitLabels.subject(value);
const fetchSchedule = new GitFetchSchedule.FetchSchedule(), fetchErrors = new Map(), fetchProgress = new Map(), fetchSuccessAt = new Map();
let autoFetchMinutes = 5, timelineScope = 'all', timelineLimit = 180;
let localFlowCollapsed = false;
let localFlowMarkup = '';
const noCommits = [];
let displaySource = null, displayFold = null, display = null, displayOutgoing = null;
let outgoingActive = false, outgoingContext = '';
// 折叠只影响显示：原始提交仍来自 state，换开关时重新构建，不重新读 Git。
function displayModel() {
  const source = timelineScope === 'current' ? state?.currentCommits || noCommits : state?.commits || noCommits;
  const fold = config.foldAuto !== false && !outgoingActive;
  const outgoing = outgoingActive ? state?.outgoingCommits : null;
  if (source !== displaySource || fold !== displayFold || outgoing !== displayOutgoing) { displaySource = source; displayFold = fold; displayOutgoing = outgoing; display = GitTimeline.build(outgoing ? GitTimeline.withOutgoing(source, outgoing) : source, { fold }); }
  return display;
}
const visibleCommits = () => displayModel().items;
// 折叠后，成员提交按它所在的那一行参与分支标签、当前提交和定位。
const rowSha = sha => displayModel().shaOf(sha);
const headSha = () => (state?.head ? rowSha(state.head) : null);
function renderScope() {
  GitChoices.set($('#timeline-scope'), [{ value: 'all', label: t('全仓库'), detail: t('所有分支的最近 180 条提交') }, { value: 'current', label: state?.detached ? t('当前提交') : t('当前分支'), detail: t('当前历史的最近 180 条提交，含已经合入的提交') }], timelineScope);
  $('#timeline-scope').hidden = tab !== 'timeline';
  $('#pull-handle .pull-label').textContent = controlsCollapsed ? t('展开工具栏') + (timelineScope === 'current' ? ' · ' + (state?.detached ? t('当前提交') : t('当前分支')) : '') : t('收起工具栏');
}
function setTimelineScope(value) {
  timelineScope = value === 'current' ? 'current' : 'all';
  selected = null; graphKey = '';
  renderScope(); if (state) render();
  $('#graph-scroll').scrollTop = 0;
}
let config = {}, state = null, dir = null, busy = false, generation = 0, tab = 'timeline', team = null, teamError = '', teamBusy = false, nextTeamAt = 0, teamFailures = 0, graphKey = '', teamEditing = false, teamGeneration = 0, connecting = false;
let activeFocus = null, lastFocusRevision = -1, followingSession = true;
// 工作目录可能是仓库的子目录；同时记住连接入口与 Git 返回的根目录。
let repositoryWorkdir = null, connectingWorkdir = null;
const workdirKey = value => typeof value === 'string' ? value.replace(value.startsWith('/') ? /\/+$/ : /[\\/]+$/, '') || value : null;
let repositoryLocked = false, lockSaving = false, configReady = false, pendingFocus = null;
let graph = null, selected = null, controlsCollapsed = false, collapseSaving = false;
const short = sha => sha ? sha.slice(0, 7) : t('尚无提交');
// Capture the worktree at render time, independent of the conversation at drop time.
function referenceAttributes(sourceDir, sha) {
  if (!sourceDir || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sha)) return '';
  const reference = t('Git 提交 ') + sha + t('（来源仓库：') + JSON.stringify(sourceDir) + '）';
  return ' draggable="true" data-commit-reference="' + escapeHtml(reference) + '"';
}
function referenceButton(sourceDir, sha) {
  const attrs = referenceAttributes(sourceDir, sha);
  return attrs ? '<button class="text-button" data-copy-reference' + attrs + ' ' + 'title="' + t('复制引用，或拖到对话输入框') + '"' + t('>复制提交引用') + '</button>' : '';
}
function age(value) {
  if (!value) return t('未知');
  const seconds = Math.max(0, (Date.now() - new Date(value).getTime()) / 1000);
  if (!Number.isFinite(seconds)) return t('未知');
  return seconds < 60 ? t('刚刚') : seconds < 3600 ? Math.floor(seconds / 60) + t(' 分钟前') : seconds < 86400 ? Math.floor(seconds / 3600) + t(' 小时前') : Math.floor(seconds / 86400) + t(' 天前');
}
// 自动同步提交是机器文案：只显示时间，不送去翻译。
function clock(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '' : String(date.getHours()).padStart(2, '0') + ':' + String(date.getMinutes()).padStart(2, '0');
}
function autoTitle(row) {
  if (row.auto?.folded) return t('自动同步 ×') + row.auto.count;
  if (config.showOriginal === true) return String(row.subject ?? '');
  const time = clock(row.date);
  return t('自动同步') + (time ? ' · ' + time : '');
}
function autoRange(row) {
  const newest = clock(row.auto?.newestDate || row.date), oldest = clock(row.auto?.oldestDate || row.date);
  if (!newest || !oldest || newest === oldest) return newest || oldest || '';
  const from = new Date(row.auto?.oldestDate || row.date), to = new Date(row.auto?.newestDate || row.date);
  const day = value => String(value.getMonth() + 1).padStart(2, '0') + '-' + String(value.getDate()).padStart(2, '0');
  return from.toDateString() === to.toDateString() ? oldest + '–' + newest : day(from) + ' ' + oldest + '–' + day(to) + ' ' + newest;
}
const refLabel = ref => GitTimeline.isAutoCommit(ref) ? autoTitle(ref) : subjectLabel(ref.subject);
// Errors raised by the background page and the Node worker carry Chinese text; a
// catalog entry translates them, and anything unknown passes through unchanged.
function localize(message) { return typeof message === 'string' && message ? t(message) : message; }
function error(message) { const text = localize(message) || ''; $('#error').textContent = text; $('#error').hidden = !text; renderAttention(); }
function renderAttention() {
  const issue = !$('#error').hidden || (config.showOriginal !== true && !!translationError) || !$('#preferences-toggle .sync-dot').hidden;
  $('#pull-handle .attention-dot').hidden = !issue;
  renderScope();
  $('#pull-handle').title = controlsCollapsed ? (issue ? t('有更新提示 · 点击或向下拖动查看') : t('点击或向下拖动，展开工具栏')) : t('点击或向上拖动，收起工具栏');
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
  $('#pull-handle .pull-label').textContent = collapsed ? t('展开工具栏') : t('收起工具栏');
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
  $('#repo-select').dataset.empty = t('选择仓库');
  GitChoices.set($('#repo-select'), [...(!dir ? [{ value: '', label: t('选择仓库'), detail: t('自动跟随项目对话，也可手动选择') }] : []), ...paths.map(p => ({ value: p, label: p.split('/').pop(), detail: p }))], dir || '');
  $('#repo-select').title = (repositoryLocked ? t('仓库已锁定 · 不随对话切换') : followingSession ? activeFocus ? t('跟随当前对话') : t('等待对话切换通知') : t('已手动选择 · 下次切换对话时恢复跟随')) + (dir ? ' · ' + dir : '');
  renderFollow();
  document.body.classList.toggle('no-motion', config.motion === false);
  $('#motion').setAttribute('aria-pressed', String(config.motion !== false));
  $('#motion').title = config.motion === false ? t('开启路径流光，方便追踪选中提交的历史') : t('关闭路径流光');
  $('#auto-sync').setAttribute('aria-pressed', String(config.foldAuto !== false));
  $('#auto-sync').title = config.foldAuto === false ? t('已关闭折叠 · 每条自动同步单独显示') : t('已开启折叠 · 连续自动同步合成一行，点击可看快照');
  $('#show-original').setAttribute('aria-pressed', String(config.showOriginal === true));
  const nextMinutes = GitFetchSchedule.minutes(config.autoFetchMinutes);
  if (nextMinutes !== autoFetchMinutes) fetchSchedule.reconfigure(nextMinutes * 60000);
  autoFetchMinutes = nextMinutes;
  GitChoices.set($('#auto-fetch'), [0, 1, 5, 10].map(n => ({ value: String(n), label: n ? t('每 ') + n + t(' 分钟') : t('仅手动') })), String(autoFetchMinutes));
  applyControls(config.headerCollapsed === true && !!state);
  renderFetchStatus();
}
function untranslatedSubjects() {
  if (config.showOriginal === true || !state) return [];
  // Match what each page actually renders; branch labels on the graph do not
  // display ref subjects, and hidden pages must not keep feeding the queue.
  const candidates = !$('#detail').hidden ? [{ subject: activeCommitSubject }]
    : tab === 'branches' ? [...branchRefs(false), ...branchRefs(true)]
    : tab === 'team' ? (config.teamUrl && config.teamRepos?.[dir]?.enabled ? team?.members || [] : [])
    : [...visibleCommits()];
  const backupsVisible = (workspaceView && !$('#detail').hidden) || (tab === 'timeline' && $('#detail').hidden && !$('#local-flow').hidden && !localFlowCollapsed);
  if (backupsVisible) for (const stash of state.stashes || []) {
    const source = GitLabels.stashInfo(stash).source;
    if (source) candidates.push({subject:source});
  }
  // 构建快照的标题是机器文案，不值得花一次模型调用去翻译。
  return [...new Set(candidates.filter(c => !GitTimeline.isAutoCommit(c)).map(c => c.subject).filter(s => s && s.length <= 1500 && !translationStalled.has(s) && GitLabels.needsTranslation(s)))];
}
function renderTranslationStatus() {
  const missing = untranslatedSubjects().length;
  const stalled = config.showOriginal !== true && state ? translationStalled.size : 0;
  $('#translation-row').hidden = !missing && !stalled;
  $('#translation-status').textContent = !missing && stalled ? stalled + t(' 条标题暂时无法翻译') : localize(translationError) || (translationBusy ? t('正在生成中文说明…') : t('等待生成中文说明…'));
  $('#retry-translation').hidden = !translationError && !(stalled && !missing);
  $('#retry-translation').disabled = translationBusy; renderAttention();
}
function repaintTranslations() {
  if (!state) return;
  renderLocalFlow();
  if (workspaceView && !$('#detail').hidden) for (const [index,stash] of workspaceView.stashes.entries()) {
    const info = GitLabels.stashInfo(stash);
    const title = $('#detail-body').querySelector('[data-stash-title="' + index + '"]');
    if (title) title.textContent = config.showOriginal === true ? info.raw : info.title;
    const subtitle = $('#detail-body').querySelector('[data-stash-subtitle="' + index + '"]');
    if (subtitle) { subtitle.textContent = info.subtitle; subtitle.hidden = config.showOriginal === true || !info.subtitle; }
  }
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
    if (title) {
      title.textContent = subjectLabel(activeCommitSubject);
      const original = $('#detail-body .original-subject');
      if (subjectLabel(activeCommitSubject) === activeCommitSubject) original?.remove();
      else if (!original) title.insertAdjacentHTML('afterend', originalSubject(activeCommitSubject));
    }
  }
  renderTranslationStatus();
}
async function translatePending(retry = false) {
  if (translationBusy || (translationError && !retry) || document.hidden) return;
  if (retry === true) { translationStalled.clear(); translationError = ''; }
  const pending = untranslatedSubjects();
  if (!pending.length) { renderTranslationStatus(); return; }
  const subjects = []; let size = 0;
  for (const source of pending) {
    if (subjects.length === 20 || size + source.length > 16000) break;
    subjects.push(source); size += source.length;
  }
  const requested = [...subjects];
  let progressed = false;
  translationBusy = true; translationError = ''; const revision = generation, requestDir = dir, requestOriginal = config.showOriginal;
  renderTranslationStatus();
  try {
    const result = await rpc('text/translate', { subjects, retry });
    GitLabels.loadTranslations(result?.translations);
    if (revision === generation && requestDir === dir && requestOriginal === config.showOriginal) {
      for (const source of requested) {
        const value = result?.translations && Object.hasOwn(result.translations,source) ? result.translations[source] : null;
        if (typeof value === 'string' && value.trim() && !GitLabels.needsTranslation(source)) progressed = true;
        else translationStalled.add(source);
      }
    }
    if (revision === generation && requestDir === dir) repaintTranslations();
  } catch (e) { if (revision === generation && requestDir === dir) { translationError = e.message; repaintTranslations(); } }
  finally { translationBusy = false; renderTranslationStatus(); }
  if (!translationError && progressed) return translatePending();
}
function renderFollow() {
  $('#follow-session').disabled = repositoryLocked || lockSaving;
  $('#follow-session').setAttribute('aria-pressed', String(!repositoryLocked && followingSession));
  const label = repositoryLocked ? t('仓库已锁定 · 先关闭右侧锁定按钮，再跟随对话') : followingSession ? activeFocus ? t('正在跟随对话 · 点击重新读取项目') : t('等待对话切换 · 也可手动选择仓库') : t('已手动选择 · 点击恢复跟随对话，下次切换对话也会自动恢复');
  $('#follow-session').title = label; $('#follow-session').setAttribute('aria-label', label);
  $('#repository-lock').disabled = lockSaving || (!repositoryLocked && (!state || busy));
  $('#repository-lock').setAttribute('aria-pressed', String(repositoryLocked));
  const lockLabel = repositoryLocked ? t('已锁定仓库 · 点击解锁并恢复跟随对话') : t('锁定当前仓库 · 切换对话时保持此仓库');
  $('#repository-lock').title = state || repositoryLocked ? lockLabel : t('选择仓库后可以锁定');
  $('#repository-lock').setAttribute('aria-label', lockLabel);
  $('#repository-lock use').setAttribute('href', repositoryLocked ? '#i-lock' : '#i-unlock');
}
function clearRepository(title, message) {
  translationStalled.clear();
  modelSummary = null; modelSummaryContext = '';
  translationError = '';
  outgoingActive = false; outgoingContext = ''; workspaceView = null;
  $('#tracking-row').hidden = true; $('#stash-pill').hidden = true; $('#local-flow').hidden = true;
  ++generation; ++teamGeneration; ++detailRevision;
  state = null; dir = null; busy = false; connecting = false; selected = null;
  repositoryWorkdir = null; connectingWorkdir = null;
  team = null; teamError = ''; teamEditing = false; nextTeamAt = 0; teamFailures = 0;
  activeCommitSubject = ''; graphKey = ''; timelineScope = 'all'; localFlowCollapsed = false;
  GitChoices.close(); showPreferences(false); $('#detail').hidden = true; $('#sheet').hidden = true;
  $('#searchbar').hidden = true; $('#search-toggle').setAttribute('aria-expanded', 'false'); $('#search').value = '';
  $('#graph').replaceChildren(); $('#branches').replaceChildren(); $('#team').replaceChildren();
  $('#translation-row').hidden = true; $('#refresh').disabled = true;
  $('#fetch').disabled = true; $('#remote-select').disabled = true;
  $('#preferences-toggle .sync-dot').hidden = true; $('#preferences-toggle').title = t('远端与显示');
  $('#welcome-title').textContent = title; $('#welcome-message').textContent = message;
  applyControls(false); error(''); options(); render();
}
let toastTimer, lastToastRevision = -1;
function showSessionToast(message) {
  if (!activeFocus || lastToastRevision === lastFocusRevision) return;
  lastToastRevision = lastFocusRevision;
  clearTimeout(toastTimer);
  const toast = $('#session-toast');
  toast.hidden = true;
  void toast.offsetWidth; // Restart the entrance animation even for consecutive warnings.
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 6200);
  if (activeFocus?.sessionId) {
    void rpc('ui/repository-warning', { sessionId: activeFocus.sessionId, revision: lastFocusRevision,
      text: '⚠ ' + message }).catch(() => {}); // The panel also works on hosts without composer contributions.
  }
}
async function followConversation(focus, revision = focus?.revision, force = false) {
  if (!Number.isInteger(revision) || revision < lastFocusRevision || (revision === lastFocusRevision && !force)) return;
  if (revision !== lastFocusRevision) {
    clearTimeout(toastTimer);
    $('#session-toast').hidden = true;
  }
  lastFocusRevision = revision; activeFocus = focus;
  if (focus && !focus.workdir) showSessionToast('当前对话没有关联本机目录。');
  if (repositoryLocked) {
    followingSession = false;
    renderFollow();
    if (focus?.workdir && workdirKey(focus.workdir) !== workdirKey(dir)) {
      try {
        const result = await rpc('session/connect', { revision, rootOnly: true });
        if (revision === lastFocusRevision && repositoryLocked && result?.outsideRepository)
          showSessionToast('当前对话不在 Git 仓库中。流线仍显示锁定的仓库。');
      } catch { /* An unreadable directory does not establish that it is outside Git. */ }
    }
    return;
  }
  followingSession = true;
  const nextWorkdir = workdirKey(focus?.workdir);
  // 换的是对话，仓库没换：保留图、滚动位置、选中项、搜索和详情。
  // 同项目的首次读取尚未完成时，也复用在途请求，不重新清屏或重复读 Git。
  if (nextWorkdir && ((connecting && nextWorkdir === connectingWorkdir) ||
      (state && !connecting && (nextWorkdir === workdirKey(dir) || nextWorkdir === repositoryWorkdir)))) {
    renderFollow();
    if (force && !connecting) await refresh();
    return;
  }
  clearRepository(focus?.workdir ? t('正在读取对话项目') : t('这个对话未关联本地项目'), focus?.workdir ? t('读取仓库后，流线会显示在这里。') : t('可以手动选择仓库；切换到项目对话后会继续自动跟随。'));
  if (focus?.workdir) await connect(focus.workdir, false, 'follow', focus);
}
async function connect(nextDir, pick = false, mode = 'manual', focus = activeFocus) {
  if (mode === 'manual' && lockSaving) return;
  const previousFollowing = followingSession;
  if (mode === 'manual') followingSession = false;
  GitChoices.close(); showPreferences(false); renderFollow();
  if (!pick) clearRepository(t('正在读取仓库'), t('读取完成后，流线会显示在这里。'));
  const revision = ++generation; ++teamGeneration; ++detailRevision;
  connectingWorkdir = workdirKey(nextDir);
  activeCommitSubject = ''; $('#detail').hidden = true; connecting = true; busy = true; error(''); $('#refresh').disabled = true;
  try {
    const data = await rpc(mode === 'follow' ? 'session/connect' : pick ? 'repo/pick' : 'repo/connect', mode === 'follow' ? { revision: focus.revision } : pick ? {} : { dir: nextDir });
    if (revision !== generation) return;
    if (mode === 'follow' && data?.outsideRepository) {
      $('#welcome-title').textContent = t('当前对话不在 Git 仓库中');
      $('#welcome-message').textContent = t('可以手动选择仓库，或切换到仓库中的对话。');
      showSessionToast('当前对话不在 Git 仓库中。');
      return;
    }
    if (!data) { followingSession = previousFollowing; options(); render(); return; }
    const latest = await rpc('config/read');
    if (revision !== generation) return;
    if (dir !== data.dir) translationStalled.clear();
    if (dir !== data.dir || state?.head !== data.head || state?.branch !== data.branch) { modelSummary = null; modelSummaryContext = ''; }
    dir = data.dir; state = data; config = latest; repositoryLocked = !!config.repositoryLock?.dir; if (repositoryLocked) followingSession = false; timelineScope = 'all'; timelineLimit = 180; localFlowCollapsed = false; selected = null;
    repositoryWorkdir = workdirKey(pick ? data.dir : nextDir);
    teamEditing = false; team = null; teamError = ''; nextTeamAt = 0; graphKey = '';
    options(); render(); syncTeam();
  } catch (e) {
    if (revision === generation) {
      $('#welcome-title').textContent = mode === 'follow' ? t('这个对话的仓库暂时无法读取') : t('仓库暂时无法读取');
      $('#welcome-message').textContent = t('可以选择其他仓库，或点击左上角分支图标重新跟随对话。');
      error(e.message);
    }
  }
  finally {
    if (revision === generation) {
      busy = false; connecting = false; $('#refresh').disabled = !state; $('#fetch').disabled = !state?.remotes.length; $('#remote-select').disabled = !state?.remotes.length;
      connectingWorkdir = null;
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
    const result = await rpc(fetchRemote ? 'repo/fetch' : 'repo/snapshot', { dir: requestedDir, remote, limit: timelineLimit });
    success = true;
    if (fetchRemote) { fetchErrors.delete(fetchSchedule.key(requestedDir, remote)); fetchSuccessAt.set(fetchSchedule.key(requestedDir, remote), result.fetchCompletedAt || new Date().toISOString()); }
    if (revision === generation) { state = result; render(); }
  } catch (e) {
    if (fetchRemote) fetchErrors.set(fetchSchedule.key(requestedDir, remote), e.message);
    if (revision === generation && !automatic) error(e.message + (state ? t(' 下方保留的是上次读取结果。') : ''));
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
async function loadMoreHistory() {
  if (!dir || busy || !(timelineScope === 'current' ? state?.currentTruncated : state?.truncated)) return;
  busy = true; renderFollow(); const revision = generation, requestedDir = dir;
  try {
    const result = await rpc('repo/snapshot', { dir: requestedDir, limit: timelineLimit + 180 });
    if (revision === generation && requestedDir === dir) { timelineLimit += 180; state = result; render(); }
  } catch (e) { if (revision === generation) error(e.message); }
  finally { if (revision === generation) { busy = false; renderFollow(); } }
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
  $('#preferences-toggle').title = showFailure ? t('远端更新失败 · 查看原因与重试') : t('远端与显示');
  label.title = showFailure ? failure + t('；保留上次记录，可手动重试。') : t('正在获取时显示真实下载进度；面板隐藏时暂停下一次自动获取，不会合并代码。');
  const completedAt = fetchSuccessAt.get(fetchSchedule.key(dir, remote)) || config.fetchTimes?.[fetchSchedule.key(dir, remote)];
  $('#fetched').textContent = completedAt ? t('上次成功更新：') + age(completedAt) : state.fetchedAt ? t('缓存文件更新于 ') + age(state.fetchedAt) : t('尚未获取远端记录');
  $('#fetched').title = completedAt ? t('这个远端上次成功完成获取的时间。') : t('缓存文件也可能在失败获取或其他工具操作时变化，不代表远端更新成功。');
  if (entry.pending) {
    const progress = fetchProgress.get(fetchSchedule.key(dir, remote));
    const phases = { counting: t('检查远端记录'), compressing: t('远端准备文件'), receiving: t('下载新文件'), resolving: t('整理新记录'), reading: t('刷新本地视图') };
    const phase = phases[progress?.phase] || (failure ? t('正在重新连接远端') : t('连接远端'));
    const percent = Number.isFinite(progress?.percent) ? ' ' + progress.percent + '%' : '…';
    const size = progress?.bytes > 0 ? ' · ' + (progress.bytes / 1048576).toFixed(1) + ' MB' : '';
    label.textContent = phase + percent + size;
  } else if (!autoFetchMinutes) label.textContent = failure ? t('更新失败 · 请重试') : t('自动更新已关闭');
  else {
    const wait = Math.max(0, Math.ceil((entry.next - performance.now()) / 60000));
    label.textContent = (failure ? t('更新失败 · ') : '') + (wait ? wait + t(' 分钟后') + (failure ? t('重试') : t('更新')) : t('即将更新'));
  }
  renderAttention();
}

function renderStatus() {
  const context = JSON.stringify([state.dir, state.branch, state.upstream]);
  if (context !== outgoingContext) { outgoingActive = false; outgoingContext = context; }
  if (!state.upstream || state.upstreamExists === false || !state.ahead || !state.outgoingCommits?.length) outgoingActive = false;
  const branch = state.branch || (state.unborn ? t('尚无提交') : t('游离提交 ') + short(state.head));
  $('#current-branch').textContent = branch;
  $('#current-branch').title = t('当前分支：') + branch + t(' · 点击定位');
  $('#current-branch').setAttribute('aria-label', t('定位当前分支 ') + branch);
  $('#sampled').textContent = t('本地记录更新于 ') + age(state.sampledAt);
  $('#tracking').textContent = state.unborn ? t('完成首次提交后，流线会显示在这里。') : state.upstream ? t('跟踪分支：') + state.upstream + (state.upstreamExists ? '' : t(' · 远端记录已缺失')) : t('未设置跟踪分支，暂时无法比较待推送和待拉取数量。');
  const dirty = $('#dirty'), count = state.status.count;
  dirty.className = 'pill ' + (count ? 'warn' : 'good');
  dirty.innerHTML = count ? '<b>' + count + '</b>' + t(' 个改动') + (state.status.conflicts ? t(' · 冲突 ') + state.status.conflicts : '') : t('无改动');
  dirty.title = count ? count + t(' 个文件尚未提交，点击查看') : t('工作区没有未提交的文件');
  const ahead = $('#ahead'), behind = $('#behind');
  ahead.hidden = !state.upstream || state.upstreamExists === false; behind.hidden = !state.behind;
  ahead.disabled = !state.ahead || !state.outgoingCommits?.length;
  ahead.setAttribute('aria-pressed', String(outgoingActive));
  ahead.className = 'pill good'; ahead.innerHTML = '↑ <b>' + (state.ahead || 0) + '</b>'; ahead.title = (state.ahead || 0) + t(' 个提交待推送') + (outgoingActive ? t(' · 再点取消高亮') : t(' · 点击定位全部'));
  ahead.setAttribute('aria-label', ahead.title);
  behind.className = 'pill warn'; behind.innerHTML = '↓ <b>' + (state.behind || 0) + '</b>'; behind.title = (state.behind || 0) + t(' 个提交待拉取');
  $('#tracking-row').hidden = false;
  const tracking = $('#branch-tracking'); tracking.hidden = false;
  tracking.textContent = state.upstream ? t('上游 ') + state.upstream + (state.upstreamExists === false ? t(' · 远端记录缺失') : '') : t('未设置上游');
  tracking.title = state.upstream ? t('相对上游的待推送数量；远端状态以最近获取为准') : t('设置上游后可查看待推送数量');
  const stashes = state.stashes || [];
  $('#stash-pill').hidden = !stashes.length;
  $('#stash-pill').innerHTML = t('备份 ') + '<b>' + stashes.length + '</b>';
  renderRemote();
}
function renderRemote() {
  const remoteSelected = $('#remote-select').value;
  $('#remote-select').dataset.empty = t('未配置');
  GitChoices.set($('#remote-select'), state.remotes.map(r => ({ value: r.name, label: r.name, detail: r.url })), remoteSelected);
  $('#remote-select').disabled = !state.remotes.length || (busy && fetchSchedule.entry(dir, remoteSelected || '').pending);
  $('#fetch').disabled = !state.remotes.length || busy;
  $('#fetched').textContent = state.remotes.length ? (state.fetchedAt ? t('上次获取：') + age(state.fetchedAt) : t('尚未获取远端记录')) : t('这个仓库还没有配置远端。');
  $('#fetched').title = t('分支页显示已获取的远端记录；点击「立即更新」从服务器重新获取。');
  renderFetchStatus();
}
function render() {
  $('#welcome').hidden = !!state; $('#workspace').hidden = !state;
  $('#overview').hidden = !state; $('#viewbar').hidden = !state; $('#pull-handle').hidden = !state;
  $('#preferences-toggle').disabled = !state;
  if (!state) return;
  syncModelSummaryContext();
  if (workspaceView && (workspaceView.head !== state.head || workspaceView.branch !== state.branch)) closeDetail();
  renderStatus(); renderScope();
  renderLocalFlow();
  renderModelSummary();
  if (state.unstable) error(t('仓库正在被其他操作更新，当前快照可能变化，请稍后刷新。'));
  $('#branch-count').textContent = state.refs.length;
  const key = JSON.stringify([state.dir, state.head, state.refs, timelineScope, outgoingActive, state.outgoingTruncated, state.ahead, visibleCommits()]);
  if (key !== graphKey) {
    graphKey = key;
    // 开关折叠后选中项可能落进行号里：能跟就跟过去，跟不上才取消。
    if (selected && !visibleCommits().some(c => c.sha === rowSha(selected))) selected = null;
    else if (selected) selected = rowSha(selected);
    renderGraph();
  }
  if (tab === 'branches') renderBranches();
  if (tab === 'team') renderTeam();
  filterGraph();
  renderTranslationStatus(); translatePending();
}

// 同名的本地分支和各远端分支合成一枚标签，减少每行的字数。
function refGroups(sha) {
  const groups = new Map();
  for (const r of state.refs.filter(r => rowSha(r.sha) === sha)) {
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
  const title = [g.local ? t('本地分支 ') + g.name : null, ...g.remotes.map(r => t('远端记录（本机缓存） ') + r)].filter(Boolean).join('\n');
  return '<span class="chip ' + (g.local ? 'local c' + lane : '') + (here ? ' here' : '') + '" title="' + escapeHtml(title) + '">' + (g.local ? '' : icon('cloud')) + '<span>' + escapeHtml(g.name) + '</span>' + (g.local && g.remotes.length ? icon('cloud') : '') + '</span>';
}
function chips(row, limit) {
  const groups = refGroups(row.sha);
  let html = groups.slice(0, limit).map(g => chip(g, row.color)).join('');
  if (groups.length > limit) html += '<span class="chip more" title="' + escapeHtml(groups.slice(limit).map(g => g.name).join('\n')) + '">+' + (groups.length - limit) + '</span>';
  if (row.sha === headSha() && !groups.some(g => g.local?.full === 'refs/heads/' + state.branch)) html = '<span ' + 'class="' + 'chip here' + '"' + '>' + '<span>' + t('当前提交') + '</span>' + '</span>' + html;
  return html;
}

let geometry = null;
function renderGraph() {
  const host = $('#graph');
  const commits = visibleCommits();
  if (!commits.length) { graph = null; geometry = null; host.innerHTML = '<p class="empty">' + (timelineScope === 'current' ? t('当前分支尚无提交。') : t('首次提交后，分支故事从这里开始。')) + '</p>'; $('#graph-foot').textContent = ''; $('#load-more').hidden = true; renderSheet(); return; }
  graph = GitGraph.layout(commits);
  const width = host.clientWidth || innerWidth;
  const spacing = Math.max(13, Math.min(18, (width * 0.42 - 22) / graph.lanes));
  const x = lane => 22 + lane * spacing;
  host.innerHTML = graph.rows.map(row => {
    const head = row.sha === headSha(), folded = !!row.auto?.folded;
    const hint = folded ? t('连续 ') + row.auto.count + t(' 条自动同步快照，点击挑选一条查看改动') : row.auto ? t('自动同步快照 · 提交作者：') + row.author : t('提交作者：') + row.author + t('（提交时填写的 Git 姓名，不是账号认证）');
    const when = folded ? autoRange(row) : age(row.date);
    return '<button class="commit-row' + (head ? ' head' : '') + (row.auto ? ' auto' : '') + (folded ? ' folded' : '') + '"' + referenceAttributes(dir, row.sha) + ' data-sha="' + row.sha + '" title="' + escapeHtml(row.auto ? row.subject : subjectLabel(row.subject)) + '"><div class="commit-title">' + escapeHtml(row.auto ? autoTitle(row) : subjectLabel(row.subject)) + '</div><div class="commit-meta">' + chips(row, 2) + '<span class="author" title="' + escapeHtml(hint) + '">' + escapeHtml(row.author || '') + '</span><span class="dot">·</span><span class="when">' + escapeHtml(when || '') + '</span></div></button>';
  }).join('');
  const elements = [...host.querySelectorAll('.commit-row')];
  elements.forEach((el, i) => el.style.setProperty('--indent', Math.round(x(graph.reach[i]) + 16 - 8) + 'px'));
  geometry = { x, y: elements.map(el => el.offsetTop + 20), height: host.scrollHeight, elements };
  drawGraph();
  const folded = displayModel().folded;
  $('#graph-foot').textContent = t('仓库历史 · ') + (timelineScope === 'current' ? (state.detached ? t('当前提交') : t('当前分支')) : t('全仓库')) + ' · ' + commits.length + t(' 条提交') + (folded ? t(' · 已折叠 ') + folded + t(' 条自动同步') : '') + ((timelineScope === 'current' ? state.currentTruncated : state.truncated) ? t(' · 虚线连接更早的记录') : t(' · 点击看摘要，再点查看改动'));
  filterGraph(); renderSheet();
  const canLoadMore = timelineScope === 'current' ? state.currentTruncated : state.truncated;
  $('#load-more').hidden = !canLoadMore || busy;
  $('#load-more').textContent = t('加载更早的提交（当前 ') + commits.length + t(' 条）');
  if (outgoingActive) $('#graph-foot').textContent += t(' · 已突出 ') + state.outgoingCommits.length + t(' 条待推送（含窗口外记录，自动同步暂时逐条展开）') + (state.outgoingTruncated ? t(' · 仅加载前 ') + state.outgoingCommits.length + t(' 条，共 ') + state.ahead + t(' 条待推送') : '');
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
  const { x, y, height } = geometry, focus = selected || headSha();
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
    const here = row.sha === headSha();
    if (here || row.sha === selected) svg += '<circle class="node-ring c' + row.color + '" cx="' + cx + '" cy="' + cy + '" r="' + (here ? 10 : 9) + '"/>';
    svg += '<circle class="node c' + row.color + (row.parents.length > 1 ? ' merge' : '') + '" cx="' + cx + '" cy="' + cy + '" r="' + (row.parents.length > 1 ? 4.6 : 5.2) + '"/>';
  }
  $('#graph').querySelector(':scope > svg')?.remove();
  $('#graph').insertAdjacentHTML('beforeend', svg + '</svg>');
  for (const el of geometry.elements) el.classList.toggle('selected', el.dataset.sha === selected);
}
function filterGraph() {
  if (!graph) return;
  const q = $('#search').value.trim().toLowerCase();
  const outgoingShas = new Set(outgoingActive ? (state.outgoingCommits || []).map(c => c.sha) : []);
  geometry.elements.forEach((el, i) => {
    const c = graph.rows[i];
    const haystack = [c.sha, c.subject, c.auto ? t('自动同步 Maker TapCode Rollback') + (c.auto.count > 1 ? t(' 折叠 ') + c.auto.count + t(' 条') : '') : GitLabels.subject(c.subject), c.author, ...state.refs.filter(r => rowSha(r.sha) === c.sha).map(r => r.name)].join(' ').toLowerCase();
    const members = c.auto?.members || [c];
    const outgoing = members.some(m => outgoingShas.has(m.sha));
    el.classList.toggle('outgoing-match', outgoing);
    el.classList.toggle('dimmed', !outgoing && !!q && !haystack.includes(q));
    el.classList.toggle('search-match', !!q && haystack.includes(q));
  });
}
function select(sha, scroll = false) {
  selected = sha; drawGraph(); renderSheet();
  const el = sha && geometry?.elements.find(el => el.dataset.sha === sha);
  if (el) el.scrollIntoView({ block: scroll ? 'center' : 'nearest', behavior: 'smooth' });
}
function originalSubject(subject) {
  return subjectLabel(subject) !== subject ? '<details ' + 'class="' + 'original-subject' + '"' + '>' + '<summary>' + t('查看提交原文') + '</summary>' + '<p>' + escapeHtml(subject) + '</p></details>' : '';
}
function renderSheet() {
  const sheet = $('#sheet'), row = graph?.rows.find(r => r.sha === selected);
  sheet.hidden = !row;
  if (!row) return;
  const refs = refGroups(row.sha), head = row.sha === headSha();
  if (row.auto?.folded) {
    // 折叠行不是一次真实提交，列出它包含的快照，而不是显示一份假补丁。
    sheet.innerHTML = '<div ' + 'class="' + 'sheet-head' + '"' + '>' + '<div ' + 'class="' + 'sheet-title' + '"' + '>' + t('自动同步 · ') + row.auto.count + t(' 条提交') + '</div>' + '<button ' + 'class="' + 'icon-button' + '"' + ' ' + 'data-sheet="' + 'close' + '"' + ' ' + 'title="' + t('关闭') + '"' + ' ' + 'aria-label="' + t('关闭') + '"' + '>' + icon('close') + '</button></div>' +
      '<div ' + 'class="' + 'sheet-meta' + '"' + '>' + '<span>' + t('自动同步快照') + '</span>' + '<span>' + escapeHtml(autoRange(row)) + '</span>' + (head ? '<span>' + t('当前提交') + '</span>' : '') + '</div>' +
      (refs.length ? '<div class="sheet-refs">' + chips(row, 6) + '</div>' : '') +
      '<p ' + 'class="' + 'auto-note' + '"' + '>' + t('每次构建都会留下一条快照，默认折成一行。点任意一条查看它的改动；不想折叠可以在「远端与显示」里关闭。') + '</p>' +
      '<div class="auto-list">' + row.auto.members.map(m => '<button class="auto-item"' + referenceAttributes(dir, m.sha) + ' data-commit="' + m.sha + '" title="' + escapeHtml(m.subject) + '"><span class="mono">' + short(m.sha) + '</span><span class="auto-time">' + escapeHtml(clock(m.date)) + '</span></button>').join('') + '</div>';
    return;
  }
  sheet.innerHTML = '<div class="sheet-head"><div class="sheet-title">' + escapeHtml(row.auto ? autoTitle(row) : subjectLabel(row.subject)) + '</div>' + '<button ' + 'class="' + 'icon-button' + '"' + ' ' + 'data-sheet="' + 'close' + '"' + ' ' + 'title="' + t('关闭') + '"' + ' ' + 'aria-label="' + t('关闭') + '"' + '>' + icon('close') + '</button></div>' +
    '<div ' + 'class="' + 'sheet-meta' + '"' + '>' + '<span>' + t('提交作者：') + escapeHtml(row.author) + '</span><span>' + age(row.date) + '</span>' + '<span ' + 'class="' + 'mono' + '"' + ' ' + 'title="' + t('提交编号：这条记录的唯一标识') + '"' + '>' + t('编号 ') + short(row.sha) + '</span>' + (row.parents.length > 1 ? '<span>' + t('合并提交') + '</span>' : '') + (row.auto ? '<span>' + t('构建自动生成') + '</span>' : '') + '</div>' +
    (refs.length || head ? '<div class="sheet-refs">' + chips(row, 6) + '</div>' : '') +
    (row.auto ? '' : originalSubject(row.subject)) + '<div ' + 'class="' + 'sheet-actions' + '"' + '>' + '<button ' + 'class="' + 'main' + '"' + ' ' + 'data-sheet="' + 'detail' + '"' + ' ' + 'title="' + t('查看这次提交修改了哪些文件和代码') + '"' + '>' + t('查看改动') + '</button>' + referenceButton(dir, row.sha) + (head ? '' : '<button ' + 'data-sheet="' + 'compare' + '"' + ' ' + 'title="' + t('只查看提交数量和文件差异，不执行合并或切换') + '"' + '>' + t('和当前分支比较') + '</button>') + '</div>';
}

function branchRefs(remote) { return (state?.refs || []).filter(r => r.remote === remote); }
function renderBranches() {
  let html = '';
  for (const remote of [false, true]) {
    const refs = branchRefs(remote);
    html += '<div class="section-label">' + (remote ? t('远端分支（本机缓存）') : t('本地分支')) + '<span>' + refs.length + '</span></div>';
    for (const r of refs) {
      const current = r.full === 'refs/heads/' + state.branch;
      const worktrees = state.worktrees.filter(w => w.branch === r.name && !r.remote);
      html += '<div class="branch-item"><span class="branch-dot' + (remote ? '' : ' local') + '"></span><div class="branch-main"><div class="branch-name"><span>' + escapeHtml(r.name) + '</span>' + (current ? '<span ' + 'class="' + 'chip here' + '"' + '>' + '<span>' + t('当前') + '</span>' + '</span>' : '') + '</div><div class="branch-description" title="' + escapeHtml(refLabel(r)) + '">' + escapeHtml(refLabel(r)) + '</div><div class="branch-meta">' + escapeHtml(r.author) + ' · ' + age(r.date) + (worktrees.length ? t(' · 已在 ') + worktrees.length + t(' 个本机工作区检出') : '') + '</div></div><div class="branch-actions"><button class="text-button" data-locate="' + r.sha + '" ' + 'title="' + t('在提交图中找到分支指向的最新提交') + '"' + t('>定位') + '</button>' + (current ? '' : '<button class="text-button" data-compare="' + escapeHtml(r.full) + '" ' + 'title="' + t('查看与当前分支的差距和文件差异，不执行合并或切换') + '"' + t('>比较') + '</button>') + '</div></div>';
    }
  }
  const tracking = '<div class="branch-tracking">' + escapeHtml(state.upstream ? t('当前分支上游 ') + state.upstream + (state.upstreamExists === false ? t(' · 远端记录缺失') : '') : t('当前分支未设置上游')) + (state.upstream && state.upstreamExists !== false ? ' · <button class="text-button" data-outgoing aria-pressed="' + outgoingActive + '"' + (!state.ahead || !state.outgoingCommits?.length ? ' disabled' : '') + '>↑ ' + (state.ahead || 0) + t(' 待推送') + '</button>' : '') + '</div>';
  $('#branches').innerHTML = tracking + html;
}
function toggleOutgoing() {
  if (!state?.upstream || state.upstreamExists === false || !state.ahead || !state.outgoingCommits?.length) return;
  outgoingActive = !outgoingActive; selected = null; graphKey = '';
  if (outgoingActive) { $('#search').value = ''; error(''); }
  switchTab('timeline'); render();
  if (outgoingActive) geometry?.elements.find(el => el.classList.contains('outgoing-match'))?.scrollIntoView({ block: 'center', behavior: config.motion === false ? 'auto' : 'smooth' });
}
function locate(sha) {
  // 折叠后真正的提交编号不是一行，先换到它所在的那一行再定位。
  if (!visibleCommits().some(c => c.sha === rowSha(sha))) {
    if (state.commits.some(c => c.sha === sha)) setTimelineScope('all');
    else if (state.currentCommits?.some(c => c.sha === sha)) setTimelineScope('current');
    else { error(t('这个提交不在当前可显示的最近 180 条记录里，暂时没法在流线上定位。')); return; }
  }
  error(''); switchTab('timeline'); select(rowSha(sha), true);
}
function renderTeam() {
  if (!$('#team-setup')) $('#team').innerHTML = '<div id="team-worktrees"></div><div id="team-setup"></div><div id="team-live"></div>';
  const cfg = config.teamRepos?.[dir] || {};
  let html = '<div ' + 'class="' + 'section-label' + '"' + '>' + t('同机工作区') + '<span>' + state.worktrees.length + '</span></div>';
  for (const w of state.worktrees) html += '<div class="worktree"><div>' + escapeHtml(w.branch || t('未检出分支')) + ' <span class="mono muted">' + short(w.sha) + '</span></div><div class="path">' + escapeHtml(w.path) + '</div></div>';
  html += '<div ' + 'class="' + 'section-label' + '"' + '>' + t('队友状态') + '<span>' + t('由队友插件上报') + '</span>' + '</div>';
  $('#team-worktrees').innerHTML = html; html = '';
  if (!config.teamUrl) {
    html += '<div ' + 'class="' + 'team-intro' + '"' + '>' + '<p>' + t('接入团队服务后，可以看到队友正在用的分支、还没推送的提交和改动数量。') + '</p>' + '<p>' + t('在「插件 → Git 流线 → 设置」填写服务地址和访问令牌，队友也要连接同一个服务。') + '</p>' + '<p ' + 'class="' + 'small' + '"' + '>' + t('提交作者不代表当前分支的使用者；远端分支请看「分支」页。') + '</p>' + '</div>';
    if (!teamEditing) $('#team-setup').innerHTML = html; html = '';
  } else {
    html += '<div class="team-control"><label><input id="share-enabled" type="checkbox" ' + (cfg.enabled ? 'checked' : '') + '>' + t('共享当前仓库的状态') + '</label>' + '<input ' + 'type="' + 'text' + '"' + ' ' + 'id="' + 'room' + '"' + ' ' + 'maxlength="' + '120' + '"' + ' ' + 'aria-label="' + t('团队项目代号') + '"' + ' ' + 'placeholder="' + t('团队项目代号，留空按默认远端识别') + '"' + ' ' + 'value="' + '' + escapeHtml(cfg.room || '') + '">' + '<div ' + 'class="' + 'small' + '"' + '>' + t('使用各自派生仓库协作时，大家填同一个代号。只分享昵称、分支、提交摘要和改动数量。') + '</div>' + '<button ' + 'id="' + 'save-team' + '"' + ' ' + 'class="' + 'text-button' + '"' + '>' + t('保存并同步') + '</button>' + '</div>';
    if (!teamEditing) $('#team-setup').innerHTML = html; html = '';
    if (teamError) html += '<div class="notice error">' + escapeHtml(localize(teamError)) + '</div>';
    if (cfg.enabled && !team && !teamError) html += '<p ' + 'class="' + 'empty' + '"' + '>' + t('正在等待团队状态…') + '</p>';
    if (!cfg.enabled) html += '<p ' + 'class="' + 'empty' + '"' + '>' + t('当前仓库还没开启共享') + '</p>';
    if (cfg.enabled && team) {
      for (const m of team.members) {
        const elapsed = team.serverTime + performance.now() - team.receivedMonotonic - m.seenAt;
        const online = !teamError && elapsed < 90000;
        const known = [...state.commits, ...(state.currentCommits || [])].some(c => c.sha === m.head);
        html += '<button class="person"' + (known ? ' data-locate="' + escapeHtml(m.head) + '" ' + 'title="' + t('在流线上定位') + '"' : ' ' + 'title="' + t('这个提交还没推送或不在本机记录里') + '"') + '><div class="person-head"><span class="avatar">' + escapeHtml(m.name.slice(0, 1)) + '</span><span class="person-name">' + escapeHtml(m.name) + (m.id === team.me ? t('（我）') : '') + '</span><span class="status ' + (online ? 'online' : '') + '">' + (online ? t('● 在线') : t('最后上报 ') + age(Date.now() - elapsed)) + '</span></div><div class="branch">' + (online ? '' : t('最后使用 ')) + escapeHtml(m.branch || t('未检出分支')) + '</div><div class="line"><span class="mono">' + short(m.head) + '</span> ' + escapeHtml(GitTimeline.isAutoCommit(m) && config.showOriginal !== true ? t('自动同步') : subjectLabel(m.subject)) + '</div><div class="line faint">' + escapeHtml(m.dirty) + t(' 项未提交 · ') + (m.ahead === null ? t('未关联上游') : escapeHtml(m.ahead) + t(' 个提交待推送')) + (online ? ' · ' + age(Date.now() - elapsed) + t('上报') : '') + '</div></button>';
      }
      html += '<div ' + 'class="' + 'team-intro small' + '"' + '>' + t('面板打开时约每 25 秒同步一次；超过 90 秒没有上报就显示最后状态。') + '</div>';
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
let workspaceView = null;
let modelSummary = null, modelSummaryContext = '';
function summarySignature() {
  return JSON.stringify([state?.head, state?.status?.count, state?.status?.additions, state?.status?.deletions, (state?.status?.files || []).map(f => f.path + ':' + f.status).join('|')]);
}
function syncModelSummaryContext() {
  const context = JSON.stringify([dir,state?.head,state?.branch]);
  if (modelSummaryContext !== context) { modelSummary = null; modelSummaryContext = context; }
}
function renderModelSummary() {
  const view = workspaceView;
  if (!view || !workspaceCurrent(view)) return;
  const host = $('#ws-model-summary'); if (!host) return;
  const summary = modelSummary?.dir === view.dir ? modelSummary : null;
  const loading = summary?.status === 'loading', hasPoints = !!summary?.points?.length;
  const stale = hasPoints && summary.signature !== summarySignature();
  let html = '';
  if (hasPoints) {
    const date = new Date(summary.generatedAt), when = Number.isNaN(date.getTime()) ? t('时间未知') : date.toLocaleString('zh-CN');
    html += '<div ' + 'class="' + 'ws-model' + '"' + '>' + '<h3>' + t('模型摘要') + '</h3>' + (stale ? '<p ' + 'class="' + 'ws-stale' + '"' + ' ' + 'role="' + 'status' + '"' + '>' + t('摘要已过期 · 工作区又有新改动') + '</p>' : '') + '<ul>' + summary.points.map(point => '<li>' + escapeHtml(point) + '</li>').join('') + '</ul>' + '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('生成于 ') + escapeHtml(when) + t(' · 仅保存在本次面板内') + '</p>' + (summary.truncated ? '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('改动较多，只总结了前一部分。') + '</p>' : '') + '</div>';
  }
  if (summary?.status === 'error') html += '<p class="ws-summary-error ws-hint" role="alert">' + escapeHtml(summary.error || t('摘要生成失败，请重试。')) + '</p>';
  const label = loading ? t('正在生成详细摘要…') : summary?.status === 'error' ? t('重试') : hasPoints ? t('重新生成') : t('生成详细摘要');
  html += '<button id="ws-summarize" class="text-button"' + (loading ? ' disabled' : '') + '>' + label + '</button>' + '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('可选 · 只在点击时把这次改动的 diff 发给模型，不会提交或修改 Git。') + '</p>';
  // Keep the flow and all expanded file/stash diffs outside this update.
  if (host.innerHTML !== html) host.innerHTML = html;
}
async function summarizeWorkspace() {
  const view = workspaceView;
  if (!view || !workspaceCurrent(view)) return;
  syncModelSummaryContext();
  if (modelSummary?.status === 'loading') return;
  const signature = summarySignature(), previous = modelSummary;
  const request = modelSummary = {dir:view.dir,signature:previous?.signature || signature,points:previous?.points || [],truncated:previous?.truncated || false,generatedAt:previous?.generatedAt || '',status:'loading'};
  renderModelSummary();
  try {
    const result = await rpc('workspace/summarize',{dir:view.dir});
    if (modelSummary !== request || !workspaceCurrent(view)) return;
    if (!Array.isArray(result?.points) || !result.points.length || result.points.some(point => typeof point !== 'string' || !point.trim())) throw new Error(t('摘要结果格式无效，请重试。'));
    Object.assign(request,{signature,points:result.points.map(point => point.trim()),truncated:result.truncated === true,generatedAt:result.generatedAt || new Date().toISOString(),status:'ready'});
  } catch (e) {
    if (modelSummary === request && workspaceCurrent(view)) Object.assign(request,{status:'error',error:e?.message || t('摘要生成失败，请重试。')});
  } finally {
    if (modelSummary === request) {
      // Closing or reopening a detail invalidates its request. Do not leave a
      // discarded request stuck in loading or overwrite the newer view.
      if (request.status === 'loading') request.status = request.points.length ? 'ready' : 'idle';
      renderModelSummary();
    }
  }
}
function openDetail(title) { workspaceView = null; GitChoices.close(); showPreferences(false); activeCommitSubject = ''; $('#detail').hidden = false; $('#detail-title').textContent = title; $('#detail-body').innerHTML = '<p ' + 'class="' + 'empty' + '"' + '>' + t('正在读取…') + '</p>'; $('#detail-body').scrollTop = 0; return ++detailRevision; }
function workspaceGroups(status) {
  const files = status?.files || [], changed = code => !!code && !/[. ?]/.test(code);
  return [
    {scope:'conflicts', title:t('冲突待处理'), files:files.filter(f => f.conflict)},
    {scope:'staged', title:t('已暂存改动'), files:files.filter(f => !f.conflict && !f.untracked && f.status !== '??' && (f.staged === true || changed(f.status?.[0])))},
    {scope:'unstaged', title:t('未暂存改动'), files:files.filter(f => !f.conflict && !f.untracked && f.status !== '??' && (f.unstaged === true || changed(f.status?.[1])))},
    {scope:'untracked', title:t('未跟踪文件'), files:files.filter(f => f.untracked || f.status === '??')}
  ];
}
function stageFilesPreview(files) {
  return files.slice(0,3).map(f => String(f.path || '').split('/').pop()).join('、') + (files.length > 3 ? t(' 等 ') + files.length + t(' 个文件') : '');
}
function stageStatsText(group) {
  let add = 0, remove = 0;
  for (const file of group.files) {
    const additions = file[group.scope + 'Add'] ?? file.add;
    const deletions = file[group.scope + 'Remove'] ?? file.remove;
    add += Number.isFinite(additions) ? additions : 0;
    remove += Number.isFinite(deletions) ? deletions : 0;
  }
  return group.files.length + (group.scope === 'untracked' ? t(' 个新文件') : t(' 个文件')) + (add + remove > 0 ? group.scope === 'untracked' ? ' · +' + add + t(' 行') : ' · +' + add + ' / -' + remove + t(' 行') : '');
}
function updateLocalFlowCollapsed() {
  const host = $('#local-flow'), button = $('#local-pull-handle');
  host.classList.toggle('collapsed',localFlowCollapsed);
  const inner = host.querySelector('.local-flow-inner');
  if (inner) inner.inert = localFlowCollapsed;
  if (!button) return;
  button.setAttribute('aria-expanded',String(!localFlowCollapsed));
  button.title = localFlowCollapsed ? t('点击或向下拖动，展开本地状态') : t('点击或向上拖动，收起本地状态');
  const suffix = [state?.status?.count > 0 ? state.status.count + t(' 个改动') : '', state?.stashes?.length ? t('备份 ') + state.stashes.length : ''].filter(Boolean).map(s => ' · ' + s).join('');
  button.querySelector('.pull-label').textContent = localFlowCollapsed ? t('展开本地状态') + suffix : t('收起本地状态');
}
function setLocalFlowCollapsed(collapsed) {
  localFlowCollapsed = !!collapsed;
  updateLocalFlowCollapsed();
  renderTranslationStatus(); translatePending();
}
function stashOrigin(stash) {
  const info = GitLabels.stashInfo(stash);
  return (info.branch ? t('来自 ') + info.branch + ' · ' : '') + age(stash.date);
}
function renderLocalFlow() {
  const host = $('#local-flow'), status = state?.status, stashes = state?.stashes || [];
  host.hidden = !state || outgoingActive || !(status?.count > 0 || stashes.length);
  if (host.hidden) { host.innerHTML = ''; localFlowMarkup = ''; return; }
  const summary = GitLabels.workspaceSummary(status);
  let html = '<div class="local-flow-collapsible"><div class="local-flow-inner"><div class="local-flow-track">';
  html += status?.count > 0 ? '<button ' + 'class="' + 'local-flow-node workspace-node' + '"' + ' ' + 'data-local="' + 'changes' + '"' + '>' + '<span ' + 'class="' + 'local-flow-head' + '"' + '>' + '<b>' + t('工作区改动') + '</b>' + '<span>' + escapeHtml(summary.statsText) + '</span></span><span class="local-flow-description">' + escapeHtml(summary.headline) + '</span></button>' : '';
  for (const group of workspaceGroups(status)) if (group.files.length) {
    html += '<button class="local-flow-node local-stage-node stage-' + group.scope + '" data-local="' + group.scope + '"><span class="local-flow-head"><b>' + group.title + '</b><span>' + escapeHtml(stageStatsText(group)) + '</span></span><span class="local-flow-description">' + escapeHtml(stageFilesPreview(group.files)) + '</span></button>';
  }
  if (stashes.length) {
    const stash = stashes[0], info = GitLabels.stashInfo(stash);
    html += '<button ' + 'class="' + 'local-flow-node stash-node' + '"' + ' ' + 'data-local="' + 'stash' + '"' + '>' + '<span ' + 'class="' + 'local-flow-head' + '"' + '>' + '<b>' + t('本地备份 · ') + stashes.length + t(' 份') + '</b>' + '<span>' + escapeHtml(stashOrigin(stash)) + '</span></span><span class="local-flow-description">' + escapeHtml(config.showOriginal === true ? info.raw : info.title + (info.subtitle ? ' · ' + info.subtitle : '')) + '</span></button>';
  }
  html += '</div>' + '</div>' + '</div>' + '<button ' + 'id="' + 'local-pull-handle' + '"' + ' ' + 'class="' + 'pull-handle local-pull-handle' + '"' + ' data-local-toggle ' + 'aria-expanded="' + 'true' + '"' + ' ' + 'title="' + t('点击或向上拖动，收起本地状态') + '"' + '>' + '<span ' + 'class="' + 'grip' + '"' + '>' + '</span>' + '<span ' + 'class="' + 'pull-label' + '"' + '>' + t('收起本地状态') + '</span>' + icon('chevron') + '</button>';
  if (html !== localFlowMarkup) { host.innerHTML = html; localFlowMarkup = html; }
  updateLocalFlowCollapsed();
}
function cleanPatchBody(patch) {
  if (typeof patch !== 'string' || !patch.trim()) return '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('没有可显示的文本差异；文件可能是二进制文件，或已被其他操作更新。') + '</p>';
  let inHunk = false;
  const lines = patch.split('\n').map(line => {
    if (line.startsWith('diff --git ')) { inHunk = false; return ''; }
    if (line.startsWith('\\ No newline')) return '';
    const hunk = line.match(/^@@[^+]*\+(\d+)(?:,\d+)? @@/);
    if (hunk) { inHunk = true; return '<span ' + 'class="' + 'patch-line hunk' + '"' + '>' + t('第 ') + hunk[1] + t(' 行') + '</span>'; }
    if (/^(?:Binary files|GIT binary patch)/.test(line)) return '<span ' + 'class="' + 'patch-line meta' + '"' + '>' + t('二进制文件发生变化') + '</span>';
    // Only code lines survive; never expose binary payloads or Git metadata.
    if (!inHunk || !/^[ +-]/.test(line)) return '';
    return '<span class="patch-line ' + (line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : '') + '">' + (escapeHtml(line) || ' ') + '</span>';
  }).filter(Boolean);
  return lines.length ? '<pre class="patch ws-patch">' + lines.join('') + '</pre>' : '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('没有可显示的文本差异。') + '</p>';
}
function stashFilePatch(patch, path) {
  if (typeof patch !== 'string') return '';
  const decodePath = value => {
    if (!value.startsWith('"')) return value.replace(/^[ab]\//,'');
    // Git quotes non-ASCII paths as UTF-8 octal bytes as well as C escapes.
    try {
      const bytes = [], encoder = new TextEncoder();
      for (let i = 1; i < value.length - 1; i++) {
        if (value[i] === '\\') {
          const octal = value.slice(i + 1).match(/^[0-7]{1,3}/);
          if (octal) { bytes.push(parseInt(octal[0],8)); i += octal[0].length; continue; }
          const escaped = ({n:'\n',t:'\t',r:'\r',b:'\b',f:'\f',v:'\v'})[value[++i]] ?? value[i];
          bytes.push(...encoder.encode(escaped));
        } else bytes.push(...encoder.encode(value[i]));
      }
      return new TextDecoder().decode(new Uint8Array(bytes)).replace(/^[ab]\//,'');
    } catch { return ''; }
  };
  return patch.split(/(?=^diff --git )/m).filter(block => {
    const markers = [...block.matchAll(/^(?:---|\+\+\+) (.+)$/gm)].map(m => decodePath(m[1]));
    if (markers.includes(path)) return true;
    const header = block.split('\n',1)[0];
    return header.endsWith(' b/' + path) || header.endsWith(' ' + JSON.stringify('b/' + path));
  }).join('');
}
function workspaceStatus(data, fallback = {}) {
  const result = data?.status || data || {};
  return { ...fallback, ...result, files:Array.isArray(result.files) ? result.files : fallback.files || [], count:result.count ?? (Array.isArray(result.files) ? result.files.length : fallback.count || 0) };
}
function workspaceSummaryCard(status) {
  const summary = GitLabels.workspaceSummary(status), files = status.files || [];
  const available = key => files.some(f => Number.isFinite(f[key]));
  const add = Number.isFinite(status.additions) ? status.additions : available('add') ? files.reduce((n,f) => n + (f.add || 0),0) : null;
  const remove = Number.isFinite(status.deletions) ? status.deletions : available('remove') ? files.reduce((n,f) => n + (f.remove || 0),0) : null;
  const total = (add || 0) + (remove || 0), fraction = total ? ((add || 0) / total * 100).toFixed(2) : 50;
  return '<section ' + 'class="' + 'ws-summary' + '"' + '>' + '<div ' + 'class="' + 'ws-eyebrow' + '"' + '>' + t('本地工作区') + '</div>' + '<h2>' + escapeHtml(summary.headline) + '</h2><div class="ws-stats"><b>' + status.count + t(' 个文件') + '</b>' + (add !== null ? '<span class="ws-add">+' + add + t(' 新增行') + '</span>' : '') + (remove !== null ? '<span class="ws-remove">−' + remove + t(' 删除行') + '</span>' : '') + '</div>' + (total ? '<div class="ws-ratio" aria-hidden="true"><i style="width:' + fraction + '%"></i></div>' : '') + '<ul>' + summary.bullets.map(b => '<li>' + escapeHtml(b) + '</li>').join('') + '</ul>' + '<div ' + 'id="' + 'ws-model-summary' + '"' + ' ' + 'class="' + 'ws-model-summary' + '"' + ' ' + 'aria-live="' + 'polite' + '"' + '>' + '</div>' + '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('基于当前未提交改动整理 · 未写入 Git 提交记录') + '</p>' + '</section>';
}
function workspaceFileRows(files, scope, view, stash) {
  return '<div class="ws-files">' + files.map(f => {
    const id = view.files.length; view.files.push({file:f,scope,stash});
    const path = String(f.path || ''), slash = path.lastIndexOf('/'), name = path.slice(slash + 1), folder = slash >= 0 ? path.slice(0,slash) : '';
    const add = scope === 'staged' ? f.stagedAdd ?? f.add : scope === 'unstaged' ? f.unstagedAdd ?? f.add : scope === 'untracked' ? f.untrackedAdd ?? f.add : f.add;
    const remove = scope === 'staged' ? f.stagedRemove ?? f.remove : scope === 'unstaged' ? f.unstagedRemove ?? f.remove : f.remove;
    const lines = Number.isFinite(add) || Number.isFinite(remove) ? '<span class="ws-file-lines"><span class="ws-add">+' + (add || 0) + '</span> <span class="ws-remove">−' + (remove || 0) + '</span></span>' : '';
    return '<div class="ws-file"><button class="ws-file-toggle" data-ws-file="' + id + '" aria-expanded="false" aria-controls="ws-diff-' + id + '"' + (!view.ready ? ' disabled' : '') + '><span class="ws-file-name"><b>' + escapeHtml(name) + '</b>' + (folder ? '<small>' + escapeHtml(folder) + '</small>' : '') + '</span><span class="ws-file-side"><span class="ws-file-badge">' + GitLabels.stageFileBadge(f,scope) + '</span>' + lines + '</span></button><div id="ws-diff-' + id + '" class="ws-inline-diff" hidden></div></div>';
  }).join('') + '</div>';
}
function renderWorkspace(view) {
  if (!workspaceCurrent(view)) return;
  view.files = [];
  const current = [...(state.currentCommits || []), ...(state.commits || [])].find(c => c.sha === view.head);
  let html = view.status.count || modelSummary?.points?.length ? workspaceSummaryCard(view.status) : '<p ' + 'class="' + 'ws-hint ws-clean' + '"' + '>' + t('工作区没有未提交改动。') + '</p>';
  if (!view.ready) html += '<p ' + 'class="' + 'ws-hint' + '"' + ' ' + 'role="' + 'status' + '"' + '>' + t('正在整理文件统计…') + '</p>';
  if (view.warning) html += '<p class="ws-hint">' + escapeHtml(view.warning) + '</p>';
  html += '<div ' + 'class="' + 'ws-flow' + '"' + '>' + '<section ' + 'class="' + 'ws-node ws-base' + '"' + '>' + '<h3>' + t('当前基准提交') + '</h3>' + '<div ' + 'class="' + 'ws-base-meta' + '"' + '>' + '<span ' + 'class="' + 'chip here' + '"' + '>' + escapeHtml(view.branch || t('当前提交')) + '</span><span class="mono">' + short(view.head) + '</span></div><p>' + escapeHtml(current ? current.auto || GitTimeline.isAutoCommit(current) ? autoTitle(current) : subjectLabel(current.subject) : view.head ? t('当前分支已保存的版本') : t('尚未创建首次提交')) + '</p></section>';
  for (const group of workspaceGroups(view.status)) if (group.files.length) html += '<section id="ws-stage-' + group.scope + '" class="ws-node' + (group.scope === 'conflicts' ? ' ws-conflict' : '') + '" tabindex="-1"><h3>' + group.title + ' <span>· ' + group.files.length + t(' 个文件') + '</span>' + '</h3>' + workspaceFileRows(group.files,group.scope,view) + '</section>';
  if (view.status.truncated) html += '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('当前仅显示部分文件，统计以已读取的内容为准。') + '</p>';
  if (view.stashes.length) html += '<section ' + 'id="' + 'ws-stashes' + '"' + ' ' + 'class="' + 'ws-node ws-stashes' + '"' + ' ' + 'tabindex="' + '-1' + '"' + '>' + '<h3>' + t('本地备份 ') + '<span>' + '· ' + view.stashes.length + t(' 份') + '</span>' + '</h3>' + view.stashes.map((s,index) => {
    const info = GitLabels.stashInfo(s);
    return '<div class="ws-stash"><button class="ws-stash-toggle" data-ws-stash="' + index + '" aria-expanded="false" aria-controls="ws-stash-body-' + index + '"><b data-stash-title="' + index + '">' + escapeHtml(config.showOriginal === true ? info.raw : info.title) + '</b><span>' + escapeHtml(stashOrigin(s)) + '</span><small data-stash-subtitle="' + index + '"' + (config.showOriginal === true || !info.subtitle ? ' hidden' : '') + '>' + escapeHtml(info.subtitle) + '</small></button><div id="ws-stash-body-' + index + '" class="ws-stash-body" hidden></div></div>';
  }).join('') + '</section>';
  $('#detail-body').innerHTML = '<article class="workspace-detail">' + html + '</div>' + '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('仅查看本地状态，不会暂存、恢复或删除备份。') + '</p>' + '</article>';
  renderModelSummary();
}
function workspaceCurrent(view) { return workspaceView === view && view.rev === detailRevision && view.generation === generation && view.dir === dir && view.head === state?.head && view.branch === state?.branch && !$('#detail').hidden; }
async function showWorkspace(focusSection = 'changes') {
  if (!state) return;
  syncModelSummaryContext();
  const rev = openDetail(t('本地工作区与备份流线'));
  const view = workspaceView = {rev,generation,dir,head:state.head,branch:state.branch,status:state.status || {count:0,files:[]},stashes:state.stashes || [],files:[],ready:true,loaded:new Map(),pending:new Set(),stashPatches:new Map()};
  renderWorkspace(view);
  renderTranslationStatus(); translatePending();
  if (['conflicts','staged','unstaged','untracked'].includes(focusSection)) {
    const section = $('#ws-stage-' + focusSection);
    section?.scrollIntoView({block:'start',behavior:config.motion === false ? 'auto' : 'smooth'});
    section?.focus({preventScroll:true});
  }
  if (focusSection === 'stash' && view.stashes.length) {
    $('#ws-stashes')?.scrollIntoView({block:'start',behavior:config.motion === false ? 'auto' : 'smooth'});
    $('#ws-stashes')?.focus({preventScroll:true});
    await toggleWorkspaceStash(0);
  }
}
async function toggleWorkspaceFile(id) {
  const view = workspaceView, entry = view?.files[id]; if (!entry || !view.ready || !workspaceCurrent(view)) return;
  const body = $('#ws-diff-' + id), button = $('#detail-body').querySelector('[data-ws-file="' + id + '"]'); if (!body || !button) return;
  body.hidden = !body.hidden; button.setAttribute('aria-expanded',String(!body.hidden));
  const key = 'file:' + id; if (body.hidden || view.loaded.has(key) || view.pending.has(key)) return;
  view.pending.add(key); body.innerHTML = '<p ' + 'class="' + 'ws-hint' + '"' + ' ' + 'role="' + 'status' + '"' + '>' + t('正在读取文件差异…') + '</p>';
  try {
    // Stash patches were fetched from that immutable stash, never from the
    // current working tree. Render just this file when the user opens it.
    const data = entry.stash ? {patch:stashFilePatch(view.stashPatches.get(entry.stash),entry.file.path)} : await rpc('repo/workspace',{dir:view.dir,path:entry.file.path,scope:entry.scope === 'conflicts' ? 'all' : entry.scope});
    if (!workspaceCurrent(view)) return;
    const html = cleanPatchBody(data?.patch ?? data?.diff) + (data?.truncated ? '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('差异较长，仅显示部分内容。') + '</p>' : '');
    body.innerHTML = html; view.loaded.set(key,html);
  } catch { if (workspaceCurrent(view)) body.innerHTML = '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('暂时无法读取这个文件的差异。收起后重新点开即可重试。') + '</p>'; }
  finally { view.pending.delete(key); }
}
async function toggleWorkspaceStash(index) {
  const view = workspaceView, stash = view?.stashes[index]; if (!stash || !workspaceCurrent(view)) return;
  const body = $('#ws-stash-body-' + index), button = $('#detail-body').querySelector('[data-ws-stash="' + index + '"]'); if (!body || !button) return;
  body.hidden = !body.hidden; button.setAttribute('aria-expanded',String(!body.hidden));
  const key = 'stash:' + index; if (body.hidden || view.loaded.has(key) || view.pending.has(key)) return;
  view.pending.add(key); body.innerHTML = '<p ' + 'class="' + 'ws-hint' + '"' + ' ' + 'role="' + 'status' + '"' + '>' + t('正在读取备份内容…') + '</p>';
  try {
    const data = await rpc('repo/workspace',{dir:view.dir,stash:stash.sha}); if (!workspaceCurrent(view)) return;
    const status = workspaceStatus(data), rawPatch = data?.patch ?? data?.diff ?? '';
    status.files = status.files.map(f => {
      if (f.status || f.untracked) return f;
      const header = stashFilePatch(rawPatch,f.path).split(/^@@/m,1)[0];
      return {...f,status:/^new file mode /m.test(header) ? 'A' : /^deleted file mode /m.test(header) ? 'D' : /^rename from /m.test(header) ? 'R' : 'M'};
    });
    view.stashPatches.set(stash.sha,rawPatch);
    const html = '<p class="ws-stash-stats">' + escapeHtml(GitLabels.workspaceSummary(status).statsText) + '</p>' + workspaceFileRows(status.files,'stash',view,stash.sha) + (!status.files.length ? cleanPatchBody(data?.patch ?? data?.diff) : '') + (data?.truncated ? '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('备份差异较长，仅显示部分内容。') + '</p>' : '');
    body.innerHTML = html; view.loaded.set(key,html);
  } catch { if (workspaceCurrent(view)) body.innerHTML = '<p ' + 'class="' + 'ws-hint' + '"' + '>' + t('暂时无法读取备份；备份仍保留在本机，收起后点开可重试。') + '</p>'; }
  finally { view.pending.delete(key); }
}
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
    else if (bin) stats.push({ file: bin[1], n: t('二进制'), add: 0, remove: 0 });
    else if (/files? changed/.test(line)) summary = line.trim().replace(/(\d+) files? changed/, t('$1 个文件')).replace(/(\d+) insertions?\(\+\)/, t('+$1 行')).replace(/(\d+) deletions?\(-\)/, t('-$1 行')).replace(/,/g, ' ·');
  }
  const max = Math.max(1, ...stats.map(s => s.add + s.remove));
  const when = row ? new Date(row.date).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  let html = '<div class="patch-head"><div class="msg">' + escapeHtml(subjectLabel(subject)) + '</div>' + originalSubject(subject) + (body.join('\n').trim() ? '<div class="body">' + escapeHtml(body.join('\n').trim()) + '</div>' : '');
  html += '<div class="meta"><span>' + t('提交作者：') + escapeHtml(row?.author || author) + '</span>' + (when ? '<span>' + when + '</span>' : '') + (row ? '<span ' + 'class="' + 'mono' + '"' + ' ' + 'title="' + t('提交编号：这条记录的唯一标识') + '"' + '>' + t('编号 ') + short(row.sha) + '</span>' : '') + (row?.parents.length > 1 ? '<span>' + t('合并提交') + '</span>' : '') + '</div>';
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
  const sourceDir = dir;
  // 折叠行是面板合成的行，不是真实提交，不能拿去读补丁。
  if (String(sha || '').startsWith('auto:')) return;
  const row = graph?.rows.find(r => r.sha === sha);
  const rev = openDetail(row ? (row.auto ? autoTitle(row) : subjectLabel(row.subject)) : t('提交编号 ') + short(sha));
  activeCommitSubject = row?.subject || '';
  try {
    const data = await rpc('repo/detail', { dir, ref: sha }); if (rev !== detailRevision) return;
    const split = data.patch.indexOf('\ndiff --git ');
    if (!activeCommitSubject) {
      const match = data.patch.match(/\n\n    ([^\n]+)/);
      activeCommitSubject = match?.[1] || '';
      if (activeCommitSubject) $('#detail-title').textContent = subjectLabel(activeCommitSubject);
    }
    $('#detail-body').innerHTML = referenceButton(sourceDir, sha) + patchHead(split < 0 ? data.patch : data.patch.slice(0, split), row) + (split < 0 ? '' : patchBody(data.patch.slice(split + 1))) + (data.truncated ? '<p ' + 'class="' + 'empty' + '"' + '>' + t('补丁太长，只显示了前 180,000 字符。') + '</p>' : '');
    for (const bar of $('#detail-body').querySelectorAll('[data-w]')) bar.style.width = bar.dataset.w + '%';
    translatePending();
  } catch (e) { if (rev === detailRevision) $('#detail-body').innerHTML = '<p class="empty">' + escapeHtml(localize(e.message)) + '</p>'; }
}
async function showCompare(target) {
  const label = /^[0-9a-f]{40}$/.test(target) ? short(target) : target.replace(/^refs\/(heads|remotes)\//, '');
  const rev = openDetail(t('当前分支 ↔ ') + label);
  try {
    const d = await rpc('repo/compare', { dir, target }); if (rev !== detailRevision) return;
    const relation = { equal: t('两边在同一次提交'), 'fast-forward': t('当前分支可以直接快进到它'), contains: t('当前分支已经包含它的全部提交'), diverged: t('两边各自有新的提交'), unrelated: t('两边没有共同历史') }[d.relation];
    $('#detail-body').innerHTML = '<div class="comparison"><h3>' + relation + '</h3><div class="nums"><div class="num"><b>' + d.ahead + '</b>' + t('当前分支独有') + '</div>' + '<div ' + 'class="' + 'num' + '"' + '>' + '<b>' + d.behind + '</b>' + escapeHtml(label) + t(' 独有') + '</div>' + '</div>' + '<p>' + (d.dirty ? t('工作区还有 ') + d.dirty + t(' 项未提交改动，切换或合并前要先处理。') : t('工作区没有未提交改动。')) + '</p><p class="small">' + escapeHtml(d.note) + '</p></div>' + (d.diff ? patchBody(d.diff) : '<p ' + 'class="' + 'empty' + '"' + '>' + t('两边的文件内容一致。') + '</p>');
  } catch (e) { if (rev === detailRevision) $('#detail-body').innerHTML = '<p class="empty">' + escapeHtml(localize(e.message)) + '</p>'; }
}
function closeDetail() { ++detailRevision; workspaceView = null; activeCommitSubject = ''; $('#detail').hidden = true; renderTranslationStatus(); translatePending(); }
function showReadingGuide() {
  openDetail(t('怎么看提交图'));
  const colors = [t('绿色'), t('紫色'), t('黄色'), t('蓝色'), t('粉色'), t('草绿色'), t('橙色'), t('青色')];
  const colorRows = colors.map((name, color) => {
    const rows = graph?.rows.filter(r => r.color === color) || [];
    if (!rows.length) return '';
    const labels = rows.flatMap(r => refGroups(r.sha).map(g => (g.local ? g.name : g.remotes.join('、')) + (g.local?.full === 'refs/heads/' + state.branch ? t('（当前分支）') : !g.local ? t('（仅远端记录）') : '')));
    return '<li><span class="guide-dot c' + color + '"></span><b>' + name + '</b><span>' + (labels.length ? t('标签落在这条颜色的泳道上：') + escapeHtml([...new Set(labels)].join('、')) : t('这条历史泳道上没有分支末端标签')) + '</span></li>';
  }).join('');
  $('#detail-body').innerHTML = '<article class="reading-guide">' +
    '<h3>' + t('先看每一行') + '</h3>' + '<p>' + t('一行代表一次提交，也就是一次已保存的代码版本。标题是这次改动的说明；下面的姓名是提交作者，时间是作者记录的提交时间距今多久。') + '</p>' +
    '<p>' + '<b>' + t('xd、shiyu、LX.. 等是提交时填写的 Git 作者姓名。') + '</b>' + t('它们不一定是平台账号，也不说明这个人当前在哪个分支，更不表示在线状态。真正的队友当前状态要看「协作」页的插件上报。') + '</p>' +
    '<h3>' + t('为什么原来有中文也有英文') + '</h3>' + '<p>' + t('提交说明由提交者或其工具填写，所以仓库里的原文会混用中英文。面板会将新增的英文提交标题自动翻译为中文并缓存；生成期间会显示「正在翻译」。点提交后可展开「查看提交原文」，版本记录不会被修改。翻译只发送标题到 Cindy 的轻量任务模型，不发送代码或补丁；失败时会提示原因，处理后可点「重试中文翻译」。') + '</p>' +
    '<p>' + t('新增功能表示加入能力；修复问题表示修正错误；样式调整表示外观变化；合并更新表示整合不同历史；性能优化表示提升运行效率。括号里是改动涉及的模块，例如剧情、界面或输入控制。') + '</p>' +
    '<h3>' + t('圆点、连线和颜色') + '</h3>' + '<p>' + t('实心圆点是普通提交；空心圆点是合并提交，连接两个或更多父提交。沿线向下看更早的历史，分开再汇合的线表示分支历史的关系。外圈标记当前提交或选中的提交，白色流光沿选中路径移动。') + '</p>' +
    '<p>' + '<b>' + t('颜色区分历史泳道，没有固定的“某颜色＝某分支”规则。') + '</b>' + t('同一条泳道可能承载多个分支标签，颜色也会复用；刷新后布局变化时颜色可能改变。准确的分支名称以节点旁标签为准。') + '</p>' +
    '<ul class="guide-colors">' + colorRows + '</ul>' +
    '<p>' + t('绿色实心标签表示当前分支，独立于连线颜色。灰色带云朵的标签表示只有远端记录；彩色标签旁带云朵表示同名本地和远端分支指向同一次提交。云朵是本机缓存记录，不是实时在线。') + '</p>' +
    '<h3>' + t('按钮分别做什么') + '</h3>' + '<dl>' + '<dt>' + t('收起工具栏') + '</dt>' + '<dd>' + t('点击或向上拖动把手，只看流线。收起后点击或向下拖动把手恢复；收起时点提交可直接查看改动。') + '</dd>' + '<dt>' + t('搜索（放大镜）') + '</dt>' + '<dd>' + t('展开搜索框，按提交说明、作者或分支名高亮匹配记录。') + '</dd>' +
    '<dt>' + t('全仓库／当前分支') + '</dt>' + '<dd>' + t('只切换流线显示范围，不切换 Git 工作分支。默认全仓库；当前分支显示它的历史，包括已经合入的提交。两种范围分别读取最近 180 条记录。') + '</dd>' + '<dt>' + t('连接仓库（＋）') + '</dt>' + '<dd>' + t('选择本机已有项目文件夹，让面板读取它的版本记录。') + '</dd>' +
    '<dt>' + t('刷新本地记录（圆箭头）') + '</dt>' + '<dd>' + t('重新读取本机提交、分支和未提交文件。') + '</dd>' +
    '<dt>' + t('立即更新（远端与显示）') + '</dt>' + '<dd>' + t('连接服务器，更新本机缓存的远端分支记录；不会合并代码或修改工作文件。') + '</dd>' +
    '<dt>' + t('自动更新（远端与显示）') + '</dt>' + '<dd>' + t('默认每 5 分钟获取上方所选远端，可改为每 1 或 10 分钟，也可关闭。面板隐藏时暂停，重新显示后检查是否到期。失败会保留上次记录并延后重试。') + '</dd>' +
    '<dt>' + t('改动数量') + '</dt>' + '<dd>' + t('查看尚未保存为提交的文件，以及已暂存、未暂存、未跟踪或冲突状态。') + '</dd>' +
    '<dt>' + t('↑／↓ 数量') + '</dt>' + '<dd>' + t('与已获取的上游记录相比，本地独有／上游独有的提交数量。这两个数字是状态，不是执行按钮。') + '</dd>' +
    '<dt>' + t('点一次提交／查看改动') + '</dt>' + '<dd>' + t('点一次打开摘要；再点一次或点「查看改动」，查看这次提交修改的文件和代码。差异里绿色带＋是新增行，红色带－是删除行。') + '</dd>' +
    '<dt>' + t('定位') + '</dt>' + '<dd>' + t('在图中找到这个分支指向的最新提交，不切换工作分支。') + '</dd>' +
    '<dt>' + t('比较／和当前分支比较') + '</dt>' + '<dd>' + t('查看两边各自独有的提交数和文件差异，不执行合并或切换。') + '</dd>' +
    '<dt>' + t('自动同步（远端与显示）') + '</dt>' + '<dd>' + t('Maker 每次构建推送都会留下一条快照提交，默认折成一行，只显示次数和时间段。点这一行可以挑一条查看改动；不想折叠就在这里关掉。') + '</dd>' +
    '<dt>' + t('路径流光（远端与显示）') + '</dt>' + '<dd>' + t('开启或关闭选中历史路径上的流光。') + '</dd>' +
    '<dt>' + t('保存并同步（协作页）') + '</dt>' + '<dd>' + t('保存共享设置，开启共享时向已配置的团队服务上报昵称、分支、最新提交和未提交数量。') + '</dd>' +
    '</dl>' + '<h3>' + t('分支名和编号') + '</h3>' + '<p>' + t('ui/story-bg-grid、huhutest、2026-10-12 都是仓库里真实的分支名，名称本身由创建者决定。分支标签指向该分支目前的末端提交，不代表这行的作者拥有整个分支。编号是提交的唯一标识，方便找到同一次记录。') + '</p>' + '</article>';
}
function switchTab(next) {
  tab = next; renderScope();
  for (const b of document.querySelectorAll('[data-tab]')) { const active = b.dataset.tab === tab; b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); }
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== tab;
  if (tab === 'timeline' && state && (!graphKey || (geometry && geometry.height !== $('#graph').scrollHeight))) renderGraph();
  if (tab === 'branches') renderBranches();
  if (tab === 'team') { renderTeam(); syncTeam(); }
  renderTranslationStatus(); translatePending();
}

async function resumeFollowing() {
  const focus = await rpc('session/current');
  followingSession = true;
  if (focus) await followConversation(focus, focus.revision, true);
  else { renderFollow(); error(t('尚未收到当前对话的项目信息，请切换一次对话后再试。')); }
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
$('#load-more').onclick = loadMoreHistory;
$('#current-branch').onclick = () => { if (state?.head) locate(state.head); };
$('#ahead').onclick = toggleOutgoing;
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
$('#show-original').onclick = async () => {
  const button = $('#show-original'); button.disabled = true;
  try { config = await rpc('config/update', { showOriginal: config.showOriginal !== true }); translationStalled.clear(); options(); repaintTranslations(); translatePending(); }
  catch (e) { options(); error(e.message); }
  finally { button.disabled = false; }
};
$('#auto-sync').onclick = async () => {
  const button = $('#auto-sync'); button.disabled = true;
  try { config = await rpc('config/update', { foldAuto: config.foldAuto === false }); options(); graphKey = ''; if (state) render(); }
  catch (e) { options(); error(e.message); }
  finally { button.disabled = false; }
};
$('#close-detail').onclick = closeDetail;
$('#reading-guide').onclick = showReadingGuide;
$('#retry-translation').onclick = () => translatePending(true);
$('#dirty').onclick = () => showWorkspace('changes');
$('#stash-pill').onclick = () => showWorkspace('stash');
let localHandleGesture = null, ignoreLocalHandleClick = false;
$('#local-flow').onpointerdown = event => {
  const handle = event.target.closest('[data-local-toggle]');
  if (!handle || event.button !== 0) return;
  localHandleGesture = {id:event.pointerId,y:event.clientY};
  handle.setPointerCapture(event.pointerId);
};
$('#local-flow').onpointerup = event => {
  if (!localHandleGesture || event.pointerId !== localHandleGesture.id) return;
  const distance = event.clientY - localHandleGesture.y; localHandleGesture = null;
  if (Math.abs(distance) > 20) {
    ignoreLocalHandleClick = true; setTimeout(() => { ignoreLocalHandleClick = false; },0);
    setLocalFlowCollapsed(distance < 0);
  }
};
$('#local-flow').onpointercancel = () => { localHandleGesture = null; };
$('#local-flow').onclick = event => {
  const toggle = event.target.closest('[data-local-toggle]');
  if (toggle?.dataset.localToggle !== undefined) { if (!ignoreLocalHandleClick) setLocalFlowCollapsed(!localFlowCollapsed); return; }
  const node = event.target.closest('[data-local]'); if (node) return showWorkspace(node.dataset.local);
};
$('#detail-body').onclick = event => {
  if (event.target.closest('#ws-summarize')) return summarizeWorkspace();
  const file = event.target.closest('[data-ws-file]'); if (file) return toggleWorkspaceFile(Number(file.dataset.wsFile));
  const stash = event.target.closest('[data-ws-stash]'); if (stash) return toggleWorkspaceStash(Number(stash.dataset.wsStash));
};
$('.tabs').onclick = event => { const button = event.target.closest('[data-tab]'); if (button) switchTab(button.dataset.tab); };
$('#graph').onclick = event => {
  const row = event.target.closest('[data-sha]'); if (!row) return;
  const folded = graph?.rows.find(r => r.sha === row.dataset.sha)?.auto?.folded;
  // 折叠行点第二次也没补丁可看，统一回到摘要里的快照列表。
  if (folded) { selected = row.dataset.sha; drawGraph(); renderSheet(); }
  else if (controlsCollapsed) { selected = row.dataset.sha; drawGraph(); showCommit(selected); }
  else if (row.dataset.sha === selected) showCommit(selected); else select(row.dataset.sha);
};
$('#graph').onkeydown = event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key) || !geometry) return;
  const i = geometry.elements.findIndex(el => el.dataset.sha === (selected || headSha()));
  const next = geometry.elements[Math.max(0, Math.min(geometry.elements.length - 1, i + (event.key === 'ArrowDown' ? 1 : -1)))];
  if (next) { event.preventDefault(); next.focus(); select(next.dataset.sha, true); }
};
document.addEventListener('dragstart', event => {
  const item = event.target.closest?.('[data-commit-reference]');
  if (!item || !event.dataTransfer) return;
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData('text/plain', item.dataset.commitReference);
});
// A panel may lack async clipboard permission but still receive a user-initiated copy event.
document.addEventListener('copy', event => {
  const button = document.activeElement?.closest?.('[data-copy-reference][data-await-copy]');
  if (!button || !event.clipboardData) return;
  event.clipboardData.setData('text/plain', button.dataset.commitReference);
  event.preventDefault();
  delete button.dataset.awaitCopy;
  button.textContent = t('已复制');
});
document.addEventListener('focusout', event => {
  const button = event.target.closest?.('[data-copy-reference][data-await-copy]');
  if (!button) return;
  delete button.dataset.awaitCopy;
  button.textContent = t('复制提交引用');
});
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-copy-reference]');
  if (!button) return;
  button.focus({ preventScroll: true });
  button.dataset.awaitCopy = 'true';
  // Keep the copy command inside the original click, before any asynchronous permission check.
  try {
    if (document.execCommand?.('copy') && !button.dataset.awaitCopy) return;
  } catch {
    // Try the async clipboard API when the command is unavailable.
  }
  try {
    await navigator.clipboard.writeText(button.dataset.commitReference);
    delete button.dataset.awaitCopy;
    button.textContent = t('已复制');
  } catch {
    if (document.activeElement !== button) return;
    button.textContent = /Mac/.test(navigator.platform) ? t('按 ⌘C 复制') : t('按 Ctrl+C 复制');
  }
});
$('#sheet').onclick = event => {
  const member = event.target.closest('[data-commit]');
  if (member) return showCommit(member.dataset.commit);
  const action = event.target.closest('[data-sheet]')?.dataset.sheet;
  if (action === 'close') select(null);
  if (action === 'detail') showCommit(selected);
  if (action === 'compare') showCompare(selected);
};
$('#branches').onclick = event => {
  if (event.target.closest('[data-outgoing]')) return toggleOutgoing();
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
// The panel reads the language from /app-context, the endpoint the plugin
// contract defines for panels. Switching language in Cindy's settings happens in
// another window, so re-read it whenever this panel comes back into view.
let appliedLocale = null;
const repaintLanguage = () => { options(); if (state) { graphKey = ''; render(); } };
const refreshLanguage = async () => {
  const i18n = hostLanguage();
  if (!i18n) return;
  const tag = await i18n.loadHostContext();
  if (tag === appliedLocale) return;
  appliedLocale = tag;
  repaintLanguage();
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshLanguage(); });
if (typeof window !== 'undefined' && window.addEventListener) window.addEventListener('focus', () => { void refreshLanguage(); });
const scrollTimers = new WeakMap();
document.addEventListener('scroll', event => { const el = event.target; if (!el.classList?.contains('scroll')) return; el.classList.add('is-scrolling'); clearTimeout(scrollTimers.get(el)); scrollTimers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), 2000)); }, true);
GitBridge.on(async message => {
  if (message.type === 'session-focus') {
    if (!configReady) { if (!pendingFocus || message.revision > pendingFocus.revision) pendingFocus = message; return; }
    await followConversation(message.focus, message.revision); return;
  }
  if (message.type === 'host-context-changed') {
    // A future host may push the language; redraw so dynamic text follows.
    if (hostLanguage()) hostLanguage().setHostContext(message.context).then(repaintLanguage);
    return;
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
    try {
      const wasFold = config.foldAuto, wasOriginal = config.showOriginal;
      const latest = await rpc('config/read');
      // 显示偏好变化只重画文字，不清空已经显示的队友状态。
      if (config.teamUrl !== latest.teamUrl || config.displayName !== latest.displayName || JSON.stringify(config.teamRepos) !== JSON.stringify(latest.teamRepos)) {
        ++teamGeneration; team = null; teamError = ''; nextTeamAt = 0; teamFailures = 0;
      }
      config = latest; if (configReady) await syncRepositoryLock(config); options(); if (state && tab === 'team') renderTeam();
      // 其他面板改了折叠开关时，这里也要跟着重画流线。
      if (state && config.foldAuto !== wasFold) { graphKey = ''; render(); }
      if (config.showOriginal !== wasOriginal) { translationStalled.clear(); repaintTranslations(); translatePending(); }
    } catch (e) { error(e.message); }
  }
  if (message.type === 'repo-connected' && message.dir !== dir && (!activeFocus || !message.sessionId || message.sessionId === activeFocus.sessionId)) connect(message.dir);
});
setInterval(tick, 12000);
setInterval(() => { if (!document.hidden && state) { $('#sampled').textContent = t('本地记录更新于 ') + age(state.sampledAt); renderFetchStatus(); if (tab === 'team') renderTeam(); } }, 15000);
let resizeTimer, lastWidth = innerWidth;
window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => { if (state && tab === 'timeline' && innerWidth !== lastWidth) { lastWidth = innerWidth; renderGraph(); } }, 100); });
document.addEventListener('visibilitychange', () => { if (!document.hidden) { tick(); translatePending(); } });
(async () => {
  const revision = generation;
  try {
    const [latest, focus, hostLocale] = await Promise.all([rpc('config/read'), rpc('session/current'), hostLanguage()?.loadHostContext()]);
    appliedLocale = hostLocale ?? null;
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
