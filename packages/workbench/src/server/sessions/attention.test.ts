import { describe, expect, test } from 'vitest';
import { detectAttentionSignal, nextOutputActivity } from './attention';

describe('detectAttentionSignal', () => {
  test('detects explicit confirmation waits in terminal output', () => {
    const output = [
      'Next Concrete Action',
      '',
      'Start task 1.1 and create reference-audit.md.',
      '',
      'Waiting for confirmation before proceeding.'
    ].join('\n');

    expect(detectAttentionSignal(output, {
      lastOutputAt: new Date('2026-05-10T12:00:00.000Z').toISOString(),
      idleNotificationSeconds: 300,
      now: new Date('2026-05-10T12:00:05.000Z')
    })).toEqual({
      kind: 'waiting_for_confirmation',
      reason: 'Terminal is waiting for confirmation'
    });
  });

  test('detects idle terminal output after the configured threshold', () => {
    expect(detectAttentionSignal('agent output', {
      lastOutputAt: new Date('2026-05-10T12:00:00.000Z').toISOString(),
      idleNotificationSeconds: 30,
      now: new Date('2026-05-10T12:00:31.000Z')
    })).toEqual({
      kind: 'idle_after_output',
      reason: 'Terminal has been idle for 31s after output'
    });
  });
});

describe('nextOutputActivity', () => {
  test('updates lastOutputAt when captured output changes', () => {
    expect(nextOutputActivity({
      output: 'new output',
      previousHash: 'old-hash',
      previousLastOutputAt: '2026-05-10T12:00:00.000Z',
      now: new Date('2026-05-10T12:01:00.000Z')
    })).toEqual({
      outputHash: expect.any(String),
      lastOutputAt: '2026-05-10T12:01:00.000Z',
      changed: true
    });
  });

  test('keeps lastOutputAt when captured output is unchanged', () => {
    const first = nextOutputActivity({
      output: 'same output',
      now: new Date('2026-05-10T12:00:00.000Z')
    });

    expect(nextOutputActivity({
      output: 'same output',
      previousHash: first.outputHash,
      previousLastOutputAt: first.lastOutputAt,
      now: new Date('2026-05-10T12:01:00.000Z')
    })).toEqual({
      outputHash: first.outputHash,
      lastOutputAt: '2026-05-10T12:00:00.000Z',
      changed: false
    });
  });
});
