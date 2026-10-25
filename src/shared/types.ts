// Types shared by main, preload and renderer.

export type Status = 'idle' | 'listening' | 'transcribing' | 'thinking' | 'speaking';

export interface OptionView {
  label: string;
  detail?: string;
}

export interface LogEntry {
  id: number;
  at: number;
  who: 'user' | 'nyx' | 'system';
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
  verbosity: 'brief' | 'normal' | 'detailed';
  /** Never speak names or message text aloud (public places, work). */
  discreet: boolean;
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
  /** Price shown with this item (e.g. a product card), if any. */
  price?: string;
  /** Id of the product card / list item this link sits in: one result per card. */
  card?: string;
  /** Visual salience, 0-1: how much a sighted eye is drawn to it (size, place on screen, type size). */
  sal?: number;
  count?: { links: number; inputs: number; buttons: number; headings: number };
}

export interface LensPage {
  url: string;
  title: string;
  items: LensItem[];
  article: string;
  /** The page's main price, on product pages. */
  price?: string;
  /** A feed's posts in order (title and address), for "next post". */
  posts?: Array<{ title: string; href: string }>;
  /** The article's paragraphs only, for skimming. */
  prose?: string;
  /** Share of the screen covered by the largest canvas (games and apps that draw instead of using HTML). */
  canvas?: number;
  /** Readable units in order: a post and its comments. */
  blocks?: Array<{ kind: 'post' | 'comment'; author?: string; score?: string; depth?: number; text: string }>;
  /** Performance mode renders this text-only instead of a live webview. */
  textOnly?: boolean;
}

/** main → renderer requests the renderer must answer. */
export interface RpcMethods {
  'lens.navigate': { url: string };
  'lens.extract': {};
  'lens.activate': { id: string; times?: number };
  'lens.fill': { id: string; text: string };
  'lens.key': { key: string };
  'lens.scroll': { direction: 'up' | 'down' };
  'lens.back': {};
  'lens.showPage': { page: LensPage };
  'lens.find': { query: string };
  'lens.capture': {};
  'lens.clickText': { text: string; times: number; until: string };
  'lens.clickPoint': { x: number; y: number; times: number; until: string };
  'lens.stopClicks': {};
  'lens.look': { text: string };
  'lens.hover': { text: string | null; x: number; y: number };
  'lens.scrollBy': { direction: 'up' | 'down'; screens: number };
  'lens.changes': {};
  'lens.eval': { code: string };
  'lens.highlight': { ids: string[] };
  'lens.typeKeys': { text: string; selectFirst?: string };
  'lens.realClick': { id: string };
  'lens.typeCells': { cells: Array<{ x: number; y: number }>; text: string };
}
