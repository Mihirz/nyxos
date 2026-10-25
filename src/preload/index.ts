import { contextBridge, ipcRenderer } from 'electron';

const on = (channel: string) => (cb: (payload: any) => void) => {
  const fn = (_e: unknown, payload: unknown) => cb(payload);
  ipcRenderer.on(channel, fn);
  return () => ipcRenderer.removeListener(channel, fn);
};

const api = {
  runText: (text: string, source: 'voice' | 'typed') => ipcRenderer.invoke('command:text', text, source),
  sendUtterance: (data: ArrayBuffer, mime: string) => ipcRenderer.invoke('audio:utterance', data, mime),
  setStatus: (s: string) => ipcRenderer.send('status', s),
  audioEnded: () => ipcRenderer.send('audio:ended'),
  interrupted: (p: { fraction: number | null; seg?: number; len?: number }) => ipcRenderer.send('audio:interrupted', p),
  setView: (v: string) => ipcRenderer.send('view', v),
  stop: () => ipcRenderer.send('stop'),
  rpcRespond: (msg: { id: number; result?: unknown; error?: string }) => ipcRenderer.send('rpc:response', msg),
  onUi: on('ui'),
  onLog: on('log'),
  onBraille: on('braille'),
  onAudioPlay: on('audio:play'),
  onAudioStop: on('audio:stop'),
  onListenToggle: on('listen:toggle'),
  onCommandFocus: on('command:focus'),
  onRpc: on('rpc:request'),
  onShortcodes: on('shortcodes'),
  onEarcon: on('earcon'),
  testRun: Boolean(process.env.NYX_SCRIPT),
};

contextBridge.exposeInMainWorld('nyx', api);
export type NyxApi = typeof api;
