export interface AuthRequest {
  path: string;
  headers: Record<string, string | string[] | undefined>;
}

export interface AuthIdentity {
  email: string;
  source: 'local-token' | 'cloudflare-access' | 'disabled';
}

export type AuthResult =
  | { ok: true; identity: AuthIdentity }
  | { ok: false; status: 401; reason: string };

export function createAuthMiddleware(options: {
  requireAuth: boolean;
  localToken?: string;
}) {
  return (request: AuthRequest): AuthResult => {
    if (!options.requireAuth) {
      return { ok: true, identity: { email: 'local-owner', source: 'disabled' } };
    }

    const authorization = headerValue(request.headers.authorization);
    const expected = options.localToken ? `Bearer ${options.localToken}` : undefined;
    if (expected && authorization === expected) {
      return { ok: true, identity: { email: 'local-owner', source: 'local-token' } };
    }

    const cfEmail = headerValue(request.headers['cf-access-authenticated-user-email']);
    if (cfEmail) {
      return { ok: true, identity: { email: cfEmail, source: 'cloudflare-access' } };
    }

    return { ok: false, status: 401, reason: `Authentication required for ${request.path}` };
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
