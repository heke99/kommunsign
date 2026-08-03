import postgres from 'postgres';
import { createHash } from 'node:crypto';

const required = (name) => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name}_REQUIRED`);
  return value;
};
const controlUrl = required('CONTROL_DATABASE_URL');
const authUrl = new URL(required('SUPABASE_AUTH_PROJECT_URL'));
if (authUrl.protocol !== 'https:') throw new Error('SUPABASE_AUTH_PROJECT_URL_INVALID');
const serviceKey = required('SUPABASE_AUTH_SERVICE_ROLE_KEY');
const email = required('SUPERADMIN_EMAIL').toLowerCase();
const displayName = required('SUPERADMIN_DISPLAY_NAME');
const redirectTo = required('SUPERADMIN_INVITE_REDIRECT_URL');
const allowExistingUser = process.env.SUPERADMIN_ALLOW_EXISTING_USER?.trim().toLowerCase() === 'true';
const canonicalJson = (value) => {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') { if (!Number.isFinite(value)) throw new Error('CANONICAL_JSON_INVALID_NUMBER'); return Object.is(value,-0)?'0':JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
};
const sha256 = (value) => createHash('sha256').update(value,'utf8').digest('hex');
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('SUPERADMIN_EMAIL_INVALID');
const redirect = new URL(redirectTo);
if (redirect.protocol !== 'https:' || redirect.username || redirect.password) throw new Error('SUPERADMIN_INVITE_REDIRECT_URL_INVALID');

const headers = { apikey: serviceKey, authorization: `Bearer ${serviceKey}`, 'content-type': 'application/json' };
async function findUser() {
  for (let page = 1; page <= 50; page += 1) {
    const response = await fetch(new URL(`/auth/v1/admin/users?page=${page}&per_page=100`, authUrl), { headers, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(`SUPABASE_AUTH_LIST_FAILED_${response.status}`);
    const payload = await response.json();
    const users = Array.isArray(payload.users) ? payload.users : [];
    const found = users.find((user) => String(user.email ?? '').toLowerCase() === email);
    if (found) return found;
    if (users.length < 100) return null;
  }
  throw new Error('SUPABASE_AUTH_USER_SEARCH_LIMIT');
}
async function sendActivationLink() {
  const endpoint = new URL('/auth/v1/recover', authUrl);
  endpoint.searchParams.set('redirect_to', redirect.toString());
  const response = await fetch(endpoint, {
    method: 'POST', headers, body: JSON.stringify({ email }), signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`SUPABASE_AUTH_RECOVERY_FAILED_${response.status}`);
}
async function inviteUser() {
  const endpoint = new URL('/auth/v1/invite', authUrl);
  endpoint.searchParams.set('redirect_to', redirect.toString());
  const response = await fetch(endpoint, {
    method: 'POST', headers,
    body: JSON.stringify({ email, data: { displayName, kommunsignPlatformRole: 'platform_super_admin' } }),
    signal: AbortSignal.timeout(10_000),
  });
  if (response.ok) { const payload = await response.json(); return { user: payload?.user ?? payload, invited: true }; }
  if (response.status === 422 || response.status === 400) {
    const existing = await findUser();
    if (existing) return { user: existing, invited: false };
  }
  throw new Error(`SUPABASE_AUTH_INVITE_FAILED_${response.status}`);
}

const sql = postgres(controlUrl, { max: 1, idle_timeout: 5, connect_timeout: 10, prepare: false });
const existing = await findUser();
let alreadyBootstrapped = false;
if (existing?.id) {
  const rows = await sql`
    select exists(
      select 1
        from control.platform_subjects subject
        join control.platform_role_assignments role on role.platform_subject_id=subject.id
       where subject.id=${existing.id}::uuid
         and subject.status='active'
         and role.role_key='platform_super_admin'
         and role.revoked_at is null
    ) as bootstrapped
  `;
  alreadyBootstrapped = rows[0]?.bootstrapped === true;
  if (!alreadyBootstrapped && !allowExistingUser) {
    await sql.end({ timeout: 5 });
    throw new Error('SUPERADMIN_EXISTING_AUTH_USER_REQUIRES_EXPLICIT_APPROVAL');
  }
}
let result;
if (existing) {
  const confirmed = typeof existing.email_confirmed_at === 'string' && existing.email_confirmed_at.length > 0;
  if (!confirmed) await sendActivationLink();
  result = { user: existing, invited: !confirmed };
} else {
  result = await inviteUser();
}
if (!result.user?.id) throw new Error('SUPABASE_AUTH_USER_ID_MISSING');
try {
  await sql.begin(async (tx) => {
    await tx`
      insert into control.platform_subjects(id,external_subject,display_name,status)
      values(${result.user.id}::uuid,${result.user.id},${displayName},'active')
      on conflict(id) do update set external_subject=excluded.external_subject,display_name=excluded.display_name,status='active',updated_at=now()
    `;
    await tx`
      insert into control.platform_role_assignments(platform_subject_id,role_key,granted_by)
      values(${result.user.id}::uuid,'platform_super_admin',${result.user.id}::uuid)
      on conflict(platform_subject_id,role_key) do update set revoked_at=null,granted_by=excluded.granted_by,granted_at=now()
    `;
    if (!alreadyBootstrapped) {
      await tx`select pg_advisory_xact_lock(hashtextextended('control-audit-chain',0))`;
      const previousRows = await tx`select event_hash from control.control_audit_events order by occurred_at desc,id desc limit 1`;
      const previousHash = previousRows[0]?.event_hash ?? '0'.repeat(64);
      const eventType = 'platform.superadmin_bootstrapped';
      const payload = { provider: 'supabase_auth', providerSubjectHash: sha256(result.user.id), inviteEmailSent: result.invited };
      const eventHash = sha256(canonicalJson({ tenantId: null, actorId: result.user.id, eventType, payload, previousHash }));
      await tx`
        insert into control.control_audit_events(tenant_id,actor_id,event_type,payload,previous_event_hash,event_hash)
        values(null,${result.user.id}::uuid,${eventType},${tx.json(payload)},${previousHash},${eventHash})
      `;
    }
  });
} finally {
  await sql.end({ timeout: 5 });
}
const masked = email.replace(/^(.)([^@]*)(@.*)$/, (_, first, middle, domain) => `${first}${'•'.repeat(Math.min(6, Math.max(2, middle.length)))}${domain}`);
console.log(result.invited ? `Superadmin skapad och aktiveringslänk skickad till ${masked}.` : alreadyBootstrapped ? `Superadmin ${masked} var redan korrekt konfigurerad.` : `Befintligt konto ${masked} har tilldelats superadminbehörighet efter uttryckligt godkännande.`);
