declare const process: { readonly env: Readonly<Record<string, string | undefined>> };
import type { ApplicantContext, PlatformContext } from '../../../../../packages/contracts/src/index.js';
import { sha256Hex } from '../../../../../packages/crypto/src/hash.js';
import { randomToken } from '../../../../../packages/crypto/src/tokens.js';
import { base64Encode } from '../../../../../packages/crypto/src/base64.js';
import { normalizeEmail, normalizeOrganizationNumber, assertDistinctApprovers } from '../../../../../packages/onboarding/src/index.js';
import { evaluateReadiness, type ReadinessCheck, type ReadinessResult } from '../../../../../packages/readiness/src/index.js';
import type { SqlDatabase, SqlTransaction } from '../../../../../packages/database/src/index.js';
import type {
  ActivationRequestView, ApplicationCreatedView, ApplicationDocumentInput, ApplicationDocumentView,
  ApplicationProfile, ApplicationView, CreateApplicationInput, CreateOrganizationInput, DecisionInput, ExternalMessageInput,
  ExternalMessageView, InformationRequestInput, InformationRequestView, InformationResponseInput,
  OnboardingRepository, Page, PageInput, PlatformOrganizationView, ProvisioningRequestView, ReviewInput, UpdateApplicationInput,
} from '../../ports.js';
import type { ProductionInfrastructure } from './infrastructure.js';

interface ApplicationRow {
  readonly id: string;
  readonly application_reference: string | null;
  readonly status: ApplicationView['status'];
  readonly status_version: number | string;
  readonly organization_name: string;
  readonly organization_number: string;
  readonly organization_type: CreateApplicationInput['organizationType'];
  readonly primary_email_ciphertext: Uint8Array;
  readonly primary_contact_name: string;
  readonly primary_contact_title: string;
  readonly applicant_visible_profile: ApplicationProfile;
  readonly assigned_to: string | null;
  readonly linked_tenant_id: string | null;
  readonly email_verified_at: string | Date | null;
  readonly submitted_at: string | Date | null;
  readonly decided_at: string | Date | null;
  readonly created_at: string | Date;
  readonly updated_at: string | Date;
}
interface ProvisioningRow {
  readonly id: string; readonly application_id: string; readonly tenant_id: string | null;
  readonly status: ProvisioningRequestView['status']; readonly current_step: string | null;
  readonly blocking_code: string | null; readonly attempts: number; readonly created_at: string|Date; readonly updated_at: string|Date;
}
interface ActivationRow {
  readonly id:string; readonly tenant_id:string; readonly requested_by:string;
  readonly status:ActivationRequestView['status']; readonly created_at:string|Date; readonly decided_at:string|Date|null;
}
interface PlatformOrganizationRow extends ApplicationRow {
  readonly provisioning_request_id: string | null;
  readonly provisioning_status: ProvisioningRequestView['status'] | null;
  readonly provisioning_current_step: string | null;
  readonly provisioning_blocking_code: string | null;
  readonly provisioning_tenant_id: string | null;
  readonly tenant_status: PlatformOrganizationView['tenantStatus'] | null;
  readonly primary_hostname: string | null;
  readonly domain_ready: boolean;
}

export function createOnboardingRepository(database: SqlDatabase, infrastructure: ProductionInfrastructure): OnboardingRepository {
  return {
    async platformOrganizations(_context, page, filters) {
      return database.transaction(async (transaction) => {
        const { offset, limit } = pageBounds(page);
        const search = filters.search?.trim() || null;
        const status = filters.status?.trim() || null;
        const result = await transaction.query<PlatformOrganizationRow>(
          `${platformOrganizationSelect}
            where (a.linked_tenant_id is not null or pr.id is not null)
              and ($1::text is null or a.organization_name ilike '%'||$1||'%' or a.organization_number like '%'||$1||'%')
              and ($2::text is null or a.status::text=$2 or pr.status::text=$2 or t.status::text=$2)
            order by a.created_at desc,a.id desc
            offset $3 limit $4`,
          [search,status,offset,limit+1],
        );
        const views: PlatformOrganizationView[] = [];
        for (const row of result.rows) views.push(await platformOrganizationView(row,infrastructure));
        return pageResult(views,offset,limit);
      });
    },
    async createOrganization(context, input, key, payloadHash) {
      return controlIdempotent(database,infrastructure,'platform',context.subjectId,'organization:create',key,payloadHash,async (transaction) => {
        const organizationNumber=normalizeOrganizationNumber(input.organizationNumber);
        const primaryEmail=normalizeEmail(input.primaryAdminEmail);
        const duplicate=await transaction.query<{readonly id:string}>(
          `select id from control.onboarding_applications
            where organization_number=$1 and status not in ('rejected','withdrawn','archived')
            union all
           select id from control.platform_tenants where organization_number=$1 and status not in ('decommissioning','decommissioned')
           limit 1`,
          [organizationNumber],
        );
        if(duplicate.rows[0])throw new Error('ORGANIZATION_ALREADY_EXISTS');
        const emailCiphertext=await infrastructure.sensitiveData.encryptText(primaryEmail,'onboarding.primary_email');
        const emailBlindIndex=await infrastructure.sensitiveData.blindIndex(primaryEmail,'onboarding.primary_email');
        const reference=await transaction.query<{readonly reference:string}>(
          `select 'ONB-'||extract(year from now())::int||'-'||lpad(nextval('control.onboarding_application_reference_seq')::text,6,'0') as reference`,
        );
        const officialEmailDomain=primaryEmail.split('@')[1] ?? '';
        const profile:ApplicationProfile={officialEmailDomain,deployment:{mode:input.deploymentMode,region:input.region},plannedUse:{createdByPlatformAdmin:true}};
        const inserted=await transaction.query<ApplicationRow>(
          `insert into control.onboarding_applications
             (application_reference,status,status_version,organization_name,organization_number,organization_type,
              primary_email_ciphertext,primary_email_blind_index,primary_contact_name,primary_contact_title,
              applicant_visible_profile,assigned_to,email_verified_at,submitted_at,decided_at)
           values($1,'provisioning',2,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,now(),now(),now())
           returning ${applicationColumns}`,
          [requireRow(reference.rows[0],'APPLICATION_REFERENCE_FAILED').reference,cleanText(input.organizationName,2,300),organizationNumber,input.organizationType,
           emailCiphertext,emailBlindIndex,cleanText(input.primaryAdminName,2,200),cleanText(input.primaryAdminTitle,2,200),profile,context.subjectId],
        );
        const applicationRow=requireRow(inserted.rows[0],'APPLICATION_INSERT_FAILED');
        const application=await applicationView(applicationRow,infrastructure);
        await saveApplicationVersion(transaction,application,'platform',context.subjectId);
        const requestResult=await transaction.query<ProvisioningRow>(
          `insert into control.tenant_provisioning_requests
             (application_id,status,deployment_mode,region,requested_by,current_step,idempotency_key,payload_sha256)
           values($1,'queued',$2::control.deployment_mode,$3,$4,'reserve_tenant_slug',$5,$6)
           returning id,application_id,tenant_id,status::text as status,current_step,blocking_code,attempts,created_at,updated_at`,
          [application.id,input.deploymentMode,cleanText(input.region,2,100),context.subjectId,key,payloadHash],
        );
        const request=requireRow(requestResult.rows[0],'PROVISIONING_REQUEST_INSERT_FAILED');
        const steps=['reserve_tenant_slug','create_tenant','create_environment','assign_data_plane','create_default_domain','create_storage_namespaces','seed_policies','seed_roles','create_branding_draft','create_auth_draft','create_onboarding_checklist','enable_account_management'];
        for(let index=0;index<steps.length;index+=1)await transaction.query(
          `insert into control.tenant_provisioning_steps(provisioning_request_id,step_key,sequence_number,status) values($1,$2,$3,'pending')`,
          [request.id,steps[index],index+1],
        );
        await infrastructure.queue.enqueue({tenantId:'00000000-0000-0000-0000-000000000000',jobType:'TENANT_PROVISION',idempotencyKey:`tenant-provision:${request.id}`,payload:{provisioningRequestId:request.id,applicationId:application.id}});
        await appendControlAudit(transaction,null,context.subjectId,'organization.created_and_provisioning_queued',{applicationId:application.id,requestId:request.id,organizationNumber});
        const row=await platformOrganizationByApplication(transaction,application.id);
        return platformOrganizationView(row,infrastructure);
      });
    },
    async create(input, key, payloadHash) {
      return controlIdempotent(database,infrastructure, 'public', 'public', 'application:create', key, payloadHash, async (transaction) => {
        const organizationNumber = normalizeOrganizationNumber(input.organizationNumber);
        const primaryEmail = normalizeEmail(input.primaryEmail);
        const emailCiphertext = await infrastructure.sensitiveData.encryptText(primaryEmail, 'onboarding.primary_email');
        const emailBlindIndex = await infrastructure.sensitiveData.blindIndex(primaryEmail, 'onboarding.primary_email');
        const duplicate = await transaction.query<{readonly id:string}>(
          `select id from control.onboarding_applications where organization_number=$1 and status not in ('rejected','withdrawn','archived') order by created_at desc limit 1`,
          [organizationNumber],
        );
        const inserted = await transaction.query<ApplicationRow>(
          `insert into control.onboarding_applications
             (organization_name,organization_number,organization_type,primary_email_ciphertext,primary_email_blind_index,
              primary_contact_name,primary_contact_title,possible_duplicate,duplicate_of_application_id)
           values($1,$2,$3,$4,$5,$6,$7,$8,$9)
           returning ${applicationColumns}`,
          [cleanText(input.organizationName,2,300),organizationNumber,input.organizationType,emailCiphertext,emailBlindIndex,
           cleanText(input.primaryContactName,2,200),cleanText(input.primaryContactTitle,2,200),Boolean(duplicate.rows[0]),duplicate.rows[0]?.id??null],
        );
        const row=requireRow(inserted.rows[0],'APPLICATION_INSERT_FAILED');
        const accessToken=randomToken(32); const accessHash=await sha256Hex(accessToken);
        await transaction.query(
          `insert into control.onboarding_access_tokens(application_id,token_hash,subject_reference,expires_at)
           values($1,decode($2,'hex'),$3,now()+interval '30 days')`,[row.id,accessHash,`applicant:${row.id}`],
        );
        const verificationToken=await issueEmailVerification(transaction,infrastructure,row.id,primaryEmail);
        const view=await applicationView(row,infrastructure);
        await saveApplicationVersion(transaction,view,'system',null);
        await appendControlAudit(transaction,null,null,'onboarding.application.created',{applicationId:row.id,possibleDuplicate:Boolean(duplicate.rows[0])});
        const notificationPayload=await encryptNotificationPayload(infrastructure,{applicationId:row.id,template:'email_verification',email:primaryEmail,verificationToken});
        await infrastructure.queue.enqueue({tenantId:'00000000-0000-0000-0000-000000000000',jobType:'APPLICATION_NOTIFICATION',idempotencyKey:`verify:${row.id}:${accessHash.slice(0,16)}`,payload:{encryptedPayload:notificationPayload}});
        const result:ApplicationCreatedView={application:view,accessToken,verificationRequired:true};
        return result;
      });
    },
    async resolveApplicant(applicationId,accessToken,requestId){
      if(!/^[0-9a-f-]{36}$/i.test(applicationId)||!requestId.trim())throw new Error('APPLICATION_ACCESS_DENIED');
      const tokenHash=await sha256Hex(accessToken);
      return database.transaction(async(transaction)=>{
        const result=await transaction.query<{readonly subject_reference:string}>(
          `select subject_reference from control.onboarding_access_tokens
            where application_id=$1 and token_hash=decode($2,'hex') and revoked_at is null and expires_at>now() limit 1`,[applicationId,tokenHash],
        );
        const row=requireRow(result.rows[0],'APPLICATION_ACCESS_DENIED');
        await transaction.query(`update control.onboarding_access_tokens set last_used_at=now() where application_id=$1 and token_hash=decode($2,'hex')`,[applicationId,tokenHash]);
        return {applicationId,subjectId:row.subject_reference,requestId};
      });
    },
    async get(context){return (await getApplication(database,infrastructure,context.applicationId))!;},
    async update(context,input,expectedVersion,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',context.applicationId,'application:update',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,context.applicationId,infrastructure,true);
        assertVersion(current,expectedVersion);
        if(!['draft','email_verification_pending','email_verified','additional_information_requested','resubmitted'].includes(current.status))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        const profile=input.profile?mergeProfile(current.profile,input.profile):current.profile;
        const result=await transaction.query<ApplicationRow>(
          `update control.onboarding_applications set
             organization_name=coalesce($3,organization_name),primary_contact_name=coalesce($4,primary_contact_name),
             primary_contact_title=coalesce($5,primary_contact_title),applicant_visible_profile=$6::jsonb,
             status_version=status_version+1,updated_at=now()
           where id=$1 and status_version=$2 returning ${applicationColumns}`,
          [context.applicationId,current.statusVersion,input.organizationName?cleanText(input.organizationName,2,300):null,
           input.primaryContactName?cleanText(input.primaryContactName,2,200):null,input.primaryContactTitle?cleanText(input.primaryContactTitle,2,200):null,profile],
        );
        const view=await applicationView(requireRow(result.rows[0],'RESOURCE_VERSION_CONFLICT'),infrastructure);
        await saveApplicationVersion(transaction,view,'applicant',null);
        await appendControlAudit(transaction,null,null,'onboarding.application.updated',{applicationId:view.id,actor:context.subjectId,statusVersion:view.statusVersion});
        return view;
      });
    },
    async verifyEmail(applicationId,token,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',applicationId,'application:verify-email',key,payloadHash,async(transaction)=>{
        const tokenHash=await sha256Hex(token);
        const verification=await transaction.query<{readonly id:string}>(
          `select id from control.onboarding_email_verifications
            where application_id=$1 and token_hash=decode($2,'hex') and used_at is null and revoked_at is null and expires_at>now()
            order by created_at desc limit 1 for update`,[applicationId,tokenHash],
        );
        const record=requireRow(verification.rows[0],'EMAIL_VERIFICATION_TOKEN_INVALID');
        const current=await requireApplication(transaction,applicationId,infrastructure,true);
        if(current.status!=='email_verification_pending')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        await transaction.query(`update control.onboarding_email_verifications set used_at=now() where id=$1`,[record.id]);
        const updated=await transitionApplication(transaction,current,'email_verified',undefined,{email_verified_at:'now()'});
        await appendControlAudit(transaction,null,null,'onboarding.application.email_verified',{applicationId,actor:`applicant:${applicationId}`});
        return applicationView(updated,infrastructure);
      });
    },
    async resendVerification(applicationId,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',applicationId,'application:resend-verification',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,applicationId,infrastructure,true);
        if(current.status!=='email_verification_pending')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        await transaction.query(`update control.onboarding_email_verifications set revoked_at=now() where application_id=$1 and used_at is null and revoked_at is null`,[applicationId]);
        const email=await infrastructure.sensitiveData.decryptText((await rawApplication(transaction,applicationId)).primary_email_ciphertext,'onboarding.primary_email');
        const verificationToken=await issueEmailVerification(transaction,infrastructure,applicationId,email);
        const notificationPayload=await encryptNotificationPayload(infrastructure,{applicationId,template:'email_verification',email,verificationToken});
        await infrastructure.queue.enqueue({tenantId:'00000000-0000-0000-0000-000000000000',jobType:'APPLICATION_NOTIFICATION',idempotencyKey:`verify-resend:${applicationId}:${key}`,payload:{encryptedPayload:notificationPayload}});
        return {accepted:true as const};
      });
    },
    async addDocument(context,input,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',context.applicationId,'application:document',key,payloadHash,async(transaction)=>{
        await requireApplication(transaction,context.applicationId,infrastructure,true);
        validateApplicationDocument(input);
        const id=crypto.randomUUID(); const objectKey=`applications/${context.applicationId}/quarantine/${id}/${cleanFileName(input.fileName)}`;
        const inserted=await transaction.query<ApplicationDocumentRow>(
          `insert into control.onboarding_application_documents
             (id,application_id,category,file_name,mime_type,byte_size,sha256,object_key,status,uploaded_by_subject)
           values($1,$2,$3,$4,$5,$6,$7,$8,'quarantined',$9)
           returning id,application_id,category,file_name,mime_type,byte_size,sha256,status,created_at`,
          [id,context.applicationId,cleanText(input.category,2,100),cleanFileName(input.fileName),input.mimeType,input.byteSize,input.sha256,objectKey,context.subjectId],
        );
        await infrastructure.queue.enqueue({tenantId:'00000000-0000-0000-0000-000000000000',jobType:'DOCUMENT_SCAN',idempotencyKey:`application-document:${id}`,payload:{applicationId:context.applicationId,documentId:id,objectKey}});
        await appendControlAudit(transaction,null,null,'onboarding.application_document.registered',{applicationId:context.applicationId,documentId:id});
        return applicationDocumentView(requireRow(inserted.rows[0],'APPLICATION_DOCUMENT_INSERT_FAILED'));
      });
    },
    async submit(context,expectedVersion,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',context.applicationId,'application:submit',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,context.applicationId,infrastructure,true); assertVersion(current,expectedVersion);
        if(!['email_verified','resubmitted'].includes(current.status))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        assertApplicationProfileComplete(current.profile);
        const reference=await transaction.query<{readonly reference:string}>(`select 'ONB-'||extract(year from now())::int||'-'||lpad(nextval('control.onboarding_application_reference_seq')::text,6,'0') as reference`);
        const updated=await transaction.query<ApplicationRow>(
          `update control.onboarding_applications set status='submitted',status_version=status_version+1,
             application_reference=coalesce(application_reference,$3),submitted_at=coalesce(submitted_at,now()),updated_at=now()
           where id=$1 and status_version=$2 returning ${applicationColumns}`,
          [context.applicationId,current.statusVersion,requireRow(reference.rows[0],'APPLICATION_REFERENCE_FAILED').reference],
        );
        const view=await applicationView(requireRow(updated.rows[0],'RESOURCE_VERSION_CONFLICT'),infrastructure);
        await saveApplicationVersion(transaction,view,'applicant',null);
        await appendControlAudit(transaction,null,null,'onboarding.application.submitted',{applicationId:view.id,reference:view.applicationReference??null});
        return view;
      });
    },
    async withdraw(context,expectedVersion,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',context.applicationId,'application:withdraw',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,context.applicationId,infrastructure,true);assertVersion(current,expectedVersion);
        if(['active','archived','rejected','withdrawn'].includes(current.status))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        const updated=await transitionApplication(transaction,current,'withdrawn');
        await appendControlAudit(transaction,null,null,'onboarding.application.withdrawn',{applicationId:current.id,actor:context.subjectId});
        return applicationView(updated,infrastructure);
      });
    },
    async listMessages(context){
      await getApplication(database,infrastructure,context.applicationId);
      return database.transaction(async(transaction)=>{
        const rows=await transaction.query<MessageRow>(`select id,application_id,direction,body,attachment_ids,created_at from control.onboarding_external_messages where application_id=$1 order by created_at`,[context.applicationId]);
        return rows.rows.map(messageView);
      });
    },
    async createMessage(context,input,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',context.applicationId,'application:message',key,payloadHash,async(transaction)=>{
        await requireApplication(transaction,context.applicationId,infrastructure,true);
        const result=await transaction.query<MessageRow>(
          `insert into control.onboarding_external_messages(application_id,direction,body,attachment_ids,sender_reference)
           values($1,'applicant_to_platform',$2,$3,$4) returning id,application_id,direction,body,attachment_ids,created_at`,
          [context.applicationId,cleanText(input.body,1,10000),input.attachmentIds??[],context.subjectId],
        );
        return messageView(requireRow(result.rows[0],'MESSAGE_INSERT_FAILED'));
      });
    },
    async listInformationRequests(context){
      await getApplication(database,infrastructure,context.applicationId);
      return database.transaction(async(transaction)=>{
        const result=await transaction.query<InformationRequestRow>(`${informationRequestSelect} where application_id=$1 order by created_at`,[context.applicationId]);
        return result.rows.map(informationRequestView);
      });
    },
    async respondToInformationRequest(context,requestId,input,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',context.applicationId,`information-request:${requestId}:response`,key,payloadHash,async(transaction)=>{
        const request=await transaction.query<InformationRequestRow>(`${informationRequestSelect} where id=$1 and application_id=$2 for update`,[requestId,context.applicationId]);
        const row=requireRow(request.rows[0],'NOT_FOUND'); if(row.status!=='open')throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        await transaction.query(`insert into control.onboarding_information_responses(information_request_id,application_id,answer,attachment_ids,submitted_by_subject) values($1,$2,$3,$4,$5)`,[requestId,context.applicationId,cleanText(input.answer,1,20000),input.attachmentIds??[],context.subjectId]);
        await transaction.query(`update control.onboarding_information_requests set status='answered',resolved_at=now() where id=$1`,[requestId]);
        const application=await requireApplication(transaction,context.applicationId,infrastructure,true);
        if(application.status==='additional_information_requested')await transitionApplication(transaction,application,'resubmitted');
        const fresh=await transaction.query<InformationRequestRow>(`${informationRequestSelect} where id=$1`,[requestId]);
        await appendControlAudit(transaction,null,null,'onboarding.information_response.created',{applicationId:context.applicationId,requestId,actor:context.subjectId});
        return informationRequestView(requireRow(fresh.rows[0],'NOT_FOUND'));
      });
    },
    async platformList(_context,page,filters){
      return database.transaction(async(transaction)=>{
        const {offset,limit}=pageBounds(page);
        const result=await transaction.query<ApplicationRow>(
          `select ${applicationColumns} from control.onboarding_applications
            where ($1::text is null or status::text=$1)
              and ($2::text is null or organization_type=$2)
              and ($3::uuid is null or assigned_to=$3)
            order by created_at desc,id desc offset $4 limit $5`,
          [filters.status??null,filters.organizationType??null,filters.assignedTo??null,offset,limit+1],
        );
        const views=await Promise.all(result.rows.map((row)=>applicationView(row,infrastructure)));
        return pageResult(views,offset,limit);
      });
    },
    async platformGet(_context,applicationId){return getApplication(database,infrastructure,applicationId,false);},
    async assign(context,applicationId,assigneeId,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',applicationId,'platform:assign',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,applicationId,infrastructure,true);
        const result=await transaction.query<ApplicationRow>(`update control.onboarding_applications set assigned_to=$2,status_version=status_version+1,updated_at=now() where id=$1 and status_version=$3 returning ${applicationColumns}`,[applicationId,assigneeId,current.statusVersion]);
        await appendControlAudit(transaction,null,context.subjectId,'onboarding.application.assigned',{applicationId,assigneeId});
        return applicationView(requireRow(result.rows[0],'RESOURCE_VERSION_CONFLICT'),infrastructure);
      });
    },
    async addReview(context,applicationId,input,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',applicationId,`platform:review:${input.reviewType}`,key,payloadHash,async(transaction)=>{
        let current=await requireApplication(transaction,applicationId,infrastructure,true);
        if(current.status==='submitted')current=await applicationView(await transitionApplication(transaction,current,'under_initial_review'),infrastructure);
        if(!['under_initial_review','resubmitted','commercial_review','legal_review','security_review','technical_review','additional_information_requested'].includes(current.status))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        await transaction.query(`insert into control.onboarding_reviews(application_id,review_type,result,reviewer_id,summary,risk_level) values($1,$2,$3,$4,$5,$6)`,[applicationId,input.reviewType,input.result,context.subjectId,cleanText(input.summary,2,5000),input.riskLevel??null]);
        if(input.result==='requires_information'&&current.status!=='additional_information_requested')current=await applicationView(await transitionApplication(transaction,current,'additional_information_requested'),infrastructure);
        else if(input.result==='passed'){
          const target=`${input.reviewType}_review` as ApplicationView['status'];
          if(current.status!==target&&current.status!=='additional_information_requested')current=await applicationView(await transitionApplication(transaction,current,target),infrastructure);
        }
        await appendControlAudit(transaction,null,context.subjectId,'onboarding.review.recorded',{applicationId,reviewType:input.reviewType,result:input.result,riskLevel:input.riskLevel??null});
        return current;
      });
    },
    async requestInformation(context,applicationId,input,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',applicationId,'platform:information-request',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,applicationId,infrastructure,true);
        const inserted=await transaction.query<InformationRequestRow>(
          `insert into control.onboarding_information_requests(application_id,category,question,attachment_required,status,requested_by,due_at)
           values($1,$2,$3,$4,'open',$5,$6) returning id,application_id,category,question,due_at,attachment_required,status,created_at`,
          [applicationId,input.category,cleanText(input.question,2,10000),input.attachmentRequired,context.subjectId,input.dueAt??null],
        );
        if(current.status!=='additional_information_requested')await transitionApplication(transaction,current,'additional_information_requested');
        await transaction.query(`insert into control.onboarding_external_messages(application_id,direction,body,sender_reference) values($1,'platform_to_applicant',$2,$3)`,[applicationId,input.question,context.subjectId]);
        await appendControlAudit(transaction,null,context.subjectId,'onboarding.information_request.created',{applicationId,requestId:inserted.rows[0]?.id??null});
        return informationRequestView(requireRow(inserted.rows[0],'INFORMATION_REQUEST_INSERT_FAILED'));
      });
    },
    async approve(context,applicationId,input,key,payloadHash){
      return decideApplication(database,infrastructure,context,applicationId,'approved',input,key,payloadHash);
    },
    async reject(context,applicationId,input,key,payloadHash){
      return decideApplication(database,infrastructure,context,applicationId,'rejected',input,key,payloadHash);
    },
    async provision(context,applicationId,key,payloadHash){
      return controlIdempotent(database,infrastructure,'application',applicationId,'platform:provision',key,payloadHash,async(transaction)=>{
        const current=await requireApplication(transaction,applicationId,infrastructure,true);
        if(!['approved','provisioning_failed'].includes(current.status))throw new Error('INVALID_APPLICATION_STATE_TRANSITION');
        const deployment=current.profile.deployment; if(!deployment)throw new Error('DEPLOYMENT_PROFILE_MISSING');
        const existing=await transaction.query<ProvisioningRow>(`${provisioningSelect} where application_id=$1`,[applicationId]);
        if(existing.rows[0])return provisioningView(existing.rows[0]);
        await transitionApplication(transaction,current,'provisioning');
        const inserted=await transaction.query<ProvisioningRow>(
          `insert into control.tenant_provisioning_requests(application_id,status,deployment_mode,region,requested_by,current_step,idempotency_key,payload_sha256)
           values($1,'queued',$2::control.deployment_mode,$3,$4,'reserve_tenant_slug',$5,$6)
           returning id,application_id,tenant_id,status::text as status,current_step,blocking_code,attempts,created_at,updated_at`,
          [applicationId,deployment.mode,deployment.region??'se-central',context.subjectId,key,payloadHash],
        );
        const request=requireRow(inserted.rows[0],'PROVISIONING_REQUEST_INSERT_FAILED');
        const steps=['reserve_tenant_slug','create_tenant','create_environment','assign_data_plane','create_default_domain','create_storage_namespaces','seed_policies','seed_roles','create_branding_draft','create_auth_draft','create_onboarding_checklist','enable_account_management'];
        for(let index=0;index<steps.length;index+=1)await transaction.query(`insert into control.tenant_provisioning_steps(provisioning_request_id,step_key,sequence_number,status) values($1,$2,$3,'pending')`,[request.id,steps[index],index+1]);
        await infrastructure.queue.enqueue({tenantId:'00000000-0000-0000-0000-000000000000',jobType:'TENANT_PROVISION',idempotencyKey:`tenant-provision:${request.id}`,payload:{provisioningRequestId:request.id,applicationId}});
        await appendControlAudit(transaction,null,context.subjectId,'tenant.provisioning.queued',{applicationId,requestId:request.id});
        return provisioningView(request);
      });
    },
    async audit(_context,applicationId){
      return database.transaction(async(transaction)=>{
        const result=await transaction.query<{readonly id:string;readonly actor_id:string|null;readonly event_type:string;readonly payload:Readonly<Record<string,unknown>>;readonly occurred_at:string|Date;readonly event_hash:string;readonly previous_event_hash:string}>(
          `select id,actor_id,event_type,payload,occurred_at,event_hash,previous_event_hash from control.control_audit_events where payload->>'applicationId'=$1 order by occurred_at,id`,[applicationId],
        );
        return result.rows.map((row)=>({id:row.id,applicationId,actorId:row.actor_id,eventType:row.event_type,payload:row.payload,occurredAt:iso(row.occurred_at),eventHash:row.event_hash,previousEventHash:row.previous_event_hash}));
      });
    },
    async getProvisioning(_context,requestId){
      return database.transaction(async(transaction)=>{const result=await transaction.query<ProvisioningRow>(`${provisioningSelect} where id=$1`,[requestId]);return result.rows[0]?provisioningView(result.rows[0]):null;});
    },
    async retryProvisioning(context,requestId,key,payloadHash){
      return controlIdempotent(database,infrastructure,'platform',context.subjectId,`provisioning:${requestId}:retry`,key,payloadHash,async(transaction)=>{
        const current=await transaction.query<ProvisioningRow>(`${provisioningSelect} where id=$1 for update`,[requestId]);const row=requireRow(current.rows[0],'NOT_FOUND');
        if(!['failed','partially_completed','retry_scheduled','waiting_for_external_dependency'].includes(row.status))throw new Error('INVALID_PROVISIONING_STATE');
        const updated=await transaction.query<ProvisioningRow>(`update control.tenant_provisioning_requests set status='queued',blocking_code=null,attempts=attempts+1,updated_at=now() where id=$1 returning id,application_id,tenant_id,status::text as status,current_step,blocking_code,attempts,created_at,updated_at`,[requestId]);
        await infrastructure.queue.enqueue({tenantId:'00000000-0000-0000-0000-000000000000',jobType:'TENANT_PROVISION',idempotencyKey:`tenant-provision-retry:${requestId}:${key}`,payload:{provisioningRequestId:requestId,applicationId:row.application_id}});
        await appendControlAudit(transaction,row.tenant_id,context.subjectId,'tenant.provisioning.retried',{applicationId:row.application_id,requestId});
        return provisioningView(requireRow(updated.rows[0],'PROVISIONING_RETRY_FAILED'));
      });
    },
    async runReadiness(context,tenantId,key,payloadHash){
      return controlIdempotent(database,infrastructure,'tenant',tenantId,'readiness:run',key,payloadHash,async(transaction)=>{
        const checks=await collectReadinessChecks(transaction,tenantId);const result=evaluateReadiness('production',checks);
        await transaction.query(`insert into control.tenant_readiness_results(tenant_id,environment,ready,blocking_checks,warning_checks,completed_checks,checked_by) values($1,'production',$2,$3::jsonb,$4::jsonb,$5::jsonb,$6)`,[tenantId,result.ready,result.blockingChecks,result.warningChecks,result.completedChecks,context.subjectId]);
        await appendControlAudit(transaction,tenantId,context.subjectId,'tenant.readiness.evaluated',{tenantId,ready:result.ready,blockingCodes:result.blockingChecks.map((item)=>item.code)});
        return result;
      });
    },
    async getReadiness(_context,tenantId){
      return database.transaction(async(transaction)=>{
        const result=await transaction.query<{readonly ready:boolean;readonly blocking_checks:readonly ReadinessCheck[];readonly warning_checks:readonly ReadinessCheck[];readonly completed_checks:readonly ReadinessCheck[]}>(`select ready,blocking_checks,warning_checks,completed_checks from control.tenant_readiness_results where tenant_id=$1 and environment='production' order by checked_at desc limit 1`,[tenantId]);
        const row=result.rows[0];return row?{ready:row.ready,environment:'production',blockingChecks:row.blocking_checks,warningChecks:row.warning_checks,completedChecks:row.completed_checks}:null;
      });
    },
    async createActivationRequest(context,tenantId,key,payloadHash){
      return controlIdempotent(database,infrastructure,'tenant',tenantId,'activation:create',key,payloadHash,async(transaction)=>{
        const readiness=await latestReadiness(transaction,tenantId);if(!readiness?.ready)throw new Error('TENANT_NOT_READY_FOR_ACTIVATION');
        const application=await transaction.query<{readonly id:string}>(`select id from control.onboarding_applications where linked_tenant_id=$1 order by created_at desc limit 1`,[tenantId]);
        const applicationId=requireRow(application.rows[0],'TENANT_APPLICATION_NOT_FOUND').id;
        const inserted=await transaction.query<ActivationRow>(
          `insert into control.tenant_activation_requests(tenant_id,application_id,requested_by,status,readiness_snapshot,idempotency_key)
           values($1,$2,$3,'pending_approval',$4::jsonb,$5)
           returning id,tenant_id,requested_by,status,created_at,decided_at`,[tenantId,applicationId,context.subjectId,readiness,key],
        );
        await appendControlAudit(transaction,tenantId,context.subjectId,'tenant.activation.requested',{tenantId,applicationId,requestId:inserted.rows[0]?.id??null});
        return activationView(requireRow(inserted.rows[0],'ACTIVATION_REQUEST_INSERT_FAILED'));
      });
    },
    async decideActivation(context,requestId,decision,reason,key,payloadHash){
      return controlIdempotent(database,infrastructure,'platform',context.subjectId,`activation:${requestId}:${decision}`,key,payloadHash,async(transaction)=>{
        const current=await transaction.query<ActivationRow&{readonly application_id:string}>(`select id,tenant_id,application_id,requested_by,status,created_at,decided_at from control.tenant_activation_requests where id=$1 for update`,[requestId]);
        const row=requireRow(current.rows[0],'NOT_FOUND');if(row.status!=='pending_approval')throw new Error('INVALID_ACTIVATION_STATE');
        assertDistinctApprovers(row.requested_by,context.subjectId);
        await transaction.query(`insert into control.tenant_activation_approvals(activation_request_id,approver_id,decision,reason) values($1,$2,$3,$4)`,[requestId,context.subjectId,decision==='approve'?'approved':'rejected',cleanText(reason,2,5000)]);
        const status=decision==='approve'?'activated':'rejected';
        const updated=await transaction.query<ActivationRow>(`update control.tenant_activation_requests set status=$2,decided_at=now() where id=$1 returning id,tenant_id,requested_by,status,created_at,decided_at`,[requestId,status]);
        if(decision==='approve'){
          await transaction.query(`update control.platform_tenants set status='active',updated_at=now(),version=version+1 where id=$1`,[row.tenant_id]);
          await transaction.query(`update control.tenant_environments set status='active',updated_at=now() where tenant_id=$1 and environment='production'`,[row.tenant_id]);
          await transaction.query(`update control.onboarding_applications set status='active',status_version=status_version+1,updated_at=now() where id=$1 and status='ready_for_activation'`,[row.application_id]);
        }
        await appendControlAudit(transaction,row.tenant_id,context.subjectId,`tenant.activation.${decision}`,{tenantId:row.tenant_id,applicationId:row.application_id,requestId,reason});
        return activationView(requireRow(updated.rows[0],'ACTIVATION_UPDATE_FAILED'));
      });
    },
  };
}

async function platformOrganizationByApplication(transaction:SqlTransaction,applicationId:string):Promise<PlatformOrganizationRow>{
  const result=await transaction.query<PlatformOrganizationRow>(`${platformOrganizationSelect} where a.id=$1 limit 1`,[applicationId]);
  return requireRow(result.rows[0],'ORGANIZATION_NOT_FOUND');
}
async function platformOrganizationView(row:PlatformOrganizationRow,infrastructure:ProductionInfrastructure):Promise<PlatformOrganizationView>{
  const primaryAdminEmail=await infrastructure.sensitiveData.decryptText(row.primary_email_ciphertext,'onboarding.primary_email');
  const tenantId=row.linked_tenant_id??row.provisioning_tenant_id??undefined;
  return {
    applicationId:row.id,legalName:row.organization_name,organizationNumber:row.organization_number,organizationType:row.organization_type,
    applicationStatus:row.status,primaryAdminEmail,primaryAdminName:row.primary_contact_name,primaryAdminTitle:row.primary_contact_title,
    domainReady:row.domain_ready,createdAt:iso(row.created_at),
    ...(tenantId?{tenantId}:{}),...(row.tenant_status?{tenantStatus:row.tenant_status}:{}),
    ...(row.provisioning_request_id?{provisioningRequestId:row.provisioning_request_id}:{}),
    ...(row.provisioning_status?{provisioningStatus:row.provisioning_status}:{}),
    ...(row.provisioning_current_step?{currentStep:row.provisioning_current_step}:{}),
    ...(row.provisioning_blocking_code?{blockingCode:row.provisioning_blocking_code}:{}),
    ...(row.primary_hostname?{primaryHostname:row.primary_hostname}:{}),
  };
}

async function decideApplication(database:SqlDatabase,infrastructure:ProductionInfrastructure,context:PlatformContext,applicationId:string,decision:'approved'|'rejected',input:DecisionInput,key:string,payloadHash:string):Promise<ApplicationView>{
  return controlIdempotent(database,infrastructure,'application',applicationId,`platform:${decision}`,key,payloadHash,async(transaction)=>{
    const current=await requireApplication(transaction,applicationId,infrastructure,true);
    if(decision==='approved'){
      const reviews=await transaction.query<{readonly review_type:string;readonly result:string;readonly risk_level:string|null}>(`select distinct on(review_type) review_type::text as review_type,result::text as result,risk_level from control.onboarding_reviews where application_id=$1 order by review_type,created_at desc`,[applicationId]);
      const latest=new Map(reviews.rows.map((row)=>[row.review_type,row]));
      if(!['commercial','legal','security','technical'].every((type)=>latest.get(type)?.result==='passed'))throw new Error('REQUIRED_REVIEWS_NOT_PASSED');
      const highRisk=reviews.rows.some((row)=>row.risk_level==='high'||row.risk_level==='critical');
      if(highRisk){if(!input.secondApproverId)throw new Error('TWO_PERSON_APPROVAL_REQUIRED');assertDistinctApprovers(context.subjectId,input.secondApproverId);}
    }
    const updated=await transitionApplication(transaction,current,decision);
    await transaction.query(`insert into control.onboarding_decisions(application_id,decision,decided_by,second_approver_id,external_reason,internal_reason,conditions,valid_until) values($1,$2,$3,$4,$5,$6,$7::jsonb,$8)`,[applicationId,decision,context.subjectId,input.secondApproverId??null,cleanText(input.reason,2,5000),input.internalReason??null,input.conditions??[],input.validUntil??null]);
    await appendControlAudit(transaction,null,context.subjectId,`onboarding.decision.${decision}`,{applicationId,reason:input.reason,secondApproverId:input.secondApproverId??null});
    return applicationView(updated,infrastructure);
  });
}

async function collectReadinessChecks(transaction:SqlTransaction,tenantId:string):Promise<readonly ReadinessCheck[]>{
  const checkedAt=new Date().toISOString();
  const environment=await transaction.query<{readonly data_plane_status:string;readonly environment_status:string}>(`select dp.status::text as data_plane_status,te.status as environment_status from control.tenant_environments te join control.data_planes dp on dp.id=te.data_plane_id where te.tenant_id=$1 and te.environment='production'`,[tenantId]);
  const env=environment.rows[0];
  const domains=await transaction.query<{readonly domain_type:string;readonly status:string;readonly is_primary:boolean;readonly dns_verified_at:string|null;readonly certificate_issued_at:string|null;readonly certificate_expires_at:string|null;readonly last_health_status:string|null;readonly normalized_hostname:string}>(`select domain_type::text,status::text,is_primary,dns_verified_at,certificate_issued_at,certificate_expires_at,last_health_status,normalized_hostname from control.tenant_domains where tenant_id=$1 and environment_id=(select id from control.tenant_environments where tenant_id=$1 and environment='production') and status<>'removed'`,[tenantId]);
  const defaultDomain=domains.rows.find((row)=>row.domain_type==='platform_default');const primary=domains.rows.find((row)=>row.is_primary);const custom=domains.rows.find((row)=>row.domain_type==='customer_custom');
  const customRequired=await transaction.query<{readonly required:boolean}>(`select coalesce((configuration->>'customDomainRequired')::boolean,false) as required from control.tenant_features where tenant_id=$1 and feature_key='custom_domain'`,[tenantId]);
  const emailProvider=(environmentValue('EMAIL_PROVIDER')??'').toLowerCase();
  const ticApiKey=environmentValue('TIC_API_KEY');
  const ticWebhookSecret=environmentValue('TIC_WEBHOOK_SECRET');
  const privateStorageReady=environmentValue('STORAGE_PROVIDER')==='supabase'
    && environmentPresent('SUPABASE_DATA_PROJECT_URL','SUPABASE_DATA_SERVICE_ROLE_KEY','STORAGE_DOCUMENT_QUARANTINE_BUCKET','STORAGE_CANONICAL_DOCUMENTS_BUCKET','STORAGE_VALIDATION_REPORTS_BUCKET','STORAGE_EVIDENCE_PACKAGES_BUCKET');
  const pdfPipelineApproved=environmentFlag('PDF_PIPELINE_APPROVED');
  const checks:ReadinessCheck[]=[
    check('TENANT_DATABASE_NOT_READY',env?.data_plane_status==='ready','blocking',checkedAt,{dataPlaneStatus:env?.data_plane_status??'missing'}),
    check('OBJECT_STORAGE_NOT_READY',privateStorageReady,'blocking',checkedAt,{provider:environmentValue('STORAGE_PROVIDER')??'missing'}),
    check('AUTH_SERVICE_NOT_CONFIGURED',environmentPresent('AUTH_BROKER_URL','SUPABASE_AUTH_PROJECT_URL','SUPABASE_AUTH_ANON_KEY','SUPABASE_AUTH_SERVICE_ROLE_KEY','CSRF_SIGNING_KEY'),'blocking',checkedAt),
    check('PUBLIC_ACCOUNT_REGISTRATION_ENABLED',environmentValue('AUTH_PUBLIC_SIGNUP_ENABLED')==='false','blocking',checkedAt),
    check('AUTH_EMAIL_DELIVERY_NOT_VERIFIED',environmentFlag('AUTH_EMAIL_DELIVERY_VERIFIED'),'blocking',checkedAt),
    check('SUPERADMIN_NOT_BOOTSTRAPPED',environmentFlag('SUPERADMIN_BOOTSTRAPPED'),'blocking',checkedAt),
    check('DEFAULT_TENANT_DOMAIN_NOT_ACTIVE',defaultDomain?.status==='active','blocking',checkedAt,{hostname:defaultDomain?.normalized_hostname??null,status:defaultDomain?.status??'missing'}),
    check('PRIMARY_DOMAIN_NOT_SELECTED',Boolean(primary),'blocking',checkedAt,{hostname:primary?.normalized_hostname??null}),
    check('CUSTOM_DOMAIN_REQUIRED_BUT_MISSING',!customRequired.rows[0]?.required||Boolean(custom),'blocking',checkedAt),
    check('CUSTOM_DOMAIN_DNS_NOT_VERIFIED',!custom||Boolean(custom.dns_verified_at),'blocking',checkedAt),
    check('CUSTOM_DOMAIN_CERTIFICATE_NOT_READY',!custom||Boolean(custom.certificate_issued_at),'blocking',checkedAt),
    check('CUSTOM_DOMAIN_ROUTING_FAILED',!custom||custom.last_health_status==='healthy','blocking',checkedAt),
    check('UNVERIFIED_HOSTNAME_CONFIGURED',domains.rows.every((row)=>row.status!=='active'||Boolean(row.dns_verified_at)),'blocking',checkedAt),
    check('SIGN_SERVICE_NOT_CONFIGURED',environmentFlag('TIC_BANKID_ENABLED')&&!environmentFlag('TIC_GLOBAL_KILL_SWITCH')&&environmentValue('TIC_ENVIRONMENT')==='production'&&environmentPresent('TIC_BASE_URL','TIC_CALLBACK_URL','TIC_WEBHOOK_URL'),'blocking',checkedAt),
    check('VALIDATION_SERVICE_NOT_CONFIGURED',environmentPresent('VALIDATION_SERVICE_URL','VALIDATION_SERVICE_TOKEN'),'blocking',checkedAt),
    check('TIC_API_KEY_NOT_CONFIGURED',Boolean(ticApiKey),'blocking',checkedAt),
    check('TIC_WEBHOOK_SECRET_NOT_CONFIGURED',Boolean(ticWebhookSecret),'blocking',checkedAt),
    check('TIC_CALLBACK_NOT_VERIFIED',environmentFlag('TIC_CALLBACK_VERIFIED'),'blocking',checkedAt),
    check('TIC_WEBHOOK_NOT_VERIFIED',environmentFlag('TIC_WEBHOOK_VERIFIED'),'blocking',checkedAt),
    check('TRUSTED_PROXY_NOT_CONFIGURED',environmentFlag('TRUST_PROXY')&&environmentFlag('REQUIRE_VERIFIED_FORWARDED_HOST')&&['vercel','cloudflare'].includes(environmentValue('TRUSTED_PROXY_PROVIDER')??''),'blocking',checkedAt),
    check('CLAMAV_NOT_READY',pdfPipelineApproved&&environmentPresent('CLAMAV_HOST','CLAMAV_PORT'),'blocking',checkedAt),
    check('QPDF_NOT_READY',pdfPipelineApproved&&environmentPresent('QPDF_COMMAND'),'blocking',checkedAt),
    check('GOTENBERG_NOT_READY',pdfPipelineApproved&&environmentPresent('GOTENBERG_URL'),'blocking',checkedAt),
    check('VERAPDF_NOT_READY',pdfPipelineApproved&&environmentPresent('VERAPDF_URL','VERAPDF_VALIDATE_PATH'),'blocking',checkedAt),
    check('EVIDENCE_VERIFIER_NOT_READY',environmentPresent('VALIDATION_SERVICE_URL','VALIDATION_SERVICE_TOKEN')&&environmentFlag('EVIDENCE_VERIFIER_VERIFIED'),'blocking',checkedAt),
    check('EMAIL_PROVIDER_NOT_READY',emailProvider==='resend'&&!environmentFlag('EMAIL_GLOBAL_KILL_SWITCH')&&environmentPresent('RESEND_API_KEY','RESEND_WEBHOOK_SECRET','EMAIL_DEFAULT_FROM','EMAIL_DEFAULT_REPLY_TO','EMAIL_SENDING_DOMAIN'),'blocking',checkedAt,{provider:emailProvider||'missing'}),
    check('EMAIL_DATA_RESIDENCY_NOT_APPROVED',emailProvider!=='resend'||environmentFlag('EMAIL_DATA_RESIDENCY_APPROVED'),'blocking',checkedAt,{provider:emailProvider||'missing'}),
    check('WORKER_CONSUMERS_NOT_READY',environmentFlag('WORKER_CONSUMERS_READY'),'blocking',checkedAt),
    check('WILDCARD_TLS_NOT_VERIFIED',environmentFlag('WILDCARD_TLS_VERIFIED')||environmentFlag('PLATFORM_WILDCARD_VERIFIED'),'blocking',checkedAt),
    check('ENCRYPTION_KEYS_NOT_CONFIGURED',environmentPresent('SENSITIVE_DATA_ENCRYPTION_KEY_BASE64','SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64','INTERNAL_GATEWAY_HMAC_KEY'),'blocking',checkedAt),
    check('AUDIT_CHAIN_NOT_VERIFIED',environmentFlag('AUDIT_CHAIN_VERIFIED'),'blocking',checkedAt),
    check('MIGRATIONS_NOT_CURRENT',environmentFlag('MIGRATIONS_CURRENT'),'blocking',checkedAt),
    check('PRIVATE_STORAGE_NOT_READY',privateStorageReady,'blocking',checkedAt),
    check('RETENTION_POLICY_NOT_APPROVED',environmentFlag('RETENTION_POLICY_APPROVED'),'blocking',checkedAt),
    check('DPA_NOT_ACCEPTED',environmentFlag('DPA_ACCEPTED'),'blocking',checkedAt),
    check('ACCEPTANCE_TEST_NOT_PASSED',environmentFlag('PRODUCTION_ACCEPTANCE_TEST_PASSED'),'blocking',checkedAt),
    check('SOFTWARE_TEST_KEY_IN_PRODUCTION',!looksLikeTestCredential(ticApiKey)&&!looksLikeTestCredential(ticWebhookSecret),'blocking',checkedAt),
    check('CERTIFICATE_EXPIRED',domains.rows.every((row)=>!row.certificate_expires_at||new Date(row.certificate_expires_at).getTime()>Date.now()),'blocking',checkedAt),
    check('DOMAIN_CERTIFICATE_EXPIRES_SOON',domains.rows.every((row)=>!row.certificate_expires_at||new Date(row.certificate_expires_at).getTime()>Date.now()+30*86400000),'warning',checkedAt),
  ];
  const requiredHealth=['auth_callback','same_origin_api','signer_flow','takeover_protection'] as const;
  for(const health of requiredHealth){
    const result=primary?await transaction.query<{readonly status:string}>(`select status from control.domain_health_checks where tenant_domain_id=(select id from control.tenant_domains where tenant_id=$1 and normalized_hostname=$2) and check_type=$3 order by checked_at desc limit 1`,[tenantId,primary.normalized_hostname,health]):{rows:[],rowCount:0};
    const code=health==='auth_callback'?'CUSTOM_DOMAIN_AUTH_CALLBACK_FAILED':health==='same_origin_api'?'CUSTOM_DOMAIN_ROUTING_FAILED':health==='signer_flow'?'CUSTOM_DOMAIN_SIGNER_FLOW_FAILED':'CUSTOM_DOMAIN_TAKEOVER_PROTECTION_FAILED';
    checks.push(check(code,result.rows[0]?.status==='healthy','blocking',checkedAt,{checkType:health}));
  }
  return checks;
}
function environmentValue(name:string):string|undefined{const value=process.env[name]?.trim();return value||undefined;}
function environmentPresent(...names:readonly string[]):boolean{return names.every((name)=>Boolean(environmentValue(name)));}
function environmentFlag(name:string):boolean{return environmentValue(name)?.toLowerCase()==='true';}
function looksLikeTestCredential(value:string|undefined):boolean{return Boolean(value&&/(sandbox|test|demo|example|dummy)/i.test(value));}

function check(code:string,passed:boolean,severity:'blocking'|'warning',checkedAt:string,evidence:Readonly<Record<string,unknown>>={}):ReadinessCheck{return{code,passed,severity,checkedAt,evidence};}
async function latestReadiness(transaction:SqlTransaction,tenantId:string):Promise<ReadinessResult|null>{const result=await transaction.query<{readonly ready:boolean;readonly blocking_checks:readonly ReadinessCheck[];readonly warning_checks:readonly ReadinessCheck[];readonly completed_checks:readonly ReadinessCheck[]}>(`select ready,blocking_checks,warning_checks,completed_checks from control.tenant_readiness_results where tenant_id=$1 and environment='production' order by checked_at desc limit 1`,[tenantId]);const row=result.rows[0];return row?{ready:row.ready,environment:'production',blockingChecks:row.blocking_checks,warningChecks:row.warning_checks,completedChecks:row.completed_checks}:null;}

async function controlIdempotent<T>(database:SqlDatabase,infrastructure:ProductionInfrastructure,scopeType:'public'|'application'|'platform'|'tenant',scopeId:string,operation:string,key:string,payloadHash:string,work:(transaction:SqlTransaction)=>Promise<T>):Promise<T>{
  if(!/^[A-Za-z0-9._:-]{8,200}$/.test(key))throw new Error('IDEMPOTENCY_KEY_INVALID');
  if(!/^[0-9a-f]{64}$/.test(payloadHash))throw new Error('PAYLOAD_HASH_INVALID');
  const encryptionPurpose=`onboarding.idempotency.${scopeType}.${operation}`;
  return database.transaction(async transaction=>{
    await transaction.query(`select pg_advisory_xact_lock(hashtextextended($1,0))`,[`${scopeType}:${scopeId}:${operation}:${key}`]);
    const existing=await transaction.query<{readonly request_payload_sha256:string;readonly response_body_ciphertext:Uint8Array|null}>(
      `select request_payload_sha256,response_body_ciphertext from control.onboarding_idempotency_keys
        where scope_type=$1 and scope_id=$2 and operation=$3 and idempotency_key=$4 and expires_at>now() for update`,
      [scopeType,scopeId,operation,key],
    );
    const row=existing.rows[0];
    if(row){
      if(row.request_payload_sha256!==payloadHash)throw new Error('IDEMPOTENCY_CONFLICT');
      if(row.response_body_ciphertext===null)throw new Error('IDEMPOTENCY_OPERATION_IN_PROGRESS');
      const plaintext=await infrastructure.sensitiveData.decryptText(row.response_body_ciphertext,encryptionPurpose);
      return JSON.parse(plaintext) as T;
    }
    await transaction.query(
      `insert into control.onboarding_idempotency_keys(scope_type,scope_id,operation,idempotency_key,request_payload_sha256,expires_at)
       values($1,$2,$3,$4,$5,now()+interval '24 hours')`,
      [scopeType,scopeId,operation,key,payloadHash],
    );
    const response=await work(transaction);
    const ciphertext=await infrastructure.sensitiveData.encryptText(JSON.stringify(response),encryptionPurpose);
    await transaction.query(
      `update control.onboarding_idempotency_keys set response_status=200,response_body=null,response_body_ciphertext=$5
        where scope_type=$1 and scope_id=$2 and operation=$3 and idempotency_key=$4`,
      [scopeType,scopeId,operation,key,ciphertext],
    );
    return response;
  });
}

async function getApplication(database:SqlDatabase,infrastructure:ProductionInfrastructure,id:string,throwIfMissing=true):Promise<ApplicationView|null>{return database.transaction(async transaction=>{const result=await transaction.query<ApplicationRow>(`select ${applicationColumns} from control.onboarding_applications where id=$1`,[id]);if(!result.rows[0]){if(throwIfMissing)throw new Error('NOT_FOUND');return null;}return applicationView(result.rows[0],infrastructure);});}
async function requireApplication(transaction:SqlTransaction,id:string,infrastructure:ProductionInfrastructure,forUpdate=false):Promise<ApplicationView>{const row=await rawApplication(transaction,id,forUpdate);return applicationView(row,infrastructure);}
async function rawApplication(transaction:SqlTransaction,id:string,forUpdate=false):Promise<ApplicationRow>{const result=await transaction.query<ApplicationRow>(`select ${applicationColumns} from control.onboarding_applications where id=$1${forUpdate?' for update':''}`,[id]);return requireRow(result.rows[0],'NOT_FOUND');}
async function applicationView(row:ApplicationRow,infrastructure:ProductionInfrastructure):Promise<ApplicationView>{const primaryEmail=await infrastructure.sensitiveData.decryptText(row.primary_email_ciphertext,'onboarding.primary_email');return{id:row.id,status:row.status,statusVersion:Number(row.status_version),organizationName:row.organization_name,organizationNumber:row.organization_number,organizationType:row.organization_type,primaryEmail,primaryContactName:row.primary_contact_name,primaryContactTitle:row.primary_contact_title,profile:row.applicant_visible_profile,createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),...(row.application_reference?{applicationReference:row.application_reference}:{}),...(row.email_verified_at?{emailVerifiedAt:iso(row.email_verified_at)}:{}),...(row.submitted_at?{submittedAt:iso(row.submitted_at)}:{}),...(row.decided_at?{decidedAt:iso(row.decided_at)}:{}),...(row.assigned_to?{assignedTo:row.assigned_to}:{}),...(row.linked_tenant_id?{tenantId:row.linked_tenant_id}:{})};}
async function transitionApplication(transaction:SqlTransaction,current:ApplicationView,status:ApplicationView['status'],expectedVersion?:number,extra:Readonly<Record<string,string>>={}):Promise<ApplicationRow>{assertVersion(current,expectedVersion);const fields=[`status=$3::control.onboarding_application_status`,`status_version=status_version+1`,`updated_at=now()`];if(status==='submitted')fields.push(`submitted_at=coalesce(submitted_at,now())`);if(status==='approved'||status==='rejected')fields.push(`decided_at=now()`);for(const[key,value]of Object.entries(extra))fields.push(`${key}=${value}`);const result=await transaction.query<ApplicationRow>(`update control.onboarding_applications set ${fields.join(',')} where id=$1 and status_version=$2 returning ${applicationColumns}`,[current.id,current.statusVersion,status]);return requireRow(result.rows[0],'RESOURCE_VERSION_CONFLICT');}
async function issueEmailVerification(transaction:SqlTransaction,infrastructure:ProductionInfrastructure,applicationId:string,email:string):Promise<string>{const token=randomToken(32);const tokenHash=await sha256Hex(token);const emailIndex=await infrastructure.sensitiveData.blindIndex(email,'onboarding.primary_email');await transaction.query(`insert into control.onboarding_email_verifications(application_id,email_blind_index,token_hash,expires_at) values($1,$2,decode($3,'hex'),now()+interval '30 minutes')`,[applicationId,emailIndex,tokenHash]);return token;}
async function saveApplicationVersion(transaction:SqlTransaction,view:ApplicationView,source:'applicant'|'platform'|'system',createdBy:string|null):Promise<void>{const snapshot=JSON.stringify(view);await transaction.query(`insert into control.onboarding_application_versions(application_id,version_number,source,snapshot,payload_sha256,created_by) values($1,$2,$3,$4::jsonb,$5,$6) on conflict(application_id,version_number) do nothing`,[view.id,view.statusVersion,source,view,await sha256Hex(snapshot),createdBy]);}
async function encryptNotificationPayload(infrastructure:ProductionInfrastructure,payload:Readonly<Record<string,unknown>>):Promise<string>{
  const ciphertext=await infrastructure.sensitiveData.encryptText(JSON.stringify(payload),'onboarding.application_notification');
  return base64Encode(ciphertext);
}

async function appendControlAudit(transaction:SqlTransaction,tenantId:string|null,actorId:string|null,eventType:string,payload:Readonly<Record<string,unknown>>):Promise<void>{await transaction.query(`select pg_advisory_xact_lock(hashtextextended('control-audit-chain',0))`);const previous=await transaction.query<{readonly event_hash:string}>(`select event_hash from control.control_audit_events order by occurred_at desc,id desc limit 1`);const previousHash=previous.rows[0]?.event_hash??'0'.repeat(64);const material=JSON.stringify({tenantId,actorId,eventType,payload,previousHash});const eventHash=await sha256Hex(material);await transaction.query(`insert into control.control_audit_events(tenant_id,actor_id,event_type,payload,previous_event_hash,event_hash) values($1,$2,$3,$4::jsonb,$5,$6)`,[tenantId,actorId,eventType,payload,previousHash,eventHash]);}
function mergeProfile(current:ApplicationProfile,next:ApplicationProfile):ApplicationProfile{const deployment=next.deployment?{...current.deployment,...next.deployment}:current.deployment;return{...current,...next,...(deployment?{deployment}:{})};}
function assertApplicationProfileComplete(profile:ApplicationProfile):void{if(!profile.officialEmailDomain)throw new Error('APPLICATION_OFFICIAL_EMAIL_DOMAIN_REQUIRED');if(!profile.deployment?.mode)throw new Error('APPLICATION_DEPLOYMENT_MODE_REQUIRED');}
function assertVersion(current:ApplicationView,expected?:number):void{if(expected!==undefined&&current.statusVersion!==expected)throw new Error('RESOURCE_VERSION_CONFLICT');}
function validateApplicationDocument(input:ApplicationDocumentInput):void{if(input.mimeType!=='application/pdf')throw new Error('UPLOAD_MIME_TYPE_NOT_ALLOWED');if(!Number.isSafeInteger(input.byteSize)||input.byteSize<1||input.byteSize>104857600)throw new Error('UPLOAD_SIZE_INVALID');if(!/^[0-9a-f]{64}$/.test(input.sha256))throw new Error('UPLOAD_SHA256_INVALID');}
function cleanText(value:string,min:number,max:number):string{const result=value.trim().replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ');if(result.length<min||result.length>max)throw new Error('TEXT_VALUE_INVALID');return result;}
function cleanFileName(value:string):string{const result=value.trim().replace(/[^A-Za-z0-9._ -]/g,'_').replace(/\s+/g,'_').slice(0,180);if(!result||result==='.'||result==='..')throw new Error('FILE_NAME_INVALID');return result;}
function pageBounds(page:PageInput):{readonly offset:number;readonly limit:number}{const limit=Math.min(Math.max(page.limit,1),200);const parsed=page.cursor?Number.parseInt(page.cursor,10):0;return{offset:Number.isSafeInteger(parsed)&&parsed>=0?parsed:0,limit};}
function pageResult<T>(rows:readonly T[],offset:number,limit:number):Page<T>{const data=rows.slice(0,limit);return{data,...(rows.length>limit?{nextCursor:String(offset+limit)}:{})};}
function requireRow<T>(row:T|undefined,code:string):T{if(!row)throw new Error(code);return row;}
function iso(value:string|Date):string{return value instanceof Date?value.toISOString():new Date(value).toISOString();}
function provisioningView(row:ProvisioningRow):ProvisioningRequestView{return{id:row.id,applicationId:row.application_id,status:row.status,attempts:Number(row.attempts),createdAt:iso(row.created_at),updatedAt:iso(row.updated_at),...(row.tenant_id?{tenantId:row.tenant_id}:{}),...(row.current_step?{currentStep:row.current_step}:{}),...(row.blocking_code?{blockingCode:row.blocking_code}:{})};}
function activationView(row:ActivationRow):ActivationRequestView{return{id:row.id,tenantId:row.tenant_id,requestedBy:row.requested_by,status:row.status,createdAt:iso(row.created_at),...(row.decided_at?{decidedAt:iso(row.decided_at)}:{})};}
interface ApplicationDocumentRow{readonly id:string;readonly application_id:string;readonly category:string;readonly file_name:string;readonly mime_type:string;readonly byte_size:number|string;readonly sha256:string;readonly status:ApplicationDocumentView['status'];readonly created_at:string|Date;}
function applicationDocumentView(row:ApplicationDocumentRow):ApplicationDocumentView{return{id:row.id,applicationId:row.application_id,category:row.category,fileName:row.file_name,mimeType:row.mime_type,byteSize:Number(row.byte_size),sha256:row.sha256,status:row.status,createdAt:iso(row.created_at)};}
interface MessageRow{readonly id:string;readonly application_id:string;readonly direction:ExternalMessageView['direction'];readonly body:string;readonly attachment_ids:readonly string[];readonly created_at:string|Date;}
function messageView(row:MessageRow):ExternalMessageView{return{id:row.id,applicationId:row.application_id,direction:row.direction,body:row.body,createdAt:iso(row.created_at),...(row.attachment_ids.length?{attachmentIds:row.attachment_ids}:{})};}
interface InformationRequestRow{readonly id:string;readonly application_id:string;readonly category:InformationRequestView['category'];readonly question:string;readonly due_at:string|Date|null;readonly attachment_required:boolean;readonly status:InformationRequestView['status'];readonly created_at:string|Date;}
function informationRequestView(row:InformationRequestRow):InformationRequestView{return{id:row.id,applicationId:row.application_id,category:row.category,question:row.question,attachmentRequired:row.attachment_required,status:row.status,createdAt:iso(row.created_at),...(row.due_at?{dueAt:iso(row.due_at)}:{})};}
const platformOrganizationSelect=`select a.id,a.application_reference,a.status::text as status,a.status_version,a.organization_name,a.organization_number,a.organization_type,a.primary_email_ciphertext,a.primary_contact_name,a.primary_contact_title,a.applicant_visible_profile,a.assigned_to,a.linked_tenant_id,a.email_verified_at,a.submitted_at,a.decided_at,a.created_at,a.updated_at,
  pr.id as provisioning_request_id,pr.status::text as provisioning_status,pr.current_step as provisioning_current_step,
  pr.blocking_code as provisioning_blocking_code,pr.tenant_id as provisioning_tenant_id,t.status::text as tenant_status,
  domain.normalized_hostname as primary_hostname,coalesce(domain.domain_ready,false) as domain_ready
 from control.onboarding_applications a
 left join control.tenant_provisioning_requests pr on pr.application_id=a.id
 left join control.platform_tenants t on t.id=coalesce(a.linked_tenant_id,pr.tenant_id)
 left join lateral (
   select td.normalized_hostname,
          (td.status='active' and td.verification_status='verified' and td.tls_status='active') as domain_ready
     from control.tenant_domains td
    where td.tenant_id=t.id and td.is_primary and td.status<>'removed'
    order by td.updated_at desc,td.id desc limit 1
 ) domain on true`;
const applicationColumns=`id,application_reference,status::text as status,status_version,organization_name,organization_number,organization_type,primary_email_ciphertext,primary_contact_name,primary_contact_title,applicant_visible_profile,assigned_to,linked_tenant_id,email_verified_at,submitted_at,decided_at,created_at,updated_at`;
const informationRequestSelect=`select id,application_id,category,question,due_at,attachment_required,status,created_at from control.onboarding_information_requests`;
const provisioningSelect=`select id,application_id,tenant_id,status::text as status,current_step,blocking_code,attempts,created_at,updated_at from control.tenant_provisioning_requests`;
