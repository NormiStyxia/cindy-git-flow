'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { subject, fileStatus } = require('../labels.js');

test('中文释义保留真实分支名，未知提交不猜译', () => {
  assert.equal(subject('feat(input): add mobile touch controls across gameplay'), '新增功能（输入控制）：为游戏操作添加移动端触控');
  assert.equal(subject('style(story): 地面透视网格加密'), '样式调整（剧情）：地面透视网格加密');
  assert.equal(subject("Merge remote-tracking branch 'origin/huhutest' into 搜打撤"), '合并更新：将远端分支 origin/huhutest 合入 搜打撤');
  assert.equal(subject('feat(custom)!: unknown future change'), '新增功能（custom） · 含不兼容变更：unknown future change');
  assert.equal(subject('unknown future change'), 'unknown future change');
});

test('文件状态区分暂存、未暂存、未跟踪与冲突', () => {
  assert.equal(fileStatus({ status: 'M.' }), '已暂存修改');
  assert.equal(fileStatus({ status: '.M' }), '未暂存修改');
  assert.equal(fileStatus({ status: 'RM' }), '已暂存重命名、未暂存修改');
  assert.equal(fileStatus({ status: '??', untracked: true }), '未跟踪');
  assert.equal(fileStatus({ status: 'UU', conflict: true }), '冲突待处理');
});
test('截图新增提交完整中文，陌生说明必须进入翻译队列', () => {
 const L=require('../labels.js');
 for(const source of ['feat(battle): add initial MVP cinematic and quick preview','fix(input): filter isolated pointer-lock mouse spikes','feat(drive): add chassis stabilization and rounded track colliders']){
  assert(!L.needsTranslation(source));assert(!/[a-z]/i.test(L.subject(source)));
 }
 assert(L.needsTranslation('feat(camera): add smooth follow after teleport'));
 assert(L.needsTranslation('fix(input): crashes'));
 assert(!L.needsTranslation('feat(story): 添加 HUD 和 2D 网格'));
 assert(!L.needsTranslation("Merge branch 'feature/future' into main"));
});
test('未知提交读取动态缓存，异常缓存不覆盖显示或触发原型键', () => {
 const L=require('../labels.js'),source='fix(input): ignore repeated keyup events';assert(L.needsTranslation(source));
 L.loadTranslations({[source]:'修复问题（输入控制）：忽略重复的按键松开事件',bad:'still English'});
 assert(!L.needsTranslation(source));assert.equal(L.subject(source),'修复问题（输入控制）：忽略重复的按键松开事件');assert.equal(L.subject('bad'),'bad');assert.equal(L.subject('__proto__'),'__proto__');
});
test('真实模型保留的英文类型与全角冒号仍显示中文，旧缓存也能修正', () => {
 const L=require('../labels.js');
 L.loadTranslations({'fix(input): repeated release':'fix(input)：忽略重复的 keyup 事件','feat(camera): teleport follow':'feat(camera): 传送后平滑跟随车辆'});
 assert.equal(L.subject('fix(input): repeated release'),'修复问题（输入控制）：忽略重复的 keyup 事件');
 assert.equal(L.subject('feat(camera): teleport follow'),'新增功能（镜头）：传送后平滑跟随车辆');
});
