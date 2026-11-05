'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { parseStatusText, remotesFromConfig, scan, clone } = require('../node/github.cjs');

test('parses gh auth status text from older GitHub CLI releases', () => {
  const text = 'github.com\n  ✓ Logged in to github.com account alice (keyring)\n  - Active account: false\n  ✓ Logged in to github.com account bob-2 (keyring)\n  - Active account: true\n  X Failed to log in to github.com account carol (keyring)\n  ✓ Logged in to ghe.example.com account dave (keyring)\n';
  assert.deepEqual(parseStatusText(text).map(a => [a.login, a.active, a.state]), [['alice', false, 'success'], ['bob-2', true, 'success'], ['carol', false, 'error']]);
});

test('reads remote identities from a Git config without running Git', () => {
  const ids = remotesFromConfig('[remote "origin"]\n\turl = https://github.com/Owner/Repo.git\n[remote "up"]\n\turl = git@github.com:Other/Thing.git\n');
  assert.deepEqual(ids, ['github.com/owner/repo', 'github.com/other/thing']);
});

test('scan finds nested repositories and skips dependency folders', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-flow-scan-'));
  try {
    await fs.mkdir(path.join(root, 'a', '.git'), { recursive: true });
    await fs.writeFile(path.join(root, 'a', '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/me/a.git\n');
    await fs.mkdir(path.join(root, 'group', 'b', '.git'), { recursive: true });
    await fs.mkdir(path.join(root, 'node_modules', 'c', '.git'), { recursive: true });
    const result = await scan(root);
    const names = result.repos.map(r => path.basename(r.dir)).sort();
    assert.deepEqual(names, ['a', 'b']);
    assert.deepEqual(result.repos.find(r => r.dir.endsWith('a')).ids, ['github.com/me/a']);
    assert.ok(result.repos.every(r => !r.dir.includes(String.fromCharCode(92))));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('clone refuses invalid names and non-empty targets before touching credentials', async () => {
  await assert.rejects(clone({ login: 'me', fullName: '../x', parent: os.tmpdir() }), /仓库名称无效/);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'git-flow-clone-'));
  try {
    await fs.mkdir(path.join(root, 'repo')); await fs.writeFile(path.join(root, 'repo', 'x'), '');
    await assert.rejects(clone({ login: 'me', fullName: 'me/repo', parent: root }), /已存在且不为空/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
