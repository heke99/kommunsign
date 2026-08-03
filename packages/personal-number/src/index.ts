export const IDENTIFIER_BINDING_MODES = ['STRICT_PREBOUND', 'BANKID_DISCOVERED'] as const;
export type IdentifierBindingMode = (typeof IDENTIFIER_BINDING_MODES)[number];

export const IDENTIFIER_BINDING_EXCEPTION_CODES = [
  'UNKNOWN_AT_INVITATION',
  'DATA_MINIMIZATION',
  'PROTECTED_PERSONAL_DATA_WORKFLOW',
  'RECIPIENT_SELECTED_BY_SECURE_CHANNEL',
  'OTHER',
] as const;
export type IdentifierBindingExceptionCode = (typeof IDENTIFIER_BINDING_EXCEPTION_CODES)[number];

export interface PersonalNumberExceptionInput {
  readonly code: IdentifierBindingExceptionCode;
  readonly reason?: string | null;
}

export interface IdentifierBindingDecision {
  readonly mode: IdentifierBindingMode;
  readonly normalizedPersonalNumber?: string;
  readonly exception?: PersonalNumberExceptionInput;
}

/** Normalizes a Swedish personal identity number to YYYYMMDDNNNN and validates date + Luhn. */
export function normalizeSwedishPersonalNumber(input: string, referenceDate = new Date()): string {
  const digits = input.replace(/[\s+-]/g, '');
  if (!/^\d{10}(?:\d{2})?$/.test(digits)) throw personalNumberError('PERSONAL_NUMBER_INVALID');
  const twelve = digits.length === 12 ? digits : inferCentury(digits, referenceDate);
  const year = Number(twelve.slice(0, 4));
  const month = Number(twelve.slice(4, 6));
  const day = Number(twelve.slice(6, 8));
  if (!isCalendarDate(year, month, day) || !luhnValid(twelve.slice(2))) {
    throw personalNumberError('PERSONAL_NUMBER_INVALID');
  }
  return twelve;
}

export function maskSwedishPersonalNumber(normalized: string): string {
  if (!/^\d{12}$/.test(normalized)) throw personalNumberError('PERSONAL_NUMBER_INVALID');
  return `${normalized.slice(0, 4)}••••-${normalized.slice(8)}`;
}

export function decideIdentifierBinding(input: {
  readonly personalNumber?: string | null;
  readonly requirePersonalNumberMatch: boolean;
  readonly exception?: PersonalNumberExceptionInput | null;
  readonly tenantAllowsException: boolean;
  readonly actorHasExceptionPermission: boolean;
  readonly referenceDate?: Date;
}): IdentifierBindingDecision {
  const raw = input.personalNumber?.trim();
  if (raw) {
    if (!input.requirePersonalNumberMatch || input.exception) throw personalNumberError('PERSONAL_NUMBER_INVALID');
    return { mode: 'STRICT_PREBOUND', normalizedPersonalNumber: normalizeSwedishPersonalNumber(raw, input.referenceDate) };
  }
  if (input.requirePersonalNumberMatch) throw personalNumberError('PERSONAL_NUMBER_REQUIRED');
  if (!input.exception) throw personalNumberError('PERSONAL_NUMBER_REQUIRED');
  if (!input.tenantAllowsException || !input.actorHasExceptionPermission) {
    throw personalNumberError('PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED');
  }
  if (!IDENTIFIER_BINDING_EXCEPTION_CODES.includes(input.exception.code)) {
    throw personalNumberError('PERSONAL_NUMBER_EXCEPTION_NOT_ALLOWED');
  }
  const reason = input.exception.reason?.trim() || undefined;
  if (input.exception.code === 'OTHER' && !reason) throw personalNumberError('PERSONAL_NUMBER_EXCEPTION_REASON_REQUIRED');
  if (reason && reason.length > 2_000) throw personalNumberError('PERSONAL_NUMBER_EXCEPTION_REASON_INVALID');
  return {
    mode: 'BANKID_DISCOVERED',
    exception: { code: input.exception.code, ...(reason ? { reason } : {}) },
  };
}

function inferCentury(tenDigits: string, referenceDate: Date): string {
  const yearTwo = Number(tenDigits.slice(0, 2));
  const month = Number(tenDigits.slice(2, 4));
  const day = Number(tenDigits.slice(4, 6));
  const currentYear = referenceDate.getUTCFullYear();
  let year = Math.floor(currentYear / 100) * 100 + yearTwo;
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (candidate.getTime() > referenceDate.getTime()) year -= 100;
  return `${String(year).padStart(4, '0')}${tenDigits.slice(2)}`;
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function luhnValid(tenDigits: string): boolean {
  if (!/^\d{10}$/.test(tenDigits)) return false;
  let sum = 0;
  for (let index = 0; index < tenDigits.length; index += 1) {
    let value = Number(tenDigits[index]) * (index % 2 === 0 ? 2 : 1);
    if (value > 9) value -= 9;
    sum += value;
  }
  return sum % 10 === 0;
}

function personalNumberError(code: string): Error {
  const error = new Error(code);
  error.name = code;
  return error;
}
