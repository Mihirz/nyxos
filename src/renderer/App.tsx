import { useEffect, useRef, useState } from 'react';
import type { LensPage, LogEntry, RpcMethods, UiState } from '../shared/types';
import { earcon, interruptSpeech, play, startListening, stopListening, stopPlayback, toggleListening, warmMic } from './audio';
import { BrailleDisplay } from './components/BrailleDisplay';
import { BoltIcon, EarIcon, EyeOffIcon, FollowIcon, GlobeIcon, HomeIcon, KeyboardIcon, MicIcon, MoonIcon, SpeakerIcon, ThinkIcon } from './components/Icons';
import { Lens, lensHandlers, Outline } from './components/Lens';

const api = window.nyx;

const INITIAL: UiState = {
  status: 'idle', level: 'Windows', options: [], optionsTitle: '', rate: 1.6, curtain: false, performance: false, follow: true,
  view: 'home', providers: { claude: false, gemini: false, tts: 'say', stt: 'none' }, verbosity: 'normal', discreet: false,
};

export function App() {
  const [ui, setUi] = useState<UiState>(INITIAL);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [braille, setBraille] = useState('');
  const [page, setPage] = useState<LensPage | null>(null);
  const [shortcodes, setShortcodes] = useState<Array<[string, string]>>([]);
  const [input, setInput] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const offs = [
      api.onUi((s: UiState) => setUi(s)),
      api.onLog((e: LogEntry) => setLog((l) => [...l.slice(-200), e])),
      api.onBraille((b: string) => setBraille(b)),
      api.onAudioPlay((p: { data: string; rate: number; queue?: boolean; seg?: number; len?: number }) => play(p.data, p.rate, p)),
      api.onAudioStop(() => stopPlayback()),
      api.onListenToggle(() => toggleListening()),
      api.onCommandFocus(() => inputRef.current?.focus()),
      api.onShortcodes((s: Array<[string, string]>) => setShortcodes(s)),
      api.onEarcon((k: 'start' | 'stop' | 'error') => earcon(k)),
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

  // Every key works the same wherever focus is: a blind user can't see what's focused.
  //   Space   push-to-talk (in the command bar only while it's empty; otherwise it types a space)
  //   Esc     stop talking, clear the command bar
  //   1-9     pick an option
  //   Enter   run what's typed
  //   any other character starts typing into the command bar ("g 42", "o safari")
  // Listeners run in the capture phase, so no focused button or link can swallow a key.
  const inputValue = useRef('');
  inputValue.current = input;
  const pttFromSpace = useRef(false);
  useEffect(() => {
    const inBar = () => document.activeElement === inputRef.current;
    const down = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return; // app and system shortcuts stay theirs
      if (e.code === 'Space' && !(inBar() && inputValue.current.length > 0)) {
        e.preventDefault();
        e.stopPropagation();
        if (!e.repeat) { pttFromSpace.current = true; startListening({ vad: false }); }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setInput('');
        inputRef.current?.blur();
        interruptSpeech();
        api.stop();
        return;
      }
      if (inBar()) return; // typing in the command bar (Enter submits the form)
      if (/^[1-9]$/.test(e.key)) { e.preventDefault(); api.runText(e.key, 'typed'); return; }
      if (e.key === 'Enter') {
        e.preventDefault();
        if (inputValue.current.trim()) { api.runText(inputValue.current.trim(), 'typed'); setInput(''); }
        else inputRef.current?.focus();
        return;
      }
      if (e.key.length === 1) {
        // Start typing a command from anywhere: the character goes into the bar, focus follows.
        e.preventDefault();
        setInput((v) => v + e.key);
        inputRef.current?.focus();
      }
    };
    // Always stop on release, even if the mic is still starting (startListening checks for that).
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && pttFromSpace.current) {
        e.preventDefault();
        e.stopPropagation();
        pttFromSpace.current = false;
        stopListening();
      }
    };
    // If the window loses focus mid-press (the key-up never arrives), don't leave the mic open.
    const lost = () => { if (pttFromSpace.current) { pttFromSpace.current = false; stopListening(); } };
    if (!api.testRun) warmMic();
    window.addEventListener('keydown', down, true);
    window.addEventListener('keyup', up, true);
    window.addEventListener('blur', lost);
    return () => {
      window.removeEventListener('keydown', down, true);
      window.removeEventListener('keyup', up, true);
      window.removeEventListener('blur', lost);
    };
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
        <div className="brand"><MoonIcon />nyxOS</div>
        <nav className="views">
          <button className={ui.view === 'home' ? 'on' : ''} onClick={() => setView('home')}><HomeIcon /> Home</button>
          <button className={ui.view === 'lens' ? 'on' : ''} onClick={() => setView('lens')}><GlobeIcon /> Lens</button>
        </nav>
        <div className="toggles">
          <Toggle on={ui.follow} label="Follow" icon={<FollowIcon />} cmd={ui.follow ? 'follow mode off' : 'follow mode on'} />
          <Toggle on={ui.performance} label="Perf" icon={<BoltIcon />} cmd={ui.performance ? 'performance mode off' : 'performance mode on'} />
          <Toggle on={ui.curtain} label="Curtain" icon={<EyeOffIcon />} cmd={ui.curtain ? 'screen curtain off' : 'screen curtain on'} />
          <Toggle on label={`Voice: ${({ cartesia: 'Cartesia', elevenlabs: 'ElevenLabs', say: 'Mac' } as Record<string, string>)[ui.providers.tts] ?? ui.providers.tts}`} icon={<SpeakerIcon />} cmd="switch voice" />
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
            <p className="hint">Hold <kbd>Space</kbd> to talk, or press <kbd>⌥ Space</kbd> from any app. Type a shortcode anywhere in nyxOS and press <kbd>Enter</kbd>. <kbd>Esc</kbd> stops.</p>
            <div className="cheatsheet">
              {shortcodes.map(([k, v]) => <div key={k}><kbd>{k}</kbd> {v}</div>)}
            </div>
          </div>
          <div className={`lens-wrap ${ui.view === 'lens' ? '' : 'hidden'}`}>
            <Lens performance={ui.performance} onPage={setPage} />
          </div>
        </section>

        <aside className={`right ${ui.view === 'lens' && page ? 'with-outline' : ''}`}>
          <h2 className="side-title">Transcript</h2>
          <div className="transcript" ref={logRef} aria-live="polite">
            {log.map((e) => (
              <div key={e.id} className={`entry ${e.who}`}>
                <span className="who">{e.who === 'user' ? (e.via === 'typed' ? <KeyboardIcon /> : <MicIcon />) : e.who === 'nyx' ? '◆' : '·'}</span>
                <span className="text">{e.text}</span>
                {(e.via || e.ms != null) && e.who !== 'user' && <span className="meta">{e.via}{e.ms != null ? ` · ${e.ms}ms` : ''}</span>}
              </div>
            ))}
          </div>
          {ui.view === 'lens' && <Outline page={page} />}
        </aside>
      </main>

      <footer className="bottom">
        <BrailleDisplay text={braille} />
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
    <button className="orb" onClick={(e) => { e.currentTarget.blur(); onClick(); }} aria-label={label}>
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
