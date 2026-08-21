import type { DomainEvent, TenantContext } from '../../../../../packages/contracts/src/index.js';
import { withTenantTransaction, type SqlDatabase } from '../../../../../packages/database/src/index.js';
import type { DataRepositories } from './data-database.js';
import type { Page, PageInput, SignatureCaseView, TemplateView } from '../../ports.js';

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const MAX_LIMIT = 200;
const CURSOR_MAX_BYTES = 1024;

type CaseCursor = { readonly v:1; readonly t:'case'; readonly createdAt:string; readonly id:string };
type EventCursor = { readonly v:1; readonly t:'event'; readonly occurredAt:string; readonly id:string };
type TemplateCursor = { readonly v:1; readonly t:'template'; readonly templateKey:string; readonly locale:string; readonly version:number; readonly id:string };

export function withKeysetListRepositories(database: SqlDatabase, base: DataRepositories): DataRepositories {
  return {
    ...base,
    cases: { ...base.cases, list: (context,page) => listCases(database,context,page) },
    events: { ...base.events, list: (context,page) => listEvents(database,context,page) },
    templates: { ...base.templates, list: (context,page) => listTemplates(database,context,page) },
  };
}

async function listCases(database:SqlDatabase, context:TenantContext, page:PageInput):Promise<Page<SignatureCaseView>> {
  const limit=pageLimit(page);
  const cursor=page.cursor ? decodeCaseCursor(page.cursor) : undefined;
  return tenant(database,context,async(tx)=>{
    // Two query texts rather than one with "cursor is null or ...". The OR form only becomes an
    // index bound when the planner can see the parameter values; under a generic plan it degrades to
    // Index Cond on tenant_id plus a filter, which walks the whole tenant range and makes page N cost
    // O(N x limit). Splitting it keeps the row comparison a true index start condition either way.
    const result=cursor
      ? await tx.query<CaseRow>(
        `select id,tenant_id,status::text as status,status_version,decision_mode::text as decision_mode,title,external_reference,created_at
           from app.signature_cases
          where tenant_id=$1 and (created_at,id) < ($2::timestamptz,$3::uuid)
          order by created_at desc,id desc
          limit $4`,
        [context.tenantId,cursor.createdAt,cursor.id,limit+1],
      )
      : await tx.query<CaseRow>(
        `select id,tenant_id,status::text as status,status_version,decision_mode::text as decision_mode,title,external_reference,created_at
           from app.signature_cases
          where tenant_id=$1
          order by created_at desc,id desc
          limit $2`,
        [context.tenantId,limit+1],
      );
    const rows=result.rows.slice(0,limit);
    return {
      data:rows.map(caseView),
      ...(result.rows.length>limit && rows.length ? {nextCursor:encodeCursor({v:1,t:'case',createdAt:iso(rows.at(-1)!.created_at),id:rows.at(-1)!.id})}:{}),
    };
  });
}

async function listEvents(database:SqlDatabase, context:TenantContext, page:PageInput):Promise<Page<DomainEvent>> {
  const limit=pageLimit(page);
  const cursor=page.cursor ? decodeEventCursor(page.cursor) : undefined;
  return tenant(database,context,async(tx)=>{
    // Split for the same reason as the case listing above.
    const result=cursor
      ? await tx.query<EventRow>(
        `select id,event_type,payload,occurred_at from app.outbox_events
          where tenant_id=$1 and (occurred_at,id) < ($2::timestamptz,$3::uuid)
          order by occurred_at desc,id desc
          limit $4`,
        [context.tenantId,cursor.occurredAt,cursor.id,limit+1],
      )
      : await tx.query<EventRow>(
        `select id,event_type,payload,occurred_at from app.outbox_events
          where tenant_id=$1
          order by occurred_at desc,id desc
          limit $2`,
        [context.tenantId,limit+1],
      );
    const rows=result.rows.slice(0,limit);
    return {
      data:rows.map((row)=>({id:row.id,tenantId:context.tenantId,type:row.event_type,occurredAt:iso(row.occurred_at),apiVersion:'2026-08-01',data:row.payload})),
      ...(result.rows.length>limit && rows.length ? {nextCursor:encodeCursor({v:1,t:'event',occurredAt:iso(rows.at(-1)!.occurred_at),id:rows.at(-1)!.id})}:{}),
    };
  });
}

async function listTemplates(database:SqlDatabase, context:TenantContext, page:PageInput):Promise<Page<TemplateView>> {
  const limit=pageLimit(page);
  const cursor=page.cursor ? decodeTemplateCursor(page.cursor) : undefined;
  return tenant(database,context,async(tx)=>{
    const result=await tx.query<TemplateRow>(
      `select id,template_key,version,locale,subject_template,body_template,active
         from app.notification_templates
        where tenant_id=$1 and (
          $2::text is null
          or template_key>$2
          or (template_key=$2 and locale>$3)
          or (template_key=$2 and locale=$3 and version<$4)
          or (template_key=$2 and locale=$3 and version=$4 and id<$5::uuid)
        )
        order by template_key,locale,version desc,id desc
        limit $6`,
      [context.tenantId,cursor?.templateKey ?? null,cursor?.locale ?? null,cursor?.version ?? null,cursor?.id ?? null,limit+1],
    );
    const rows=result.rows.slice(0,limit);
    return {
      data:rows.map(templateView),
      ...(result.rows.length>limit && rows.length ? {nextCursor:encodeCursor({v:1,t:'template',templateKey:rows.at(-1)!.template_key,locale:rows.at(-1)!.locale,version:Number(rows.at(-1)!.version),id:rows.at(-1)!.id})}:{}),
    };
  });
}

function tenant<T>(database:SqlDatabase,context:TenantContext,work:Parameters<typeof withTenantTransaction<T>>[3]):Promise<T> {
  const actor=context.authMethod==='oauth2_client_credentials'||context.authMethod==='mtls'?'external_client':context.authMethod==='worker'?'worker':context.authMethod==='trusted_service'?'trusted_service':'internal_user';
  return withTenantTransaction(database,context,actor,work);
}
function pageLimit(page:PageInput):number {
  if (!Number.isInteger(page.limit) || page.limit<1) throw new Error('PAGE_LIMIT_INVALID');
  return Math.min(page.limit,MAX_LIMIT);
}
function encodeCursor(cursor:CaseCursor|EventCursor|TemplateCursor):string {
  const json=JSON.stringify(cursor);
  return bytesToBase64Url(UTF8.encode(json));
}
function decodeCaseCursor(value:string):CaseCursor {
  const candidate=decodeCursor(value);
  if (candidate.t!=='case' || typeof candidate.createdAt!=='string' || !isUuid(candidate.id) || !isIso(candidate.createdAt)) throw new Error('PAGE_CURSOR_INVALID');
  return candidate as CaseCursor;
}
function decodeEventCursor(value:string):EventCursor {
  const candidate=decodeCursor(value);
  if (candidate.t!=='event' || typeof candidate.occurredAt!=='string' || !isUuid(candidate.id) || !isIso(candidate.occurredAt)) throw new Error('PAGE_CURSOR_INVALID');
  return candidate as EventCursor;
}
function decodeTemplateCursor(value:string):TemplateCursor {
  const candidate=decodeCursor(value);
  if (candidate.t!=='template' || typeof candidate.templateKey!=='string' || typeof candidate.locale!=='string' || !Number.isInteger(candidate.version) || !isUuid(candidate.id)) throw new Error('PAGE_CURSOR_INVALID');
  return candidate as TemplateCursor;
}
function decodeCursor(value:string):Record<string,unknown> {
  if (!/^[A-Za-z0-9_-]{4,2048}$/.test(value)) throw new Error('PAGE_CURSOR_INVALID');
  try {
    const bytes=base64UrlToBytes(value);
    if (bytes.length>CURSOR_MAX_BYTES) throw new Error('PAGE_CURSOR_INVALID');
    const parsed:unknown=JSON.parse(UTF8_DECODER.decode(bytes));
    if (!parsed || typeof parsed!=='object' || Array.isArray(parsed) || (parsed as {v?:unknown}).v!==1) throw new Error('PAGE_CURSOR_INVALID');
    return parsed as Record<string,unknown>;
  } catch { throw new Error('PAGE_CURSOR_INVALID'); }
}
function bytesToBase64Url(bytes:Uint8Array):string {
  let binary='';
  for (const byte of bytes) binary+=String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}
function base64UrlToBytes(value:string):Uint8Array {
  const base64=value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'=');
  const binary=atob(base64);
  return Uint8Array.from(binary,(character)=>character.charCodeAt(0));
}
function isUuid(value:unknown):value is string { return typeof value==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isIso(value:string):boolean { const date=new Date(value); return Number.isFinite(date.valueOf()) && date.toISOString()===value; }
function iso(value:string|Date):string { return value instanceof Date?value.toISOString():new Date(value).toISOString(); }
function caseView(row:CaseRow):SignatureCaseView { return {id:row.id,tenantId:row.tenant_id,status:row.status,statusVersion:Number(row.status_version),decisionMode:row.decision_mode,title:row.title,createdAt:iso(row.created_at),...(row.external_reference?{externalReference:row.external_reference}:{})}; }
function templateView(row:TemplateRow):TemplateView { return {id:row.id,templateKey:row.template_key,version:Number(row.version),locale:row.locale,subjectTemplate:row.subject_template,bodyTemplate:row.body_template,active:row.active}; }

interface CaseRow { readonly id:string; readonly tenant_id:string; readonly status:SignatureCaseView['status']; readonly status_version:number|string; readonly decision_mode:SignatureCaseView['decisionMode']; readonly title:string; readonly external_reference:string|null; readonly created_at:string|Date; }
interface EventRow { readonly id:string; readonly event_type:string; readonly payload:Readonly<Record<string,unknown>>; readonly occurred_at:string|Date; }
interface TemplateRow { readonly id:string; readonly template_key:string; readonly version:number|string; readonly locale:string; readonly subject_template:string; readonly body_template:string; readonly active:boolean; }
