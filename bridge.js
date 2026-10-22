'use strict';
window.GitBridge = (() => {
  const channel = new BroadcastChannel('git-flow-v1'); const pending = new Map(); const listeners = new Set();
  channel.onmessage = ({ data: m }) => {
    if (m.type === 'response') {
      const p = pending.get(m.id); if (!p) return;
      clearInterval(p.repeat); clearTimeout(p.timeout); pending.delete(m.id);
      if (m.error) p.reject(new Error(m.error)); else p.resolve(m.result);
    } else { for (const listener of listeners) listener(m); }
  };
  async function request(method, params = {}) {
    const wake = await fetch('/wake'); if (!wake.ok) throw new Error('插件未能唤醒，请在插件页确认已启用。');
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID(); const message = { type: 'request', id, method, params };
      const repeat = setInterval(() => channel.postMessage(message), 800);
      const timeout = setTimeout(() => { clearInterval(repeat); pending.delete(id); reject(new Error('插件响应超时，请点击刷新重试。')); }, method === 'repo/fetch' ? 915000 : method === 'text/translate' ? 90000 : 45000);
      pending.set(id, { resolve, reject, repeat, timeout }); channel.postMessage(message);
    });
  }
  return { request, on: listener => listeners.add(listener) };
})();
