// main → renderer request/response (the Lens webview lives in the renderer).

import { ipcMain } from 'electron';
import type { RpcMethods } from '../shared/types';
import { send } from './output';

let nextId = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

ipcMain.on('rpc:response', (_e, msg: { id: number; result?: unknown; error?: string }) => {
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.error) p.reject(new Error(msg.error));
  else p.resolve(msg.result);
});

export function rpc<T = unknown, M extends keyof RpcMethods = keyof RpcMethods>(method: M, args: RpcMethods[M], timeout = 15000): Promise<T> {
  const id = ++nextId;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    send('rpc:request', { id, method, args });
    setTimeout(() => {
      if (pending.delete(id)) reject(new Error(`${method} timed out`));
    }, timeout);
  });
}
