'use strict';
const repo = require('./git.cjs');
const team = require('./team.cjs');
async function handle(method, p, secrets = {}, notify = () => {}) {
  if (method === 'repo/snapshot') return repo.snapshot(p.dir);
  if (method === 'repo/detail') return repo.detail(p.dir, p.ref);
  if (method === 'repo/compare') return repo.compare(p.dir, p.target);
  if (method === 'repo/fetch') return repo.fetchRemote(p.dir, p.remote, notify);
  if (method === 'team/sync') return team.sync(p, secrets.team_token);
  throw new Error('未知操作，请更新插件后重试。');
}
module.exports = { handle };
