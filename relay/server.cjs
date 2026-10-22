'use strict';
const http = require('node:http');
const { timingSafeEqual, createHash } = require('node:crypto');
const digest = s => createHash('sha256').update(s).digest();
function createRelay(token, options = {}) {
  const startedAt = Date.now(), startedTick = performance.now();
  const now = options.now || (() => startedAt + performance.now() - startedTick);
  if (typeof token !== 'string' || token.length < 24) throw new Error('GIT_FLOW_TOKEN 至少需要 24 个字符。');
  const rooms = new Map(); const expected = digest('Bearer ' + token);
  return http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store');
    const send = (code, value) => { res.writeHead(code); res.end(JSON.stringify(value)); };
    if (!timingSafeEqual(expected, digest(req.headers.authorization || ''))) return send(401, { error: 'unauthorized' });
    if (req.method !== 'POST' || req.url !== '/v1/presence') return send(404, { error: 'not_found' });
    try {
      let size = 0, chunks = [];
      for await (const chunk of req) { size += chunk.length; if (size > 8192) { send(413, { error: 'too_large' }); return; } chunks.push(Buffer.from(chunk)); }
      const { repo, member: m } = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!/^[a-f0-9]{64}$/.test(repo) || !m || !/^[a-zA-Z0-9_-]{8,128}$/.test(m.id) || typeof m.name !== 'string' || !m.name.trim() || m.name.length > 60 || !(m.branch === null || typeof m.branch === 'string' && m.branch.length <= 1024) || !(m.head === null || /^[a-f0-9]{40,64}$/.test(m.head)) || typeof m.subject !== 'string' || m.subject.length > 240 || !Number.isInteger(m.dirty) || m.dirty < 0 || !(m.ahead === null || Number.isInteger(m.ahead) && m.ahead >= 0) || !Number.isFinite(Date.parse(m.sampledAt))) return send(400, { error: 'invalid_presence' });
      const time = now();
      for (const [key, room] of rooms) { for (const [id, member] of room) if (time - member.seenAt > 86400000) room.delete(id); if (!room.size) rooms.delete(key); }
      if (!rooms.has(repo)) { if (rooms.size >= 100) return send(429, { error: 'rooms_full' }); rooms.set(repo, new Map()); }
      const room = rooms.get(repo);
      if (!room.has(m.id) && room.size >= 256) return send(429, { error: 'members_full' });
      // Receive order controls freshness; a teammate's wall clock may move backwards.
      room.set(m.id, { id: m.id, name: m.name, branch: m.branch, head: m.head, subject: m.subject, dirty: m.dirty, ahead: m.ahead, sampledAt: m.sampledAt, seenAt: time });
      send(200, { serverTime: time, members: [...room.values()].map(m => ({ ...m, online: time - m.seenAt < 90000 })) });
    } catch { if (!res.headersSent) send(400, { error: 'bad_request' }); }
  });
}
if (require.main === module) {
  const server = createRelay(process.env.GIT_FLOW_TOKEN);
  server.requestTimeout = 10000; server.headersTimeout = 10000;
  server.listen(Number(process.env.PORT || 47831), process.env.HOST || '127.0.0.1', () => process.stderr.write('Git 流线团队服务已启动。\n'));
}
module.exports = { createRelay };
