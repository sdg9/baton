import { killTmuxSession } from './tmux';

test('kills the named tmux session', async () => {
  const commands: string[][] = [];

  await killTmuxSession('agent-workbench-example-project-change-a', async (file, args) => {
    commands.push([file, ...args]);
    return { stdout: '', stderr: '' };
  });

  expect(commands).toEqual([
    ['tmux', 'kill-session', '-t', 'agent-workbench-example-project-change-a']
  ]);
});
