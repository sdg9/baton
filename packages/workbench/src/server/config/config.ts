import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';

const agentProfileSchema = z.object({
  label: z.string(),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  allowed: z.boolean()
});

const agentConfigSchema = z.object({
  agents: z.record(z.string(), agentProfileSchema),
  session: z.object({
    backend: z.literal('tmux'),
    namePrefix: z.string().min(1),
    defaultShell: z.string().min(1),
    idleNotificationSeconds: z.number().int().positive()
  }),
  security: z.object({
    bindHost: z.string(),
    requireAuth: z.boolean(),
    trustedProxy: z.string(),
    auditLog: z.boolean()
  })
});

const projectConfigSchema = z.object({
  projects: z.array(z.object({
    id: z.string().min(1),
    name: z.string().min(1),
    path: z.string().startsWith('/'),
    adapter: z.literal('openspec'),
    defaultAgent: z.string().min(1),
    allowedAgents: z.array(z.string()).min(1),
    openspec: z.object({
      listCommand: z.string().min(1),
      validateCommand: z.string().min(1)
    })
  }))
});

export type AgentConfig = z.infer<typeof agentConfigSchema>;
export type AgentProfile = AgentConfig['agents'][string];
export type ProjectConfigFile = z.infer<typeof projectConfigSchema>;
export type ProjectConfig = ProjectConfigFile['projects'][number];

export interface WorkbenchConfig {
  agents: AgentConfig;
  projects: ProjectConfigFile;
  security: AgentConfig['security'] & { localToken: string };
}

export interface LoadWorkbenchConfigResult {
  config: WorkbenchConfig;
  defaultedFiles: { agents: boolean; projects: boolean };
  cwdAutoRegisteredAsProject: boolean;
}

export function buildDefaultAgentConfig(): AgentConfig {
  return {
    agents: {
      claude: { label: 'Claude Code', command: 'claude', args: [], allowed: true }
    },
    session: {
      backend: 'tmux',
      namePrefix: 'baton-workbench',
      defaultShell: process.env.SHELL && process.env.SHELL.length > 0 ? process.env.SHELL : '/bin/bash',
      idleNotificationSeconds: 30
    },
    security: {
      bindHost: '127.0.0.1',
      requireAuth: true,
      trustedProxy: 'cloudflare-access',
      auditLog: true
    }
  };
}

function isOpenspecDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

export function buildDefaultProjectConfig(cwd: string): ProjectConfigFile {
  if (!isOpenspecDir(join(cwd, 'openspec'))) return { projects: [] };
  const name = basename(cwd) || 'project';
  return {
    projects: [{
      id: name,
      name,
      path: cwd,
      adapter: 'openspec',
      defaultAgent: 'claude',
      allowedAgents: ['claude'],
      openspec: {
        listCommand: 'openspec list --json',
        validateCommand: 'openspec validate --strict'
      }
    }]
  };
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadWorkbenchConfig(root = process.cwd()): LoadWorkbenchConfigResult {
  const agentsPath = join(root, 'config', 'agents.json');
  const projectsPath = join(root, 'config', 'projects.json');

  const agentsExists = existsSync(agentsPath);
  const projectsExists = existsSync(projectsPath);

  const agents = agentsExists
    ? agentConfigSchema.parse(readJson(agentsPath))
    : buildDefaultAgentConfig();
  const projects = projectsExists
    ? projectConfigSchema.parse(readJson(projectsPath))
    : buildDefaultProjectConfig(root);

  if (agents.security.bindHost !== '127.0.0.1' && agents.security.bindHost !== 'localhost') {
    throw new Error(`security.bindHost must be loopback-only, received ${agents.security.bindHost}`);
  }

  return {
    config: {
      agents,
      projects,
      security: {
        ...agents.security,
        localToken: process.env.AGENT_WORKBENCH_TOKEN ?? 'local-dev-token'
      }
    },
    defaultedFiles: {
      agents: !agentsExists,
      projects: !projectsExists
    },
    cwdAutoRegisteredAsProject: !projectsExists && projects.projects.length > 0
  };
}

export function getProject(config: WorkbenchConfig, projectId: string): ProjectConfig {
  const project = config.projects.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Project ${projectId} is not configured`);
  }
  return project;
}
