import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionStore } from './store';

test('removes a stored session', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-sessions-'));
  const store = new SessionStore(join(root, 'sessions.json'));

  store.upsert({
    projectId: 'example-project',
    cardId: 'change-a',
    profileId: 'codex',
    sessionId: 'agent-workbench-example-project-change-a',
    tmuxSessionName: 'agent-workbench-example-project-change-a',
    status: 'running',
    updatedAt: '2026-05-10T13:00:00.000Z'
  });

  expect(store.remove('example-project', 'change-a')).toBe(true);
  expect(store.get('example-project', 'change-a')).toBeUndefined();
  expect(new SessionStore(join(root, 'sessions.json')).get('example-project', 'change-a')).toBeUndefined();
});
