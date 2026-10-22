'use strict';
// 统一的主题菜单：保留按钮的 value/change 接口，不使用原生 select。
window.GitChoices = (() => {
  const menu = document.querySelector('#choice-menu'), choices = new Map();
  let origin = null;
  function close(restoreFocus = false) {
    const button = origin; origin = null; menu.hidden = true;
    if (button) { button.setAttribute('aria-expanded', 'false'); if (restoreFocus) button.focus({ preventScroll: true }); }
  }
  function set(button, items, value) {
    const previous = choices.get(button);
    choices.set(button, items);
    button.value = items.some(item => item.value === value) ? value : items[0]?.value || '';
    const current = items.find(item => item.value === button.value);
    const label = document.createElement('span'); label.textContent = current?.label || button.dataset.empty || '暂无选项';
    const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    arrow.setAttribute('aria-hidden', 'true'); arrow.innerHTML = '<use href="#i-chevron"/>';
    button.replaceChildren(label, arrow); button.setAttribute('aria-controls', 'choice-menu');
    if (origin === button && JSON.stringify(previous) !== JSON.stringify(items)) close(true);
  }
  function open(button, edge) {
    if (button.disabled) return;
    if (origin === button) { close(true); return; }
    const items = choices.get(button) || []; if (!items.length) return;
    button.dispatchEvent(new CustomEvent('choice-opening', { bubbles: true }));
    close(); origin = button; button.setAttribute('aria-expanded', 'true');
    menu.setAttribute('aria-label', button.getAttribute('aria-label') || '选择');
    menu.replaceChildren(...items.map(item => {
      const option = document.createElement('button'); option.type = 'button'; option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', String(item.value === button.value)); option.dataset.value = item.value;
      const text = document.createElement('span'); text.className = 'choice-copy';
      const title = document.createElement('span'); title.textContent = item.label; text.append(title);
      if (item.detail) { const detail = document.createElement('small'); detail.textContent = item.detail; text.append(detail); }
      const check = document.createElement('span'); check.className = 'choice-check'; check.textContent = item.value === button.value ? '✓' : '';
      option.append(text, check);
      option.onclick = () => {
        if (button.disabled || !(choices.get(button) || []).some(next => next.value === item.value)) { close(true); return; }
        const changed = button.value !== item.value;
        set(button, choices.get(button), item.value); close(true);
        if (changed) button.dispatchEvent(new Event('change', { bubbles: true }));
      };
      return option;
    }));
    menu.hidden = false;
    const box = button.getBoundingClientRect(), width = Math.min(innerWidth - 16, Math.max(250, box.width));
    menu.style.width = width + 'px'; menu.style.maxHeight = Math.min(280, innerHeight - 16) + 'px';
    const height = menu.offsetHeight;
    menu.style.left = Math.max(8, Math.min(box.left, innerWidth - width - 8)) + 'px';
    menu.style.top = Math.max(8, Math.min(box.bottom + 5 + height > innerHeight - 8 ? box.top - height - 5 : box.bottom + 5, innerHeight - height - 8)) + 'px';
    const options = [...menu.children];
    const focus = edge === 'first' ? options[0] : edge === 'last' ? options.at(-1) : options.find(el => el.getAttribute('aria-selected') === 'true') || options[0];
    focus?.focus({ preventScroll: true }); focus?.scrollIntoView({ block: 'nearest' });
  }
  document.querySelectorAll('.choice-trigger').forEach(button => {
    button.addEventListener('click', () => open(button));
    button.addEventListener('keydown', event => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); open(button, event.key === 'ArrowDown' ? 'first' : 'last'); }
    });
  });
  document.addEventListener('pointerdown', event => { if (origin && !menu.contains(event.target) && !origin.contains(event.target)) close(); });
  document.addEventListener('keydown', event => {
    if (!origin) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); close(true); return; }
    if (event.key === 'Tab') { close(true); return; }
    const options = [...menu.children], index = options.indexOf(document.activeElement);
    if ((event.key === 'Enter' || event.key === ' ') && index >= 0) {
      event.preventDefault(); event.stopImmediatePropagation(); options[index].click(); return;
    }
    let next;
    if (event.key === 'ArrowDown') next = (index + 1) % options.length;
    if (event.key === 'ArrowUp') next = (index - 1 + options.length) % options.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = options.length - 1;
    if (next !== undefined) { event.preventDefault(); event.stopImmediatePropagation(); options[next].focus(); }
  }, true);
  window.addEventListener('resize', () => close());
  return { set, close, get isOpen() { return !!origin; } };
})();
