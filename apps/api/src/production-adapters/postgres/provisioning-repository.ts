import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { normalizeTenantSlug, platformDefaultHostname } from '../../../../../packages/custom-domains/src/index.js';
import { withTenantTransaction, type SqlDatabase, type SqlTransaction } from '../../../../../packages/database/src/index.js';
import type { TenantContext } from '../../../../../packages/contracts/src/index.js';
import type { ProductionInfrastructure } from './infrastructure.js';

export interface ProvisioningExecutionConfiguration {
  readonly rootDomain: string;
  readonly releaseVersion: string;
  readonly kmsKeyReference: string;
  readonly platformWildcardVerified: boolean;
  readonly bucketNames: readonly string[];
}

export interface ProvisioningExecutionResult {
  readonly requestId: string;
  readonly tenantId?: string;
  readonly status: 'completed' | 'waiting_for_external_dependency' | 'failed';
  readonly currentStep?: string;
  readonly blockingCode?: string;
}

interface RequestRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string | null;
  readonly status: string;
  readonly deployment_mode: 'shared_saas' | 'dedicated_data_plane' | 'customer_hosted';
  readonly region: string;
  readonly requested_by: string;
  readonly attempts: number | string;
  readonly organization_name: string;
  readonly organization_number: string;
  readonly primary_contact_name: string;
  readonly primary_email_ciphertext: Uint8Array;
  readonly applicant_visible_profile: Readonly<Record<string, unknown>>;
}

interface StepRow {
  readonly id: string;
  readonly status: string;
  readonly resource_reference: string | null;
}

interface ClaimedRequest {
  readonly request: RequestRow;
  readonly attemptNumber: number;
}

class ExternalDependencyError extends Error {
  constructor(readonly code: string, readonly step: string) {
    super(code);
  }
}

class ProvisioningStepError extends Error {
  constructor(readonly step: string, readonly causeValue: unknown) {
    super(causeValue instanceof Error ? causeValue.message : 'PROVISIONING_STEP_FAILED');
  }
}

class ProvisioningAlreadyRunningError extends Error {
  constructor() {
    super('PROVISIONING_ALREADY_RUNNING');
  }
}

export function createProvisioningRepository(
  controlDatabase: SqlDatabase,
  dataDatabase: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  configuration: ProvisioningExecutionConfiguration,
): { run(requestId: string, workerId: string): Promise<ProvisioningExecutionResult> } {
  return {
    async run(requestId, workerId) {
      if (!/^[0-9a-f-]{36}$/i.test(requestId)) throw new Error('PROVISIONING_REQUEST_ID_INVALID');
      if (!/^[A-Za-z0-9._:-]{3,200}$/.test(workerId)) throw new Error('PROVISIONING_WORKER_ID_INVALID');

      let claimed: ClaimedRequest;
      try {
        claimed = await claimRequest(controlDatabase, requestId);
      } catch (cause) {
        if (cause instanceof ProvisioningAlreadyRunningError) {
          return {
            requestId,
            status: 'waiting_for_external_dependency',
            blockingCode: 'PROVISIONING_ALREADY_RUNNING',
          };
        }
        throw cause;
      }

      const request = claimed.request;
      if (request.status === 'completed') {
        return {
          requestId,
          ...(request.tenant_id ? { tenantId: request.tenant_id } : {}),
          status: 'completed',
        };
      }

      try {
        const primaryEmail = await infrastructure.sensitiveData.decryptText(
          request.primary_email_ciphertext,
          'onboarding.primary_email',
        );

        await runStep(controlDatabase, request, claimed.attemptNumber, 'reserve_tenant_slug', workerId, async (transaction) => {
          const current = await currentTenantId(transaction, request.id);
          if (current) return tenantSlug(transaction, current);

          const slug = await allocateTenantSlug(transaction, request.organization_name, request.application_id);
          const inserted = await transaction.query<{ readonly id: string }>(
            `insert into control.platform_tenants(slug,legal_name,organization_number,status)
             values($1,$2,$3,'provisioning')
             returning id`,
            [slug, request.organization_name, request.organization_number],
          );
          const tenantId = required(inserted.rows[0], 'TENANT_CREATE_FAILED').id;
          await transaction.query(
            `update control.tenant_provisioning_requests
                set tenant_id=$2,updated_at=now()
              where id=$1`,
            [request.id, tenantId],
          );
          await transaction.query(
            `update control.onboarding_applications
                set linked_tenant_id=$2,updated_at=now()
              where id=$1`,
            [request.application_id, tenantId],
          );
          return slug;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_tenant', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          await tenantSlug(transaction, tenantId);
          return tenantId;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'assign_data_plane', workerId, async (transaction) => {
          const result = await transaction.query<{
            readonly id: string;
            readonly connection_secret_reference: string;
            readonly storage_secret_reference: string | null;
          }>(
            `select id,connection_secret_reference,storage_secret_reference
               from control.data_planes
              where deployment_mode=$1::control.deployment_mode
                and status='ready'
                and region=$2
              order by created_at
              limit 1`,
            [request.deployment_mode, request.region],
          );
          const dataPlane = result.rows[0];
          if (!dataPlane) throw new ExternalDependencyError('DATA_PLANE_NOT_READY', 'assign_data_plane');
          if (!dataPlane.storage_secret_reference) {
            throw new ExternalDependencyError('DATA_PLANE_STORAGE_SECRET_MISSING', 'assign_data_plane');
          }
          const tenantId = await requiredTenantId(transaction, request.id);
          await transaction.query(
            `insert into control.tenant_deployments
               (tenant_id,mode,region,data_plane_reference,object_storage_reference,queue_namespace,kms_key_reference,release_version)
             values($1,$2::control.deployment_mode,$3,$4,$5,$6,$7,$8)
             on conflict(tenant_id) do update set
               mode=excluded.mode,
               region=excluded.region,
               data_plane_reference=excluded.data_plane_reference,
               object_storage_reference=excluded.object_storage_reference,
               queue_namespace=excluded.queue_namespace,
               kms_key_reference=excluded.kms_key_reference,
               release_version=excluded.release_version,
               updated_at=now()`,
            [
              tenantId,
              request.deployment_mode,
              request.region,
              dataPlane.connection_secret_reference,
              dataPlane.storage_secret_reference,
              `tenant:${tenantId}`,
              configuration.kmsKeyReference,
              configuration.releaseVersion,
            ],
          );
          return dataPlane.id;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_environment', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          const dataPlaneId = await assignedDataPlaneId(transaction, tenantId);
          const inserted = await transaction.query<{ readonly id: string }>(
            `insert into control.tenant_environments(tenant_id,environment,data_plane_id,status)
             values($1,'production',$2,'onboarding')
             on conflict(tenant_id,environment) do update set
               data_plane_id=excluded.data_plane_id,
               updated_at=now()
             returning id`,
            [tenantId, dataPlaneId],
          );
          return required(inserted.rows[0], 'TENANT_ENVIRONMENT_CREATE_FAILED').id;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_default_domain', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          const slug = await tenantSlug(transaction, tenantId);
          const environmentId = await productionEnvironmentId(transaction, tenantId);
          const hostname = platformDefaultHostname(slug, configuration.rootDomain);
          const tokenHash = await sha256Hex(`${tenantId}:${hostname}:platform-managed`);
          const active = configuration.platformWildcardVerified;
          await transaction.query(
            `insert into control.tenant_domains
               (tenant_id,hostname,verification_token_hash,verification_status,tls_status,lifecycle_state,
                environment_id,normalized_hostname,domain_type,status,is_primary,is_platform_managed,provider,
                dns_verified_at,certificate_issued_at,last_health_check_at,last_health_status,activated_at,created_by)
             values($1,$2,decode($3,'hex'),$4,$5,$6,$7,$2,'platform_default',$8,$9,true,'vercel',
                    case when $9 then now() end,
                    case when $9 then now() end,
                    case when $9 then now() end,
                    case when $9 then 'healthy' end,
                    case when $9 then now() end,
                    $10)
             on conflict(normalized_hostname) do update set
               tenant_id=excluded.tenant_id,
               environment_id=excluded.environment_id,
               verification_status=excluded.verification_status,
               tls_status=excluded.tls_status,
               lifecycle_state=excluded.lifecycle_state,
               status=excluded.status,
               is_primary=excluded.is_primary,
               dns_verified_at=excluded.dns_verified_at,
               certificate_issued_at=excluded.certificate_issued_at,
               last_health_check_at=excluded.last_health_check_at,
               last_health_status=excluded.last_health_status,
               activated_at=excluded.activated_at,
               updated_at=now()`,
            [
              tenantId,
              hostname,
              tokenHash,
              active ? 'verified' : 'pending',
              active ? 'active' : 'pending',
              active ? 'active' : 'dns_challenge_created',
              environmentId,
              active ? 'active' : 'routing_pending',
              active,
              request.requested_by,
            ],
          );
          return hostname;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_storage_namespaces', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          const result = await infrastructure.objectStorage.provisionTenantNamespaces({
            tenantId,
            bucketNames: configuration.bucketNames,
            idempotencyKey: `tenant-storage:${tenantId}`,
          });
          return result.namespaceReference;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'seed_policies', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          await seedSharedDataPlane(dataDatabase, infrastructure, {
            tenantId,
            requestId: request.id,
            actorId: request.requested_by,
            legalName: request.organization_name,
            organizationNumber: request.organization_number,
            adminDisplayName: request.primary_contact_name,
            adminEmail: primaryEmail,
            applicationId: request.application_id,
          });
          return `tenant:${tenantId}:baseline`;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'seed_roles', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          return `tenant:${tenantId}:roles`;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_branding_draft', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          const designTokens = JSON.stringify({ primaryColor: '#174A7E', accentColor: '#F2B705' });
          const supportContact = JSON.stringify({ email: primaryEmail });
          const brandingConfiguration = JSON.stringify({
            productName: request.organization_name,
            primaryColor: '#174A7E',
            accentColor: '#F2B705',
            supportEmail: primaryEmail,
            locale: 'sv-SE',
            status: 'draft',
          });
          await transaction.query(
            `insert into control.tenant_branding(tenant_id,display_name,design_tokens,support_contact)
             values($1,$2,$3::jsonb,$4::jsonb)
             on conflict(tenant_id) do update set
               display_name=excluded.display_name,
               design_tokens=excluded.design_tokens,
               support_contact=excluded.support_contact,
               updated_at=now()`,
            [tenantId, request.organization_name, designTokens, supportContact],
          );
          await transaction.query(
            `insert into control.tenant_branding_versions(tenant_id,version,configuration,active,created_by)
             values($1,1,$2::jsonb,false,$3)
             on conflict(tenant_id,version) do update set
               configuration=excluded.configuration`,
            [tenantId, brandingConfiguration, request.requested_by],
          );
          return `tenant:${tenantId}:branding:1`;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_auth_draft', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          await transaction.query(
            `insert into control.onboarding_tasks(application_id,tenant_id,task_type,status,payload)
             select $1,$2,'configure_identity_provider','queued',$3::jsonb
              where not exists (
                select 1
                  from control.onboarding_tasks
                 where application_id=$1
                   and task_type='configure_identity_provider'
                   and status in ('queued','in_progress','blocked')
              )`,
            [
              request.application_id,
              tenantId,
              JSON.stringify({ identityAndAccess: request.applicant_visible_profile.identityAndAccess ?? {} }),
            ],
          );
          return `tenant:${tenantId}:auth-draft`;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'create_onboarding_checklist', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          const checklist = await transaction.query<{ readonly id: string }>(
            `insert into control.onboarding_checklists(application_id,tenant_id,environment,status)
             values($1,$2,'production','not_started')
             on conflict(application_id,environment) do update set tenant_id=excluded.tenant_id
             returning id`,
            [request.application_id, tenantId],
          );
          const checklistId = required(checklist.rows[0], 'ONBOARDING_CHECKLIST_CREATE_FAILED').id;
          const items = [
            ['identity_provider', 'identity'],
            ['branding_approval', 'branding'],
            ['default_domain_health', 'domain'],
            ['signature_provider', 'signing'],
            ['email_sender', 'notification'],
            ['acceptance_test', 'verification'],
          ] as const;
          for (const [itemKey, category] of items) {
            await transaction.query(
              `insert into control.onboarding_checklist_items(checklist_id,item_key,category,required,status)
               values($1,$2,$3,true,'not_started')
               on conflict(checklist_id,item_key) do nothing`,
              [checklistId, itemKey, category],
            );
          }
          return checklistId;
        });

        await runStep(controlDatabase, request, claimed.attemptNumber, 'invite_first_admin', workerId, async (transaction) => {
          const tenantId = await requiredTenantId(transaction, request.id);
          const queued = await infrastructure.queue.enqueue({
            tenantId,
            jobType: 'TENANT_ADMIN_INVITATION',
            idempotencyKey: `tenant-admin-invite:${tenantId}:${request.application_id}`,
            payload: {
              tenantId,
              applicationId: request.application_id,
              email: primaryEmail,
              destination: 'apply.kommunsign.se',
            },
          });
          return queued.jobId;
        });

        const tenantId = await controlDatabase.transaction(async (transaction) => requiredTenantId(transaction, request.id));
        if (!configuration.platformWildcardVerified) {
          const code = 'DEFAULT_TENANT_DOMAIN_EXTERNAL_VERIFICATION_REQUIRED';
          await markWaiting(controlDatabase, request.id, 'create_default_domain', code, claimed.attemptNumber);
          return {
            requestId,
            tenantId,
            status: 'waiting_for_external_dependency',
            currentStep: 'create_default_domain',
            blockingCode: code,
          };
        }

        await controlDatabase.transaction(async (transaction) => {
          await transaction.query(
            `update control.tenant_provisioning_requests
                set status='completed',current_step=null,blocking_code=null,completed_at=now(),updated_at=now()
              where id=$1`,
            [request.id],
          );
          await transaction.query(
            `update control.onboarding_applications
                set status='onboarding',status_version=status_version+1,updated_at=now()
              where id=$1
                and status='provisioning'`,
            [request.application_id],
          );
        });
        return { requestId, tenantId, status: 'completed' };
      } catch (cause) {
        const stepCause = cause instanceof ProvisioningStepError ? cause.causeValue : cause;
        const step = cause instanceof ProvisioningStepError ? cause.step : undefined;
        if (stepCause instanceof ExternalDependencyError) {
          await markWaiting(
            controlDatabase,
            requestId,
            stepCause.step,
            stepCause.code,
            claimed.attemptNumber,
          );
          const tenantId = await lookupTenantId(controlDatabase, requestId);
          return {
            requestId,
            ...(tenantId ? { tenantId } : {}),
            status: 'waiting_for_external_dependency',
            currentStep: stepCause.step,
            blockingCode: stepCause.code,
          };
        }
        const code = safeErrorCode(stepCause);
        const failed = await markFailed(controlDatabase, requestId, code, step, claimed.attemptNumber);
        return {
          requestId,
          ...(failed.tenantId ? { tenantId: failed.tenantId } : {}),
          status: 'failed',
          ...(failed.currentStep ? { currentStep: failed.currentStep } : {}),
          blockingCode: code,
        };
      }
    },
  };
}

async function claimRequest(database: SqlDatabase, requestId: string): Promise<ClaimedRequest> {
  return database.transaction(async (transaction) => {
    const request = await loadRequest(transaction, requestId, true);
    if (request.status === 'cancelled') throw new Error('PROVISIONING_REQUEST_CANCELLED');
    if (request.status === 'completed') {
      return { request, attemptNumber: Number(request.attempts) };
    }
    if (request.status === 'running') {
      const recent = await transaction.query<{ readonly recent: boolean }>(
        `select updated_at > now() - interval '15 minutes' as recent
           from control.tenant_provisioning_requests
          where id=$1`,
        [requestId],
      );
      if (recent.rows[0]?.recent) throw new ProvisioningAlreadyRunningError();
    }
    const claimed = await transaction.query<{ readonly attempts: number | string }>(
      `update control.tenant_provisioning_requests
          set status='running',attempts=attempts+1,blocking_code=null,updated_at=now()
        where id=$1
        returning attempts`,
      [requestId],
    );
    return {
      request,
      attemptNumber: Number(required(claimed.rows[0], 'PROVISIONING_CLAIM_FAILED').attempts),
    };
  });
}

async function runStep(
  database: SqlDatabase,
  request: RequestRow,
  attemptNumber: number,
  stepKey: string,
  workerId: string,
  work: (transaction: SqlTransaction) => Promise<string>,
): Promise<void> {
  const started = await database.transaction(async (transaction) => {
    const step = await transaction.query<StepRow>(
      `select id,status,resource_reference
         from control.tenant_provisioning_steps
        where provisioning_request_id=$1
          and step_key=$2
        for update`,
      [request.id, stepKey],
    );
    const row = required(step.rows[0], `PROVISIONING_STEP_MISSING:${stepKey}`);
    if (row.status === 'completed' || row.status === 'skipped') return false;
    await transaction.query(
      `update control.tenant_provisioning_steps
          set status='running',started_at=coalesce(started_at,now()),safe_error_code=null
        where id=$1`,
      [row.id],
    );
    await transaction.query(
      `insert into control.tenant_provisioning_attempts
         (provisioning_request_id,step_id,attempt_number,worker_id,result)
       values($1,$2,$3,$4,'started')
       on conflict(provisioning_request_id,step_id,attempt_number) do update set
         worker_id=excluded.worker_id,
         result='started',
         safe_error_code=null,
         finished_at=null`,
      [request.id, row.id, attemptNumber, workerId],
    );
    await transaction.query(
      `update control.tenant_provisioning_requests
          set current_step=$2,updated_at=now()
        where id=$1`,
      [request.id, stepKey],
    );
    return true;
  });
  if (!started) return;

  try {
    await database.transaction(async (transaction) => {
      const step = await transaction.query<StepRow>(
        `select id,status,resource_reference
           from control.tenant_provisioning_steps
          where provisioning_request_id=$1
            and step_key=$2
          for update`,
        [request.id, stepKey],
      );
      const row = required(step.rows[0], `PROVISIONING_STEP_MISSING:${stepKey}`);
      if (row.status === 'completed' || row.status === 'skipped') return;
      const reference = await work(transaction);
      await transaction.query(
        `update control.tenant_provisioning_steps
            set status='completed',resource_reference=$2,completed_at=now(),safe_error_code=null
          where id=$1`,
        [row.id, reference],
      );
      await transaction.query(
        `update control.tenant_provisioning_attempts
            set result='succeeded',finished_at=now(),safe_error_code=null
          where provisioning_request_id=$1
            and step_id=$2
            and attempt_number=$3`,
        [request.id, row.id, attemptNumber],
      );
    });
  } catch (cause) {
    throw new ProvisioningStepError(stepKey, cause);
  }
}

async function loadRequest(
  transaction: SqlTransaction,
  requestId: string,
  lock: boolean,
): Promise<RequestRow> {
  const result = await transaction.query<RequestRow>(
    `select r.id,r.application_id,r.tenant_id,r.status::text as status,
            r.deployment_mode::text as deployment_mode,r.region,r.requested_by,r.attempts,
            a.organization_name,a.organization_number,a.primary_contact_name,
            a.primary_email_ciphertext,a.applicant_visible_profile
       from control.tenant_provisioning_requests r
       join control.onboarding_applications a on a.id=r.application_id
      where r.id=$1${lock ? ' for update' : ''}`,
    [requestId],
  );
  return required(result.rows[0], 'PROVISIONING_REQUEST_NOT_FOUND');
}

async function allocateTenantSlug(
  transaction: SqlTransaction,
  legalName: string,
  applicationId: string,
): Promise<string> {
  let base: string;
  try {
    base = normalizeTenantSlug(legalName);
  } catch {
    base = `tenant-${applicationId.replace(/-/g, '').slice(0, 8)}`;
  }
  if (base.length < 3) base = `${base}-tenant`;
  await transaction.query(`select pg_advisory_xact_lock(hashtextextended('tenant-slug-allocation',0))`);
  for (let index = 0; index < 100; index += 1) {
    const suffix = index === 0 ? '' : `-${index + 1}`;
    const candidate = `${base.slice(0, 63 - suffix.length)}${suffix}`;
    const occupied = await transaction.query<{ readonly occupied: boolean }>(
      `select exists(select 1 from control.platform_tenants where slug=$1)
              or exists(select 1 from control.reserved_tenant_slugs where slug=$1) as occupied`,
      [candidate],
    );
    if (!occupied.rows[0]?.occupied) return candidate;
  }
  throw new Error('TENANT_SLUG_ALLOCATION_EXHAUSTED');
}

async function seedSharedDataPlane(
  database: SqlDatabase,
  infrastructure: ProductionInfrastructure,
  input: {
    readonly tenantId: string;
    readonly requestId: string;
    readonly actorId: string;
    readonly legalName: string;
    readonly organizationNumber: string;
    readonly adminDisplayName: string;
    readonly adminEmail: string;
    readonly applicationId: string;
  },
): Promise<void> {
  const context: TenantContext = {
    tenantId: input.tenantId,
    subjectId: input.actorId,
    requestId: input.requestId,
    authMethod: 'worker',
    source: 'deployment',
  };
  await withTenantTransaction(database, context, 'worker', async (transaction) => {
    const existingOrganization = await transaction.query<{ readonly id: string }>(
      `select id
         from app.organizations
        where tenant_id=$1
        order by created_at
        limit 1`,
      [input.tenantId],
    );
    let organizationId = existingOrganization.rows[0]?.id;
    if (!organizationId) {
      const organization = await transaction.query<{ readonly id: string }>(
        `insert into app.organizations(tenant_id,legal_name,organization_number)
         values($1,$2,$3)
         returning id`,
        [input.tenantId, input.legalName, input.organizationNumber],
      );
      organizationId = required(organization.rows[0], 'TENANT_ORGANIZATION_CREATE_FAILED').id;
    }

    const emailCiphertext = await infrastructure.sensitiveData.encryptText(
      input.adminEmail,
      'tenant.user_email',
    );
    const emailBlindIndex = await infrastructure.sensitiveData.blindIndex(
      input.adminEmail,
      'tenant.user_email',
    );
    const user = await transaction.query<{ readonly id: string }>(
      `insert into app.users(tenant_id,external_subject,display_name,email_ciphertext,email_blind_index)
       values($1,$2,$3,$4,$5)
       on conflict(tenant_id,external_subject) do update set
         display_name=excluded.display_name,
         email_ciphertext=excluded.email_ciphertext,
         email_blind_index=excluded.email_blind_index
       returning id`,
      [
        input.tenantId,
        `pending-invite:${input.applicationId}`,
        input.adminDisplayName,
        emailCiphertext,
        emailBlindIndex,
      ],
    );
    const userId = required(user.rows[0], 'TENANT_ADMIN_USER_CREATE_FAILED').id;

    const existingMembership = await transaction.query<{ readonly id: string }>(
      `select id
         from app.memberships
        where tenant_id=$1
          and user_id=$2
        order by created_at
        limit 1`,
      [input.tenantId, userId],
    );
    let membershipId = existingMembership.rows[0]?.id;
    if (!membershipId) {
      const membership = await transaction.query<{ readonly id: string }>(
        `insert into app.memberships(tenant_id,user_id,status)
         values($1,$2,'active')
         returning id`,
        [input.tenantId, userId],
      );
      membershipId = required(membership.rows[0], 'TENANT_ADMIN_MEMBERSHIP_CREATE_FAILED').id;
    } else {
      await transaction.query(
        `update app.memberships
            set status='active'
          where tenant_id=$1
            and id=$2`,
        [input.tenantId, membershipId],
      );
    }

    const rolePermissions: Readonly<Record<string, readonly string[]>> = {
      tenant_admin: [
        'case:create', 'case:send', 'case:cancel', 'case:read', 'case:remind',
        'document:add', 'document:download', 'signer:add', 'upload:create',
        'validation:read', 'evidence:download', 'policy:manage', 'integration:manage',
        'webhook:manage', 'event:read', 'template:read', 'template:manage',
        'audit:read', 'archive:manage', 'tenant:manage',
      ],
      tenant_security_admin: [
        'case:read', 'validation:read', 'policy:manage', 'audit:read',
        'event:read', 'integration:manage',
      ],
      document_creator: [
        'case:create', 'case:read', 'document:add', 'signer:add', 'upload:create', 'template:read',
      ],
      document_sender: [
        'case:create', 'case:send', 'case:cancel', 'case:read', 'case:remind',
        'document:add', 'document:download', 'signer:add', 'upload:create',
        'validation:read', 'evidence:download', 'template:read',
      ],
      auditor: ['case:read', 'validation:read', 'event:read', 'audit:read'],
      readonly: ['case:read', 'template:read'],
    };

    for (const [roleKey, permissions] of Object.entries(rolePermissions)) {
      const role = await transaction.query<{ readonly id: string }>(
        `insert into app.roles(tenant_id,role_key,permissions)
         values($1,$2,$3::jsonb)
         on conflict(tenant_id,role_key) do update set permissions=excluded.permissions
         returning id`,
        [input.tenantId, roleKey, JSON.stringify(permissions)],
      );
      if (roleKey === 'tenant_admin') {
        const roleId = required(role.rows[0], 'TENANT_ADMIN_ROLE_MISSING').id;
        await transaction.query(
          `insert into app.role_assignments(tenant_id,membership_id,role_id)
           select $1,$2,$3
            where not exists (
              select 1
                from app.role_assignments
               where tenant_id=$1
                 and membership_id=$2
                 and role_id=$3
            )`,
          [input.tenantId, membershipId, roleId],
        );
      }
    }

    const policies = [
      ['Digitalt godkännande', 'DIGITAL_APPROVAL', {
        requiresIdentity: false,
        requiresCryptographicSignature: false,
      }],
      ['Elektronisk underskrift', 'ELECTRONIC_SIGNATURE', {
        requiresIdentity: true,
        requiresCryptographicSignature: true,
        signatureFormat: 'PAdES',
      }],
    ] as const;
    for (const [name, decisionMode, policy] of policies) {
      await transaction.query(
        `insert into app.signature_policies(tenant_id,version,name,decision_mode,policy,active,created_by)
         select $1,1,$2,$3::app.decision_mode,$4::jsonb,true,$5
          where not exists (
            select 1
              from app.signature_policies
             where tenant_id=$1
               and name=$2
               and version=1
          )`,
        [input.tenantId, name, decisionMode, JSON.stringify(policy), userId],
      );
    }

    void organizationId;
  });
}

async function assignedDataPlaneId(transaction: SqlTransaction, tenantId: string): Promise<string> {
  const existing = await transaction.query<{ readonly data_plane_id: string }>(
    `select data_plane_id
       from control.tenant_environments
      where tenant_id=$1
        and environment='production'`,
    [tenantId],
  );
  if (existing.rows[0]) return existing.rows[0].data_plane_id;
  const deployment = await transaction.query<{ readonly id: string }>(
    `select dp.id
       from control.tenant_deployments td
       join control.data_planes dp
         on dp.connection_secret_reference=td.data_plane_reference
      where td.tenant_id=$1`,
    [tenantId],
  );
  return required(deployment.rows[0], 'ASSIGNED_DATA_PLANE_NOT_FOUND').id;
}

async function productionEnvironmentId(transaction: SqlTransaction, tenantId: string): Promise<string> {
  const result = await transaction.query<{ readonly id: string }>(
    `select id
       from control.tenant_environments
      where tenant_id=$1
        and environment='production'`,
    [tenantId],
  );
  return required(result.rows[0], 'TENANT_ENVIRONMENT_NOT_FOUND').id;
}

async function tenantSlug(transaction: SqlTransaction, tenantId: string): Promise<string> {
  const result = await transaction.query<{ readonly slug: string }>(
    `select slug
       from control.platform_tenants
      where id=$1`,
    [tenantId],
  );
  return required(result.rows[0], 'TENANT_NOT_FOUND').slug;
}

async function currentTenantId(transaction: SqlTransaction, requestId: string): Promise<string | undefined> {
  const result = await transaction.query<{ readonly tenant_id: string | null }>(
    `select tenant_id
       from control.tenant_provisioning_requests
      where id=$1`,
    [requestId],
  );
  return result.rows[0]?.tenant_id ?? undefined;
}

async function requiredTenantId(transaction: SqlTransaction, requestId: string): Promise<string> {
  const tenantId = await currentTenantId(transaction, requestId);
  return requiredString(tenantId, 'TENANT_ID_MISSING');
}

async function lookupTenantId(database: SqlDatabase, requestId: string): Promise<string | undefined> {
  return database.transaction(async (transaction) => currentTenantId(transaction, requestId));
}

async function markWaiting(
  database: SqlDatabase,
  requestId: string,
  step: string,
  code: string,
  attemptNumber: number,
): Promise<void> {
  await database.transaction(async (transaction) => {
    await transaction.query(
      `update control.tenant_provisioning_requests
          set status='waiting_for_external_dependency',current_step=$2,blocking_code=$3,updated_at=now()
        where id=$1`,
      [requestId, step, code],
    );
    const stepRow = await transaction.query<{ readonly id: string }>(
      `update control.tenant_provisioning_steps
          set status='waiting',safe_error_code=$3
        where provisioning_request_id=$1
          and step_key=$2
        returning id`,
      [requestId, step, code],
    );
    const stepId = stepRow.rows[0]?.id;
    if (stepId) {
      await transaction.query(
        `update control.tenant_provisioning_attempts
            set result='retryable_failure',safe_error_code=$4,finished_at=now()
          where provisioning_request_id=$1
            and step_id=$2
            and attempt_number=$3`,
        [requestId, stepId, attemptNumber, code],
      );
    }
  });
}

async function markFailed(
  database: SqlDatabase,
  requestId: string,
  code: string,
  explicitStep: string | undefined,
  attemptNumber: number,
): Promise<{ readonly tenantId?: string; readonly currentStep?: string }> {
  return database.transaction(async (transaction) => {
    const result = await transaction.query<{
      readonly tenant_id: string | null;
      readonly current_step: string | null;
    }>(
      `update control.tenant_provisioning_requests
          set status='failed',blocking_code=$2,updated_at=now()
        where id=$1
        returning tenant_id,current_step`,
      [requestId, code],
    );
    const row = result.rows[0];
    const currentStep = explicitStep ?? row?.current_step ?? undefined;
    if (currentStep) {
      const stepRow = await transaction.query<{ readonly id: string }>(
        `update control.tenant_provisioning_steps
            set status='failed',safe_error_code=$3
          where provisioning_request_id=$1
            and step_key=$2
          returning id`,
        [requestId, currentStep, code],
      );
      const stepId = stepRow.rows[0]?.id;
      if (stepId) {
        await transaction.query(
          `update control.tenant_provisioning_attempts
              set result='permanent_failure',safe_error_code=$4,finished_at=now()
            where provisioning_request_id=$1
              and step_id=$2
              and attempt_number=$3`,
          [requestId, stepId, attemptNumber, code],
        );
      }
    }
    return {
      ...(row?.tenant_id ? { tenantId: row.tenant_id } : {}),
      ...(currentStep ? { currentStep } : {}),
    };
  });
}

function safeErrorCode(cause: unknown): string {
  const value = cause instanceof Error ? cause.message : 'PROVISIONING_UNKNOWN_FAILURE';
  return value.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 120) || 'PROVISIONING_UNKNOWN_FAILURE';
}

function required<T>(value: T | undefined, code: string): T {
  if (value === undefined) throw new Error(code);
  return value;
}

function requiredString(value: string | undefined, code: string): string {
  if (!value) throw new Error(code);
  return value;
}
