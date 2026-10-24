// iMessage / SMS via the local Messages database (read) and AppleScript (send).
// Reading chat.db requires Full Disk Access for the app running Callbacks.

import os from 'node:os';
import path from 'node:path';
import { osascript, shell } from './native';

const DB = path.join(os.homedir(), 'Library', 'Messages', 'chat.db');

export interface Unread { chatId: string; sender: string; text: string; at: Date; service: string; isGroup: boolean; chatName: string | null }

// Apple epoch (2001-01-01) in nanoseconds on modern macOS.
const APPLE_EPOCH = 978307200;

const SQL = `
SELECT m.ROWID, COALESCE(c.chat_identifier, h.id) AS chat, COALESCE(h.id, '') AS sender,
       COALESCE(m.text, '') AS text, hex(m.attributedBody) AS body, m.date AS date,
       COALESCE(m.service, '') AS service, COALESCE(c.display_name, '') AS chat_name,
       (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = c.ROWID) AS members
FROM message m
LEFT JOIN handle h ON h.ROWID = m.handle_id
LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
LEFT JOIN chat c ON c.ROWID = cmj.chat_id
WHERE m.is_read = 0 AND m.is_from_me = 0 AND m.item_type = 0
  AND m.date > (strftime('%s','now') - ${APPLE_EPOCH} - 14*86400) * 1000000000
ORDER BY m.date DESC
LIMIT 60;`;

/** On recent macOS the text often lives only in attributedBody (an NSArchiver typedstream). */
function decodeAttributedBody(hex: string): string {
  if (!hex) return '';
  const buf = Buffer.from(hex, 'hex');
  const marker = buf.indexOf(Buffer.from('NSString'));
  if (marker < 0) return '';
  // After "NSString" comes a small header then 0x2B ('+') and a length-prefixed UTF-8 string.
  let i = buf.indexOf(0x2b, marker);
  if (i < 0) return '';
  i++;
  let len = buf[i];
  i++;
  if (len === 0x81) { len = buf.readUInt16LE(i); i += 2; }
  else if (len === 0x82) { len = buf.readUInt32LE(i); i += 4; }
  return buf.subarray(i, i + len).toString('utf8');
}

export async function unreadMessages(): Promise<Unread[]> {
  let raw: string;
  try {
    raw = await shell('/usr/bin/sqlite3', ['-readonly', '-json', DB, SQL], 4000);
  } catch (e) {
    const msg = String((e as Error).message);
    if (/authorization denied|unable to open/i.test(msg)) {
      throw new Error('I need Full Disk Access to read Messages. Open System Settings, Privacy and Security, Full Disk Access, and allow Callbacks or your terminal.');
    }
    throw e;
  }
  if (!raw.trim()) return [];
  const rows = JSON.parse(raw) as Array<{ chat: string; sender: string; text: string; body: string; date: number; service: string; chat_name: string; members: number }>;
  return rows
    .map((r) => ({
      chatId: r.chat,
      sender: r.sender,
      text: (r.text || decodeAttributedBody(r.body)).replace(/￼/g, '[attachment]').trim(),
      at: new Date((r.date / 1e9 + APPLE_EPOCH) * 1000),
      service: r.service,
      isGroup: r.members > 1,
      chatName: r.chat_name || null,
    }))
    .filter((m) => m.text);
}

/** Map phone numbers/emails to Contacts names (best effort, cached). */
const nameCache = new Map<string, string>();
export async function contactName(handle: string): Promise<string> {
  if (nameCache.has(handle)) return nameCache.get(handle)!;
  const digits = handle.replace(/\D/g, '').slice(-10);
  const script = handle.includes('@')
    ? `tell application "Contacts" to get name of first person whose value of emails contains "${handle}"`
    : `tell application "Contacts"
         repeat with p in people
           repeat with ph in phones of p
             set d to do shell script "echo " & quoted form of (value of ph as text) & " | tr -cd '0-9' | tail -c 10"
             if d is "${digits}" then return name of p
           end repeat
         end repeat
       end tell
       return ""`;
  const name = (await osascript(script, 'AppleScript', 2500).catch(() => '')) || handle;
  nameCache.set(handle, name);
  return name;
}

export function digest(msgs: Array<Unread & { name: string }>): string {
  const byChat = new Map<string, Array<Unread & { name: string }>>();
  for (const m of msgs) byChat.set(m.chatId, [...(byChat.get(m.chatId) ?? []), m]);
  let i = 0;
  return [...byChat.values()]
    .map((thread) => {
      const head = thread[0];
      const who = head.isGroup ? `${head.chatName ?? 'group chat'}` : head.name;
      const lines = thread.slice().reverse().map((m) => `  ${head.isGroup ? m.name + ': ' : ''}${m.text}`).join('\n');
      return `${++i}. ${who} (${thread.length} unread, latest ${head.at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}):\n${lines}`;
    })
    .join('\n');
}

const esc = (s: string) => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

export async function sendMessage(to: string, text: string): Promise<void> {
  const script = `
    tell application "Messages"
      set svc to 1st account whose service type = iMessage
      send "${esc(text)}" to participant "${esc(to)}" of svc
    end tell`;
  await osascript(script, 'AppleScript', 8000);
}
