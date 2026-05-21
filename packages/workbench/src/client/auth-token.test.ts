import { getInitialLocalToken, getStoredTerminalToken } from './auth-token';

test('defaults the local browser token to local-dev-token when nothing is stored', () => {
  expect(getInitialLocalToken(null)).toBe('local-dev-token');
});

test('uses the stored local browser token when one exists', () => {
  expect(getInitialLocalToken('custom-token')).toBe('custom-token');
});

test('uses local-dev-token for terminal websocket auth when nothing is stored', () => {
  expect(getStoredTerminalToken(null)).toBe('local-dev-token');
});
