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
export const MESSAGES: Readonly<Record<string, string>> = {
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

  // Underskrift och inbjudan, som en undertecknare kan möta i signeringsportalen.
  SIGNING_ORDER_BLOCKED: 'Det är inte din tur att skriva under ännu. Du får ett nytt meddelande när handlingen är redo för dig.',
  DOCUMENT_REVIEW_REQUIRED: 'Du måste öppna och granska handlingarna innan BankID kan startas.',
  INVITATION_INVALID: 'Länken är inte giltig. Kontakta avsändaren för en ny inbjudan.',
  INVITATION_EXPIRED: 'Länken har upphört att gälla. Kontakta avsändaren för en ny inbjudan.',
  INVITATION_REVOKED: 'Länken har ersatts eller återkallats. Använd den senaste inbjudan, eller kontakta avsändaren.',
  PERSONAL_NUMBER_REQUIRED: 'Personnummer krävs för den här underskriften.',
  PERSONAL_NUMBER_INVALID: 'Personnumret är inte giltigt. Ange det som ååååmmdd-nnnn.',
  PERSONAL_NUMBER_MISMATCH: 'BankID tillhör en annan person än den som är inbjuden att skriva under.',
  PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED: 'Undantag från personnummerbindning är inte tillåtet för den här signeringspolicyn.',
  PERSONAL_NUMBER_EXCEPTION_REASON_REQUIRED: 'Ange skäl för undantaget från personnummerbindning.',
  TIC_NOT_CONFIGURED: 'BankID är inte aktiverat för den här organisationen ännu.',
  TIC_RATE_LIMITED: 'BankID är hårt belastat just nu. Vänta en stund och försök igen.',
  TIC_SESSION_EXPIRED: 'BankID-sessionen har gått ut. Starta underskriften igen.',
  TIC_EVIDENCE_INVALID: 'Underskriften kunde inte styrkas. Försök igen, eller kontakta avsändaren.',
  TIC_SIGNATURE_INVALID: 'Underskriften kunde inte styrkas. Försök igen, eller kontakta avsändaren.',
  TIC_OCSP_MISSING: 'Underskriften kunde inte styrkas fullt ut just nu. Försök igen om en stund.',

  // Handlingar.
  DOCUMENT_NOT_READY: 'Handlingen förbereds fortfarande. Vänta en stund och uppdatera sidan.',
  DOCUMENT_INFECTED: 'Filen avvisades av virusskyddet.',
  DOCUMENT_HASH_MISMATCH: 'Handlingen har ändrats sedan den låstes. Ladda om sidan och börja om.',
  DOCUMENT_PAGE_LIMIT_EXCEEDED: 'Handlingen har fler sidor än vad tjänsten tar emot.',
  DOCUMENT_PDFA_CONVERSION_FAILED: 'Filen kunde inte konverteras till arkivformat. Spara om den och försök igen.',
  DOCUMENT_PDFA_VALIDATION_FAILED: 'Filen uppfyller inte arkivformatet PDF/A.',
  DOCUMENT_PDF_MAGIC_INVALID: 'Filen är inte en PDF, trots filnamnet.',
  UPLOAD_GRANT_ALREADY_USED: 'Uppladdningen är redan genomförd. Uppdatera sidan.',
  OFFICE_TOO_LARGE: 'Filen är för stor.',
  OFFICE_MAGIC_BYTES_MISMATCH: 'Filens innehåll stämmer inte med filändelsen.',
  OFFICE_UPLOAD_FAILED: 'Filen kunde inte laddas upp. Försök igen.',

  // Bevis och verifiering.
  EVIDENCE_PACKAGE_NOT_READY: 'Bevispaketet är inte färdigställt ännu.',
  EVIDENCE_ZIP_INVALID: 'Filen är inte ett giltigt bevispaket från Kommunsign.',

  // Session, inloggning och samtidiga ändringar.
  API_UNREACHABLE: 'Tjänsten kunde inte nås. Kontrollera din uppkoppling och försök igen.',
  AUTH_SESSION_INVALID: 'Din session har upphört. Logga in igen.',
  AUTH_INVALID_CREDENTIALS: 'Fel e-postadress eller lösenord.',
  AUTH_ACCOUNT_NOT_AUTHORIZED: 'Kontot saknar behörighet till den här miljön.',
  AUTH_DESTINATION_NOT_AVAILABLE: 'Din organisations miljö är inte tillgänglig just nu.',
  AUTH_PUBLIC_SIGNUP_DISABLED: 'Konton skapas av en administratör, inte här.',
  AUTH_REDIRECT_URL_INVALID: 'Länken du kom från är inte giltig. Börja om från inloggningssidan.',
  PASSWORD_POLICY_FAILED: 'Lösenordet uppfyller inte kraven.',
  CSRF_TOKEN_INVALID: 'Sidan var inaktuell. Ladda om och försök igen.',
  RESOURCE_VERSION_CONFLICT: 'Någon annan har ändrat uppgifterna. Ladda om sidan och gör om ändringen.',
  IDEMPOTENCY_KEY_REQUIRED: 'Begäran saknar unik nyckel. Ladda om sidan och försök igen.',
  VALIDATION_ERROR: 'Något i formuläret är inte ifyllt på rätt sätt.',
  SIGNATURE_POLICY_NOT_FOUND: 'Signeringspolicyn finns inte.',
  SIGNATURE_POLICY_DECISION_MODE_MISMATCH: 'Signeringspolicyn passar inte den valda beslutsformen.',
  ORGANIZATION_ACCOUNT_NOT_FOUND: 'Kontot finns inte i organisationen.',
  ORGANIZATION_USER_NOT_FOUND: 'Användaren finns inte i organisationen.',
  TENANT_NOT_READY_FOR_ACTIVATION: 'Organisationen är inte klar att aktiveras ännu.',

  // Plattformsadministration. Dessa låg tidigare i en egen tabell i
  // apps/platform-admin/public/app.js. Två tabeller är två uppsättningar text
  // som glider isär, och den som glider är alltid den som ingen läser förrän
  // felet inträffar.
  DATABASE_SCHEMA_OUTDATED: 'Databasmigrationerna för organisationsskapande är inte aktuella. Kör npm run db:migrate och npm run db:verify på både control- och data-databasen.',
  DATABASE_PERMISSION_DENIED: 'API-tjänstens databasroll saknar nödvändiga rättigheter för organisationsskapande.',
  DATABASE_UNAVAILABLE: 'Databasen eller provisioneringskön kan inte nås just nu.',
  ORGANIZATION_ALREADY_EXISTS: 'Det finns redan en aktiv ansökan eller organisation med detta organisationsnummer.',
  INVALID_APPLICATION_STATE_TRANSITION: 'Ansökan har redan gått vidare eller är ännu inte inskickad. Uppdatera ansökan och försök igen.',
  APPLICATION_ALREADY_CLOSED: 'Ansökan är redan avslutad och kan inte godkännas.',
  INVALID_PROVISIONING_STATE: 'Organisationens skapande kan inte startas om från nuvarande status. Uppdatera sidan och kontrollera statusen.',
  DEPLOYMENT_PROFILE_MISSING: 'Ansökan saknar vald driftform. Be sökanden komplettera ansökan innan organisationen skapas.',
  TWO_PERSON_APPROVAL_REQUIRED: 'En annan superadministratör måste anges eftersom hög eller kritisk risk har registrerats.',
  ORGANIZATION_PRIMARY_DOMAIN_NOT_ACTIVE: 'Organisationens inloggningsadress är inte klar. Uppdatera organisationen och försök igen.',
  ORGANIZATION_PROVISIONING_NOT_COMPLETED: 'Organisationen är fortfarande under skapande. Vänta tills statusen visar Organisation skapad.',
  ORGANIZATION_DATA_ENVIRONMENT_NOT_READY: 'Organisationens datamiljö är inte färdig. Kör om organisationsskapandet och kontrollera worker-loggen.',
  ORGANIZATION_ROLE_NOT_PROVISIONED: 'Organisationens standardroller är inte färdigskapade. Kontrollera provisioneringsstatusen.',
  AUTH_RATE_LIMITED: 'För många inbjudningar har begärts. Vänta en stund och försök igen.',
  AUTH_PROVIDER_TIMEOUT: 'Identitetstjänsten svarade inte i tid.',
  AUTH_PROVIDER_UNAVAILABLE: 'Identitetstjänsten är tillfälligt otillgänglig.',
  AUTH_PROVIDER_FAILURE: 'Identitetstjänsten kunde inte slutföra inbjudan.',
  AUTH_PROVIDER_REJECTED: 'Identitetstjänsten avvisade inbjudan. Kontrollera e-postkonfigurationen.',
  AUTH_PROVIDER_VALIDATION_FAILED: 'Identitetstjänsten avvisade uppgifterna i inbjudan.',
  AUTH_PROVIDER_RESPONSE_INVALID: 'Identitetstjänsten gav ett ogiltigt svar.',
  AUTH_PROVIDER_USER_LOOKUP_LIMIT: 'Identitetstjänstens användarsökning kunde inte slutföras.',
  AUTH_PROVIDER_IDENTITY_MISMATCH: 'Identitetstjänsten returnerade fel användaridentitet.',
  ORGANIZATION_ACCOUNT_INVITATION_CREATE_FAILED: 'Inbjudningsposten kunde inte sparas.',
  ORGANIZATION_ACCOUNT_PROVISION_FAILED: 'Kontot kunde inte kopplas till organisationen.',
  ORGANIZATION_USER_CREATE_FAILED: 'Organisationsanvändaren kunde inte skapas.',
  ORGANIZATION_MEMBERSHIP_CREATE_FAILED: 'Användarens organisationsmedlemskap kunde inte skapas.',
  EMAIL_INVALID: 'E-postadressen är ogiltig.',
  IDEMPOTENCY_CONFLICT: 'Begäran återanvändes med andra kontouppgifter. Uppdatera sidan och försök igen.',
};

export const FALLBACK = 'Något gick fel. Försök igen, eller kontakta support med ärendets referens.';

export function messageFor(code: string): string {
  return MESSAGES[code] ?? FALLBACK;
}

export function hasSwedishMessage(code: string): boolean {
  return Object.hasOwn(MESSAGES, code);
}
