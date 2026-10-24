import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';

const watch = process.argv.includes('--watch');
const common = { bundle: true, sourcemap: 'inline', logLevel: 'info', target: 'es2023' };

mkdirSync('dist/renderer', { recursive: true });
mkdirSync('dist/bin', { recursive: true });

await Promise.all([
  build({ ...common, entryPoints: ['src/main/index.ts'], outfile: 'dist/main/index.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/preload/index.ts'], outfile: 'dist/preload/index.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/main.tsx'], outfile: 'dist/renderer/main.js', platform: 'browser', format: 'iife', jsx: 'automatic' }),
]);
copyFileSync('src/renderer/index.html', 'dist/renderer/index.html');
copyFileSync('src/renderer/styles.css', 'dist/renderer/styles.css');

// Native accessibility helper (Swift). Rebuild only when the source changed.
const src = 'native/axhelper.swift', out = 'dist/bin/axhelper';
if (!existsSync(out) || statSync(src).mtimeMs > statSync(out).mtimeMs) {
  console.log('compiling axhelper…');
  execFileSync('swiftc', ['-O', src, '-o', out], { stdio: 'inherit' });
}
if (watch) console.log('watch mode not implemented; rerun npm run build');
