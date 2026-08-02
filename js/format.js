/** Display formatting helpers. Nothing here touches the chain. */

import { heartsToHex, sharesToTShares } from './hexmath.js';

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** HEX amount from hearts, with thousands separators. */
export function fmtHex(hearts, decimals = 2) {
  const n = heartsToHex(hearts);
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Compact HEX for tight spaces: 1.23M, 45.6k. */
export function fmtHexCompact(hearts) {
  return compact(heartsToHex(hearts));
}

export function compact(n) {
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(2) + 'T';
  if (a >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(2) + 'k';
  return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** USD with a sensible number of decimals for the magnitude. */
export function fmtUsd(v) {
  if (v == null || !isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e6) return '$' + compact(v);
  if (a >= 1) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (a === 0) return '$0.00';
  return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
}

/** Token prices go well below a cent, so keep significant digits instead of fixed ones. */
export function fmtPrice(v) {
  if (v == null || !isFinite(v)) return '—';
  if (v >= 1) return '$' + v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  const digits = Math.max(4, Math.min(10, 2 - Math.floor(Math.log10(v))));
  return '$' + v.toFixed(digits);
}

export function fmtTShares(shares, decimals = 3) {
  return sharesToTShares(shares).toLocaleString('en-US', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtPct(v, decimals = 2) {
  if (v == null || !isFinite(v)) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}

export const fmtDate = (d) =>
  d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });

export function fmtDays(d) {
  const n = Number(d);
  if (n === 1) return '1 day';
  return `${n.toLocaleString('en-US')} days`;
}

/** "3,281 days (~9.0 years)" for long terms. */
export function fmtTerm(days) {
  const n = Number(days);
  if (n < 400) return fmtDays(n);
  return `${fmtDays(n)} (~${(n / 365).toFixed(1)} yr)`;
}

export const shortAddr = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export function fmtAgo(ts) {
  if (!ts) return 'never';
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? '1 day ago' : `${d} days ago`;
}

/**
 * A price impact. In a pool holding tens of dollars this runs into the tens of thousands
 * of percent, where a percentage stops meaning anything — past 10x, say it as a multiple.
 */
export function fmtImpact(frac) {
  if (frac == null || !isFinite(frac)) return '—';
  if (frac >= 9) return (1 + frac).toLocaleString('en-US', { maximumFractionDigits: 0 }) + '×';
  const pct = frac * 100;
  return pct.toFixed(pct >= 10 ? 0 : 1) + '%';
}
