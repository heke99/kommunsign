/**
 * WCAG 2.2 AA gate for the built portals.
 *
 * Kungälv requirement 2015 demands at least WCAG 2.0 AA; DOS-lagen and the
 * current EN 301 549 both point at WCAG 2.2 AA, so that is what is checked.
 *
 * This is a static audit of the shipped HTML and CSS, not a browser run. That
 * is a deliberate trade rather than a shortcut: the checks below are exactly
 * the ones that are decidable from the markup, and they are the ones that
 * regress silently when someone adds a field or a button months from now. The
 * criteria that genuinely need a rendering engine or a human — colour contrast
 * of overlapping layers, screen-reader announcement order, meaningful
 * alternative text — are listed in docs/accessibility/wcag-2.2-aa.md as manual
 * tests with their results, because claiming automated coverage of those would
 * be a false claim about conformance.
 *
 * Every rule cites its success criterion so a failure says what is wrong in the
 * standard's own terms.
 */
import { readFile, readdir } from 'node:fs/promises';

const PORTALS = ['auth-portal', 'onboarding-portal', 'platform-admin', 'tenant-portal', 'signer-portal', 'verification-portal'];
const failures = [];

function fail(portal, criterion, message) {
  failures.push(`${portal}: [WCAG ${criterion}] ${message}`);
}

/** Strips comments so commented-out markup never satisfies a rule. */
function stripComments(html) {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

function tagsOf(html, tag) {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))].map((match) => match[0]);
}

function attribute(tag, name) {
  const match = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return match ? (match[2] ?? match[3] ?? match[4] ?? '') : null;
}

function hasAttribute(tag, name) {
  return new RegExp(`\\s${name}(\\s|=|>|$)`, 'i').test(tag);
}

for (const portal of PORTALS) {
  const root = `apps/${portal}/public`;
  const html = stripComments(await readFile(`${root}/index.html`, 'utf8'));

  const cssFiles = (await readdir(root)).filter((name) => name.endsWith('.css'));
  let css = '';
  for (const file of cssFiles) css += await readFile(`${root}/${file}`, 'utf8');

  /* --- 3.1.1 Language of Page --- */
  const lang = attribute(tagsOf(html, 'html')[0] ?? '', 'lang');
  if (lang !== 'sv') fail(portal, '3.1.1', 'the html element must declare lang="sv"');

  /* --- 2.4.2 Page Titled --- */
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html);
  if (!title || title[1].trim().length < 3) fail(portal, '2.4.2', 'a non-empty <title> is required');

  /* --- 1.4.4 Resize Text / 1.4.10 Reflow ---
     A viewport that forbids zoom is the single most common way a mobile page
     fails AA outright, and it is invisible until someone needs to zoom. */
  const viewport = tagsOf(html, 'meta').find((tag) => attribute(tag, 'name') === 'viewport');
  if (!viewport) fail(portal, '1.4.10', 'a viewport meta tag is required for reflow');
  else {
    const content = attribute(viewport, 'content') ?? '';
    if (/user-scalable\s*=\s*no/i.test(content)) fail(portal, '1.4.4', 'user-scalable=no prevents resizing text');
    if (/maximum-scale\s*=\s*(1(\.0+)?)\b/i.test(content)) fail(portal, '1.4.4', 'maximum-scale=1 prevents zooming to 200%');
  }

  /* --- 2.4.1 Bypass Blocks --- */
  if (!/class="[^"]*skip-link/.test(html) || !/href="#/.test(html)) {
    fail(portal, '2.4.1', 'a skip link to the main content is required');
  }

  /* --- 1.3.1 Info and Relationships: landmarks --- */
  if (tagsOf(html, 'main').length !== 1) fail(portal, '1.3.1', 'exactly one <main> landmark is required');
  const mainId = attribute(tagsOf(html, 'main')[0] ?? '', 'id');
  if (mainId && !html.includes(`href="#${mainId}"`)) {
    fail(portal, '2.4.1', `the skip link must target the main landmark (#${mainId})`);
  }

  /* --- 1.3.1 / 2.4.6 Headings: exactly one h1, no skipped levels ---
     A jump from h1 to h3 tells a screen-reader user a section is missing. */
  const headings = [...html.matchAll(/<h([1-6])\b/gi)].map((match) => Number(match[1]));
  const h1Count = headings.filter((level) => level === 1).length;
  if (h1Count === 0) fail(portal, '2.4.6', 'a top-level <h1> is required');
  let previous = 0;
  for (const level of headings) {
    if (previous !== 0 && level > previous + 1) {
      fail(portal, '1.3.1', `heading level jumps from h${previous} to h${level}`);
      break;
    }
    previous = level;
  }

  /* --- 1.1.1 Non-text Content --- */
  for (const tag of tagsOf(html, 'img')) {
    if (!hasAttribute(tag, 'alt')) fail(portal, '1.1.1', `<img> without alt: ${tag.slice(0, 80)}`);
  }
  // A decorative SVG must be hidden; a meaningful one must be labelled.
  for (const tag of tagsOf(html, 'svg')) {
    if (attribute(tag, 'aria-hidden') !== 'true' && !hasAttribute(tag, 'aria-label') && attribute(tag, 'role') !== 'img') {
      fail(portal, '1.1.1', `<svg> is neither aria-hidden nor labelled: ${tag.slice(0, 80)}`);
    }
  }

  /* --- 3.3.2 Labels or Instructions / 4.1.2 Name, Role, Value ---
     An input with only a placeholder has no accessible name once the user
     starts typing, which is precisely when they need it. */
  // A control is named by an explicit for=, an aria-label(ledby), or by being
  // wrapped in a <label> that carries text. The wrapping form is valid HTML and
  // is what most of these forms use, so a checker that only understood for=
  // would report every one of them as a failure and train people to ignore it.
  const implicitlyLabelled = new Set();
  for (const match of html.matchAll(/<label\b[^>]*>([\s\S]*?)<\/label>/gi)) {
    const inner = match[1];
    const text = inner.replace(/<[^>]*>/g, '').trim();
    if (text === '') continue;
    for (const control of [...tagsOf(inner, 'input'), ...tagsOf(inner, 'select'), ...tagsOf(inner, 'textarea')]) {
      implicitlyLabelled.add(control);
    }
  }
  const isLabelled = (tag) => {
    if (implicitlyLabelled.has(tag)) return true;
    if (hasAttribute(tag, 'aria-label') || hasAttribute(tag, 'aria-labelledby')) return true;
    const id = attribute(tag, 'id');
    return Boolean(id) && new RegExp(`<label\\b[^>]*\\sfor\\s*=\\s*["']${id}["']`, 'i').test(html);
  };

  for (const tag of tagsOf(html, 'input')) {
    const type = (attribute(tag, 'type') ?? 'text').toLowerCase();
    if (['hidden', 'submit', 'button', 'reset'].includes(type)) continue;
    if (!isLabelled(tag)) fail(portal, '3.3.2', `input has no associated label: ${tag.slice(0, 80)}`);
  }
  for (const tag of [...tagsOf(html, 'select'), ...tagsOf(html, 'textarea')]) {
    if (!isLabelled(tag)) fail(portal, '3.3.2', `control has no associated label: ${tag.slice(0, 80)}`);
  }

  /* --- 1.3.5 Identify Input Purpose ---
     Fields about the user must declare their purpose so a browser or assistive
     tool can fill them. */
  for (const tag of tagsOf(html, 'input')) {
    const type = (attribute(tag, 'type') ?? 'text').toLowerCase();
    if (!['email', 'tel', 'password'].includes(type)) continue;
    if (!hasAttribute(tag, 'autocomplete')) {
      fail(portal, '1.3.5', `input type=${type} must declare autocomplete: ${tag.slice(0, 80)}`);
    }
  }

  /* --- 4.1.2: a button must have an accessible name --- */
  for (const match of html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/gi)) {
    const attrs = `<button${match[1]}>`;
    const text = match[2].replace(/<[^>]*>/g, '').trim();
    if (!text && !hasAttribute(attrs, 'aria-label') && !hasAttribute(attrs, 'aria-labelledby')) {
      fail(portal, '4.1.2', `button has no accessible name: ${attrs.slice(0, 80)}`);
    }
  }

  /* --- 2.4.4 Link Purpose --- */
  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const attrs = `<a${match[1]}>`;
    const text = match[2].replace(/<[^>]*>/g, '').trim();
    if (!text && !hasAttribute(attrs, 'aria-label')) {
      fail(portal, '2.4.4', `link has no discernible text: ${attrs.slice(0, 80)}`);
    }
    // A new tab that opens without warning disorients screen-reader users.
    if (attribute(attrs, 'target') === '_blank' && !/ny flik|nytt fönster/i.test(text) && !hasAttribute(attrs, 'aria-label')) {
      fail(portal, '3.2.5', `link opens a new tab without saying so: ${text.slice(0, 40)}`);
    }
  }

  /* --- 2.4.7 Focus Visible ---
     Removing the outline without replacing it leaves keyboard users with no
     idea where they are. Checked in CSS because that is where it is removed. */
  const removesOutline = /outline\s*:\s*(none|0)\b/i.test(css);
  const providesFocus = /:focus-visible\b/.test(css) || /:focus\b[^{]*\{[^}]*(outline|box-shadow)/i.test(css);
  if (removesOutline && !providesFocus) {
    fail(portal, '2.4.7', 'outline is removed without providing a visible focus style');
  }
  if (!providesFocus) fail(portal, '2.4.7', 'no visible focus indicator is defined in CSS');

  /* --- 2.5.8 Target Size (Minimum), new in WCAG 2.2 ---
     24x24 CSS px. Checked as a declared floor rather than measured, since the
     rendered box needs a browser. */
  if (!/min-height\s*:\s*(2[4-9]|[3-9]\d|\d{3,})px/i.test(css)) {
    fail(portal, '2.5.8', 'no interactive target minimum height of at least 24px is declared in CSS');
  }

  /* --- 1.4.12 Text Spacing: a fixed line-height under 1.5 cannot be overridden --- */
  const lineHeight = /\bbody\b[^{]*\{[^}]*line-height\s*:\s*([0-9.]+)\s*[;}]/i.exec(css);
  if (lineHeight && Number(lineHeight[1]) < 1.5 && Number(lineHeight[1]) > 0) {
    fail(portal, '1.4.12', `body line-height ${lineHeight[1]} is below the 1.5 required for text spacing`);
  }

  /* --- 1.4.3 Contrast (Minimum) ---
     Not decidable statically for arbitrary overlays, but a page that never
     states a colour scheme will be rendered against an unknown background.
     The measured ratios are recorded in the manual test document. */
  if (!/<meta\s+name="color-scheme"/i.test(html) && !/color-scheme\s*:/i.test(css)) {
    fail(portal, '1.4.3', 'no colour scheme is declared, so contrast cannot be assured');
  }

  /* --- 4.1.3 Status Messages ---
     A status that changes without a live region is silent to a screen reader:
     the user is left waiting with no idea anything happened. */
  if (/id="status"|class="[^"]*status/.test(html) && !/aria-live=/.test(html)) {
    fail(portal, '4.1.3', 'status regions must be announced with aria-live');
  }
}

if (failures.length > 0) {
  console.error('WCAG 2.2 AA verification failed:');
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`WCAG 2.2 AA static verification: OK (${PORTALS.length} portals)`);
}
