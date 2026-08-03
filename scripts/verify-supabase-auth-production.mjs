import { expectedSupabaseAuthConfig, fetchSupabaseAuthConfig, verifySupabaseAuthConfig } from './supabase-auth-config-lib.mjs';

const expected = await expectedSupabaseAuthConfig(process.env);
const actual = await fetchSupabaseAuthConfig(process.env);
const problems = verifySupabaseAuthConfig(actual, expected);
if (problems.length) {
  console.error(`Supabase Auth-konfigurationen avviker:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Supabase Auth-konfiguration: OK (stängd registrering, Custom SMTP, mallar och exakta redirects).');
