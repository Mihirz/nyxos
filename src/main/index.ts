import { app, BrowserWindow, globalShortcut, ipcMain, Menu, session, systemPreferences } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { config, effectiveStt, effectiveTts } from './config';
import { attachExecutorWindow, capturePrevFront, runText, shortcodeHelp, startFollowLoop, startWarmers } from './executor';
import { axTrusted } from './native';
import { setProviderLostHandler } from './voice';
import { attachWindow, cancelInterrupt, log, noteInterrupt, send, setUi, speak, speechEnded, stopSpeech, ui } from './output';
import { transcribe } from './voice';
import { resetForDemo } from './reset';
import './rpc';

app.setName('nyxOS');

let win: BrowserWindow;

function createWindow() {
  // Scripted test runs open in the background: never take keyboard focus, the microphone, or
  // global shortcuts from the copy of nyxOS the user is actually using.
  // (NYX_FOCUS=1 lets a test window take focus, for checking keyboard behavior in games.)
  const testRun = Boolean(process.env.NYX_SCRIPT) && !process.env.NYX_FOCUS;
  win = new BrowserWindow({
    show: !testRun,
    focusable: !testRun,
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'nyxOS',
    backgroundColor: '#060a16',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(app.getAppPath(), 'dist', 'preload', 'index.js'),
      webviewTag: true,
      contextIsolation: true,
      sandbox: false,
    },
  });
  win.loadFile(path.join(app.getAppPath(), 'dist', 'renderer', 'index.html'));
  // Dev aids: surface renderer errors in the terminal; optionally snapshot the UI.
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 'warning') console.log(`[renderer ${e.level}] ${e.message}`);
  });
  // NYX_SCRIPT="o localhost:3000;a;2" runs typed commands on launch (e2e smoke tests).
  // Steps can also drive the UI: "!js" runs JS in the window, "key:Space down" / "key:Space up" /
  // "key:w" send real key events, "wait:1500" pauses.
  // Safety net: a test run never outlives 6 minutes, even if a step hangs.
  if (process.env.NYX_SCRIPT) setTimeout(() => app.quit(), 6 * 60_000).unref?.();
  if (process.env.NYX_SNAPSHOT || process.env.NYX_SCRIPT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      for (const cmd of (process.env.NYX_SCRIPT ?? '').split(';').filter(Boolean)) {
        console.log(`> ${cmd}`);
        if (cmd.startsWith('!')) console.log('  =', await win.webContents.executeJavaScript(cmd.slice(1)).catch((e: Error) => e.message));
        else if (cmd.startsWith('wait:')) await new Promise((r) => setTimeout(r, Number(cmd.slice(5))));
        else if (cmd.startsWith('key:')) {
          const [key, phase] = cmd.slice(4).split(' ');
          if (phase !== 'up') win.webContents.sendInputEvent({ type: 'keyDown', keyCode: key });
          if (!phase && (key.length === 1 || key === 'Return')) win.webContents.sendInputEvent({ type: 'char', keyCode: key === 'Return' ? '\r' : key });
          if (phase !== 'down') win.webContents.sendInputEvent({ type: 'keyUp', keyCode: key });
        } else await runText(cmd, 'typed');
        await new Promise((r) => setTimeout(r, 300));
      }
      if (process.env.NYX_SNAPSHOT) {
        writeFileSync(process.env.NYX_SNAPSHOT, (await win.capturePage()).toPNG());
        console.log('snapshot written');
      }
      // A test run closes itself when its script is done: no stray windows left behind.
      if (process.env.NYX_SCRIPT) setTimeout(() => app.quit(), 500);
    }, 2500));
  }
  attachWindow(win);
  attachExecutorWindow(win);
}

app.setName('nyxOS');

// Links that open a new window (target=_blank) open in the Lens itself: one place to be.
app.on('web-contents-created', (_e, wc) => {
  if (wc.getType() !== 'webview') return;
  // Keyboard focus never stays in the Lens page (a blind user can't tell it went there): give it
  // straight back to nyxOS, so Space, Esc, numbers and typing always reach our handlers.
  // (Keys nyxOS itself sends into the page, like Return for "press enter", still arrive:
  // those go to the page directly, not through keyboard focus.)
  wc.on('focus', () => wc.hostWebContents?.focus());
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: 'deny' };
  });
});

app.whenReady().then(async () => {
  // The default menu's Reload / Force Reload would reload the window without the main process,
  // leaving the two out of step; ⌘⇧R is a full clean relaunch instead (Demo → Reset for Demo).
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: 'appMenu' },
    { role: 'editMenu' },
    { label: 'View', submenu: [{ role: 'togglefullscreen' }, { role: 'toggleDevTools' }] },
    { label: 'Demo', submenu: [{ label: 'Reset for Demo', accelerator: 'CmdOrCtrl+Shift+R', click: () => resetForDemo() }] },
    { role: 'windowMenu' },
  ]));
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  createWindow();
  // Don't block startup on the permission dialog.
  systemPreferences.askForMediaAccess('microphone').catch(() => false);
  setUi({ providers: { claude: Boolean(config.anthropicKey), gemini: Boolean(config.geminiKey), tts: effectiveTts(), stt: effectiveStt() } });

  if (!process.env.NYX_SCRIPT) registerShortcuts();
  if (process.env.NYX_SCRIPT && !process.env.NYX_FOCUS) win.showInactive();

function registerShortcuts() {
  // Global: toggle listening from any app (renderer keeps the mic warm and does VAD).
  globalShortcut.register(config.hotkeyListen, async () => {
    stopSpeech();
    await capturePrevFront();
    win.webContents.send('listen:toggle');
  });
  // Global: jump to the typed command bar, remembering which app to act on.
  globalShortcut.register(config.hotkeyCommand, async () => {
    await capturePrevFront();
    win.show();
    win.focus();
    win.webContents.send('command:focus');
  });
}

  win.webContents.once('did-finish-load', async () => {
    win.webContents.send('ui', ui);
    win.webContents.send('shortcodes', shortcodeHelp());
    const trusted = await axTrusted(true).catch(() => false);
    if (!trusted) log('system', 'Accessibility permission needed: System Settings → Privacy & Security → Accessibility → enable nyxOS (or your terminal in dev).');
    speak('Nyx OS ready.');
  });

  startFollowLoop();
  startWarmers();
  setProviderLostHandler((name, now) => {
    const nice = (p: string) => ({ cartesia: 'Cartesia', elevenlabs: 'ElevenLabs', say: 'the Mac voice', none: 'typing only' })[p] ?? p;
    setUi({ providers: { ...ui.providers, tts: effectiveTts(), stt: effectiveStt() } });
    speak(`${nice(name)} is out of credits. Using ${nice(now)}.`, { via: 'grammar' });
  });
});

ipcMain.handle('command:text', (_e, text: string, source: 'voice' | 'typed') => runText(text, source));

ipcMain.handle('audio:utterance', async (_e, data: ArrayBuffer, mime: string) => {
  setUi({ status: 'transcribing' });
  const t0 = Date.now();
  try {
    const text = await transcribe(Buffer.from(data), mime);
    log('system', `heard in ${Date.now() - t0}ms`);
    if (!text || /^\W*$/.test(text)) {
      // Heard sound but no words: a tone, so the user knows to try again instead of waiting.
      log('system', 'Heard no words.');
      send('earcon', 'error');
      cancelInterrupt();
      setUi({ status: 'idle' });
      return;
    }
    setUi({ status: 'thinking' });
    await runText(text, 'voice');
  } catch (e) {
    setUi({ status: 'idle' });
    speak((e as Error).message);
  }
});

ipcMain.on('status', (_e, status: typeof ui.status) => setUi({ status }));
ipcMain.on('audio:ended', () => { speechEnded(); if (ui.status === 'speaking') setUi({ status: 'idle' }); });
ipcMain.on('audio:interrupted', (_e, p: { fraction: number | null; seg?: number; len?: number }) => noteInterrupt(p.fraction, p.seg, p.len));
ipcMain.on('view', (_e, view: typeof ui.view) => setUi({ view }));
ipcMain.on('stop', () => stopSpeech());

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
