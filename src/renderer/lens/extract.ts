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

  // Prices: "$ 29 . 99" across spans, "$1,299", "29,99 €".
  const PRICE = /(?:[$£€]\s?\d[\d,]*(?:\s?\.\s?\d{2})?)|(?:\d[\d.,]*\s?€)/;
  const priceIn = (el) => {
    const off = el.querySelector('.a-price .a-offscreen, [itemprop=price], [data-testid*=price], [class*=price]');
    const t = off ? (off.getAttribute('content') && !/[$£€]/.test(off.innerText) ? '$' + off.getAttribute('content') : off.textContent) : '';
    const m = (t && t.match(PRICE)) || (el.innerText || '').match(PRICE);
    return m ? m[0].replace(/\s+/g, '') : undefined;
  };
  // The product card around a link: the nearest list item / article / tile, kept small.
  const cardOf = (el) => {
    const known = el.closest('[data-component-type=s-search-result],[data-asin]:not([data-asin=""])');
    if (known) return known;
    const c = el.closest('article,li,[role=listitem],[class*=card],[class*=product]');
    return c && c !== document.body && (c.textContent || '').length < 4000 ? c : null;
  };

  // "bigCookie" → "big cookie": names for controls that have no text (icon buttons, game pieces).
  const human = (s) => s.replace(/[-_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\d+$/, '').trim().toLowerCase();

  const items = [];
  const seenHref = new Set();
  const byEl = new Map();
  // One entry per element, even when it matches two selectors (e.g. a combobox button).
  // Ads are never read: anything inside an ad container is skipped everywhere.
  const AD = 'shreddit-ad-post, [data-testid*="ad-" i], [id^=google_ads], ins.adsbygoogle, [aria-label*="advertisement" i], [class*="sponsored" i], [data-promoted=true], [data-component-type=sp-sponsored-result]';
  const isAd = (el) => !!el.closest(AD);
  const elById = new Map();
  // Ad contents are skipped, except the controls that get you past an ad ("Continue to
  // Connections", "Skip advertisement", "Close"): without them a game's ad gate is a dead end.
  const passAd = (item) => (item.kind === 'button' || item.kind === 'link') && /^(continue|skip|close|play|no thanks|dismiss)\b/i.test(item.label || '');
  const add = (el, item) => { if (byEl.has(el) || (isAd(el) && !passAd(item))) return; item.id = tag(el); items.push(item); byEl.set(el, item); elById.set(item.id, el); };

  document.querySelectorAll('h1,h2,h3,h4,[role=heading]').forEach((h) => {
    if (!visible(h)) return;
    const label = clean(h.innerText).slice(0, 140);
    if (label) add(h, { kind: 'heading', level: Number(h.getAttribute('aria-level') || h.tagName[1]) || 2, label });
  });
  document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=image]),textarea,select,[contenteditable=true],[role=searchbox],[role=textbox],[role=combobox]').forEach((el) => {
    if (!visible(el)) return;
    add(el, { kind: 'input', label: (labelFor(el) || el.type || 'text field').slice(0, 80), inputType: el.type || el.tagName.toLowerCase() });
  });
  // role=option covers crossword clue lists (selecting a clue selects its entry and direction).
  document.querySelectorAll('button,[role=button],[role=option],input[type=submit],input[type=button]').forEach((el) => {
    if (!visible(el)) return;
    const label = labelFor(el).slice(0, 80) || (el.id ? human(el.id) : '');
    if (label) add(el, { kind: 'button', label });
  });
  document.querySelectorAll('a[href]').forEach((a) => {
    if (!visible(a) || seenHref.has(a.href) || a.href.startsWith('javascript:')) return;
    const label = labelFor(a).slice(0, 120);
    if (!label) return;
    seenHref.add(a.href);
    const card = cardOf(a);
    const price = card ? priceIn(card) : undefined;
    add(a, card ? { kind: 'link', label, href: a.href, price, card: tag(card) } : { kind: 'link', label, href: a.href });
  });

  // Clickable things that aren't links or buttons: game pieces, tiles, custom widgets.
  // A pointer cursor is the tell; cursor is inherited, so keep only the outermost one.
  const clickRoots = [];
  document.querySelectorAll('[onclick],[tabindex]:not([tabindex="-1"]),div[id],span[id],canvas[id],[class*=btn],[class*=button],[class*=clickable],[class*=product],[class*=option],[class*=tile]').forEach((el) => {
    if (clickRoots.length >= 80 || byEl.has(el) || el.closest('a,button,input,select,textarea') || !visible(el)) return;
    if (clickRoots.some((r) => r.contains(el)) || getComputedStyle(el).cursor !== 'pointer') return;
    const text = clean(el.getAttribute('aria-label') || el.title || el.innerText || '');
    if (text.length > 160) return; // a big container, not a control
    const firstLine = clean((el.getAttribute('aria-label') || el.title || el.innerText || '').split('\n').find((l) => l.trim()) || '');
    const label = firstLine.slice(0, 80) || (el.id ? human(el.id) : '');
    if (!label) return;
    clickRoots.push(el);
    add(el, { kind: 'button', label });
  });

  // Regions: landmarks, each listing the items inside it.
  const regionSel = 'header,nav,main,aside,footer,form,section[aria-label],section[aria-labelledby],[role=banner],[role=navigation],[role=main],[role=search],[role=complementary],[role=contentinfo],[role=dialog],dialog[open]';
  const nameOf = (r) => {
    const role = r.getAttribute('role') || ({ HEADER: 'banner', NAV: 'navigation', MAIN: 'main', ASIDE: 'sidebar', FOOTER: 'footer', FORM: 'form', SECTION: 'section', DIALOG: 'dialog' })[r.tagName] || 'region';
    const label = r.getAttribute('aria-label') || (r.querySelector('h1,h2,h3') ? clean(r.querySelector('h1,h2,h3').innerText).slice(0, 50) : '');
    return label ? role + ': ' + label : role;
  };
  const regions = [...document.querySelectorAll(regionSel)].filter(visible).filter((r) => !r.parentElement || !r.parentElement.closest('form') || r.tagName !== 'FORM');
  // Visual salience, after SaIL (Aydin et al., IUI 2020), which ranks regions by where sighted
  // users look: here approximated from layout. Big, near the top of the first screen, large
  // type, pictures: more salient. Navigation and footers: less.
  const vw = innerWidth, vh = innerHeight;
  const salience = (el) => {
    const r = el.getBoundingClientRect();
    const visW = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
    const visH = Math.max(0, Math.min(r.bottom, vh * 1.5) - Math.max(r.top, 0));
    const area = (visW * visH) / (vw * vh * 1.5);
    const top = r.top < vh ? 1 - Math.max(0, r.top) / vh : 0;
    const center = 1 - Math.min(1, Math.abs((r.left + r.right) / 2 - vw / 2) / (vw / 2));
    const fs = parseFloat(getComputedStyle(el).fontSize) || 16;
    const media = el.querySelector && el.querySelector('img,video,canvas') ? 0.15 : 0;
    const chrome = el.closest('nav,header,footer,[role=navigation],[role=banner],[role=contentinfo]') ? -0.35 : 0;
    return Math.max(0, Math.min(1, area * 0.9 + top * 0.35 + center * 0.15 + Math.min(1, (fs - 12) / 24) * 0.25 + media + chrome));
  };
  // Salience for the first 400 items is plenty (the rest are far down busy pages) and keeps this fast.
  for (const it of items.slice(0, 400)) { const el = elById.get(it.id); if (el) it.sal = Math.round(salience(el) * 100) / 100; }

  const regionItems = regions.map((r) => {
    const kids = items.filter((it) => r.contains(elById.get(it.id)));
    const count = { links: 0, inputs: 0, buttons: 0, headings: 0 };
    kids.forEach((k) => { count[{ link: 'links', input: 'inputs', button: 'buttons', heading: 'headings' }[k.kind]]++; });
    return { id: tag(r), kind: 'region', label: nameOf(r), children: kids.map((k) => k.id), count, sal: Math.round(salience(r) * 100) / 100 };
  }).filter((r) => r.children.length);
  // Drop a region when a region nested inside it covers exactly the same items
  // (e.g. <header> that only wraps a <nav>): one stop, not two.
  const same = (a, b) => a.children.length === b.children.length && a.children.every((id, i) => id === b.children[i]);
  const elOf = (r) => document.querySelector('[data-cb="' + r.id + '"]');
  const dedupedRegions = regionItems.filter((r) => !regionItems.some((o) => o !== r && same(o, r) && elOf(r).contains(elOf(o))));

  // documentElement as a last resort: a page caught mid-load can have no body yet.
  const main = document.querySelector('main,[role=main],article') || document.body || document.documentElement;
  // Readable units, in order: the post, then comments (with author and depth), for "read the comments".
  const blocks = [];
  const post = document.querySelector('shreddit-post, [data-testid=post-container], article[data-type=post]');
  if (post && !isAd(post)) blocks.push({ kind: 'post', author: post.getAttribute('author') || '', text: clean(post.innerText).slice(0, 1200) });
  document.querySelectorAll('shreddit-comment, [data-testid=comment], .comment, [role=comment], li[id^=comment], article[data-type=comment]').forEach((c) => {
    if (blocks.length > 80 || isAd(c)) return;
    const own = c.querySelector(':scope > [slot=comment], :scope > .md, :scope > .comment-body, :scope > div [id$=-comment-rtjson-content]') || c.querySelector('[slot=comment], .md, .comment-body, p');
    const text = clean(own ? own.innerText : c.innerText).slice(0, 700);
    if (!text) return;
    blocks.push({ kind: 'comment', author: c.getAttribute('author') || clean((c.querySelector('[slot=authorName], .author, a[href*="/user/"]') || {}).innerText || ''), score: c.getAttribute('score') || '', depth: Number(c.getAttribute('depth') || 0), text });
  });
  // A feed's posts in order (Reddit, news lists), so "next post" can go straight to the next one.
  const posts = [];
  const seenPost = new Set();
  document.querySelectorAll('shreddit-post, article, [data-testid=post-container]').forEach((p) => {
    if (posts.length >= 60 || isAd(p)) return;
    const title = p.getAttribute('post-title') || clean((p.querySelector('h1,h2,h3,[slot=title]') || {}).innerText || '');
    let href = p.getAttribute('permalink') || '';
    if (!href) { const a = p.querySelector('a[slot=full-post-link], h1 a[href], h2 a[href], h3 a[href], a[href][data-click-id=body]'); href = a ? a.getAttribute('href') : ''; }
    if (!title || !href) return;
    try { href = new URL(href, location.href).href; } catch { return; }
    if (seenPost.has(href)) return;
    seenPost.add(href);
    posts.push({ title: title.slice(0, 160), href });
  });
  const adText = [...document.querySelectorAll(AD)].map((a) => a.innerText || '').filter((t) => t.length > 20);
  let article = (main.innerText || '').slice(0, 40000);
  // Prose for skimming: real paragraphs only (no infobox coordinates, menus, or captions).
  const prose = [...main.querySelectorAll('p')].filter((p) => !p.closest('table,nav,aside,figure,header,footer,.infobox') && visible(p))
    .map((p) => clean(p.innerText)).filter((t) => t.length > 60 && (t.match(/[a-z]/g) || []).length > t.length * 0.5).join('\n\n').slice(0, 40000);
  for (const t of adText) article = article.split(t).join(' ');
  // Product pages: the buy-box price, else the first price near the top of the page.
  const buy = document.querySelector('#corePrice_feature_div, #corePriceDisplay_desktop_feature_div, #apex_desktop, [itemprop=offers], [data-testid=price], .product-price, .price');
  const pagePrice = (buy && visible(buy) && priceIn(buy)) || undefined;
  const canvasShare = Math.max(0, ...[...document.querySelectorAll('canvas')].map((c) => { const r = c.getBoundingClientRect(); return (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (vw * vh); }));
  return {
    url: location.href,
    title: clean(document.title) || location.hostname,
    canvas: Math.round(canvasShare * 100) / 100,
    // Busy pages (Amazon) have hundreds of filter buttons before the product links: keep plenty.
    items: [...dedupedRegions, ...items].slice(0, 1500),
    article,
    prose,
    blocks,
    posts,
    price: pagePrice,
  };
})()`;

// Repeated clicks are paced at ~3 per second, which is what sites like Cookie Clicker accept
// from scripted clicks; we stay within that rather than imitating a physical mouse.
export const activateJs = (id: string, times = 1) => String.raw`(async () => {
  const el = document.querySelector('[data-cb="${id}"]');
  if (!el) return false;
  document.querySelectorAll('[data-cb-focus]').forEach((x) => { x.removeAttribute('data-cb-focus'); x.style.outline = x.dataset.cbOutline || ''; });
  el.dataset.cbOutline = el.style.outline;
  el.setAttribute('data-cb-focus', '1');
  el.style.outline = '6px solid #FFD400';
  el.style.outlineOffset = '3px';
  el.scrollIntoView({ block: 'center', behavior: 'instant' });
  // Checkboxes and radio buttons (Connections' word tiles) are toggled; text fields get focus.
  if (el.matches('input[type=checkbox],input[type=radio]')) { el.click(); return { checked: el.checked }; }
  if (el.matches('input,textarea,select,[contenteditable=true],[role=textbox],[role=searchbox],[role=combobox]')) el.focus();
  else if (el.matches('h1,h2,h3,h4,h5,h6,[role=heading]')) {
    // A heading that is (or wraps) a link, like a product title: follow the link.
    const link = el.closest('a[href]') || el.querySelector('a[href]');
    if (link) link.click();
    else { el.setAttribute('tabindex', '-1'); el.focus(); }
  }
  else {
    window.__cbStop = false;
    for (let i = 0; i < ${Math.max(1, Math.min(100, times))} && !window.__cbStop; i++) {
      if (i) await new Promise((r) => setTimeout(r, 350));
      el.click();
    }
  }
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

/**
 * Text around every visible match of the query words: answers "how much is X", "what's the
 * rating". Walks text nodes once (linear even on huge pages like Reddit), then climbs from
 * each hit to the smallest surrounding block that reads as a unit (a post, a card, a row).
 */
export const findJs = (query: string) => String.raw`(() => {
  const words = ${JSON.stringify(query.toLowerCase())}.split(/\s+/).filter((w) => w.length > 2);
  if (!words.length) return [];
  const blocks = new Map();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n.nodeValue.toLowerCase();
    if (t.length < 3 || !words.some((w) => t.includes(w))) continue;
    let el = n.parentElement;
    if (!el || el.closest('script,style,noscript')) continue;
    // Grow to the post/card around the hit, but stop before a whole column.
    while (el.parentElement && el.parentElement !== document.body && (el.parentElement.textContent || '').length < 700) el = el.parentElement;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const text = (el.innerText || '').replace(/\s+/g, ' ').trim();
    const hits = words.filter((w) => text.toLowerCase().includes(w)).length;
    if (text && !blocks.has(el)) blocks.set(el, { text: text.slice(0, 600), hits });
    if (blocks.size > 200) break;
  }
  return [...blocks.values()].sort((a, b) => b.hits - a.hits).slice(0, 6).map((b) => b.text);
})()`;

/**
 * Click something that isn't a link or button: by its visible text, or by a point on the
 * page (CSS pixels). Repeats are paced like activateJs; with `until`, it stops as soon as
 * that text appears one more time than before (e.g. "Achievement unlocked"). "stop" sets
 * window.__cbStop to end a loop early.
 */
const CLICKER = String.raw`async (el, times, until, how) => {
  if (!el) return { clicked: false };
  // A point click that lands on a full-page layer (a dialog's dimmed backdrop) would do nothing useful.
  const box = el.getBoundingClientRect();
  if (how === 'point' && box.width * box.height > innerWidth * innerHeight * 0.6) {
    const dialog = document.querySelector('dialog[open], [role=dialog], [aria-modal=true], .prompt, #prompt, [class*=modal]:not([style*="none"])');
    return { clicked: false, blocked: true, label: dialog ? (dialog.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '' };
  }
  document.querySelectorAll('[data-cb-focus]').forEach((x) => { x.removeAttribute('data-cb-focus'); x.style.outline = x.dataset.cbOutline || ''; });
  el.dataset.cbOutline = el.style.outline;
  el.setAttribute('data-cb-focus', '1');
  el.style.outline = '6px solid #FFD400';
  const count = (t) => t ? ((document.body.innerText || '').toLowerCase().split(t.toLowerCase()).length - 1) : 0;
  const before = count(until);
  const textBefore = (el.innerText || '').replace(/\s+/g, ' ').trim();
  window.__cbStop = false;
  let n = 0, reached = false;
  const max = until ? Math.max(times, 100) : times;
  for (; n < max && !window.__cbStop; n++) {
    if (n) await new Promise((r) => setTimeout(r, 350));
    const r = el.getBoundingClientRect();
    const opts = { bubbles: true, cancelable: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('mouseup', opts));
    el.click();
    if (until && count(until) > before) { reached = true; n++; break; }
  }
  const label = (el.getAttribute('aria-label') || el.innerText || el.id || el.tagName).replace(/\s+/g, ' ').trim().slice(0, 60);
  // What appeared: the words right after the newest "until" text ("Achievement unlocked Stifling the press").
  let found = '';
  if (reached) {
    const body = (document.body.innerText || '').replace(/\s+/g, ' ');
    const at = body.toLowerCase().lastIndexOf(until.toLowerCase());
    found = body.slice(at, at + until.length + 50).replace(/ [×✕x] ?$/, '').trim();
  }
  const textAfter = (el.innerText || '').replace(/\s+/g, ' ').trim();
  return { clicked: true, times: n, label, how, reached, found, stopped: window.__cbStop, textBefore, textAfter };
}`;

export const clickTextJs = (text: string, times = 1, until = '') => String.raw`(async () => {
  const want = ${JSON.stringify(text.toLowerCase())};
  // The smallest visible element whose text contains the words.
  let best = null, bestLen = Infinity;
  for (const el of document.querySelectorAll('body *')) {
    if (el.children.length > 8) continue;
    const t = (el.textContent || '').toLowerCase();
    if (!t.includes(want) || t.length >= bestLen) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
    best = el; bestLen = t.length;
  }
  return (${CLICKER})(best, ${Math.max(1, Math.min(100, times))}, ${JSON.stringify(until)}, 'text');
})()`;

export const clickPointJs = (x: number, y: number, times = 1, until = '') => String.raw`(async () => {
  // The smallest visible element under the point: a ticker inside a toolbar, not the toolbar.
  // (The click still bubbles up, so handlers on the containers fire too.)
  const stack = document.elementsFromPoint(${Math.round(x)}, ${Math.round(y)})
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r }) => r.width * r.height > 100);
  stack.sort((a, b) => a.r.width * a.r.height - b.r.width * b.r.height);
  const el = stack.length ? stack[0].e : document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  return (${CLICKER})(el, ${Math.max(1, Math.min(100, times))}, ${JSON.stringify(until)}, 'point');
})()`;

export const STOP_CLICKS_JS = 'window.__cbStop = true';

/**
 * Watch the page for appended content: a new chat message or notification is *added*
 * (nothing removed), while tickers, counters and carousels *replace* what was there.
 * Only additions are kept, and only text a person would read.
 */
export const WATCH_JS = String.raw`(() => {
  if (window.__cbWatch) return true;
  // Appended elements are remembered, and judged when we're about to speak: only what a
  // sighted person can actually see counts. Games build hidden shop rows and tooltips ahead of
  // time (Cookie Clicker's locked buildings); announcing those would be making things up.
  window.__cbAdded = [];
  window.__cbWatch = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type !== 'childList' || r.removedNodes.length) continue;
      for (const n of r.addedNodes) {
        if (n.nodeType !== 1 || n.closest('script,style,iframe,[aria-hidden=true]')) continue;
        window.__cbAdded.push(n);
        if (window.__cbAdded.length > 40) window.__cbAdded.shift();
      }
    }
  });
  window.__cbWatch.observe(document.body, { childList: true, subtree: true });
  return true;
})()`;

/** New, visible content since the last call, as readable lines ("Priya: is it fixed?"). */
export const WATCH_TAKE_JS = String.raw`(() => {
  const nodes = window.__cbAdded || [];
  window.__cbAdded = [];
  const shown = (el) => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
    for (let e = el; e && e !== document.body; e = e.parentElement) {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) < 0.1) return false;
    }
    return true;
  };
  const out = [];
  for (const n of nodes) {
    if (!shown(n)) continue;
    // Join text pieces with spaces ("<b>Priya</b>Is it fixed" → "Priya: Is it fixed"):
    // a short bold/name-like first piece reads as the sender.
    const parts = [];
    const w = document.createTreeWalker(n, NodeFilter.SHOW_TEXT);
    for (let x = w.nextNode(); x; x = w.nextNode()) {
      const v = x.nodeValue.trim();
      // Skip hidden copies (Connections repeats every word in an aria-hidden span), invisible pieces, and repeats.
      if (!v || (x.parentElement && (x.parentElement.closest('[aria-hidden=true],.visually-hidden,.sr-only') || !shown(x.parentElement)))) continue;
      if (!parts.some((p) => p.v === v)) parts.push({ v, el: x.parentElement });
    }
    if (!parts.length) continue;
    const first = parts[0];
    const sender = parts.length > 1 && first.v.length < 32 && first.el && first.el !== n && /^(B|STRONG|H\d|SPAN|A)$/.test(first.el.tagName);
    const t = (sender ? first.v + ': ' + parts.slice(1).map((p) => p.v).join(' ') : parts.map((p) => p.v).join(' ')).replace(/\s+/g, ' ').trim();
    if (t.length < 20 || /sponsored|advertisement|promoted/i.test(t) || out.includes(t)) continue;
    out.push(t.slice(0, 400));
  }
  return out;
})()`;

/**
 * Bring the thing named by `text` into view and return the rectangle of its picture (or of
 * the whole post/card when it has none), in CSS pixels, for a small cropped capture.
 */
export const lookJs = (text: string) => String.raw`(() => {
  const want = ${JSON.stringify(text.toLowerCase())};
  let hit = null, len = Infinity;
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.parentElement && n.parentElement.textContent || '').toLowerCase();
    if (n.nodeValue.toLowerCase().includes(want.slice(0, 40)) && t.length < len) { hit = n.parentElement; len = t.length; }
  }
  if (!hit) return null;
  // The post/card around the text, and the largest image or video inside it.
  let card = hit;
  while (card.parentElement && card.parentElement !== document.body && !card.querySelector('img,video,canvas,picture') && card.textContent.length < 3000) card = card.parentElement;
  const media = [...card.querySelectorAll('img,video,canvas,picture')]
    .map((m) => ({ m, r: m.getBoundingClientRect() }))
    .filter(({ r }) => r.width > 80 && r.height > 80)
    .sort((a, b) => b.r.width * b.r.height - a.r.width * a.r.height)[0];
  const target = media ? media.m : card;
  target.scrollIntoView({ block: 'center', behavior: 'instant' });
  const r = target.getBoundingClientRect();
  const alt = media && (media.m.getAttribute('alt') || media.m.getAttribute('aria-label') || '');
  return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(r.width, innerWidth), height: Math.min(r.height, innerHeight), media: !!media, alt, text: (card.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 400) };
})()`;

/** Hover over the element showing `text` (or at a point) to reveal its tooltip; returns new text that appeared. */
export const hoverJs = (text: string | null, x: number, y: number) => String.raw`(async () => {
  let el = null;
  const want = ${JSON.stringify((text ?? '').toLowerCase())};
  if (want) {
    let len = Infinity;
    for (const e of document.querySelectorAll('body *')) {
      const t = (e.textContent || '').toLowerCase();
      if (e.children.length < 8 && t.includes(want) && t.length < len) { el = e; len = t.length; }
    }
  } else el = document.elementFromPoint(${Math.round(x)}, ${Math.round(y)});
  if (!el) return null;
  const before = document.body.innerText || '';
  const r = el.getBoundingClientRect();
  const opts = { bubbles: true, view: window, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (const type of ['pointerover', 'mouseover', 'mouseenter', 'mousemove']) el.dispatchEvent(new MouseEvent(type, opts));
  await new Promise((res) => setTimeout(res, 300));
  const after = document.body.innerText || '';
  const added = after.split('\n').filter((l) => l.trim() && !before.includes(l)).join(' ').replace(/\s+/g, ' ').trim();
  return { label: (el.getAttribute('title') || el.getAttribute('aria-label') || '').slice(0, 200), tooltip: added.slice(0, 500) };
})()`;

export const scrollByJs = (dir: 'up' | 'down', screens: number) => `(() => { window.scrollBy({ top: ${dir === 'down' ? '' : '-'}window.innerHeight * 0.85 * ${Math.max(1, Math.min(10, screens))}, behavior: 'instant' }); return { y: Math.round(scrollY), max: Math.round(document.documentElement.scrollHeight - innerHeight) }; })()`;

/** Outline the items being talked about (dashed) and scroll the first into view. */
export const highlightJs = (ids: string[]) => String.raw`(() => {
  document.querySelectorAll('[data-cb-hl]').forEach((x) => { x.removeAttribute('data-cb-hl'); x.style.outline = x.dataset.cbHlOutline || ''; });
  const els = ${JSON.stringify(ids)}.map((id) => document.querySelector('[data-cb="' + id + '"]')).filter(Boolean);
  els.forEach((el) => {
    if (el.hasAttribute('data-cb-focus')) return;
    el.dataset.cbHlOutline = el.style.outline;
    el.setAttribute('data-cb-hl', '1');
    el.style.outline = '3px dashed #FFD400';
    el.style.outlineOffset = '2px';
  });
  if (els[0]) els[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
  return els.length;
})()`;
