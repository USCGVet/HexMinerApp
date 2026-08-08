/**
 * "View this address" links.
 *
 * An address in the URL renders that account's portfolio for this page load only. The
 * saved address list in localStorage is never touched by a link — sharing a stake should
 * not quietly replace what the recipient is tracking — so adopting the address is an
 * explicit click on the banner.
 *
 * Three spellings are accepted, because people will type all three:
 *
 *   index.html?a=0x81605…      canonical: what the app's own links produce
 *   index.html#0x81605…        what you get from pasting into the wrong place
 *   /0x81605…                  pretty. GitHub Pages has no rewrites, so 404.html turns
 *                              this into the canonical form (see the comment there)
 *
 * Several addresses can be listed at once, comma-separated, matching the multi-address
 * portfolio the settings page already supports.
 */

import { isAddress, normalize } from './config.js';
import { esc, shortAddr } from './format.js';

const PARAMS = ['a', 'address', 'addresses'];
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;

/**
 * A link naming more addresses than this is either a mistake or an attempt to make a
 * stranger's browser fan out across a lot of RPC calls. The surplus is dropped and the
 * banner says how many, rather than silently truncating.
 */
export const MAX_URL_ADDRESSES = 10;

const pick = (text) => String(text || '').split(/[,\s/]+/).filter((s) => ADDR_RE.test(s));

function parseUrl() {
  const found = [];
  const q = new URLSearchParams(location.search);
  for (const p of PARAMS) for (const v of q.getAll(p)) found.push(...pick(v));
  found.push(...pick(safeDecode(location.hash.slice(1))));
  found.push(...pick(safeDecode(location.pathname)));

  const out = [];
  for (const a of found) {
    const n = normalize(a);
    if (isAddress(n) && !out.includes(n)) out.push(n);
  }
  return out;
}

const safeDecode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // a malformed escape is not worth throwing over
  }
};

// The URL cannot change without a reload on any of these pages, so parse once.
const ALL = parseUrl();

/** Addresses named by the current URL. Empty means "show the saved portfolio". */
export const urlAddresses = () => ALL.slice(0, MAX_URL_ADDRESSES);
export const urlAddressesDropped = () => Math.max(0, ALL.length - MAX_URL_ADDRESSES);
export const isViewing = () => ALL.length > 0;

/** The same page with every address stripped out — "back to my own portfolio". */
export function cleanUrl() {
  const u = new URL(location.href);
  for (const p of PARAMS) u.searchParams.delete(p);
  if (ADDR_RE.test(u.hash.slice(1))) u.hash = '';
  const segs = u.pathname.split('/').filter((s) => !ADDR_RE.test(s));
  u.pathname = segs.join('/') || '/';
  if (!/\.[a-z]+$/i.test(u.pathname) && !u.pathname.endsWith('/')) u.pathname += '/';
  return u.pathname + u.search + u.hash;
}

/** A link to `page` that carries the addresses currently being viewed. */
export const viewUrl = (page, addresses = urlAddresses()) =>
  addresses.length ? `${page}?a=${addresses.join(',')}` : page;

/**
 * Carry the viewed address across the in-app nav, so following Charts and coming back
 * does not silently drop you into someone else's portfolio. Settings is excluded on
 * purpose: it edits the saved list, which a view link has nothing to do with.
 */
export function propagateLinks() {
  if (!ALL.length) return;
  const addrs = urlAddresses();
  for (const a of document.querySelectorAll('.topbar a[href]')) {
    const href = a.getAttribute('href');
    if (!href || /^([a-z]+:|#|\/\/)/i.test(href) || href.startsWith('settings')) continue;
    a.setAttribute('href', viewUrl(href.split(/[?#]/)[0], addrs));
  }
}

/**
 * Render the "this is not your portfolio" banner into #viewBanner.
 *
 * @param saved   the visitor's own saved address list, to decide whether "track" applies
 * @param onSave  called when they choose to adopt the viewed address(es)
 */
export function renderViewBanner(saved = [], onSave = null) {
  const el = document.getElementById('viewBanner');
  if (!el) return;

  const addrs = urlAddresses();
  if (!addrs.length) {
    el.hidden = true;
    el.innerHTML = '';
    return;
  }

  const savedSet = new Set(saved.map((a) => a.address));
  const unsaved = addrs.filter((a) => !savedSet.has(a));
  const dropped = urlAddressesDropped();

  const names = addrs
    .map((a) => `<span class="mono" title="${esc(a)}">${esc(shortAddr(a))}</span>`)
    .join(', ');

  el.hidden = false;
  el.innerHTML = `
    <div class="viewing">
      <span class="viewing-icon" aria-hidden="true">◎</span>
      <div class="viewing-text">
        Viewing ${names} from this link.
        <span class="muted">Read-only, and your own saved addresses are untouched.</span>
        ${
          dropped
            ? `<span class="bad">${dropped} further address${dropped === 1 ? '' : 'es'} in this
                 link ${dropped === 1 ? 'was' : 'were'} ignored (limit ${MAX_URL_ADDRESSES}).</span>`
            : ''
        }
      </div>
      <div class="viewing-actions">
        ${unsaved.length && onSave ? `<button class="btn btn-sm" id="viewSaveBtn" type="button">Track ${unsaved.length === 1 ? 'this address' : 'these addresses'}</button>` : ''}
        ${saved.length ? `<a class="btn btn-sm" href="${esc(cleanUrl())}">My portfolio</a>` : ''}
      </div>
    </div>`;

  document.getElementById('viewSaveBtn')?.addEventListener('click', () => onSave(unsaved));
}

// Same pattern as version.js: importing the module is enough to wire the nav.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', propagateLinks);
} else {
  propagateLinks();
}
