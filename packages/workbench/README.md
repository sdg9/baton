# @baton-tools/workbench

Local-first Kanban board for launching and monitoring Claude Code terminal sessions against your local projects.

Part of the [Baton](https://github.com/sdg9/baton) monorepo. Pairs naturally with [`@baton-tools/harness`](../harness) — projects with a `harness.config.ts` get harness-driven actions on the board (approve, status, holdout-check, verify), but the workbench works against any project with OpenSpec changes (and is adapter-shaped to support other source-of-truth backends in the future).

## What it is

- **Browser UI** that shows project cards in Kanban columns (active / attention / ready-to-merge / done).
- **Card source adapters** — the first is OpenSpec (reads `openspec list --json`). Future adapters can read GitHub issues, Linear, plain markdown.
- **Per-card sessions** — moving a card to an active column can create or attach a terminal session.
- **Durable terminals** — sessions run locally through a PTY, attached to `tmux` for survival across browser/tab restarts.
- **Local-first** — the server binds to `127.0.0.1` by default; nothing leaves the host unless you put it behind your own Cloudflare Tunnel + Access.

## Intended Runtime

```text
Browser UI
  <-> local HTTP/WebSocket server on 127.0.0.1
  <-> PTY/tmux session manager
  <-> claude / shell
  <-> allowlisted project workspaces
```

Cloudflare Tunnel can expose the local server with Cloudflare Access restricted to a single email if you want remote access.

## Getting started

```bash
# In the monorepo
pnpm install
pnpm --filter @baton-tools/workbench dev      # vite dev server (browser UI)
pnpm --filter @baton-tools/workbench server   # backend (PTY/tmux/HTTP)
pnpm --filter @baton-tools/workbench test
```

Configuration lives in `config/`:
- `config/agents.example.json` — copy to `config/agents.json` and edit to set bind host, allowed agent commands, tmux session prefix, idle-notification timeout.
- `config/projects.example.json` — copy to `config/projects.json` and edit to allowlist your project paths, set per-project default agent, and choose the adapter.

## Local Auth and Remote Access

The server binds to `127.0.0.1` (configurable in `config/agents.json`). Terminal/session APIs require either:

- `Authorization: Bearer local-dev-token` for local development, OR
- `Cf-Access-Authenticated-User-Email` when the app is placed behind Cloudflare Tunnel + Cloudflare Access.

Do not bind the server to `0.0.0.0` for normal use. Browser terminal control is local shell access and must remain behind loopback plus an authenticated tunnel.

## License

MIT
