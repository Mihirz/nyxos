// Screen curtain: black out every display (privacy + it proves nobody is peeking).
// Callbacks keeps working underneath, because it never relied on pixels.

import { BrowserWindow, screen } from 'electron';

let curtains: BrowserWindow[] = [];

export function setCurtain(on: boolean) {
  for (const c of curtains) if (!c.isDestroyed()) c.close();
  curtains = [];
  if (!on) return;
  for (const d of screen.getAllDisplays()) {
    const c = new BrowserWindow({
      ...d.bounds, frame: false, transparent: false, backgroundColor: '#000000', focusable: false,
      alwaysOnTop: true, skipTaskbar: true, hasShadow: false, enableLargerThanScreen: true, show: false,
    });
    c.setAlwaysOnTop(true, 'screen-saver');
    c.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    c.setIgnoreMouseEvents(true);
    c.loadURL('data:text/html,<body style="background:#000;margin:0;cursor:none"></body>');
    c.showInactive();
    curtains.push(c);
  }
}
