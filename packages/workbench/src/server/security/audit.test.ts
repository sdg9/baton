import { redactSecrets } from './audit';

test('redacts likely secrets in audit payloads', () => {
  const redacted = redactSecrets({
    token: 'abc',
    nested: {
      apiKey: 'secret',
      safe: 'value'
    },
    text: 'Authorization: Bearer abc123'
  });

  expect(redacted).toEqual({
    token: '[REDACTED]',
    nested: {
      apiKey: '[REDACTED]',
      safe: 'value'
    },
    text: 'Authorization: Bearer [REDACTED]'
  });
});
