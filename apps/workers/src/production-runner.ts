declare const process: { readonly env: Readonly<Record<string, string | undefined>>; readonly pid: number; on(signal: string, listener: () => void): void };
import { processClaimedJob, type DurableJobRepository, type DurableJobType, type DurableJob } from './jobs.js';

interface ProductionWorkerAdapter {
  readonly repository: DurableJobRepository;
  readonly handlers: Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>>;
  readonly close?: () => Promise<void>;
  readonly onJobReady?: (handler: () => void) => Promise<() => Promise<void>>;
}
interface ProductionWorkerModule {
  readonly createProductionWorkerAdapter?: (configuration: Readonly<Record<string, string>>) => Promise<ProductionWorkerAdapter> | ProductionWorkerAdapter;
}
function boundedInteger(name: string, fallback: string, minimum: number, maximum: number): number {
  const parsed=Number.parseInt(process.env[name]?.trim()||fallback,10);
  if(!Number.isInteger(parsed)||parsed<minimum||parsed>maximum)throw new Error(`${name}_INVALID`);
  return parsed;
}
function required(name: string): string { const value=process.env[name]?.trim(); if(!value)throw new Error(`${name}_MISSING`); return value; }

if (process.env.APP_ENV !== 'production') throw new Error('PRODUCTION_WORKER_REQUIRES_PRODUCTION_ENV');
const moduleName=required('KOMMUNSIGN_WORKER_ADAPTER_MODULE');
if(moduleName.includes('dev-runner'))throw new Error('DEVELOPMENT_WORKER_FORBIDDEN_IN_PRODUCTION');
const loaded=await import(moduleName) as ProductionWorkerModule;
if(typeof loaded.createProductionWorkerAdapter!=='function')throw new Error('PRODUCTION_WORKER_ADAPTER_EXPORT_MISSING');
required('CONTROL_DATABASE_URL');
required('DATA_DATABASE_URL');
const configuration=Object.fromEntries(
  Object.entries(process.env).filter((entry): entry is [string,string]=>typeof entry[1]==='string'),
);
const adapter=await loaded.createProductionWorkerAdapter(configuration);
const workerId=process.env.WORKER_ID?.trim()||`kommunsign-${process.pid}-${crypto.randomUUID()}`;
const claimLimit=Number.parseInt(process.env.WORKER_CLAIM_LIMIT??'10',10);
const leaseSeconds=Number.parseInt(process.env.WORKER_LEASE_SECONDS??'60',10);
const pollMilliseconds=boundedInteger('WORKER_POLL_MILLISECONDS','1000',100,60_000);
// An idle queue used to be polled once a second forever. Each poll listed every tenant and
// opened a transaction per tenant, which is what produced 384k claim calls and 192k tenant
// listings in production for a handful of actual jobs. Backing off when there is nothing to
// do costs idle pickup latency and nothing else; the delay resets the moment work appears.
const maximumPollMilliseconds=boundedInteger('WORKER_POLL_MAX_MILLISECONDS','30000',pollMilliseconds,600_000);
const pollBackoffFactor=boundedInteger('WORKER_POLL_BACKOFF_FACTOR','2',1,10);
let idlePollMilliseconds=pollMilliseconds;
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;wake();});

// Backing off is what keeps an idle queue from hammering the database, but on its own it also means
// a document can sit for the length of the backoff before anything looks at it. The database now
// signals when a job becomes claimable (migration 0035), so the sleep is interrupted instead of
// waited out: idle costs stay low AND a new job is picked up immediately. If the subscription cannot
// be established the loop still polls, just less promptly.
let wake:()=>void=()=>{};
const sleepUntilWorkOrTimeout=(milliseconds:number):Promise<void>=>new Promise((resolve)=>{
  const timer=setTimeout(()=>{wake=()=>{};resolve();},milliseconds);
  wake=()=>{clearTimeout(timer);wake=()=>{};resolve();};
});
let unlisten:(()=>Promise<void>)|null=null;
try{
  unlisten=await adapter.onJobReady?.(()=>wake())??null;
}catch(cause){
  console.error(JSON.stringify({level:'warn',event:'worker_wakeup_unavailable',
    code:cause instanceof Error&&/^[A-Z][A-Z0-9_]{2,79}$/.test(cause.message)?cause.message:'LISTEN_FAILED'}));
}

while(!stopping){
  const jobs=await adapter.repository.claim(workerId,claimLimit,leaseSeconds);
  await Promise.all(jobs.map((job)=>processClaimedJob(adapter.repository,workerId,job,adapter.handlers)));
  if(jobs.length===0){
    // Jitter keeps a restarted fleet from re-synchronising into a thundering herd.
    const jittered=idlePollMilliseconds*(0.8+Math.random()*0.4);
    await sleepUntilWorkOrTimeout(Math.round(jittered));
    idlePollMilliseconds=Math.min(idlePollMilliseconds*pollBackoffFactor,maximumPollMilliseconds);
  } else {
    idlePollMilliseconds=pollMilliseconds;
  }
}
await unlisten?.().catch(()=>undefined);
await adapter.close?.();
