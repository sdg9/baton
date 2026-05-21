import type { ProjectConfig } from '../config/config';
import type { CardMetadata } from './metadata';

export type BoardColumn = 'backlog' | 'approved' | 'active' | 'attention' | 'ready_to_merge' | 'done';

export interface OpenSpecChange {
  name: string;
  completedTasks: number;
  totalTasks: number;
  status: string;
  lastModified?: string;
}

export interface SessionMetadata {
  sessionId: string;
  status: 'running' | 'exited' | 'attention';
  profileId: string;
}

export interface WorktreeMetadata {
  path: string;
  branch?: string;
  dirty: boolean;
  ahead: number;
}

export interface BoardCard {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  completedTasks: number;
  totalTasks: number;
  lastModified?: string;
  column: BoardColumn;
  session?: SessionMetadata;
  worktree?: WorktreeMetadata;
  metadata: CardMetadata;
  allowedAgents: string[];
  defaultAgent: string;
  project: ProjectConfig;
}

export interface BoardColumnGroup {
  id: BoardColumn;
  title: string;
  cards: BoardCard[];
}
