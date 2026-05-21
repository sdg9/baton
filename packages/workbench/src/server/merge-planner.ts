import { basename } from 'node:path';
import type { OpenSpecChange } from './projects/types';
import type { GitWorktree } from './projects/worktrees';

export interface MergeTarget {
  changeId: string;
  worktreePath: string;
  branch?: string;
  status: string;
  completedTasks: number;
  totalTasks: number;
}

export function planWorktreeMergeTargets(worktrees: GitWorktree[], changes: OpenSpecChange[]): MergeTarget[] {
  return changes.flatMap((change) => {
    const worktree = worktrees.find((candidate) => worktreeMatchesChange(candidate, change.name));
    if (!worktree) return [];
    return [{
      changeId: change.name,
      worktreePath: worktree.path,
      branch: worktree.branch,
      status: change.status,
      completedTasks: change.completedTasks,
      totalTasks: change.totalTasks
    }];
  });
}

export function buildMultiMergePrompt(options: {
  projectName: string;
  projectPath: string;
  targets: MergeTarget[];
}): string {
  const targetList = options.targets.map((target, index) => [
    `${index + 1}. ${target.changeId}`,
    `   worktree: ${target.worktreePath}`,
    `   branch: ${target.branch ?? '(detached)'}`,
    `   OpenSpec status: ${target.status}, tasks: ${target.completedTasks}/${target.totalTasks}`
  ].join('\n')).join('\n\n');

  return [
    '# Plan Multi-Merge',
    '',
    `Project: ${options.projectName}`,
    `Main checkout: ${options.projectPath}`,
    '',
    'You are orchestrating a merge plan for active implementation worktrees.',
    'Do not merge, rebase, delete branches, or modify files until the user explicitly approves a specific merge action.',
    '',
    'For each target, inspect:',
    '- `git status --porcelain` in the worktree',
    '- `git log --oneline main..HEAD`',
    '- `git diff --stat main...HEAD`',
    '- relevant OpenSpec proposal/design/tasks/specs',
    '- project validation commands that are appropriate for the change',
    '',
    'Produce a concise merge plan with:',
    '- recommended merge order',
    '- items ready to merge',
    '- dirty worktrees',
    '- likely conflicts or dependency ordering',
    '- validation commands to run before each merge',
    '',
    'Targets:',
    targetList || '(none detected)'
  ].join('\n');
}

function worktreeMatchesChange(worktree: GitWorktree, changeId: string): boolean {
  const branchParts = worktree.branch?.split('/') ?? [];
  const candidates = [
    basename(worktree.path),
    worktree.branch ?? '',
    branchParts.at(-1) ?? ''
  ];
  return candidates.some((candidate) => normalize(candidate) === normalize(changeId));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
