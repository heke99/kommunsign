'use strict';
(() => {
  const OFFICE_MAX_BYTES = 50 * 1024 * 1024;
  const formats = new Map([
    ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
    ['.odt', 'application/vnd.oasis.opendocument.text'],
    ['.ods', 'application/vnd.oasis.opendocument.spreadsheet'],
    ['.rtf', 'application/rtf'],
  ]);
  const macroExtensions = ['.docm', '.xlsm', '.pptm', '.dotm', '.xltm', '.potm'];

  document.addEventListener('submit', async (event) => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || form.id !== 'document-form') return;
    const file = byId('document-file').files?.[0];
    if (!file) return;
    const extension = extensionOf(file.name);
    if (extension === '.pdf') return;

    event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();

    const caseId = byId('document-case').value;
    try {
      if (macroExtensions.includes(extension)) throw new Error(messageFor('OFFICE_MACRO_FORMAT_REJECTED'));
      const mimeType = formats.get(extension);
      if (!mimeType) throw new Error(messageFor('OFFICE_FORMAT_NOT_SUPPORTED'));
      if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > OFFICE_MAX_BYTES) throw new Error(messageFor('OFFICE_TOO_LARGE'));

      status('document-status', 'Kontrollerar Office-filen och beräknar SHA-256 lokalt.');
      // Bara containersignaturen behöver läsas här. Resten av filen rörs aldrig av huvudtråden:
      // hashningen sker i en worker och själva uppladdningen skickar Blob:en som den är.
      assertContainer(extension, new Uint8Array(await file.slice(0, 5).arrayBuffer()));
      const digest = await digestFile(file);

      const grant = await body(await api('/v1/uploads', {
        method: 'POST',
        headers: { 'idempotency-key': key() },
        body: JSON.stringify({ fileName: file.name, mimeType, byteSize: file.size, sha256: digest }),
      }));

      status('document-status', 'Laddar upp Office-källan till privat karantän.');
      showUploadProgress(0);
      try {
        await putWithProgress(grant.uploadUrl, { ...grant.requiredHeaders, 'content-type': mimeType }, file, showUploadProgress);
      } finally {
        hideUploadProgress();
      }

      await body(await api(`/v1/uploads/${grant.id}/complete`, {
        method: 'POST',
        headers: { 'idempotency-key': key() },
        body: JSON.stringify({ sha256: digest }),
      }));
      const view = await body(await api(`/v1/signature-cases/${caseId}/documents`, {
        method: 'POST',
        headers: { 'idempotency-key': key() },
        body: JSON.stringify({ uploadId: grant.id, displayName: file.name }),
      }));
      status(
        'document-status',
        `${file.name} ligger i karantän. Skadlig kod kontrolleras och Office-filen konverteras till verifierad PDF/A-2b innan den kan signeras.`,
      );
      await loadCaseDetail(caseId);
      renderPreview();
      // Konverteringen är asynkron. Utan bevakning står statusen kvar på karantän tills någon
      // själv trycker Visa, vilket ser ut som att uppladdningen aldrig blev klar.
      watchDocument(caseId, view.id, file.name);
    } catch (error) {
      hideUploadProgress();
      status('document-status', error instanceof Error ? error.message : messageFor('OFFICE_UPLOAD_FAILED'), 'error');
    }
  }, true);

  function extensionOf(name) {
    const lower = name.toLowerCase();
    const index = lower.lastIndexOf('.');
    return index >= 0 ? lower.slice(index) : '';
  }

  function assertContainer(extension, bytes) {
    if (extension === '.rtf') {
      if (bytes.length < 5 || bytes[0] !== 0x7b || bytes[1] !== 0x5c || bytes[2] !== 0x72 || bytes[3] !== 0x74 || bytes[4] !== 0x66) {
        throw new Error(messageFor('OFFICE_MAGIC_BYTES_MISMATCH'));
      }
      return;
    }
    const zip = bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b
      && ((bytes[2] === 0x03 && bytes[3] === 0x04)
        || (bytes[2] === 0x05 && bytes[3] === 0x06)
        || (bytes[2] === 0x07 && bytes[3] === 0x08));
    if (!zip) throw new Error(messageFor('OFFICE_MAGIC_BYTES_MISMATCH'));
  }
})();
