import { resolveAgentProfile } from './profiles';
import type { AgentConfig, ProjectConfig } from '../config/config';

const agents: AgentConfig = {
  agents: {
    codex: { label: 'Codex', command: 'codex', args: [], allowed: true },
    shell: { label: 'Shell', command: 'zsh', args: [], allowed: true }
  },
  session: { backend: 'tmux', namePrefix: 'agent-workbench', defaultShell: '/bin/zsh', idleNotificationSeconds: 30 },
  security: { bindHost: '127.0.0.1', requireAuth: true, trustedProxy: 'cloudflare-access', auditLog: true }
};

const project: ProjectConfig = {
  id: 'example-project',
  name: 'Example Project',
  path: '/allowed/project',
  adapter: 'openspec',
  defaultAgent: 'codex',
  allowedAgents: ['codex'],
  openspec: { listCommand: 'openspec list --json', validateCommand: 'openspec validate --strict' }
};

test('resolves an allowed agent profile', () => {
  expect(resolveAgentProfile(agents, project, 'codex').command).toBe('codex');
});

test('rejects arbitrary commands that are not allowed by the project profile list', () => {
  expect(() => resolveAgentProfile(agents, project, 'shell')).toThrow(/not allowed/);
});
