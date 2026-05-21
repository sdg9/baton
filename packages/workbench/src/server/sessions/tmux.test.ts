import { attachCommand, buildSessionName, createOrAttachTmuxSession } from './tmux';

test('builds stable sanitized tmux session names for cards', () => {
  expect(buildSessionName('agent-workbench', 'example-project', 'content/ironclad unblock')).toBe('agent-workbench-example-project-content-ironclad-unblock');
});

test('attaches instead of creating duplicate tmux sessions', async () => {
  const commands: string[][] = [];
  const result = await createOrAttachTmuxSession({
    namePrefix: 'agent-workbench',
    projectId: 'example-project',
    cardId: 'change-a',
    cwd: '/allowed/project',
    command: 'codex',
    args: [],
    initialPrompt: 'Start work',
    execFile: async (file, args) => {
      commands.push([file, ...args]);
      return { stdout: '', stderr: '' };
    },
    hasSession: async () => true
  });

  expect(result.created).toBe(false);
  expect(result.sessionName).toBe('agent-workbench-example-project-change-a');
  expect(commands).toEqual([]);
});

test('raises history-limit before creating a new session so panes keep deep scrollback', async () => {
  const commands: string[][] = [];
  const result = await createOrAttachTmuxSession({
    namePrefix: 'agent-workbench',
    projectId: 'example-project',
    cardId: 'change-a',
    cwd: '/allowed/project',
    command: 'codex',
    args: [],
    initialPrompt: 'Start work',
    execFile: async (file, args) => {
      commands.push([file, ...args]);
      return { stdout: '', stderr: '' };
    },
    hasSession: async () => false
  });

  expect(result.created).toBe(true);
  // history-limit is a window option and only applies to panes created afterwards,
  // so it must be raised before new-session spawns the pane.
  expect(commands[0]).toEqual(['tmux', 'set-option', '-g', 'history-limit', '50000']);
  expect(commands[1].slice(0, 4)).toEqual(['tmux', 'new-session', '-d', '-s']);
  expect(commands).toHaveLength(2);
});

test('browser attach enables mouse mode and uses latest client size as authoritative', () => {
  expect(attachCommand('agent-workbench-example-project-change-a')).toEqual({
    command: 'tmux',
    args: [
      'set-option', '-t', 'agent-workbench-example-project-change-a', 'mouse', 'on', ';',
      'set-window-option', '-t', 'agent-workbench-example-project-change-a', 'window-size', 'latest', ';',
      'attach-session', '-t', 'agent-workbench-example-project-change-a'
    ]
  });
});
