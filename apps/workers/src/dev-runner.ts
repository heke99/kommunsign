const processLike = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process;
if (processLike?.env?.APP_ENV === 'production') throw new Error('DEVELOPMENT_WORKER_FORBIDDEN_IN_PRODUCTION');
console.log(JSON.stringify({ service: 'kommunsign-workers', mode: 'development', status: 'idle', note: 'Database-backed worker bootstrap is required for production.' }));
