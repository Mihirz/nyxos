import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand, parseNumber, normalizeKeys } from './commands.ts';
import { toBraille } from './braille.ts';
import { compact, shortPageTitle, speakOptions } from './narration.ts';
import { skim } from './skim.ts';

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
  assert.deepEqual(parseCommand('search best tacos in Berkeley'), { kind: 'search', query: 'best tacos in Berkeley', qualified: true });
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
  assert.deepEqual(parseCommand('m krishna', 'typed'), { kind: 'reply', to: 'krishna', text: '' });
  assert.deepEqual(parseCommand('/ what does this error mean', 'typed'), { kind: 'ask', text: 'what does this error mean' });
});

test('braille', () => {
  assert.equal(toBraille('abc', 1), '⠁⠃⠉');
  assert.equal(toBraille('Hi', 1), '⠠⠓⠊');
  assert.equal(toBraille('42', 1), '⠼⠙⠃');
  assert.equal(toBraille('the', 2), '⠮');
  assert.equal(toBraille('and', 1), '⠁⠝⠙');
});

test('search is contextual unless the web is named', () => {
  assert.deepEqual(parseCommand('search fridge magnets'), { kind: 'search', query: 'fridge magnets' });
  assert.deepEqual(parseCommand('google fridge magnets'), { kind: 'search', query: 'fridge magnets', web: true });
  assert.deepEqual(parseCommand('search the web for tacos'), { kind: 'search', query: 'tacos', web: true });
  assert.deepEqual(parseCommand('Search for magnets.'), { kind: 'search', query: 'magnets' });
  // Judgment calls go to Claude.
  assert.equal(parseCommand('find the cheapest one'), null);
  assert.deepEqual(parseCommand('search for protein powder under $20'), { kind: 'search', query: 'protein powder under $20', qualified: true });
  assert.equal(parseCommand('find a protein powder for under 20 dollars'), null);
  assert.deepEqual(parseCommand('No, where am I?'), { kind: 'whereAmI' });
  assert.deepEqual(parseCommand('click the big cookie 20 times'), { kind: 'click', target: 'big cookie', times: 20 });
  assert.deepEqual(parseCommand('Quick cookie 15 times.'), { kind: 'click', target: 'cookie', times: 15 });
  assert.deepEqual(parseCommand('What are the words?'), { kind: 'web', view: 'choices' });
  assert.deepEqual(parseCommand('use eleven labs'), { kind: 'voice', provider: 'elevenlabs' });
  assert.deepEqual(parseCommand('switch voice'), { kind: 'voice', provider: 'next' });
  assert.deepEqual(parseCommand('skim this page'), { kind: 'web', view: 'skim' });
  assert.deepEqual(parseCommand('give me the gist'), { kind: 'web', view: 'skim' });
  assert.deepEqual(parseCommand('what can I click'), { kind: 'web', view: 'detect' });
  assert.deepEqual(parseCommand('be brief'), { kind: 'verbosity', level: 'brief' });
  assert.deepEqual(parseCommand('play crosswords'), { kind: 'open', target: 'crosswords', play: true });
  assert.deepEqual(parseCommand('Go to the next post.'), { kind: 'relative', dir: 1, noun: 'post' });
  assert.deepEqual(parseCommand('Show me more comments.'), { kind: 'web', view: 'comments', more: true });
  assert.deepEqual(parseCommand('Select those four and submit.'), { kind: 'click', target: 'those four', submit: true });
  assert.deepEqual(parseCommand('Submit those four.'), { kind: 'click', target: 'those four', submit: true });
  assert.deepEqual(parseCommand('Select the last four and submit.'), { kind: 'click', target: 'the last four', submit: true });
  assert.deepEqual(parseCommand('read the rest of the comments'), { kind: 'web', view: 'comments', more: true });
  assert.deepEqual(parseCommand('previous one'), { kind: 'relative', dir: -1, noun: 'one' });
  assert.deepEqual(parseCommand('discreet mode'), { kind: 'discreet', on: true });
  assert.deepEqual(parseCommand('read out the words for me'), { kind: 'web', view: 'choices' });
  assert.deepEqual(parseCommand('click on this protein shaker bottle'), { kind: 'click', target: 'this protein shaker bottle' });
});

test('compact narration', () => {
  assert.equal(compact('Show/hide shortcuts, shift, option, z'), 'Show/hide shortcuts');
  assert.equal(compact('Your recently viewed items and featured recommendations'), 'Your recently viewed items');
  assert.equal(shortPageTitle('Amazon.com. Spend less. Smile more.'), 'Amazon');
  assert.equal(shortPageTitle('Issues · anthropics/anthropic-sdk-typescript - GitHub'), 'Issues');
  const items = ['A', 'B', 'C', 'D', 'E', 'F'].map((label) => ({ label, action: null }));
  assert.equal(speakOptions('Amazon', items), 'Amazon: A, B, C, D, E, and 1 more.');
  assert.equal(speakOptions('Tabs', items.slice(0, 3)), 'Tabs: A, B and C.');
  assert.equal(speakOptions('', items, 5), 'F.');
});

test('skim picks key sentences in order', () => {
  const text = `The Battle of Schliengen was fought on 24 October 1796 between French and Austrian armies. It was part of the War of the First Coalition.

The French army under Moreau was retreating toward the Rhine after a long summer campaign. The Austrian army under Archduke Charles attacked the French positions near Schliengen. Rain had turned the roads to mud that morning.

The Austrians made gains on both flanks of the French line. Moreau withdrew across the Rhine during the night. The battle ended the French invasion of southern Germany.

Historians still debate whether Charles could have destroyed the French army. Some say the weather saved Moreau. Others credit his careful retreat.`;
  const s = skim(text, 0.3, 3, 4);
  assert.ok(s.sentences.length >= 3 && s.sentences.length <= 4);
  assert.equal(s.sentences[0], 'The Battle of Schliengen was fought on 24 October 1796 between French and Austrian armies.');
  const idx = s.sentences.map((x) => text.indexOf(x));
  assert.deepEqual(idx, [...idx].sort((a, b) => a - b)); // document order
  assert.equal(s.total, 11);
});
