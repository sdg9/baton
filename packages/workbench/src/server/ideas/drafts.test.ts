import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  commitAndMergeDraft,
  createIdeaDraft,
  generateChangeIdFromPrompt,
  validateChangeId
} from './drafts';
import type { ProjectConfig } from '../config/config';

function projectAt(path: string): ProjectConfig {
  return {
    id: 'example-project',
    name: 'Example Project',
    path,
    adapter: 'openspec',
    defaultAgent: 'codex',
    allowedAgents: ['claude', 'codex'],
    openspec: { listCommand: 'openspec list --json', validateCommand: 'openspec validate --strict' }
  };
}

test('rejects unsafe draft change ids', () => {
  expect(() => validateChangeId('../escape')).toThrow(/Invalid change id/);
});

test('generates a readable change id from an idea prompt', () => {
  expect(generateChangeIdFromPrompt(
    'My cards/hand, animations, and interactions feel alright but not buttery smooth.',
    new Date('2026-05-10T13:30:00Z')
  )).toBe('cards-hand-animations-interactions-feel-alright-20260510-133000');
});

test('creates an idea draft in an isolated worktree branch', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-drafts-'));
  const calls: string[][] = [];

  const draft = await createIdeaDraft({
    root,
    project: projectAt('/repo/main'),
    changeId: 'new-idea',
    prompt: 'Add a new idea',
    profileId: 'codex',
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      return { stdout: '', stderr: '' };
    }
  });

  expect(draft.branchName).toBe('workbench/idea/new-idea');
  expect(draft.worktreePath).toBe(join(root, '.agent-workbench', 'worktrees', 'example-project', 'new-idea'));
  expect(calls[0]).toEqual([
    'git',
    '-C',
    '/repo/main',
    'worktree',
    'add',
    draft.worktreePath,
    '-b',
    'workbench/idea/new-idea'
  ]);
});

test('creates an idea draft with a generated change id when omitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-drafts-'));

  const draft = await createIdeaDraft({
    root,
    project: projectAt('/repo/main'),
    prompt: 'Make hand interactions buttery smooth',
    profileId: 'codex',
    now: new Date('2026-05-10T13:31:00Z'),
    execFile: async () => ({ stdout: '', stderr: '' })
  });

  expect(draft.changeId).toBe('make-hand-interactions-buttery-smooth-20260510-133100');
  expect(draft.branchName).toBe('workbench/idea/make-hand-interactions-buttery-smooth-20260510-133100');
});

test('commit and merge blocks files outside the generated OpenSpec change', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-drafts-'));

  await expect(commitAndMergeDraft({
    root,
    project: projectAt('/repo/main'),
    changeId: 'new-idea',
    execFile: async (_file, args) => {
      if (args.includes('status') && args.includes('--porcelain')) {
        return { stdout: '?? package.json\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  })).rejects.toThrow(/outside openspec\/changes\/new-idea/);
});

test('commit and merge blocks when the main checkout is dirty', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-drafts-'));

  await expect(commitAndMergeDraft({
    root,
    project: projectAt('/repo/main'),
    changeId: 'new-idea',
    execFile: async (_file, args) => {
      if (args[1]?.includes('.agent-workbench')) {
        return { stdout: '?? openspec/changes/new-idea/proposal.md\n', stderr: '' };
      }
      if (args[2] === 'status') {
        return { stdout: ' M src/game.ts\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    }
  })).rejects.toThrow(/main checkout is not clean/);
});
