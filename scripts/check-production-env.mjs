const required = [
  'CONTROL_DATABASE_URL','DATA_DATABASE_URL','KMS_KEY_REFERENCE',
  'SENSITIVE_DATA_ENCRYPTION_KEY_BASE64','SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64',
  'SUPABASE_DATA_PROJECT_URL','SUPABASE_DATA_SERVICE_ROLE_KEY',
  'SUPABASE_AUTH_PROJECT_URL','SUPABASE_AUTH_PROJECT_REF','SUPABASE_AUTH_ANON_KEY','SUPABASE_AUTH_SERVICE_ROLE_KEY',
  'AUTH_SMTP_PASSWORD_SECRET_REF','AUTH_SMTP_SENDER_EMAIL','AUTH_SMTP_SENDER_NAME',
  'INTERNAL_GATEWAY_HMAC_KEY','CSRF_SIGNING_KEY','TRUSTED_PROXY_SHARED_SECRET',
  'TIC_API_KEY','TIC_WEBHOOK_SECRET','RESEND_API_KEY','RESEND_WEBHOOK_SECRET',
  'VALIDATION_SERVICE_TOKEN','VERCEL_API_TOKEN','VERCEL_TEAM_ID','VERCEL_WEB_PROJECT_ID',
];
const exact = {
  NODE_ENV:'production',APP_ENV:'production',KOMMUNSIGN_ENV:'production',
  AUTH_PUBLIC_SIGNUP_ENABLED:'false',SUPERADMIN_ALLOW_EXISTING_USER:'false',
  AUTH_SMTP_PROVIDER:'resend',AUTH_SMTP_HOST:'smtp.resend.com',AUTH_SMTP_PORT:'465',AUTH_SMTP_USERNAME:'resend',
  SESSION_COOKIE_SECURE:'true',SESSION_COOKIE_HTTP_ONLY:'true',
  TRUST_PROXY:'true',REJECT_UNKNOWN_HOSTS:'true',REQUIRE_VERIFIED_FORWARDED_HOST:'true',
  REJECT_UNVERIFIED_CUSTOM_DOMAINS:'true',ALLOW_ARBITRARY_REDIRECTS:'false',
  ALLOW_IN_MEMORY_RUNTIME:'false',TENANT_CONTEXT_REQUIRED:'true',
  TIC_ENVIRONMENT:'production',TIC_GLOBAL_KILL_SWITCH:'false',
  EMAIL_PROVIDER:'resend',EMAIL_GLOBAL_KILL_SWITCH:'false',
  EMAIL_OPEN_TRACKING:'false',EMAIL_CLICK_TRACKING:'false',EMAIL_REQUIRE_VERIFIED_SENDER_DOMAIN:'true',
  ALLOW_WILDCARD_CORS:'false',
};
const verified = [
  'PLATFORM_WILDCARD_VERIFIED','TIC_BANKID_ENABLED','TIC_CALLBACK_VERIFIED','TIC_WEBHOOK_VERIFIED',
  'WILDCARD_TLS_VERIFIED','AUDIT_CHAIN_VERIFIED','MIGRATIONS_CURRENT','EVIDENCE_VERIFIER_VERIFIED',
  'WORKER_CONSUMERS_READY','PDF_PIPELINE_APPROVED','PRODUCTION_ACCEPTANCE_TEST_PASSED',
  'RETENTION_POLICY_APPROVED','DPA_ACCEPTED','AUTH_EMAIL_DELIVERY_VERIFIED','SUPERADMIN_BOOTSTRAPPED',
];
const urls = [
  'PUBLIC_WEBSITE_URL','ONBOARDING_PORTAL_URL','PLATFORM_ADMIN_URL','TENANT_DISCOVERY_URL','AUTH_BROKER_URL',
  'API_BASE_URL','SIGNER_FALLBACK_URL','VERIFICATION_PORTAL_URL','WEBHOOK_BASE_URL',
  'TIC_CALLBACK_URL','TIC_WEBHOOK_URL','AUTH_INVITE_REDIRECT_URL','AUTH_PASSWORD_RESET_REDIRECT_URL','SUPABASE_AUTH_SITE_URL',
];
const problems=[];
for(const name of required){const value=process.env[name]?.trim();if(!value)problems.push(`${name}: saknas`);else if(/^(<|changeme|replace|todo|example|your-)/i.test(value))problems.push(`${name}: innehåller platshållare`);}
for(const [name,wanted] of Object.entries(exact)){if(process.env[name]?.trim().toLowerCase()!==wanted)problems.push(`${name}: ska vara ${wanted}`);}
for(const name of verified){if(process.env[name]?.trim().toLowerCase()!=='true')problems.push(`${name}: ska vara true efter verifiering`);}
for(const name of urls){try{const url=new URL(process.env[name]??'');if(url.protocol!=='https:'||url.username||url.password)throw new Error();}catch{problems.push(`${name}: ska vara en giltig https-URL`);}}
for(const name of ['SENSITIVE_DATA_ENCRYPTION_KEY_BASE64','SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64']){const value=process.env[name];if(value){try{if(Buffer.from(value,'base64').length<32)problems.push(`${name}: minst 32 byte krävs`);}catch{problems.push(`${name}: ogiltig base64`);}}}
for(const name of ['INTERNAL_GATEWAY_HMAC_KEY','CSRF_SIGNING_KEY','TRUSTED_PROXY_SHARED_SECRET','TIC_WEBHOOK_SECRET','RESEND_WEBHOOK_SECRET','VALIDATION_SERVICE_TOKEN']){const value=process.env[name];if(value&&value.length<32)problems.push(`${name}: minst 32 tecken krävs`);}
const authRedirects=new Set((process.env.SUPABASE_AUTH_ALLOWED_REDIRECT_URLS??'').split(',').map((value)=>value.trim()).filter(Boolean));
for(const requiredRedirect of ['https://app.kommunsign.se/aktivera/','https://app.kommunsign.se/aterstall/']){if(!authRedirects.has(requiredRedirect))problems.push(`SUPABASE_AUTH_ALLOWED_REDIRECT_URLS: saknar ${requiredRedirect}`);}
if(process.env.EMAIL_PROVIDER==='resend'&&process.env.EMAIL_DATA_RESIDENCY_APPROVED!=='true')problems.push('EMAIL_DATA_RESIDENCY_APPROVED: skriftligt beslut krävs för vald e-postleverantör');
if(problems.length){console.error('Produktionsmiljön är inte komplett:\n- '+problems.join('\n- '));process.exit(1);}
console.log('Produktionsmiljön är komplett och samtliga obligatoriska verifieringsflaggor är satta.');
