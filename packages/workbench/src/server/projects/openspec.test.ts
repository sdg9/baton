import { mapOpenSpecChangesToCards, runOpenSpecList } from './openspec';
import type { ProjectConfig } from '../config/config';

const project: ProjectConfig = {
  id: 'example-project',
  name: 'Example Project',
  path: '/allowed/project',
  adapter: 'openspec',
  defaultAgent: 'codex',
  allowedAgents: ['claude', 'codex'],
  openspec: { listCommand: 'openspec list --json', validateCommand: 'openspec validate --strict' }
};

test('rejects an unconfigured project path before running a command', async () => {
  let ran = false;

  await expect(runOpenSpecList({
    requestedProjectPath: '/other/project',
    project,
    execFile: async () => {
      ran = true;
      return { stdout: '{"changes":[]}', stderr: '' };
    }
  })).rejects.toThrow(/not allowlisted/);

  expect(ran).toBe(false);
});

test('maps inactive and active OpenSpec changes to stable board columns', () => {
  const cards = mapOpenSpecChangesToCards(project, [
    { name: 'ready-change', completedTasks: 0, totalTasks: 2, status: 'in-progress', lastModified: '2026-05-10T00:00:00.000Z' },
    { name: 'finished-change', completedTasks: 2, totalTasks: 2, status: 'complete', lastModified: '2026-05-10T01:00:00.000Z' }
  ], {
    'example-project:ready-change': { sessionId: 's1', status: 'running', profileId: 'codex' }
  });

  expect(cards.map((card) => [card.id, card.column])).toEqual([
    ['ready-change', 'active'],
    ['finished-change', 'done']
  ]);
});

test('maps local priority metadata onto cards', () => {
  const cards = mapOpenSpecChangesToCards(project, [
    { name: 'ready-change', completedTasks: 0, totalTasks: 2, status: 'in-progress', lastModified: '2026-05-10T00:00:00.000Z' }
  ], {}, {
    'example-project:ready-change': { priority: 'P5', updatedAt: '2026-05-10T00:00:00.000Z' }
  });

  expect(cards[0]?.metadata.priority).toBe('P5');
});

test('maps changes with an approval marker to the approved column', () => {
  const cards = mapOpenSpecChangesToCards(project, [
    { name: 'approved-change', completedTasks: 0, totalTasks: 2, status: 'in-progress', lastModified: '2026-05-10T00:00:00.000Z' }
  ], {}, {}, new Set(['approved-change']));

  expect(cards[0]?.column).toBe('approved');
});

test('maps changes with matching implementation worktrees to the active column', () => {
  const cards = mapOpenSpecChangesToCards(project, [
    { name: 'worktree-change', completedTasks: 0, totalTasks: 2, status: 'in-progress', lastModified: '2026-05-10T00:00:00.000Z' }
  ], {}, {}, new Set(), new Set(['worktree-change']));

  expect(cards[0]?.column).toBe('active');
});

test('runtime metadata maps needs attention and ready to merge columns', () => {
  const cards = mapOpenSpecChangesToCards(project, [
    { name: 'blocked-change', completedTasks: 0, totalTasks: 2, status: 'in-progress', lastModified: '2026-05-10T00:00:00.000Z' },
    { name: 'merge-change', completedTasks: 2, totalTasks: 2, status: 'in-progress', lastModified: '2026-05-10T00:00:00.000Z' }
  ], {}, {
    'example-project:blocked-change': { runtimeState: 'needs_attention', reason: 'blocked', updatedAt: '2026-05-10T00:00:00.000Z' },
    'example-project:merge-change': { runtimeState: 'ready_to_merge', reason: 'done', updatedAt: '2026-05-10T00:00:00.000Z' }
  });

  expect(cards.map((card) => [card.id, card.column])).toEqual([
    ['blocked-change', 'attention'],
    ['merge-change', 'ready_to_merge']
  ]);
});
