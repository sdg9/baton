import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectConfig } from '../config/config';

export interface ArchivedChange {
  projectId: string;
  projectName: string;
  id: string;
  archivedAt?: string;
}

const DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})-(.+)$/;

export function listArchivedChanges(project: ProjectConfig): ArchivedChange[] {
  const archiveDir = join(project.path, 'openspec', 'changes', 'archive');
  let entries: string[];
  try {
    entries = readdirSync(archiveDir);
  } catch {
    return [];
  }
  const archived: ArchivedChange[] = [];
  for (const entry of entries) {
    const entryPath = join(archiveDir, entry);
    let isDir = false;
    try {
      isDir = statSync(entryPath).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const match = DATE_PREFIX.exec(entry);
    archived.push({
      projectId: project.id,
      projectName: project.name,
      id: entry,
      archivedAt: match?.[1]
    });
  }
  return archived.sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? '') || a.id.localeCompare(b.id));
}
