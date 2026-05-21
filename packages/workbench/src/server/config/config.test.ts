import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkbenchConfig } from './config';

test('falls back to built-in defaults when no config files are present', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-defaults-'));

  const { config, defaultedFiles } = loadWorkbenchConfig(root);

  expect(defaultedFiles).toEqual({ agents: true, projects: true });
  expect(config.security.bindHost).toBe('127.0.0.1');
  expect(config.security.requireAuth).toBe(true);
  expect(config.agents.session.backend).toBe('tmux');
  expect(config.agents.session.namePrefix).toBe('baton-workbench');
  expect(Object.keys(config.agents.agents)).toEqual(['claude']);
  expect(config.agents.agents.claude.command).toBe('claude');
  expect(config.agents.agents.claude.args).toEqual([]);
  expect(config.projects.projects).toEqual([]);
});

test('loads user-provided config when present', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-user-config-'));
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'agents.json'), JSON.stringify({
    agents: {
      claude: { label: 'Claude Code', command: 'claude', args: [], allowed: true },
      codex: { label: 'Codex', command: 'codex', args: ['--yolo'], allowed: true }
    },
    session: { backend: 'tmux', namePrefix: 'custom', defaultShell: '/bin/zsh', idleNotificationSeconds: 45 },
    security: { bindHost: '127.0.0.1', requireAuth: false, trustedProxy: 'none', auditLog: false }
  }));
  writeFileSync(join(root, 'config', 'projects.json'), JSON.stringify({ projects: [] }));

  const { config, defaultedFiles } = loadWorkbenchConfig(root);

  expect(defaultedFiles).toEqual({ agents: false, projects: false });
  expect(config.agents.session.namePrefix).toBe('custom');
  expect(config.agents.agents.codex.args).toEqual(['--yolo']);
  expect(config.security.requireAuth).toBe(false);
});

test('mixes user-provided agents config with defaulted projects', () => {
  const root = mkdtempSync(join(tmpdir(), 'workbench-mixed-'));
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'agents.json'), JSON.stringify({
    agents: {
      claude: { label: 'Claude Code', command: 'claude', args: [], allowed: true }
    },
    session: { backend: 'tmux', namePrefix: 'override', defaultShell: '/bin/zsh', idleNotificationSeconds: 30 },
    security: { bindHost: '127.0.0.1', requireAuth: true, trustedProxy: 'cloudflare-access', auditLog: true }
  }));

  const { config, defaultedFiles } = loadWorkbenchConfig(root);

  expect(defaultedFiles).toEqual({ agents: false, projects: true });
  expect(config.agents.session.namePrefix).toBe('override');
  expect(config.projects.projects).toEqual([]);
});

test('rejects non-loopback bind hosts', () => {
  const root = mkdtempSync(join(tmpdir(), 'agent-workbench-config-'));
  mkdirSync(join(root, 'config'));
  writeFileSync(join(root, 'config', 'agents.json'), JSON.stringify({
    agents: {
      codex: { label: 'Codex', command: 'codex', args: [], allowed: true }
    },
    session: { backend: 'tmux', namePrefix: 'agent-workbench', defaultShell: '/bin/zsh', idleNotificationSeconds: 30 },
    security: { bindHost: '0.0.0.0', requireAuth: true, trustedProxy: 'cloudflare-access', auditLog: true }
  }));
  writeFileSync(join(root, 'config', 'projects.json'), JSON.stringify({ projects: [] }));

  expect(() => loadWorkbenchConfig(root)).toThrow(/bindHost/);
});
