import { spawnSync } from 'node:child_process';
import { createConnection } from 'node:net';

const checks = [];
await run('CLAMAV', () => pingClamAv(value('CLAMAV_HOST', '127.0.0.1'), integer('CLAMAV_PORT', 3310), integer('CLAMAV_TIMEOUT_MS', 30_000)));
await run('QPDF', () => qpdfVersion(value('QPDF_COMMAND', 'qpdf')));
await run('GOTENBERG', () => httpHealth(value('GOTENBERG_HEALTH_URL', `${required('GOTENBERG_URL').replace(/\/$/, '')}/health`)));
await run('VERAPDF', () => httpHealth(required('VERAPDF_HEALTH_URL')));
await run('EVIDENCE_VERIFIER', () => httpHealth(value('VALIDATION_SERVICE_HEALTH_URL', `${required('VALIDATION_SERVICE_URL').replace(/\/$/, '')}/health`), required('VALIDATION_SERVICE_TOKEN')));
for (const check of checks) console.log(`${check.name}: ${check.passed ? 'OK' : `FAIL (${check.detail})`}`);
if (checks.some((check) => !check.passed)) process.exitCode = 2;

async function run(name, operation) {
  try { checks.push({ name, passed: true, detail: await operation() }); }
  catch (error) { checks.push({ name, passed: false, detail: safe(error) }); }
}
function qpdfVersion(command) {
  const result = spawnSync(command, ['--version'], { encoding: 'utf8', timeout: 10_000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('QPDF_VERSION_COMMAND_FAILED');
  const firstLine = String(result.stdout).trim().split('\n')[0];
  if (!/^qpdf version /i.test(firstLine)) throw new Error('QPDF_VERSION_RESPONSE_INVALID');
  return firstLine;
}
function pingClamAv(host, port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('CLAMAV_TIMEOUT')); }, timeoutMs);
    let response = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write('zPING\0'));
    socket.on('data', (chunk) => { response += chunk; if (response.includes('PONG')) { clearTimeout(timer); socket.end(); resolve('PONG'); } });
    socket.on('error', (error) => { clearTimeout(timer); reject(error); });
    socket.on('close', () => { if (!response.includes('PONG')) { clearTimeout(timer); reject(new Error('CLAMAV_PONG_MISSING')); } });
  });
}
async function httpHealth(url, bearerToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: bearerToken ? { authorization: `Bearer ${bearerToken}` } : {} });
    if (!response.ok) throw new Error(`HTTP_${response.status}`);
    return `${new URL(url).origin} HTTP ${response.status}`;
  } finally { clearTimeout(timer); }
}
function required(name) { const result = process.env[name]?.trim(); if (!result) throw new Error(`${name}_MISSING`); return result; }
function value(name, fallback) { return process.env[name]?.trim() || fallback; }
function integer(name, fallback) { const parsed = Number(value(name, String(fallback))); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name}_INVALID`); return parsed; }
function safe(error) { return error instanceof Error ? error.message.replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, 160) : 'UNKNOWN_ERROR'; }
