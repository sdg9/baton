import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import ReactMarkdown from 'react-markdown';
import rehypeHighlight from 'rehype-highlight';
import rehypeSlug from 'rehype-slug';
import remarkGfm from 'remark-gfm';
import 'highlight.js/styles/github-dark.css';
import { getInitialLocalToken, getStoredTerminalToken, LOCAL_TOKEN_STORAGE_KEY } from './auth-token';
import { openDocPanelTarget, type DocPanelTarget } from './doc-panel';

type TocItem = { id: string; depth: number; text: string; varName: string };

const DOC_REHYPE_PLUGINS = [rehypeSlug, rehypeHighlight];
const DOC_REMARK_PLUGINS = [remarkGfm];

function DocViewer({ docs, activePath, onPathChange, emptyMessage }: {
  docs: CardDoc[];
  activePath: string;
  onPathChange: (path: string) => void;
  emptyMessage: string;
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const activeDoc = docs.find((doc) => doc.path === activePath);

  useEffect(() => {
    const root = contentRef.current;
    if (!root) {
      setToc([]);
      return;
    }
    const rafId = requestAnimationFrame(() => {
      const headings = Array.from(root.querySelectorAll<HTMLElement>('h1, h2, h3')).filter((heading) => heading.id);
      const items: TocItem[] = headings.map((heading, index) => ({
        id: heading.id,
        depth: Number(heading.tagName.slice(1)),
        text: heading.textContent ?? '',
        varName: `--doc-h-${index}`
      }));
      for (const item of items) {
        const el = root.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`);
        if (el) el.style.setProperty('view-timeline-name', item.varName);
      }
      setToc(items);
    });
    return () => cancelAnimationFrame(rafId);
  }, [activeDoc?.path, activeDoc?.content]);

  const scopeStyle = toc.length ? { ['timelineScope' as any]: toc.map((item) => item.varName).join(', ') } : undefined;

  return (
    <>
      <div className="doc-tabs">
        {docs.map((doc) => (
          <button className={doc.path === activePath ? 'doc-tab active' : 'doc-tab'} key={doc.path} onClick={() => onPathChange(doc.path)}>
            {doc.label}
          </button>
        ))}
      </div>
      <div className="doc-viewer" style={scopeStyle}>
        {toc.length > 1 && (
          <nav className="doc-toc" aria-label="Table of contents">
            {toc.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className={`doc-toc-link depth-${item.depth}`}
                style={{ ['--target' as any]: item.varName }}
                onClick={(event) => {
                  event.preventDefault();
                  contentRef.current?.querySelector<HTMLElement>(`#${CSS.escape(item.id)}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                }}
              >
                {item.text}
              </a>
            ))}
          </nav>
        )}
        <div className="doc-content" ref={contentRef}>
          {activeDoc ? (
            <ReactMarkdown remarkPlugins={DOC_REMARK_PLUGINS} rehypePlugins={DOC_REHYPE_PLUGINS}>
              {activeDoc.content}
            </ReactMarkdown>
          ) : (
            <p>{emptyMessage}</p>
          )}
        </div>
      </div>
    </>
  );
}

type BoardColumn = {
  id: string;
  title: string;
  cards: BoardCard[];
};

type BoardCard = {
  id: string;
  projectId: string;
  projectName: string;
  title: string;
  status: string;
  completedTasks: number;
  totalTasks: number;
  column: string;
  allowedAgents: string[];
  defaultAgent: string;
  metadata: { priority?: Priority; runtimeState?: RuntimeState; reason?: string; updatedAt: string };
  session?: { sessionId: string; status: string; profileId: string };
  worktree?: { path: string; branch?: string; dirty: boolean; ahead: number };
};

type Priority = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'P5';
type PriorityFilter = 'all' | Priority | 'none';
type SortMode = 'priority' | 'recent' | 'name';
type RuntimeState = 'active' | 'needs_attention' | 'ready_to_merge';

type TerminalTarget = {
  id: string;
  projectId: string;
  title: string;
};

type TmuxSession = {
  projectId: string;
  cardId: string;
  title: string;
  sessionId: string;
  tmuxSessionName: string;
  profileId: string;
  status: string;
  updatedAt: string;
};

type ViewMode = 'board' | 'tmux' | 'completed' | 'worktrees';

type ArchivedChange = {
  projectId: string;
  projectName: string;
  id: string;
  archivedAt?: string;
};

type WorktreeSummary = {
  projectId: string;
  projectName: string;
  path: string;
  branch?: string;
  isMain: boolean;
  dirty: boolean;
  ahead: number;
  behind: number;
  changeId?: string;
  mappingSource?: 'recorded' | 'inferred';
  specState: 'active' | 'archived' | 'unmapped';
  removable: boolean;
};
type TmuxLayout = 1 | 2 | 4;

type CardDoc = {
  path: string;
  label: string;
  content: string;
};

type IdeaDraft = {
  projectId: string;
  changeId: string;
  branchName: string;
  worktreePath: string;
  profileId: string;
  sessionCardId?: string;
};

function App() {
  const [columns, setColumns] = useState<BoardColumn[]>([]);
  const [activeCard, setActiveCard] = useState<TerminalTarget | null>(null);
  const [profileId, setProfileId] = useState('codex');
  const [cardAgentOverrides, setCardAgentOverrides] = useState<Record<string, string>>({});
  const [diagnostics, setDiagnostics] = useState<Array<{ name: string; ok: boolean; detail: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [localToken, setLocalToken] = useState(() => getInitialLocalToken(localStorage.getItem(LOCAL_TOKEN_STORAGE_KEY)));
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const stored = localStorage.getItem('theme');
    if (stored === 'light' || stored === 'dark') return stored;
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('theme', theme);
  }, [theme]);
  const [docPanelTarget, setDocPanelTarget] = useState<DocPanelTarget | null>(null);
  const [priorityFilter, setPriorityFilter] = useState<PriorityFilter>('all');
  const [sortMode, setSortMode] = useState<SortMode>('priority');
  const [priorityDirtyProjects, setPriorityDirtyProjects] = useState<Set<string>>(() => new Set());
  const [ideaPrompt, setIdeaPrompt] = useState('');
  const [isIdeaModalOpen, setIsIdeaModalOpen] = useState(false);
  const [drafts, setDrafts] = useState<IdeaDraft[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('board');
  const [tmuxSessions, setTmuxSessions] = useState<TmuxSession[]>([]);
  const [tmuxLayout, setTmuxLayout] = useState<TmuxLayout>(1);
  const [tmuxPage, setTmuxPage] = useState(0);
  const [archivedChanges, setArchivedChanges] = useState<ArchivedChange[]>([]);
  const [worktrees, setWorktrees] = useState<WorktreeSummary[]>([]);

  async function loadBoard() {
    const [boardResponse, diagnosticsResponse] = await Promise.all([
      fetch('/api/board'),
      fetch('/api/diagnostics')
    ]);
    const board = await boardResponse.json();
    const diagnosticBody = await diagnosticsResponse.json();
    setColumns(board.columns);
    setDiagnostics(diagnosticBody.diagnostics);
  }

  async function loadTmuxSessions() {
    const response = await fetch('/api/sessions', {
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {}
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to load tmux sessions');
      return;
    }
    setTmuxSessions(body.sessions);
    setTmuxPage((current) => Math.min(current, Math.max(0, Math.ceil(body.sessions.length / tmuxLayout) - 1)));
  }

  useEffect(() => {
    loadBoard().catch((err) => setError(String(err)));
    const interval = window.setInterval(() => {
      loadBoard().catch((err) => setError(String(err)));
    }, 60_000);
    return () => window.clearInterval(interval);
  }, []);

  useEffect(() => {
    if (viewMode !== 'tmux') return;
    loadTmuxSessions().catch((err) => setError(String(err)));
  }, [viewMode, tmuxLayout]);

  async function loadArchivedChanges() {
    const response = await fetch('/api/archived-changes', {
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {}
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to load archived changes');
      return;
    }
    setArchivedChanges(body.changes);
  }

  async function loadWorktrees() {
    const response = await fetch('/api/worktrees', {
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {}
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to load worktrees');
      return;
    }
    setWorktrees(body.worktrees);
  }

  async function removeWorktree(worktree: WorktreeSummary) {
    if (!window.confirm(`Remove worktree at ${worktree.path}?`)) return;
    setError(null);
    const response = await fetch('/api/worktrees', {
      method: 'DELETE',
      headers: {
        'content-type': 'application/json',
        ...(localToken ? { authorization: `Bearer ${localToken}` } : {})
      },
      body: JSON.stringify({ projectId: worktree.projectId, worktreePath: worktree.path })
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to remove worktree');
      return;
    }
    await loadWorktrees();
  }

  useEffect(() => {
    if (viewMode !== 'completed') return;
    loadArchivedChanges().catch((err) => setError(String(err)));
  }, [viewMode]);

  useEffect(() => {
    if (viewMode !== 'worktrees') return;
    loadWorktrees().catch((err) => setError(String(err)));
  }, [viewMode]);

  async function startSession(card: BoardCard) {
    setError(null);
    const response = await fetch('/api/sessions/start', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(localToken ? { authorization: `Bearer ${localToken}` } : {})
      },
      body: JSON.stringify({ projectId: card.projectId, cardId: card.id, profileId: cardAgentOverrides[card.id] ?? card.defaultAgent })
    });
    if (!response.ok) {
      const body = await response.json();
      setError(body.error ?? 'Failed to start session');
      return;
    }
    await loadBoard();
    setActiveCard({ id: card.id, projectId: card.projectId, title: card.title });
  }

  function openDetails(card: BoardCard) {
    setDocPanelTarget((current) => openDocPanelTarget(current, { type: 'card', projectId: card.projectId, cardId: card.id }));
  }

  async function createDraftIdea() {
    setError(null);
    const projectId = columns.flatMap((column) => column.cards)[0]?.projectId ?? '';
    if (!projectId) {
      setError('No project available — configure at least one project in projects.json before drafting ideas.');
      return;
    }
    const response = await fetch('/api/ideas/drafts', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(localToken ? { authorization: `Bearer ${localToken}` } : {})
      },
      body: JSON.stringify({ projectId, prompt: ideaPrompt, profileId })
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to create draft');
      return;
    }
    setDrafts((current) => [body.draft, ...current.filter((draft) => draft.changeId !== body.draft.changeId)]);
    setIdeaPrompt('');
    setIsIdeaModalOpen(false);
    setActiveCard({ id: `idea-${body.draft.changeId}`, projectId: body.draft.projectId, title: body.draft.changeId });
  }

  async function commitAndMergeDraft(draft: IdeaDraft) {
    setError(null);
    const response = await fetch(`/api/ideas/drafts/${encodeURIComponent(draft.projectId)}/${encodeURIComponent(draft.changeId)}/commit-merge`, {
      method: 'POST',
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {}
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to commit and merge draft');
      return;
    }
    setDrafts((current) => current.filter((candidate) => candidate.changeId !== draft.changeId));
    await loadBoard();
  }

  async function updatePriority(card: BoardCard, priority: Priority | null) {
    setError(null);
    const response = await fetch(`/api/projects/${encodeURIComponent(card.projectId)}/cards/${encodeURIComponent(card.id)}/metadata`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(localToken ? { authorization: `Bearer ${localToken}` } : {})
      },
      body: JSON.stringify({ priority })
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to update priority');
      return;
    }
    await loadBoard();
    setPriorityDirtyProjects((current) => new Set(current).add(card.projectId));
  }

  async function updateRuntimeState(card: BoardCard, state: RuntimeState) {
    setError(null);
    const response = await fetch(`/api/projects/${encodeURIComponent(card.projectId)}/cards/${encodeURIComponent(card.id)}/runtime-state`, {
      method: 'PATCH',
      headers: {
        'content-type': 'application/json',
        ...(localToken ? { authorization: `Bearer ${localToken}` } : {})
      },
      body: JSON.stringify({ state })
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to update runtime state');
      return;
    }
    await loadBoard();
  }

  async function savePriorities(projectId: string) {
    setError(null);
    const response = await fetch(`/api/projects/${encodeURIComponent(projectId)}/metadata/commit`, {
      method: 'POST',
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {}
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to save priorities');
      return;
    }
    setPriorityDirtyProjects((current) => {
      const next = new Set(current);
      next.delete(projectId);
      return next;
    });
  }

  async function copyTmuxAttach(card: BoardCard) {
    if (!card.session?.sessionId) return;
    await navigator.clipboard.writeText(`tmux attach -t ${card.session.sessionId}`);
  }

  async function startMultiMergePlan() {
    setError(null);
    const response = await fetch('/api/merge-plans', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(localToken ? { authorization: `Bearer ${localToken}` } : {})
      },
      body: JSON.stringify({ projectId, profileId })
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to start multi-merge plan');
      return;
    }
    setActiveCard({ id: 'multi-merge-plan', projectId, title: 'Plan Multi-Merge' });
  }

  async function closeTmuxSession(target: TerminalTarget) {
    if (!window.confirm(`Kill tmux session for ${target.title}? This will terminate the running process.`)) return;
    setError(null);
    const response = await fetch(`/api/sessions/${encodeURIComponent(target.projectId)}/${encodeURIComponent(target.id)}`, {
      method: 'DELETE',
      headers: localToken ? { authorization: `Bearer ${localToken}` } : {}
    });
    const body = await response.json();
    if (!response.ok) {
      setError(body.error ?? 'Failed to close tmux session');
      return;
    }
    setActiveCard((current) => current?.projectId === target.projectId && current.id === target.id ? null : current);
    await Promise.all([
      loadTmuxSessions(),
      loadBoard()
    ]);
  }

  const visibleColumns = columns.map((column) => ({
    ...column,
    cards: sortCards(column.cards.filter((card) => {
      if (priorityFilter === 'all') return true;
      if (priorityFilter === 'none') return !card.metadata.priority;
      return card.metadata.priority === priorityFilter;
    }), sortMode)
  }));
  const projectId = columns.flatMap((column) => column.cards)[0]?.projectId ?? '';
  const addCardAgents = columns.flatMap((column) => column.cards)[0]?.allowedAgents ?? ['claude', 'codex'];
  const visibleTmuxSessions = tmuxSessions.slice(tmuxPage * tmuxLayout, tmuxPage * tmuxLayout + tmuxLayout);
  const maxTmuxPage = Math.max(0, Math.ceil(tmuxSessions.length / tmuxLayout) - 1);
  const docPanelCard = docPanelTarget?.type === 'card'
    ? columns.flatMap((column) => column.cards).find((card) => card.projectId === docPanelTarget.projectId && card.id === docPanelTarget.cardId) ?? null
    : null;
  const docPanelArchivedChange = docPanelTarget?.type === 'archived'
    ? archivedChanges.find((change) => change.projectId === docPanelTarget.projectId && change.id === docPanelTarget.changeId) ?? null
    : null;
  const docPanelDraft = docPanelTarget?.type === 'draft'
    ? drafts.find((draft) => draft.projectId === docPanelTarget.projectId && draft.changeId === docPanelTarget.changeId) ?? null
    : null;

  return (
    <main>
      <header className="topbar">
        <div>
          <h1>Baton Workbench</h1>
          <p>OpenSpec Kanban for local Claude/Codex tmux sessions</p>
        </div>
        <div className="status-strip">
          {diagnostics.map((item) => (
            <span className={item.ok ? 'status-ok' : 'status-warn'} key={item.name} title={item.detail}>
              {item.name}
            </span>
          ))}
        </div>
        <button
          type="button"
          className="theme-toggle"
          onClick={() => setTheme((t) => (t === 'dark' ? 'light' : 'dark'))}
          title={theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
          aria-label="Toggle color theme"
        >
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
        <label className="token-field">
          <span>Local token</span>
          <input
            type="password"
            value={localToken}
            placeholder="local-dev-token"
            onChange={(event) => {
              setLocalToken(event.target.value);
              localStorage.setItem(LOCAL_TOKEN_STORAGE_KEY, event.target.value);
            }}
          />
        </label>
      </header>

      {error && <div className="error">{error}</div>}

      <nav className="view-tabs">
        <button className={viewMode === 'board' ? 'active' : ''} onClick={() => setViewMode('board')}>Board</button>
        <button className={viewMode === 'tmux' ? 'active' : ''} onClick={() => setViewMode('tmux')}>Tmux</button>
        <button className={viewMode === 'completed' ? 'active' : ''} onClick={() => setViewMode('completed')}>Completed</button>
        <button className={viewMode === 'worktrees' ? 'active' : ''} onClick={() => setViewMode('worktrees')}>Worktrees</button>
      </nav>

      {viewMode === 'board' && <section className="idea-panel">
        <button onClick={() => setIsIdeaModalOpen(true)}>Add card</button>
        {drafts.length > 0 && (
          <div className="draft-list">
            {drafts.map((draft) => (
              <div className="draft-row" key={`${draft.projectId}:${draft.changeId}`}>
                <div>
                  <strong>{draft.changeId}</strong>
                  <p>{draft.branchName}</p>
                </div>
                <div className="draft-actions">
                  <button onClick={() => setActiveCard({
                    id: `idea-${draft.changeId}`,
                    projectId: draft.projectId,
                    title: draft.changeId,
                  })}>Open Terminal</button>
                  <button onClick={() => setDocPanelTarget((current) => openDocPanelTarget(current, { type: 'draft', projectId: draft.projectId, changeId: draft.changeId }))}>View Docs</button>
                  <button onClick={() => commitAndMergeDraft(draft)}>Commit and Merge</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>}

      {viewMode === 'board' && <section className="board-controls">
        <label>
          <span>Priority filter</span>
          <select value={priorityFilter} onChange={(event) => setPriorityFilter(event.target.value as PriorityFilter)}>
            <option value="all">All priorities</option>
            <option value="none">No priority</option>
            {priorityOptions.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
          </select>
        </label>
        <label>
          <span>Sort cards</span>
          <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
            <option value="priority">Priority</option>
            <option value="recent">Last modified</option>
            <option value="name">Name</option>
          </select>
        </label>
        <button disabled={!priorityDirtyProjects.has(projectId)} onClick={() => savePriorities(projectId)}>
          Save priorities
        </button>
        <button onClick={startMultiMergePlan}>Plan Multi-Merge</button>
      </section>}

      {isIdeaModalOpen && (
        <AddCardModal
          prompt={ideaPrompt}
          profileId={profileId}
          allowedAgents={addCardAgents}
          onPromptChange={setIdeaPrompt}
          onProfileChange={setProfileId}
          onClose={() => setIsIdeaModalOpen(false)}
          onSubmit={createDraftIdea}
        />
      )}

      {viewMode === 'board' && <section className="board">
        {visibleColumns.map((column) => (
          <div className="column" key={column.id}>
            <h2>{column.title}</h2>
            <div className="card-list">
              {column.cards.map((card) => (
                <article className={card.session ? `card session-${card.session.status}` : 'card'} key={`${card.projectId}:${card.id}`} onClick={() => openDetails(card)}>
                  <div className="card-title">{card.title}</div>
                  <div className="card-meta">
                    <span className={card.metadata.priority ? 'priority-badge' : 'priority-badge empty'}>{card.metadata.priority ?? 'No P'}</span>
                    {card.session && <span className={`session-badge ${card.session.status}`}>{card.session.status}</span>}
                    {card.metadata.runtimeState && <span className={`runtime-badge ${card.metadata.runtimeState}`}>{card.metadata.runtimeState.replaceAll('_', ' ')}</span>}
                    {card.worktree && <span className={card.worktree.dirty ? 'worktree-badge dirty' : 'worktree-badge clean'}>{card.worktree.dirty ? 'dirty' : 'clean'} · +{card.worktree.ahead}</span>}
                    {card.projectName} · {card.completedTasks}/{card.totalTasks} tasks · {card.status}
                  </div>
                  <div className="card-actions">
                    <select
                      value={card.metadata.priority ?? ''}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updatePriority(card, event.target.value ? event.target.value as Priority : null)}
                    >
                      <option value="">No priority</option>
                      {priorityOptions.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
                    </select>
                    <select
                      value={cardAgentOverrides[card.id] ?? card.defaultAgent}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => setCardAgentOverrides((prev) => ({ ...prev, [card.id]: event.target.value }))}
                    >
                      {card.allowedAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
                    </select>
                    <select
                      value={card.metadata.runtimeState ?? 'active'}
                      onClick={(event) => event.stopPropagation()}
                      onChange={(event) => updateRuntimeState(card, event.target.value as RuntimeState)}
                    >
                      <option value="active">Active/clear</option>
                      <option value="needs_attention">Needs attention</option>
                      <option value="ready_to_merge">Ready to merge</option>
                    </select>
                    <button onClick={(event) => { event.stopPropagation(); startSession(card); }}>
                      {card.session ? 'Attach' : card.worktree ? 'Locally in progress' : 'Start'}
                    </button>
                    {card.session && (
                      <button title="Copy tmux attach command" aria-label="Copy tmux attach command" onClick={(event) => { event.stopPropagation(); copyTmuxAttach(card); }}>
                        tmux
                      </button>
                    )}
                    {card.session && <button onClick={(event) => { event.stopPropagation(); setActiveCard(card); }}>Open Terminal</button>}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ))}
      </section>}

      {viewMode === 'tmux' && (
        <section className="tmux-page">
          <div className="tmux-toolbar">
            <div className="segmented">
              {[1, 2, 4].map((size) => (
                <button className={tmuxLayout === size ? 'active' : ''} key={size} onClick={() => { setTmuxLayout(size as TmuxLayout); setTmuxPage(0); }}>
                  {size}
                </button>
              ))}
            </div>
            <button onClick={() => setTmuxPage((page) => Math.max(0, page - 1))} disabled={tmuxPage === 0}>Back</button>
            <span>{tmuxSessions.length === 0 ? 'No sessions' : `${tmuxPage + 1}/${maxTmuxPage + 1}`}</span>
            <button onClick={() => setTmuxPage((page) => Math.min(maxTmuxPage, page + 1))} disabled={tmuxPage >= maxTmuxPage}>Forward</button>
            <button onClick={() => loadTmuxSessions()}>Refresh</button>
          </div>
          <div className={`tmux-grid layout-${tmuxLayout}`}>
            {visibleTmuxSessions.map((session) => (
              <EmbeddedTerminal
                key={`${session.projectId}:${session.cardId}`}
                target={{ id: session.cardId, projectId: session.projectId, title: session.title }}
                onCloseSession={() => closeTmuxSession({ id: session.cardId, projectId: session.projectId, title: session.title })}
              />
            ))}
          </div>
        </section>
      )}

      {viewMode === 'completed' && (
        <section className="list-view">
          <div className="list-view-toolbar">
            <h2>Archived OpenSpec changes</h2>
            <span className="list-view-count">{archivedChanges.length}</span>
            <button onClick={() => loadArchivedChanges()}>Refresh</button>
          </div>
          {archivedChanges.length === 0 ? <p>No archived changes found.</p> : (
            <table className="archived-table">
              <thead>
                <tr>
                  <th>Archived</th>
                  <th>Change</th>
                  <th>Project</th>
                </tr>
              </thead>
              <tbody>
                {archivedChanges.map((change) => (
                  <tr key={`${change.projectId}:${change.id}`} onClick={() => setDocPanelTarget((current) => openDocPanelTarget(current, { type: 'archived', projectId: change.projectId, changeId: change.id }))}>
                    <td className="archived-date">{change.archivedAt ?? '—'}</td>
                    <td className="archived-id">{change.id}</td>
                    <td>{change.projectName}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}

      {viewMode === 'worktrees' && (
        <section className="list-view">
          <div className="list-view-toolbar">
            <h2>Git worktrees</h2>
            <button onClick={() => loadWorktrees()}>Refresh</button>
          </div>
          {worktrees.length === 0 ? <p>No worktrees found.</p> : (
            <ul className="worktree-list">
              {worktrees.map((worktree) => (
                <li key={`${worktree.projectId}:${worktree.path}`} className={`worktree-row state-${worktree.specState}${worktree.isMain ? ' main' : ''}`}>
                  <div>
                    <strong>{worktree.branch ?? '(detached)'}</strong>
                    <p>{worktree.path}</p>
                    <p className="worktree-meta">
                      {worktree.projectName}
                      {worktree.isMain && ' · main checkout'}
                      {worktree.changeId && ` · spec: ${worktree.changeId} (${worktree.mappingSource})`}
                      {' · '}{worktree.specState}
                      {worktree.dirty && ' · dirty'}
                      {!worktree.isMain && ` · +${worktree.ahead}/-${worktree.behind} vs main`}
                    </p>
                  </div>
                  <div className="worktree-actions">
                    {!worktree.isMain && (
                      <button
                        disabled={!worktree.removable}
                        title={
                          worktree.removable
                            ? 'Safe to remove: spec archived, worktree clean, no commits ahead of main'
                            : worktree.specState !== 'archived'
                              ? 'Spec is not archived yet'
                              : worktree.dirty
                                ? 'Worktree has uncommitted changes'
                                : worktree.ahead > 0
                                  ? `${worktree.ahead} commit(s) ahead of main`
                                  : 'Not removable'
                        }
                        onClick={() => removeWorktree(worktree)}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {docPanelCard && (
        <CardDetailPanel card={docPanelCard} token={localToken} onPriorityChange={updatePriority} onRuntimeStateChange={updateRuntimeState} onClose={() => setDocPanelTarget(null)} />
      )}

      {docPanelArchivedChange && (
        <ArchivedDetailPanel change={docPanelArchivedChange} token={localToken} onClose={() => setDocPanelTarget(null)} />
      )}

      {docPanelDraft && (
        <DraftDocPanel draft={docPanelDraft} token={localToken} onClose={() => setDocPanelTarget(null)} />
      )}

      {activeCard && (
        <TerminalPanel card={activeCard} onKillSession={() => closeTmuxSession(activeCard)} onClose={() => setActiveCard(null)} />
      )}
    </main>
  );
}

const priorityOptions: Priority[] = ['P0', 'P1', 'P2', 'P3', 'P4', 'P5'];

function priorityRank(priority?: Priority): number {
  return priority ? priorityOptions.indexOf(priority) : priorityOptions.length;
}

function sortCards(cards: BoardCard[], sortMode: SortMode): BoardCard[] {
  return [...cards].sort((a, b) => {
    if (sortMode === 'priority') {
      const rank = priorityRank(a.metadata.priority) - priorityRank(b.metadata.priority);
      if (rank !== 0) return rank;
    }
    if (sortMode === 'recent') {
      return String(b.metadata.updatedAt ?? '').localeCompare(String(a.metadata.updatedAt ?? ''));
    }
    return a.title.localeCompare(b.title);
  });
}

function AddCardModal({ prompt, profileId, allowedAgents, onPromptChange, onProfileChange, onClose, onSubmit }: {
  prompt: string;
  profileId: string;
  allowedAgents: string[];
  onPromptChange: (value: string) => void;
  onProfileChange: (value: string) => void;
  onClose: () => void;
  onSubmit: () => Promise<void>;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);

  async function submit() {
    if (!prompt.trim() || isSubmitting) return;
    setIsSubmitting(true);
    try {
      await onSubmit();
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section className="add-card-modal" role="dialog" aria-modal="true" aria-labelledby="add-card-title" onMouseDown={(event) => event.stopPropagation()}>
        <header>
          <div>
            <h2 id="add-card-title">Add card</h2>
            <p>Start a tmux-backed agent session to draft a new OpenSpec story.</p>
          </div>
          <button onClick={onClose}>Close</button>
        </header>
        <label>
          <span>Prompt</span>
          <textarea
            autoFocus
            value={prompt}
            placeholder="Describe the OpenSpec story you want the agent to draft"
            onChange={(event) => onPromptChange(event.target.value)}
          />
        </label>
        <div className="add-card-actions">
          <label>
            <span>Agent</span>
            <select value={profileId} onChange={(event) => onProfileChange(event.target.value)}>
              {allowedAgents.map((agent) => <option key={agent} value={agent}>{agent}</option>)}
            </select>
          </label>
          <button disabled={!prompt.trim() || isSubmitting} onClick={submit}>
            {isSubmitting ? 'Starting...' : 'Start draft'}
          </button>
        </div>
      </section>
    </div>
  );
}

function DraftDocPanel({ draft, token, onClose }: {
  draft: IdeaDraft;
  token: string;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<CardDoc[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setDocs([]);
    setActivePath('');
    setError(null);
    fetch(`/api/ideas/drafts/${encodeURIComponent(draft.projectId)}/${encodeURIComponent(draft.changeId)}/docs`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Failed to load draft docs');
        setDocs(body.docs);
        setActivePath(body.docs[0]?.path ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [draft.changeId, draft.projectId, token]);


  return (
    <aside className={isFullscreen ? 'detail-panel fullscreen' : 'detail-panel'}>
      <div className="detail-header">
        <div>
          <h2>{draft.changeId}</h2>
          <p>Draft OpenSpec story in {draft.branchName}</p>
        </div>
        <div className="detail-actions">
          <button onClick={() => setIsFullscreen((current) => !current)}>
            {isFullscreen ? 'Minimize' : 'Fullscreen'}
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>

      {error && <div className="detail-error">{error}</div>}

      <DocViewer docs={docs} activePath={activePath} onPathChange={setActivePath} emptyMessage={error ? 'Draft docs are not available yet.' : 'Loading docs...'} />
    </aside>
  );
}

function ArchivedDetailPanel({ change, token, onClose }: {
  change: ArchivedChange;
  token: string;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<CardDoc[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setDocs([]);
    setActivePath('');
    setError(null);
    fetch(`/api/projects/${encodeURIComponent(change.projectId)}/archived-changes/${encodeURIComponent(change.id)}/docs`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Failed to load archived docs');
        setDocs(body.docs);
        setActivePath(body.docs[0]?.path ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [change.id, change.projectId, token]);


  return (
    <aside className={isFullscreen ? 'detail-panel fullscreen' : 'detail-panel'}>
      <div className="detail-header">
        <div>
          <h2>{change.id}</h2>
          <p>{change.projectName}{change.archivedAt ? ` · archived ${change.archivedAt}` : ''}</p>
        </div>
        <div className="detail-actions">
          <button onClick={() => setIsFullscreen((current) => !current)}>
            {isFullscreen ? 'Minimize' : 'Fullscreen'}
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>

      {error && <div className="detail-error">{error}</div>}

      <DocViewer docs={docs} activePath={activePath} onPathChange={setActivePath} emptyMessage={error ? 'Archived docs are not available.' : 'Loading docs...'} />
    </aside>
  );
}

function CardDetailPanel({ card, token, onPriorityChange, onRuntimeStateChange, onClose }: {
  card: BoardCard;
  token: string;
  onPriorityChange: (card: BoardCard, priority: Priority | null) => Promise<void>;
  onRuntimeStateChange: (card: BoardCard, state: RuntimeState) => Promise<void>;
  onClose: () => void;
}) {
  const [docs, setDocs] = useState<CardDoc[]>([]);
  const [activePath, setActivePath] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    setDocs([]);
    setActivePath('');
    setError(null);
    fetch(`/api/projects/${encodeURIComponent(card.projectId)}/cards/${encodeURIComponent(card.id)}/docs`, {
      headers: token ? { authorization: `Bearer ${token}` } : {}
    })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? 'Failed to load docs');
        setDocs(body.docs);
        setActivePath(body.docs[0]?.path ?? '');
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, [card.id, card.projectId, token]);


  return (
    <aside className={isFullscreen ? 'detail-panel fullscreen' : 'detail-panel'}>
      <div className="detail-header">
        <div>
          <h2>{card.title}</h2>
          <p>{card.projectName} · {card.completedTasks}/{card.totalTasks} tasks · {card.status}</p>
          <label className="detail-priority">
            <span>Priority</span>
            <select value={card.metadata.priority ?? ''} onChange={(event) => onPriorityChange(card, event.target.value ? event.target.value as Priority : null)}>
              <option value="">No priority</option>
              {priorityOptions.map((priority) => <option key={priority} value={priority}>{priority}</option>)}
            </select>
          </label>
          <label className="detail-priority">
            <span>Runtime state</span>
            <select value={card.metadata.runtimeState ?? 'active'} onChange={(event) => onRuntimeStateChange(card, event.target.value as RuntimeState)}>
              <option value="active">Active/clear</option>
              <option value="needs_attention">Needs attention</option>
              <option value="ready_to_merge">Ready to merge</option>
            </select>
          </label>
          {card.metadata.reason && <p>{card.metadata.reason}</p>}
        </div>
        <div className="detail-actions">
          <button onClick={() => setIsFullscreen((current) => !current)}>
            {isFullscreen ? 'Minimize' : 'Fullscreen'}
          </button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>

      {error && <div className="detail-error">{error}</div>}

      <DocViewer docs={docs} activePath={activePath} onPathChange={setActivePath} emptyMessage={error ? 'Docs are not available.' : 'Loading docs...'} />
    </aside>
  );
}

function TerminalPanel({ card, onKillSession, onClose }: { card: TerminalTarget; onKillSession: () => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [sessionName, setSessionName] = useState<string | null>(null);
  const [tmuxCopied, setTmuxCopied] = useState(false);

  useEffect(() => {
    if (!ref.current) return;
    setSessionName(null);
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, Monaco, monospace', fontSize: 13, scrollback: 10_000, theme: { background: '#101418' } });
    terminalRef.current = terminal;
    const fit = new FitAddon();
    fitAddonRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(ref.current);
    fit.fit();
    const token = getStoredTerminalToken(localStorage.getItem(LOCAL_TOKEN_STORAGE_KEY));
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal?projectId=${card.projectId}&cardId=${card.id}&token=${encodeURIComponent(token)}`);
    let resizeEnabled = false;
    const sendSize = () => {
      const dims = fit.proposeDimensions();
      if (resizeEnabled && dims && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    };
    socket.onmessage = (event) => {
      const message = parseTerminalServerMessage(event.data);
      if (message.type === 'server_ready') {
        resizeEnabled = message.features.includes('resize');
        if (message.sessionName) setSessionName(message.sessionName);
        sendSize();
        return;
      }
      if (message.type === 'terminal_history') {
        terminal.write(message.data);
        return;
      }
      terminal.write(message.data);
    };
    terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
    const resize = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      socket.close();
      terminal.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
  }, [card.id, card.projectId]);

  useEffect(() => {
    const id = window.setTimeout(() => fitAddonRef.current?.fit(), 80);
    return () => window.clearTimeout(id);
  }, [isFullscreen]);

  async function copyAttach() {
    if (!sessionName) return;
    try {
      await navigator.clipboard.writeText(`tmux attach -t ${sessionName}`);
      setTmuxCopied(true);
      window.setTimeout(() => setTmuxCopied(false), 1500);
    } catch {
      // clipboard may be blocked; silently ignore
    }
  }

  return (
    <section className={isFullscreen ? 'terminal-drawer fullscreen' : 'terminal-drawer'}>
      <div className="terminal-header">
        <strong>{card.title}</strong>
        <div className="terminal-actions">
          <button onClick={() => setIsFullscreen((current) => !current)}>
            {isFullscreen ? 'Minimize' : 'Fullscreen'}
          </button>
          <button onClick={() => terminalRef.current?.scrollToBottom()}>Bottom</button>
          <button
            disabled={!sessionName}
            title={sessionName ? `Copy: tmux attach -t ${sessionName}` : 'Waiting for tmux session name…'}
            onClick={copyAttach}
          >
            {tmuxCopied ? 'Copied!' : 'tmux'}
          </button>
          <button className="danger-button" onClick={onKillSession}>Kill session</button>
          <button onClick={onClose}>Close</button>
        </div>
      </div>
      <div className="terminal" ref={ref} />
    </section>
  );
}

function EmbeddedTerminal({ target, onCloseSession }: { target: TerminalTarget; onCloseSession?: () => void }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const terminal = new Terminal({ cursorBlink: true, fontFamily: 'Menlo, Monaco, monospace', fontSize: 12, scrollback: 10_000, theme: { background: '#101418' } });
    const fit = new FitAddon();
    fitAddonRef.current = fit;
    terminal.loadAddon(fit);
    terminal.open(ref.current);
    fit.fit();
    const token = getStoredTerminalToken(localStorage.getItem(LOCAL_TOKEN_STORAGE_KEY));
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/terminal?projectId=${target.projectId}&cardId=${target.id}&token=${encodeURIComponent(token)}`);
    let resizeEnabled = false;
    const sendSize = () => {
      const dims = fit.proposeDimensions();
      if (resizeEnabled && dims && socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: 'resize', cols: dims.cols, rows: dims.rows }));
      }
    };
    socket.onmessage = (event) => {
      const message = parseTerminalServerMessage(event.data);
      if (message.type === 'server_ready') {
        resizeEnabled = message.features.includes('resize');
        sendSize();
        return;
      }
      if (message.type === 'terminal_history') {
        terminal.write(message.data);
        return;
      }
      terminal.write(message.data);
    };
    terminal.onData((data) => socket.readyState === WebSocket.OPEN && socket.send(data));
    const resize = new ResizeObserver(() => {
      fit.fit();
      sendSize();
    });
    resize.observe(ref.current);
    return () => {
      resize.disconnect();
      socket.close();
      terminal.dispose();
      fitAddonRef.current = null;
    };
  }, [target.id, target.projectId]);

  return (
    <article className="embedded-terminal">
      <header>
        <span>{target.title}</span>
        {onCloseSession && <button onClick={onCloseSession}>Close</button>}
      </header>
      <div className="embedded-terminal-surface" ref={ref} />
    </article>
  );
}


type TerminalServerMessage =
  | { type: 'data'; data: string }
  | { type: 'server_ready'; features: string[]; sessionName?: string }
  | { type: 'terminal_history'; data: string };

function parseTerminalServerMessage(data: unknown): TerminalServerMessage {
  const text = typeof data === 'string' ? data : String(data);
  try {
    const parsed = JSON.parse(text) as { type?: unknown; features?: unknown; sessionName?: unknown };
    if (parsed.type === 'server_ready' && Array.isArray(parsed.features)) {
      const sessionName = typeof parsed.sessionName === 'string' ? parsed.sessionName : undefined;
      return { type: 'server_ready', features: parsed.features.filter((feature): feature is string => typeof feature === 'string'), sessionName };
    }
    if (parsed.type === 'terminal_history' && typeof (parsed as { data?: unknown }).data === 'string') {
      return { type: 'terminal_history', data: (parsed as { data: string }).data };
    }
  } catch {
    // Terminal output is usually raw text.
  }
  return { type: 'data', data: text };
}

createRoot(document.getElementById('root')!).render(<App />);
