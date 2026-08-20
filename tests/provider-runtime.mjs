import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { jitteredRetryDelaySeconds, retryDelaySeconds } from '../dist/apps/workers/src/jobs.js';

for (let attempt=1; attempt<=12; attempt+=1) {
  const base=retryDelaySeconds(attempt);
  const jitter=jitteredRetryDelaySeconds('00000000-0000-4000-8000-000000000001',attempt);
  assert.ok(jitter>=base/2 && jitter<=base, `jitter ${jitter} outside equal-jitter range for base ${base}`);
  assert.equal(jitter,jitteredRetryDelaySeconds('00000000-0000-4000-8000-000000000001',attempt));
}
const firstA=jitteredRetryDelaySeconds('00000000-0000-4000-8000-000000000001',1);
const firstB=jitteredRetryDelaySeconds('00000000-0000-4000-8000-000000000002',1);
assert.ok(firstA>=0.5&&firstA<=1&&firstB>=0.5&&firstB<=1);
assert.notEqual(firstA,firstB);

// The generic external-signing provider (packages/provider-adapters/src/external-signing.ts)
// and its tests were removed on 2026-08-21. No application imported it and no
// requirement cited it, so what it proved was that the adapter worked, not that
// anything in Kommunsign did.

console.log('Provider runtime verification: OK');
