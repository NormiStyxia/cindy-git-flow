'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// Keep every shipped language honest: the panel falls back to the Chinese source
// for a missing key, so nothing here can fail at runtime — it would just show
// Chinese inside an English, Japanese or Portuguese panel.

const root = path.join(__dirname, '..');
const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const ghost = read('ghost.json');
const ui = tag => read(path.join('locales', 'ui', tag + '.json'));
const manifestLocale = tag => read(path.join('locales', tag + '.json'));

const LANGUAGES = ['en', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-PT', 'pt-BR'];
const CHINESE = new Set(['zh-TW']);
const MARKUP = /<\/?(?!br>)[a-zA-Z]/;
const HAN = /[\u3400-\u9fff\uf900-\ufaff]/;
// Han characters are legitimate in Japanese and Korean text; only the
// non-Chinese, non-Japanese, non-Korean catalogs must stay Han-free.
const HAN_EXEMPT = new Set(['zh-TW', 'ja', 'ko']);

function flatten(node, prefix = '', out = new Set()) {
  if (node && typeof node === 'object' && !Array.isArray(node)) {
    for (const [key, value] of Object.entries(node)) flatten(value, prefix + '/' + key, out);
  } else out.add(prefix);
  return out;
}

test('the manifest advertises the languages the catalogs cover', () => {
  const declared = Object.keys(ghost.locales);
  assert.deepEqual(declared.slice().sort(), ['de', 'en', 'es', 'fr', 'ja', 'ko', 'pt-BR', 'pt-PT', 'zh-CN', 'zh-TW'].sort());
  // The host requires en and falls back to it for anything unsupported.
  assert.ok(declared.includes('en'));
  for (const tag of declared) assert.ok(fs.existsSync(path.join(root, ghost.locales[tag])), `${tag} locale file is missing`);
  for (const tag of Object.keys(ghost.locales)) {
    if (tag === 'zh-CN') continue;
    assert.ok(fs.existsSync(path.join(root, 'locales', 'ui', tag + '.json')), `${tag} UI catalog is missing`);
  }
});

test('every UI catalog has exactly the English key set', () => {
  const base = Object.keys(ui('en'));
  assert.ok(base.length > 400, `expected a large catalog, got ${base.length}`);
  for (const tag of LANGUAGES) {
    const keys = Object.keys(ui(tag));
    const missing = base.filter(key => !keys.includes(key));
    const extra = keys.filter(key => !base.includes(key));
    assert.deepEqual(missing, [], `${tag} is missing keys`);
    assert.deepEqual(extra, [], `${tag} has unknown keys`);
  }
});

test('a translation never leaks markup, and never leaves Han text in a Latin catalog', () => {
  const english = ui('en');
  for (const tag of LANGUAGES) {
    const catalog = ui(tag);
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(typeof value, 'string', `${tag}: ${key} is not a string`);
      assert.ok(value.length > 0, `${tag}: ${key} is empty`);
      assert.ok(!MARKUP.test(value), `${tag}: ${key} kept markup -> ${value}`);
      if (tag === 'en' || (!CHINESE.has(tag) && !HAN_EXEMPT.has(tag))) {
        assert.ok(!HAN.test(value), `${tag}: ${key} still holds Han text -> ${value}`);
      }
      // Fragments are concatenated with numbers, so their spacing is part of the layout.
      if (/^\s/.test(english[key])) assert.ok(/^\s/.test(value), `${tag}: ${key} lost its leading space`);
      if (/\s$/.test(english[key])) assert.ok(/\s$/.test(value), `${tag}: ${key} lost its trailing space`);
      for (const glyph of ['↑', '↓', '●', '✓', '↗', '＋', '×', '↔', '／', '⌘']) {
        if (english[key].includes(glyph)) assert.ok(value.includes(glyph), `${tag}: ${key} lost ${glyph}`);
      }
    }
  }
});

test('the manifest locale files mirror the manifest text surface', () => {
  const base = flatten(read(path.join('locales', 'en.json')));
  for (const tag of Object.keys(ghost.locales)) {
    const locale = manifestLocale(tag);
    assert.deepEqual([...flatten(locale)].sort(), [...base].sort(), `${tag} manifest locale paths differ`);
    const allowed = new Set(['name', 'description', 'whenToUse', 'tools', 'panel', 'mainView', 'taskView', 'network', 'node', 'setup']);
    for (const field of Object.keys(locale)) assert.ok(allowed.has(field), `${tag} manifest locale has an unsupported field ${field}`);
    for (const tool of ghost.tools) {
      assert.ok(locale.tools[tool.name], `${tag} is missing the tool text for ${tool.name}`);
    }
  }
});

test('the panel chrome is fully translated outside Chinese', () => {
  const markup = ['panel.html', 'settings.html'].map(file => fs.readFileSync(path.join(root, file), 'utf8')).join('\n');
  const keys = new Set([...markup.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map(match => match[1]));
  const english = ui('en');
  for (const key of keys) assert.equal(typeof english[key], 'string', `static key ${key} has no entry`);
  // Every language must carry the same static keys; the parity test above only
  // compares against English, so check the class of keys that is easy to forget.
  for (const tag of LANGUAGES) {
    const catalog = ui(tag);
    for (const key of keys) assert.ok(key in catalog, `${tag} is missing the static key ${key}`);
  }
});

test('panel scripts share one global scope without clashing bindings', () => {
  // panel.html loads classic scripts into a single global scope. A repeated const
  // or let binding aborts the second script, which silently kills the panel, so
  // shared helpers are declared as functions on purpose.
  const html = fs.readFileSync(path.join(root, 'panel.html'), 'utf8');
  const scripts = [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map(match => match[1]);
  assert.ok(scripts.length >= 8, `expected the panel script list, got ${scripts.length}`);
  const seen = new Map();
  for (const file of scripts) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    const declared = new Set([...source.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map(match => match[1]));
    for (const name of declared) {
      assert.ok(!seen.has(name), `${file} redeclares ${name}, already declared by ${seen.get(name)}`);
      seen.set(name, file);
    }
  }
});

test('a declared locale file stays inside the host size cap', () => {
  // The host rejects an installed locale resource over 64 KiB, which would fail
  // the whole installation rather than one language.
  for (const file of Object.values(ghost.locales)) {
    const bytes = Buffer.byteLength(fs.readFileSync(path.join(root, file), 'utf8'), 'utf8');
    assert.ok(bytes <= 64 * 1024, `${file} is ${bytes} bytes, over the host cap`);
  }
});
