import { randomToken } from '../../../../../packages/crypto/src/tokens.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { canonicalHostname } from '../../../../../packages/custom-domains/src/index.js';
import type { DomainChallenge, DomainProvider } from '../../../../../packages/domain-provider/src/index.js';
import type { SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { ProductionInfrastructure } from './infrastructure.js';

export interface ManagedDomainView {
  readonly id:string;readonly tenantId:string;readonly environmentId:string;readonly hostname:string;
  readonly status:string;readonly isPrimary:boolean;readonly provider:string;readonly providerDomainId?:string;
}

export function createDomainManagementRepository(database:SqlDatabase,provider:DomainProvider,infrastructure:ProductionInfrastructure){
  return{
    async requestCustomDomain(input:{readonly tenantId:string;readonly environmentId:string;readonly hostname:string;readonly actorId:string;readonly idempotencyKey:string}):Promise<ManagedDomainView>{
      const hostname=canonicalHostname(input.hostname);
      const providerResult=await provider.requestDomain({...input,hostname});
      const verificationTokenHash=await sha256Hex(randomToken(32));
      return database.transaction(async transaction=>{
        const environment=await transaction.query<{readonly id:string}>(`select id from control.tenant_environments where id=$1 and tenant_id=$2`,[input.environmentId,input.tenantId]);
        if(!environment.rows[0])throw new Error('TENANT_ENVIRONMENT_NOT_FOUND');
        const result=await transaction.query<DomainRow>(
          `insert into control.tenant_domains
             (tenant_id,hostname,verification_token_hash,verification_status,tls_status,lifecycle_state,environment_id,
              normalized_hostname,domain_type,status,is_primary,is_platform_managed,provider,provider_domain_id,created_by)
           values($1,$2,decode($3,'hex'),'pending','pending','requested',$4,$2,'customer_custom','requested',false,false,$5,$6,$7)
           returning ${domainColumns}`,
          [input.tenantId,hostname,verificationTokenHash,input.environmentId,providerResult.provider,providerResult.providerDomainId,input.actorId],
        );
        const row=required(result.rows[0],'CUSTOM_DOMAIN_CREATE_FAILED');
        await recordProviderOperation(transaction,row,input.idempotencyKey,'request','succeeded');
        return view(row);
      });
    },
    async createChallenge(input:{readonly tenantId:string;readonly domainId:string;readonly idempotencyKey:string}):Promise<DomainChallenge>{
      const row=await getDomain(database,input.tenantId,input.domainId);
      const challenge=await provider.createVerificationChallenge({hostname:row.hostname,tenantId:row.tenant_id,environmentId:row.environment_id,idempotencyKey:input.idempotencyKey});
      const valueHash=await sha256Hex(`${row.tenant_id}:${row.hostname}:${challenge.recordValue}`);
      const ciphertext=await infrastructure.sensitiveData.encryptText(challenge.recordValue,`domain.challenge.${row.id}`);
      await database.transaction(async transaction=>{
        await transaction.query(`update control.domain_verification_challenges set revoked_at=coalesce(revoked_at,now()) where tenant_domain_id=$1 and verified_at is null and revoked_at is null`,[row.id]);
        await transaction.query(
          `insert into control.domain_verification_challenges
             (tenant_id,environment_id,tenant_domain_id,token_hash,record_name,record_type,record_value_hash,record_value_ciphertext,expires_at)
           values($1,$2,$3,decode($4,'hex'),$5,'TXT',decode($6,'hex'),$7,$8)`,
          [row.tenant_id,row.environment_id,row.id,await sha256Hex(randomToken(32)),challenge.recordName,valueHash,ciphertext,challenge.expiresAt],
        );
        await transaction.query(
          `update control.tenant_domains set status='dns_challenge_created',verification_record_name=$2,
             verification_record_type='TXT',verification_record_value=null,verification_expires_at=$3 where id=$1`,
          [row.id,challenge.recordName,challenge.expiresAt],
        );
        await recordProviderOperation(transaction,row,input.idempotencyKey,'verify_dns','queued');
      });
      return challenge;
    },
    async currentChallenge(input:{readonly tenantId:string;readonly domainId:string}):Promise<DomainChallenge|null>{
      const result=await database.transaction(async transaction=>transaction.query<ChallengeRow>(
        `select c.record_name,c.record_type,c.record_value_ciphertext,c.expires_at
           from control.domain_verification_challenges c join control.tenant_domains d on d.id=c.tenant_domain_id
          where c.tenant_domain_id=$1 and d.tenant_id=$2 and c.revoked_at is null and c.verified_at is null and c.expires_at>now()
          order by c.created_at desc limit 1`,[input.domainId,input.tenantId],
      ));
      const challenge=result.rows[0];if(!challenge)return null;
      return{recordName:challenge.record_name,recordType:'TXT',recordValue:await infrastructure.sensitiveData.decryptText(challenge.record_value_ciphertext,`domain.challenge.${input.domainId}`),expiresAt:iso(challenge.expires_at)};
    },
    async verifyAndAttach(input:{readonly tenantId:string;readonly domainId:string;readonly idempotencyKey:string}):Promise<ManagedDomainView>{
      const row=await getDomain(database,input.tenantId,input.domainId);
      const challenge=await this.currentChallenge(input);if(!challenge)throw new Error('DOMAIN_CHALLENGE_NOT_AVAILABLE');
      const verified=await provider.verifyDns({hostname:row.hostname,tenantId:row.tenant_id,environmentId:row.environment_id,idempotencyKey:input.idempotencyKey,challenge});
      if(!verified.verified){await setDomainStatus(database,row.id,'dns_verification_pending');throw new Error('CUSTOM_DOMAIN_DNS_NOT_VERIFIED');}
      const attachment=await provider.attachDomain({hostname:row.hostname,tenantId:row.tenant_id,environmentId:row.environment_id,idempotencyKey:input.idempotencyKey});
      return database.transaction(async transaction=>{
        await transaction.query(`update control.domain_verification_challenges set verified_at=now() where tenant_domain_id=$1 and revoked_at is null and verified_at is null`,[row.id]);
        const result=await transaction.query<DomainRow>(
          `update control.tenant_domains set status='certificate_pending',verification_status='verified',lifecycle_state='certificate_pending',
             dns_verified_at=now(),verified_at=coalesce(verified_at,now()),provider_domain_id=$2 where id=$1 returning ${domainColumns}`,
          [row.id,attachment.providerDomainId],
        );
        await recordProviderOperation(transaction,row,input.idempotencyKey,'attach','succeeded');
        return view(required(result.rows[0],'CUSTOM_DOMAIN_UPDATE_FAILED'));
      });
    },
    async checkCertificateAndHealth(input:{readonly tenantId:string;readonly domainId:string;readonly idempotencyKey:string}):Promise<ManagedDomainView>{
      const row=await getDomain(database,input.tenantId,input.domainId);
      const certificate=await provider.getCertificateStatus({hostname:row.hostname,tenantId:row.tenant_id,environmentId:row.environment_id,idempotencyKey:input.idempotencyKey});
      if(certificate.status!=='issued')throw new Error('CUSTOM_DOMAIN_CERTIFICATE_NOT_READY');
      const health=await provider.healthCheck({hostname:row.hostname,tenantId:row.tenant_id,environmentId:row.environment_id,idempotencyKey:input.idempotencyKey,expectedTenantId:row.tenant_id});
      return database.transaction(async transaction=>{
        await transaction.query(
          `insert into control.domain_certificate_snapshots(tenant_id,environment_id,tenant_domain_id,provider,status,not_before,not_after,fingerprint_sha256)
           values($1,$2,$3,$4,$5,$6,$7,$8)`,
          [row.tenant_id,row.environment_id,row.id,row.provider,certificate.status,certificate.issuedAt??null,certificate.expiresAt??null,certificate.fingerprintSha256??null],
        );
        for(const [checkType,passed] of Object.entries(health.checks)){
          await transaction.query(
            `insert into control.domain_health_checks(tenant_id,environment_id,tenant_domain_id,check_type,status,safe_error_code,evidence)
             values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
            [row.tenant_id,row.environment_id,row.id,normalizeCheckType(checkType),passed?'healthy':'failed',passed?null:health.safeErrorCode??'DOMAIN_HEALTH_FAILED',{passed}],
          );
        }
        const status=health.status==='healthy'?'active':'failed';
        const result=await transaction.query<DomainRow>(
          `update control.tenant_domains set status=$2::control.domain_status,tls_status=$3,lifecycle_state=$4,
             certificate_issued_at=$5,certificate_expires_at=$6,last_health_check_at=$7,last_health_status=$8,
             activated_at=case when $2='active' then coalesce(activated_at,now()) else activated_at end
           where id=$1 returning ${domainColumns}`,
          [row.id,status,health.status==='healthy'?'active':'failed',health.status==='healthy'?'active':'suspended',certificate.issuedAt??new Date().toISOString(),certificate.expiresAt??null,health.checkedAt,health.status],
        );
        return view(required(result.rows[0],'CUSTOM_DOMAIN_HEALTH_UPDATE_FAILED'));
      });
    },
    async makePrimary(input:{readonly tenantId:string;readonly environmentId:string;readonly domainId:string;readonly requestedBy:string;readonly approvedBy:string;readonly reason:string}):Promise<void>{
      await database.transaction(async transaction=>{await transaction.query(`select control.set_primary_tenant_domain($1,$2,$3,$4,$5,$6)`,[input.tenantId,input.environmentId,input.domainId,input.requestedBy,input.approvedBy,input.reason]);});
    },
    async remove(input:{readonly tenantId:string;readonly domainId:string;readonly idempotencyKey:string}):Promise<void>{
      const row=await getDomain(database,input.tenantId,input.domainId);if(row.is_primary)throw new Error('PRIMARY_DOMAIN_REMOVAL_FORBIDDEN');
      await provider.removeDomain({hostname:row.hostname,tenantId:row.tenant_id,environmentId:row.environment_id,idempotencyKey:input.idempotencyKey});
      await database.transaction(async transaction=>{await transaction.query(`update control.tenant_domains set status='removed',verification_status='revoked',tls_status='revoked',lifecycle_state='removed',removed_at=now() where id=$1`,[row.id]);await recordProviderOperation(transaction,row,input.idempotencyKey,'remove','succeeded');});
    },
  };
}

interface DomainRow{readonly id:string;readonly tenant_id:string;readonly environment_id:string;readonly hostname:string;readonly normalized_hostname:string;readonly status:string;readonly is_primary:boolean;readonly provider:string;readonly provider_domain_id:string|null;}
const domainColumns=`id,tenant_id,environment_id,hostname,normalized_hostname,status::text as status,is_primary,provider,provider_domain_id`;
async function getDomain(database:SqlDatabase,tenantId:string,domainId:string):Promise<DomainRow>{return database.transaction(async transaction=>{const result=await transaction.query<DomainRow>(`select ${domainColumns} from control.tenant_domains where id=$1 and tenant_id=$2`,[domainId,tenantId]);return required(result.rows[0],'DOMAIN_NOT_FOUND');});}
async function setDomainStatus(database:SqlDatabase,id:string,status:string):Promise<void>{await database.transaction(async transaction=>{await transaction.query(`update control.tenant_domains set status=$2::control.domain_status where id=$1`,[id,status]);});}
async function recordProviderOperation(transaction:import('../../../../../packages/database/src/index.js').SqlTransaction,row:DomainRow,key:string,operation:string,status:string):Promise<void>{const fingerprint=await sha256Hex(`${row.tenant_id}:${row.id}:${operation}:${key}`);await transaction.query(`insert into control.domain_provider_operations(tenant_id,environment_id,tenant_domain_id,provider,operation,idempotency_key,status,request_fingerprint,completed_at) values($1,$2,$3,$4,$5,$6,$7,$8,case when $7='succeeded' then now() end) on conflict(provider,operation,idempotency_key) do nothing`,[row.tenant_id,row.environment_id,row.id,row.provider,operation,key,status,fingerprint]);}
function view(row:DomainRow):ManagedDomainView{return{id:row.id,tenantId:row.tenant_id,environmentId:row.environment_id,hostname:row.normalized_hostname,status:row.status,isPrimary:row.is_primary,provider:row.provider,...(row.provider_domain_id?{providerDomainId:row.provider_domain_id}:{})};}
interface ChallengeRow{readonly record_name:string;readonly record_type:string;readonly record_value_ciphertext:Uint8Array;readonly expires_at:string|Date;}
function iso(value:string|Date):string{return value instanceof Date?value.toISOString():new Date(value).toISOString();}
function normalizeCheckType(value:string):string{const map:Readonly<Record<string,string>>={tls:'tls',routing:'routing',tenantResolution:'tenant_resolution',authCallback:'auth_callback',sameOriginApi:'same_origin_api',signerFlow:'signer_flow',takeoverProtection:'takeover_protection'};return map[value]??'routing';}
function required<T>(value:T|undefined,code:string):T{if(value===undefined)throw new Error(code);return value;}
