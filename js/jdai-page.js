/**
 * JDAI page — a light introduction plus live pricing.
 *
 * Deliberately not a vault management console: the JDAI DApp does that. This page exists so
 * HEX stakers discover JDAI and Taker, see what they trade at, and can click through.
 */

import { loadSettings } from './config.js';
import { loadTokensSnapshot, loadPairExtras } from './hexdata.js';
import { PULSE_TOKENS, jdaiTokens, jdaiTargetUsd, jdaiVaultStats } from './tokens.js';
import { renderTokenCard } from './tokencard.js';
import { esc, fmtUsd, fmtPrice, fmtPct, fmtAgo, compact } from './format.js';

const state = {
  settings: loadSettings(),
  snap: null,
  tokenExtras: {},
  error: null,
  loading: false,
  loadedAt: null,
};

const $ = (id) => document.getElementById(id);

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  state.error = null;
  renderStatus();

  const addrs = state.settings.addresses.map((a) => a.address);
  try {
    state.snap = await loadTokensSnapshot(addrs, state.settings, (m) => {
      state.progress = m;
      renderStatus();
    });
  } catch (e) {
    state.error = e.message || String(e);
  }

  Promise.all(
    jdaiTokens().map(async (t) => {
      const ex = await loadPairExtras('pulsechain', t.dexscreenerPair);
      if (ex) state.tokenExtras[t.key] = ex;
    })
  ).then(render);

  state.loading = false;
  state.progress = null;
  state.loadedAt = Date.now();
  render();
}

function renderStatus() {
  const bits = [];
  if (state.loading) bits.push(`<span class="spinner"></span> ${esc(state.progress || 'loading')}`);
  else if (state.loadedAt) bits.push(`<span class="dot ok"></span> updated ${fmtAgo(state.loadedAt)}`);
  if (state.error) bits.push(`<span class="dot bad"></span> ${esc(state.error)}`);
  $('statusBar').innerHTML = bits.join('<span class="sep">·</span>');
  $('refreshBtn')?.toggleAttribute('disabled', state.loading);
}

function render() {
  renderStatus();
  const tk = state.snap?.tokens;
  if (!tk || tk.error) {
    $('main').innerHTML = `<div class="card empty">
      <h2>JDAI</h2>
      <p>A gold-pegged unstablecoin on PulseChain. Could not reach the contracts just now
      ${tk?.error ? `— ${esc(tk.error)}` : ''}.</p>
      <div class="empty-actions">
        <a class="btn btn-primary" href="${esc(PULSE_TOKENS.JDAI.app)}" target="_blank" rel="noopener noreferrer">Open the JDAI DApp ↗</a>
      </div></div>`;
    return;
  }

  const j = tk.jdai;
  const target = jdaiTargetUsd(j.par);
  const market = tk.prices.JDAI?.usd;
  const premium = market && target ? (market / target - 1) * 100 : null;

  // Only shown when one of the tracked addresses actually has a vault.
  const vaults = j.vaults
    .map((v) => {
      const st = jdaiVaultStats(v, j, tk.plsUsd);
      return `<div class="kv" style="margin-top:0">
        <div><dt>Backing</dt><dd>${compact(st.collateralPls)} PLS</dd></div>
        <div><dt>Borrowed</dt><dd>${st.debtJdai.toFixed(4)} JDAI</dd></div>
        <div><dt>Collateralisation</dt>
          <dd class="${st.safe ? 'good' : 'bad'}">${st.ratio != null ? (st.ratio * 100).toFixed(0) + '%' : '—'}
          ${st.safe ? '' : ' · below minimum'}</dd></div>
      </div>`;
    })
    .join('');

  $('main').innerHTML = `
    <section class="hero card jdai-hero">
      <div class="hero-main">
        <div class="hero-label">JDAI · PulseChain</div>
        <div class="hero-value">${market != null ? fmtPrice(market) : '—'}</div>
        <div class="hero-sub">
          gold-pegged unstablecoin · target ${fmtUsd(target)}
          ${premium != null ? ` · ${fmtPct(premium)} vs peg` : ''}
        </div>
      </div>
      <div class="jdai-pitch">
        <p>
          JDAI is a MakerDAO-style borrowing system on PulseChain, with one difference that
          matters: it is not pegged to a dollar. One JDAI targets <b>1/1000 of an ounce of
          gold</b> — currently ${fmtUsd(target)}, implying ${fmtUsd(target * 1000)} an ounce.
        </p>
        <p>
          Lock PLS as collateral, borrow JDAI against it, and your debt is denominated in gold
          rather than in a currency that inflates. <b>Taker</b> is the governance token.
        </p>
        <div class="empty-actions" style="justify-content:flex-start;margin:16px 0 0">
          <a class="btn btn-primary" href="${esc(PULSE_TOKENS.JDAI.app)}" target="_blank" rel="noopener noreferrer">Open the JDAI DApp ↗</a>
          <a class="btn" href="https://dexscreener.com/pulsechain/${esc(PULSE_TOKENS.JDAI.dexscreenerPair)}" target="_blank" rel="noopener noreferrer">Chart ↗</a>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="section-head"><h2>Live pricing</h2></div>
      <div class="hero-breakdown">
        ${tile('Market price', market != null ? fmtPrice(market) : '—', 'PulseX JDAI/WPLS')}
        ${tile('Peg target', fmtUsd(target), '1/1000 oz gold')}
        ${tile('Premium to peg', premium != null ? fmtPct(premium) : '—',
          premium == null ? '' : premium >= 0 ? 'trading above target' : 'trading below target')}
        ${tile('Implied gold', fmtUsd(target * 1000), 'per ounce')}
      </div>
    </section>

    <section>
      <div class="section-head" style="margin-bottom:14px"><h2>Tokens</h2></div>
      <div class="chain-grid">${jdaiTokens().map((t) => renderTokenCard(t, tk, state.tokenExtras[t.key])).join('')}</div>
    </section>

    ${
      vaults
        ? `<section class="card"><div class="section-head"><h2>Your vault</h2>
             <a class="muted small" href="${esc(PULSE_TOKENS.JDAI.app)}" target="_blank" rel="noopener noreferrer">Manage in the DApp ↗</a>
           </div>${vaults}</section>`
        : ''
    }
  `;
}

const tile = (label, value, hint) => `
  <div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${esc(value)}</div>
    <div class="tile-hint">${esc(hint)}</div>
  </div>`;

document.addEventListener('DOMContentLoaded', () => {
  $('refreshBtn').addEventListener('click', refresh);
  refresh();
});
