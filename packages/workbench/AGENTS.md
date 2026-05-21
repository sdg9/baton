# Agent Instructions

This project builds a local-first web workbench for managing Claude/Codex
terminal sessions from a Kanban board.

## Canonical Instructions

Read `CLAUDE.md` first and follow it unless a direct user instruction says
otherwise.

## Safety Rules

- Treat browser-accessible terminal control as remote shell access.
- Do not expose the server directly to the LAN or internet by default.
- Bind development servers to `127.0.0.1` unless a task explicitly requires
  another bind address.
- Keep project access allowlisted by absolute path.
- Keep runnable commands allowlisted by agent profile.
- Never log raw secrets, OAuth tokens, API keys, or Cloudflare Access headers.
- Prefer `tmux`-backed sessions for durable agent terminals.

## Common Commands

- OpenSpec dashboard: `npm run openspec:status`
- OpenSpec list: `npm run openspec:list`
- OpenSpec validation: `npm run openspec:validate`
- Starter prompt: `npm run start:prompt`

