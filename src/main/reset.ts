// A clean start for demo recordings: nyxOS relaunches with an empty transcript, the Home view,
// a Lens with no page or back history, no conversation context, and its default window size
// and position. Site sign-ins in the Lens (its cookies) are kept.

import { app } from 'electron';
import { stopSpeech } from './output';

export function resetForDemo(): void {
  // A test run would relaunch itself with its script and run it again.
  if (process.env.NYX_SCRIPT) { console.log('[reset] (relaunch skipped in test runs)'); return; }
  stopSpeech();
  app.relaunch();
  app.quit();
}
