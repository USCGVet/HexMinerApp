/**
 * Charts page. Everything is derived from the contract's dailyData:
 *   dayPayoutTotal      — HEX paid to all stakers for that day
 *   dayStakeSharesTotal — total shares that shared it
 * so payout-per-T-share is the true, contract-level yield curve.
 */

import { CHAINS, loadSettings } from './config.js';
import { loadChainSnapshot } from './hexdata.js';
import { BIG_PAY_DAY, dayToDate, heartsToHex, sharesToTShares } from './hexmath.js';
import { lineChart, attachHover } from './charts.js';
import { esc, fmtUsd, fmtDate, compact, fmtAgo } from './format.js';

const state = {
  settings: loadSettings(),
  snapshots: {},
  errors: {},
  loading: false,
  loadedAt: null,
  range: localStorage.getItem('hexminer.chartRange') || '365',
  log: localStorage.getItem('hexminer.chartLog') !== '0',
};

const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------- load

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  state.errors = {};
  renderStatus();

  const addrs = state.settings.addresses.map((a) => a.address);
  await Promise.all(
    state.settings.enabledChains.map(async (id) => {
      try {
        state.snapshots[id] = await loadChainSnapshot(id, addrs, state.settings, (m) => {
          state.progress = { ...(state.progress || {}), [id]: m };
          renderStatus();
        });
      } catch (e) {
        state.errors[id] = e.message || String(e);
      }
    })
  );

  state.loading = false;
  state.progress = null;
  state.loadedAt = Date.now();
  render();
}

function renderStatus() {
  const bits = [];
  if (state.loading) {
    const msgs = Object.entries(state.progress || {}).map(([id, m]) => `${CHAINS[id].short}: ${m}`);
    bits.push(`<span class="spinner"></span> ${esc(msgs.join(' · ') || 'loading')}`);
  } else if (state.loadedAt) {
    bits.push(`<span class="dot ok"></span> updated ${fmtAgo(state.loadedAt)}`);
  }
  for (const [id, m] of Object.entries(state.errors)) {
    bits.push(`<span class="dot bad"></span> ${CHAINS[id].name}: ${esc(m)}`);
  }
  $('statusBar').innerHTML = bits.join('<span class="sep">·</span>');
  $('refreshBtn')?.toggleAttribute('disabled', state.loading);
}

const ready = () => state.settings.enabledChains.filter((id) => state.snapshots[id]);

// ---------------------------------------------------------------- series

/** Days included given the current range selection. */
function dayWindow() {
  const ids = ready();
  if (!ids.length) return [0n, 0n];
  const maxDay = ids.reduce((m, id) => {
    const c = state.snapshots[id].globals.dailyDataCount;
    return c > m ? c : m;
  }, 0n);
  if (state.range === 'all') return [0n, maxDay];
  const span = BigInt(state.range);
  const from = maxDay > span ? maxDay - span : 0n;
  return [from, maxDay];
}

/** payout per T-share, in HEX, for each day in the window. */
function perTShareSeries(from, to) {
  return ready().map((id) => {
    const snap = state.snapshots[id];
    const points = [];
    for (let d = from; d < to; d++) {
      const x = snap.dailyData.get(d);
      if (!x || x.shares === 0n) continue;
      // hearts per share * 1e12 shares / 1e8 hearts-per-HEX
      points.push([Number(d), (Number(x.payout) / Number(x.shares)) * 1e12 / 1e8]);
    }
    return { label: CHAINS[id].name, color: CHAINS[id].accent, points };
  });
}

/** Cumulative HEX earned by one T-share held across the window. */
function cumulativeSeries(from, to) {
  return ready().map((id) => {
    const snap = state.snapshots[id];
    const points = [];
    let acc = 0;
    for (let d = from; d < to; d++) {
      const x = snap.dailyData.get(d);
      if (!x || x.shares === 0n) continue;
      acc += (Number(x.payout) / Number(x.shares)) * 1e12 / 1e8;
      points.push([Number(d), acc]);
    }
    return { label: CHAINS[id].name, color: CHAINS[id].accent, points };
  });
}

/** Total T-shares competing for the daily payout. */
function totalSharesSeries(from, to) {
  return ready().map((id) => {
    const snap = state.snapshots[id];
    const points = [];
    for (let d = from; d < to; d++) {
      const x = snap.dailyData.get(d);
      if (!x || x.shares === 0n) continue;
      points.push([Number(d), sharesToTShares(x.shares)]);
    }
    return { label: CHAINS[id].name, color: CHAINS[id].accent, points };
  });
}

/** Total HEX paid to stakers each day. */
function dailyPayoutSeries(from, to) {
  return ready().map((id) => {
    const snap = state.snapshots[id];
    const points = [];
    for (let d = from; d < to; d++) {
      const x = snap.dailyData.get(d);
      if (!x || x.shares === 0n) continue;
      points.push([Number(d), heartsToHex(x.payout)]);
    }
    return { label: CHAINS[id].name, color: CHAINS[id].accent, points };
  });
}

/** What one T-share earned over the last n closed days. */
function earnedOverLastDays(id, n) {
  const snap = state.snapshots[id];
  const end = snap.globals.dailyDataCount;
  const start = end > BigInt(n) ? end - BigInt(n) : 0n;
  let acc = 0;
  for (let d = start; d < end; d++) {
    const x = snap.dailyData.get(d);
    if (!x || x.shares === 0n) continue;
    acc += (Number(x.payout) / Number(x.shares)) * 1e12 / 1e8;
  }
  return acc;
}

// ---------------------------------------------------------------- render

function render() {
  renderStatus();
  const ids = ready();
  if (!ids.length) {
    $('main').innerHTML = `<div class="card empty"><h2>Could not load chain data</h2>
      <p>${esc(Object.values(state.errors)[0] || 'No chains enabled.')}</p>
      <div class="empty-actions"><a class="btn btn-primary" href="settings.html">Check settings</a></div></div>`;
    return;
  }

  const [from, to] = dayWindow();
  const legend = ids
    .map((id) => `<span><i style="background:${CHAINS[id].accent};color:${CHAINS[id].accent}"></i>${esc(CHAINS[id].name)} <span class="muted">${esc(CHAINS[id].hexSymbol)}</span></span>`)
    .join('');

  const fmtX = (x) => fmtDate(dayToDate(Math.round(x)));
  const marks = [{ x: Number(BIG_PAY_DAY), label: 'Big Pay Day' }];

  $('main').innerHTML = `
    <section class="card">
      <div class="section-head">
        <h2>One T-share earns</h2>
        <div class="range-row" id="rangeRow">
          ${['90', '365', '1095', 'all'].map((r) => `<button class="btn ${state.range === r ? 'on' : ''}" data-range="${r}">${r === 'all' ? 'All' : r + 'd'}</button>`).join('')}
        </div>
      </div>
      <div class="table-scroll">
      <table class="data">
        <thead><tr><th>Chain</th><th>Last 30 days</th><th>Last 90 days</th><th>Last 365 days</th><th>Yesterday</th><th>Value / T-share / yr</th></tr></thead>
        <tbody>
        ${ids
          .map((id) => {
            const y = earnedOverLastDays(id, 1);
            const y365 = earnedOverLastDays(id, 365);
            const price = state.snapshots[id].price?.hexUsd;
            return `<tr>
              <td><span class="chain-tag" style="--accent:${CHAINS[id].accent}">${esc(CHAINS[id].short)}</span> ${esc(CHAINS[id].name)}</td>
              <td>${earnedOverLastDays(id, 30).toFixed(2)} HEX</td>
              <td>${earnedOverLastDays(id, 90).toFixed(2)} HEX</td>
              <td>${y365.toFixed(2)} HEX</td>
              <td>${y.toFixed(3)} HEX</td>
              <td>${price ? fmtUsd(y365 * price) : '—'}</td>
            </tr>`;
          })
          .join('')}
        </tbody>
      </table></div>
      <p class="chart-note" style="margin-top:14px">
        A T-share is one trillion stake shares. Each day the contract mints roughly 0.00995% of
        the allocated supply plus any forfeited penalties, then splits it between every open
        stake in proportion to shares — so this is the yield curve every stake actually rides.
      </p>
    </section>

    ${chartCard('payout', 'Payout per T-share, per day', legend,
      `The daily reward one T-share receives. It drifts down as more shares are created and
       jumps whenever large penalties are forfeited into the pool.`)}

    ${chartCard('cumulative', 'Cumulative HEX per T-share', legend,
      `What a single T-share would have accrued across this window if held the whole time.`)}

    ${chartCard('shares', 'Total T-shares staked', legend,
      `Every share competing for the same daily payout. Rising share totals dilute per-share yield.`)}

    ${chartCard('daily', 'Total HEX paid to stakers, per day', legend,
      `The whole daily payout pool — inflation plus forfeited penalties.`)}
  `;

  drawChart('payout', perTShareSeries(from, to), fmtX, marks, state.log, (v) => v.toFixed(v < 1 ? 3 : 2));
  drawChart('cumulative', cumulativeSeries(from, to), fmtX, marks, false, (v) => compact(v));
  drawChart('shares', totalSharesSeries(from, to), fmtX, marks, false, (v) => compact(v));
  drawChart('daily', dailyPayoutSeries(from, to), fmtX, marks, false, (v) => compact(v));

  $('rangeRow')
    .querySelectorAll('[data-range]')
    .forEach((b) =>
      b.addEventListener('click', () => {
        state.range = b.dataset.range;
        localStorage.setItem('hexminer.chartRange', state.range);
        render();
      })
    );

  $('logToggle')?.addEventListener('click', () => {
    state.log = !state.log;
    localStorage.setItem('hexminer.chartLog', state.log ? '1' : '0');
    render();
  });
}

const chartCard = (id, title, legend, note) => `
  <section class="card chart-card">
    <div class="chart-head">
      <h3>${esc(title)}</h3>
      ${id === 'payout' ? `<button class="btn" id="logToggle" style="padding:5px 11px;font-size:12px">${state.log ? 'Log scale' : 'Linear scale'}</button>` : ''}
      <div class="legend">${legend}</div>
    </div>
    <p class="chart-note">${esc(note)}</p>
    <div id="chart-${id}"></div>
  </section>`;

function drawChart(id, series, fmtX, marks, log, fmtY) {
  const host = $(`chart-${id}`);
  if (!host) return;
  host.innerHTML = lineChart({ series, log, fmtX, fmtY, marks, height: 250 });
  attachHover(host, ({ x, values }) => {
    const day = Math.round(x);
    return (
      `<span>day <b>${day}</b> · ${esc(fmtDate(dayToDate(day)))}</span>` +
      values
        .filter((v) => v.value != null)
        .map((v) => `<span style="color:${esc(v.color)}">${esc(v.label)}: <b>${esc(fmtY(v.value))}</b></span>`)
        .join('')
    );
  });
}

document.addEventListener('DOMContentLoaded', () => {
  $('refreshBtn').addEventListener('click', refresh);
  refresh();
});
