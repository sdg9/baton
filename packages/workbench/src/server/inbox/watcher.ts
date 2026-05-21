import chokidar, { type FSWatcher } from 'chokidar';
import { inboxSourceFiles, rebuildCache } from './cache';

const watchers = new Map<string, FSWatcher>();
const debounceTimers = new Map<string, NodeJS.Timeout>();

function scheduleRebuild(projectId: string, projectPath: string): void {
  const existing = debounceTimers.get(projectId);
  if (existing) clearTimeout(existing);
  debounceTimers.set(
    projectId,
    setTimeout(() => {
      try {
        const result = rebuildCache(projectId, projectPath);
        if (!result.skipped) {
          console.log(`[inbox] rebuilt ${projectId}: ${result.entries} entries`);
        }
      } catch (err) {
        console.warn(`[inbox] rebuild failed for ${projectId}:`, err);
      }
      debounceTimers.delete(projectId);
    }, 250),
  );
}

export function startInboxWatcher(projectId: string, projectPath: string): void {
  if (watchers.has(projectId)) return;

  const files = inboxSourceFiles(projectPath);
  if (files.length === 0) return;

  // Initial sync (skipped if fingerprint matches)
  try {
    rebuildCache(projectId, projectPath);
  } catch (err) {
    console.warn(`[inbox] initial cache build failed for ${projectId}:`, err);
  }

  const watcher = chokidar.watch(files, {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
  });
  watcher.on('change', () => scheduleRebuild(projectId, projectPath));
  watcher.on('add', () => scheduleRebuild(projectId, projectPath));
  watcher.on('unlink', () => scheduleRebuild(projectId, projectPath));
  watcher.on('error', (err) => console.warn(`[inbox] watcher error for ${projectId}:`, err));

  watchers.set(projectId, watcher);
}

export async function stopAllInboxWatchers(): Promise<void> {
  for (const [_id, w] of watchers) {
    await w.close();
  }
  watchers.clear();
  for (const [_id, t] of debounceTimers) clearTimeout(t);
  debounceTimers.clear();
}
