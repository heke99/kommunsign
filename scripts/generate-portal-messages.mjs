// Generates apps/<portal>/public/messages.js from packages/locale.
//
// The portals are static pages served as classic scripts, so they cannot import
// the package directly. Before this generator each portal that needed Swedish
// error text either kept its own table or showed the raw code — which is how a
// signer came to read SIGNING_ORDER_BLOCKED on the page where they were trying
// to sign a decision.
//
// messageFor is emitted from the compiled function's own source rather than
// rewritten here, so the browser copy cannot fall out of step with the one the
// server uses.

import { readFile, writeFile } from 'node:fs/promises';

const BANNER = `// Generated from packages/locale by scripts/generate-portal-messages.mjs.
// Do not edit: add the message to packages/locale and run npm run build.
`;

export async function generatePortalMessages(portals) {
  const locale = await import('../dist/packages/locale/src/index.js').catch(() => {
    throw new Error('dist/packages/locale is missing; run tsc before the portal build');
  });
  const source = `${BANNER}const MESSAGES = Object.freeze(${JSON.stringify(locale.MESSAGES, null, 2)});
const FALLBACK = ${JSON.stringify(locale.FALLBACK)};
globalThis.messageFor = ${locale.messageFor.toString()};
globalThis.hasSwedishMessage = ${locale.hasSwedishMessage.toString()};
`;
  let written = 0;
  for (const portal of portals) {
    const path = `apps/${portal}/public/messages.js`;
    const existing = await readFile(path, 'utf8').catch(() => null);
    if (existing === source) continue;
    await writeFile(path, source, 'utf8');
    written += 1;
  }
  return { messages: Object.keys(locale.MESSAGES).length, written };
}
