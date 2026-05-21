import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkbenchConfig } from './config';

test('loads example config files when local config files are absent', () => {
  const config = loadWorkbenchConfig(process.cwd());

  expect(config.security.bindHost).toBe('127.0.0.1');
  expect(config.projects.projects[0]?.path).toBe('/path/to/your/project');
  expect(config.agents.agents.codex.command).toBe('codex');
  expect(config.agents.agents.codex.args).toEqual(['--dangerously-bypass-approvals-and-sandbox']);
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
