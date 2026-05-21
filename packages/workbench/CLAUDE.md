# Workbench — package notes for Claude

## Purpose

`@baton-tools/workbench` is a local-first web app for running one or more Claude Code terminal sessions from a Kanban board. Card source is pluggable; the first adapter reads OpenSpec changes from any allowlisted local project.

## Product Shape

- A browser UI shows project cards in Kanban columns.
- Moving a card to an active column can create or attach a terminal session.
- Terminal sessions run locally on the host machine through a PTY, preferably attached to `tmux` for durability.
- The app may be exposed through Cloudflare Tunnel, but the local server remains bound to `127.0.0.1`.
- Cloudflare Access email auth is expected at the tunnel edge.

## Architecture Principles

- Treat OpenSpec as **one adapter**, not the whole domain model. Future adapters may read GitHub issues, Linear, or local markdown tasks. Keep the card-source seam clean.
- Separate these concerns:
  - project discovery and card source adapters
  - session lifecycle and PTY/tmux control
  - terminal IO streaming
  - agent prompt construction
  - notifications
  - authentication and audit logging
- Use TypeScript for app/server code unless a future design explicitly changes the stack.
- Project paths and agent commands are always allowlisted — never accept arbitrary paths or commands from the wire.

## Security Baseline

- Browser-to-server access must be authenticated before any terminal/session API becomes available.
- All project roots must be explicitly configured.
- All agent commands must be explicitly configured.
- Server-side actions that spawn processes, send terminal input, or mutate card state must be audit logged.
- Avoid generic unrestricted shell actions in the first implementation.
- Do not store secrets in repo files. Use environment variables or OS/keychain backed storage when implementation reaches auth/token handling.

## Configuration

- `config/agents.example.json` — agent commands, tmux backend, security/bind defaults. Copy to `config/agents.json`.
- `config/projects.example.json` — allowlisted projects and per-project adapter. Copy to `config/projects.json`.

Reading cards from OpenSpec uses `openspec list --json` against each allowlisted project's path. Card columns are derived from OpenSpec status plus local session metadata; the workbench never mutates OpenSpec status directly.
