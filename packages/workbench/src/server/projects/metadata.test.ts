import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CardMetadataStore, commitProjectMetadata, isPriority } from './metadata';
import type { ProjectConfig } from '../config/config';

function projectAt(path: string): ProjectConfig {
  return {
    id: 'example-project',
    name: 'Example Project',
    path,
    adapter: 'openspec',
    defaultAgent: 'codex',
    allowedAgents: ['claude', 'codex'],
    openspec: { listCommand: 'openspec list --json', validateCommand: 'openspec validate --strict' }
  };
}

test('stores and reloads card priority metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-metadata-'));
  const store = new CardMetadataStore(join(root, 'card-metadata.json'));

  store.update('example-project', 'change-a', { priority: 'P2' });

  const reloaded = new CardMetadataStore(join(root, 'card-metadata.json'));
  expect(reloaded.get('example-project', 'change-a')?.priority).toBe('P2');
});

test('stores and reloads runtime state metadata', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-metadata-'));
  const store = new CardMetadataStore(join(root, 'card-metadata.json'));

  store.update('example-project', 'change-a', { runtimeState: 'ready_to_merge', reason: 'validation passed' });

  const reloaded = new CardMetadataStore(join(root, 'card-metadata.json'));
  expect(reloaded.get('example-project', 'change-a')?.runtimeState).toBe('ready_to_merge');
  expect(reloaded.get('example-project', 'change-a')?.reason).toBe('validation passed');
});

test('rejects invalid priority values', () => {
  expect(isPriority('P0')).toBe(true);
  expect(isPriority('P5')).toBe(true);
  expect(isPriority('P9')).toBe(false);
});

test('commit project metadata blocks when main checkout is dirty before writing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-metadata-'));
  const store = new CardMetadataStore(join(root, 'card-metadata.json'));
  store.update('example-project', 'change-a', { priority: 'P2' });

  await expect(commitProjectMetadata({
    project: projectAt('/repo/main'),
    store,
    execFile: async (_file, args) => {
      if (args.includes('status')) return { stdout: ' M src/game.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    writeFile: () => {
      throw new Error('should not write when main is dirty');
    }
  })).rejects.toThrow(/main checkout is not clean/);
});

test('commit project metadata writes a scoped metadata file and commits once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-metadata-'));
  const store = new CardMetadataStore(join(root, 'card-metadata.json'));
  store.update('example-project', 'change-a', { priority: 'P2' });
  store.update('example-project', 'change-a', { runtimeState: 'ready_to_merge', reason: 'verification passed' });
  const calls: string[][] = [];
  const writes: Array<{ path: string; content: string }> = [];

  const result = await commitProjectMetadata({
    project: projectAt('/repo/main'),
    store,
    execFile: async (file, args) => {
      calls.push([file, ...args]);
      if (args.includes('--') && args.includes('openspec/workbench/card-metadata.json')) {
        return { stdout: 'M  openspec/workbench/card-metadata.json\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    mkdir: () => undefined,
    writeFile: (path, content) => writes.push({ path, content })
  });

  expect(result.path).toBe('/repo/main/openspec/workbench/card-metadata.json');
  expect(writes[0]?.content).toContain('"priority": "P2"');
  expect(writes[0]?.content).not.toContain('runtimeState');
  expect(writes[0]?.content).not.toContain('verification passed');
  expect(calls).toContainEqual(['git', '-C', '/repo/main', 'add', 'openspec/workbench/card-metadata.json']);
  expect(calls).toContainEqual(['git', '-C', '/repo/main', 'commit', '-m', 'chore: update workbench priorities']);
});
