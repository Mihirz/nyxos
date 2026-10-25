// nyxOS Bridge: a localhost-only JSON API over the active editor.
// Screen readers see VS Code's editor as a partial textarea; this gives nyxOS
// exact line numbers, the real file contents, diagnostics, and edit events.

const vscode = require('vscode');
const http = require('http');

let server;
let seq = 0;
const events = []; // ring buffer of {seq, type, ...}

function push(ev) {
  events.push({ seq: ++seq, at: Date.now(), ...ev });
  if (events.length > 200) events.shift();
}

function editor() {
  return vscode.window.activeTextEditor;
}

function diagSummary(uri) {
  const diags = uri ? vscode.languages.getDiagnostics(uri) : [];
  return {
    errors: diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length,
    warnings: diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length,
  };
}

function state() {
  const ed = editor();
  if (!ed) return { focused: vscode.window.state.focused, file: null };
  const pos = ed.selection.active;
  const doc = ed.document;
  return {
    focused: vscode.window.state.focused,
    file: doc.fileName,
    relPath: vscode.workspace.asRelativePath(doc.uri),
    languageId: doc.languageId,
    line: pos.line + 1,
    column: pos.character + 1,
    lineCount: doc.lineCount,
    lineText: doc.lineAt(pos.line).text,
    selectedText: doc.getText(ed.selection) || undefined,
    dirty: doc.isDirty,
    diagnostics: diagSummary(doc.uri),
  };
}

async function gotoLine(line, column) {
  const ed = editor();
  if (!ed) throw new Error('no active editor');
  const n = Math.max(0, Math.min(ed.document.lineCount - 1, line - 1));
  const text = ed.document.lineAt(n).text;
  const col = column != null ? column - 1 : text.length - text.trimStart().length; // first non-blank
  const pos = new vscode.Position(n, col);
  ed.selection = new vscode.Selection(pos, pos);
  ed.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  await vscode.window.showTextDocument(ed.document, ed.viewColumn);
  return state();
}

function lines(from, to) {
  const ed = editor();
  if (!ed) return [];
  const doc = ed.document;
  const a = Math.max(1, from), b = Math.min(doc.lineCount, to);
  const out = [];
  for (let i = a; i <= b; i++) out.push({ n: i, text: doc.lineAt(i - 1).text });
  return out;
}

async function insert(text) {
  const ed = editor();
  if (!ed) throw new Error('no active editor');
  await ed.edit((b) => ed.selections.forEach((s) => b.replace(s, text)));
  return state();
}

async function replaceLine(line, text) {
  const ed = editor();
  if (!ed) throw new Error('no active editor');
  const l = ed.document.lineAt(line - 1);
  await ed.edit((b) => b.replace(l.range, text));
  return state();
}

function diagnostics() {
  const ed = editor();
  if (!ed) return [];
  return vscode.languages.getDiagnostics(ed.document.uri).map((d) => ({
    line: d.range.start.line + 1,
    severity: ['error', 'warning', 'info', 'hint'][d.severity],
    message: d.message,
    source: d.source,
  }));
}

async function openFile(query) {
  const files = await vscode.workspace.findFiles(`**/*${query}*`, '**/node_modules/**', 20);
  if (!files.length) throw new Error(`no file matching ${query}`);
  const doc = await vscode.workspace.openTextDocument(files[0]);
  await vscode.window.showTextDocument(doc);
  return state();
}

const routes = {
  'GET /state': () => state(),
  'GET /lines': (q) => lines(Number(q.get('from')), Number(q.get('to'))),
  'GET /diagnostics': () => diagnostics(),
  'GET /events': (q) => ({ seq, events: events.filter((e) => e.seq > Number(q.get('since') || 0)) }),
  'POST /goto': (_, b) => gotoLine(b.line, b.column),
  'POST /insert': (_, b) => insert(b.text),
  'POST /replaceLine': (_, b) => replaceLine(b.line, b.text),
  'POST /open': (_, b) => openFile(b.query),
  'POST /command': async (_, b) => { await vscode.commands.executeCommand(b.id, ...(b.args || [])); return state(); },
  'POST /save': async () => { await editor()?.document.save(); return state(); },
};

function activate(context) {
  // Each VS Code window runs its own extension host. Every window takes the first
  // free port in [base, base+9]; nyxOS asks them all and talks to the focused one.
  const base = vscode.workspace.getConfiguration('callbacks').get('port', 47100);
  server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const handler = routes[`${req.method} ${url.pathname}`];
    res.setHeader('Content-Type', 'application/json');
    if (!handler) { res.statusCode = 404; return res.end('{"error":"not found"}'); }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      try {
        const result = await handler(url.searchParams, body ? JSON.parse(body) : {});
        res.end(JSON.stringify(result ?? {}));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: String(e.message || e) }));
      }
    });
  });
  let port = base;
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && port < base + 9) server.listen(++port, '127.0.0.1');
  });
  server.listen(port, '127.0.0.1');

  // Edit events feed nyxOS' "follow mode": it reads back lines as you finish them.
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      const ed = editor();
      if (!ed || e.document !== ed.document || !e.contentChanges.length) return;
      const line = e.contentChanges[0].range.start.line;
      const newlines = e.contentChanges.some((c) => c.text.includes('\n'));
      push({ type: 'edit', line: line + 1, text: e.document.lineAt(Math.min(line, e.document.lineCount - 1)).text, newline: newlines });
    }),
    vscode.languages.onDidChangeDiagnostics(() => {
      const ed = editor();
      if (ed) push({ type: 'diagnostics', ...diagSummary(ed.document.uri) });
    }),
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed) push({ type: 'file', relPath: vscode.workspace.asRelativePath(ed.document.uri), line: ed.selection.active.line + 1 });
    }),
    { dispose: () => server && server.close() },
  );
}

function deactivate() {
  if (server) server.close();
}

module.exports = { activate, deactivate };
