import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export interface WorktreeMapping {
  projectId: string;
  changeId: string;
  worktreePath: string;
  branchName?: string;
  createdAt: string;
}

export class WorktreeMappingStore {
  private byPath = new Map<string, WorktreeMapping>();

  constructor(private readonly path: string) {
    this.load();
  }

  all(): WorktreeMapping[] {
    return Array.from(this.byPath.values());
  }

  get(worktreePath: string): WorktreeMapping | undefined {
    return this.byPath.get(normalizePath(worktreePath));
  }

  record(mapping: Omit<WorktreeMapping, 'createdAt'> & { createdAt?: string }): WorktreeMapping {
    const entry: WorktreeMapping = {
      ...mapping,
      createdAt: mapping.createdAt ?? new Date().toISOString()
    };
    this.byPath.set(normalizePath(entry.worktreePath), entry);
    this.save();
    return entry;
  }

  remove(worktreePath: string): void {
    if (this.byPath.delete(normalizePath(worktreePath))) {
      this.save();
    }
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as WorktreeMapping[];
    this.byPath = new Map(parsed.map((entry) => [normalizePath(entry.worktreePath), entry]));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.all(), null, 2));
  }
}

function normalizePath(value: string): string {
  return value.replace(/\/+$/, '');
}
