import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { type InboxEntry, parseInbox } from './parser';

const SOURCE_FILES = ['INBOX.md', 'BACKLOG.md'];

function cacheDir(): string {
  const dir = join(homedir(), '.cache', 'agent-workbench');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

function cachePath(projectId: string): string {
  return join(cacheDir(), `${projectId}.inbox.sqlite`);
}

function openDb(projectId: string): Database.Database {
  const db = new Database(cachePath(projectId));
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS entries (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      source_file   TEXT    NOT NULL,
      section       TEXT    NOT NULL,
      size_class    TEXT    NOT NULL,
      date          TEXT    NOT NULL,
      slug          TEXT    NOT NULL,
      title         TEXT    NOT NULL,
      status        TEXT    NOT NULL,
      size          TEXT    NOT NULL,
      source        TEXT    NOT NULL,
      gating        TEXT    NOT NULL,
      scope         TEXT    NOT NULL,
      reason        TEXT    NOT NULL,
      notes         TEXT    NOT NULL,
      priority      TEXT    NOT NULL DEFAULT '',
      priority_rank INTEGER NOT NULL DEFAULT 99,
      line          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entries_size_class    ON entries (size_class);
    CREATE INDEX IF NOT EXISTS idx_entries_date          ON entries (date);
    CREATE INDEX IF NOT EXISTS idx_entries_slug          ON entries (slug);
    CREATE INDEX IF NOT EXISTS idx_entries_section       ON entries (section);
    CREATE INDEX IF NOT EXISTS idx_entries_priority_rank ON entries (priority_rank);

    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Forward-migrate older caches: add priority columns if missing.
  const cols = db.prepare<[], { name: string }>("PRAGMA table_info(entries)").all().map((r) => r.name);
  if (!cols.includes('priority')) db.exec("ALTER TABLE entries ADD COLUMN priority TEXT NOT NULL DEFAULT ''");
  if (!cols.includes('priority_rank')) db.exec("ALTER TABLE entries ADD COLUMN priority_rank INTEGER NOT NULL DEFAULT 99");
  return db;
}

function fingerprint(projectPath: string): string {
  return SOURCE_FILES.map((f) => {
    const p = join(projectPath, f);
    if (!existsSync(p)) return `${f}:missing`;
    const s = statSync(p);
    return `${f}:${s.size}:${s.mtimeMs}`;
  }).join('|');
}

export function rebuildCache(projectId: string, projectPath: string): { entries: number; skipped: boolean } {
  const db = openDb(projectId);
  try {
    const fp = fingerprint(projectPath);
    const existingRow = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get('fingerprint');
    if (existingRow?.value === fp) {
      const count = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM entries').get();
      return { entries: count?.c ?? 0, skipped: true };
    }

    const all: InboxEntry[] = [];
    for (const file of SOURCE_FILES) {
      const path = join(projectPath, file);
      if (!existsSync(path)) continue;
      const label = file.replace(/\.md$/i, '').toUpperCase();
      const parsed = parseInbox(label, readFileSync(path, 'utf-8'));
      all.push(...parsed);
    }

    const insert = db.prepare(`
      INSERT INTO entries (source_file, section, size_class, date, slug, title, status, size, source, gating, scope, reason, notes, priority, priority_rank, line)
      VALUES (@source_file, @section, @size_class, @date, @slug, @title, @status, @size, @source, @gating, @scope, @reason, @notes, @priority, @priority_rank, @line)
    `);
    const txn = db.transaction((rows: InboxEntry[]) => {
      db.prepare('DELETE FROM entries').run();
      for (const r of rows) insert.run(r);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('fingerprint', fp);
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run('rebuiltAt', new Date().toISOString());
    });
    txn(all);

    return { entries: all.length, skipped: false };
  } finally {
    db.close();
  }
}

export type InboxQuery = {
  q?: string;
  size?: string;
  source_file?: string;
  section?: string;
  since?: string;
  mode?: 'actionable' | 'all';
  priority?: string;
};

const NON_ACTIONABLE_SECTIONS = ['Abandoned', 'OpenSpec Change Map'];

export type InboxQueryResult = {
  rebuiltAt: string | null;
  total: number;
  entries: InboxEntry[];
};

export function queryInbox(projectId: string, query: InboxQuery): InboxQueryResult {
  const db = openDb(projectId);
  try {
    const where: string[] = [];
    const params: Record<string, string> = {};
    if (query.size) {
      where.push('size_class = @size');
      params.size = query.size;
    }
    if (query.source_file) {
      where.push('source_file = @source_file');
      params.source_file = query.source_file;
    }
    if (query.section) {
      where.push('section = @section');
      params.section = query.section;
    }
    if (query.since) {
      where.push("(date != '' AND date >= @since)");
      params.since = query.since;
    }
    if (query.q) {
      where.push('(title LIKE @q OR slug LIKE @q OR scope LIKE @q OR source LIKE @q OR notes LIKE @q)');
      params.q = `%${query.q}%`;
    }
    if (query.priority) {
      // Treat 'P1' as "P1 only", 'prioritized' as "any priority set"
      if (query.priority === 'prioritized') {
        where.push("priority != ''");
      } else {
        where.push('priority LIKE @priority_like');
        params.priority_like = `%${query.priority}%`;
      }
    }
    if ((query.mode ?? 'actionable') === 'actionable') {
      const placeholders = NON_ACTIONABLE_SECTIONS.map((_, i) => `@na${i}`).join(', ');
      where.push(`section NOT IN (${placeholders})`);
      where.push("status != 'x'");
      NON_ACTIONABLE_SECTIONS.forEach((s, i) => {
        params[`na${i}`] = s;
      });
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const rows = db
      .prepare(
        `SELECT source_file, section, size_class, date, slug, title, status, size, source, gating, scope, reason, notes, priority, priority_rank, line
         FROM entries
         ${whereSql}
         ORDER BY priority_rank, source_file, line`,
      )
      .all(params) as InboxEntry[];

    const totalRow = db.prepare<[], { c: number }>('SELECT COUNT(*) AS c FROM entries').get();
    const metaRow = db.prepare<[string], { value: string }>('SELECT value FROM meta WHERE key = ?').get('rebuiltAt');

    return {
      rebuiltAt: metaRow?.value ?? null,
      total: totalRow?.c ?? 0,
      entries: rows,
    };
  } finally {
    db.close();
  }
}

export function inboxSourceFiles(projectPath: string): string[] {
  return SOURCE_FILES.map((f) => join(projectPath, f)).filter((p) => existsSync(p));
}

export function findEntry(projectId: string, sourceFile: string, line: number): InboxEntry | null {
  const db = openDb(projectId);
  try {
    const row = db
      .prepare(
        `SELECT source_file, section, size_class, date, slug, title, status, size, source, gating, scope, reason, notes, priority, priority_rank, line
         FROM entries WHERE source_file = ? AND line = ?`,
      )
      .get(sourceFile, line) as InboxEntry | undefined;
    return row ?? null;
  } finally {
    db.close();
  }
}
