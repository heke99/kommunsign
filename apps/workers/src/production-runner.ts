declare const process: { readonly env: Readonly<Record<string, string | undefined>>; readonly pid: number; on(signal: string, listener: () => void): void };
import { processClaimedJob, type DurableJobRepository, type DurableJobType, type DurableJob } from './jobs.js';

interface ProductionWorkerAdapter {
  readonly repository: DurableJobRepository;
  readonly handlers: Readonly<Record<DurableJobType, (job: DurableJob) => Promise<void>>>;
  readonly close?: () => Promise<void>;
}
interface ProductionWorkerModule {
  readonly createProductionWorkerAdapter?: (configuration: Readonly<Record<string, string>>) => Promise<ProductionWorkerAdapter> | ProductionWorkerAdapter;
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
const pollMilliseconds=Number.parseInt(process.env.WORKER_POLL_MILLISECONDS??'1000',10);
let stopping=false;
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;});
while(!stopping){
  const jobs=await adapter.repository.claim(workerId,claimLimit,leaseSeconds);
  await Promise.all(jobs.map((job)=>processClaimedJob(adapter.repository,workerId,job,adapter.handlers)));
  if(jobs.length===0)await new Promise((resolve)=>setTimeout(resolve,pollMilliseconds));
}
await adapter.close?.();
