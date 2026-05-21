import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function configPath(root: string, fileName: string): string {
  const local = join(root, 'config', fileName);
  if (existsSync(local)) return local;
  return join(root, 'config', fileName.replace('.json', '.example.json'));
}

export function loadWorkbenchConfig(root = process.cwd()): WorkbenchConfig {
  const agentsPath = configPath(root, 'agents.json');
  const projectsPath = configPath(root, 'projects.json');
  const agents = agentConfigSchema.parse(readJson(agentsPath));
  const projects = projectConfigSchema.parse(readJson(projectsPath));

  if (agents.security.bindHost !== '127.0.0.1' && agents.security.bindHost !== 'localhost') {
    throw new Error(`security.bindHost must be loopback-only, received ${agents.security.bindHost}`);
  }

  return {
    agents,
    projects,
    security: {
      ...agents.security,
      localToken: process.env.AGENT_WORKBENCH_TOKEN ?? 'local-dev-token'
    }
  };
}

export function getProject(config: WorkbenchConfig, projectId: string): ProjectConfig {
  const project = config.projects.projects.find((candidate) => candidate.id === projectId);
  if (!project) {
    throw new Error(`Project ${projectId} is not configured`);
  }
  return project;
}
