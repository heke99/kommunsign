/**
 * Swedish locale formatting.
 *
 * Kungälv 2034 (menus, dialogs and error messages in Swedish) and 2035 (dates
 * as åååå-mm-dd and times as tt:mm).
 *
 * Formatting is done here rather than with `toLocaleString` because the
 * requirement names an exact format, and a locale-dependent formatter produces
 * whatever the server's locale happens to be. A server that drifts to `en-US`
 * would start rendering 08/07/2026 — which is a different date to a Swedish
 * reader, silently, with no error anywhere.
 *
 * Times are rendered in Swedish local time, not UTC. A user reading "gick ut
 * 14:00" needs the wall-clock time they experience; showing them UTC is a
 * off-by-an-hour bug that only appears half the year.
 */

export type LocaleErrorCode = 'LOCALE_TIMESTAMP_INVALID';

export class LocaleError extends Error {
  constructor(readonly code: LocaleErrorCode, message: string) {
    super(message);
    this.name = 'LocaleError';
  }
}

function parse(instant: string): Date {
  const parsed = Date.parse(instant);
  if (!Number.isFinite(parsed)) {
    throw new LocaleError('LOCALE_TIMESTAMP_INVALID', `Ogiltig tidsstämpel: ${instant}`);
  }
  return new Date(parsed);
}

/**
 * Sweden observes CET (UTC+1) and CEST (UTC+2), switching on the last Sunday in
 * March and the last Sunday in October, both at 01:00 UTC.
 *
 * Computed rather than taken from a timezone database so the output does not
 * depend on the host's tzdata being present and current — a container with a
 * stale or stripped tzdata is common, and would shift every displayed time by
 * an hour without failing.
 */
export function swedishUtcOffsetHours(instant: Date): 1 | 2 {
  const year = instant.getUTCFullYear();
  const lastSunday = (month: number): number => {
    const last = new Date(Date.UTC(year, month + 1, 0));
    return last.getUTCDate() - last.getUTCDay();
  };
  const summerStart = Date.UTC(year, 2, lastSunday(2), 1);
  const summerEnd = Date.UTC(year, 9, lastSunday(9), 1);
  const time = instant.getTime();
  return time >= summerStart && time < summerEnd ? 2 : 1;
}

function shifted(instant: Date): Date {
  return new Date(instant.getTime() + swedishUtcOffsetHours(instant) * 3_600_000);
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** åååå-mm-dd (ISO 8601, which is also the Swedish standard). */
export function formatSwedishDate(instant: string): string {
  const local = shifted(parse(instant));
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}`;
}

/** tt:mm, 24-hour. */
export function formatSwedishTime(instant: string): string {
  const local = shifted(parse(instant));
  return `${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}`;
}

/** åååå-mm-dd tt:mm. */
export function formatSwedishDateTime(instant: string): string {
  return `${formatSwedishDate(instant)} ${formatSwedishTime(instant)}`;
}

/**
 * For evidence and archive output, where the reader may be in another timezone
 * decades later. Keeps the Swedish display format but states the offset, so the
 * value stays unambiguous without forcing the reader to parse ISO 8601.
 */
export function formatSwedishTimestampWithOffset(instant: string): string {
  const offset = swedishUtcOffsetHours(parse(instant));
  return `${formatSwedishDateTime(instant)} (UTC+${offset})`;
}

/**
 * Error and status text, in Swedish.
 *
 * Centralised so a message cannot be introduced in English by whoever adds the
 * next endpoint: `messageFor` is the only way to turn a code into user-facing
 * text, and an unknown code yields a Swedish fallback rather than the raw code.
 * Showing a caller `PADES_TIMESTAMP_MISSING` is both untranslated and a leak of
 * internal structure.
 */
const MESSAGES: Readonly<Record<string, string>> = {
  // Behörighet och identitet
  UNAUTHENTICATED: 'Du är inte inloggad. Logga in och försök igen.',
  FORBIDDEN: 'Du saknar behörighet för den här åtgärden.',
  NOT_FOUND: 'Resursen finns inte.',
  RATE_LIMITED: 'För många försök. Vänta en stund och försök igen.',
  // Dokument
  DOCUMENT_PDF_POLICY_REJECTED: 'Endast PDF-filer tas emot.',
  DOCUMENT_TOO_LARGE: 'Filen är för stor.',
  PDF_ENCRYPTED: 'Dokumentet är lösenordsskyddat och kan inte behandlas.',
  PDF_JAVASCRIPT: 'Dokumentet innehåller aktivt innehåll och kan inte behandlas.',
  OFFICE_MACRO_FORMAT_REJECTED: 'Makroaktiverade Office-format tas inte emot. Spara om dokumentet utan makron.',
  OFFICE_FORMAT_NOT_SUPPORTED: 'Filformatet stöds inte.',
  // Signering
  WORKFLOW_STEP_NOT_REACHED: 'Det är inte din tur att skriva under ännu.',
  WORKFLOW_SIGNER_ALREADY_FINISHED: 'Du har redan hanterat det här ärendet.',
  WORKFLOW_CASE_NOT_ACTIVE: 'Ärendet tar inte emot fler underskrifter.',
  WORKFLOW_ATTACHMENT_NOT_BOUND: 'Handlingarna har ändrats sedan inbjudan skapades. Begär en ny inbjudan.',
  SIGNING_PROVIDER_NOT_CONFIGURED: 'Underskriftstjänsten är inte tillgänglig. Kontakta din administratör.',
  PADES_NOT_VALIDATED: 'Underskriften kunde inte valideras och har därför inte registrerats.',
  // Gallring och integritet
  GALLRING_SELF_APPROVAL: 'Gallring måste godkännas av någon annan än den som begärde den.',
  GALLRING_APPROVER_NOT_PERMITTED: 'Du saknar behörighet att godkänna gallring.',
  GALLRING_DECISION_STALE: 'Underlaget har ändrats sedan gallringen begärdes. Begär en ny bedömning.',
  PRIVACY_IDENTITY_NOT_VERIFIED: 'Identiteten måste styrkas innan begäran kan handläggas.',
  PRIVACY_ERASURE_BLOCKED_BY_LEGAL_HOLD: 'Uppgifterna omfattas av bevarandebeslut och kan inte raderas.',
};

const FALLBACK = 'Något gick fel. Försök igen, eller kontakta support med ärendets referens.';

export function messageFor(code: string): string {
  return MESSAGES[code] ?? FALLBACK;
}

export function hasSwedishMessage(code: string): boolean {
  return Object.hasOwn(MESSAGES, code);
}
