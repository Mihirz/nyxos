// Lens: a de-bloated browser built for hierarchical, voice-first navigation.
// Left: the real page (for low-vision users and sighted helpers), with a heavy
// yellow focus ring that follows voice navigation. Right: the page reduced to
// regions → items in large type. In performance mode the webview is never
// created; pages are fetched as text by the main process.

import { useEffect, useRef, useState } from 'react';
import type { LensItem, LensPage, RpcMethods } from '../../shared/types';
import { activateJs, EXTRACT_JS, fillJs, scrollJs, SUBMIT_JS } from '../lens/extract';
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
}

const HOME = 'https://html.duckduckgo.com/html/';

export function Lens({ performance }: { performance: boolean }) {
  const ref = useRef<WebviewEl | null>(null);
  const [page, setPage] = useState<LensPage | null>(null);
  const [url, setUrl] = useState(HOME);
  const waiters = useRef<Array<() => void>>([]);

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const done = () => {
      setUrl(wv.getURL());
      waiters.current.splice(0).forEach((f) => f());
    };
    wv.addEventListener('did-stop-loading', done);
    wv.addEventListener('did-fail-load', done);
    return () => {
      wv.removeEventListener('did-stop-loading', done);
      wv.removeEventListener('did-fail-load', done);
    };
  }, [performance]);

  const loaded = () => new Promise<void>((res) => {
    waiters.current.push(res);
    setTimeout(res, 15000);
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
        ref.current.src = url;
        setUrl(url);
        await p;
      },
      'lens.extract': () => extract(),
      'lens.activate': async ({ id }: { id: string }) => {
        const wv = ref.current;
        if (!wv) return;
        const willNavigate = page?.items.find((i) => i.id === id && (i.kind === 'link' || i.kind === 'button'));
        const p = willNavigate ? Promise.race([loaded(), new Promise((r) => setTimeout(r, 1200))]) : Promise.resolve();
        await wv.executeJavaScript(activateJs(id));
        await p;
      },
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
          await Promise.race([p, new Promise((res) => setTimeout(res, 2500))]);
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

  const regions = page?.items.filter((i) => i.kind === 'region') ?? [];
  const byId = new Map(page?.items.map((i) => [i.id, i]) ?? []);
  const loose = page?.items.filter((i) => i.kind !== 'region' && !regions.some((r) => r.children?.includes(i.id))) ?? [];

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
        <aside className="lens-outline" aria-label="Page outline">
          <h2>{page?.title ?? 'Outline'}</h2>
          {regions.map((r) => (
            <div key={r.id} className="region">
              <h3>{r.label}</h3>
              <ul>{r.children?.slice(0, 12).map((id) => byId.get(id)).filter(Boolean).map((it) => <OutlineItem key={it!.id} item={it!} />)}</ul>
            </div>
          ))}
          {loose.length > 0 && (
            <div className="region">
              {regions.length > 0 && <h3>other</h3>}
              <ul>{loose.slice(0, 40).map((it) => <OutlineItem key={it.id} item={it} />)}</ul>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}

function OutlineItem({ item }: { item: LensItem }) {
  const glyph = { heading: 'H' + (item.level ?? ''), link: '↗', button: '●', input: '▭', result: '★', region: '▣', text: '¶' }[item.kind];
  return <li className={`k-${item.kind}`}><b>{glyph}</b> {item.label}</li>;
}
