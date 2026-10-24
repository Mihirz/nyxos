// Scripts injected into the Lens webview. The page is reduced to what a screen
// reader user navigates: landmark regions → headings / links / fields / buttons.
// Every element gets a stable data-cb id so voice commands can act on it.

export const EXTRACT_JS = String.raw`(() => {
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0' && (r.width > 0 || r.height > 0);
  };
  window.__cbN = window.__cbN || 0;
  const tag = (el) => el.dataset.cb || (el.dataset.cb = 'e' + (++window.__cbN));
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const labelFor = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return clean(aria);
    const by = el.getAttribute('aria-labelledby');
    if (by) { const l = document.getElementById(by); if (l) return clean(l.innerText); }
    if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return clean(l.innerText); }
    const wrap = el.closest('label'); if (wrap) return clean(wrap.innerText);
    return clean(el.placeholder || el.title || el.name || el.value || el.innerText || el.alt || '');
  };

  const items = [];
  const seenHref = new Set();
  const byEl = new Map();
  const add = (el, item) => { item.id = tag(el); items.push(item); byEl.set(el, item); };

  document.querySelectorAll('h1,h2,h3,h4,[role=heading]').forEach((h) => {
    if (!visible(h)) return;
    const label = clean(h.innerText).slice(0, 140);
    if (label) add(h, { kind: 'heading', level: Number(h.getAttribute('aria-level') || h.tagName[1]) || 2, label });
  });
  document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]),textarea,select,[contenteditable=true],[role=searchbox],[role=textbox],[role=combobox]').forEach((el) => {
    if (!visible(el)) return;
    add(el, { kind: 'input', label: (labelFor(el) || el.type || 'text field').slice(0, 80), inputType: el.type || el.tagName.toLowerCase() });
  });
  document.querySelectorAll('button,[role=button],input[type=submit],input[type=button]').forEach((el) => {
    if (!visible(el)) return;
    const label = labelFor(el).slice(0, 80);
    if (label) add(el, { kind: 'button', label });
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    if (!visible(a) || seenHref.has(a.href) || a.href.startsWith('javascript:')) return;
    const label = labelFor(a).slice(0, 120);
    if (!label) return;
    seenHref.add(a.href);
    add(a, { kind: 'link', label, href: a.href });
  });

  // Regions: landmarks, each listing the items inside it.
  const regionSel = 'header,nav,main,aside,footer,form,section[aria-label],section[aria-labelledby],[role=banner],[role=navigation],[role=main],[role=search],[role=complementary],[role=contentinfo],[role=dialog],dialog[open]';
  const nameOf = (r) => {
    const role = r.getAttribute('role') || ({ HEADER: 'banner', NAV: 'navigation', MAIN: 'main', ASIDE: 'sidebar', FOOTER: 'footer', FORM: 'form', SECTION: 'section', DIALOG: 'dialog' })[r.tagName] || 'region';
    const label = r.getAttribute('aria-label') || (r.querySelector('h1,h2,h3') ? clean(r.querySelector('h1,h2,h3').innerText).slice(0, 50) : '');
    return label ? role + ': ' + label : role;
  };
  const regions = [...document.querySelectorAll(regionSel)].filter(visible).filter((r) => !r.parentElement || !r.parentElement.closest('form') || r.tagName !== 'FORM');
  const regionItems = regions.map((r) => {
    const kids = items.filter((it) => r.contains(document.querySelector('[data-cb="' + it.id + '"]')));
    const count = { links: 0, inputs: 0, buttons: 0, headings: 0 };
    kids.forEach((k) => { count[{ link: 'links', input: 'inputs', button: 'buttons', heading: 'headings' }[k.kind]]++; });
    return { id: tag(r), kind: 'region', label: nameOf(r), children: kids.map((k) => k.id), count };
  }).filter((r) => r.children.length);
  // Drop a region when a region nested inside it covers exactly the same items
  // (e.g. <header> that only wraps a <nav>): one stop, not two.
  const same = (a, b) => a.children.length === b.children.length && a.children.every((id, i) => id === b.children[i]);
  const elOf = (r) => document.querySelector('[data-cb="' + r.id + '"]');
  const dedupedRegions = regionItems.filter((r) => !regionItems.some((o) => o !== r && same(o, r) && elOf(r).contains(elOf(o))));

  const main = document.querySelector('main,[role=main],article') || document.body;
  return {
    url: location.href,
    title: clean(document.title) || location.hostname,
    items: [...dedupedRegions, ...items].slice(0, 400),
    article: (main.innerText || '').slice(0, 40000),
  };
})()`;

export const activateJs = (id: string) => String.raw`(() => {
  const el = document.querySelector('[data-cb="${id}"]');
  if (!el) return false;
  document.querySelectorAll('[data-cb-focus]').forEach((x) => { x.removeAttribute('data-cb-focus'); x.style.outline = x.dataset.cbOutline || ''; });
  el.dataset.cbOutline = el.style.outline;
  el.setAttribute('data-cb-focus', '1');
  el.style.outline = '6px solid #FFD400';
  el.style.outlineOffset = '3px';
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  if (el.matches('input,textarea,select,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]')) el.focus();
  else if (el.matches('h1,h2,h3,h4,h5,h6,[role=heading]')) { el.setAttribute('tabindex', '-1'); el.focus(); }
  else el.click();
  return true;
})()`;

export const fillJs = (id: string, text: string) => String.raw`(() => {
  const el = document.querySelector('[data-cb="${id}"]');
  if (!el) return false;
  el.focus();
  if (el.isContentEditable) { el.textContent = ${JSON.stringify(text)}; }
  else {
    const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(text)});
  }
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`;

export const SUBMIT_JS = String.raw`(() => {
  const el = document.activeElement;
  const form = el && el.form;
  if (form) { form.requestSubmit ? form.requestSubmit() : form.submit(); return 'submitted'; }
  return 'none';
})()`;

export const scrollJs = (dir: 'up' | 'down') => `window.scrollBy({ top: ${dir === 'down' ? '' : '-'}window.innerHeight * 0.8, behavior: 'instant' })`;
