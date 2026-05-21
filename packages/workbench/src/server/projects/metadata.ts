import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../config/config';

const execFileAsync = promisify(nodeExecFile);

export type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
export type RuntimeState = 'active' | 'needs_attention' | 'ready_to_merge';

export interface CardMetadata {
  priority?: Priority;
  runtimeState?: RuntimeState;
  reason?: string;
  updatedAt: string;
}

const priorities = new Set(['P0', 'P1', 'P2', 'P3', 'P4', 'P5']);
const runtimeStates = new Set(['active', 'needs_attention', 'ready_to_merge']);

export function isPriority(value: string): value is Priority {
  return priorities.has(value);
}

export function isRuntimeState(value: string): value is RuntimeState {
  return runtimeStates.has(value);
}

export class CardMetadataStore {
  private metadata = new Map<string, CardMetadata>();

  constructor(private readonly path: string) {
    this.load();
  }

  all(): Record<string, CardMetadata> {
    return Object.fromEntries(this.metadata.entries());
  }

  get(projectId: string, cardId: string): CardMetadata | undefined {
    return this.metadata.get(key(projectId, cardId));
  }

  update(projectId: string, cardId: string, patch: { priority?: Priority | null; runtimeState?: RuntimeState | null; reason?: string | null }): CardMetadata {
    const existing = this.get(projectId, cardId);
    const next: CardMetadata = {
      ...existing,
      updatedAt: new Date().toISOString()
    };

    if ('priority' in patch) {
      if (patch.priority === null) {
        delete next.priority;
      } else if (patch.priority && isPriority(patch.priority)) {
        next.priority = patch.priority;
      } else {
        throw new Error(`Invalid priority: ${String(patch.priority)}`);
      }
    }

    if ('runtimeState' in patch) {
      if (patch.runtimeState === null || patch.runtimeState === 'active') {
        delete next.runtimeState;
        delete next.reason;
      } else if (patch.runtimeState && isRuntimeState(patch.runtimeState)) {
        next.runtimeState = patch.runtimeState;
        next.reason = patch.reason?.trim() || undefined;
      } else {
        throw new Error(`Invalid runtime state: ${String(patch.runtimeState)}`);
      }
    } else if ('reason' in patch && patch.reason !== undefined) {
      next.reason = patch.reason?.trim() || undefined;
    }

    this.metadata.set(key(projectId, cardId), next);
    this.save();
    return next;
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as Record<string, CardMetadata>;
    this.metadata = new Map(Object.entries(parsed));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify(this.all(), null, 2));
  }
}

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;

export async function commitProjectMetadata(options: {
  project: ProjectConfig;
  store: CardMetadataStore;
  execFile?: ExecFile;
  mkdir?: (path: string, options: { recursive: true }) => unknown;
  writeFile?: (path: string, content: string) => unknown;
}) {
  const execFile = options.execFile ?? execFileAsync;
  const mkdir = options.mkdir ?? mkdirSync;
  const writeFile = options.writeFile ?? writeFileSync;
  const mainStatus = await execFile('git', ['-C', options.project.path, 'status', '--porcelain']);
  if (mainStatus.stdout.trim()) {
    throw new Error(`The main checkout is not clean: ${mainStatus.stdout.trim()}`);
  }

  const relativePath = 'openspec/workbench/card-metadata.json';
  const absolutePath = join(options.project.path, relativePath);
  const projectPrefix = `${options.project.id}:`;
  const projectMetadata = Object.fromEntries(
    Object.entries(options.store.all())
      .filter(([key]) => key.startsWith(projectPrefix))
      .filter(([, value]) => Boolean(value.priority))
      .map(([key, value]) => [
        key.slice(projectPrefix.length),
        {
          updatedAt: value.updatedAt,
          priority: value.priority
        }
      ])
  );

  mkdir(dirname(absolutePath), { recursive: true });
  writeFile(absolutePath, `${JSON.stringify({ cards: projectMetadata }, null, 2)}\n`);
  await execFile('git', ['-C', options.project.path, 'add', relativePath]);
  const postWriteStatus = await execFile('git', ['-C', options.project.path, 'status', '--porcelain', '--', relativePath]);
  if (!postWriteStatus.stdout.trim()) {
    return { committed: false, path: absolutePath, reason: 'no metadata changes' };
  }
  await execFile('git', ['-C', options.project.path, 'commit', '-m', 'chore: update workbench priorities']);
  return { committed: true, path: absolutePath };
}

function key(projectId: string, cardId: string): string {
  return `${projectId}:${cardId}`;
}
