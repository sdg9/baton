import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SECRET_KEY_PATTERN = /(token|secret|api[-_]?key|authorization|cookie)/i;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]+/g;

export function redactSecrets(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(BEARER_PATTERN, 'Bearer [REDACTED]');
  if (Array.isArray(value)) return value.map((entry) => redactSecrets(entry));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [
      key,
      SECRET_KEY_PATTERN.test(key) ? '[REDACTED]' : redactSecrets(nested)
    ]));
  }
  return value;
}

export function writeAuditEvent(path: string, action: string, payload: Record<string, unknown>): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify({
    timestamp: new Date().toISOString(),
    action,
    payload: redactSecrets(payload)
  })}\n`);
}
