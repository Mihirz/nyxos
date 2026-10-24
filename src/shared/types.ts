// Types shared by main, preload and renderer.

export type Status = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface OptionView {
  label: string;
  detail?: string;
}

export interface LogEntry {
  id: number;
  at: number;
  who: 'user' | 'callbacks' | 'system';
  text: string;
  via?: 'voice' | 'typed' | 'grammar' | 'claude' | 'gemini' | 'follow';
  ms?: number;
}

export interface UiState {
  status: Status;
  level: string;
  options: OptionView[];
  optionsTitle: string;
  rate: number;
  curtain: boolean;
  performance: boolean;
  follow: boolean;
  view: 'home' | 'lens';
  providers: { claude: boolean; gemini: boolean; tts: string; stt: string };
}

// ---- Lens (de-bloated browser) ----

export type LensKind = 'heading' | 'link' | 'button' | 'input' | 'region' | 'result' | 'text';

export interface LensItem {
  id: string;
  kind: LensKind;
  label: string;
  level?: number;
  href?: string;
  inputType?: string;
  children?: string[]; // ids, for regions
  count?: { links: number; inputs: number; buttons: number; headings: number };
}

export interface LensPage {
  url: string;
  title: string;
  items: LensItem[];
  article: string;
  /** Performance mode renders this text-only instead of a live webview. */
  textOnly?: boolean;
}

/** main → renderer requests the renderer must answer. */
export interface RpcMethods {
  'lens.navigate': { url: string };
  'lens.extract': {};
  'lens.activate': { id: string };
  'lens.fill': { id: string; text: string };
  'lens.key': { key: string };
  'lens.scroll': { direction: 'up' | 'down' };
  'lens.back': {};
  'lens.showPage': { page: LensPage };
}
