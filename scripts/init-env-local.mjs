import { copyFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const source = '.env.local.example';
const target = '.env.local';
try {
  await access(target, constants.F_OK);
  console.log(`${target} finns redan och lämnades oförändrad.`);
} catch {
  await copyFile(source, target);
  console.log(`${target} skapades från ${source}. Fyll endast de markerade värden du behöver.`);
}
