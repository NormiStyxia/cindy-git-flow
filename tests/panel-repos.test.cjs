'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
function panel() {
  const nodes = new Map();
  const element = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { hidden: true, innerHTML: '', dataset: {}, setAttribute() {}, addEventListener() {}, querySelector: element, classList: { toggle() {} } });
    return nodes.get(selector);
  };
  const fixture = { active: 'alice', accounts: [], gitPush: { globalHttpsUsesGh: true, label: 'GitHub CLI' }, identity: {} };
  const context = { config: {}, dir: null, state: null, fixture, $: element, escapeHtml: s => s, icon: () => '', rpc: async () => fixture, GitBridge: { on() {} }, document: { querySelector: element, querySelectorAll: () => [], addEventListener() {} } };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(require.resolve('../panel-repos.js'), 'utf8'), context);
  return { run: source => vm.runInContext(source, context), element };
}
test('repository panel preserves case-distinct paths and merges repeated identical paths', () => {
  const p = panel();
  const entries = p.run(`config = { repositories: ['/work/Game', '/work/game'] };
    localData = { repos: [{ dir: '/work/game', ids: ['github.com/me/lower'] }] };
    dir = '/work/Game'; state = { remotes: [{ identity: 'github.com/me/upper' }] }; localEntries()`);
  assert.deepEqual(JSON.parse(JSON.stringify(entries.map(r => [r.dir, r.ids]))), [
    ['/work/Game', ['github.com/me/upper']], ['/work/game', ['github.com/me/lower']]
  ]);
});
test('account panel explains HTTPS scope and does not promise a push account', () => {
  const p = panel();
  for (const configured of [true, false]) {
    p.run(`accounts = fixture; accounts.gitPush.globalHttpsUsesGh = ${configured}; renderAccounts()`);
    const html = p.element('#account-body').innerHTML;
    assert.match(html, /全局 · HTTPS/);
    assert.match(html, /SSH/);
    assert.match(html, /未核实当前仓库的推送账号/);
    assert.ok(!html.includes('下一次 git push / pull 就会改用新账号'));
  }
});
