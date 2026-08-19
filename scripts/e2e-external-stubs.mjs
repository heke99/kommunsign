#!/usr/bin/env node
// Stands in for the suppliers outside the system during the application-chain
// E2E: the transactional email provider and the BankID broker.
//
// It serves HTTPS with a certificate generated per run, because both provider
// clients refuse a plaintext base URL and that refusal is worth keeping. The
// production ResendEmailProvider and TicBankIdProvider run unchanged against
// this; nothing inside the system is mocked.
//
// What this cannot stand in for is the BankID signature itself. Completion data
// is signed by BankID's own key and verified against their CA, so no local
// process can produce evidence that passes verification. The chain's identity
// leg therefore stops at "session completed" here, and the E2E asserts that the
// system refuses to move a signer to signed on that alone -- which is the
// property the whole design turns on.

import { createServer } from 'node:https';
import { readFileSync } from 'node:fs';

const port = Number(process.env.E2E_STUB_PORT ?? 8443);
const directory = process.env.E2E_STUB_DIR ?? 'build/e2e-app';
const sessions = new Map();
const delivered = [];

const server = createServer(
  { key: readFileSync(`${directory}/stub-key.pem`), cert: readFileSync(`${directory}/stub-cert.pem`) },
  (request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(request.url ?? '/', `https://127.0.0.1:${port}`);
      const send = (status, payload) => {
        const bytes = Buffer.from(JSON.stringify(payload));
        response.writeHead(status, { 'content-type': 'application/json', 'content-length': bytes.length });
        response.end(bytes);
      };

      // --- transactional email ---------------------------------------------
      if (request.method === 'POST' && url.pathname === '/emails') {
        const parsed = body ? JSON.parse(body) : {};
        delivered.push({ to: parsed.to, subject: parsed.subject, at: new Date().toISOString() });
        return send(200, { id: `stub-${delivered.length}` });
      }
      if (request.method === 'GET' && url.pathname === '/stub/emails') return send(200, { delivered });

      // --- BankID broker ----------------------------------------------------
      if (request.method === 'POST' && url.pathname === '/signatures') {
        const sessionId = `stub-session-${sessions.size + 1}`;
        sessions.set(sessionId, { status: 'PENDING', startedAt: Date.now() });
        return send(200, {
          sessionId,
          autoStartToken: '00000000-0000-0000-0000-000000000000',
          qrStartToken: '00000000-0000-0000-0000-000000000001',
          qrStartSecret: 'stub-secret',
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        });
      }
      const status = url.pathname.match(/^\/signatures\/([^/]+)\/status$/);
      if (request.method === 'POST' && status) {
        const session = sessions.get(status[1]);
        if (!session) return send(404, { error: 'unknown session' });
        // One poll pending, then complete: enough to exercise the polling path
        // without making the E2E wait on a wall clock.
        if (session.status === 'PENDING') session.status = 'COMPLETE';
        return send(200, { status: session.status === 'COMPLETE' ? 'complete' : 'pending' });
      }
      const collect = url.pathname.match(/^\/signatures\/([^/]+)$/);
      if (request.method === 'GET' && collect) {
        const session = sessions.get(collect[1]);
        if (!session) return send(404, { error: 'unknown session' });
        return send(200, {
          sessionId: collect[1],
          status: 'complete',
          // Deliberately not a real BankID signature. Nothing local can mint
          // one, and the system must refuse this rather than accept it.
          completionData: { signature: 'c3R1Yi1ub3QtYS1yZWFsLWJhbmtpZC1zaWduYXR1cmU=', ocspResponse: 'c3R1Yg==' },
        });
      }
      if (request.method === 'DELETE' && collect) {
        sessions.delete(collect[1]);
        return send(204, {});
      }

      if (url.pathname === '/health') return send(200, { status: 'UP' });
      return send(404, { error: 'not implemented by the stub', path: url.pathname });
    });
  },
);

server.listen(port, '127.0.0.1', () => {
  console.log(JSON.stringify({ level: 'info', event: 'e2e_stubs_listening', port }));
});
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => process.exit(0)));
