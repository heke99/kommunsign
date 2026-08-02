export interface TenantBrandingInput {
  readonly productName: string;
  readonly primaryColor: string;
  readonly accentColor: string;
  readonly logoUrl?: string;
  readonly faviconUrl?: string;
  readonly supportEmail?: string;
  readonly footerText?: string;
}

export interface TenantBranding extends TenantBrandingInput {
  readonly primaryTextColor: '#000000' | '#ffffff';
  readonly accentTextColor: '#000000' | '#ffffff';
}

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validateAndNormalizeBranding(input: TenantBrandingInput): TenantBranding {
  const productName = cleanText(input.productName, 'productName', 2, 80);
  const primaryColor = normalizeColor(input.primaryColor, 'primaryColor');
  const accentColor = normalizeColor(input.accentColor, 'accentColor');
  const logoUrl = input.logoUrl ? sanitizeAssetUrl(input.logoUrl) : undefined;
  const faviconUrl = input.faviconUrl ? sanitizeAssetUrl(input.faviconUrl) : undefined;
  const supportEmail = input.supportEmail ? input.supportEmail.trim().toLowerCase() : undefined;
  if (supportEmail && !EMAIL.test(supportEmail)) throw new Error('BRANDING_SUPPORT_EMAIL_INVALID');
  const footerText = input.footerText ? cleanText(input.footerText, 'footerText', 1, 300) : undefined;
  return {
    productName,
    primaryColor,
    accentColor,
    primaryTextColor: readableTextColor(primaryColor),
    accentTextColor: readableTextColor(accentColor),
    ...(logoUrl ? { logoUrl } : {}),
    ...(faviconUrl ? { faviconUrl } : {}),
    ...(supportEmail ? { supportEmail } : {}),
    ...(footerText ? { footerText } : {}),
  };
}

export function contrastRatio(first: string, second: string): number {
  const left = relativeLuminance(normalizeColor(first, 'first'));
  const right = relativeLuminance(normalizeColor(second, 'second'));
  const light = Math.max(left, right);
  const dark = Math.min(left, right);
  return (light + 0.05) / (dark + 0.05);
}

export function readableTextColor(background: string): '#000000' | '#ffffff' {
  return contrastRatio(background, '#000000') >= contrastRatio(background, '#ffffff') ? '#000000' : '#ffffff';
}

function cleanText(value: string, field: string, minimum: number, maximum: number): string {
  const normalized = value.trim().replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ');
  if (normalized.length < minimum || normalized.length > maximum) throw new Error(`BRANDING_${field.toUpperCase()}_INVALID`);
  if (/[<>]/.test(normalized)) throw new Error(`BRANDING_${field.toUpperCase()}_HTML_FORBIDDEN`);
  return normalized;
}

function normalizeColor(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!HEX_COLOR.test(normalized)) throw new Error(`BRANDING_${field.toUpperCase()}_INVALID`);
  return normalized;
}

function sanitizeAssetUrl(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== 'https:') throw new Error('BRANDING_ASSET_URL_MUST_USE_HTTPS');
  if (parsed.username || parsed.password) throw new Error('BRANDING_ASSET_URL_CREDENTIALS_FORBIDDEN');
  if (parsed.href.length > 2048) throw new Error('BRANDING_ASSET_URL_TOO_LONG');
  return parsed.toString();
}

function relativeLuminance(color: string): number {
  const channels = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255)
    .map((channel) => channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}
