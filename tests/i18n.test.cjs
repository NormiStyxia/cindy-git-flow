'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

// Load i18n.js the way the panel does: a classic script on window with only
// document and a fake /app-context endpoint plus the catalog files on disk.
function load({context, nodes = [], appContext, languages = null} = {}) {
  const document = {
    documentElement: {lang: ''},
    querySelectorAll(selector) {
      const attribute = selector.replace(/^\[|\]$/g, '');
      return nodes.filter(node => attribute in node.attributes).map(node => ({
        attributes: node.attributes,
        getAttribute: name => node.attributes[name] ?? null,
        set textContent(value) { node.text = value; },
        set innerHTML(value) { node.html = value; },
        set title(value) { node.attributes.title = value; },
        set placeholder(value) { node.attributes.placeholder = value; },
        setAttribute(name, value) { node.attributes[name] = value; }
      }));
    }
  };
  const fetch = async url => {
    if (url === '/app-context') {
      if (!appContext) throw new Error('host unavailable');
      return {ok: true, json: async () => ({ok: true, context: appContext})};
    }
    const match = /^\/locales\/ui\/([^/]+)\.json$/.exec(url);
    if (!match) throw new Error('unexpected ' + url);
    const tag = decodeURIComponent(match[1]);
    if (languages && !languages.includes(tag)) return {ok: false, json: async () => ({})};
    const file = path.join(__dirname, '..', 'locales', 'ui', tag + '.json');
    if (!fs.existsSync(file)) return {ok: false, json: async () => ({})};
    return {ok: true, json: async () => JSON.parse(fs.readFileSync(file, 'utf8'))};
  };
  const sandbox = vm.createContext({window: {}, document, fetch, navigator: {language: 'de-DE'}});
  vm.runInContext(fs.readFileSync(require.resolve('../i18n.js'), 'utf8'), sandbox);
  const i18n = vm.runInContext('window.GitI18n', sandbox);
  return {i18n, nodes, document, load: async options => {
    if (options) await i18n.setHostContext(options);
    else await i18n.loadHostContext();
    return i18n;
  }};
}

const markup = ['../panel.html', '../settings.html']
  .map(file => fs.readFileSync(require.resolve(file), 'utf8')).join('\n');
const markupKeys = [...new Set([...markup.matchAll(/data-i18n(?:-[a-z]+)?="([^"]+)"/g)].map(match => match[1]))];

test('every markup key is translated for every shipped language', async () => {
  assert.ok(markupKeys.length > 40, `expected a substantial static surface, got ${markupKeys.length}`);
  for (const tag of ['en', 'zh-TW', 'ja', 'ko', 'es', 'fr', 'de', 'pt-PT', 'pt-BR']) {
    const {i18n, load: boot} = load();
    await boot({uiLocale: tag});
    // Chinese values legitimately equal the Simplified source, so compare against
    // the catalog itself rather than against t()'s key fallback.
    const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'locales', 'ui', tag + '.json'), 'utf8'));
    const missing = markupKeys.filter(key => typeof catalog[key] !== 'string' || (i18n.t(key) === key && catalog[key] !== key));
    assert.deepEqual(missing, [], `${tag} is missing static keys`);
  }
});

test('an unknown key falls back to the Chinese source string', async () => {
  const {i18n, load: boot} = load();
  await boot({uiLocale: 'en'});
  const unknown = '这里没有对应翻译';
  assert.equal(i18n.t(unknown), unknown);
  await i18n.setHostContext({uiLocale: 'zh-CN'});
  assert.equal(i18n.t('选择仓库'), '选择仓库');
});

test('the language follows the host, never a plugin preference', async () => {
  const {i18n} = load();
  // uiLocale wins over the legacy locale field.
  assert.equal(i18n.localeFor('en'), 'en');
  assert.equal(i18n.localeFor('zh-CN'), 'zh-CN');
  // Region and script variants collapse onto supported tags.
  assert.equal(i18n.localeFor('pt_BR'), 'pt-BR');
  assert.equal(i18n.localeFor('pt'), 'pt-PT');
  assert.equal(i18n.localeFor('zh-Hant'), 'zh-TW');
  assert.equal(i18n.localeFor('zh-SG'), 'zh-CN');
  // The literary Chinese interfaces reuse the modern Chinese catalogs.
  assert.equal(i18n.localeFor('zh-Hant-x-lzh'), 'zh-TW');
  assert.equal(i18n.localeFor('zh-Hans-x-lzh'), 'zh-CN');
  // The OS locale is never consulted.
  assert.equal(i18n.localeFor(undefined), 'en');
  assert.equal(i18n.localeFor('de-DE'), 'de');
});

test('an unsupported language reads English, Chinese keeps Chinese', async () => {
  const {i18n, load: boot} = load({languages: ['en']});
  await boot({uiLocale: 'fr'});
  assert.equal(i18n.locale, 'fr');
  // fr.json could not be fetched, so the entry comes from the English catalog.
  assert.equal(i18n.t('选择仓库'), 'Select repository');
  const zh = load({languages: ['en']});
  await zh.load({uiLocale: 'zh-TW'});
  assert.equal(zh.i18n.t('选择仓库'), '选择仓库');
});

test('the panel reads the language from /app-context', async () => {
  const {i18n, load: boot} = load({appContext: {uiLocale: 'ja', locale: 'zh-CN'}});
  await boot();
  assert.equal(i18n.locale, 'ja');
  assert.equal(i18n.t('选择仓库'), 'リポジトリを選択');
});

test('a host switch loads the new catalog and repaints static markup', async () => {
  const nodes = [
    {attributes: {'data-i18n': '选择仓库'}},
    {attributes: {'data-i18n-title': '选择仓库'}}
  ];
  const {i18n, load: boot} = load({nodes});
  await boot({uiLocale: 'en'});
  assert.equal(nodes[0].text, 'Select repository');
  await i18n.setHostContext({uiLocale: 'de'});
  assert.equal(nodes[0].text, 'Repository auswählen');
  assert.equal(nodes[1].attributes.title, 'Repository auswählen');
  assert.equal(nodes[1].attributes['aria-label'], undefined);
});

test('{name} placeholders are filled after the catalog lookup', async () => {
  const {i18n, load: boot} = load();
  await boot({uiLocale: 'en'});
  // No shipped key needs a variable today, but the substitution stays available
  // for keys that do: an unknown key still gets its variables filled in.
  assert.equal(i18n.t('{n} commits', {n: 4}), '4 commits');
  // Catalogue values keep $1 untouched: it belongs to the caller's own formatting.
  assert.equal(i18n.t('$1 个文件'), '$1 files');
});

test('a failed catalog fetch keeps the Chinese source instead of throwing', async () => {
  const {i18n, load: boot} = load({languages: []});
  await boot({uiLocale: 'es'});
  assert.equal(i18n.locale, 'es');
  assert.equal(i18n.t('选择仓库'), '选择仓库');
});
