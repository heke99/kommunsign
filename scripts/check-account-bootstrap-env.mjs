const required = [
  'CONTROL_DATABASE_URL',
  'SUPABASE_AUTH_PROJECT_URL',
  'SUPABASE_AUTH_PROJECT_REF',
  'SUPABASE_AUTH_SERVICE_ROLE_KEY',
  'SUPABASE_MANAGEMENT_ACCESS_TOKEN',
  'AUTH_SMTP_PASSWORD',
  'AUTH_SMTP_SENDER_EMAIL',
  'AUTH_SMTP_SENDER_NAME',
  'SUPABASE_AUTH_SITE_URL',
  'SUPABASE_AUTH_ALLOWED_REDIRECT_URLS',
  'SUPERADMIN_EMAIL',
  'SUPERADMIN_DISPLAY_NAME',
  'SUPERADMIN_INVITE_REDIRECT_URL',
];

const problems = [];
for (const name of required) {
  const value = process.env[name]?.trim();
  if (!value) problems.push(`${name}: saknas`);
  else if (/^(<|changeme|replace|todo|example|your-)/i.test(value)) problems.push(`${name}: innehåller platshållare`);
}
for (const [name, expected] of Object.entries({
  AUTH_PUBLIC_SIGNUP_ENABLED: 'false',
  AUTH_SMTP_PROVIDER: 'resend',
  AUTH_SMTP_HOST: 'smtp.resend.com',
  AUTH_SMTP_PORT: '465',
  AUTH_SMTP_USERNAME: 'resend',
  SUPERADMIN_ALLOW_EXISTING_USER: 'false',
})) {
  if (process.env[name]?.trim().toLowerCase() !== expected) problems.push(`${name}: ska vara ${expected}`);
}
for (const name of ['SUPABASE_AUTH_PROJECT_URL','SUPABASE_AUTH_SITE_URL','SUPERADMIN_INVITE_REDIRECT_URL']) {
  try {
    const url = new URL(process.env[name] ?? '');
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
  } catch {
    problems.push(`${name}: ska vara en giltig https-URL`);
  }
}
const allowed = new Set((process.env.SUPABASE_AUTH_ALLOWED_REDIRECT_URLS ?? '').split(',').map((value) => value.trim()).filter(Boolean));
for (const redirect of ['https://app.kommunsign.se/aktivera/','https://app.kommunsign.se/aterstall/']) {
  if (!allowed.has(redirect)) problems.push(`SUPABASE_AUTH_ALLOWED_REDIRECT_URLS: saknar ${redirect}`);
}
if (problems.length) {
  console.error(`Kontostarten saknar konfiguration:\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log('Kontostartens miljö är komplett för Supabase Auth-konfiguration och första superadmininbjudan.');
