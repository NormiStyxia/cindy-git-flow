'use strict';
const repo = require('./git.cjs');
const team = require('./team.cjs');
const github = require('./github.cjs');
async function handle(method, p, secrets = {}, notify = () => {}) {
  if (method === 'repo/snapshot') return repo.snapshot(p.dir);
  if (method === 'repo/detail') return repo.detail(p.dir, p.ref);
  if (method === 'repo/compare') return repo.compare(p.dir, p.target);
  if (method === 'repo/fetch') return repo.fetchRemote(p.dir, p.remote, notify);
  if (method === 'account/list') return github.listAccounts();
  if (method === 'account/switch') return github.switchAccount(p.login);
  if (method === 'account/setup-git') return github.setupGit();
  if (method === 'account/identity') return github.setIdentity(p.login);
  if (method === 'account/login') return github.login(params => notify(params, 'auth-progress'));
  if (method === 'account/login-cancel') return github.cancelLogin();
  if (method === 'cloud/list') return github.cloudRepos(p.login);
  if (method === 'cloud/clone') return github.clone(p, params => notify(params, 'clone-progress'));
  if (method === 'local/scan') return github.scan(p.root);
  if (method === 'team/sync') return team.sync(p, secrets.team_token);
  throw new Error('未知操作，请更新插件后重试。');
}
module.exports = { handle };
