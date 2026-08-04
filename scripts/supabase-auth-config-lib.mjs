import { readFile } from 'node:fs/promises';

const required = (environment, name) => {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};

export async function expectedSupabaseAuthConfig(environment = process.env, options = {}) {
  const siteUrl = new URL(required(environment, 'SUPABASE_AUTH_SITE_URL'));
  if (siteUrl.protocol !== 'https:' || siteUrl.username || siteUrl.password || siteUrl.hash || siteUrl.search || siteUrl.pathname !== '/') throw new Error('SUPABASE_AUTH_SITE_URL_INVALID');
  const redirects = required(environment, 'SUPABASE_AUTH_ALLOWED_REDIRECT_URLS').split(',').map((value) => value.trim()).filter(Boolean);
  if (!redirects.length || redirects.some((value) => { try { return new URL(value).protocol !== 'https:'; } catch { return true; } })) throw new Error('SUPABASE_AUTH_ALLOWED_REDIRECT_URLS_INVALID');
  const port = Number(required(environment, 'AUTH_SMTP_PORT'));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('AUTH_SMTP_PORT_INVALID');
  const password = options.requirePassword ? required(environment, 'AUTH_SMTP_PASSWORD') : undefined;
  const inviteTemplate = await readFile(new URL('../infrastructure/supabase/auth-templates/invite.html', import.meta.url), 'utf8');
  const recoveryTemplate = await readFile(new URL('../infrastructure/supabase/auth-templates/recovery.html', import.meta.url), 'utf8');
  return {
    site_url: siteUrl.toString().replace(/\/$/, ''),
    uri_allow_list: redirects.join(','),
    disable_signup: true,
    external_email_enabled: true,
    mailer_autoconfirm: false,
    mailer_allow_unverified_email_sign_ins: false,
    smtp_admin_email: required(environment, 'AUTH_SMTP_SENDER_EMAIL'),
    smtp_host: required(environment, 'AUTH_SMTP_HOST'),
    smtp_port: String(port),
    smtp_user: required(environment, 'AUTH_SMTP_USERNAME'),
    ...(password ? { smtp_pass: password } : {}),
    smtp_sender_name: required(environment, 'AUTH_SMTP_SENDER_NAME'),
    smtp_max_frequency: 60,
    mailer_subjects_invite: 'Aktivera ditt konto i Kommunsign',
    mailer_templates_invite_content: inviteTemplate.trim(),
    mailer_subjects_recovery: 'Återställ ditt lösenord i Kommunsign',
    mailer_templates_recovery_content: recoveryTemplate.trim(),
    mailer_notifications_password_changed_enabled: true,
  };
}

export async function fetchSupabaseAuthConfig(environment = process.env) {
  const token = required(environment, 'SUPABASE_MANAGEMENT_ACCESS_TOKEN');
  const projectRef = required(environment, 'SUPABASE_AUTH_PROJECT_REF');
  if (!/^[a-z0-9]{8,40}$/.test(projectRef)) throw new Error('SUPABASE_AUTH_PROJECT_REF_INVALID');
  const response = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/config/auth`, {
    headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_AUTH_CONFIG_READ_FAILED_${response.status}`);
  return response.json();
}

export function verifySupabaseAuthConfig(actual, expected) {
  const problems = [];
  const equal = (name, wanted) => {
    const got = actual?.[name];
    if (String(got ?? '') !== String(wanted)) problems.push(`${name}: förväntat ${JSON.stringify(wanted)}, fick ${JSON.stringify(got)}`);
  };
  for (const name of ['site_url','disable_signup','external_email_enabled','mailer_autoconfirm','mailer_allow_unverified_email_sign_ins','smtp_admin_email','smtp_host','smtp_port','smtp_user','smtp_sender_name','mailer_subjects_invite','mailer_subjects_recovery','mailer_templates_invite_content','mailer_templates_recovery_content']) equal(name, expected[name]);
  const actualRedirects = new Set(String(actual?.uri_allow_list ?? '').split(',').map((value) => value.trim()).filter(Boolean));
  for (const redirect of String(expected.uri_allow_list).split(',')) if (!actualRedirects.has(redirect)) problems.push(`uri_allow_list: saknar ${redirect}`);
  if (actual?.mailer_notifications_password_changed_enabled !== true) problems.push('mailer_notifications_password_changed_enabled: ska vara true');
  return problems;
}
