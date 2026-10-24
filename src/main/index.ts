import { app, BrowserWindow, globalShortcut, ipcMain, session, systemPreferences } from 'electron';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { config, effectiveStt, effectiveTts } from './config';
import { attachExecutorWindow, capturePrevFront, runText, shortcodeHelp, startFollowLoop } from './executor';
import { axTrusted } from './native';
import { attachWindow, log, setUi, speak, stopSpeech, ui } from './output';
import { transcribe } from './voice';
import './rpc';

app.setName('Callbacks');

let win: BrowserWindow;

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 720,
    minHeight: 560,
    title: 'Callbacks',
    backgroundColor: '#000000',
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
  // CALLBACKS_SCRIPT="o localhost:3000;a;2" runs typed commands on launch (e2e smoke tests).
  if (process.env.CALLBACKS_SNAPSHOT || process.env.CALLBACKS_SCRIPT) {
    win.webContents.once('did-finish-load', () => setTimeout(async () => {
      for (const cmd of (process.env.CALLBACKS_SCRIPT ?? '').split(';').filter(Boolean)) {
        console.log(`> ${cmd}`);
        await runText(cmd, 'typed');
        await new Promise((r) => setTimeout(r, 800));
      }
      if (process.env.CALLBACKS_SNAPSHOT) {
        writeFileSync(process.env.CALLBACKS_SNAPSHOT, (await win.capturePage()).toPNG());
        console.log('snapshot written');
      }
    }, 2500));
  }
  attachWindow(win);
  attachExecutorWindow(win);
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media'));
  createWindow();
  // Don't block startup on the permission dialog.
  systemPreferences.askForMediaAccess('microphone').catch(() => false);
  setUi({ providers: { claude: Boolean(config.anthropicKey), gemini: Boolean(config.geminiKey), tts: effectiveTts(), stt: effectiveStt() } });

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

  win.webContents.once('did-finish-load', async () => {
    win.webContents.send('ui', ui);
    win.webContents.send('shortcodes', shortcodeHelp());
    const trusted = await axTrusted(true).catch(() => false);
    if (!trusted) log('system', 'Accessibility permission needed: System Settings → Privacy & Security → Accessibility → enable Callbacks (or your terminal in dev).');
    speak(`Callbacks ready. Press ${config.hotkeyListen.replace('Alt', 'Option').replace('+', ' ')} and talk, or say help.`);
  });

  startFollowLoop();
});

ipcMain.handle('command:text', (_e, text: string, source: 'voice' | 'typed') => runText(text, source));

ipcMain.handle('audio:utterance', async (_e, data: ArrayBuffer, mime: string) => {
  setUi({ status: 'transcribing' });
  const t0 = Date.now();
  try {
    const text = await transcribe(Buffer.from(data), mime);
    log('system', `heard in ${Date.now() - t0}ms`);
    if (!text || /^\W*$/.test(text)) {
      setUi({ status: 'idle' });
      return;
    }
    await runText(text, 'voice');
  } catch (e) {
    setUi({ status: 'idle' });
    speak((e as Error).message);
  }
});

ipcMain.on('status', (_e, status: typeof ui.status) => setUi({ status }));
ipcMain.on('audio:ended', () => { if (ui.status === 'speaking') setUi({ status: 'idle' }); });
ipcMain.on('view', (_e, view: typeof ui.view) => setUi({ view }));
ipcMain.on('stop', () => stopSpeech());

app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
