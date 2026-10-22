'use strict';
const $ = s => document.querySelector(s);
async function load() { const cfg = await GitBridge.request('config/read'); $('#name').value = cfg.displayName || ''; $('#url').value = cfg.teamUrl || ''; const result = await (await fetch('/secrets')).json(); const secrets = Array.isArray(result) ? result : result.secrets || []; const saved = secrets.find(s=>s.key==='team_token')?.saved; $('#token-status').textContent = saved ? '已保存团队令牌' : '尚未保存团队令牌'; }
$('#settings').onsubmit = async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true;
  try {
    const address = $('#url').value.trim();
    if (address) { const u = new URL(address); if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(u.hostname))) || u.username || u.password || u.search || u.hash) throw new Error('请使用 HTTPS 地址，本机测试可用 HTTP；地址中不要包含凭证。'); }
    if ($('#token').value) { const r = await fetch('/secrets/team_token', { method:'PUT', body:JSON.stringify({ value:$('#token').value }) }); if (!r.ok) throw new Error('令牌保存失败，请重试。'); $('#token').value = ''; }
    await GitBridge.request('config/update', { displayName:$('#name').value.trim(), teamUrl:address });
    $('#message').textContent = '已保存。到面板「协作」页开启当前仓库的共享。'; await load();
  } catch(e) { $('#message').textContent = e.message; } finally { button.disabled = false; }
};
$('#clear').onclick = async () => { try { const r = await fetch('/secrets/team_token', { method:'DELETE' }); if (!r.ok) throw new Error('清除失败，请重试。'); $('#message').textContent = '已清除团队令牌。'; await load(); } catch(e) { $('#message').textContent = e.message; } };
load().catch(e=>$('#message').textContent=e.message);
