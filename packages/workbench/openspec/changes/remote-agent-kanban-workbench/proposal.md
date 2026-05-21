## Why

Managing multiple agent-driven terminal sessions from separate local terminals is
hard to monitor remotely and does not map cleanly to OpenSpec story state. A
local-first web workbench can provide a Kanban control plane while keeping code
execution on the owner's Mac.

## What Changes

- Add a standalone web workbench that can read OpenSpec changes from configured
  local projects and render them as Kanban cards.
- Add a session model that can start, attach, detach, and monitor durable
  Claude/Codex terminal sessions per card.
- Add a browser terminal surface that streams terminal input/output over an
  authenticated local server connection.
- Add initial safety boundaries for Cloudflare Tunnel use: localhost bind,
  authenticated access, project allowlists, command allowlists, and audit logs.
- Add notification hooks for sessions that need user attention.

Non-goals:

- Do not implement a general unauthenticated web shell.
- Do not replace OpenSpec, Claude Code, Codex, or project-specific harnesses.
- Do not modify target project files directly from the board except through
  explicit agent/terminal actions.
- Do not expose the server directly to the public internet.

## Capabilities

### New Capabilities

- `project-kanban`: Reading configured project work items and rendering them as
  board cards with stable columns and metadata.
- `agent-terminal-sessions`: Starting, attaching, detaching, and monitoring
  Claude/Codex terminal sessions tied to cards.
- `remote-access-security`: Restricting browser access, project roots, commands,
  and terminal actions for a local server exposed through an authenticated
  tunnel.
- `attention-notifications`: Detecting when an agent terminal needs human input
  and sending an external notification.

### Modified Capabilities

<!-- None. This is a new project. -->

## Impact

- New TypeScript application code for a local server, browser UI, adapters, and
  session manager.
- Expected dependencies include a web framework, WebSocket support, xterm.js,
  node-pty or an equivalent PTY bridge, and tmux on macOS.
- Operational integration with Cloudflare Tunnel and Cloudflare Access is
  configuration-only for the MVP.
