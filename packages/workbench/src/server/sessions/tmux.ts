import { execFile as nodeExecFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(nodeExecFile);

interface ExecResult {
  stdout: string;
  stderr: string;
}

type ExecFile = (file: string, args: string[], options?: { cwd?: string }) => Promise<ExecResult>;

export function buildSessionName(prefix: string, projectId: string, cardId: string): string {
  const raw = `${prefix}-${projectId}-${cardId}`;
  return raw.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

export async function tmuxHasSession(sessionName: string, execFile: ExecFile = execFileAsync): Promise<boolean> {
  try {
    await execFile('tmux', ['has-session', '-t', sessionName]);
    return true;
  } catch {
    return false;
  }
}

export async function killTmuxSession(sessionName: string, execFile: ExecFile = execFileAsync): Promise<void> {
  await execFile('tmux', ['kill-session', '-t', sessionName]);
}

export async function captureTmuxPane(sessionName: string, execFile: ExecFile = execFileAsync, startLine = '-160'): Promise<string> {
  const { stdout } = await execFile('tmux', ['capture-pane', '-pt', sessionName, '-S', startLine]);
  return stdout;
}

export async function createOrAttachTmuxSession(options: {
  namePrefix: string;
  projectId: string;
  cardId: string;
  cwd: string;
  command: string;
  args: string[];
  initialPrompt: string;
  execFile?: ExecFile;
  hasSession?: (sessionName: string) => Promise<boolean>;
}) {
  const execFile = options.execFile ?? execFileAsync;
  const sessionName = buildSessionName(options.namePrefix, options.projectId, options.cardId);
  const hasSession = options.hasSession ?? ((name) => tmuxHasSession(name, execFile));
  if (await hasSession(sessionName)) {
    return { sessionName, created: false };
  }

  const command = shellQuote([
    options.command,
    ...options.args,
    options.initialPrompt
  ]);
  // history-limit is a window option that only takes effect for panes created
  // afterwards, so raise it before new-session spawns this session's pane.
  // This keeps deep tmux scrollback available for browser copy-mode scrolling.
  await execFile('tmux', ['set-option', '-g', 'history-limit', String(HISTORY_LIMIT)]);
  await execFile('tmux', ['new-session', '-d', '-s', sessionName, '-c', options.cwd, command], { cwd: options.cwd });
  return { sessionName, created: true };
}

const HISTORY_LIMIT = 50000;

export function attachCommand(sessionName: string): { command: string; args: string[] } {
  // Enable mouse mode so wheel-scroll in the browser terminal enters tmux
  // copy-mode and scrolls real scrollback; window-size latest makes the most
  // recently attached client authoritative for pane dimensions.
  return {
    command: 'tmux',
    args: [
      'set-option', '-t', sessionName, 'mouse', 'on', ';',
      'set-window-option', '-t', sessionName, 'window-size', 'latest', ';',
      'attach-session', '-t', sessionName
    ]
  };
}

function shellQuote(args: string[]): string {
  return args.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(' ');
}
