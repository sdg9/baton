import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { SessionMetadata } from '../projects/types';

export interface StoredSession extends SessionMetadata {
  projectId: string;
  cardId: string;
  tmuxSessionName: string;
  updatedAt: string;
  lastOutputHash?: string;
  lastOutputAt?: string;
  attentionReason?: string;
}

export class SessionStore {
  private sessions = new Map<string, StoredSession>();

  constructor(private readonly path: string) {
    this.load();
  }

  all(): Record<string, SessionMetadata> {
    return Object.fromEntries([...this.sessions.values()].map((session) => [
      `${session.projectId}:${session.cardId}`,
      { sessionId: session.sessionId, status: session.status, profileId: session.profileId }
    ]));
  }

  get(projectId: string, cardId: string): StoredSession | undefined {
    return this.sessions.get(`${projectId}:${cardId}`);
  }

  list(): StoredSession[] {
    return [...this.sessions.values()];
  }

  upsert(session: StoredSession): void {
    this.sessions.set(`${session.projectId}:${session.cardId}`, session);
    this.save();
  }

  remove(projectId: string, cardId: string): boolean {
    const removed = this.sessions.delete(`${projectId}:${cardId}`);
    if (removed) this.save();
    return removed;
  }

  markStatus(projectId: string, cardId: string, status: StoredSession['status']): void {
    const session = this.get(projectId, cardId);
    if (!session || session.status === status) return;
    this.sessions.set(`${projectId}:${cardId}`, {
      ...session,
      status,
      updatedAt: new Date().toISOString()
    });
    this.save();
  }

  markRunning(projectId: string, cardId: string): void {
    const session = this.get(projectId, cardId);
    if (!session || session.status === 'running') return;
    this.sessions.set(`${projectId}:${cardId}`, {
      ...session,
      status: 'running',
      attentionReason: undefined,
      updatedAt: new Date().toISOString()
    });
    this.save();
  }

  markAttention(projectId: string, cardId: string, reason: string): void {
    const session = this.get(projectId, cardId);
    if (!session || (session.status === 'attention' && session.attentionReason === reason)) return;
    this.sessions.set(`${projectId}:${cardId}`, {
      ...session,
      status: 'attention',
      attentionReason: reason,
      updatedAt: new Date().toISOString()
    });
    this.save();
  }

  recordOutputActivity(projectId: string, cardId: string, activity: { outputHash: string; lastOutputAt: string }): void {
    const session = this.get(projectId, cardId);
    if (!session) return;
    if (session.lastOutputHash === activity.outputHash && session.lastOutputAt === activity.lastOutputAt) return;
    this.sessions.set(`${projectId}:${cardId}`, {
      ...session,
      lastOutputHash: activity.outputHash,
      lastOutputAt: activity.lastOutputAt
    });
    this.save();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    const parsed = JSON.parse(readFileSync(this.path, 'utf8')) as StoredSession[];
    parsed.forEach((session) => this.sessions.set(`${session.projectId}:${session.cardId}`, session));
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    writeFileSync(this.path, JSON.stringify([...this.sessions.values()], null, 2));
  }
}
