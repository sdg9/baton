## 1. Project Foundation

- [x] 1.1 Choose and install the TypeScript app stack for local server and browser UI.
- [x] 1.2 Add configuration loading for `config/agents.json` and `config/projects.json` with example files as templates.
- [x] 1.3 Add startup diagnostics for `tmux`, configured agent commands, and configured project paths.
- [x] 1.4 Add a local development auth mode and document the Cloudflare Access production assumption.

## 2. OpenSpec Kanban Adapter

- [x] 2.1 Implement the project registry and OpenSpec adapter that runs `openspec list --json` in an allowlisted project root.
- [x] 2.2 Map OpenSpec changes plus local session metadata into board columns.
- [x] 2.3 Render a minimal Kanban board for the configured game repo.
- [x] 2.4 Add tests for project allowlist rejection and OpenSpec status mapping.

## 3. Terminal Session Manager

- [x] 3.1 Implement agent profile allowlist resolution for `claude` and `codex`.
- [x] 3.2 Implement tmux session naming, create, attach, detach, and status checks.
- [x] 3.3 Implement PTY/WebSocket bridge for browser terminal IO.
- [x] 3.4 Add browser terminal rendering with xterm.js.
- [x] 3.5 Add tests for duplicate session prevention and arbitrary command rejection.

## 4. Card Activation Flow

- [x] 4.1 Add a card action or drag transition that opens agent/profile confirmation.
- [x] 4.2 Start or attach the terminal session from the confirmed card action.
- [x] 4.3 Generate the initial agent prompt from `config/prompts/openspec-start-session.md`.
- [x] 4.4 Persist local card/session metadata without mutating OpenSpec files.

## 5. Security and Audit

- [x] 5.1 Add authentication middleware for local development and Cloudflare Access header validation.
- [x] 5.2 Add audit logging for card activation, process spawn, terminal input, rejected command, and auth failure.
- [x] 5.3 Redact likely secrets from audit payloads.
- [x] 5.4 Add tests covering unauthenticated terminal API rejection.

## 6. Attention Notifications

- [ ] 6.1 Add session idle and process-exit attention detection.
- [ ] 6.2 Add a notification provider interface with a no-op provider and one concrete local provider.
- [ ] 6.3 Surface needs-attention state on cards.
- [ ] 6.4 Add tests for nonzero exit and idle attention events.

## 7. Validation

- [x] 7.1 Run `npm run openspec:validate`.
- [x] 7.2 Run the project test suite once implementation exists.
- [x] 7.3 Manually smoke the board against `/path/to/your/project`.
- [x] 7.4 Manually start one Claude or Codex session, disconnect the browser, reconnect, and verify attach works.
