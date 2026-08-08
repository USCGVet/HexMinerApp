/** Dashboard: loads every enabled chain in parallel and renders the portfolio. */

import { CHAINS, loadSettings, saveSettings, isAddress, normalize } from './config.js';
import { loadChainSnapshot, loadMarketExtras, loadPairExtras } from './hexdata.js';
import { heartsToHex, sharesToTShares, BIG_PAY_DAY } from './hexmath.js';
import { PULSE_TOKENS, TOKENS_CHAIN_ID, stakeTokens } from './tokens.js';
import { SIDE_TOKENS } from './sidestakes.js';
import { renderTokenCard } from './tokencard.js';
import { urlAddresses, isViewing, renderViewBanner, cleanUrl } from './urlview.js';
import {
  esc, fmtHex, fmtHexCompact, fmtUsd, fmtPrice, fmtTShares, fmtPct,
  fmtDate, fmtDays, fmtTerm, shortAddr, fmtAgo, compact,
} from './format.js';

/** Secondary tokens are 18-decimal; show enough digits for these small amounts. */
const fmtTok = (v, d = 5) =>
  (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

/**
 * Hedron and Communis run to millions and billions of units respectively, so they get
 * compact notation rather than the five decimal places HXR and Savant need.
 */
const fmtSide = (raw, key) => compact(Number(raw) / 10 ** SIDE_TOKENS[key].decimals);

const state = {
  settings: loadSettings(),
  // Addresses named by the URL, if any. Kept separate from settings.addresses so that
  // anything writing settings back to localStorage cannot pick up a link's addresses.
  view: urlAddresses(),
  snapshots: {},   // chainId -> snapshot
  extras: {},      // chainId -> dexscreener (HEX)
  tokenExtras: {}, // token key -> dexscreener (HXR / SAVANT / JDAI / TKR)
  errors: {},      // chainId -> message
  loading: false,
  loadedAt: null,
  sort: localStorage.getItem('hexminer.sort') || 'value',
  chainFilter: 'all',
  statusFilter: 'all',
};

const $ = (id) => document.getElementById(id);
let refreshTimer = null;

// ---------------------------------------------------------------- loading

/** A link's addresses win over the saved list for as long as the link is being followed. */
const activeAddresses = () =>
  state.view.length ? state.view : state.settings.addresses.map((a) => a.address);

async function refresh() {
  if (state.loading) return;
  const addrs = activeAddresses();
  if (!addrs.length) {
    renderEmpty();
    return;
  }

  state.loading = true;
  state.errors = {};
  renderStatus();

  const chains = state.settings.enabledChains;
  try {
    await Promise.all(
      chains.map(async (id) => {
        try {
          state.snapshots[id] = await loadChainSnapshot(id, addrs, state.settings, (msg) => {
            state.progress = { ...(state.progress || {}), [id]: msg };
            renderStatus();
          });
          delete state.errors[id];
        } catch (e) {
          state.errors[id] = e.message || String(e);
          delete state.snapshots[id];
        }
        render();
      })
    );

    // Non-blocking market enrichment: HEX per chain, plus the PulseChain secondary tokens.
    Promise.all([
      ...chains.map(async (id) => {
        const ex = await loadMarketExtras(CHAINS[id]);
        if (ex) state.extras[id] = ex;
      }),
      ...(chains.includes(TOKENS_CHAIN_ID)
        ? Object.values(PULSE_TOKENS).map(async (t) => {
            const ex = await loadPairExtras('pulsechain', t.dexscreenerPair);
            if (ex) state.tokenExtras[t.key] = ex;
          })
        : []),
    ]).then(render);
  } finally {
    // A throw anywhere above — including inside render() — must not leave the app stuck
    // showing a spinner with no way back. The error still surfaces; the load ends either way.
    state.loading = false;
    state.progress = null;
    state.loadedAt = Date.now();
  }
  render();
  scheduleAutoRefresh();
}

function scheduleAutoRefresh() {
  if (refreshTimer) clearTimeout(refreshTimer);
  const s = Number(state.settings.refreshSeconds || 0);
  if (s > 0) refreshTimer = setTimeout(refresh, s * 1000);
}

// ---------------------------------------------------------------- aggregation

function activeChains() {
  return state.settings.enabledChains.filter((id) => state.snapshots[id]);
}

function combinedTotals() {
  let usd = 0;
  let hex = 0n;
  let liquid = 0n;
  let principal = 0n;
  let interest = 0n;
  let bigPayDay = 0n;
  let shares = 0n;
  let penalty = 0n;
  let stakeCount = 0;
  let priced = true;

  for (const id of activeChains()) {
    const t = state.snapshots[id].totals;
    hex += t.totalHex;
    liquid += t.liquid;
    principal += t.principal;
    interest += t.interest;
    bigPayDay += t.bigPayDay;
    shares += t.shares;
    penalty += t.penaltyIfEndedNow;
    stakeCount += t.stakeCount;
    if (t.totalUsd == null) priced = false;
    else usd += t.totalUsd;
  }
  return { usd: priced ? usd : null, hex, liquid, principal, interest, bigPayDay, shares, penalty, stakeCount };
}

function allStakes() {
  const out = [];
  for (const id of activeChains()) {
    for (const s of state.snapshots[id].stakes) out.push({ ...s, chainId: id });
  }
  const filtered = out.filter(
    (s) =>
      (state.chainFilter === 'all' || String(s.chainId) === state.chainFilter) &&
      (state.statusFilter === 'all' || s.status === state.statusFilter)
  );
  const price = (id) => state.snapshots[id]?.price?.hexUsd ?? 0;
  const cmp = {
    value: (a, b) => heartsToHex(b.grossValue) * price(b.chainId) - heartsToHex(a.grossValue) * price(a.chainId),
    principal: (a, b) => Number(b.principal - a.principal),
    interest: (a, b) => Number(b.interest - a.interest),
    shares: (a, b) => Number(b.shares - a.shares),
    ending: (a, b) => Number(a.endDay - b.endDay),
    started: (a, b) => Number(b.lockedDay - a.lockedDay),
    apy: (a, b) => (b.apy ?? -1) - (a.apy ?? -1),
  }[state.sort];
  return filtered.sort(cmp || cmp_value);
}
const cmp_value = () => 0;

// ---------------------------------------------------------------- render

function render() {
  renderViewBanner(state.settings.addresses, trackViewed);
  if (!activeAddresses().length) return renderEmpty();
  renderStatus();
  renderHero();
  renderNotices();
  renderChains();
  renderStakes();
  renderTokens();
  renderSideTokens();
  renderProtocol();
}

/** PulseChain token/mint state, or null if PulseChain is not loaded. */
function pulse() {
  const snap = state.snapshots[TOKENS_CHAIN_ID];
  if (!snap || !snap.tokens || snap.tokens.error) return null;
  return { snap, tk: snap.tokens };
}

/** Mint state for one stake, if it is a PulseChain stake. */
function mintFor(stake) {
  const p = pulse();
  if (!p || stake.chainId !== TOKENS_CHAIN_ID) return null;
  return p.tk.mintByStake.get(`${stake.owner}:${stake.index}`) || null;
}

/** Served its term, so stakeEnd() could be called on it today — mints included. */
const isFinished = (s) => s.status === 'matured' || s.status === 'late' || s.status === 'unlocked';

/** Everything still mintable, and how much of it is on stakes that could be ended today. */
function mintSummary() {
  const p = pulse();
  if (!p) return null;
  let hxr = 0n;
  let sav = 0n;
  let urgentHxr = 0n;
  let urgentSav = 0n;
  let collisionLost = 0n;
  let collisionCount = 0;
  const urgentStakes = new Set();
  let stakeCount = 0;

  for (const s of p.snap.stakes) {
    const m = p.tk.mintByStake.get(`${s.owner}:${s.index}`);
    if (!m) continue;
    if (m.HXR.collision) {
      collisionCount++;
      collisionLost += m.HXR.lostToCollision;
    }
    const risky = m.HXR.atRisk || m.SAVANT.atRisk;
    if (risky) stakeCount++;
    if (m.HXR.atRisk) hxr += m.HXR.rewardNow;
    if (m.SAVANT.atRisk) sav += m.SAVANT.rewardNow;
    // A finished stake is one transaction away from being gone, taking the mint with it.
    if (risky && isFinished(s)) {
      urgentStakes.add(s.index);
      if (m.HXR.atRisk) urgentHxr += m.HXR.rewardNow;
      if (m.SAVANT.atRisk) urgentSav += m.SAVANT.rewardNow;
    }
  }
  const px = (k) => p.tk.prices[k]?.usd || 0;
  return {
    hxr, sav, stakeCount,
    urgentHxr, urgentSav, urgentCount: urgentStakes.size,
    collisionLost, collisionCount,
    usd: (Number(hxr) / 1e18) * px('HXR') + (Number(sav) / 1e18) * px('SAVANT'),
  };
}

/**
 * Build the notice list. Nothing here is rendered inline — it all lives behind the bell in
 * the header so the dashboard itself stays clean.
 *
 * Severity drives the bell's colour, so an urgent notice is still visible at a glance
 * without a banner taking up the top of the page.
 */
function buildNotices() {
  const stakes = activeChains().flatMap((id) => state.snapshots[id].stakes.map((s) => ({ ...s, chainId: id })));
  const ready = stakes.filter((s) => s.status === 'matured');
  const late = stakes.filter((s) => s.status === 'late');
  const settled = stakes.filter((s) => s.goodAccounted);
  const ms = mintSummary();
  const out = [];

  if (late.length) {
    const lost = late.reduce((a, s) => a + s.penalty, 0n);
    out.push({
      severity: 'warn',
      icon: '⚠',
      title: `${late.length} stake${late.length === 1 ? ' is' : 's are'} past the grace period`,
      body: `${fmtHex(lost)} HEX already forfeited to late-end penalties, growing every day.
             Calling HEX <code class="mono">stakeGoodAccounting()</code> freezes the penalty where it is.`,
    });
  }

  if (ready.length) {
    const graceLeft = ready.reduce((min, s) => Math.min(min, Number(s.graceDaysLeft)), Infinity);
    out.push({
      severity: 'good',
      icon: '✦',
      title: `${ready.length} stake${ready.length === 1 ? '' : 's'} finished the full term`,
      body: `Penalty-free to end${isFinite(graceLeft) && graceLeft > 0 ? ` for another ${fmtDays(graceLeft)}` : ''}.`,
    });
  }

  if (settled.length) {
    const frozenPenalty = settled.reduce((a, s) => a + s.penalty, 0n);
    out.push({
      severity: 'good',
      icon: '❄',
      title: `${settled.length} stake${settled.length === 1 ? ' has' : 's have'} already run good accounting`,
      body: `Unlocked and out of the share pool, so the payout${
        frozenPenalty > 0n ? ` and the ${fmtHex(frozenPenalty)} HEX late penalty are` : ' is'
      } frozen — ending ${settled.length === 1 ? 'it' : 'them'} can wait with nothing more to lose.
             ${settled.length === 1 ? 'It also qualifies' : 'They also qualify'} for the HexRewards full-term bonus.`,
    });
  }

  // stakeEnd() removes a stake from stakeLists, and HexRewards/Savant mint by reading that
  // list — so ending first loses the mint permanently. This is the one irreversible mistake.
  if (ms && ms.urgentCount > 0) {
    out.push({
      severity: 'warn',
      icon: '⛏',
      title: `Mint before you end ${ms.urgentCount === 1 ? 'that stake' : 'those stakes'}`,
      body: `${ms.urgentCount} finished stake${ms.urgentCount === 1 ? '' : 's'} still
             ${ms.urgentCount === 1 ? 'has' : 'have'} <b>${fmtTok(ms.urgentHxr)} HXR</b> and
             <b>${fmtTok(ms.urgentSav)} SAVANT</b> unminted.
             <code class="mono">stakeEnd()</code> removes a stake from the HEX stake list, and both
             contracts mint by reading that list — once ended, these are unrecoverable.`,
      links: [
        { label: 'HexRewards', href: PULSE_TOKENS.HXR.app },
        { label: 'Savant', href: PULSE_TOKENS.SAVANT.app },
      ],
    });
  } else if (ms && ms.stakeCount > 0) {
    out.push({
      severity: 'info',
      icon: '⛏',
      title: `${fmtTok(ms.hxr)} HXR and ${fmtTok(ms.sav)} SAVANT mintable`,
      body: `Across ${ms.stakeCount} PulseChain stake${ms.stakeCount === 1 ? '' : 's'}. Amounts grow
             every day a stake runs, and jump on the final day — but mint before ending any stake.`,
      links: [
        { label: 'HexRewards', href: PULSE_TOKENS.HXR.app },
        { label: 'Savant', href: PULSE_TOKENS.SAVANT.app },
      ],
    });
  }

  // Communis end bonuses live for 37 days after a stake matures and then cannot ever be
  // minted. That is the only hard deadline anywhere in this app, so it leads.
  const expiring = [];
  let hdrnTotal = 0n;
  let hdrnUsd = 0;
  const exposed = [];
  for (const id of activeChains()) {
    const side = state.snapshots[id].side;
    if (!side || side.error) continue;
    hdrnTotal += side.totals.hdrnMintable;
    hdrnUsd += side.totals.hdrnMintableUsd || 0;
    for (const [key, e] of side.byStake) {
      if (!e.communis) continue;
      if (e.communis.end.status === 'ready') {
        expiring.push({ chainId: id, key, amount: e.communis.end.amount, daysLeft: e.communis.end.daysLeft });
      }
      if (e.communis.good.status === 'claimable-by-anyone') {
        exposed.push({ chainId: id, key, amount: e.communis.good.amount });
      }
    }
  }

  if (expiring.length) {
    const soonest = expiring.reduce((m, x) => (x.daysLeft < m ? x.daysLeft : m), 9999n);
    const total = expiring.reduce((a, x) => a + x.amount, 0n);
    out.push({
      severity: 'warn',
      icon: '⏳',
      title: `${expiring.length} Communis end bonus${expiring.length === 1 ? '' : 'es'} expiring`,
      body: `<b>${fmtSide(total, 'COM')} COM</b> can still be minted, but Communis allows only 37 days
             after a stake matures — the soonest closes in <b>${fmtDays(soonest)}</b>. After that the
             end bonus for that stake can never be minted by anyone.`,
      links: [{ label: 'Communis', href: SIDE_TOKENS.COM.app }],
    });
  }

  if (exposed.length) {
    const total = exposed.reduce((a, x) => a + x.amount, 0n);
    out.push({
      severity: 'warn',
      icon: '⚠',
      title: `${exposed.length} stake${exposed.length === 1 ? '' : 's'} a stranger can unlock`,
      body: `Past the 37-day window, Communis pays 1% of a stake's max payout —
             <b>${fmtSide(total, 'COM')} COM</b> here — to <em>anyone</em> who calls
             <code class="mono">mintGoodAccountingBonus()</code> on it. Doing so runs HEX
             <code class="mono">stakeGoodAccounting()</code> on your stake as a side effect, which
             freezes its late penalty. Claiming it yourself keeps both the bonus and the timing.`,
      links: [{ label: 'Communis', href: SIDE_TOKENS.COM.app }],
    });
  }

  if (hdrnTotal > 0n) {
    out.push({
      severity: 'info',
      icon: '◈',
      title: `${fmtSide(hdrnTotal, 'HDRN')} HDRN mintable`,
      body: `Hedron pays per day served and keeps accruing, so nothing is lost by waiting —
             but it is only reachable while the stake exists${hdrnUsd ? `. Worth about ${fmtUsd(hdrnUsd)} at the current pool quote` : ''}.`,
      links: [{ label: 'Hedron', href: SIDE_TOKENS.HDRN.app }],
    });
  }

  // The HexRewards index-keying bug, but only when it is provably costing this wallet.
  if (ms && ms.collisionCount > 0) {
    out.push({
      severity: 'warn',
      icon: '⚠',
      title: `${ms.collisionCount} stake${ms.collisionCount === 1 ? '' : 's'} cannot mint HexRewards`,
      body: `HXR records claims against the stake <em>index</em>, and HEX reuses indexes when a stake
             is ended, so ${ms.collisionCount === 1 ? 'this slot was' : 'these slots were'} already
             consumed by a since-ended stake (${fmtTok(ms.collisionLost)} HXR unreachable).
             Savant keys by stake <em>ID</em> instead and is unaffected — those stakes can still mint.`,
    });
  }

  return out;
}

const SEVERITY_RANK = { warn: 3, good: 2, info: 1 };

function renderNotices() {
  const btn = $('bellBtn');
  const panel = $('noticePanel');
  const count = $('bellCount');
  if (!btn || !panel) return;

  const notices = activeChains().length ? buildNotices() : [];
  state.notices = notices;

  const worst = notices.reduce(
    (acc, n) => (SEVERITY_RANK[n.severity] > SEVERITY_RANK[acc] ? n.severity : acc),
    'info'
  );

  btn.classList.toggle('has-notices', notices.length > 0);
  btn.dataset.severity = notices.length ? worst : '';
  btn.setAttribute('aria-label', notices.length ? `${notices.length} notices` : 'No notices');
  count.hidden = notices.length === 0;
  count.textContent = String(notices.length);

  panel.innerHTML = notices.length
    ? `<div class="notice-head">Notices</div>` +
      notices
        .map(
          (n) => `<div class="notice ${n.severity}">
            <span class="notice-icon">${n.icon}</span>
            <div>
              <div class="notice-title">${n.title}</div>
              <div class="notice-body">${n.body}</div>
              ${
                n.links
                  ? `<div class="notice-links">${n.links
                      .map(
                        (l) =>
                          `<a href="${esc(l.href)}" target="_blank" rel="noopener noreferrer">${esc(l.label)} ↗</a>`
                      )
                      .join('')}</div>`
                  : ''
              }
            </div>
          </div>`
        )
        .join('')
    : `<div class="notice-head">Notices</div><div class="notice-empty">Nothing needs your attention.</div>`;
}

function toggleNotices(open) {
  const btn = $('bellBtn');
  const panel = $('noticePanel');
  if (!btn || !panel) return;
  const next = open ?? panel.hidden;
  panel.hidden = !next;
  btn.setAttribute('aria-expanded', String(next));
  if (next) positionNotices();
}

/**
 * On narrow screens the panel is viewport-anchored (see the media query), and the wrapped
 * header's height is not knowable from CSS — so publish it as a custom property.
 */
function positionNotices() {
  const bar = document.querySelector('.topbar');
  if (!bar) return;
  document.documentElement.style.setProperty('--notice-top', `${Math.round(bar.getBoundingClientRect().bottom + 8)}px`);
}

function renderEmpty() {
  $('main').innerHTML = `
    <div class="empty card">
      <h2>No addresses yet</h2>
      <p>Add a HEX address to see your liquid balance, every stake, exactly what each one
         has earned, and what you would receive if you ended it today — on Ethereum and
         PulseChain at the same time.</p>
      <div class="empty-actions">
        <a class="btn btn-primary" href="settings.html">Add an address</a>
        <button class="btn" id="connectBtn">Connect wallet</button>
      </div>
      <p class="muted small">Read-only. This app never requests a signature or a transaction.</p>
      <p class="muted small">Any address can also be opened straight from the URL —
         <code class="mono">?a=0x…</code> — without saving it here.</p>
    </div>`;
  $('connectBtn')?.addEventListener('click', connectWallet);
  renderStatus();
}

/** Adopt a link's address into the saved list, then step off the link. */
function trackViewed(addresses) {
  for (const a of addresses) {
    if (state.settings.addresses.some((x) => x.address === a)) continue;
    state.settings.addresses.push({ address: a, label: '' });
  }
  saveSettings(state.settings);
  location.href = cleanUrl();
}

function renderStatus() {
  const el = $('statusBar');
  if (!el) return;
  const bits = [];
  if (state.loading) {
    const p = state.progress || {};
    const msgs = Object.entries(p).map(([id, m]) => `${CHAINS[id].short}: ${m}`);
    bits.push(`<span class="spinner"></span> ${esc(msgs.join(' · ') || 'loading')}`);
  } else if (state.loadedAt) {
    bits.push(`<span class="dot ok"></span> updated ${fmtAgo(state.loadedAt)}`);
    for (const id of activeChains()) {
      const s = state.snapshots[id];
      bits.push(`<span class="muted">${CHAINS[id].short} block ${s.block.toLocaleString('en-US')}</span>`);
    }
  }
  for (const [id, msg] of Object.entries(state.errors)) {
    bits.push(`<span class="dot bad"></span> ${CHAINS[id].name} failed: ${esc(msg)}`);
  }
  el.innerHTML = bits.join('<span class="sep">·</span>');
  $('refreshBtn')?.toggleAttribute('disabled', state.loading);
}

function renderHero() {
  const t = combinedTotals();
  const day = activeChains().length ? state.snapshots[activeChains()[0]].globals.currentDay : null;

  $('main').innerHTML = `
    <section class="hero card">
      <div class="hero-main">
        <div class="hero-label">Total portfolio value</div>
        <div class="hero-value">${fmtUsd(t.usd)}</div>
        <div class="hero-sub">${fmtHex(t.hex)} HEX across ${activeChains().length} chain${activeChains().length === 1 ? '' : 's'}${
          day != null ? ` · HEX day ${day}` : ''
        }</div>
      </div>
      <div class="hero-breakdown">
        ${statTile('Liquid', fmtHexCompact(t.liquid), 'HEX in wallets')}
        ${statTile('Staked principal', fmtHexCompact(t.principal), `${t.stakeCount} stake${t.stakeCount === 1 ? '' : 's'}`)}
        ${statTile('Interest earned', fmtHexCompact(t.interest), t.bigPayDay > 0n ? `incl. ${fmtHexCompact(t.bigPayDay)} Big Pay Day` : 'paid by the contract')}
        ${statTile('T-shares', fmtTShares(t.shares), 'your share of daily payouts')}
      </div>
    </section>

    <section id="chainCards" class="chain-grid"></section>

    <section class="card">
      <div class="section-head">
        <h2>Stakes</h2>
        <div class="controls">
          <select id="chainFilter" aria-label="Filter by chain"></select>
          <select id="statusFilter" aria-label="Filter by status">
            <option value="all">All statuses</option>
            <option value="active">Active</option>
            <option value="pending">Pending</option>
            <option value="matured">Matured</option>
            <option value="late">Late</option>
            <option value="unlocked">Good accounting</option>
          </select>
          <select id="sortSel" aria-label="Sort stakes">
            <option value="value">Sort: value</option>
            <option value="principal">Sort: principal</option>
            <option value="interest">Sort: interest</option>
            <option value="shares">Sort: T-shares</option>
            <option value="ending">Sort: ending soonest</option>
            <option value="started">Sort: newest</option>
            <option value="apy">Sort: yield</option>
          </select>
        </div>
      </div>
      <div id="stakeList" class="stake-grid"></div>
    </section>

    <section id="tokens"></section>
    <section id="sideTokens"></section>
    <section id="protocol" class="card"></section>
  `;

  const cf = $('chainFilter');
  cf.innerHTML =
    `<option value="all">All chains</option>` +
    activeChains().map((id) => `<option value="${id}">${esc(CHAINS[id].name)}</option>`).join('');
  cf.value = state.chainFilter;
  cf.onchange = () => {
    state.chainFilter = cf.value;
    renderStakes();
  };
  const sf = $('statusFilter');
  sf.value = state.statusFilter;
  sf.onchange = () => {
    state.statusFilter = sf.value;
    renderStakes();
  };
  const ss = $('sortSel');
  ss.value = state.sort;
  ss.onchange = () => {
    state.sort = ss.value;
    localStorage.setItem('hexminer.sort', ss.value);
    renderStakes();
  };
}

const statTile = (label, value, hint) => `
  <div class="tile">
    <div class="tile-label">${esc(label)}</div>
    <div class="tile-value">${esc(value)}</div>
    <div class="tile-hint">${esc(hint)}</div>
  </div>`;

function renderChains() {
  const el = $('chainCards');
  if (!el) return;
  el.innerHTML = state.settings.enabledChains
    .map((id) => {
      const chain = CHAINS[id];
      const snap = state.snapshots[id];
      const err = state.errors[id];
      if (err) {
        return `<div class="card chain-card error" style="--accent:${chain.accent}">
          <div class="chain-head"><span class="chain-name">${esc(chain.name)}</span></div>
          <p class="bad small">${esc(err)}</p></div>`;
      }
      if (!snap) {
        return `<div class="card chain-card" style="--accent:${chain.accent}">
          <div class="chain-head"><span class="chain-name">${esc(chain.name)}</span></div>
          <p class="muted small">loading…</p></div>`;
      }
      const ex = state.extras[id];
      const t = snap.totals;
      const chg = ex?.change24h;
      return `<div class="card chain-card" style="--accent:${chain.accent}">
        <div class="chain-head">
          <span class="chain-name">${esc(chain.name)}</span>
          <span class="badge">${esc(chain.hexSymbol)}</span>
        </div>
        <div class="chain-price">
          ${fmtPrice(snap.price.hexUsd)}
          ${chg != null ? `<span class="chg ${chg >= 0 ? 'up' : 'down'}">${fmtPct(chg)}</span>` : ''}
        </div>
        <div class="muted small">
          vs ${esc(snap.price.quoteSymbol)} · liquidity ${fmtUsd(ex?.liquidityUsd ?? snap.price.liquidityUsd)}
          ${ex?.volume24h != null ? ` · 24h vol ${fmtUsd(ex.volume24h)}` : ''}
        </div>
        <dl class="kv">
          <div><dt>Your HEX</dt><dd>${fmtHex(t.totalHex)}</dd></div>
          <div><dt>Value</dt><dd>${fmtUsd(t.totalUsd)}</dd></div>
          <div><dt>Stakes</dt><dd>${t.stakeCount}</dd></div>
          <div><dt>T-shares</dt><dd>${fmtTShares(t.shares)}</dd></div>
        </dl>
      </div>`;
    })
    .join('');
}

function renderStakes() {
  const el = $('stakeList');
  if (!el) return;
  const stakes = allStakes();
  if (!stakes.length) {
    el.innerHTML = `<p class="muted">No stakes match this filter.</p>`;
    return;
  }
  el.innerHTML = stakes.map(stakeCard).join('');
}

/** 'unlocked' is the state, "good accounting" is what everyone calls the call that causes it. */
const STATUS_LABEL = { unlocked: 'good accounting' };

function stakeCard(s) {
  const chain = CHAINS[s.chainId];
  const price = state.snapshots[s.chainId]?.price?.hexUsd;
  const usd = (h) => (price == null ? '' : `<span class="usd">${fmtUsd(heartsToHex(h) * price)}</span>`);
  const pct = Math.round(s.progress * 100);

  // Lazy on purpose: only the matching branch is evaluated. An object of plain strings
  // would compute every branch for every stake, and unlockedDate is null unless the
  // stake actually ran good accounting.
  const statusText = ({
    pending: () => `Starts ${fmtDate(s.startDate)}`,
    active: () => `${fmtDays(s.daysLeft)} left`,
    matured: () => 'Ready to end',
    late: () => `${fmtDays(s.daysLate)} late`,
    unlocked: () => `Settled ${fmtDate(s.unlockedDate)}${s.daysLate > 0n ? ` — ${fmtDays(s.daysLate)} late` : ''}`,
  }[s.status] || (() => ''))();

  const owner = state.settings.addresses.length > 1
    ? `<span class="owner" title="${esc(s.owner)}">${esc(labelFor(s.owner))}</span>`
    : '';

  return `
  <article class="stake ${s.status}" style="--accent:${chain.accent}">
    <header>
      <div class="stake-id">
        <span class="chain-tag">${esc(chain.short)}</span>
        <span class="mono">${s.isHsi ? 'HSI' : `#${s.index}`}</span>
        <span class="muted mono small">id ${s.stakeId}</span>
        ${s.isAutoStake ? '<span class="badge auto" title="Auto-stake from a BTC claim">auto</span>' : ''}
        ${
          s.isHsi
            ? `<span class="badge hsi" title="A HEX Stake Instance: this stake is held by its own contract (${esc(s.hsiAddress)}) rather than in your wallet's stake list.${
                s.tokenized ? ' It is currently tokenized as an NFT.' : ''
              }">${s.tokenized ? 'HSI · NFT' : 'HSI'}</span>`
            : ''
        }
        ${owner}
      </div>
      <span class="pill ${s.status}"${
        s.goodAccounted
          ? ` title="stakeGoodAccounting() has run on this stake (HEX day ${s.unlockedDay}). It left the share pool then, so interest, penalty and everything below are frozen at that day — nothing changes until it is ended."`
          : ''
      }>${esc(STATUS_LABEL[s.status] || s.status)}</span>
    </header>

    <div class="stake-progress">
      ${ring(s.progress, chain.accent)}
      <div class="progress-meta">
        <div class="progress-days">${s.servedDays} / ${s.stakedDays} days served</div>
        <div class="muted small">${esc(statusText)}</div>
        <div class="muted small">${fmtDate(s.startDate)} → ${fmtDate(s.endDate)}</div>
      </div>
    </div>

    <dl class="kv">
      <div><dt>Principal</dt><dd>${fmtHex(s.principal)} ${usd(s.principal)}</dd></div>
      <div><dt>Interest</dt><dd class="good">${fmtHex(s.interest)} ${usd(s.interest)}</dd></div>
      ${
        s.bigPayDay > 0n
          ? `<div><dt title="Share of unclaimed Satoshis paid on day ${BIG_PAY_DAY}">Big Pay Day</dt><dd class="bpd">${fmtHex(s.bigPayDay)} ${usd(s.bigPayDay)}</dd></div>`
          : ''
      }
      <div><dt>T-shares</dt><dd>${fmtTShares(s.shares)}</dd></div>
      <div><dt>Term</dt><dd>${esc(fmtTerm(s.stakedDays))}</dd></div>
      ${s.apy != null ? `<div><dt title="Interest so far, annualised over days served">Yield</dt><dd>${s.apy.toFixed(2)}%</dd></div>` : ''}
      ${
        s.todayEstimate > 0n
          ? `<div><dt title="The contract pays nothing until a day closes, so this is not yet earned">Today (est.)</dt><dd class="muted">+${fmtHex(s.todayEstimate, 4)}</dd></div>`
          : ''
      }
    </dl>

    ${mintBlock(s)}

    <footer class="if-ended ${s.penalty > 0n ? 'has-penalty' : ''}">
      <div>
        <div class="tile-label">${s.goodAccounted ? 'Settled — pays out' : 'If ended today'}</div>
        <div class="net">${fmtHex(s.netIfEndedNow)} HEX ${usd(s.netIfEndedNow)}</div>
      </div>
      ${
        s.penalty > 0n
          ? `<div class="penalty" title="${
              s.goodAccounted
                ? `Late-end penalty, frozen: 1/700th of the stake return for each of the ${s.daysLate} days between the grace period and the day good accounting ran. It cannot grow.`
                : s.status === 'late'
                ? 'Late-end penalty: 1/700th of the stake return for every day past the 14-day grace period'
                : 'Early-end penalty: the contract confiscates interest over the penalty window (half the term, minimum 90 days)'
            }">
               <div class="tile-label">Penalty${s.goodAccounted ? ' (frozen)' : ''}</div>
               <div class="bad">−${fmtHex(s.penalty)}</div>
             </div>`
          : `<div class="penalty"><div class="tile-label">Penalty</div><div class="good">none</div></div>`
      }
    </footer>
  </article>`;
}

/** Hedron + Communis state for one stake. Unlike HXR/Savant, this exists on both chains. */
function sideFor(stake) {
  const side = state.snapshots[stake.chainId]?.side;
  if (!side || side.error) return null;
  return side.byStake.get(`${stake.owner}:${stake.index}`) || null;
}

/** How much a stored launch bonus multiplies a Hedron mint, e.g. 100 -> 11x. */
const launchMultiple = (b) => 1 + Number(b) / 10;

/**
 * Hedron and Communis rows.
 *
 * These read differently from the HXR/Savant rows above them: Hedron is not a one-shot
 * claim but an allowance that grows every day and is never used up, while Communis has
 * three separate bonuses with their own windows — one of which expires for good.
 */
function sideMintRows(s) {
  const e = sideFor(s);
  if (!e) return '';
  const rows = [];
  const h = e.hedron;

  const hBadge = h.isLoaned
    ? '<span class="mint-pill blocked">loaned</span>'
    : h.needsDetokenize
    ? '<span class="mint-pill warn">detokenize first</span>'
    : h.mintable > 0n
    ? '<span class="mint-pill ready">ready</span>'
    : '<span class="mint-pill">nothing yet</span>';

  const hFlags = [];
  if (h.unmintedDays > 0n) {
    hFlags.push(`<span class="mint-flag" title="Hedron pays per day served. Minting banks the days so far; the rest keeps accruing, so nothing is lost by waiting.">${
      h.unmintedDays} day${h.unmintedDays === 1n ? '' : 's'} unminted${h.mintedDays > 0n ? ` · ${h.mintedDays} already minted` : ''}</span>`);
  }
  if (h.launchBonus > 0n) {
    hFlags.push(`<span class="mint-flag good" title="This stake was registered during Hedron's first 100 days, which permanently multiplies every mint against it.">launch bonus ${launchMultiple(h.launchBonus)}×</span>`);
  }
  if (h.needsDetokenize) {
    hFlags.push('<span class="mint-flag warn" title="Hedron mints against an HSI through the manager\'s list, which a tokenized HSI has left. Detokenize it to mint.">tokenized — detokenize to mint</span>');
  }
  if (h.isLoaned) {
    hFlags.push('<span class="mint-flag bad">borrowed against; repay the loan to mint again</span>');
  }

  rows.push(`<div class="mint-row" style="--accent:${SIDE_TOKENS.HDRN.accent}">
    <span class="mint-name">HDRN</span>
    ${hBadge}
    <span class="mint-amt">${h.mintable > 0n ? fmtSide(h.mintable, 'HDRN') : '—'}</span>
    ${hFlags.length ? `<div class="mint-flags">${hFlags.join('')}</div>` : ''}
  </div>`);

  // Communis reads the caller's own stakeLists, which an HSI stake is not part of.
  if (!e.communis) {
    rows.push(`<div class="mint-row muted-row" style="--accent:${SIDE_TOKENS.COM.accent}">
      <span class="mint-name">COM</span>
      <span class="mint-pill blocked">n/a</span>
      <span class="mint-amt">—</span>
      <div class="mint-flags"><span class="mint-flag">Communis mints from your own stake list, so an HSI stake cannot claim it</span></div>
    </div>`);
    return rows.join('');
  }

  const c = e.communis;
  const badgeFor = (b) => ({
    ready: '<span class="mint-pill ready">ready</span>',
    minted: '<span class="mint-pill done">minted</span>',
    expired: '<span class="mint-pill blocked">expired</span>',
    blocked: '<span class="mint-pill blocked">blocked</span>',
    ineligible: '<span class="mint-pill blocked">ineligible</span>',
    waiting: '<span class="mint-pill">not yet</span>',
    'claimable-by-anyone': '<span class="mint-pill warn">anyone can take</span>',
  }[b.status] || '<span class="mint-pill"></span>');

  const comRow = (label, b, extra = '') => {
    const flags = [];
    if (b.reason) flags.push(`<span class="mint-flag ${b.status === 'expired' ? 'bad' : ''}">${esc(b.reason)}</span>`);
    if (extra) flags.push(extra);
    return `<div class="mint-row" style="--accent:${SIDE_TOKENS.COM.accent}">
      <span class="mint-name">COM</span>
      ${badgeFor(b)}
      <span class="mint-amt">${b.amount > 0n ? fmtSide(b.amount, 'COM') : '—'}</span>
      <span class="mint-best">${esc(label)}</span>
      ${flags.length ? `<div class="mint-flags">${flags.join('')}</div>` : ''}
    </div>`;
  };

  rows.push(comRow('start bonus', c.start, c.start.status === 'ready'
    ? '<span class="mint-flag warn" title="The start bonus is scaled by this stake\'s original share rate over the current global share rate. HEX\'s share rate only rises, so this shrinks every day.">shrinks as HEX\'s share rate rises</span>'
    : ''));

  rows.push(comRow('end bonus', c.end, c.end.status === 'ready'
    ? `<span class="mint-flag warn" title="Communis allows 37 days after the term ends, then the end bonus can never be minted.">${c.end.daysLeft} day${c.end.daysLeft === 1n ? '' : 's'} left in the 37-day window</span>`
    : ''));

  if (c.good.status !== 'waiting' && c.good.status !== 'ineligible') {
    rows.push(comRow('good accounting bonus', c.good, c.good.status === 'claimable-by-anyone'
      ? '<span class="mint-flag bad" title="Communis pays 1% of maxPayout to whoever calls mintGoodAccountingBonus on this stake — anyone, not just you. The call runs HEX stakeGoodAccounting() as a side effect.">a stranger can claim this and unlock your stake</span>'
      : ''));
  }

  return rows.join('');
}

/**
 * The HexRewards / Savant mint state for a single stake. Only PulseChain stakes can mint;
 * on Ethereum these contracts do not exist, so nothing is shown.
 */
function mintBlock(s) {
  const m = mintFor(s);
  const side = sideMintRows(s);
  if (!m) {
    return side
      ? `<div class="mint-block">
           <div class="tile-label">Side stakes
             <a class="mint-help" href="${esc(SIDE_TOKENS.HDRN.app)}" target="_blank" rel="noopener noreferrer">Hedron ↗</a>
             <a class="mint-help" href="${esc(SIDE_TOKENS.COM.app)}" target="_blank" rel="noopener noreferrer">Communis ↗</a>
           </div>${side}</div>`
      : '';
  }
  const rows = [PULSE_TOKENS.HXR, PULSE_TOKENS.SAVANT]
    .map((cfg) => {
      const e = m[cfg.key];
      if (!e) return '';
      const badge = {
        ready: '<span class="mint-pill ready">ready</span>',
        'needs-registration': '<span class="mint-pill warn">register first</span>',
        claimed: '<span class="mint-pill done">minted</span>',
        'index-taken': '<span class="mint-pill blocked">index taken</span>',
        blocked: '<span class="mint-pill blocked">tier full</span>',
        ineligible: '<span class="mint-pill blocked">too small</span>',
        waiting: '<span class="mint-pill">not started</span>',
      }[e.status];

      const dead = e.status === 'blocked' || e.status === 'ineligible' || e.status === 'index-taken';
      let amount;
      if (e.status === 'claimed') amount = fmtTok(e.claimed);
      else if (dead) amount = '—';
      else amount = fmtTok(e.rewardNow);

      const boost =
        e.status !== 'claimed' && !dead && e.rewardBest > e.rewardNow
          ? `<span class="mint-best" title="What this stake mints if held to its final day${
              cfg.needsGoodAccounting ? ', after calling HEX stakeGoodAccounting() to unlock the bonus tier' : ''
            }">→ ${fmtTok(e.rewardBest)} at full term</span>`
          : '';

      const flags = [];
      if (e.boostNeedsGoodAccounting) {
        flags.push(
          `<span class="mint-flag warn" title="HexRewards only pays the 10x/100x tier when unlockedDay != 0. Call HEX stakeGoodAccounting() on this stake first — it keeps the stake in stakeLists, and on a late stake it also freezes the late-end penalty.">call stakeGoodAccounting() first for ${
            e.boostMultiple ? Math.round(e.boostMultiple) + '×' : 'the bonus'
          }</span>`
        );
      }
      if (e.reason) {
        flags.push(`<span class="mint-flag ${e.status === 'index-taken' ? 'bad' : ''}">${esc(e.reason)}</span>`);
      }

      return `<div class="mint-row" style="--accent:${cfg.accent}">
        <span class="mint-name">${esc(cfg.symbol)}</span>
        ${badge}
        <span class="mint-amt">${amount}</span>
        ${boost}
        ${flags.length ? `<div class="mint-flags">${flags.join('')}</div>` : ''}
      </div>`;
    })
    .join('');

  return `<div class="mint-block">
    <div class="tile-label">Secondary mints
      <a class="mint-help" href="${esc(PULSE_TOKENS.HXR.app)}" target="_blank" rel="noopener noreferrer">HXR ↗</a>
      <a class="mint-help" href="${esc(PULSE_TOKENS.SAVANT.app)}" target="_blank" rel="noopener noreferrer">Savant ↗</a>
      <a class="mint-help" href="${esc(SIDE_TOKENS.HDRN.app)}" target="_blank" rel="noopener noreferrer">Hedron ↗</a>
      <a class="mint-help" href="${esc(SIDE_TOKENS.COM.app)}" target="_blank" rel="noopener noreferrer">Communis ↗</a>
    </div>
    ${rows}
    ${side}
  </div>`;
}

function labelFor(addr) {
  const a = state.settings.addresses.find((x) => x.address === addr);
  return a?.label?.trim() || shortAddr(addr);
}

/** Progress ring as inline SVG. */
function ring(progress, accent) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const off = c * (1 - Math.max(0, Math.min(1, progress)));
  return `<svg class="ring" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="rgba(255,255,255,.10)" stroke-width="6"/>
    <circle cx="32" cy="32" r="${r}" fill="none" stroke="${accent}" stroke-width="6"
      stroke-linecap="round" stroke-dasharray="${c.toFixed(2)}" stroke-dashoffset="${off.toFixed(2)}"
      transform="rotate(-90 32 32)"/>
    <text x="32" y="33" text-anchor="middle" dominant-baseline="middle"
      fill="currentColor" font-size="15" font-weight="600">${Math.round(progress * 100)}%</text>
  </svg>`;
}

/** The four PulseChain-only tokens: price, liquidity, your holdings, and tier capacity. */
function renderTokens() {
  const el = $('tokens');
  if (!el) return;
  const p = pulse();
  if (!p) {
    const snap = state.snapshots[TOKENS_CHAIN_ID];
    el.innerHTML = snap?.tokens?.error
      ? `<div class="card"><div class="section-head"><h2>Secondary tokens</h2></div>
         <p class="bad small">Could not read the PulseChain token contracts: ${esc(snap.tokens.error)}</p></div>`
      : '';
    return;
  }
  const { tk } = p;
  const ms = mintSummary();

  const cards = stakeTokens()
    .map((t) => renderTokenCard(t, tk, state.tokenExtras[t.key], { tiers: true }))
    .join('');

  el.innerHTML = `
    <div class="section-head" style="margin-bottom:14px">
      <h2>Stake-minted tokens · PulseChain</h2>
      ${ms ? `<span class="muted small">${fmtTok(ms.hxr)} HXR + ${fmtTok(ms.sav)} SAVANT still mintable</span>` : ''}
    </div>
    <div class="chain-grid">${cards}</div>
    <p class="muted small" style="margin:-4px 0 18px">
      Both contracts exist only on PulseChain — Ethereum stakes cannot mint them. Supply is
      deliberately small: every token in existence was minted by someone staking HEX, one claim
      per stake, and tiers are capped at 369 stakes each.
    </p>`;
}

/**
 * Hedron and Communis across both chains.
 *
 * Rendered as one table rather than as cards, because the story here is the comparison:
 * the same two contracts, same addresses, running independently on Ethereum and
 * PulseChain with their own supplies, prices and balances.
 */
function renderSideTokens() {
  const el = $('sideTokens');
  if (!el) return;

  const ids = activeChains().filter((id) => state.snapshots[id]?.side);
  if (!ids.length) {
    el.innerHTML = '';
    return;
  }
  const errored = ids.filter((id) => state.snapshots[id].side.error);
  const live = ids.filter((id) => !state.snapshots[id].side.error);

  const rows = [];
  for (const cfg of Object.values(SIDE_TOKENS)) {
    for (const id of live) {
      const side = state.snapshots[id].side;
      const price = side.prices[cfg.key];
      const bal = side.balances[cfg.key];
      const mintable = cfg.key === 'HDRN' ? side.totals.hdrnMintable : side.totals.comReady;
      const balUsd = price.usd == null ? null : (Number(bal) / 10 ** cfg.decimals) * price.usd;
      rows.push(`<tr>
        <td><span class="tok-dot" style="background:${cfg.accent}"></span> ${esc(cfg.symbol)}</td>
        <td><span class="chain-tag">${esc(CHAINS[id].short)}</span></td>
        <td class="mono">${fmtPrice(price.usd)}</td>
        <td class="mono">${fmtSide(bal, cfg.key)}${balUsd != null ? ` <span class="usd">${fmtUsd(balUsd)}</span>` : ''}</td>
        <td class="mono ${mintable > 0n ? 'good' : 'muted'}">${mintable > 0n ? fmtSide(mintable, cfg.key) : '—'}</td>
        <td class="mono muted">${price.liquidityUsd == null ? '—' : fmtUsd(price.liquidityUsd)}</td>
      </tr>`);
    }
  }

  // Communis lets you stake COM back into itself against the debt an end-bonus mint creates.
  const staking = live.flatMap((id) =>
    (state.snapshots[id].side.comStaking || [])
      .filter((c) => c.staked > 0n || c.payoutDebt > 0n)
      .map((c) => ({ ...c, chainId: id }))
  );

  el.innerHTML = `
    <div class="section-head" style="margin-bottom:14px">
      <h2>Side stakes · both chains</h2>
      <span class="muted small">Hedron and Communis mint against the same HEX stakes</span>
    </div>
    <div class="card">
      <div class="table-scroll">
        <table class="data">
          <thead><tr><th>Token</th><th>Chain</th><th>Price</th><th>Your balance</th><th>Mintable now</th><th>Pool</th></tr></thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>
      ${
        staking.length
          ? `<div class="table-scroll" style="margin-top:16px">
              <table class="data">
                <thead><tr><th>Staked COM</th><th>Chain</th><th>Amount</th><th>End-bonus debt</th><th>Next payout</th><th>Due now</th></tr></thead>
                <tbody>${staking
                  .map(
                    (c) => `<tr>
                    <td class="mono muted">${esc(labelFor(c.address))}</td>
                    <td><span class="chain-tag">${esc(CHAINS[c.chainId].short)}</span></td>
                    <td class="mono">${fmtSide(c.staked, 'COM')}</td>
                    <td class="mono ${c.debtCovered ? '' : 'bad'}">${fmtSide(c.payoutDebt, 'COM')}${
                      c.debtCovered ? '' : ' <span class="mint-flag bad">not covered — payouts frozen</span>'
                    }</td>
                    <td class="mono muted">${c.nextPayoutDay > 0n ? `HEX day ${c.nextPayoutDay}` : '—'}</td>
                    <td class="mono ${c.bonusDue > 0n ? 'good' : 'muted'}">${c.bonusDue > 0n ? fmtSide(c.bonusDue, 'COM') : '—'}</td>
                  </tr>`
                  )
                  .join('')}</tbody>
              </table>
             </div>`
          : ''
      }
      <p class="muted small" style="margin:14px 0 0">
        Both contracts sit at the same address on Ethereum and PulseChain — deployed before the
        fork, so the bytecode is identical either side while the supplies have diverged since.
        Hedron pays by the day and never expires; Communis pays a start bonus that shrinks as
        HEX's share rate rises, and an end bonus that is gone 37 days after a stake matures.
      </p>
      ${errored
        .map((id) => `<p class="bad small">${esc(CHAINS[id].name)}: ${esc(state.snapshots[id].side.error)}</p>`)
        .join('')}
    </div>`;
}

function renderProtocol() {
  const el = $('protocol');
  if (!el) return;
  const ids = activeChains();
  if (!ids.length) {
    el.innerHTML = '';
    return;
  }
  el.innerHTML = `
    <div class="section-head"><h2>Protocol state</h2>
      <a class="muted small" href="chart.html">View charts →</a></div>
    <div class="table-scroll">
    <table class="data">
      <thead><tr>
        <th>Chain</th><th>Day</th><th>Share rate</th><th>Total T-shares</th>
        <th>Staked HEX</th><th>Circulating</th><th>Payout / T-share (last full day)</th>
      </tr></thead>
      <tbody>
      ${ids
        .map((id) => {
          const s = state.snapshots[id];
          const g = s.globals;
          const lastDay = g.dailyDataCount - 1n;
          const d = s.dailyData.get(lastDay);
          const perT = d && d.shares > 0n ? (Number(d.payout) / Number(d.shares)) * 1e12 / 1e8 : null;
          return `<tr>
            <td><span class="chain-tag" style="--accent:${CHAINS[id].accent}">${esc(CHAINS[id].short)}</span> ${esc(CHAINS[id].name)}</td>
            <td>${g.currentDay}</td>
            <td title="Hearts per share, scaled by 1e5">${(Number(g.shareRate) / 1e5).toFixed(5)}</td>
            <td>${compact(sharesToTShares(g.stakeSharesTotal))}</td>
            <td>${compact(heartsToHex(g.lockedHeartsTotal))}</td>
            <td>${compact(heartsToHex(g.totalSupply))}</td>
            <td>${perT == null ? '—' : perT.toFixed(2) + ' HEX'}</td>
          </tr>`;
        })
        .join('')}
      </tbody>
    </table></div>
    <p class="muted small">
      Share rate only ever rises, so the same amount of HEX buys fewer shares over time —
      earlier stakes keep a permanently larger claim on daily payouts.
    </p>`;
}

// ---------------------------------------------------------------- wallet

async function connectWallet() {
  const eth = window.ethereum;
  if (!eth) {
    alert('No browser wallet detected. You can add any address manually in Settings — this app is read-only and works with watch-only addresses.');
    return;
  }
  try {
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    let added = 0;
    for (const a of accounts || []) {
      if (!isAddress(a)) continue;
      const addr = normalize(a);
      if (state.settings.addresses.some((x) => x.address === addr)) continue;
      state.settings.addresses.push({ address: addr, label: '' });
      added++;
    }
    if (added) {
      saveSettings(state.settings);
      // Connecting a wallet is a request to see your own portfolio, so step off any link.
      if (isViewing()) location.href = cleanUrl();
      else refresh();
    } else {
      alert('That address is already being tracked.');
    }
  } catch (e) {
    if (e?.code !== 4001) alert(`Could not read accounts: ${e.message || e}`);
  }
}

// ---------------------------------------------------------------- boot

document.addEventListener('DOMContentLoaded', () => {
  $('refreshBtn')?.addEventListener('click', refresh);

  $('bellBtn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleNotices();
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('.bell-wrap')) toggleNotices(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') toggleNotices(false);
  });
  window.addEventListener('resize', () => {
    if (!$('noticePanel')?.hidden) positionNotices();
  });

  refresh();
  // keep the "updated Xm ago" label honest
  setInterval(() => {
    if (!state.loading && state.loadedAt) renderStatus();
  }, 30000);
});
