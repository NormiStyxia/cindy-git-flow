'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const timeline = require('../timeline.js');
const { layout } = require('../graph.js');

const sync = (sha, parent, stamp = '2026/11/4 17:06:14') => ({ sha, parents: parent ? [parent] : [], author: 'Maker', date: '2026-11-04T09:06:14.000Z', subject: '[1793783174615] sync at ' + stamp });
const human = (sha, parent, subject, author = 'xd') => ({ sha, parents: parent ? [parent] : [], author, email: 'xd@example.com', date: '2026-11-04T08:00:00.000Z', subject });

test('只把 Maker 构建模板认成自动同步，正常提交不受影响', () => {
  assert.equal(timeline.isAutoCommit(sync('a')), true);
  assert.equal(timeline.isAutoCommit({ subject: '[1793783174615] sync at 2026-11-04 17:06:14', author: 'maker' }), true);
  // 同样的标题换了作者就不是构建快照
  assert.equal(timeline.isAutoCommit({ subject: '[1793783174615] sync at 2026-11-04 17:06:14', author: 'xd' }), false);
  assert.equal(timeline.isAutoCommit(human('h', null, 'test(audio): 补一条采集音效')), false);
  assert.equal(timeline.isAutoCommit(human('h', null, 'sync at 2026-11-04 17:06:14', 'Maker')), false);
  assert.equal(timeline.isAutoCommit(null), false);
  assert.equal(timeline.isAutoSubject('[1793783174615] sync at 2026-11-04 17:06:14'), true);
});

test('真实项目的斜杠日期、未补零时间和不带邮箱的快照都能识别', () => {
  for (const subject of [
    '[1793856047711] sync at 2026/11/5 13:20:47',
    '[1793783174615] sync at 2026/11/4 17:06:14',
    '[1793823094393] sync at 2026/11/5 4:11:34',
    '[1793783174615] sync at 2026/01/04 07:06:14',
    '[1793783174615] sync at 2026-11-04T17:06:14'
  ]) {
    assert.equal(timeline.isAutoCommit({ subject, author: 'Maker' }), true, subject);
    assert.equal(timeline.isAutoCommit({ subject, author: 'xd' }), false, subject);
  }
  for (const subject of ['sync at 2026/11/5 13:20:47', 'fix: sync at 2026/11/5 13:20:47', '[1793856047711] sync at 2026/11-5 13:20:47']) {
    assert.equal(timeline.isAutoCommit({ subject, author: 'Maker' }), false, subject);
  }
  const model = timeline.build([
    { sha: 'a', parents: ['b'], author: 'Maker', subject: '[1793856047711] sync at 2026/11/5 13:20:47' },
    { sha: 'b', parents: ['real'], author: 'Maker', subject: '[1793855978652] sync at 2026/11/5 13:19:38' },
    human('real', null, 'fix: 保留人工提交')
  ]);
  assert.equal(model.auto, 2);
  assert.equal(model.folded, 1);
  assert.deepEqual(model.items.map(c => c.sha), ['auto:a', 'real']);
  assert.deepEqual(model.items[0].parents, ['real']);
});

test('连续的构建快照折成一行，父母提交接到下面真实的提交上', () => {
  const commits = [sync('s3', 's2'), sync('s2', 's1', '2026-11-04 17:05:00'), sync('s1', 'human', '2026-11-04 17:04:00'), human('human', 'base', 'feat(audio): add harvest sound'), human('base', null, 'init')];
  const model = timeline.build(commits);
  assert.deepEqual(model.items.map(i => i.sha), ['auto:s3', 'human', 'base']);
  const group = model.items[0];
  assert.equal(group.auto.folded, true);
  assert.equal(group.auto.count, 3);
  assert.deepEqual(group.auto.members.map(m => m.sha), ['s3', 's2', 's1']);
  assert.deepEqual(group.parents, ['human']);
  assert.equal(model.folded, 2);
  assert.equal(model.auto, 3);
  assert.equal(model.shaOf('s2'), 'auto:s3');
  assert.equal(model.shaOf('human'), 'human');
  assert.equal(model.shaOf('outside'), 'outside');
});

test('被真实提交打断的同步链折成两组，不会连成一条假历史', () => {
  const commits = [sync('n2', 'n1'), sync('n1', 'real2', '2026-11-04 17:00:00'), human('real2', 'o1', 'fix: 修一下采集'), sync('o2', 'o1'), sync('o1', 'old', '2026-11-04 16:00:00'), human('old', null, 'init')];
  const model = timeline.build(commits);
  assert.deepEqual(model.items.map(i => i.sha), ['auto:n2', 'real2', 'auto:o2', 'old']);
  assert.deepEqual(model.items.map(i => i.parents), [['real2'], ['auto:o2'], ['old'], []]);
});

test('单条快照保留真实编号，开关关掉后全部原样显示', () => {
  const commits = [sync('s1', 'human'), human('human', null, 'init')];
  const single = timeline.build(commits);
  assert.deepEqual(single.items.map(i => i.sha), ['s1', 'human']);
  assert.equal(single.items[0].auto.folded, false);
  assert.equal(single.folded, 0);
  const raw = timeline.build([sync('s2', 's1'), sync('s1', 'human'), human('human', null, 'init')], { fold: false });
  assert.deepEqual(raw.items.map(i => i.sha), ['s2', 's1', 'human']);
  assert.deepEqual(raw.items.map(i => i.parents), [['s1'], ['human'], []]);
  assert.equal(raw.folded, 0);
  assert.equal(raw.items[0].auto.folded, false);
});

test('折叠结果仍能直接交给泳道布局，连线不会指向被折掉的行', () => {
  const commits = [sync('s2', 's1'), sync('s1', 'm2'), human('m2', 'm1', 'feat: 分支上的改动'), human('m1', 'base', 'fix: 主干改动'), human('base', null, 'init')];
  const model = timeline.build(commits);
  const graph = layout(model.items);
  assert.equal(graph.rows.length, 4);
  const shas = new Set(model.items.map(i => i.sha));
  for (const link of graph.links) {
    assert(shas.has(link.from));
    assert(shas.has(link.to) || link.boundary);
    assert.notEqual(link.from, link.to);
  }
  // 合并提交的第二个父提交照样接上；折叠后重复的目标只留一条边
  const merge = timeline.build([{ sha: 'merge', parents: ['s1', 'other'], author: 'xd', subject: 'Merge branch x' }, sync('s1', 'other'), human('other', null, 'init')]);
  assert.deepEqual(merge.items.map(i => i.parents), [['s1', 'other'], ['other'], []]);
  const both = timeline.build([{ sha: 'merge', parents: ['s2', 's1'], author: 'xd', subject: 'Merge branch x' }, sync('s2', 's1'), sync('s1', 'base', '2026-11-04 17:00:00'), human('base', null, 'init')]);
  assert.deepEqual(both.items.map(i => i.sha), ['merge', 'auto:s2', 'base']);
  // 两个父提交都被折进同一行时，只留一条边
  assert.deepEqual(both.items[0].parents, ['auto:s2']);
});

test('异常数据不会打断构建，空仓库返回空列表', () => {
  const model = timeline.build([null, { sha: 'y' }, { sha: 'x', parents: ['y'], author: 'Maker', subject: '[1793783174615] sync at 2026-11-04 17:06:14' }]);
  assert.deepEqual(model.items.map(i => i.sha), ['y', 'x']);
  assert.deepEqual(model.items[1].parents, ['y']);
  assert.deepEqual(timeline.build(null).items, []);
  assert.deepEqual(model.shaOf(undefined), undefined);
});
