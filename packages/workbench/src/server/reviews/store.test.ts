import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acceptPending,
  addComment,
  getPending,
  listComments,
  listVersions,
  loadSnapshot,
  markCommentsSubmitted,
  rejectPending,
  reviewRoot,
  setPending,
  snapshotBaseVersion
} from './store';
import type { ProjectConfig } from '../config/config';

function projectAt(path: string): ProjectConfig {
  return {
    id: 'demo',
    name: 'Demo',
    path,
    adapter: 'openspec',
    defaultAgent: 'codex',
    allowedAgents: ['claude', 'codex'],
    openspec: { listCommand: 'openspec list --json', validateCommand: 'openspec validate --strict' }
  };
}

function locator() {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-reviews-'));
  return { project: projectAt(root), changeId: 'demo-change', docPath: 'proposal.md', root };
}

test('rejects unsafe change ids and doc paths', () => {
  const project = projectAt('/tmp/x');
  expect(() => reviewRoot({ project, changeId: '../escape', docPath: 'proposal.md' })).toThrow(/Invalid change id/);
  expect(() => reviewRoot({ project, changeId: 'demo', docPath: '../etc/passwd' })).toThrow(/Invalid doc path/);
  expect(() => reviewRoot({ project, changeId: 'demo', docPath: 'proposal.txt' })).toThrow(/Invalid doc path/);
});

test('encodes nested doc paths into a flat directory', () => {
  const root = reviewRoot({ project: projectAt('/repo'), changeId: 'demo', docPath: 'specs/auth/spec.md' });
  expect(root).toBe('/repo/openspec/changes/demo/.reviews/specs__SLASH__auth__SLASH__spec.md');
});

test('snapshots a base version once', () => {
  const loc = locator();
  const v1 = snapshotBaseVersion(loc, '# original\n');
  const v2 = snapshotBaseVersion(loc, '# different\n');
  expect(v1.index).toBe(0);
  expect(v2.fileName).toBe(v1.fileName);
  expect(listVersions(reviewRoot(loc))).toHaveLength(1);
});

test('addComment assigns sequential NoIds and persists', () => {
  const loc = locator();
  const a = addComment(loc, 'first');
  const b = addComment(loc, 'second');
  expect(a.id).toBe(1);
  expect(b.id).toBe(2);
  expect(listComments(reviewRoot(loc))).toHaveLength(2);
  expect(() => addComment(loc, '   ')).toThrow(/empty/);
});

test('submit + accept promotes pending to next version and resolves comments', () => {
  const loc = locator();
  snapshotBaseVersion(loc, '# v0\n');
  addComment(loc, 'tighten the intro');
  addComment(loc, 'add a constraints section');
  const submitted = markCommentsSubmitted(loc, 'batch-1');
  expect(submitted).toHaveLength(2);
  setPending(loc, 'batch-1', '# v1\nrewrite\n');
  expect(getPending(loc)?.content).toBe('# v1\nrewrite\n');

  const v1 = acceptPending(loc, 'edit');
  expect(v1.index).toBe(1);
  expect(getPending(loc)).toBeUndefined();
  expect(readFileSync(join(reviewRoot(loc), 'versions', v1.fileName), 'utf8')).toBe('# v1\nrewrite\n');
  expect(listComments(reviewRoot(loc)).every((comment) => comment.status === 'resolved')).toBe(true);
});

test('reject discards pending and reopens submitted comments', () => {
  const loc = locator();
  snapshotBaseVersion(loc, '# v0\n');
  addComment(loc, 'first');
  markCommentsSubmitted(loc, 'batch-1');
  setPending(loc, 'batch-1', '# attempted\n');

  rejectPending(loc);
  expect(getPending(loc)).toBeUndefined();
  const comments = listComments(reviewRoot(loc));
  expect(comments[0].status).toBe('open');
  expect(comments[0].batchId).toBeUndefined();
});

test('loadSnapshot returns full review state', () => {
  const loc = locator();
  snapshotBaseVersion(loc, '# v0\n');
  addComment(loc, 'a');
  const snap = loadSnapshot(loc);
  expect(snap.versions).toHaveLength(1);
  expect(snap.comments).toHaveLength(1);
  expect(snap.state.nextCommentId).toBe(2);
  expect(snap.pending).toBeUndefined();
});
