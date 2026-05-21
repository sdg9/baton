import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../config/config';

const execFileAsync = promisify(nodeExecFile);
const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STOP_WORDS = new Set(['a', 'an', 'and', 'as', 'but', 'for', 'i', 'it', 'my', 'not', 'of', 'or', 'the', 'to']);

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;

export interface IdeaDraft {
  projectId: string;
  changeId: string;
  branchName: string;
  worktreePath: string;
  prompt: string;
  profileId: string;
}

export function validateChangeId(changeId: string): string {
  if (!CHANGE_ID_PATTERN.test(changeId)) {
    throw new Error(`Invalid change id: ${changeId}`);
  }
  return changeId;
}

export function generateChangeIdFromPrompt(prompt: string, now = new Date()): string {
  const words = prompt
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((word) => word && !STOP_WORDS.has(word))
    .slice(0, 6);
  const base = (words.length > 0 ? words.join('-') : 'new-idea').slice(0, 58).replace(/-+$/g, '');
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '').replace('T', '-');
  return validateChangeId(`${base}-${stamp}`);
}

export function draftBranchName(changeId: string): string {
  return `workbench/idea/${validateChangeId(changeId)}`;
}

export function draftWorktreePath(root: string, projectId: string, changeId: string): string {
  return join(root, '.agent-workbench', 'worktrees', projectId, validateChangeId(changeId));
}

export async function createIdeaDraft(options: {
  root: string;
  project: ProjectConfig;
  changeId?: string;
  prompt: string;
  profileId: string;
  now?: Date;
  execFile?: ExecFile;
}): Promise<IdeaDraft> {
  const execFile = options.execFile ?? execFileAsync;
  const changeId = options.changeId?.trim() ? validateChangeId(options.changeId.trim()) : generateChangeIdFromPrompt(options.prompt, options.now);
  const worktreePath = draftWorktreePath(options.root, options.project.id, changeId);
  const branchName = draftBranchName(changeId);
  mkdirSync(join(options.root, '.agent-workbench', 'worktrees', options.project.id), { recursive: true });

  if (!existsSync(worktreePath)) {
    await execFile('git', ['-C', options.project.path, 'worktree', 'add', worktreePath, '-b', branchName]);
  }

  return {
    projectId: options.project.id,
    changeId,
    branchName,
    worktreePath,
    prompt: options.prompt,
    profileId: options.profileId
  };
}

export async function commitAndMergeDraft(options: {
  root: string;
  project: ProjectConfig;
  changeId: string;
  execFile?: ExecFile;
}) {
  const execFile = options.execFile ?? execFileAsync;
  const changeId = validateChangeId(options.changeId);
  const worktreePath = draftWorktreePath(options.root, options.project.id, changeId);
  const branchName = draftBranchName(changeId);
  const allowedPrefix = `openspec/changes/${changeId}/`;

  const draftStatus = await execFile('git', ['-C', worktreePath, 'status', '--porcelain']);
  const changedFiles = parsePorcelainFiles(draftStatus.stdout);
  const outOfScope = changedFiles.filter((file) => file !== `openspec/changes/${changeId}` && !file.startsWith(allowedPrefix));
  if (outOfScope.length > 0) {
    throw new Error(`Draft has files outside ${allowedPrefix}: ${outOfScope.join(', ')}`);
  }
  if (changedFiles.length > 0) {
    await execFile('git', ['-C', worktreePath, 'add', `openspec/changes/${changeId}`]);
    await execFile('git', ['-C', worktreePath, 'commit', '-m', `spec: add ${changeId}`]);
  }

  const mainStatus = await execFile('git', ['-C', options.project.path, 'status', '--porcelain']);
  if (mainStatus.stdout.trim()) {
    throw new Error(`The main checkout is not clean: ${mainStatus.stdout.trim()}`);
  }

  await execFile('git', ['-C', options.project.path, 'merge', '--ff-only', branchName]);
  return { merged: true, branchName, worktreePath };
}

export async function draftGitStatus(options: {
  root: string;
  project: ProjectConfig;
  changeId: string;
  execFile?: ExecFile;
}) {
  const execFile = options.execFile ?? execFileAsync;
  const worktreePath = draftWorktreePath(options.root, options.project.id, options.changeId);
  const status = await execFile('git', ['-C', worktreePath, 'status', '--porcelain']);
  return { worktreePath, files: parsePorcelainFiles(status.stdout), raw: status.stdout };
}

function parsePorcelainFiles(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => line.slice(3).split(' -> ').pop() ?? '')
    .filter(Boolean);
}
