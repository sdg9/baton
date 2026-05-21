import { execFile as nodeExecFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ProjectConfig } from '../config/config';
import type { CardMetadata } from './metadata';
import type { BoardCard, OpenSpecChange, SessionMetadata, WorktreeMetadata } from './types';

const execFileAsync = promisify(nodeExecFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[], options: { cwd: string }) => Promise<ExecResult>;

export async function runOpenSpecList(options: {
  requestedProjectPath: string;
  project: ProjectConfig;
  execFile?: ExecFile;
}): Promise<OpenSpecChange[]> {
  const { requestedProjectPath, project, execFile = execFileAsync } = options;
  if (requestedProjectPath !== project.path) {
    throw new Error(`Project path ${requestedProjectPath} is not allowlisted`);
  }

  const command = project.openspec.listCommand.trim().split(/\s+/);
  if (command[0] !== 'openspec' || command[1] !== 'list' || command[2] !== '--json' || command.length !== 3) {
    throw new Error(`Unsupported OpenSpec list command for project ${project.id}`);
  }

  const { stdout } = await execFile(command[0], command.slice(1), { cwd: project.path });
  const parsed = JSON.parse(stdout) as { changes?: OpenSpecChange[] };
  return parsed.changes ?? [];
}

export function sessionKey(projectId: string, cardId: string): string {
  return `${projectId}:${cardId}`;
}

export function mapOpenSpecChangesToCards(
  project: ProjectConfig,
  changes: OpenSpecChange[],
  sessions: Record<string, SessionMetadata> = {},
  metadata: Record<string, CardMetadata> = {},
  approvedChanges: Set<string> = new Set(),
  activeWorktreeChanges: Set<string> = new Set(),
  worktreeMetadata: Record<string, WorktreeMetadata> = {}
): BoardCard[] {
  return changes.map((change) => {
    const session = sessions[sessionKey(project.id, change.name)];
    const cardMetadata = metadata[sessionKey(project.id, change.name)] ?? { updatedAt: change.lastModified ?? new Date(0).toISOString() };
    const column = (() => {
      if (cardMetadata.runtimeState === 'needs_attention') return 'attention';
      if (cardMetadata.runtimeState === 'ready_to_merge') return 'ready_to_merge';
      if (session?.status === 'attention' || session?.status === 'exited') return 'attention';
      if (session?.status === 'running') return 'active';
      if (activeWorktreeChanges.has(change.name)) return 'active';
      if (change.status === 'complete' || (change.totalTasks > 0 && change.completedTasks === change.totalTasks)) return 'done';
      if (approvedChanges.has(change.name)) return 'approved';
      return 'backlog';
    })();

    return {
      id: change.name,
      projectId: project.id,
      projectName: project.name,
      title: change.name,
      status: change.status,
      completedTasks: change.completedTasks,
      totalTasks: change.totalTasks,
      lastModified: change.lastModified,
      column,
      session,
      worktree: worktreeMetadata[change.name],
      metadata: cardMetadata,
      allowedAgents: project.allowedAgents,
      defaultAgent: project.defaultAgent,
      project
    };
  });
}

export function findApprovedChanges(project: ProjectConfig, changes: OpenSpecChange[]): Set<string> {
  return new Set(changes
    .filter((change) => existsSync(join(project.path, 'openspec', 'changes', change.name, 'approved')))
    .map((change) => change.name));
}

export function groupCards(cards: BoardCard[]) {
  return [
    { id: 'backlog' as const, title: 'Ready', cards: cards.filter((card) => card.column === 'backlog') },
    { id: 'approved' as const, title: 'Approved', cards: cards.filter((card) => card.column === 'approved') },
    { id: 'active' as const, title: 'Active', cards: cards.filter((card) => card.column === 'active') },
    { id: 'attention' as const, title: 'Needs Attention', cards: cards.filter((card) => card.column === 'attention') },
    { id: 'ready_to_merge' as const, title: 'Ready to Merge', cards: cards.filter((card) => card.column === 'ready_to_merge') },
    { id: 'done' as const, title: 'Done', cards: cards.filter((card) => card.column === 'done') }
  ];
}
