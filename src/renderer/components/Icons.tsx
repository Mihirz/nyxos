// Low-vision iconography: one idea per icon, thick strokes, no fine detail,
// recognizable as a silhouette at a glance or under heavy magnification.

const S = { fill: 'none', stroke: 'currentColor', strokeWidth: 3.5, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };

export const MicIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><rect x="16" y="5" width="16" height="26" rx="8" {...S} /><path d="M9 23a15 15 0 0 0 30 0M24 38v6" {...S} /></svg>
);
export const EarIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><path d="M14 20a10 10 0 1 1 20 0c0 7-8 9-8 16a6 6 0 0 1-11 3" {...S} /><path d="M20 20a4 4 0 1 1 8 0" {...S} /></svg>
);
export const SpeakerIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><path d="M6 18h8l11-9v30l-11-9H6z" {...S} /><path d="M32 17a9 9 0 0 1 0 14M37 11a17 17 0 0 1 0 26" {...S} /></svg>
);
export const ThinkIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><circle cx="12" cy="24" r="4" fill="currentColor" /><circle cx="24" cy="24" r="4" fill="currentColor" /><circle cx="36" cy="24" r="4" fill="currentColor" /></svg>
);
export const GlobeIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><circle cx="24" cy="24" r="18" {...S} /><path d="M6 24h36M24 6c-7 8-7 28 0 36M24 6c7 8 7 28 0 36" {...S} /></svg>
);
export const HomeIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><path d="M6 22 24 7l18 15M11 19v21h26V19" {...S} /></svg>
);
export const EyeOffIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><path d="M4 24s7-13 20-13 20 13 20 13-7 13-20 13S4 24 4 24z" {...S} /><path d="M8 40 40 8" {...S} /></svg>
);
export const BoltIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><path d="M27 4 10 27h13l-3 17 18-24H25z" {...S} /></svg>
);
export const FollowIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden><path d="M8 14h32M8 24h32M8 34h18" {...S} /><path d="M34 30l6 4-6 4z" fill="currentColor" stroke="currentColor" strokeWidth={2} /></svg>
);
export const BrailleIcon = () => (
  <svg viewBox="0 0 48 48" aria-hidden>{[[16, 10], [16, 24], [32, 10], [32, 38], [16, 38]].map(([x, y], i) => <circle key={i} cx={x} cy={y} r="5" fill="currentColor" />)}</svg>
);
