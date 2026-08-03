import { expectedSupabaseAuthConfig, fetchSupabaseAuthConfig, verifySupabaseAuthConfig } from './supabase-auth-config-lib.mjs';

const token = process.env.SUPABASE_MANAGEMENT_ACCESS_TOKEN?.trim();
const projectRef = process.env.SUPABASE_AUTH_PROJECT_REF?.trim();
if (!token) throw new Error('SUPABASE_MANAGEMENT_ACCESS_TOKEN_REQUIRED');
if (!projectRef || !/^[a-z0-9]{8,40}$/.test(projectRef)) throw new Error('SUPABASE_AUTH_PROJECT_REF_INVALID');
const expected = await expectedSupabaseAuthConfig(process.env, { requirePassword: true });
const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
  method: 'PATCH',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
  body: JSON.stringify(expected),
  signal: AbortSignal.timeout(20_000),
});
if (!response.ok) throw new Error(`SUPABASE_AUTH_CONFIG_UPDATE_FAILED_${response.status}`);
const actual = await fetchSupabaseAuthConfig(process.env);
const problems = verifySupabaseAuthConfig(actual, expected);
if (problems.length) throw new Error(`SUPABASE_AUTH_CONFIG_VERIFICATION_FAILED\n- ${problems.join('\n- ')}`);
console.log('Supabase Auth: publik registrering avstängd, exakta redirect-URL:er och Custom SMTP verifierade.');
