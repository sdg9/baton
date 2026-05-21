import type { Server } from 'node:http';
import pty from '@lydell/node-pty';
import { WebSocketServer } from 'ws';
import { attachCommand, captureTmuxPane } from './sessions/tmux';
import { writeAuditEvent } from './security/audit';
import type { AuthRequest, AuthResult } from './security/auth';

export function attachTerminalWebSocket(server: Server, options: {
  getSessionName: (projectId: string, cardId: string) => string | undefined;
  auditPath: string;
  authenticate: (request: AuthRequest) => AuthResult;
  markSessionRunning?: (projectId: string, cardId: string) => void;
}) {
  const wss = new WebSocketServer({ server, path: '/ws/terminal' });

  wss.on('connection', (socket, request) => {
    const url = new URL(request.url ?? '', 'http://127.0.0.1');
    const projectId = url.searchParams.get('projectId') ?? '';
    const cardId = url.searchParams.get('cardId') ?? '';
    const token = url.searchParams.get('token');
    const authResult = options.authenticate({
      path: '/ws/terminal',
      headers: {
        ...request.headers,
        authorization: token ? `Bearer ${token}` : request.headers.authorization
      }
    });
    if (!authResult.ok) {
      writeAuditEvent(options.auditPath, 'auth.failure', { path: '/ws/terminal', reason: authResult.reason, projectId, cardId });
      socket.close(1008, 'Authentication required');
      return;
    }

    const sessionName = options.getSessionName(projectId, cardId);
    if (!sessionName) {
      socket.close(1008, 'Unknown session');
      return;
    }

    socket.send(JSON.stringify({ type: 'server_ready', features: ['resize', 'history'], sessionName }));
    captureTmuxPane(sessionName, undefined, '-5000')
      .then((history) => {
        if (history.trim() && socket.readyState === socket.OPEN) {
          socket.send(JSON.stringify({ type: 'terminal_history', data: normalizeCapturedPaneHistory(history) }));
        }
      })
      .catch((error) => writeAuditEvent(options.auditPath, 'terminal.history_capture_failed', {
        projectId,
        cardId,
        sessionName,
        error: error instanceof Error ? error.message : String(error)
      }))
      .finally(() => attachLiveTmux());

    let ptyProcess: pty.IPty | undefined;
    const attachLiveTmux = () => {
      if (socket.readyState !== socket.OPEN) return;
      const attach = attachCommand(sessionName);
      ptyProcess = pty.spawn(attach.command, attach.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: process.cwd(),
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' }
    });

      ptyProcess.onData((data) => socket.readyState === socket.OPEN && socket.send(stripClearScrollbackSequences(data)));
      ptyProcess.onExit(() => socket.close());
    };
    socket.on('message', (message) => {
      const parsed = parseTerminalClientMessage(message.toString());
      if (parsed.type === 'resize') {
        ptyProcess?.resize(parsed.cols, parsed.rows);
        return;
      }
      const input = parsed.data;
      options.markSessionRunning?.(projectId, cardId);
      writeAuditEvent(options.auditPath, 'terminal.input', { projectId, cardId, sessionName, bytes: input.length });
      ptyProcess?.write(input);
    });
    socket.on('close', () => ptyProcess?.kill());
  });

  return wss;
}

function normalizeCapturedPaneHistory(history: string): string {
  return history.replace(/\r?\n/g, '\r\n');
}

export function stripClearScrollbackSequences(data: string): string {
  return data.replace(/\x1b\[3J/g, '');
}

export type TerminalClientMessage =
  | { type: 'input'; data: string }
  | { type: 'resize'; cols: number; rows: number };

export function parseTerminalClientMessage(message: string): TerminalClientMessage {
  try {
    const parsed = JSON.parse(message) as { type?: unknown; cols?: unknown; rows?: unknown };
    if (
      parsed.type === 'resize'
      && Number.isInteger(parsed.cols)
      && Number.isInteger(parsed.rows)
      && Number(parsed.cols) > 0
      && Number(parsed.rows) > 0
    ) {
      return { type: 'resize', cols: Number(parsed.cols), rows: Number(parsed.rows) };
    }
  } catch {
    // Plain terminal input is usually not JSON.
  }
  return { type: 'input', data: message };
}
