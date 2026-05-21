import { findWorktreeMatchedChanges, parseGitWorktreeList } from './worktrees';

test('parses git worktree porcelain output', () => {
  const worktrees = parseGitWorktreeList(`worktree /repo
HEAD abc
branch refs/heads/main

worktree /repo/.claude/worktrees/content-ironclad-divergence-reconciliation
HEAD def
branch refs/heads/story/content-ironclad-divergence-reconciliation
`);

  expect(worktrees).toEqual([
    { path: '/repo', branch: 'main' },
    {
      path: '/repo/.claude/worktrees/content-ironclad-divergence-reconciliation',
      branch: 'story/content-ironclad-divergence-reconciliation'
    }
  ]);
});

test('fuzzy matches OpenSpec change ids to worktree path basename or branch suffix', () => {
  const matches = findWorktreeMatchedChanges([
    { path: '/repo/.claude/worktrees/content-ironclad-divergence-reconciliation', branch: 'story/other-name' },
    { path: '/repo/.worktrees/random-name', branch: 'story/content-ironclad-ip-rename-unblock' }
  ], [
    'content-ironclad-divergence-reconciliation',
    'content-ironclad-ip-rename-unblock',
    'combat-hooks-consolidation'
  ]);

  expect([...matches].sort()).toEqual([
    'content-ironclad-divergence-reconciliation',
    'content-ironclad-ip-rename-unblock'
  ]);
});
