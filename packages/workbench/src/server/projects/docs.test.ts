import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readOpenSpecChangeDocs, readOpenSpecChangeDocsFromRoot } from './docs';
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

test('reads proposal, design, tasks, and specs for an allowlisted OpenSpec change', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-docs-'));
  const changeRoot = join(root, 'openspec', 'changes', 'change-a');
  mkdirSync(join(changeRoot, 'specs', 'project-kanban'), { recursive: true });
  writeFileSync(join(changeRoot, 'proposal.md'), '# Proposal');
  writeFileSync(join(changeRoot, 'design.md'), '# Design');
  writeFileSync(join(changeRoot, 'tasks.md'), '# Tasks');
  writeFileSync(join(changeRoot, 'specs', 'project-kanban', 'spec.md'), '# Spec');

  const docs = readOpenSpecChangeDocs(projectAt(root), 'change-a');

  expect(docs.map((doc) => doc.path)).toEqual([
    'proposal.md',
    'design.md',
    'tasks.md',
    'specs/project-kanban/spec.md'
  ]);
  expect(docs[0]?.content).toBe('# Proposal');
});

test('rejects unsafe change ids before reading files', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-docs-'));

  expect(() => readOpenSpecChangeDocs(projectAt(root), '../other')).toThrow(/Invalid OpenSpec change id/);
});

test('reads docs from an explicit worktree root', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-docs-'));
  const changeRoot = join(root, 'openspec', 'changes', 'draft-a');
  mkdirSync(changeRoot, { recursive: true });
  writeFileSync(join(changeRoot, 'proposal.md'), '# Draft');

  const docs = readOpenSpecChangeDocsFromRoot(root, 'draft-a');

  expect(docs.map((doc) => doc.path)).toEqual(['proposal.md']);
  expect(docs[0]?.content).toBe('# Draft');
});
