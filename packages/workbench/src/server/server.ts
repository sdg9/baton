import express from 'express';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadWorkbenchConfig } from './config/config';
import { runDiagnostics } from './diagnostics';
import { commitAndMergeDraft, createIdeaDraft, draftGitStatus, draftWorktreePath } from './ideas/drafts';
import { buildMultiMergePrompt, planWorktreeMergeTargets } from './merge-planner';
import { readOpenSpecArchivedChangeDocs, readOpenSpecChangeDocs, readOpenSpecChangeDocsFromRoot } from './projects/docs';
import { CardMetadataStore, commitProjectMetadata, isPriority, isRuntimeState } from './projects/metadata';
import { findApprovedChanges, groupCards, mapOpenSpecChangesToCards, runOpenSpecList } from './projects/openspec';
import { findActiveWorktreeChanges, findWorktreeMetadata, listGitWorktrees, safeRemoveWorktree, summarizeProjectWorktrees } from './projects/worktrees';
import { listArchivedChanges } from './projects/archived';
import { WorktreeMappingStore } from './projects/worktree-mappings';
import { createAuthMiddleware } from './security/auth';
import { writeAuditEvent } from './security/audit';
import { resolveAgentProfile } from './sessions/profiles';
import { detectAttentionSignal, nextOutputActivity } from './sessions/attention';
import { SessionStore } from './sessions/store';
import { captureTmuxPane, createOrAttachTmuxSession, killTmuxSession } from './sessions/tmux';
import { tmuxHasSession } from './sessions/tmux';
import { buildStartPrompt } from './prompt';
import { attachTerminalWebSocket } from './terminal-ws';
import { validateChangeId } from './ideas/drafts';

const root = process.cwd();
const { config, defaultedFiles } = loadWorkbenchConfig(root);
if (defaultedFiles.agents) {
  console.log('[workbench] no config/agents.json — using built-in defaults (claude + tmux + loopback). Write config/agents.json to override.');
}
if (defaultedFiles.projects) {
  console.log('[workbench] no config/projects.json — starting with no projects. Write config/projects.json to add some.');
}
const app = express();
const server = createServer(app);
const sessionStore = new SessionStore(join(root, '.agent-workbench', 'sessions.json'));
const cardMetadataStore = new CardMetadataStore(join(root, '.agent-workbench', 'card-metadata.json'));
const worktreeMappingStore = new WorktreeMappingStore(join(root, '.agent-workbench', 'worktree-mappings.json'));
const auditPath = join(root, '.agent-workbench', 'audit.log');
const auth = createAuthMiddleware({ requireAuth: config.security.requireAuth, localToken: config.security.localToken });

app.use(express.json());
app.use((req, res, next) => {
  if (!req.path.startsWith('/api/sessions') && !req.path.startsWith('/api/terminal') && !req.path.startsWith('/api/ideas') && !req.path.startsWith('/api/merge-plans') && !req.path.startsWith('/api/worktrees') && !req.path.startsWith('/api/archived-changes') && !req.path.includes('/docs') && !req.path.includes('/metadata') && !req.path.includes('/runtime-state')) {
    next();
    return;
  }
  const result = auth({ path: req.path, headers: req.headers });
  if (!result.ok) {
    writeAuditEvent(auditPath, 'auth.failure', { path: req.path, reason: result.reason, headers: req.headers });
    res.status(result.status).json({ error: result.reason });
    return;
  }
  next();
});

app.get('/api/diagnostics', (_req, res) => {
  res.json({ diagnostics: runDiagnostics(config), security: { bindHost: config.security.bindHost, requireAuth: config.security.requireAuth } });
});

app.get('/api/sessions', async (_req, res, next) => {
  try {
    await refreshSessionHealth();
    res.json({
      sessions: sessionStore.list()
        .filter((session) => session.status === 'running' || session.status === 'attention')
        .map((session) => ({
          projectId: session.projectId,
          cardId: session.cardId,
          title: session.cardId,
          sessionId: session.sessionId,
          tmuxSessionName: session.tmuxSessionName,
          profileId: session.profileId,
          status: session.status,
          updatedAt: session.updatedAt
        }))
    });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/sessions/:projectId/:cardId', async (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    const session = sessionStore.get(project.id, req.params.cardId);
    if (!session) {
      res.status(404).json({ error: 'Session was not found' });
      return;
    }
    if (await tmuxHasSession(session.tmuxSessionName)) {
      await killTmuxSession(session.tmuxSessionName);
    }
    sessionStore.remove(project.id, req.params.cardId);
    writeAuditEvent(auditPath, 'session.closed', {
      projectId: project.id,
      cardId: req.params.cardId,
      sessionName: session.tmuxSessionName
    });
    res.json({ closed: true });
  } catch (error) {
    writeAuditEvent(auditPath, 'session.close_failed', {
      projectId: req.params.projectId,
      cardId: req.params.cardId,
      error: error instanceof Error ? error.message : String(error)
    });
    next(error);
  }
});

app.get('/api/board', async (_req, res, next) => {
  try {
    await refreshSessionHealth();
    const cards = [];
    for (const project of config.projects.projects) {
      const changes = await runOpenSpecList({ requestedProjectPath: project.path, project });
      const activeWorktrees = await findActiveWorktreeChanges(project, changes);
      const worktreeMetadata = await findWorktreeMetadata(project, changes);
      cards.push(...mapOpenSpecChangesToCards(project, changes, sessionStore.all(), cardMetadataStore.all(), findApprovedChanges(project, changes), activeWorktrees, worktreeMetadata));
    }
    res.json({ columns: groupCards(cards), cards });
  } catch (error) {
    next(error);
  }
});

app.post('/api/agent-event', (req, res, next) => {
  try {
    const { agent, event, cwd, sessionId, message } = req.body as {
      agent?: string;
      event?: string;
      cwd?: string;
      sessionId?: string;
      message?: string;
    };
    if (!agent || !event || !cwd) {
      res.status(400).json({ error: 'agent, event, and cwd are required' });
      return;
    }

    let mapping = worktreeMappingStore.get(cwd);
    if (!mapping) {
      let cur = cwd;
      while (true) {
        const parent = dirname(cur);
        if (parent === cur) break;
        cur = parent;
        const candidate = worktreeMappingStore.get(cur);
        if (candidate) { mapping = candidate; break; }
      }
    }

    if (!mapping) {
      writeAuditEvent(auditPath, 'agent.event.unmapped', { agent, event, cwd, sessionId });
      res.json({ recorded: false, reason: 'no worktree mapping for cwd' });
      return;
    }

    const candidates = sessionStore.list().filter((session) =>
      session.projectId === mapping!.projectId &&
      session.status !== 'exited' &&
      (
        session.cardId === mapping!.changeId ||
        session.cardId === `idea-${mapping!.changeId}` ||
        session.cardId.startsWith(`${mapping!.changeId}-`)
      )
    );

    const shouldMark = shouldMarkAttentionForAgentEvent(agent, event);
    const reason = describeAgentEventReason(agent, event, message);

    if (shouldMark) {
      for (const session of candidates) {
        sessionStore.markAttention(session.projectId, session.cardId, reason);
      }
    }

    writeAuditEvent(auditPath, 'agent.event', {
      agent,
      event,
      cwd,
      sessionId,
      message,
      projectId: mapping.projectId,
      changeId: mapping.changeId,
      sessionsMatched: candidates.length,
      attentionMarked: shouldMark
    });

    res.json({
      recorded: true,
      projectId: mapping.projectId,
      changeId: mapping.changeId,
      sessionsMatched: candidates.length,
      attentionMarked: shouldMark
    });
  } catch (error) {
    next(error);
  }
});

function shouldMarkAttentionForAgentEvent(agent: string, event: string): boolean {
  if (agent === 'claude') return event === 'Stop' || event === 'Notification' || event === 'SubagentStop';
  if (agent === 'codex') return event.startsWith('agent-turn-complete') || event === 'task-complete';
  return false;
}

function describeAgentEventReason(agent: string, event: string, message?: string): string {
  const trimmed = message?.trim();
  if (agent === 'claude') {
    if (event === 'Notification') return trimmed ? `Claude: ${truncateForReason(trimmed)}` : 'Claude needs input';
    if (event === 'Stop') return 'Claude session stopped';
    if (event === 'SubagentStop') return 'Claude subagent stopped';
  }
  if (agent === 'codex' && event.startsWith('agent-turn-complete')) {
    return trimmed ? `Codex done: ${truncateForReason(trimmed)}` : 'Codex turn complete';
  }
  return `${agent} ${event}`;
}

function truncateForReason(value: string): string {
  const limit = 100;
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

app.get('/api/archived-changes', (_req, res, next) => {
  try {
    const items = config.projects.projects.flatMap((project) => listArchivedChanges(project));
    res.json({ changes: items });
  } catch (error) {
    next(error);
  }
});

app.get('/api/worktrees', async (_req, res, next) => {
  try {
    const recorded = new Map(worktreeMappingStore.all().map((entry) => [entry.worktreePath.replace(/\/+$/, ''), { changeId: entry.changeId }]));
    const summaries = [];
    for (const project of config.projects.projects) {
      const changes = await runOpenSpecList({ requestedProjectPath: project.path, project });
      const activeChangeIds = new Set(changes.map((change) => change.name));
      const archivedChangeIds = new Set(listArchivedChanges(project).map((change) => change.id));
      summaries.push(...await summarizeProjectWorktrees({ project, activeChangeIds, archivedChangeIds, recordedMappings: recorded }));
    }
    res.json({ worktrees: summaries });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/worktrees', async (req, res, next) => {
  try {
    const { projectId, worktreePath } = req.body as { projectId?: string; worktreePath?: string };
    if (!projectId || !worktreePath) throw new Error('projectId and worktreePath are required');
    const project = config.projects.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} is not configured`);
    const result = await safeRemoveWorktree({ project, worktreePath });
    worktreeMappingStore.remove(result.path);
    writeAuditEvent(auditPath, 'worktree.removed', { projectId, worktreePath: result.path });
    res.json(result);
  } catch (error) {
    writeAuditEvent(auditPath, 'worktree.remove_failed', { body: req.body, error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
});

async function refreshSessionHealth(): Promise<void> {
  await Promise.all(sessionStore.list().map(async (session) => {
    if (session.status === 'exited') return;
    const exists = await tmuxHasSession(session.tmuxSessionName);
    if (!exists) {
      sessionStore.markStatus(session.projectId, session.cardId, 'exited');
      writeAuditEvent(auditPath, 'session.exited', {
        projectId: session.projectId,
        cardId: session.cardId,
        sessionName: session.tmuxSessionName
      });
      return;
    }

    const output = await captureTmuxPane(session.tmuxSessionName);
    const activity = nextOutputActivity({
      output,
      previousHash: session.lastOutputHash,
      previousLastOutputAt: session.lastOutputAt
    });
    sessionStore.recordOutputActivity(session.projectId, session.cardId, activity);
    if (session.status === 'running') {
      const signal = detectAttentionSignal(output, {
        lastOutputAt: activity.lastOutputAt,
        idleNotificationSeconds: config.agents.session.idleNotificationSeconds
      });
      if (signal) {
        sessionStore.markAttention(session.projectId, session.cardId, signal.reason);
        writeAuditEvent(auditPath, 'session.attention', {
          projectId: session.projectId,
          cardId: session.cardId,
          sessionName: session.tmuxSessionName,
          reason: signal.reason,
          kind: signal.kind
        });
      }
    }
  }));
}

app.patch('/api/projects/:projectId/cards/:cardId/metadata', (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    const { priority } = req.body as { priority?: string | null };
    if (priority !== null && priority !== undefined && !isPriority(priority)) {
      throw new Error(`Invalid priority: ${priority}`);
    }
    const metadata = cardMetadataStore.update(project.id, req.params.cardId, { priority });
    writeAuditEvent(auditPath, 'card.metadata.update', { projectId: project.id, cardId: req.params.cardId, priority });
    res.json({ metadata });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/projects/:projectId/cards/:cardId/runtime-state', (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    const { state, reason } = req.body as { state?: string | null; reason?: string | null };
    if (state !== null && state !== undefined && !isRuntimeState(state)) {
      throw new Error(`Invalid runtime state: ${state}`);
    }
    const metadata = cardMetadataStore.update(project.id, req.params.cardId, { runtimeState: state ?? null, reason });
    writeAuditEvent(auditPath, 'card.runtime_state.update', { projectId: project.id, cardId: req.params.cardId, state, reason });
    res.json({ metadata });
  } catch (error) {
    next(error);
  }
});

app.post('/api/projects/:projectId/metadata/commit', async (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    const result = await commitProjectMetadata({ project, store: cardMetadataStore });
    writeAuditEvent(auditPath, 'project.metadata.commit', { projectId: project.id, ...result });
    res.json(result);
  } catch (error) {
    writeAuditEvent(auditPath, 'project.metadata.commit_failed', { projectId: req.params.projectId, error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
});

app.get('/api/projects/:projectId/cards/:cardId/docs', (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    res.json({ docs: readOpenSpecChangeDocs(project, req.params.cardId) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/projects/:projectId/archived-changes/:changeId/docs', (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    res.json({ docs: readOpenSpecArchivedChangeDocs(project, req.params.changeId) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ideas/drafts', async (req, res, next) => {
  try {
    const { projectId, changeId, prompt, profileId } = req.body as { projectId: string; changeId?: string; prompt: string; profileId: string };
    if (!prompt?.trim()) throw new Error('Idea prompt is required');
    const project = config.projects.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} is not configured`);
    const profile = resolveAgentProfile(config.agents, project, profileId || project.defaultAgent);
    const draft = await createIdeaDraft({ root, project, changeId, prompt, profileId: profileId || project.defaultAgent });
    worktreeMappingStore.record({ projectId, changeId: draft.changeId, worktreePath: draft.worktreePath, branchName: draft.branchName });
    const ideaPrompt = [
      `You are drafting a new OpenSpec change in ${draft.worktreePath}.`,
      `Change id: ${draft.changeId}`,
      '',
      'Create proposal.md, design.md, tasks.md, and specs under:',
      `openspec/changes/${draft.changeId}/`,
      '',
      'User idea:',
      draft.prompt,
      '',
      'Stop after drafting and wait for review. Do not edit files outside this change directory.'
    ].join('\n');
    const session = await createOrAttachTmuxSession({
      namePrefix: config.agents.session.namePrefix,
      projectId,
      cardId: `idea-${draft.changeId}`,
      cwd: draft.worktreePath,
      command: profile.command,
      args: profile.args,
      initialPrompt: ideaPrompt
    });
    sessionStore.upsert({
      projectId,
      cardId: `idea-${draft.changeId}`,
      profileId: profileId || project.defaultAgent,
      sessionId: session.sessionName,
      tmuxSessionName: session.sessionName,
      status: 'running',
      updatedAt: new Date().toISOString()
    });
    writeAuditEvent(auditPath, 'idea.draft.create', { projectId, changeId, profileId: profileId || project.defaultAgent, branchName: draft.branchName, sessionName: session.sessionName });
    res.json({ draft, session });
  } catch (error) {
    writeAuditEvent(auditPath, 'idea.draft.rejected', { error: error instanceof Error ? error.message : String(error), body: req.body });
    next(error);
  }
});

app.get('/api/ideas/drafts/:projectId/:changeId/docs', (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    const worktreePath = draftWorktreePath(root, project.id, req.params.changeId);
    res.json({ docs: readOpenSpecChangeDocsFromRoot(worktreePath, req.params.changeId) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ideas/drafts/:projectId/:changeId/status', async (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    res.json(await draftGitStatus({ root, project, changeId: req.params.changeId }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/ideas/drafts/:projectId/:changeId/commit-merge', async (req, res, next) => {
  try {
    const project = config.projects.projects.find((candidate) => candidate.id === req.params.projectId);
    if (!project) throw new Error(`Project ${req.params.projectId} is not configured`);
    const result = await commitAndMergeDraft({ root, project, changeId: req.params.changeId });
    writeAuditEvent(auditPath, 'idea.draft.commit_merge', { projectId: project.id, changeId: req.params.changeId, branchName: result.branchName });
    res.json(result);
  } catch (error) {
    writeAuditEvent(auditPath, 'idea.draft.commit_merge_failed', { projectId: req.params.projectId, changeId: req.params.changeId, error: error instanceof Error ? error.message : String(error) });
    next(error);
  }
});

app.post('/api/merge-plans', async (req, res, next) => {
  try {
    const { projectId, profileId } = req.body as { projectId: string; profileId: string };
    const project = config.projects.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} is not configured`);
    const selectedProfileId = profileId || project.defaultAgent;
    const profile = resolveAgentProfile(config.agents, project, selectedProfileId);
    const changes = await runOpenSpecList({ requestedProjectPath: project.path, project });
    const mainPath = project.path.toLowerCase();
    const worktrees = (await listGitWorktrees(project)).filter((worktree) => worktree.path.toLowerCase() !== mainPath);
    const targets = planWorktreeMergeTargets(worktrees, changes);
    if (targets.length === 0) throw new Error('No matching active worktrees were found');
    const prompt = buildMultiMergePrompt({ projectName: project.name, projectPath: project.path, targets });
    const session = await createOrAttachTmuxSession({
      namePrefix: config.agents.session.namePrefix,
      projectId,
      cardId: 'multi-merge-plan',
      cwd: project.path,
      command: profile.command,
      args: profile.args,
      initialPrompt: prompt
    });
    sessionStore.upsert({
      projectId,
      cardId: 'multi-merge-plan',
      profileId: selectedProfileId,
      sessionId: session.sessionName,
      tmuxSessionName: session.sessionName,
      status: 'running',
      updatedAt: new Date().toISOString()
    });
    writeAuditEvent(auditPath, 'merge_plan.start', { projectId, profileId: selectedProfileId, sessionName: session.sessionName, targets: targets.map((target) => target.changeId) });
    res.json({ session, targets });
  } catch (error) {
    writeAuditEvent(auditPath, 'merge_plan.failed', { error: error instanceof Error ? error.message : String(error), body: req.body });
    next(error);
  }
});

app.post('/api/sessions/start', async (req, res, next) => {
  try {
    const { projectId, cardId, profileId } = req.body as { projectId: string; cardId: string; profileId: string };
    const project = config.projects.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error(`Project ${projectId} is not configured`);
    const profile = resolveAgentProfile(config.agents, project, profileId);
    const changes = await runOpenSpecList({ requestedProjectPath: project.path, project });
    const card = mapOpenSpecChangesToCards(project, changes, sessionStore.all(), cardMetadataStore.all()).find((candidate) => candidate.id === cardId);
    if (!card) throw new Error(`Card ${cardId} was not found`);
    const initialPrompt = buildStartPrompt(join(root, 'config', 'prompts', 'openspec-start-session.md'), card);
    writeAuditEvent(auditPath, 'card.activate', { projectId, cardId, profileId });
    const result = await createOrAttachTmuxSession({
      namePrefix: config.agents.session.namePrefix,
      projectId,
      cardId,
      cwd: project.path,
      command: profile.command,
      args: profile.args,
      initialPrompt
    });
    writeAuditEvent(auditPath, result.created ? 'process.spawn' : 'session.attach', { projectId, cardId, profileId, sessionName: result.sessionName });
    sessionStore.upsert({
      projectId,
      cardId,
      profileId,
      sessionId: result.sessionName,
      tmuxSessionName: result.sessionName,
      status: 'running',
      updatedAt: new Date().toISOString()
    });
    res.json(result);
  } catch (error) {
    writeAuditEvent(auditPath, 'command.rejected', { error: error instanceof Error ? error.message : String(error), body: req.body });
    next(error);
  }
});

attachTerminalWebSocket(server, {
  auditPath,
  authenticate: auth,
  getSessionName: (projectId, cardId) => sessionStore.get(projectId, cardId)?.tmuxSessionName,
  markSessionRunning: (projectId, cardId) => sessionStore.markRunning(projectId, cardId)
});

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const clientDir = join(packageRoot, 'dist', 'client');
if (existsSync(join(clientDir, 'index.html'))) {
  app.use(express.static(clientDir));
} else {
  console.warn(`[workbench] no built client at ${clientDir} — UI requests will 404. Run \`vite build\` first.`);
}
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
});

const port = Number(process.env.PORT ?? 4173);
server.listen(port, config.security.bindHost, () => {
  console.log(`Agent Workbench listening on http://${config.security.bindHost}:${port}`);
  for (const item of runDiagnostics(config)) {
    console.log(`${item.ok ? 'ok' : 'warn'} ${item.name}: ${item.detail}`);
  }
});
