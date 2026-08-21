'use strict';
// SHA-256 över hela filen tog tidigare main thread i anspråk. För en 20 MB-fil är det hundratals
// millisekunder av fryst flik, precis i det ögonblick användaren har tryckt på knappen och förväntar
// sig att något ska hända. Här kostar samma arbete ingenting synligt.
//
// Filen skickas som File-objekt och läses här inne, så bytesen aldrig passerar main thread.
self.addEventListener('message', async (event) => {
  try {
    const file = event.data && event.data.file;
    if (!file) throw new Error('DOCUMENT_HASH_INPUT_MISSING');
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    self.postMessage({ sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('') });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'DOCUMENT_HASH_FAILED' });
  }
});
