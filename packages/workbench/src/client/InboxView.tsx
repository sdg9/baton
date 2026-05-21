import { useEffect, useMemo, useState } from 'react';

type InboxEntry = {
  source_file: string;
  section: string;
  size_class: string;
  date: string;
  slug: string;
  title: string;
  status: string;
  size: string;
  source: string;
  gating: string;
  scope: string;
  reason: string;
  notes: string;
  priority: string;
  priority_rank: number;
  line: number;
};

type InboxResponse = {
  rebuiltAt: string | null;
  total: number;
  entries: InboxEntry[];
};

type Project = { id: string; name: string };

type SortKey = 'priority_rank' | 'source_file' | 'section' | 'size_class' | 'date' | 'slug' | 'title';
type SortDir = 'asc' | 'desc';

const SIZE_OPTIONS = ['', 'XS', 'S', 'M', 'L', 'XL', 'XXL'];

interface InboxViewProps {
  projects: Project[];
  token: string;
  onSessionStart: (target: { id: string; projectId: string; title: string }) => void;
}

export function InboxView({ projects, token, onSessionStart }: InboxViewProps): React.ReactElement {
  const [projectId, setProjectId] = useState<string>(projects[0]?.id ?? '');
  const [data, setData] = useState<InboxResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [size, setSize] = useState('');
  const [sourceFile, setSourceFile] = useState('');
  const [section, setSection] = useState('');
  const [mode, setMode] = useState<'actionable' | 'all'>('actionable');
  const [priority, setPriority] = useState('');
  const [since, setSince] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sortKey, setSortKey] = useState<SortKey>('priority_rank');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [starting, setStarting] = useState<string | null>(null);

  async function startSession(entry: InboxEntry): Promise<void> {
    const key = `${entry.source_file}:${entry.line}`;
    setStarting(key);
    setError(null);
    try {
      const r = await fetch(`/api/projects/${projectId}/inbox/start`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({ source_file: entry.source_file, line: entry.line }),
      });
      if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
      const body = (await r.json()) as { draft: { changeId: string; projectId: string } };
      onSessionStart({
        id: `idea-${body.draft.changeId}`,
        projectId: body.draft.projectId,
        title: body.draft.changeId,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(null);
    }
  }

  useEffect(() => {
    if (!projectId) return;
    setLoading(true);
    setError(null);
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (size) params.set('size', size);
    if (sourceFile) params.set('source_file', sourceFile);
    if (section) params.set('section', section);
    if (since) params.set('since', since);
    if (priority) params.set('priority', priority);
    params.set('mode', mode);
    const url = `/api/projects/${projectId}/inbox${params.size ? `?${params}` : ''}`;
    fetch(url, { headers: token ? { 'x-workbench-token': token } : {} })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
        return (await r.json()) as InboxResponse;
      })
      .then((res) => setData(res))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [projectId, q, size, sourceFile, section, since, mode, priority, token]);

  const sections = useMemo(() => {
    if (!data) return [] as string[];
    return Array.from(new Set(data.entries.map((e) => e.section).filter(Boolean))).sort();
  }, [data]);

  const sorted = useMemo(() => {
    if (!data) return [] as InboxEntry[];
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...data.entries].sort((a, b) => {
      const av = a[sortKey] ?? '';
      const bv = b[sortKey] ?? '';
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [data, sortKey, sortDir]);

  const toggle = (key: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const setSort = (key: SortKey): void => {
    if (sortKey === key) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  };

  const sortIndicator = (key: SortKey): string => (sortKey !== key ? '' : sortDir === 'asc' ? ' ▲' : ' ▼');

  return (
    <section className="list-view inbox-view">
      <div className="list-view-toolbar">
        <h2>Inbox</h2>
        <span className="list-view-count">{data ? `${sorted.length}/${data.total}` : '—'}</span>
        {projects.length > 1 && (
          <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
        <input
          type="search"
          placeholder="Search title / scope / source / slug…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 280 }}
        />
        <select value={size} onChange={(e) => setSize(e.target.value)}>
          {SIZE_OPTIONS.map((s) => (
            <option key={s} value={s}>
              {s ? `Size: ${s}` : 'All sizes'}
            </option>
          ))}
        </select>
        <select value={sourceFile} onChange={(e) => setSourceFile(e.target.value)}>
          <option value="">All files</option>
          <option value="INBOX">INBOX</option>
          <option value="BACKLOG">BACKLOG</option>
        </select>
        <select value={mode} onChange={(e) => setMode(e.target.value as 'actionable' | 'all')} title="Actionable hides Abandoned, OpenSpec Change Map, and archived [x] roadmap items">
          <option value="actionable">Actionable</option>
          <option value="all">All (incl. abandoned)</option>
        </select>
        <select value={priority} onChange={(e) => setPriority(e.target.value)} title="Filter by **Priority:** marker in source MD">
          <option value="">Any priority</option>
          <option value="prioritized">Has priority set</option>
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
          <option value="P3">P3</option>
        </select>
        <select value={section} onChange={(e) => setSection(e.target.value)}>
          <option value="">Any section</option>
          {sections.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={since}
          onChange={(e) => setSince(e.target.value)}
          title="Show entries dated on or after this date"
        />
        {data?.rebuiltAt && <span className="inbox-cache-stamp">cache: {new Date(data.rebuiltAt).toLocaleString()}</span>}
      </div>

      {error && <p className="inbox-error">Failed to load: {error}</p>}
      {loading && !data && <p>Loading…</p>}

      {data && sorted.length === 0 && <p>No entries match.</p>}

      {data && sorted.length > 0 && (
        <table className="archived-table inbox-table">
          <thead>
            <tr>
              <th onClick={() => setSort('priority_rank')} role="button">Priority{sortIndicator('priority_rank')}</th>
              <th onClick={() => setSort('source_file')} role="button">File{sortIndicator('source_file')}</th>
              <th onClick={() => setSort('section')} role="button">Section{sortIndicator('section')}</th>
              <th onClick={() => setSort('size_class')} role="button">Size{sortIndicator('size_class')}</th>
              <th onClick={() => setSort('date')} role="button">Date{sortIndicator('date')}</th>
              <th onClick={() => setSort('slug')} role="button">Slug{sortIndicator('slug')}</th>
              <th onClick={() => setSort('title')} role="button">Title{sortIndicator('title')}</th>
              <th aria-label="Actions" />
            </tr>
          </thead>
          <tbody>
            {sorted.map((e) => {
              const key = `${e.source_file}:${e.line}`;
              const isOpen = expanded.has(key);
              return (
                <>
                  <tr key={key} onClick={() => toggle(key)} className={isOpen ? 'inbox-row-open' : undefined}>
                    <td>{e.priority ? <span className={`inbox-priority inbox-priority-${(e.priority.match(/P[0-3]/) ?? [''])[0].toLowerCase()}`}>{e.priority}</span> : ''}</td>
                    <td>{e.source_file}</td>
                    <td>{e.section}</td>
                    <td>{e.size_class || (e.size ? '?' : '')}</td>
                    <td>{e.date}</td>
                    <td>{e.slug}</td>
                    <td>{e.title}</td>
                    <td className="inbox-row-action" onClick={(ev) => ev.stopPropagation()}>
                      <button
                        className="inbox-start-btn"
                        disabled={starting === key}
                        title="Spawn a tmux session to draft this as an OpenSpec change"
                        onClick={() => startSession(e)}
                      >
                        {starting === key ? '…' : 'Start'}
                      </button>
                    </td>
                  </tr>
                  {isOpen && (
                    <tr key={`${key}:detail`} className="inbox-detail-row">
                      <td colSpan={8}>
                        <dl className="inbox-detail">
                          {e.source && <><dt>Source</dt><dd>{e.source}</dd></>}
                          {e.scope && <><dt>Scope</dt><dd>{e.scope}</dd></>}
                          {e.gating && <><dt>Gating</dt><dd>{e.gating}</dd></>}
                          {e.size && <><dt>Size</dt><dd>{e.size}</dd></>}
                          {e.reason && <><dt>Reason</dt><dd>{e.reason}</dd></>}
                          {e.notes && <><dt>Notes</dt><dd>{e.notes}</dd></>}
                          <dt>Origin</dt>
                          <dd>{e.source_file}.md:{e.line}</dd>
                        </dl>
                      </td>
                    </tr>
                  )}
                </>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
