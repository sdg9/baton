## Context

The workbench should run on a trusted Mac laptop or Mac mini while allowing the
owner to access a browser UI remotely through Cloudflare Tunnel. The browser UI
is a control plane for local terminal sessions, not a hosted SaaS. The first
project adapter targets OpenSpec changes in
`/path/to/your/project`.

## Goals / Non-Goals

**Goals:**

- Render OpenSpec changes as Kanban cards for configured projects.
- Start or attach a durable Claude/Codex terminal session when a card is moved
  into active work.
- Stream terminal output to the browser and browser input back to the terminal.
- Preserve sessions across browser disconnects.
- Provide a security baseline suitable for Cloudflare Access protected remote
  use.
- Notify the owner when a session appears to need attention.

**Non-Goals:**

- Multi-user collaboration beyond a single trusted owner.
- Hosted cloud execution.
- Full project management replacement for Linear/GitHub/Jira.
- Editing arbitrary files from the browser outside terminal-driven workflows.

## Decisions

### D1: Standalone App With Project Adapters

Build this as a standalone project. Project-specific knowledge lives in adapters
and config files. The first adapter shells out to `openspec list --json` in an
allowlisted project root and maps changes to cards.

Alternative considered: embed the board in the game repo. Rejected because
terminal sessions, auth, notifications, and remote access are reusable
infrastructure.

### D2: Local Server Bound to Loopback

The app server binds to `127.0.0.1` by default. Remote access is via Cloudflare
Tunnel plus Cloudflare Access. The application still validates identity headers
or a local auth token before enabling session APIs.

Alternative considered: bind to LAN and rely on network trust. Rejected because
terminal control is equivalent to shell access.

### D3: tmux-Backed Terminal Sessions

Each card session gets a stable tmux session name derived from project and card
IDs. The browser attaches through a PTY running `tmux attach`, so closing the
browser does not kill the agent process.

Alternative considered: raw node-pty sessions only. Rejected for MVP durability;
raw PTYs can still be useful for short-lived diagnostics later.

### D4: Agent Profiles Are Command Allowlists

Claude and Codex are configured as agent profiles with command, args, allowed
project roots, and prompt template. Starting a card session uses one of these
profiles rather than accepting arbitrary command strings from the browser.

Alternative considered: freeform command input. Rejected for the first version
because it expands the remote shell attack surface.

### D5: Metadata Is Local and Append-Only Where Possible

Card/session metadata, audit events, and notification state are stored in local
app data. The workbench should not mutate OpenSpec state merely because a card
is dragged; OpenSpec remains the source for change definitions and task counts.

## Risks / Trade-offs

- Remote terminal access can run destructive commands -> require auth, command
  allowlists, project allowlists, audit logs, and loopback-only bind.
- Agent TUIs can redraw heavily and produce large output -> cap buffered output,
  support terminal resize, and persist only bounded scrollback.
- Needs-input detection can be noisy -> start with explicit process exit, idle
  timeout, and conservative text heuristics; make notifications configurable.
- Cloudflare Access headers are only trustworthy behind the tunnel -> document
  local development auth separately and do not trust headers unless configured.
- tmux availability differs by host -> add startup diagnostics that report
  missing `tmux`, `claude`, or `codex`.

## Migration Plan

1. Build the MVP against local-only access.
2. Add Cloudflare Tunnel documentation and Access header validation.
3. Add the game repo as the first configured project.
4. Iterate on notification heuristics after real terminal sessions run.

Rollback: stop the local server and kill tmux sessions with the configured
prefix. Target projects remain ordinary local repos.

## Open Questions

- Which push channel should be first: macOS notifications, Pushover, email, or
  mobile push through a service?
- Should card drag immediately start work, or should it open a confirmation
  sheet with agent/prompt settings?
- Should the first UI be full React, or a minimal server-rendered board with
  xterm panels?
