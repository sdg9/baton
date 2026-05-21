import { expect, test } from 'vitest';
import { parseTerminalClientMessage, stripClearScrollbackSequences } from './terminal-ws';

test('parses resize control messages from terminal clients', () => {
  expect(parseTerminalClientMessage(JSON.stringify({
    type: 'resize',
    cols: 127,
    rows: 55
  }))).toEqual({ type: 'resize', cols: 127, rows: 55 });
});

test('treats ordinary terminal input as data', () => {
  expect(parseTerminalClientMessage('yes\n')).toEqual({ type: 'input', data: 'yes\n' });
});

test('strips terminal clear-scrollback sequences from live attach output', () => {
  expect(stripClearScrollbackSequences('\u001b[2Jbefore\u001b[3Jafter')).toBe('\u001b[2Jbeforeafter');
});
