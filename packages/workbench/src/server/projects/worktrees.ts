import { execFile as nodeExecFile } from 'node:child_process';
import { basename } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../config/config';
import type { OpenSpecChange, WorktreeMetadata } from './types';

const execFileAsync = promisify(nodeExecFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[]) => Promise<ExecResult>;

export interface GitWorktree {
  path: string;
  branch?: string;
}

export async function listGitWorktrees(project: ProjectConfig, execFile: ExecFile = execFileAsync): Promise<GitWorktree[]> {
  const { stdout } = await execFile('git', ['-C', project.path, 'worktree', 'list', '--porcelain']);
  return parseGitWorktreeList(stdout);
}

export function parseGitWorktreeList(stdout: string): GitWorktree[] {
  const worktrees: GitWorktree[] = [];
  let current: GitWorktree | undefined;

  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      if (current) worktrees.push(current);
      current = undefined;
      continue;
    }
    if (line.startsWith('worktree ')) {
      if (current) worktrees.push(current);
      current = { path: line.slice('worktree '.length) };
    } else if (current && line.startsWith('branch refs/heads/')) {
      current.branch = line.slice('branch refs/heads/'.length);
    }
  }
  if (current) worktrees.push(current);
  return worktrees;
}

export function findWorktreeMatchedChanges(worktrees: GitWorktree[], changeIds: string[]): Set<string> {
  const normalizedToChange = new Map(changeIds.map((changeId) => [normalize(changeId), changeId]));
  const matches = new Set<string>();

  for (const worktree of worktrees) {
    for (const candidate of candidatesFor(worktree)) {
      const exact = normalizedToChange.get(normalize(candidate));
      if (exact) matches.add(exact);
    }
  }

  return matches;
}

export async function findActiveWorktreeChanges(project: ProjectConfig, changes: OpenSpecChange[]): Promise<Set<string>> {
  const worktrees = await listGitWorktrees(project);
  const mainPath = normalize(project.path);
  return findWorktreeMatchedChanges(
    worktrees.filter((worktree) => normalize(worktree.path) !== mainPath),
    changes.map((change) => change.name)
  );
}

export async function findWorktreeMetadata(project: ProjectConfig, changes: OpenSpecChange[], execFile: ExecFile = execFileAsync): Promise<Record<string, WorktreeMetadata>> {
  const worktrees = (await listGitWorktrees(project, execFile)).filter((worktree) => normalize(worktree.path) !== normalize(project.path));
  const result: Record<string, WorktreeMetadata> = {};

  await Promise.all(changes.map(async (change) => {
    const worktree = worktrees.find((candidate) => worktreeMatchesChange(candidate, change.name));
    if (!worktree) return;
    const [status, ahead] = await Promise.all([
      execFile('git', ['-C', worktree.path, 'status', '--porcelain']),
      execFile('git', ['-C', worktree.path, 'rev-list', '--count', 'main..HEAD']).catch(() => ({ stdout: '0', stderr: '' }))
    ]);
    result[change.name] = {
      path: worktree.path,
      branch: worktree.branch,
      dirty: Boolean(status.stdout.trim()),
      ahead: Number.parseInt(ahead.stdout.trim(), 10) || 0
    };
  }));

  return result;
}

export interface WorktreeSummary {
  projectId: string;
  projectName: string;
  path: string;
  branch?: string;
  isMain: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  changeId?: string;
  mappingSource?: 'recorded' | 'inferred';
  specState: 'active' | 'archived' | 'unmapped';
  removable: boolean;
}

export async function summarizeProjectWorktrees(options: {
  project: ProjectConfig;
  activeChangeIds: Set<string>;
  archivedChangeIds: Set<string>;
  recordedMappings: Map<string, { changeId: string }>;
  execFile?: ExecFile;
}): Promise<WorktreeSummary[]> {
  const execFile = options.execFile ?? execFileAsync;
  const { project, activeChangeIds, archivedChangeIds, recordedMappings } = options;
  const worktrees = await listGitWorktrees(project, execFile);
  const mainPath = normalize(project.path);

  return Promise.all(worktrees.map(async (worktree): Promise<WorktreeSummary> => {
    const isMain = normalize(worktree.path) === mainPath;
    const recorded = recordedMappings.get(normalizePath(worktree.path));
    const inferredId = inferChangeId(worktree, [...activeChangeIds, ...archivedChangeIds]);
    const changeId = recorded?.changeId ?? inferredId;
    const mappingSource = recorded ? 'recorded' : inferredId ? 'inferred' : undefined;

    const specState: WorktreeSummary['specState'] = (() => {
      if (!changeId) return 'unmapped';
      if (archivedChangeIds.has(changeId)) return 'archived';
      if (activeChangeIds.has(changeId)) return 'active';
      return 'unmapped';
    })();

    const [statusResult, aheadBehindResult] = await Promise.all([
      execFile('git', ['-C', worktree.path, 'status', '--porcelain']).catch(() => ({ stdout: '', stderr: '' })),
      isMain
        ? Promise.resolve({ stdout: '0\t0', stderr: '' })
        : execFile('git', ['-C', worktree.path, 'rev-list', '--left-right', '--count', 'HEAD...main']).catch(() => ({ stdout: '0\t0', stderr: '' }))
    ]);
    const dirty = Boolean(statusResult.stdout.trim());
    const [aheadRaw, behindRaw] = aheadBehindResult.stdout.trim().split(/\s+/);
    const ahead = Number.parseInt(aheadRaw ?? '0', 10) || 0;
    const behind = Number.parseInt(behindRaw ?? '0', 10) || 0;

    return {
      projectId: project.id,
      projectName: project.name,
      path: worktree.path,
      branch: worktree.branch,
      isMain,
      dirty,
      ahead,
      behind,
      changeId,
      mappingSource,
      specState,
      removable: !isMain && specState === 'archived' && !dirty && ahead === 0
    };
  }));
}

export async function safeRemoveWorktree(options: {
  project: ProjectConfig;
  worktreePath: string;
  execFile?: ExecFile;
}): Promise<{ removed: true; path: string }> {
  const execFile = options.execFile ?? execFileAsync;
  const worktrees = await listGitWorktrees(options.project, execFile);
  const target = worktrees.find((entry) => normalizePath(entry.path) === normalizePath(options.worktreePath));
  if (!target) throw new Error(`Worktree not found under project ${options.project.id}: ${options.worktreePath}`);
  if (normalize(target.path) === normalize(options.project.path)) {
    throw new Error('Refusing to remove the project main worktree');
  }
  await execFile('git', ['-C', options.project.path, 'worktree', 'remove', target.path]);
  return { removed: true, path: target.path };
}

function inferChangeId(worktree: GitWorktree, changeIds: string[]): string | undefined {
  const map = new Map(changeIds.map((id) => [normalize(id), id]));
  for (const candidate of candidatesFor(worktree)) {
    const match = map.get(normalize(candidate));
    if (match) return match;
  }
  return undefined;
}

function normalizePath(value: string): string {
  return value.replace(/\/+$/, '');
}

function candidatesFor(worktree: GitWorktree): string[] {
  const branchParts = worktree.branch?.split('/') ?? [];
  return [
    basename(worktree.path),
    worktree.branch ?? '',
    branchParts.at(-1) ?? ''
  ].filter(Boolean);
}

function worktreeMatchesChange(worktree: GitWorktree, changeId: string): boolean {
  return candidatesFor(worktree).some((candidate) => normalize(candidate) === normalize(changeId));
}

function normalize(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
