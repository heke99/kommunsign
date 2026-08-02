import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const requiredNodeMajor = 22;
const currentNodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '0', 10);

if (currentNodeMajor < requiredNodeMajor) {
  throw new Error(
    `KommunSign requires Node.js ${requiredNodeMajor} or newer; current version is ${process.versions.node}.`,
  );
}

const localTypeScriptPackage = resolve('node_modules/typescript/package.json');
try {
  await access(localTypeScriptPackage);
} catch {
  throw new Error(
    'Local dependencies are missing. Run `npm ci` from the KommunSign repository root, then run `npm run verify` again.',
  );
}

const typeScriptPackage = JSON.parse(await readFile(localTypeScriptPackage, 'utf8'));
if (typeScriptPackage.version !== '5.8.3') {
  throw new Error(
    `Unexpected TypeScript version ${String(typeScriptPackage.version)}. Run \`npm ci\` to install the locked version 5.8.3.`,
  );
}

console.log(`toolchain verification: Node ${process.versions.node}, TypeScript ${typeScriptPackage.version}`);
