import { accessSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import type { WorkbenchConfig } from './config/config';

export interface DiagnosticItem {
  name: string;
  ok: boolean;
  detail: string;
}

export function runDiagnostics(config: WorkbenchConfig): DiagnosticItem[] {
  const commandNames = new Set(['tmux', 'openspec']);
  Object.values(config.agents.agents).forEach((profile) => {
    if (profile.allowed) commandNames.add(profile.command);
  });

  const commandDiagnostics = [...commandNames].sort().map((command) => {
    try {
      const path = execFileSync('command', ['-v', command], { encoding: 'utf8', shell: '/bin/zsh' }).trim();
      return { name: `command:${command}`, ok: true, detail: path };
    } catch {
      return { name: `command:${command}`, ok: false, detail: `${command} not found on PATH` };
    }
  });

  const projectDiagnostics = config.projects.projects.map((project) => {
    try {
      accessSync(project.path);
      return { name: `project:${project.id}`, ok: true, detail: project.path };
    } catch {
      return { name: `project:${project.id}`, ok: false, detail: `${project.path} is not accessible` };
    }
  });

  return [
    { name: 'bindHost', ok: config.security.bindHost === '127.0.0.1' || config.security.bindHost === 'localhost', detail: config.security.bindHost },
    { name: 'auth', ok: config.security.requireAuth, detail: config.security.requireAuth ? 'required' : 'disabled' },
    ...commandDiagnostics,
    ...projectDiagnostics
  ];
}
