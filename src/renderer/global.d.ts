import type { CallbacksApi } from '../preload/index';

declare global {
  interface Window {
    callbacks: CallbacksApi;
  }
}

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      webview: React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & { src?: string; partition?: string; allowpopups?: string };
    }
  }
}

export {};
