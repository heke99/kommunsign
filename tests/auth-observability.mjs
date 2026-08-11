import assert from 'node:assert/strict';
import { productionAuthTimingSink, withAuthenticationOperationTiming, withAuthenticationSqlTiming } from '../dist/apps/api/src/production-adapters/postgres/authentication-observability.js';

const observations=[];
const sink={observe(metric,milliseconds,labels={}){observations.push({metric,milliseconds,labels});}};
const database={
  async transaction(work){
    return work({async query(sql){return {rows:sql.includes('returning')?[{id:'x'}]:[],rowCount:0};}});
  },
};
const timed=withAuthenticationSqlTiming(database,sink,'control');
await timed.transaction(async(tx)=>{
  await tx.query(`insert into control.auth_rate_limit_buckets(action,bucket_hash) values('login','x') returning attempts`);
  await tx.query(`select s.id from control.platform_subjects s where s.id=$1`);
  await tx.query(`select d.tenant_id from control.tenant_domains d where d.normalized_hostname=$1`);
  await tx.query(`insert into control.host_bound_sessions(token_hash) values('x')`);
  await tx.query(`update control.host_bound_sessions set last_seen_at=now() where id=$1`);
});
for(const metric of ['auth.rate_limit_ms','auth.platform_lookup_ms','auth.tenant_resolution_ms','auth.session_create_ms','auth.session_verify_ms']) {
  assert.ok(observations.some((entry)=>entry.metric===metric),`missing ${metric}`);
}
const repository={
  async login(){return {sessionToken:'opaque',csrfToken:'opaque',subjectId:'00000000-0000-4000-8000-000000000001',boundary:'tenant',tenantId:'00000000-0000-4000-8000-000000000002',destinationUrl:'https://tenant.kommunsign.se/',expiresAt:new Date(Date.now()+1000).toISOString()};},
  async forgotPassword(){return {accepted:true};},
  async completePassword(){return {sessionToken:'opaque',csrfToken:'opaque',subjectId:'00000000-0000-4000-8000-000000000001',boundary:'tenant',tenantId:'00000000-0000-4000-8000-000000000002',destinationUrl:'https://tenant.kommunsign.se/',expiresAt:new Date(Date.now()+1000).toISOString()};},
  async session(){return {csrfToken:'opaque',subjectId:'00000000-0000-4000-8000-000000000001',boundary:'tenant',tenantId:'00000000-0000-4000-8000-000000000002',destinationUrl:'https://tenant.kommunsign.se/',expiresAt:new Date(Date.now()+1000).toISOString()};},
  async logout(){return {loggedOut:true};},
  async listOrganizationUsers(){return [];},
  async inviteOrganizationUser(){throw new Error('unused');},
  async setOrganizationUserStatus(){throw new Error('unused');},
};
const wrapped=withAuthenticationOperationTiming(repository,sink);
await wrapped.login({email:'person@example.se',password:'not-used'},{ipAddress:'127.0.0.1',userAgent:'test'});
assert.ok(observations.some((entry)=>entry.metric==='auth.total_ms'&&entry.labels.operation==='login'));
assert.ok(observations.some((entry)=>entry.metric==='auth.redirect_ms'&&entry.labels.operation==='login'));
assert.ok(observations.every((entry)=>!JSON.stringify(entry.labels).includes('person@example.se')));

const originalInfo=console.info;
let emitted='';
console.info=(value)=>{emitted+=String(value);};
try { productionAuthTimingSink().observe('auth.total_ms',12.345,{operation:'login',email:'person@example.se'}); }
finally { console.info=originalInfo; }
assert.ok(emitted.includes('auth.total_ms'));
assert.ok(!emitted.includes('person@example.se'));
console.log('Auth observability verification: OK');
