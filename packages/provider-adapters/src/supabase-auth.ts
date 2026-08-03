export interface SupabaseAuthUser {
  readonly id: string;
  readonly email: string;
  readonly emailConfirmedAt?: string;
  readonly userMetadata: Readonly<Record<string, unknown>>;
}

export interface SupabasePasswordSession {
  readonly accessToken: string;
  readonly expiresIn: number;
  readonly user: SupabaseAuthUser;
}

export interface SupabaseAuthConfiguration {
  readonly projectUrl: string;
  readonly anonKey: string;
  readonly serviceRoleKey?: string;
  readonly requestTimeoutMs?: number;
  readonly http?: typeof fetch;
}

export class SupabaseAuthError extends Error {
  constructor(readonly code: string, readonly status: number, readonly retryable: boolean) {
    super(code);
    this.name = 'SupabaseAuthError';
  }
}

export class SupabaseAuthProvider {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly http: typeof fetch;

  constructor(private readonly configuration: SupabaseAuthConfiguration) {
    const parsed = new URL(configuration.projectUrl);
    if (parsed.protocol !== 'https:' && parsed.hostname !== '127.0.0.1' && parsed.hostname !== 'localhost') throw new Error('SUPABASE_AUTH_PROJECT_URL_INVALID');
    if (!configuration.anonKey.trim()) throw new Error('SUPABASE_AUTH_ANON_KEY_MISSING');
    this.baseUrl = parsed.toString().replace(/\/$/, '');
    this.timeoutMs = configuration.requestTimeoutMs ?? 10_000;
    this.http = configuration.http ?? fetch;
  }

  async signInWithPassword(email: string, password: string): Promise<SupabasePasswordSession> {
    const payload = await this.request('/auth/v1/token?grant_type=password', {
      method: 'POST',
      headers: this.publicHeaders(),
      body: JSON.stringify({ email: normalizeEmail(email), password }),
    });
    const record = object(payload);
    return {
      accessToken: requiredString(record.access_token, 'AUTH_PROVIDER_RESPONSE_INVALID'),
      expiresIn: requiredPositiveInteger(record.expires_in, 'AUTH_PROVIDER_RESPONSE_INVALID'),
      user: user(record.user),
    };
  }

  async getUser(accessToken: string): Promise<SupabaseAuthUser> {
    const payload = await this.request('/auth/v1/user', {
      method: 'GET',
      headers: { ...this.publicHeaders(), authorization: `Bearer ${bearer(accessToken)}` },
    });
    return user(payload);
  }

  async verifyEmailOtp(tokenHash: string, type: 'invite' | 'recovery'): Promise<SupabasePasswordSession> {
    const payload = await this.request('/auth/v1/verify', {
      method: 'POST',
      headers: this.publicHeaders(),
      body: JSON.stringify({ token_hash: emailTokenHash(tokenHash), type: emailActionType(type) }),
    }).catch((cause) => {
      if (cause instanceof SupabaseAuthError && ['AUTH_PROVIDER_REJECTED','AUTH_PROVIDER_VALIDATION_FAILED','AUTH_INVALID_CREDENTIALS'].includes(cause.code)) {
        throw new SupabaseAuthError('AUTH_EMAIL_LINK_INVALID', 401, false);
      }
      throw cause;
    });
    const record = object(payload);
    return {
      accessToken: requiredString(record.access_token, 'AUTH_PROVIDER_RESPONSE_INVALID'),
      expiresIn: requiredPositiveInteger(record.expires_in, 'AUTH_PROVIDER_RESPONSE_INVALID'),
      user: user(record.user),
    };
  }

  async updatePassword(accessToken: string, password: string): Promise<SupabaseAuthUser> {
    validatePassword(password);
    const payload = await this.request('/auth/v1/user', {
      method: 'PUT',
      headers: { ...this.publicHeaders(), authorization: `Bearer ${bearer(accessToken)}` },
      body: JSON.stringify({ password }),
    });
    return user(payload);
  }

  async sendPasswordRecovery(email: string, redirectTo: string): Promise<void> {
    const redirect = safeRedirect(redirectTo);
    await this.request(`/auth/v1/recover?redirect_to=${encodeURIComponent(redirect)}`, {
      method: 'POST',
      headers: this.publicHeaders(),
      body: JSON.stringify({ email: normalizeEmail(email) }),
    }, true);
  }

  async inviteUser(email: string, redirectTo: string, metadata: Readonly<Record<string, unknown>>): Promise<SupabaseAuthUser> {
    const redirect = safeRedirect(redirectTo);
    const payload = await this.request(`/auth/v1/invite?redirect_to=${encodeURIComponent(redirect)}`, {
      method: 'POST',
      headers: this.adminHeaders(),
      body: JSON.stringify({ email: normalizeEmail(email), data: metadata }),
    });
    const record = object(payload);
    return user(record.user ?? payload);
  }

  async findUserByEmail(email: string): Promise<SupabaseAuthUser | null> {
    const target = normalizeEmail(email);
    for (let page = 1; page <= 100; page += 1) {
      const payload = await this.request(`/auth/v1/admin/users?page=${page}&per_page=100`, {
        method: 'GET',
        headers: this.adminHeaders(),
      });
      const record = object(payload);
      const users = Array.isArray(record.users) ? record.users : [];
      for (const candidate of users) {
        const parsed = user(candidate);
        if (parsed.email === target) return parsed;
      }
      if (users.length < 100) return null;
    }
    throw new SupabaseAuthError('AUTH_PROVIDER_USER_LOOKUP_LIMIT', 503, true);
  }

  async inviteOrFindUser(email: string, redirectTo: string, metadata: Readonly<Record<string, unknown>>): Promise<{ readonly user: SupabaseAuthUser; readonly invited: boolean }> {
    const existing = await this.findUserByEmail(email);
    if (existing?.emailConfirmedAt) return { user: existing, invited: false };
    if (existing) {
      // Supabase rejects a second administrative invite for an existing identity.
      // A recovery link uses the same protected password-completion flow and safely
      // re-delivers account activation without creating a duplicate identity.
      await this.sendPasswordRecovery(email, redirectTo);
      return { user: existing, invited: true };
    }
    return { user: await this.inviteUser(email, redirectTo, metadata), invited: true };
  }

  private publicHeaders(): Readonly<Record<string, string>> {
    return { apikey: this.configuration.anonKey, 'content-type': 'application/json', accept: 'application/json' };
  }

  private adminHeaders(): Readonly<Record<string, string>> {
    const serviceRoleKey = this.configuration.serviceRoleKey?.trim();
    if (!serviceRoleKey) throw new Error('SUPABASE_AUTH_SERVICE_ROLE_KEY_MISSING');
    return { apikey: serviceRoleKey, authorization: `Bearer ${serviceRoleKey}`, 'content-type': 'application/json', accept: 'application/json' };
  }

  private async request(path: string, init: RequestInit, hideEnumeration = false): Promise<unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.http(`${this.baseUrl}${path}`, { ...init, signal: controller.signal });
    } catch (cause) {
      if (cause instanceof Error && cause.name === 'AbortError') throw new SupabaseAuthError('AUTH_PROVIDER_TIMEOUT', 504, true);
      throw new SupabaseAuthError('AUTH_PROVIDER_UNAVAILABLE', 503, true);
    } finally {
      clearTimeout(timeout);
    }
    const payload = await response.json().catch(() => ({}));
    if (response.ok) return payload;
    if (hideEnumeration && response.status >= 400 && response.status < 500) return {};
    const providerCode = safeProviderCode(payload);
    if (response.status === 400 || response.status === 401 || response.status === 403) throw new SupabaseAuthError(providerCode === 'INVALID_LOGIN_CREDENTIALS' ? 'AUTH_INVALID_CREDENTIALS' : 'AUTH_PROVIDER_REJECTED', 401, false);
    if (response.status === 422) throw new SupabaseAuthError('AUTH_PROVIDER_VALIDATION_FAILED', 422, false);
    if (response.status === 429) throw new SupabaseAuthError('AUTH_RATE_LIMITED', 429, true);
    throw new SupabaseAuthError('AUTH_PROVIDER_FAILURE', 503, response.status >= 500);
  }
}

export function validatePassword(value: string): void {
  if (typeof value !== 'string' || value.length < 12 || value.length > 128) throw new Error('PASSWORD_POLICY_FAILED');
  if (!/[a-zåäö]/.test(value) || !/[A-ZÅÄÖ]/.test(value) || !/[0-9]/.test(value) || !/[^A-Za-zÅÄÖåäö0-9]/.test(value)) throw new Error('PASSWORD_POLICY_FAILED');
}

function user(value: unknown): SupabaseAuthUser {
  const record = object(value);
  const id = requiredString(record.id, 'AUTH_PROVIDER_RESPONSE_INVALID');
  const email = normalizeEmail(requiredString(record.email, 'AUTH_PROVIDER_RESPONSE_INVALID'));
  const metadata = record.user_metadata && typeof record.user_metadata === 'object' && !Array.isArray(record.user_metadata)
    ? record.user_metadata as Readonly<Record<string, unknown>>
    : {};
  const confirmed = typeof record.email_confirmed_at === 'string' && record.email_confirmed_at ? record.email_confirmed_at : undefined;
  return { id, email, userMetadata: metadata, ...(confirmed ? { emailConfirmedAt: confirmed } : {}) };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SupabaseAuthError('AUTH_PROVIDER_RESPONSE_INVALID', 502, false);
  return value as Record<string, unknown>;
}
function requiredString(value: unknown, code: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new SupabaseAuthError(code, 502, false);
  return value;
}
function requiredPositiveInteger(value: unknown, code: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new SupabaseAuthError(code, 502, false);
  return parsed;
}
function normalizeEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error('EMAIL_INVALID');
  return normalized;
}
function emailTokenHash(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._~-]{32,1024}$/.test(normalized)) throw new Error('AUTH_EMAIL_LINK_INVALID');
  return normalized;
}
function emailActionType(value: string): 'invite' | 'recovery' {
  if (value !== 'invite' && value !== 'recovery') throw new Error('AUTH_EMAIL_LINK_INVALID');
  return value;
}
function bearer(value: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9._~-]{32,8192}$/.test(normalized)) throw new Error('AUTH_ACCESS_TOKEN_INVALID');
  return normalized;
}
function safeRedirect(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.hash) throw new Error('AUTH_REDIRECT_URL_INVALID');
  return parsed.toString();
}
function safeProviderCode(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'AUTH_PROVIDER_REJECTED';
  const record = payload as Record<string, unknown>;
  const value = [record.code, record.error_code, record.msg, record.message].find((candidate) => typeof candidate === 'string') as string | undefined;
  if (!value) return 'AUTH_PROVIDER_REJECTED';
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'AUTH_PROVIDER_REJECTED';
}
