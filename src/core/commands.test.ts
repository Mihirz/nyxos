import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseNumber, normalizeKeys } from './commands.ts';
import { toBraille } from './braille.ts';

test('numbers', () => {
  assert.equal(parseNumber('42'), 42);
  assert.equal(parseNumber('forty two'), 42);
  assert.equal(parseNumber('forty-two'), 42);
  assert.equal(parseNumber('one hundred and five'), 105);
  assert.equal(parseNumber('four two'), 42);
  assert.equal(parseNumber('safari'), null);
});

test('keys', () => {
  assert.equal(normalizeKeys('command shift p'), 'cmd+shift+p');
  assert.equal(normalizeKeys('Control G'), 'ctrl+g');
  assert.equal(normalizeKeys('cmd+s'), 'cmd+s');
});

test('voice commands', () => {
  assert.deepEqual(parseCommand('Go to line forty two.'), { kind: 'goToLine', line: 42 });
  assert.deepEqual(parseCommand('open VS Code'), { kind: 'open', target: 'vs code' });
  assert.deepEqual(parseCommand('Can you please open Safari?'), { kind: 'open', target: 'safari' });
  assert.deepEqual(parseCommand('Type Hello World'), { kind: 'type', text: 'Hello World' });
  assert.deepEqual(parseCommand('go back to windows'), { kind: 'windows' });
  assert.deepEqual(parseCommand('three'), { kind: 'choose', index: 3 });
  assert.deepEqual(parseCommand('open 2'), { kind: 'choose', index: 2 });
  assert.deepEqual(parseCommand('save'), { kind: 'press', keys: 'cmd+s' });
  assert.deepEqual(parseCommand('press command shift p'), { kind: 'press', keys: 'cmd+shift+p' });
  assert.deepEqual(parseCommand('search best tacos in Berkeley'), { kind: 'search', query: 'best tacos in Berkeley' });
  assert.deepEqual(parseCommand('reply to Sam saying fixed it'), { kind: 'reply', to: 'sam', text: 'fixed it' });
  assert.deepEqual(parseCommand('read my unread messages'), { kind: 'unread' });
  assert.deepEqual(parseCommand('screen off'), { kind: 'curtain', on: true });
  assert.deepEqual(parseCommand('screen curtain off'), { kind: 'curtain', on: false });
  assert.deepEqual(parseCommand('click sign up'), { kind: 'click', target: 'sign up' });
  assert.equal(parseCommand('summarize what this function does')?.kind ?? null, null);
});

test('typed shortcodes', () => {
  assert.deepEqual(parseCommand('g 42', 'typed'), { kind: 'goToLine', line: 42 });
  assert.deepEqual(parseCommand('o safari', 'typed'), { kind: 'open', target: 'safari' });
  assert.deepEqual(parseCommand('k cmd+s', 'typed'), { kind: 'press', keys: 'cmd+s' });
  assert.deepEqual(parseCommand('?', 'typed'), { kind: 'whereAmI' });
  assert.deepEqual(parseCommand('.', 'typed'), { kind: 'repeat' });
  assert.deepEqual(parseCommand('3', 'typed'), { kind: 'choose', index: 3 });
  assert.deepEqual(parseCommand('m Sam: on my way', 'typed'), { kind: 'reply', to: 'Sam', text: 'on my way' });
  assert.deepEqual(parseCommand('/ what does this error mean', 'typed'), { kind: 'ask', text: 'what does this error mean' });
});

test('braille', () => {
  assert.equal(toBraille('abc', 1), '⠁⠃⠉');
  assert.equal(toBraille('Hi', 1), '⠠⠓⠊');
  assert.equal(toBraille('42', 1), '⠼⠙⠃');
  assert.equal(toBraille('the', 2), '⠮');
  assert.equal(toBraille('and', 1), '⠁⠝⠙');
});
