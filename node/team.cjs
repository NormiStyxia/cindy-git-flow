'use strict';
const { snapshot, hash } = require('./git.cjs');
function parsePresence(body) {
  const bad = () => { throw new Error('团队服务返回格式无效，请检查服务版本。'); };
  if (!body || !Array.isArray(body.members) || !Number.isFinite(body.serverTime) || body.serverTime < 0 || body.members.length > 256) bad();
  const members = body.members.map(m => {
    if (!m || typeof m.id !== 'string' || !/^[a-zA-Z0-9_-]{8,128}$/.test(m.id) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60 || !(m.branch === null || typeof m.branch === 'string' && m.branch.length <= 1024) || !(m.head === null || typeof m.head === 'string' && /^[a-f0-9]{40,64}$/.test(m.head)) || typeof m.subject !== 'string' || m.subject.length > 240 || !Number.isSafeInteger(m.dirty) || m.dirty < 0 || !(m.ahead === null || Number.isSafeInteger(m.ahead) && m.ahead >= 0) || !Number.isFinite(m.seenAt) || m.seenAt < 0 || m.seenAt > body.serverTime + 1000) bad();
    return { id:m.id, name:m.name, branch:m.branch, head:m.head, subject:m.subject, dirty:m.dirty, ahead:m.ahead, seenAt:m.seenAt, online:body.serverTime - m.seenAt < 90000 };
  });
  return { serverTime:body.serverTime, members };
}
async function sync(params, secret) {
  if (!secret) throw new Error('请在插件设置里保存团队访问令牌，再启用团队同步。');
  let url; try { url = new URL(params.url); } catch { throw new Error('请填写团队服务的 HTTPS 地址。'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) || url.username || url.password || url.search || url.hash) throw new Error('团队地址必须使用 HTTPS（本机测试可用 HTTP），且不能夹带凭证或查询参数。');
  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(params.memberId || '')) throw new Error('设备身份无效，请重新打开面板。');
  const state = await snapshot(params.dir);
  if (state.unstable) throw new Error('仓库正在切换分支，本次状态暂不上报，请稍后刷新。');
  const identity = params.room?.trim() || state.remotes.find(r => r.name === (params.remote || 'origin'))?.identity;
  if (!identity) throw new Error('请设置团队项目代号，或连接一个有效远端。');
  const repo = hash(identity);
  const me = { id: params.memberId + '-' + hash(state.dir).slice(0, 12), name: String(params.name || state.userName || '队友').slice(0, 60), branch: state.branch, head: state.head, subject: state.commits.find(c => c.sha === state.head)?.subject.slice(0, 240) || '', dirty: state.status.count, ahead: state.ahead, sampledAt: state.sampledAt };
  url.pathname = url.pathname.replace(/\/$/, '') + '/v1/presence';
  let response;
  try { response = await fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + secret, 'Content-Type': 'application/json' }, body: JSON.stringify({ repo, member: me }), redirect: 'error', signal: AbortSignal.timeout(10000) }); }
  catch { throw new Error('团队服务连接失败，请检查服务地址和网络；本地仓库仍可使用。'); }
  if (!response.ok) throw new Error(response.status === 401 ? '团队令牌无效，请在插件设置里更新。' : '团队服务暂时不可用，请检查服务状态后重试。');
  const reader = response.body.getReader(); let chunks = [], size = 0;
  while (true) { const r = await reader.read(); if (r.done) break; size += r.value.length; if (size > 256000) { await reader.cancel(); throw new Error('团队返回数据过大，请检查服务配置。'); } chunks.push(Buffer.from(r.value)); }
  let body; try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('团队服务返回格式无效，请检查服务版本。'); }
  return { ...parsePresence(body), me: me.id, repo };
}
module.exports = { sync, parsePresence };
