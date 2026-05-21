import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/config';

const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const DOC_PATH_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9._/-]*\.md$/;
const SLASH_TOKEN = '__SLASH__';

export type CommentStatus = 'open' | 'submitted' | 'resolved';

export interface ReviewComment {
  id: number;
  body: string;
  createdAt: string;
  status: CommentStatus;
  batchId?: string;
}

export interface ReviewVersion {
  index: number;
  fileName: string;
  label: string;
  createdAt: string;
}

export interface ReviewState {
  nextCommentId: number;
  currentVersion: number;
  pendingBatchId?: string;
  pendingCreatedAt?: string;
}

export interface ReviewSnapshot {
  state: ReviewState;
  comments: ReviewComment[];
  versions: ReviewVersion[];
  pending?: { batchId: string; createdAt: string; content: string };
}

interface ReviewLocator {
  project: ProjectConfig;
  changeId: string;
  docPath: string;
}

function validateInputs(changeId: string, docPath: string): void {
  if (!CHANGE_ID_PATTERN.test(changeId)) throw new Error(`Invalid change id: ${changeId}`);
  if (!DOC_PATH_PATTERN.test(docPath)) throw new Error(`Invalid doc path: ${docPath}`);
  if (docPath.includes('..')) throw new Error(`Invalid doc path: ${docPath}`);
}

export function reviewRoot({ project, changeId, docPath }: ReviewLocator): string {
  validateInputs(changeId, docPath);
  const encoded = docPath.replace(/\//g, SLASH_TOKEN);
  return join(project.path, 'openspec', 'changes', changeId, '.reviews', encoded);
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function readJsonOr<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function writeJson(path: string, value: unknown): void {
  ensureDir(join(path, '..'));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function statePath(root: string): string { return join(root, 'state.json'); }
function commentsPath(root: string): string { return join(root, 'comments.json'); }
function versionsDir(root: string): string { return join(root, 'versions'); }
function pendingPath(root: string): string { return join(root, 'pending.md'); }

export function readState(root: string): ReviewState {
  return readJsonOr<ReviewState>(statePath(root), { nextCommentId: 1, currentVersion: 0 });
}

function writeState(root: string, state: ReviewState): void {
  writeJson(statePath(root), state);
}

export function listComments(root: string): ReviewComment[] {
  return readJsonOr<ReviewComment[]>(commentsPath(root), []);
}

function writeComments(root: string, comments: ReviewComment[]): void {
  writeJson(commentsPath(root), comments);
}

export function listVersions(root: string): ReviewVersion[] {
  const dir = versionsDir(root);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.md'))
    .map((fileName) => parseVersionFile(fileName))
    .filter((v): v is ReviewVersion => v !== null)
    .sort((a, b) => a.index - b.index);
}

function parseVersionFile(fileName: string): ReviewVersion | null {
  const match = /^(\d{3})__([A-Za-z0-9_-]+)__(.+)\.md$/.exec(fileName);
  if (!match) return null;
  const [, indexText, label, createdAt] = match;
  return { index: Number(indexText), fileName, label, createdAt };
}

function versionFileName(index: number, label: string, createdAt: Date): string {
  const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'edit';
  const isoSafe = createdAt.toISOString().replace(/[:]/g, '-');
  return `${String(index).padStart(3, '0')}__${safeLabel}__${isoSafe}.md`;
}

export function readVersionContent(root: string, version: ReviewVersion): string {
  return readFileSync(join(versionsDir(root), version.fileName), 'utf8');
}

export function snapshotBaseVersion(locator: ReviewLocator, currentContent: string, now: Date = new Date()): ReviewVersion {
  const root = reviewRoot(locator);
  const versions = listVersions(root);
  if (versions.length > 0) return versions[0];
  ensureDir(versionsDir(root));
  const version: ReviewVersion = {
    index: 0,
    fileName: versionFileName(0, 'base', now),
    label: 'base',
    createdAt: now.toISOString()
  };
  writeFileSync(join(versionsDir(root), version.fileName), currentContent);
  const state = readState(root);
  writeState(root, { ...state, currentVersion: 0 });
  return version;
}

export function addComment(locator: ReviewLocator, body: string, now: Date = new Date()): ReviewComment {
  const trimmed = body.trim();
  if (!trimmed) throw new Error('Comment body must not be empty');
  const root = reviewRoot(locator);
  ensureDir(root);
  const state = readState(root);
  const comments = listComments(root);
  const comment: ReviewComment = {
    id: state.nextCommentId,
    body: trimmed,
    createdAt: now.toISOString(),
    status: 'open'
  };
  comments.push(comment);
  writeComments(root, comments);
  writeState(root, { ...state, nextCommentId: state.nextCommentId + 1 });
  return comment;
}

export function removeComment(locator: ReviewLocator, commentId: number): boolean {
  const root = reviewRoot(locator);
  const comments = listComments(root);
  const next = comments.filter((comment) => comment.id !== commentId);
  if (next.length === comments.length) return false;
  writeComments(root, next);
  return true;
}

export function markCommentsSubmitted(locator: ReviewLocator, batchId: string): ReviewComment[] {
  const root = reviewRoot(locator);
  const comments = listComments(root);
  const updated = comments.map((comment) => comment.status === 'open' ? { ...comment, status: 'submitted' as CommentStatus, batchId } : comment);
  writeComments(root, updated);
  return updated.filter((comment) => comment.batchId === batchId && comment.status === 'submitted');
}

export function setPending(locator: ReviewLocator, batchId: string, content: string, now: Date = new Date()): void {
  const root = reviewRoot(locator);
  ensureDir(root);
  writeFileSync(pendingPath(root), content);
  const state = readState(root);
  writeState(root, { ...state, pendingBatchId: batchId, pendingCreatedAt: now.toISOString() });
}

export function getPending(locator: ReviewLocator): { batchId: string; createdAt: string; content: string } | undefined {
  const root = reviewRoot(locator);
  const state = readState(root);
  if (!state.pendingBatchId || !existsSync(pendingPath(root))) return undefined;
  return {
    batchId: state.pendingBatchId,
    createdAt: state.pendingCreatedAt ?? '',
    content: readFileSync(pendingPath(root), 'utf8')
  };
}

export function acceptPending(locator: ReviewLocator, label = 'edit', now: Date = new Date()): ReviewVersion {
  const root = reviewRoot(locator);
  const state = readState(root);
  const pending = getPending(locator);
  if (!pending) throw new Error('No pending version to accept');
  const nextIndex = state.currentVersion + 1;
  const version: ReviewVersion = {
    index: nextIndex,
    fileName: versionFileName(nextIndex, label, now),
    label,
    createdAt: now.toISOString()
  };
  ensureDir(versionsDir(root));
  writeFileSync(join(versionsDir(root), version.fileName), pending.content);
  rmSync(pendingPath(root), { force: true });
  const comments = listComments(root).map((comment) => comment.batchId === pending.batchId ? { ...comment, status: 'resolved' as CommentStatus } : comment);
  writeComments(root, comments);
  writeState(root, { nextCommentId: state.nextCommentId, currentVersion: nextIndex });
  return version;
}

export function rejectPending(locator: ReviewLocator): void {
  const root = reviewRoot(locator);
  const state = readState(root);
  rmSync(pendingPath(root), { force: true });
  const batchId = state.pendingBatchId;
  if (batchId) {
    const comments = listComments(root).map((comment) => comment.batchId === batchId && comment.status === 'submitted' ? { ...comment, status: 'open' as CommentStatus, batchId: undefined } : comment);
    writeComments(root, comments);
  }
  writeState(root, { nextCommentId: state.nextCommentId, currentVersion: state.currentVersion });
}

export function loadSnapshot(locator: ReviewLocator): ReviewSnapshot {
  const root = reviewRoot(locator);
  return {
    state: readState(root),
    comments: listComments(root),
    versions: listVersions(root),
    pending: getPending(locator)
  };
}
