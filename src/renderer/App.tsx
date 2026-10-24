import { useEffect, useRef, useState } from 'react';
import type { LogEntry, RpcMethods, UiState } from '../shared/types';
import { isListening, play, startListening, stopListening, stopPlayback, toggleListening } from './audio';
import { BrailleDisplay } from './components/BrailleDisplay';
import { BoltIcon, EarIcon, EyeOffIcon, FollowIcon, GlobeIcon, HomeIcon, MicIcon, SpeakerIcon, ThinkIcon } from './components/Icons';
import { Lens, lensHandlers } from './components/Lens';

const api = window.callbacks;

const INITIAL: UiState = {
  status: 'idle', level: 'Windows', options: [], optionsTitle: '', rate: 1.6, curtain: false, performance: false, follow: false,
  view: 'home', providers: { claude: false, gemini: false, tts: 'say', stt: 'none' },
};

export function App() {
  const [ui, setUi] = useState<UiState>(INITIAL);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [braille, setBraille] = useState('');
  const [brailleText, setBrailleText] = useState('');
  const [shortcodes, setShortcodes] = useState<Array<[string, string]>>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const offs = [
      api.onUi((s: UiState) => setUi(s)),
      api.onLog((e: LogEntry) => {
        setLog((l) => [...l.slice(-200), e]);
        if (e.who === 'callbacks') setBrailleText(e.text);
      }),
      api.onBraille((b: string) => setBraille(b)),
      api.onAudioPlay((p: { data: string; rate: number }) => play(p.data, p.rate)),
      api.onAudioStop(() => stopPlayback()),
      api.onListenToggle(() => toggleListening()),
      api.onCommandFocus(() => inputRef.current?.focus()),
      api.onShortcodes((s: Array<[string, string]>) => setShortcodes(s)),
      api.onRpc(async (req: { id: number; method: keyof RpcMethods; args: any }) => {
        try {
          // The Lens may still be mounting right after a view switch.
          for (let i = 0; i < 60 && !lensHandlers[req.method]; i++) await new Promise((r) => setTimeout(r, 50));
          const h = lensHandlers[req.method];
          if (!h) throw new Error(`no handler for ${req.method}`);
          api.rpcRespond({ id: req.id, result: await h(req.args) });
        } catch (e) {
          api.rpcRespond({ id: req.id, error: (e as Error).message });
        }
      }),
    ];
    return () => offs.forEach((off) => off());
  }, []);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [log]);

  // Hold Space (outside the command bar) for push-to-talk while Callbacks is focused.
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (document.activeElement === inputRef.current) {
        if (e.key === 'Escape') { inputRef.current?.blur(); api.stop(); }
        return;
      }
      if (e.code === 'Space' && !e.repeat) { e.preventDefault(); startListening({ vad: false }); }
      else if (e.key === 'Escape') { api.stop(); stopPlayback(); }
      else if (/^[1-9]$/.test(e.key)) api.runText(e.key, 'typed');
      else if (e.key === '/' || e.key === 'Enter') { e.preventDefault(); inputRef.current?.focus(); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && isListening() && document.activeElement !== inputRef.current) stopListening();
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    api.runText(text, 'typed');
  };

  const setView = (v: UiState['view']) => api.setView(v);

  return (
    <div className={`app status-${ui.status}`}>
      <header className="topbar">
        <div className="brand">CALLBACKS</div>
        <nav className="views">
          <button className={ui.view === 'home' ? 'on' : ''} onClick={() => setView('home')}><HomeIcon /> Home</button>
          <button className={ui.view === 'lens' ? 'on' : ''} onClick={() => setView('lens')}><GlobeIcon /> Lens</button>
        </nav>
        <div className="toggles">
          <Toggle on={ui.follow} label="Follow" icon={<FollowIcon />} cmd={ui.follow ? 'follow mode off' : 'follow mode on'} />
          <Toggle on={ui.performance} label="Perf" icon={<BoltIcon />} cmd={ui.performance ? 'performance mode off' : 'performance mode on'} />
          <Toggle on={ui.curtain} label="Curtain" icon={<EyeOffIcon />} cmd={ui.curtain ? 'screen curtain off' : 'screen curtain on'} />
        </div>
      </header>

      <main className="stage">
        <aside className="left">
          <StatusOrb status={ui.status} onClick={() => toggleListening()} />
          <div className="level">
            <span>LEVEL</span>
            <strong>{ui.level}</strong>
          </div>
          <div className="options">
            <h2>{ui.optionsTitle || 'Say “windows”'}</h2>
            <ol>
              {ui.options.slice(0, 9).map((o, i) => (
                <li key={i} onClick={() => api.runText(String(i + 1), 'typed')}>
                  <span className="num">{i + 1}</span>
                  <span className="lbl">{o.label}{o.detail && <em>{o.detail}</em>}</span>
                </li>
              ))}
            </ol>
            {ui.options.length > 9 && <p className="more">+{ui.options.length - 9} more — say “next”</p>}
          </div>
          <div className="providers">
            <span className={ui.providers.claude ? 'ok' : ''}>Claude</span>
            <span className={ui.providers.gemini ? 'ok' : ''}>Gemini</span>
            <span className="ok">TTS: {ui.providers.tts}</span>
            <span className={ui.providers.stt !== 'none' ? 'ok' : ''}>STT: {ui.providers.stt}</span>
            <span className="ok">{ui.rate}×</span>
          </div>
        </aside>

        <section className="center">
          <div className={`home ${ui.view === 'home' ? '' : 'hidden'}`}>
            <div className="transcript" ref={logRef} aria-live="polite">
              {log.length === 0 && <p className="hint">Press <kbd>⌥ Space</kbd> anywhere and speak, hold <kbd>Space</kbd> here, or type a shortcode below.</p>}
              {log.map((e) => (
                <div key={e.id} className={`entry ${e.who}`}>
                  <span className="who">{e.who === 'user' ? (e.via === 'typed' ? '⌨' : '🗣') : e.who === 'callbacks' ? '◆' : '·'}</span>
                  <span className="text">{e.text}</span>
                  {(e.via || e.ms != null) && e.who !== 'user' && <span className="meta">{e.via}{e.ms != null ? ` · ${e.ms}ms` : ''}</span>}
                </div>
              ))}
            </div>
            <div className="cheatsheet">
              {shortcodes.map(([k, v]) => <div key={k}><kbd>{k}</kbd> {v}</div>)}
            </div>
          </div>
          <div className={`lens-wrap ${ui.view === 'lens' ? '' : 'hidden'}`}>
            <Lens performance={ui.performance} />
          </div>
        </section>
      </main>

      <footer className="bottom">
        <BrailleDisplay braille={braille} text={brailleText} />
        <form className="commandbar" onSubmit={submit}>
          <span className="prompt">›</span>
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="g 42 · o safari · t hello · s tacos near me · / ask anything"
            spellCheck={false}
            aria-label="Command"
          />
        </form>
      </footer>
    </div>
  );
}

function StatusOrb({ status, onClick }: { status: UiState['status']; onClick: () => void }) {
  const icon = { idle: <MicIcon />, listening: <EarIcon />, transcribing: <ThinkIcon />, thinking: <ThinkIcon />, speaking: <SpeakerIcon /> }[status];
  const label = { idle: 'Ready', listening: 'Listening', transcribing: 'Hearing', thinking: 'Working', speaking: 'Speaking' }[status];
  return (
    <button className="orb" onClick={onClick} aria-label={label}>
      <div className="ring">{icon}</div>
      <span>{label}</span>
    </button>
  );
}

function Toggle({ on, label, icon, cmd }: { on: boolean; label: string; icon: React.ReactNode; cmd: string }) {
  return (
    <button className={`toggle ${on ? 'on' : ''}`} onClick={() => api.runText(cmd, 'voice')} aria-pressed={on}>
      {icon}<span>{label}</span>
    </button>
  );
}
