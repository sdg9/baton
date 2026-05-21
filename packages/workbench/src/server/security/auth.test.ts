import { createAuthMiddleware } from './auth';

test('rejects unauthenticated terminal API requests', () => {
  const auth = createAuthMiddleware({ requireAuth: true, localToken: 'dev-token' });
  const result = auth({ path: '/api/sessions', headers: {} });

  expect(result.ok).toBe(false);
  if (!result.ok) {
    expect(result.status).toBe(401);
  }
});

test('accepts local development bearer token', () => {
  const auth = createAuthMiddleware({ requireAuth: true, localToken: 'dev-token' });
  const result = auth({ path: '/api/sessions', headers: { authorization: 'Bearer dev-token' } });

  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.identity.email).toBe('local-owner');
  }
});
