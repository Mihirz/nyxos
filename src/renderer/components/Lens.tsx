// Lens: a de-bloated browser built for hierarchical, voice-first navigation.
// The real page (for low-vision users and sighted helpers) gets a heavy yellow
// focus ring that follows voice navigation; <Outline> shows the same page reduced
// to regions → items in large type, in the side column. In performance mode the
// webview is never created; pages are fetched as text by the main process.

import { useEffect, useRef, useState } from 'react';
import type { LensItem, LensPage, RpcMethods } from '../../shared/types';
import { activateJs, clickPointJs, clickTextJs, EXTRACT_JS, fillJs, findJs, highlightJs, hoverJs, lookJs, scrollByJs, scrollJs, STOP_CLICKS_JS, SUBMIT_JS, WATCH_JS, WATCH_TAKE_JS } from '../lens/extract';
import { GlobeIcon } from './Icons';

type Handler = (args: any) => Promise<unknown>;
export const lensHandlers: Partial<Record<keyof RpcMethods, Handler>> = {};

interface WebviewEl extends HTMLElement {
  src: string;
  executeJavaScript<T = unknown>(code: string): Promise<T>;
  goBack(): void;
  canGoBack(): boolean;
  sendInputEvent(e: { type: string; keyCode: string; modifiers?: string[] }): void;
  getURL(): string;
  getWebContentsId(): number;
  setZoomFactor(f: number): void;
  getZoomFactor(): number;
  loadURL(url: string): Promise<void>;
}

const HOME = 'https://html.duckduckgo.com/html/';

export function Lens({ performance, onPage }: { performance: boolean; onPage: (p: LensPage | null) => void }) {
  const ref = useRef<WebviewEl | null>(null);
  const [page, setPageState] = useState<LensPage | null>(null);
  const setPage = (p: LensPage | null) => { setPageState(p); onPage(p); };
  const [url, setUrl] = useState(HOME);
  const waiters = useRef<Array<() => void>>([]);
  const loading = useRef(false);
  const typingIntoPage = useRef(false);

  // A page counts as loaded when its document is ready, not when every ad iframe finishes:
  // busy sites (Amazon) keep the loading spinner going indefinitely.
  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const start = (e: Event) => {
      const ev = e as Event & { isMainFrame?: boolean; isSameDocument?: boolean };
      if (ev.isMainFrame && !ev.isSameDocument) loading.current = true;
    };
    // Fit the page's desktop layout to the Lens width: the whole page shows, scaled, instead of
    // a cramped mobile slice where what we're talking about is often off to the side.
    const fit = () => { try { wv.setZoomFactor(Math.max(0.5, Math.min(1, wv.clientWidth / 1280))); } catch { /* not attached yet */ } };
    const ro = new ResizeObserver(fit);
    ro.observe(wv);
    const done = () => {
      fit();
      loading.current = false;
      setUrl(wv.getURL());
      wv.executeJavaScript(WATCH_JS).catch(() => undefined);
      setTimeout(() => waiters.current.splice(0).forEach((f) => f()), 350);
    };
    const failed = (e: Event) => { if ((e as Event & { isMainFrame?: boolean }).isMainFrame !== false) done(); };
    // Keyboard focus never stays in the page: a blind user can't tell it moved there, and every
    // nyxOS key (Space, Esc, numbers, typing) must keep working. Clicks still reach the page.
    // (Not while nyxOS itself is typing into the page: a game moving to its next square takes
    // focus, and handing it back would drop the rest of the letters.)
    const giveBack = () => setTimeout(() => { if (typingIntoPage.current) return; wv.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); }, 0);
    wv.addEventListener('focus', giveBack);
    const settled = () => { loading.current = false; };
    wv.addEventListener('did-start-navigation', start);
    wv.addEventListener('did-stop-loading', settled);
    wv.addEventListener('did-navigate-in-page', settled);
    wv.addEventListener('dom-ready', done);
    wv.addEventListener('did-fail-load', failed);
    return () => {
      ro.disconnect();
      wv.removeEventListener('focus', giveBack);
      wv.removeEventListener('did-start-navigation', start);
      wv.removeEventListener('did-stop-loading', settled);
      wv.removeEventListener('did-navigate-in-page', settled);
      wv.removeEventListener('dom-ready', done);
      wv.removeEventListener('did-fail-load', failed);
    };
  }, [performance]);

  // Capped: a navigation that never reaches dom-ready must not stall every later action.
  const loaded = (max = 8000) => new Promise<void>((res) => {
    waiters.current.push(res);
    setTimeout(() => { loading.current = false; res(); }, max);
  });

  const extract = async (): Promise<LensPage> => {
    const p = performance && page ? page : await ref.current!.executeJavaScript<LensPage>(EXTRACT_JS);
    setPage(p);
    return p;
  };

  useEffect(() => {
    Object.assign(lensHandlers, {
      'lens.navigate': async ({ url }: { url: string }) => {
        if (!ref.current) return;
        const p = loaded();
        // loadURL always navigates; assigning the same src again is silently ignored.
        ref.current.loadURL(url).catch(() => undefined);
        setUrl(url);
        await p;
      },
      'lens.extract': () => extract(),
      'lens.activate': async ({ id, times = 1 }: { id: string; times?: number }) => {
        const wv = ref.current;
        if (!wv) return { navigated: false, found: false };
        const before = wv.getURL();
        const p = loaded();
        const out = await wv.executeJavaScript<boolean | { checked: boolean }>(activateJs(id, times));
        if (!out) return { navigated: false, found: false }; // the page re-rendered; the caller looks again
        if (typeof out === 'object') return { navigated: false, found: true, checked: out.checked };
        // A click that starts a page load (or changes the URL in a single-page app) gets
        // waited out fully, so we describe the new page, not the old one.
        await new Promise((r) => setTimeout(r, 450));
        if (loading.current) await p;
        else await new Promise((r) => setTimeout(r, 250));
        return { navigated: wv.getURL() !== before, found: true };
      },
      // Typing into games: key presses only, one per letter. Games read keydown and move to the
      // next square themselves; an extra character event would pile letters into one square.
      'lens.typeKeys': async ({ text, selectFirst }: { text: string; selectFirst?: string }) => {
        const wv = ref.current;
        if (!wv) return;
        typingIntoPage.current = true;
        try {
          // Re-select the target (a crossword clue) inside the same uninterrupted step, so the
          // game's selection and direction are fresh when the letters arrive.
          // Focus the page first, then select: focusing after selecting resets a crossword's direction.
          if (selectFirst) { wv.focus(); await new Promise((r) => setTimeout(r, 60)); await wv.executeJavaScript(activateJs(selectFirst, 1)); await new Promise((r) => setTimeout(r, 200)); }
          // No wv.focus() here: refocusing the page fires the square's own focus handler, which
          // resets a crossword's direction to across. Key events reach the page without it.
          for (const ch of text) {
            const keyCode = ch === ' ' ? 'Space' : ch;
            wv.sendInputEvent({ type: 'keyDown', keyCode });
            wv.sendInputEvent({ type: 'keyUp', keyCode });
            await new Promise((r) => setTimeout(r, 60));
          }
        } finally {
          // Hand focus back to nyxOS once the letters are in.
          setTimeout(() => { typingIntoPage.current = false; wv.blur(); }, 150);
        }
      },
      // A real mouse click at the element's center, for games that ignore script-made clicks
      // (NYT Connections' tiles and Submit). One click, as the user asked, like Voice Control.
      'lens.realClick': async ({ id }: { id: string }) => {
        const wv = ref.current;
        if (!wv) return { found: false };
        // Where to click: the element (or a hidden checkbox's visible label), but only once it is
        // the thing actually under that point and has stopped moving (boards animate after a solve).
        const locate = () => wv.executeJavaScript<{ x: number; y: number; checked: boolean | null } | null>(`(() => {
          const target = document.querySelector('[data-cb="${id}"]');
          if (!target) return null;
          let el = target;
          if (el.matches('input[type=checkbox],input[type=radio]')) { const lab = el.closest('label') || (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')); if (lab) el = lab; }
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) return null;
          const x = r.left + r.width / 2, y = r.top + r.height / 2;
          const hit = document.elementFromPoint(x, y);
          const onTarget = hit && (el === hit || el.contains(hit) || hit.contains(el));
          return { x, y, onTarget, checked: 'checked' in target && (target.type === 'checkbox' || target.type === 'radio') ? target.checked : null };
        })()`);
        let at = await locate();
        for (let i = 0; i < 8 && at && !(at as { onTarget?: boolean }).onTarget; i++) { await new Promise((r) => setTimeout(r, 150)); at = await locate(); }
        if (!at) return { found: false };
        let prev = { x: -1, y: -1 };
        for (let i = 0; i < 6 && (Math.abs(prev.x - at.x) > 1 || Math.abs(prev.y - at.y) > 1); i++) { prev = { x: at.x, y: at.y }; await new Promise((r) => setTimeout(r, 120)); at = (await locate()) ?? at; }
        const wasChecked = at.checked;
        const z = wv.getZoomFactor();
        const x = Math.round(at.x * z), y = Math.round(at.y * z);
        wv.sendInputEvent({ type: 'mouseMove', x, y } as never);
        wv.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 } as never);
        wv.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 } as never);
        await new Promise((r) => setTimeout(r, 250));
        const checked = await wv.executeJavaScript<boolean | null>(`(() => { const el = document.querySelector('[data-cb="${id}"]'); return el && 'checked' in el && (el.type === 'checkbox' || el.type === 'radio') ? el.checked : null; })()`);
        return { found: true, checked, changed: wasChecked == null || checked !== wasChecked };
      },
      // Crosswords: one letter per square, each square focused before its key press, so the
      // letters land in the right squares whichever direction the game thinks is active.
      'lens.typeCells': async ({ cells, text }: { cells: Array<{ x: number; y: number }>; text: string }) => {
        const wv = ref.current;
        if (!wv) return 0;
        typingIntoPage.current = true;
        let typed = 0;
        try {
          wv.focus();
          for (let i = 0; i < Math.min(cells.length, text.length); i++) {
            const { x, y } = cells[i];
            const ok = await wv.executeJavaScript<boolean>(`(() => { const c = document.querySelector('input[id^="cell-input-${x}-${y}-"]'); if (!c) return false; c.focus(); return true; })()`);
            if (!ok) break;
            await new Promise((r) => setTimeout(r, 40));
            wv.sendInputEvent({ type: 'keyDown', keyCode: text[i] });
            wv.sendInputEvent({ type: 'keyUp', keyCode: text[i] });
            await new Promise((r) => setTimeout(r, 60));
            typed++;
          }
        } finally {
          setTimeout(() => { typingIntoPage.current = false; wv.blur(); }, 150);
        }
        return typed;
      },
      'lens.highlight': async ({ ids }: { ids: string[] }) => ref.current?.executeJavaScript(highlightJs(ids)),
      'lens.eval': async ({ code }: { code: string }) => ref.current?.executeJavaScript(code),
      'lens.find': async ({ query }: { query: string }) => ref.current?.executeJavaScript<string[]>(findJs(query)) ?? [],
      'lens.clickText': async ({ text, times, until }: { text: string; times: number; until: string }) => ref.current?.executeJavaScript(clickTextJs(text, times, until)),
      'lens.clickPoint': async ({ x, y, times, until }: { x: number; y: number; times: number; until: string }) => ref.current?.executeJavaScript(clickPointJs(x, y, times, until)),
      'lens.stopClicks': async () => ref.current?.executeJavaScript(STOP_CLICKS_JS),
      'lens.changes': async () => ref.current?.executeJavaScript<string[]>(WATCH_TAKE_JS) ?? [],
      'lens.look': async ({ text }: { text: string }) => ref.current?.executeJavaScript(lookJs(text)),
      'lens.hover': async ({ text, x, y }: { text: string | null; x: number; y: number }) => ref.current?.executeJavaScript(hoverJs(text, x, y)),
      'lens.scrollBy': async ({ direction, screens }: { direction: 'up' | 'down'; screens: number }) => ref.current?.executeJavaScript(scrollByJs(direction, screens)),
      // The main process captures the pixels; it only needs to know which contents.
      'lens.capture': async () => ref.current?.getWebContentsId() ?? null,
      'lens.fill': async ({ id, text }: { id: string; text: string }) => ref.current?.executeJavaScript(fillJs(id, text)),
      'lens.key': async ({ key }: { key: string }) => {
        const wv = ref.current;
        if (!wv) return;
        if (key === 'return') {
          const p = loaded();
          const r = await wv.executeJavaScript<string>(SUBMIT_JS);
          if (r === 'none') {
            wv.sendInputEvent({ type: 'keyDown', keyCode: 'Return' });
            wv.sendInputEvent({ type: 'keyUp', keyCode: 'Return' });
          }
          await new Promise((res) => setTimeout(res, 450));
          if (loading.current) await p;
          return;
        }
        const parts = key.split('+');
        const k = parts.pop()!;
        const modifiers = parts.map((m) => ({ cmd: 'meta', ctrl: 'control', alt: 'alt', shift: 'shift' })[m] ?? m);
        wv.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers });
        wv.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers });
      },
      'lens.scroll': async ({ direction }: { direction: 'up' | 'down' }) => ref.current?.executeJavaScript(scrollJs(direction)),
      'lens.back': async () => {
        const wv = ref.current;
        if (wv?.canGoBack()) {
          const p = loaded();
          wv.goBack();
          await p;
        }
      },
      'lens.showPage': async ({ page }: { page: LensPage }) => {
        setPage(page);
        setUrl(page.url);
      },
    } satisfies Partial<Record<keyof RpcMethods, Handler>>);
  });

  return (
    <div className={`lens ${performance ? 'text-only' : ''}`}>
      <div className="lens-bar">
        <GlobeIcon />
        <span className="lens-url">{url.replace(/^https?:\/\//, '')}</span>
        {performance && <span className="badge">TEXT ONLY</span>}
      </div>
      <div className="lens-body">
        {!performance && <webview ref={ref as never} src={HOME} className="lens-web" partition="persist:lens" />}
        {performance && (
          <article className="lens-text">
            <h1>{page?.title ?? 'Performance mode'}</h1>
            <p>{page?.article?.slice(0, 6000) ?? 'Pages load as plain text. Say search, then what you want.'}</p>
          </article>
        )}
      </div>
    </div>
  );
}

export function Outline({ page }: { page: LensPage | null }) {
  if (!page) return null;
  const regions = page.items.filter((i) => i.kind === 'region');
  const byId = new Map(page.items.map((i) => [i.id, i]));
  const loose = page.items.filter((i) => i.kind !== 'region' && !regions.some((r) => r.children?.includes(i.id)));
  return (
    <section className="lens-outline" aria-label="Page outline">
      <h2>{page.title}</h2>
      {regions.map((r) => (
        <div key={r.id} className="region">
          <h3>{r.label}</h3>
          <ul>{r.children?.slice(0, 12).map((id) => byId.get(id)).filter(Boolean).map((it, i) => <OutlineItem key={`${it!.id}-${i}`} item={it!} />)}</ul>
        </div>
      ))}
      {loose.length > 0 && (
        <div className="region">
          {regions.length > 0 && <h3>other</h3>}
          <ul>{loose.slice(0, 40).map((it, i) => <OutlineItem key={`${it.id}-${i}`} item={it} />)}</ul>
        </div>
      )}
    </section>
  );
}

function OutlineItem({ item }: { item: LensItem }) {
  const glyph = { heading: 'H' + (item.level ?? ''), link: '↗', button: '●', input: '▭', result: '★', region: '▣', text: '¶' }[item.kind];
  return <li className={`k-${item.kind}`}><b>{glyph}</b> {item.label}</li>;
}
