import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { ConfiguredJsonExternalSigningProvider } from '../dist/packages/provider-adapters/src/external-signing.js';
import { jitteredRetryDelaySeconds, retryDelaySeconds } from '../dist/apps/workers/src/jobs.js';

assert.throws(() => new ConfiguredJsonExternalSigningProvider({
  baseUrl:'http://provider.invalid',apiCredential:'12345678',createPath:'/create',statusPathTemplate:'/status/{reference}',artifactPathTemplate:'/artifact/{reference}',
}), /EXTERNAL_SIGNING_HTTPS_REQUIRED/);
assert.throws(() => new ConfiguredJsonExternalSigningProvider({
  baseUrl:'https://provider.example',apiCredential:'short',createPath:'/create',statusPathTemplate:'/status/{reference}',artifactPathTemplate:'/artifact/{reference}',
}), /EXTERNAL_SIGNING_CREDENTIAL_INVALID/);
assert.throws(() => new ConfiguredJsonExternalSigningProvider({
  baseUrl:'https://provider.example',apiCredential:'credential-value',createPath:'/create',statusPathTemplate:'/status/no-placeholder',artifactPathTemplate:'/artifact/{reference}',
}), /EXTERNAL_SIGNING_PATH_TEMPLATE_INVALID/);

for (let attempt=1; attempt<=12; attempt+=1) {
  const base=retryDelaySeconds(attempt);
  const jitter=jitteredRetryDelaySeconds('00000000-0000-4000-8000-000000000001',attempt);
  assert.ok(jitter>=Math.max(1,Math.round(base/2)) && jitter<=base, `jitter ${jitter} outside equal-jitter range for base ${base}`);
  assert.equal(jitter,jitteredRetryDelaySeconds('00000000-0000-4000-8000-000000000001',attempt));
}

const source=new TextEncoder().encode('%PDF-1.7\nsource');
const sourceHash=createHash('sha256').update(source).digest('hex');
const signed=new TextEncoder().encode('%PDF-1.7\nsigned');
const calls=[];
const originalFetch=globalThis.fetch;
globalThis.fetch=async (url,init={})=>{
  calls.push({url:String(url),method:init.method,authorization:new Headers(init.headers).get('authorization')});
  const path=new URL(String(url)).pathname;
  if (path==='/configured/create') return new Response(JSON.stringify({providerReference:'provider-123',status:'pending',redirectUrl:'https://provider.example/sign/provider-123'}),{status:200,headers:{'content-type':'application/json'}});
  if (path==='/configured/status/provider-123') return new Response(JSON.stringify({status:'completed',providerCompletedAt:'2026-08-11T22:00:00Z'}),{status:200,headers:{'content-type':'application/json'}});
  if (path==='/configured/artifact/provider-123') return new Response(signed,{status:200,headers:{'content-type':'application/pdf'}});
  return new Response('not found',{status:404});
};
try {
  const provider=new ConfiguredJsonExternalSigningProvider({
    baseUrl:'https://provider.example',apiCredential:'credential-value',createPath:'/configured/create',statusPathTemplate:'/configured/status/{reference}',artifactPathTemplate:'/configured/artifact/{reference}',requestTimeoutMs:2000,
  });
  const started=await provider.start({idempotencyKey:'idem-12345678',callbackUrl:'https://kommunsign.se/provider-callback',signerReference:'opaque-signer',documentName:'document.pdf',documentBytes:source,documentSha256:sourceHash,metadata:{caseReference:'opaque-case'}});
  assert.equal(started.providerReference,'provider-123');
  assert.equal(started.status,'pending');
  const status=await provider.status(started.providerReference);
  assert.equal(status.status,'completed');
  const artifact=await provider.fetchFinalArtifact(started.providerReference);
  assert.equal(artifact.sha256,createHash('sha256').update(signed).digest('hex'));
  assert.equal(calls.length,3);
  assert.ok(calls.every((call)=>call.authorization==='Bearer credential-value'));
} finally {
  globalThis.fetch=originalFetch;
}

console.log('Provider runtime verification: OK');
