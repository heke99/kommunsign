import type { SqlDatabase, SqlTransaction, QueryResult } from '../../../../../packages/database/src/index.js';
import { SupabaseAuthProvider, type SupabaseAuthConfiguration, type SupabaseAuthUser, type SupabaseManagedUserResolution, type SupabasePasswordSession } from '../../../../../packages/provider-adapters/src/supabase-auth.js';
import type { AuthenticationRepository } from '../../ports.js';

export type AuthTimingMetric =
  | 'auth.rate_limit_ms'
  | 'auth.provider_ms'
  | 'auth.platform_lookup_ms'
  | 'auth.membership_lookup_ms'
  | 'auth.tenant_resolution_ms'
  | 'auth.authorization_ms'
  | 'auth.session_create_ms'
  | 'auth.session_verify_ms'
  | 'auth.redirect_ms'
  | 'auth.total_ms';

export interface AuthTimingSink {
  observe(metric: AuthTimingMetric, milliseconds: number, labels?: Readonly<Record<string,string>>): void;
}

export function productionAuthTimingSink(): AuthTimingSink {
  return {
    observe(metric,milliseconds,labels={}) {
      const value=Math.max(0,Math.round(milliseconds*1000)/1000);
      console.info(JSON.stringify({level:'info',service:'kommunsign-api',kind:'metric',metric,value,unit:'ms',...safeLabels(labels)}));
    },
  };
}

export function withAuthenticationSqlTiming(database:SqlDatabase,sink:AuthTimingSink,source:'control'|'data'):SqlDatabase {
  return {
    transaction<T>(work:(transaction:SqlTransaction)=>Promise<T>):Promise<T> {
      return database.transaction((transaction)=>work({
        async query<Row=Readonly<Record<string,unknown>>>(sql:string,parameters?:readonly unknown[]):Promise<QueryResult<Row>> {
          const metric=classifyAuthQuery(sql);
          if (!metric) return transaction.query<Row>(sql,parameters);
          const started=performance.now();
          try { return await transaction.query<Row>(sql,parameters); }
          finally { sink.observe(metric,performance.now()-started,{source}); }
        },
      }));
    },
  };
}

export class TimedSupabaseAuthProvider extends SupabaseAuthProvider {
  constructor(configuration:SupabaseAuthConfiguration,private readonly sink:AuthTimingSink) { super(configuration); }
  override signInWithPassword(email:string,password:string):Promise<SupabasePasswordSession> { return this.timed('sign_in',()=>super.signInWithPassword(email,password)); }
  override getUser(accessToken:string):Promise<SupabaseAuthUser> { return this.timed('get_user',()=>super.getUser(accessToken)); }
  override verifyEmailOtp(tokenHash:string,type:'invite'|'recovery'):Promise<SupabasePasswordSession> { return this.timed('verify_email_otp',()=>super.verifyEmailOtp(tokenHash,type)); }
  override updatePassword(accessToken:string,password:string):Promise<SupabaseAuthUser> { return this.timed('update_password',()=>super.updatePassword(accessToken,password)); }
  override async sendPasswordRecovery(email:string,redirectTo:string):Promise<void> { await this.timed('password_recovery',()=>super.sendPasswordRecovery(email,redirectTo)); }
  override inviteOrFindUser(email:string,redirectTo:string,metadata:Readonly<Record<string,unknown>>):Promise<SupabaseManagedUserResolution> { return this.timed('invite_or_find',()=>super.inviteOrFindUser(email,redirectTo,metadata)); }
  private async timed<T>(operation:string,work:()=>Promise<T>):Promise<T> {
    const started=performance.now();
    try { return await work(); }
    finally { this.sink.observe('auth.provider_ms',performance.now()-started,{operation}); }
  }
}

export function withAuthenticationOperationTiming(repository:AuthenticationRepository,sink:AuthTimingSink):AuthenticationRepository {
  return {
    ...repository,
    async login(input,metadata) {
      const started=performance.now();
      try {
        const result=await repository.login(input,metadata);
        measureRedirect(result.destinationUrl,sink,'login');
        return result;
      } finally { sink.observe('auth.total_ms',performance.now()-started,{operation:'login'}); }
    },
    async completePassword(input,metadata) {
      const started=performance.now();
      try {
        const result=await repository.completePassword(input,metadata);
        measureRedirect(result.destinationUrl,sink,'password_complete');
        return result;
      } finally { sink.observe('auth.total_ms',performance.now()-started,{operation:'password_complete'}); }
    },
    async session(sessionToken,originHostname) {
      const started=performance.now();
      try { return await repository.session(sessionToken,originHostname); }
      finally { sink.observe('auth.total_ms',performance.now()-started,{operation:'session'}); }
    },
  };
}

function measureRedirect(destinationUrl:string,sink:AuthTimingSink,operation:string):void {
  const started=performance.now();
  const parsed=new URL(destinationUrl);
  if (parsed.protocol!=='https:') throw new Error('AUTH_REDIRECT_URL_INVALID');
  sink.observe('auth.redirect_ms',performance.now()-started,{operation});
}

function classifyAuthQuery(sql:string):Exclude<AuthTimingMetric,'auth.provider_ms'|'auth.redirect_ms'|'auth.total_ms'>|null {
  const normalized=sql.toLowerCase().replace(/\s+/g,' ');
  if (normalized.includes('auth_rate_limit_buckets')) return 'auth.rate_limit_ms';
  if (normalized.includes('host_bound_sessions')) {
    if (normalized.includes('insert into control.host_bound_sessions')) return 'auth.session_create_ms';
    if (normalized.includes('last_seen_at=now()')) return 'auth.session_verify_ms';
  }
  if (normalized.includes('tenant_domains')) return 'auth.tenant_resolution_ms';
  if (normalized.includes('platform_subjects')) return normalized.includes('display_name') ? 'auth.authorization_ms' : 'auth.platform_lookup_ms';
  // The login membership lookup now goes through a SECURITY DEFINER resolver, so its SQL no longer
  // names the underlying tables. Without this the metric would silently stop being emitted.
  if (normalized.includes('subject_membership_destinations')) return 'auth.membership_lookup_ms';
  if (normalized.includes('app.memberships') && normalized.includes('app.users')) return normalized.includes('display_name') ? 'auth.authorization_ms' : 'auth.membership_lookup_ms';
  return null;
}

function safeLabels(labels:Readonly<Record<string,string>>):Readonly<Record<string,string>> {
  const output:Record<string,string>={};
  for (const [key,value] of Object.entries(labels)) {
    if (/^[a-z][a-z0-9_.-]{0,40}$/.test(key) && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)) output[key]=value;
  }
  return output;
}
