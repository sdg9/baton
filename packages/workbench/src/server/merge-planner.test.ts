import { buildMultiMergePrompt, planWorktreeMergeTargets } from './merge-planner';
import type { GitWorktree } from './projects/worktrees';
import type { OpenSpecChange } from './projects/types';

const changes: OpenSpecChange[] = [
  { name: 'content-ironclad-divergence-reconciliation', completedTasks: 0, totalTasks: 29, status: 'in-progress' },
  { name: 'content-ironclad-ip-rename-unblock', completedTasks: 0, totalTasks: 38, status: 'in-progress' }
];

const worktrees: GitWorktree[] = [
  {
    path: '/repo/.claude/worktrees/content-ironclad-divergence-reconciliation',
    branch: 'story/content-ironclad-divergence-reconciliation'
  },
  {
    path: '/repo/.claude/worktrees/other',
    branch: 'story/content-ironclad-ip-rename-unblock'
  }
];

test('plans merge targets by matching worktrees to OpenSpec changes', () => {
  const targets = planWorktreeMergeTargets(worktrees, changes);

  expect(targets.map((target) => target.changeId)).toEqual([
    'content-ironclad-divergence-reconciliation',
    'content-ironclad-ip-rename-unblock'
  ]);
});

test('builds a plan-only multi-merge prompt with safety gates', () => {
  const prompt = buildMultiMergePrompt({
    projectName: 'Example Project',
    projectPath: '/repo',
    targets: planWorktreeMergeTargets(worktrees, changes)
  });

  expect(prompt).toContain('Plan Multi-Merge');
  expect(prompt).toContain('Do not merge');
  expect(prompt).toContain('content-ironclad-divergence-reconciliation');
  expect(prompt).toContain('git status --porcelain');
});
