export const DEFAULT_LOCAL_TOKEN = 'local-dev-token';
export const LOCAL_TOKEN_STORAGE_KEY = 'agent-workbench-token';

export function getInitialLocalToken(storedToken: string | null): string {
  return storedToken || DEFAULT_LOCAL_TOKEN;
}

export function getStoredTerminalToken(storedToken: string | null): string {
  return storedToken || DEFAULT_LOCAL_TOKEN;
}
