// Microphone with voice-activity detection, earcons, and fast speech playback.

const api = () => window.callbacks;

let stream: MediaStream | null = null;
let ctx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
let recorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let vadTimer: number | null = null;

async function ensureMic() {
  if (stream) return;
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

export async function startListening(opts: { vad?: boolean } = { vad: true }) {
  if (isListening()) return;
  stopPlayback();
  api().stop();
  await ensureMic();
  chunks = [];
  const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
  recorder = new MediaRecorder(stream!, { mimeType: mime });
  recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  recorder.onstop = async () => {
    if (vadTimer) clearInterval(vadTimer);
    const blob = new Blob(chunks, { type: mime });
    if (blob.size < 2500 || (recorder as any)._cancelled) { api().setStatus('idle'); return; }
    api().sendUtterance(await blob.arrayBuffer(), mime);
  };
  recorder.start(100);
  earcon('start');
  api().setStatus('listening');
  if (opts.vad !== false) runVad();
}

export function stopListening(cancel = false) {
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

export function play(base64: string, rate: number) {
  stopPlayback();
  player = new Audio(`data:audio/mpeg;base64,${base64}`);
  player.preservesPitch = true;
  player.playbackRate = Math.min(4, Math.max(0.5, rate));
  player.onended = () => api().audioEnded();
  player.onerror = () => api().audioEnded();
  player.play().catch(() => api().audioEnded());
}

export function stopPlayback() {
  if (player) {
    player.pause();
    player.src = '';
    player = null;
  }
}
