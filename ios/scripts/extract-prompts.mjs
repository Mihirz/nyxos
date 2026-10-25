// Pull the Claude prompts, tool definitions and schemas out of the desktop's src/main/claude.ts
// into nyxOS/Resources/prompts.json, so the iOS operator speaks with exactly the same rules
// (they encode a lot of user feedback). Run by bundle-core.sh; writes only inside ios/.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '../../src/main/claude.ts'), 'utf8');
const out = path.join(here, '../nyxOS/Resources/prompts.json');

const need = (re, what) => { const m = src.match(re); if (!m) throw new Error(`extract-prompts: can't find ${what}`); return m[1]; };
const unescape = (s) => s.replace(/\\`/g, '`').replace(/\\\$/g, '$').replace(/\\\\/g, '\\');

const SPOKEN_STYLE = unescape(need(/const SPOKEN_STYLE = `([\s\S]*?)`;/, 'SPOKEN_STYLE'));
// Template text: ${SPOKEN_STYLE} is filled in; any other ${expr} becomes {{expr}} for Swift to fill.
const tmpl = (s) => unescape(s).replace(/\$\{SPOKEN_STYLE\}/g, SPOKEN_STYLE).replace(/\$\{([^}]+)\}/g, (_, e) => `{{${e.trim()}}}`);

const obj = (props, required = []) => ({ type: 'object', properties: props, required, additionalProperties: false });
const str = (description) => ({ type: 'string', description });
const int = (description) => ({ type: 'integer', description });
const evalJs = (code) => Function('obj', 'str', 'int', `return (${code});`)(obj, str, int);

const toolsSrc = need(/export const OPERATOR_TOOLS[^=]*=\s*(\[[\s\S]*?\n\]);/, 'OPERATOR_TOOLS');
const tools = evalJs(toolsSrc);
const strict = evalJs(need(/const STRICT_TOOLS = new Set\((\[[\s\S]*?\])\)/, 'STRICT_TOOLS'));
const glanceSchema = evalJs(need(/const GLANCE_SCHEMA = (\{[\s\S]*?\n\});/, 'GLANCE_SCHEMA'));
const detectSchema = (() => { try { return evalJs(need(/const DETECT_SCHEMA = (\{[\s\S]*?\n\});/, 'DETECT_SCHEMA')); } catch { return null; } })();
const fn = (name) => { const i = src.indexOf(`function ${name}(`); return i < 0 ? '' : src.slice(i, src.indexOf('\n}\n', i)); };
const sysOf = (name) => {
  const body = fn(name);
  const m = body.match(/system: \[\{ type: 'text', cache_control: CACHE, text: `([\s\S]*?)` \}\]/) ?? body.match(/system: `([\s\S]*?)`,/) ?? body.match(/system: \[\{ type: 'text', cache_control: CACHE, text: '([\s\S]*?)' \}\]/);
  return m ? tmpl(m[1].replace(/\\'/g, "'")) : null;
};

const data = {
  source: 'src/main/claude.ts',
  spokenStyle: SPOKEN_STYLE,
  operatorSystem: tmpl(need(/const OPERATOR_SYSTEM = `([\s\S]*?)`;\n/, 'OPERATOR_SYSTEM')),
  tools,
  strictTools: strict,
  glanceSystem: sysOf('firstGlance'),
  glanceSchema,
  describeImageSystem: sysOf('describeImage'),
  summarizeChangeSystem: sysOf('summarizeChange'),
  detectSystem: sysOf('detectElements'),
  detectSchema,
};
for (const [k, v] of Object.entries(data)) if (v == null && k !== 'detectSystem' && k !== 'detectSchema') throw new Error(`extract-prompts: missing ${k}`);
writeFileSync(out, JSON.stringify(data, null, 1));
console.log(`wrote ${out} (${tools.length} tools)`);
