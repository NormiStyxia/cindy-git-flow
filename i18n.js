'use strict';
// Git Flow interface language.
//
// The language always follows the Cindy host (`uiLocale`, falling back to the
// legacy `locale`); the plugin never stores a language of its own and never
// reads navigator.language or the operating-system locale.
//
// Catalog keys are the Simplified Chinese source strings, so a missing entry
// falls back to readable Chinese instead of a raw key. Catalogs live in
// locales/ui/<tag>.json and are loaded on demand for the resolved language.
//
// Fallback order mirrors the host: a Traditional Chinese host reads zh-TW, then
// zh-CN, then English; every other language reads itself, then English. The
// literary Chinese interfaces reuse the modern Chinese catalogs.
(() => {
  const SOURCE_LOCALE = 'zh-CN';
  const CHAINS = {
    'zh-CN': ['zh-CN'],
    'zh-TW': ['zh-TW', 'zh-CN'],
    en: ['en'],
    ja: ['ja', 'en'],
    ko: ['ko', 'en'],
    es: ['es', 'en'],
    fr: ['fr', 'en'],
    de: ['de', 'en'],
    'pt-PT': ['pt-PT', 'en'],
    'pt-BR': ['pt-BR', 'en'],
  };
  // Literary Chinese interfaces reuse the modern Chinese catalogs.
  const CLASSICAL = { 'zh-Hant-x-lzh': 'zh-TW', 'zh-Hans-x-lzh': 'zh-CN' };
  // Region and script variants collapse onto the supported tags.
  const TAG_ALIASES = {
    pt: 'pt-PT',
    'pt-br': 'pt-BR',
    'pt-pt': 'pt-PT',
    es: 'es',
    'es-419': 'es',
    fr: 'fr',
    de: 'de',
    ja: 'ja',
    ko: 'ko',
    en: 'en',
    'zh-cn': 'zh-CN',
    'zh-hans': 'zh-CN',
    'zh-sg': 'zh-CN',
    'zh-tw': 'zh-TW',
    'zh-hk': 'zh-TW',
    'zh-mo': 'zh-TW',
    'zh-hant': 'zh-TW'
  };

  let locale = 'en';
  let chain = CHAINS.en;
  let catalogs = {};
  let loading = Promise.resolve();
  let loaded = false;

  const localeFor = value => {
    if (typeof value !== 'string') return 'en';
    const tag = value.trim().replace(/_/g, '-');
    if (!tag) return 'en';
    if (CLASSICAL[tag]) return CLASSICAL[tag];
    if (CHAINS[tag]) return tag;
    const lower = tag.toLowerCase();
    if (TAG_ALIASES[lower]) return TAG_ALIASES[lower];
    const base = lower.split('-')[0];
    return TAG_ALIASES[base] || 'en';
  };

  const catalogUrl = tag => '/locales/ui/' + encodeURIComponent(tag) + '.json';

  const readCatalog = async tag => {
    if (tag === SOURCE_LOCALE) return {};
    try {
      const response = await fetch(catalogUrl(tag), { cache: 'no-cache' });
      if (!response.ok) return {};
      const body = await response.json();
      if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
      return body;
    } catch {
      // Host not reachable yet: keep the source text rather than blocking the panel.
      return {};
    }
  };

  const loadChain = async () => {
    const entries = await Promise.all(chain.map(async tag => [tag, await readCatalog(tag)]));
    catalogs = Object.fromEntries(entries);
    loaded = true;
    return catalogs;
  };

  const t = (key, vars) => {
    if (typeof key !== 'string' || !key) return key;
    let text = key;
    for (const tag of chain) {
      const catalog = catalogs[tag];
      if (catalog && typeof catalog[key] === 'string') { text = catalog[key]; break; }
    }
    if (vars) for (const name of Object.keys(vars)) text = text.split('{' + name + '}').join(String(vars[name]));
    return text;
  };

  // Static markup keeps its Chinese source text in the element and names the key
  // in a data attribute, so the page still reads correctly if this file fails.
  // title and placeholder are reflected IDL properties; ARIA has no property,
  // so it needs setAttribute.
  const ATTRIBUTES = {
    'data-i18n': (node, key) => { node.textContent = t(key); },
    // Only for elements whose source text legitimately carries markup such as <br>.
    'data-i18n-html': (node, key) => { node.innerHTML = t(key); },
    'data-i18n-title': (node, key) => { node.title = t(key); },
    'data-i18n-placeholder': (node, key) => { node.placeholder = t(key); },
    'data-i18n-aria': (node, key) => { node.setAttribute('aria-label', t(key)); }
  };

  const apply = (root) => {
    const scope = root || (typeof document !== 'undefined' ? document : null);
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    if (scope === document && document.documentElement) document.documentElement.lang = locale;
    for (const [selector, write] of Object.entries(ATTRIBUTES)) {
      for (const node of scope.querySelectorAll('[' + selector + ']')) {
        const key = node.getAttribute(selector);
        if (key) write(node, key);
      }
    }
  };

  const setHostContext = context => {
    const next = localeFor(context && (context.uiLocale ?? context.locale));
    if (next === locale && loaded) return loading;
    locale = next;
    chain = CHAINS[next] || CHAINS.en;
    loading = loadChain().then(() => { apply(); return locale; });
    return loading;
  };

  // Same-origin read-only endpoint; the panel and the settings page have no
  // preload bridge, so this is how they see the host language at load time.
  const loadHostContext = async () => {
    // Panels re-read the context when they regain focus; skip the catalog fetch
    // when the host still reports the language already applied.
    if (loaded) {
      try {
        const current = await fetch('/app-context');
        const body = await current.json();
        if (body && body.context) {
          const next = localeFor(body.context.uiLocale ?? body.context.locale);
          if (next === locale) { apply(); return locale; }
        }
      } catch { /* fall through to the full reload below */ }
    }
    locale = 'en';
    chain = CHAINS.en;
    try {
      const response = await fetch('/app-context');
      const body = await response.json();
      if (body && body.context) {
        const next = localeFor(body.context.uiLocale ?? body.context.locale);
        locale = next;
        chain = CHAINS[next] || CHAINS.en;
      }
    } catch { /* host not reachable yet: keep English until it announces itself */ }
    return loadChain().then(() => { apply(); return locale; });
  };

  window.GitI18n = {
    t,
    apply,
    setHostContext,
    loadHostContext,
    localeFor,
    ready: () => loading,
    get locale() { return locale; }
  };
  // Expose a bare t() for call sites that only need a string.
  window.t = t;
})();
