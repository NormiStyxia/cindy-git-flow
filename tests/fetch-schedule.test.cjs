'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FetchSchedule, minutes } = require('../fetch-schedule.js');
test('自动获取尊重间隔、关闭状态与正在执行的请求', () => {
  let now = 0; const s = new FetchSchedule(() => now);
  assert.equal(minutes(undefined), 5); assert.equal(minutes(0), 0); assert.equal(minutes('1'), 5);
  assert.equal(s.due('/repo', 'origin', false), false);
  assert.equal(s.due('/repo', 'origin', true), true);
  assert.equal(s.begin('/repo', 'origin'), true);
  now += 600000; assert.equal(s.due('/repo', 'origin', true), false); assert.equal(s.begin('/repo', 'origin'), false);
  s.finish('/repo', 'origin', 300000, true);
  now += 299999; assert.equal(s.due('/repo', 'origin', true), false);
  now++; assert.equal(s.due('/repo', 'origin', true), true);
});
test('请求结束只更新对应仓库和远端，手动获取重置定时', () => {
  let now = 0; const s = new FetchSchedule(() => now);
  s.begin('/a', 'origin'); s.begin('/b', 'origin'); s.begin('/a', 'other');
  now = 1000; s.finish('/a', 'origin', 300000, true);
  assert.equal(s.entry('/b', 'origin').pending, true); assert.equal(s.entry('/a', 'other').pending, true);
  now = 2000; s.begin('/a', 'origin'); s.finish('/a', 'origin', 300000, true);
  assert.equal(s.entry('/a', 'origin').next, 302000);
  s.reconfigure(60000); assert.equal(s.entry('/a', 'origin').next, 62000);
});
test('失败退避且不会因本地刷新立即重试，成功后恢复常规间隔', () => {
  let now = 0; const s = new FetchSchedule(() => now);
  for (const delay of [60000, 120000, 240000, 480000, 900000, 900000]) {
    s.begin('/a', 'origin'); s.finish('/a', 'origin', 60000, false);
    assert.equal(s.entry('/a', 'origin').next - now, delay);
    s.seed('/a', 'origin', null, 60000); assert.equal(s.due('/a', 'origin', true), false);
    now += delay;
  }
  s.begin('/a', 'origin'); s.finish('/a', 'origin', 60000, true);
  assert.equal(s.entry('/a', 'origin').failures, 0); assert.equal(s.entry('/a', 'origin').next - now, 60000);
});
test('已获取时间初始化调度，未来时间不导致无限延期', () => {
  const s = new FetchSchedule(() => 1000);
  s.seed('/a', 'origin', new Date(Date.now() - 600000).toISOString(), 300000);
  assert.equal(s.due('/a', 'origin', true), true);
  s.seed('/b', 'origin', new Date(Date.now() + 3600000).toISOString(), 300000);
  assert.equal(s.entry('/b', 'origin').next, 301000);
});
