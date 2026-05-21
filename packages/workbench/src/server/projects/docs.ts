import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { ProjectConfig } from '../config/config';

export interface OpenSpecDoc {
  path: string;
  label: string;
  content: string;
}

const CHANGE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function readOpenSpecChangeDocs(project: ProjectConfig, changeId: string): OpenSpecDoc[] {
  return readOpenSpecChangeDocsFromRoot(project.path, changeId);
}

export function readOpenSpecArchivedChangeDocs(project: ProjectConfig, changeId: string): OpenSpecDoc[] {
  if (!CHANGE_ID_PATTERN.test(changeId)) {
    throw new Error(`Invalid OpenSpec change id: ${changeId}`);
  }
  const changeRoot = join(project.path, 'openspec', 'changes', 'archive', changeId);
  if (!existsSync(changeRoot) || !statSync(changeRoot).isDirectory()) {
    throw new Error(`Archived OpenSpec change ${changeId} was not found`);
  }
  const docs: OpenSpecDoc[] = [];
  for (const fileName of ['proposal.md', 'design.md', 'tasks.md']) {
    const absolutePath = join(changeRoot, fileName);
    if (existsSync(absolutePath)) docs.push(toDoc(changeRoot, absolutePath));
  }
  const specsRoot = join(changeRoot, 'specs');
  if (existsSync(specsRoot)) {
    for (const absolutePath of walkMarkdown(specsRoot)) {
      docs.push(toDoc(changeRoot, absolutePath));
    }
  }
  return docs;
}

export function readOpenSpecChangeDocsFromRoot(projectPath: string, changeId: string): OpenSpecDoc[] {
  if (!CHANGE_ID_PATTERN.test(changeId)) {
    throw new Error(`Invalid OpenSpec change id: ${changeId}`);
  }

  const changeRoot = join(projectPath, 'openspec', 'changes', changeId);
  if (!existsSync(changeRoot) || !statSync(changeRoot).isDirectory()) {
    throw new Error(`OpenSpec change ${changeId} was not found`);
  }

  const docs: OpenSpecDoc[] = [];
  for (const fileName of ['proposal.md', 'design.md', 'tasks.md']) {
    const absolutePath = join(changeRoot, fileName);
    if (existsSync(absolutePath)) {
      docs.push(toDoc(changeRoot, absolutePath));
    }
  }

  const specsRoot = join(changeRoot, 'specs');
  if (existsSync(specsRoot)) {
    for (const absolutePath of walkMarkdown(specsRoot)) {
      docs.push(toDoc(changeRoot, absolutePath));
    }
  }

  return docs;
}

function toDoc(changeRoot: string, absolutePath: string): OpenSpecDoc {
  const path = relative(changeRoot, absolutePath);
  return {
    path,
    label: path,
    content: readFileSync(absolutePath, 'utf8')
  };
}

function walkMarkdown(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkMarkdown(path));
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      files.push(path);
    }
  }
  return files.sort();
}
