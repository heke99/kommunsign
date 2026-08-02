import { randomToken } from '../../../../../packages/crypto/src/tokens.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { canonicalHostname } from '../../../../../packages/custom-domains/src/index.js';
import type { AuthorizationCodeRecord, AuthorizationCodeStore, SessionBoundary } from '../../../../../packages/auth-broker/src/index.js';
import type { SqlDatabase } from '../../../../../packages/database/src/index.js';

export function createAuthorizationCodeStore(database: SqlDatabase): AuthorizationCodeStore {
  return {
    async create(record) {
      await database.transaction(async (transaction) => {
        await transaction.query(
          `insert into control.auth_authorization_codes
             (code_hash,tenant_id,destination_hostname,subject_id,auth_method,created_at,expires_at,used_at,revoked_at)
           values(decode($1,'hex'),$2,$3,$4,$5,$6,$7,$8,$9)`,
          [record.codeHash,record.tenantId,canonicalHostname(record.destinationHostname,{allowPlatformNamespace:true}),record.subjectId,record.authMethod,record.createdAt,record.expiresAt,record.usedAt??null,record.revokedAt??null],
        );
      });
    },
    async consume(codeHash, now) {
      return database.transaction(async (transaction) => {
        const result=await transaction.query<AuthCodeRow>(
          `update control.auth_authorization_codes
              set used_at=$2
            where code_hash=decode($1,'hex') and used_at is null and revoked_at is null and expires_at>$2
            returning encode(code_hash,'hex') as code_hash,tenant_id,destination_hostname,subject_id,auth_method,created_at,expires_at,used_at,revoked_at`,
          [codeHash,now.toISOString()],
        );
        const row=result.rows[0];
        return row?authorizationCodeRecord(row):null;
      });
    },
  };
}

export interface HostBoundSessionRecord {
  readonly tenantId?: string;
  readonly boundary: SessionBoundary;
  readonly hostname: string;
  readonly subjectId: string;
  readonly authenticationMethod: string;
  readonly expiresAt: string;
}

export function createApplicationSessionRepository(database: SqlDatabase): {
  create(record: HostBoundSessionRecord): Promise<{ readonly token:string; readonly expiresAt:string }>;
  resolve(input:{readonly token:string;readonly hostname:string;readonly boundary:SessionBoundary;readonly now?:Date}):Promise<HostBoundSessionRecord|null>;
  revoke(token:string):Promise<void>;
} {
  return {
    async create(record){
      const hostname=canonicalHostname(record.hostname,{allowPlatformNamespace:true});
      const token=randomToken(32); const tokenHash=await sha256Hex(token);
      await database.transaction(async transaction=>{
        await transaction.query(
          `insert into control.host_bound_sessions(token_hash,tenant_id,boundary,hostname,subject_id,authentication_method,expires_at)
           values(decode($1,'hex'),$2,$3,$4,$5,$6,$7)`,
          [tokenHash,record.tenantId??null,record.boundary,hostname,record.subjectId,record.authenticationMethod,record.expiresAt],
        );
      });
      return{token,expiresAt:record.expiresAt};
    },
    async resolve(input){
      const tokenHash=await sha256Hex(input.token);const now=input.now??new Date();const hostname=canonicalHostname(input.hostname,{allowPlatformNamespace:true});
      return database.transaction(async transaction=>{
        const result=await transaction.query<SessionRow>(
          `update control.host_bound_sessions set last_seen_at=$4
            where token_hash=decode($1,'hex') and hostname=$2 and boundary=$3 and revoked_at is null and expires_at>$4
            returning tenant_id,boundary,hostname,subject_id,authentication_method,expires_at`,
          [tokenHash,hostname,input.boundary,now.toISOString()],
        );
        const row=result.rows[0];return row?sessionRecord(row):null;
      });
    },
    async revoke(token){const tokenHash=await sha256Hex(token);await database.transaction(async transaction=>{await transaction.query(`update control.host_bound_sessions set revoked_at=coalesce(revoked_at,now()) where token_hash=decode($1,'hex')`,[tokenHash]);});},
  };
}

interface AuthCodeRow{readonly code_hash:string;readonly tenant_id:string;readonly destination_hostname:string;readonly subject_id:string;readonly auth_method:string;readonly created_at:string|Date;readonly expires_at:string|Date;readonly used_at:string|Date|null;readonly revoked_at:string|Date|null;}
function authorizationCodeRecord(row:AuthCodeRow):AuthorizationCodeRecord{return{codeHash:row.code_hash,tenantId:row.tenant_id,destinationHostname:row.destination_hostname,subjectId:row.subject_id,authMethod:row.auth_method,createdAt:iso(row.created_at),expiresAt:iso(row.expires_at),...(row.used_at?{usedAt:iso(row.used_at)}:{}),...(row.revoked_at?{revokedAt:iso(row.revoked_at)}:{})};}
interface SessionRow{readonly tenant_id:string|null;readonly boundary:SessionBoundary;readonly hostname:string;readonly subject_id:string;readonly authentication_method:string;readonly expires_at:string|Date;}
function sessionRecord(row:SessionRow):HostBoundSessionRecord{return{...(row.tenant_id?{tenantId:row.tenant_id}:{}),boundary:row.boundary,hostname:row.hostname,subjectId:row.subject_id,authenticationMethod:row.authentication_method,expiresAt:iso(row.expires_at)};}
function iso(value:string|Date):string{return value instanceof Date?value.toISOString():new Date(value).toISOString();}
