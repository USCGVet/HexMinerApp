/** Shared token card, used by both the portfolio page and the JDAI page. */

import { CHAINS } from './config.js';
import { TOKENS_CHAIN_ID, TIER_LABELS } from './tokens.js';
import { esc, fmtUsd, fmtPrice, fmtPct } from './format.js';

const fmtTok = (v, d = 5) =>
  (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * @param t       entry from PULSE_TOKENS
 * @param tk      the loaded token state (prices, balances, supplies, tiers)
 * @param extras  optional DexScreener data for this token
 * @param opts.tiers show tier occupancy chips (only meaningful for the minting contracts)
 */
export function renderTokenCard(t, tk, extras, { tiers = false } = {}) {
  const pr = tk.prices[t.key] || {};
  const bal = tk.balances[t.key] || 0n;
  const val = pr.usd != null ? (Number(bal) / 1e18) * pr.usd : null;
  const chg = extras?.change24h;
  const liq = extras?.liquidityUsd ?? pr.liquidityUsd;

  const tierStrip =
    tiers && tk.tiers?.[t.key]
      ? `<div class="tier-strip">${tk.tiers[t.key]
          .map((x, i) =>
            x.used > 0 || i < 4
              ? `<span class="tier-chip ${x.used >= x.max ? 'full' : ''}" title="${esc(
                  TIER_LABELS[i]
                )} HEX stakes: ${x.used} of ${x.max} registered">${esc(TIER_LABELS[i])} <b>${x.used}/${x.max}</b></span>`
              : null
          )
          .filter(Boolean)
          .join('')}</div>`
      : '';

  return `<div class="card chain-card" style="--accent:${t.accent}">
    <div class="chain-head">
      <span class="chain-name">${esc(t.name)}</span>
      <span class="badge">${esc(t.symbol)}</span>
      ${t.fixedSupply ? '<span class="badge fixed" title="No mint function — the supply can never increase">fixed supply</span>' : ''}
    </div>
    <div class="chain-price">
      ${pr.usd != null ? fmtPrice(pr.usd) : '<span class="muted">no price</span>'}
      ${chg != null ? `<span class="chg ${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span>` : ''}
    </div>
    <div class="muted small">${liq != null ? `pool ${fmtUsd(liq)}` : ''}${
      extras?.volume24h != null ? ` · 24h vol ${fmtUsd(extras.volume24h)}` : ''
    }</div>
    ${t.blurb ? `<p class="token-blurb">${esc(t.blurb)}</p>` : ''}
    <dl class="kv">
      <div><dt>In existence</dt><dd class="supply">${fmtTok(tk.supplies[t.key] || 0n, 2)}</dd></div>
      <div><dt>Your balance</dt><dd>${fmtTok(bal)}</dd></div>
      <div><dt>Value</dt><dd>${val != null ? fmtUsd(val) : '—'}</dd></div>
    </dl>
    ${tierStrip}
    <div class="token-links">
      <a href="${esc(t.app)}" target="_blank" rel="noopener noreferrer">Open DApp ↗</a>
      <a href="https://dexscreener.com/pulsechain/${esc(t.dexscreenerPair)}" target="_blank" rel="noopener noreferrer">DexScreener ↗</a>
      <a href="${esc(CHAINS[TOKENS_CHAIN_ID].explorer)}/address/${esc(t.address)}" target="_blank" rel="noopener noreferrer">Contract ↗</a>
    </div>
  </div>`;
}
