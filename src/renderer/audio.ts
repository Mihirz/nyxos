// Microphone with voice-activity detection, earcons, and fast speech playback.

const api = () => window.nyx;

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let recorder: MediaRecorder | null = null;
let vadTimer: number | null = null;

async function ensureMic() {
  // A warm mic can die (sleep, headphones unplugged): reopen it instead of recording silence.
  if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live' && t.enabled && !t.muted)) return;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  ctx = new AudioContext();
  analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  ctx.createMediaStreamSource(stream).connect(analyser);
}

/** Short tones: blind users need to *hear* that the mic opened/closed. */
export function earcon(kind: 'start' | 'stop' | 'error') {
  const c = ctx ?? (ctx = new AudioContext());
  const o = c.createOscillator();
  const g = c.createGain();
  const [f1, f2] = kind === 'start' ? [660, 990] : kind === 'stop' ? [880, 520] : [300, 200];
  o.frequency.setValueAtTime(f1, c.currentTime);
  o.frequency.linearRampToValueAtTime(f2, c.currentTime + 0.09);
  g.gain.setValueAtTime(0.12, c.currentTime);
  g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + 0.14);
  o.connect(g).connect(c.destination);
  o.start();
  o.stop(c.currentTime + 0.15);
}

export const isListening = () => recorder?.state === 'recording';

/** Push-to-talk state: the key can be released before the mic has finished starting. */
let wantListening = false;
let startedAt = 0;

/** Open the mic once and keep it warm, so push-to-talk starts instantly and catches the first word. */
export const warmMic = () => ensureMic().catch(() => undefined);

/** Interrupting: tell main how far through the speech we were, so "click that" means what was just heard. */
export function interruptSpeech() {
  if (player && !player.paused && player.duration > 0) api().interrupted({ fraction: Math.min(1, player.currentTime / player.duration), seg: playingSeg.seg, len: playingSeg.len });
  else api().interrupted({ fraction: null });
  stopPlayback();
}

export async function startListening(opts: { vad?: boolean } = { vad: true }) {
  // Silence comes first, every time, before anything that could wait (the mic, a running recording).
  interruptSpeech();
  api().stop();
  wantListening = true;
  if (isListening()) return;
  await ensureMic();
  if (!wantListening) return; // released before the mic was ready: nothing to record
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  const rec = new MediaRecorder(stream!, { mimeType: mime });
  // Each recording keeps its own chunks: a recorder still finishing must not lose its header
  // to a new one starting (that produced "invalid file format" from speech-to-text).
  const chunks: Blob[] = [];
  recorder = rec;
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = async () => {
    if (vadTimer) clearInterval(vadTimer);
    const blob = new Blob(chunks, { type: mime });
    const held = performance.now() - startedAt;
    if ((rec as any)._cancelled) { api().setStatus('idle'); return; }
    if (held < 350 || blob.size < 2500) {
      // Too short to be speech: say so with a tone instead of sending noise to speech-to-text.
      earcon('error');
      api().setStatus('idle');
      return;
    }
    api().sendUtterance(await blob.arrayBuffer(), mime);
  };
  rec.start(100);
  startedAt = performance.now();
  earcon('start');
  api().setStatus('listening');
  if (opts.vad !== false) runVad();
}

export function stopListening(cancel = false) {
  wantListening = false;
  if (!recorder || recorder.state !== 'recording') return;
  (recorder as any)._cancelled = cancel;
  recorder.stop();
  earcon('stop');
}

export function toggleListening() {
  if (isListening()) stopListening();
  else startListening();
}

/** End the utterance after ~0.7s of silence following speech; give up after 6s of nothing. */
function runVad() {
  const buf = new Float32Array(analyser!.fftSize);
  const started = performance.now();
  let heard = false;
  let lastLoud = performance.now();
  vadTimer = window.setInterval(() => {
    analyser!.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);
    const now = performance.now();
    if (rms > 0.018) { heard = true; lastLoud = now; }
    if (heard && now - lastLoud > 700) stopListening();
    else if (!heard && now - started > 6000) stopListening(true);
    else if (now - started > 15000) stopListening();
  }, 50);
}

// ---------------------------------------------------------------- playback

let player: HTMLAudioElement | null = null;
/** Streamed sentences waiting their turn, and where the playing one sits in the full reply. */
let queue: Array<{ data: string; rate: number; seg: number; len: number }> = [];
let playingSeg = { seg: 0, len: 0 };

export function play(base64: string, rate: number, opts: { queue?: boolean; seg?: number; len?: number } = {}) {
  // Audio that arrives while the user holds the talk key (speech that was already being
  // generated) is dropped: the user is talking.
  if (wantListening || isListening()) { api().audioEnded(); return; }
  const item = { data: base64, rate, seg: opts.seg ?? 0, len: opts.len ?? 0 };
  // A streamed sentence waits for the one before it; anything else replaces what's playing.
  if (opts.queue && player && !player.paused) { queue.push(item); return; }
  if (!opts.queue) stopPlayback();
  start(item);
}

function start(item: { data: string; rate: number; seg: number; len: number }) {
  player = new Audio(`data:audio/mpeg;base64,${item.data}`);
  playingSeg = { seg: item.seg, len: item.len };
  player.preservesPitch = true;
  player.playbackRate = Math.min(4, Math.max(0.5, item.rate));
  const next = () => {
    const n = queue.shift();
    if (n && !wantListening) start(n);
    else { player = null; api().audioEnded(); }
  };
  player.onended = next;
  player.onerror = next;
  player.play().catch(next);
}

export function stopPlayback() {
  queue = [];
  if (player) {
    player.pause();
    player.src = '';
    player = null;
  }
}
