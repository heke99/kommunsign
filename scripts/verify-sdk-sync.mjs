import { readFile } from 'node:fs/promises';
const api = await readFile('docs/api/openapi.yaml', 'utf8');
const version = api.match(/version: '([^']+)'/)?.[1];
if (!version) throw new Error('OpenAPI version missing');
for (const file of ['sdks/typescript/src/client.ts','sdks/csharp/src/KommunSignClient.cs','sdks/java/src/main/java/se/kommunsign/sdk/KommunSignClient.java']) {
  const source = await readFile(file, 'utf8');
  if (!source.includes(version)) throw new Error(`${file} is not synchronized with OpenAPI ${version}`);
}
for (const operation of ['listSignaturePolicies','createSignatureCase','listSignatureCases','getSignatureCase','addDocument','addSigner','sendSignatureCase','cancelSignatureCase','listPlatformOrganizations','createPlatformOrganization']) {
  if (!api.includes(`operationId: ${operation}`)) throw new Error(`OpenAPI operation missing: ${operation}`);
}
console.log(`SDK sync verification: ${version}`);
