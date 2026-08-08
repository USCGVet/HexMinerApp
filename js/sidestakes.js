/**
 * Hedron and Communis — the two stake-minting contracts this app did not author.
 *
 * They sit alongside HexRewards and Savant conceptually, but differ in three ways that
 * shape this module:
 *
 *   1. They exist on BOTH chains, at the same addresses, with independent state. HEX's
 *      state was forked to PulseChain and these were already deployed, so the bytecode is
 *      identical either side (verified by codehash) while the supplies have since
 *      diverged. Everything here is therefore chain-parameterised, unlike tokens.js which
 *      is PulseChain-only by nature.
 *
 *   2. Hedron mints INCREMENTALLY. It is not one claim per stake — it pays for the days
 *      served since the last mint, so "mintable now" grows daily and is never used up
 *      until the stake ends.
 *
 *   3. Hedron also mints against HSI stakes: HEX stakes wrapped in their own contract and
 *      held by the HSI Manager. Those are real HEX stakes that never appear in a wallet's
 *      own stakeLists, so they are loaded here and folded into the portfolio.
 *
 * Arithmetic provenance:
 *   Communis  getPayout / getStartBonusPayout are `pure` on-chain, so this transcription
 *             was checked against the deployed contract over 312 realistic stakes —
 *             1,992 values, zero mismatches.
 *   Hedron    exposes no equivalent view, so the mint formula was checked against real
 *             historical Mint events: 105 mints across 30 stakes, zero mismatches,
 *             covering first mints, incremental mints and launch bonuses of 0, 90 and 100.
 */

import { SEL, callAddress, callAddressUint, callNoArgs, padWord,
         decodeUint, decodeAddress, decodeWords, decodeReserves, decodeStake } from './abi.js';
import { mc } from './rpc.js';
import { HEX_ADDRESS } from './config.js';

// --------------------------------------------------------------- addresses

/** Same on Ethereum and PulseChain — deployed before the fork. */
export const HEDRON_ADDRESS = '0x3819f64f282bf135d62168C1e513280dAF905e06';
export const COMMUNIS_ADDRESS = '0x5A9780Bfe63f3ec57f01b087cD65BD656C9034A8';
export const HSIM_ADDRESS = '0x8BD3d1472A656e312E94fB1BbdD599B8C51D18e3';

/** Hedron's own epoch: 2022-02-26T00:00:00Z, unrelated to HEX's launch. */
const HDRN_LAUNCH = 1645833600n;
const HDRN_LAUNCH_DAYS = 100n;

// --------------------------------------------------------------- selectors

const S = {
  // Hedron
  shareList:        '0xd4029727', // shareList(uint256)            keyed by stakeId
  dailyDataList:    '0x6144a2d8', // dailyDataList(uint256)
  // Communis
  startBonusPaid:   '0x741bf921', // stakeIdStartBonusPayout(uint256)
  endBonusPaid:     '0xea98ed9a', // stakeIdEndBonusPayout(uint256)
  goodAcctPaid:     '0x6c03c39c', // stakeIdGoodAccountingBonusPayout(uint256)
  stakedCodeak:     '0x7b4296db', // addressStakedCodeak(address)
  endBonusDebt:     '0x3b665f9c', // addressEndBonusDebt(address)
  restakeEndDebt:   '0x60bc0be8', // addressRestakeEndDebt(address)
  // HSI Manager
  hsiCount:         '0xb947e629', // hsiCount(address)             detokenized only
  hsiLists:         '0xf2b29141', // hsiLists(address,uint256)     -> HSI contract address
  tokenOfOwnerByIndex: '0x2f745c59', // tokenOfOwnerByIndex(address,uint256)
  hsiToken:         '0x1322e104', // hsiToken(uint256)             tokenId -> HSI address
  // HSI instance
  share:            '0xa8d5fd65', // share()
};

// --------------------------------------------------------------- token config

export const SIDE_TOKENS = {
  HDRN: {
    key: 'HDRN',
    name: 'Hedron',
    symbol: 'HDRN',
    address: HEDRON_ADDRESS,
    decimals: 9,
    app: 'https://hedron.pro/',
    accent: '#a78bfa',
    blurb: 'Mints against HEX stakes by the day, and keeps paying as the stake runs.',
    // Both chains' deepest usable V2 pools quote in HEX, which this app already prices
    // exactly — so no second hop and no stablecoin assumption.
    pairs: {
      1:   { address: '0x035a397725D3c9fc5Ddd3E56066B7b64C749014e', quote: 'HEX' },
      369: { address: '0xa67F04E03194F3A1064f4FF4FF0f0f0144fD5EfF', quote: 'HEX' },
    },
  },
  COM: {
    key: 'COM',
    name: 'Communis',
    symbol: 'COM',
    address: COMMUNIS_ADDRESS,
    decimals: 12,
    app: 'https://communis.io/',
    accent: '#34e5b0',
    blurb: 'Pays a bonus at stake start, at stake end, and for cleaning up stale stakes.',
    pairs: {
      1:   { address: '0x8FFdc8C69e1c1AFdbd4D37e9dF98EBA3e3Aca92D', quote: 'HEX' },
      369: { address: '0x5aDbcC7885311Fc621B3Ac59D685b355Ae4507F5', quote: 'HEX' },
    },
  },
};

// --------------------------------------------------------------- Hedron math

/** _calcLPBMultiplier — the launch-phase bonus tier, in tenths. */
export function hdrnLaunchMultiplier(launchDay) {
  if (launchDay > 90n) return 100n;
  if (launchDay > 80n) return 90n;
  if (launchDay > 70n) return 80n;
  if (launchDay > 60n) return 70n;
  if (launchDay > 50n) return 60n;
  if (launchDay > 40n) return 50n;
  if (launchDay > 30n) return 40n;
  if (launchDay > 20n) return 30n;
  if (launchDay > 10n) return 20n;
  if (launchDay > 0n) return 10n;
  return 0n;
}

export const hdrnDayFor = (blockTimestamp) => (BigInt(blockTimestamp) - HDRN_LAUNCH) / 86400n;

/**
 * mintNative / mintInstanced — both reduce to the same arithmetic.
 *
 * Bonuses compound in order: the launch bonus is applied to the base payout, then the
 * mint multiplier is applied to the result. `_calcBonus` is `payout * multiplier / 10`,
 * so a launchBonus of 100 is a 10x bonus on top of the base, i.e. 11x overall.
 *
 * @param mintedDays days already minted for this stake (0 if never minted)
 * @param launchBonus stored on the share; only ever set during Hedron's first 100 days
 * @param mintMultiplier that Hedron day's loan-to-mint bonus (0 on every day so far)
 */
export function hdrnMintable({ shares, lockedDay, stakedDays, hexCurrentDay, mintedDays, launchBonus, mintMultiplier, hdrnDay }) {
  if (hexCurrentDay < lockedDay) return 0n; // cannot mint against a pending stake

  let servedDays = hexCurrentDay - lockedDay;
  if (servedDays > stakedDays) servedDays = stakedDays;
  if (servedDays <= mintedDays) return 0n;

  const mintDays = servedDays - mintedDays;
  let payout = shares * mintDays;

  // An unminted stake picks up a launch bonus only while Hedron is still in its first
  // 100 days. That window closed long ago, so in practice this only ever replays a
  // bonus already stored on the share.
  let bonus = launchBonus;
  if (bonus === 0n && hdrnDay != null && hdrnDay < HDRN_LAUNCH_DAYS) {
    bonus = hdrnLaunchMultiplier(HDRN_LAUNCH_DAYS - hdrnDay);
  }
  if (bonus > 0n) payout += (payout * bonus) / 10n;
  if (mintMultiplier > 0n) payout += (payout * mintMultiplier) / 10n;

  return payout;
}

// --------------------------------------------------------------- Communis math

const COM_MIN_SHARES = 9999n;      // strictly greater than, per the contract
const COM_END_GRACE_DAYS = 37n;    // the end bonus is unreachable after this
const COM_STAKE_BONUS_PERIOD = 91n;

/** getStakesBonusHearts — HEX's start bonus, reversed out of the recorded shares. */
function stakesBonusHearts(s) {
  let cappedDays = 0n;
  if (s.stakedDays > 1n) cappedDays = s.stakedDays <= 3640n ? s.stakedDays - 1n : 3640n;
  const cappedHearts = s.stakedHearts <= 15n * 10n ** 15n ? s.stakedHearts : 15n * 10n ** 15n;
  return (s.stakedHearts * (cappedDays * (15n * 10n ** 16n) + cappedHearts * 1820n)) / (273n * 10n ** 18n);
}

/** getRecalculatedBonusHearts — the same, without HEX's 3,640-day cap on the term. */
function recalculatedBonusHearts(s) {
  const cappedDays = s.stakedDays - 1n;
  const cappedHearts = s.stakedHearts <= 15n * 10n ** 15n ? s.stakedHearts : 15n * 10n ** 15n;
  return (s.stakedHearts * (cappedDays * (15n * 10n ** 16n) + cappedHearts * 1820n)) / (273n * 10n ** 18n);
}

/** Communis.getPayout — maxPayout is the ceiling any single stake can ever mint. */
export function comPayout(s) {
  if (s.stakeShares === 0n) return { recalculatedStakeShares: 0n, stakesOriginalShareRate: 0n, maxPayout: 0n };
  const stakesOriginalShareRate = ((s.stakedHearts + stakesBonusHearts(s)) * 10n ** 5n) / s.stakeShares;
  if (stakesOriginalShareRate === 0n) return { recalculatedStakeShares: 0n, stakesOriginalShareRate: 0n, maxPayout: 0n };
  const recalculatedStakeShares = ((s.stakedHearts + recalculatedBonusHearts(s)) * 10n ** 17n) / stakesOriginalShareRate;
  const penalty = (s.stakedDays * 10n ** 15n) / 5555n;
  return {
    recalculatedStakeShares,
    stakesOriginalShareRate,
    maxPayout: (recalculatedStakeShares * penalty) / 10n ** 15n,
  };
}

/**
 * Communis.getStartBonusPayout.
 *
 * The start bonus decays: once past the stake's own start day it is scaled by
 * stakesOriginalShareRate / globalShareRate, and HEX's share rate only ever rises. So
 * every day of delay permanently costs some of it.
 */
export function comStartBonus({ stakedDays, lockedDay, maxPayout, stakesOriginalShareRate, currentDay, globalShareRate, applyRestakeBonus }) {
  let bonusPercentage;
  if (applyRestakeBonus) {
    bonusPercentage = ((stakedDays - 365n) * 10n ** 10n) / 5190n;
    bonusPercentage = (3n * 10n ** 10n * bonusPercentage) / 10n ** 10n;
    bonusPercentage = 5n * 10n ** 10n - bonusPercentage;
  } else if (stakedDays > 364n) {
    bonusPercentage = ((stakedDays - 365n) * 10n ** 10n) / 5190n;
    bonusPercentage = (6n * 10n ** 10n * bonusPercentage) / 10n ** 10n;
    bonusPercentage = 10n * 10n ** 10n - bonusPercentage;
  } else {
    bonusPercentage = ((stakedDays - 180n) * 10n ** 10n) / 185n;
    bonusPercentage = (10n * 10n ** 10n * bonusPercentage) / 10n ** 10n;
    bonusPercentage = 20n * 10n ** 10n - bonusPercentage;
  }
  if (bonusPercentage <= 0n) return 0n;

  let payout = (maxPayout * 10n ** 10n) / bonusPercentage;
  if (currentDay !== lockedDay && globalShareRate > 0n) {
    const penalty = (stakesOriginalShareRate * 10n ** 15n) / globalShareRate;
    payout = (payout * penalty) / 10n ** 15n;
  }
  return payout;
}

/**
 * Everything Communis will and will not pay for one stake, mirroring each mint
 * function's require()s.
 *
 * @param hsiOwned the stake belongs to an HSI contract rather than to the wallet.
 *   _mintStartBonus and _mintEndBonus both read memoryStake(msg.sender, …), so neither is
 *   reachable for one. mintGoodAccountingBonus is the exception — it takes stakeOwner as a
 *   parameter, so it works against an HSI's stake and anyone may call it.
 */
export function comStakeState(stake, paid, globals, { hsiOwned = false } = {}) {
  const { currentDay, shareRate } = globals;
  const s = {
    stakedHearts: stake.principal,
    stakeShares: stake.shares,
    lockedDay: stake.lockedDay,
    stakedDays: stake.stakedDays,
  };
  const pr = comPayout(s);
  const dueDay = stake.lockedDay + stake.stakedDays;
  const graceEnd = dueDay + COM_END_GRACE_DAYS;
  const enoughShares = stake.shares > COM_MIN_SHARES;

  const ownerBound = { status: 'ineligible', amount: 0n, reason: 'only the HSI contract itself could mint this' };

  // ---- start bonus
  let start;
  if (hsiOwned) {
    start = { ...ownerBound };
  } else if (paid.start > 0n) {
    start = { status: 'minted', amount: paid.start, reason: null };
  } else if (paid.end > 0n) {
    start = { status: 'blocked', amount: 0n, reason: 'end bonus already minted' };
  } else if (!enoughShares) {
    start = { status: 'ineligible', amount: 0n, reason: 'needs at least 10,000 shares' };
  } else if (stake.stakedDays <= 179n) {
    start = { status: 'ineligible', amount: 0n, reason: 'needs a term of at least 180 days' };
  } else if (currentDay < stake.lockedDay) {
    start = { status: 'waiting', amount: 0n, reason: 'stake has not started' };
  } else {
    start = {
      status: 'ready',
      amount: comStartBonus({
        stakedDays: stake.stakedDays, lockedDay: stake.lockedDay, maxPayout: pr.maxPayout,
        stakesOriginalShareRate: pr.stakesOriginalShareRate, currentDay,
        globalShareRate: shareRate, applyRestakeBonus: false,
      }),
      reason: null,
    };
  }

  // ---- end bonus: a hard 37-day window after the term, then gone for good
  let end;
  if (hsiOwned) {
    end = { ...ownerBound };
  } else if (paid.end > 0n) {
    end = { status: 'minted', amount: paid.end, reason: null };
  } else if (!enoughShares) {
    end = { status: 'ineligible', amount: 0n, reason: 'needs at least 10,000 shares' };
  } else if (stake.stakedDays <= 364n) {
    end = { status: 'ineligible', amount: 0n, reason: 'needs a term of at least 365 days' };
  } else if (currentDay < dueDay) {
    end = { status: 'waiting', amount: 0n, reason: `opens on HEX day ${dueDay}` };
  } else if (currentDay > graceEnd) {
    end = { status: 'expired', amount: 0n, reason: `the 37-day window closed on day ${graceEnd}` };
  } else {
    const amount = pr.maxPayout > paid.start ? pr.maxPayout - paid.start : 0n;
    end = { status: 'ready', amount, reason: null, daysLeft: graceEnd - currentDay };
  }

  // ---- good accounting bonus: 1% of maxPayout, paid to whoever calls it
  let good;
  if (paid.good > 0n) {
    good = { status: 'minted', amount: paid.good, reason: null };
  } else if (paid.end > 0n) {
    good = { status: 'blocked', amount: 0n, reason: 'end bonus already minted' };
  } else if (!enoughShares) {
    good = { status: 'ineligible', amount: 0n, reason: 'needs at least 10,000 shares' };
  } else if (stake.unlockedDay !== 0n) {
    good = { status: 'blocked', amount: 0n, reason: 'stake is already unlocked' };
  } else if (currentDay <= graceEnd) {
    good = { status: 'waiting', amount: 0n, reason: `opens on HEX day ${graceEnd + 1n}` };
  } else {
    // Anyone can take this, and taking it runs good accounting on the stake.
    good = { status: 'claimable-by-anyone', amount: pr.maxPayout / 100n, reason: null };
  }

  /*
    Start and end are NOT additive. _mintEndBonus pays maxPayout - stakeIdStartBonusPayout,
    so minting the start bonus first reduces the end bonus one for one and the pair together
    can never exceed maxPayout. Whenever the end bonus is reachable its amount already IS
    the whole remaining ceiling, so that is the figure a total may count; adding the start
    bonus on top would promise COM that cannot exist.
  */
  const bestNow =
    end.status === 'ready' ? end.amount : start.status === 'ready' ? start.amount : 0n;
  const sharesCeiling = end.status === 'ready' && start.status === 'ready';

  return { maxPayout: pr.maxPayout, bestNow, sharesCeiling, start, end, good };
}

/** _mintStakeBonus — what staked COM has accrued, in 91-day chunks. */
export function comStakeBonusDue(stakedCodeak, nextPayoutDay, payoutDebt, currentDay) {
  if (payoutDebt === 0n || stakedCodeak < payoutDebt) return 0n;
  if (nextPayoutDay === 0n || currentDay < nextPayoutDay) return 0n;
  const payouts = (currentDay - nextPayoutDay) / COM_STAKE_BONUS_PERIOD + 1n;
  return (stakedCodeak * payouts) / 80n;
}

// --------------------------------------------------------------- loading

/** Decode the 11-word ShareStore returned by HSI.share() and Hedron.shareList(). */
function decodeShare(data) {
  const w = decodeWords(data, 11);
  return {
    stakeId: w[0], stakeShares: w[1], lockedDay: w[2], stakedDays: w[3],
    mintedDays: w[4], launchBonus: w[5], loanStart: w[6], loanedDays: w[7],
    interestRate: w[8], paymentsMade: w[9], isLoaned: w[10] !== 0n,
  };
}

/**
 * Load Hedron + Communis state for one chain.
 *
 * Runs in three passes because the HSI inventory is only discoverable by walking it:
 * a wallet's HSI count, then each slot, then each slot's stake. Everything that does not
 * depend on that walk is batched into the first pass.
 *
 * @param stakes  the wallet's own (native) derived stakes
 * @param globals HEX globals — currentDay, shareRate and blockTimestamp
 * @param hexUsd  HEX price on this chain; both pools quote in HEX
 */
export async function loadSideStakes(rpc, chainId, block, addresses, stakes, globals, hexUsd, onProgress) {
  const tokens = Object.values(SIDE_TOKENS);
  const hdrnDay = hdrnDayFor(globals.blockTimestamp);

  // ---------------- pass 1
  const calls = [];

  const priceIdx = {};
  for (const t of tokens) {
    const pair = t.pairs[chainId];
    priceIdx[t.key] = calls.length;
    // Both sides are read so the HEX-quote assumption below can be checked rather than
    // assumed, in either token ordering.
    calls.push(
      mc(pair.address, callNoArgs(SEL.token0)),
      mc(pair.address, callNoArgs(SEL.token1)),
      mc(pair.address, callNoArgs(SEL.getReserves))
    );
  }

  const balIdx = {};
  for (const t of tokens) {
    balIdx[t.key] = calls.length;
    for (const a of addresses) calls.push(mc(t.address, callAddress(SEL.balanceOf, a)));
  }

  const supplyIdx = calls.length;
  for (const t of tokens) calls.push(mc(t.address, callNoArgs(SEL.totalSupply)));

  const dayIdx = calls.length;
  calls.push(mc(HEDRON_ADDRESS, S.dailyDataList + padWord(hdrnDay)));

  // Hedron share record per native stake, keyed by stakeId (no index collisions here)
  const shareIdx = calls.length;
  for (const s of stakes) calls.push(mc(HEDRON_ADDRESS, S.shareList + padWord(s.stakeId)));

  // Communis per-stake payout records, all keyed by stakeId
  const comIdx = calls.length;
  for (const s of stakes) {
    calls.push(mc(COMMUNIS_ADDRESS, S.startBonusPaid + padWord(s.stakeId)));
    calls.push(mc(COMMUNIS_ADDRESS, S.endBonusPaid + padWord(s.stakeId)));
    calls.push(mc(COMMUNIS_ADDRESS, S.goodAcctPaid + padWord(s.stakeId)));
  }

  // Communis staking, per address
  const comStakeIdx = calls.length;
  for (const a of addresses) {
    calls.push(mc(COMMUNIS_ADDRESS, callAddress(S.stakedCodeak, a)));
    calls.push(mc(COMMUNIS_ADDRESS, callAddress(S.endBonusDebt, a)));
    calls.push(mc(COMMUNIS_ADDRESS, callAddress(S.restakeEndDebt, a)));
  }

  // HSI inventory sizes: detokenized live in hsiLists, tokenized are ERC-721 balances
  const hsiCountIdx = calls.length;
  for (const a of addresses) {
    calls.push(mc(HSIM_ADDRESS, callAddress(S.hsiCount, a)));
    calls.push(mc(HSIM_ADDRESS, callAddress(SEL.balanceOf, a)));
  }

  const r = await rpc.multicallChunked(calls, { block, chunk: 50 });
  const okUint = (i) => (r[i]?.success ? decodeUint(r[i].data) : 0n);

  // ---- prices, quoted in HEX
  const prices = {};
  for (const t of tokens) {
    const i = priceIdx[t.key];
    const blank = { usd: null, hexPer: null, liquidityUsd: null, reserveToken: null, reserveHex: null, lastTradeAt: null };
    if (!r[i]?.success || !r[i + 1]?.success || !r[i + 2]?.success || hexUsd == null) {
      prices[t.key] = blank;
      continue;
    }
    const token0 = decodeAddress(r[i].data).toLowerCase();
    const token1 = decodeAddress(r[i + 1].data).toLowerCase();
    const self = t.address.toLowerCase();
    const hex = HEX_ADDRESS.toLowerCase();
    const isToken0 = token0 === self;
    /*
      Everything below converts through HEX, so the pair really must be TOKEN/HEX. A stale
      or mistyped address, or a pool that has since been replaced, would otherwise divide by
      some unrelated token's reserve and present the result as a price. Refusing to quote is
      the honest outcome; a fabricated number is not.
    */
    const paired = isToken0 ? token1 : token0;
    if ((token0 !== self && token1 !== self) || paired !== hex) { prices[t.key] = blank; continue; }

    const res = decodeReserves(r[i + 2].data);
    const tokRes = isToken0 ? res.reserve0 : res.reserve1;
    const hexRes = isToken0 ? res.reserve1 : res.reserve0;
    if (tokRes === 0n || hexRes === 0n) { prices[t.key] = { ...blank, liquidityUsd: 0 }; continue; }
    const tokAmt = Number(tokRes) / 10 ** t.decimals;
    const hexAmt = Number(hexRes) / 1e8;
    prices[t.key] = {
      usd: (hexAmt / tokAmt) * hexUsd,
      hexPer: hexAmt / tokAmt,
      liquidityUsd: hexAmt * hexUsd * 2,
      reserveToken: tokAmt,
      reserveHex: hexAmt,
      lastTradeAt: res.blockTimestampLast ? Number(res.blockTimestampLast) * 1000 : null,
    };
  }

  const balances = {};
  const supplies = {};
  tokens.forEach((t, k) => {
    const base = balIdx[t.key];
    balances[t.key] = addresses.reduce((sum, _a, i) => sum + okUint(base + i), 0n);
    supplies[t.key] = okUint(supplyIdx + k);
  });

  const mintMultiplier = r[dayIdx]?.success ? decodeWords(r[dayIdx].data, 5)[4] : 0n;

  // ---- Communis staking per address
  const comStaking = addresses.map((address, i) => {
    const b = comStakeIdx + i * 3;
    const staked = okUint(b);
    const debtWords = r[b + 1]?.success ? decodeWords(r[b + 1].data, 2) : [0n, 0n];
    const restakeWords = r[b + 2]?.success ? decodeWords(r[b + 2].data, 3) : [0n, 0n, 0n];
    const nextPayoutDay = debtWords[0];
    const payoutDebt = debtWords[1];
    return {
      address,
      staked,
      nextPayoutDay,
      payoutDebt,
      // Falling below the debt freezes the payouts until it is topped back up.
      debtCovered: payoutDebt === 0n || staked >= payoutDebt,
      bonusDue: comStakeBonusDue(staked, nextPayoutDay, payoutDebt, globals.currentDay),
      restake: { stakedDays: restakeWords[0], endBonusPayoutDay: restakeWords[1], sharesDebt: restakeWords[2] },
    };
  });

  // ---- per-stake state for the wallet's own stakes
  const byStake = new Map();
  stakes.forEach((s, k) => {
    byStake.set(`${s.owner}:${s.index}`, buildStakeEntry(s, {
      share: r[shareIdx + k]?.success ? decodeShare(r[shareIdx + k].data) : null,
      paid: {
        start: okUint(comIdx + k * 3),
        end: okUint(comIdx + k * 3 + 1),
        good: okUint(comIdx + k * 3 + 2),
      },
      globals, mintMultiplier, hdrnDay,
    }));
  });

  // ---------------- walk the HSI inventory
  //
  // Kept in its own failure domain: HSI stakes are real HEX holdings that feed the
  // portfolio totals, and they are discovered through the HSI manager with no dependence
  // on Hedron or Communis state. A price or mint read falling over must not silently take
  // a wallet's stakes with it.
  let hsiStakes = [];
  let hsiError = null;
  try {
    hsiStakes = await loadHsiStakes(rpc, block, addresses, r, hsiCountIdx, onProgress);
  } catch (e) {
    hsiError = e.message || String(e);
  }

  return {
    chainId,
    prices,
    balances,
    supplies,
    hdrnDay,
    mintMultiplier,
    comStaking,
    byStake,
    hsiStakes,
    hsiError,
    totals: summarise(byStake, hsiStakes, comStaking, prices),
  };
}

/**
 * Hedron + Communis state for a single stake.
 *
 * Communis is deliberately absent for HSI stakes: every one of its mint functions reads
 * HEX.stakeLists(msg.sender, …), and an HSI's stake belongs to the HSI contract rather
 * than to the wallet, so a holder can never mint a Communis bonus against one. Hedron is
 * the only one of the two with an instanced mint path.
 */
function buildStakeEntry(stake, { share, paid, globals, mintMultiplier, hdrnDay, isHsi = false }) {
  const minted = share?.stakeId === stake.stakeId ? share.mintedDays : 0n;
  const launchBonus = share?.stakeId === stake.stakeId ? share.launchBonus : 0n;
  const isLoaned = share?.stakeId === stake.stakeId ? share.isLoaned : false;
  const needsDetokenize = isHsi && stake.tokenized === true;

  // What the stake has accrued, whether or not it can be collected in its current state.
  const accrued = hdrnMintable({
    shares: stake.shares,
    lockedDay: stake.lockedDay,
    stakedDays: stake.stakedDays,
    hexCurrentDay: globals.currentDay,
    mintedDays: minted,
    launchBonus,
    mintMultiplier,
    hdrnDay,
  });

  /*
    Two preconditions block a mint outright, and both would make the transaction revert:
    mintInstanced requires the HSI to still be in the manager's hsiLists, which
    hexStakeTokenize prunes it out of, and it refuses a loaned stake. Neither loses the
    accrual — the owner can clear both — but "mintable now" must not count either, or the
    totals promise HDRN that no call can currently produce.
  */
  const blockedBy = isLoaned ? 'loaned' : needsDetokenize ? 'tokenized' : null;
  const mintable = blockedBy ? 0n : accrued;

  let servedDays = globals.currentDay > stake.lockedDay ? globals.currentDay - stake.lockedDay : 0n;
  if (servedDays > stake.stakedDays) servedDays = stake.stakedDays;

  return {
    isHsi,
    hedron: {
      accrued,
      mintable,
      blockedBy,
      mintedDays: minted,
      unmintedDays: servedDays > minted ? servedDays - minted : 0n,
      launchBonus,
      isLoaned,
      // Nothing is lost by waiting — unlike a one-shot claim, the days keep accruing.
      status: blockedBy || (mintable > 0n ? 'ready' : 'nothing-yet'),
      // A tokenized HSI has to be detokenized before Hedron will mint against it.
      needsDetokenize,
    },
    // An HSI stake still gets a Communis state: the good-accounting bonus reaches it even
    // though the start and end bonuses do not.
    communis: comStakeState(stake, paid, globals, { hsiOwned: isHsi }),
  };
}

/**
 * Fold the HSI stakes' mint state in once they have been derived. Deriving needs the
 * chain snapshot's dailyData, which this module does not have, so it happens in the
 * loader and comes back here.
 */
export function attachHsiEntries(side, derivedHsiStakes, globals) {
  for (const d of derivedHsiStakes) {
    const src = side.hsiStakes.find((h) => h.hsiAddress === d.hsiAddress);
    side.byStake.set(`${d.owner}:${d.index}`, buildStakeEntry(d, {
      share: src?.share ?? null,
      paid: src?.paid ?? { start: 0n, end: 0n, good: 0n },
      globals,
      mintMultiplier: side.mintMultiplier,
      hdrnDay: side.hdrnDay,
      isHsi: true,
    }));
  }
  side.totals = summarise(side.byStake, side.hsiStakes, side.comStaking, side.prices);
}

/**
 * HSI stakes for every address, in two passes: read each wallet's slots, then read the
 * HEX stake and Hedron share behind each slot.
 *
 * Detokenized HSIs are addressable directly through the manager's own stakeLists wrapper.
 * Tokenized ones are ERC-721s, so the token id has to be resolved to an HSI address
 * first — and Hedron cannot mint against them until they are detokenized.
 */
async function loadHsiStakes(rpc, block, addresses, r, hsiCountIdx, onProgress) {
  const okUint = (i) => (r[i]?.success ? decodeUint(r[i].data) : 0n);

  const slots = [];
  addresses.forEach((address, i) => {
    const detok = Number(okUint(hsiCountIdx + i * 2));
    const tok = Number(okUint(hsiCountIdx + i * 2 + 1));
    for (let k = 0; k < detok; k++) slots.push({ address, index: k, tokenized: false });
    for (let k = 0; k < tok; k++) slots.push({ address, index: k, tokenized: true });
  });
  if (!slots.length) return [];

  onProgress?.(`reading ${slots.length} HSI stake${slots.length === 1 ? '' : 's'}`);

  // pass 2: detokenized slots resolve straight to a stake; tokenized give a token id
  const p2 = slots.map((s) =>
    s.tokenized
      ? mc(HSIM_ADDRESS, callAddressUint(S.tokenOfOwnerByIndex, s.address, s.index))
      : mc(HSIM_ADDRESS, callAddressUint(S.hsiLists, s.address, s.index))
  );
  const r2 = await rpc.multicallChunked(p2, { block, chunk: 50 });

  // pass 3: token ids -> HSI addresses
  const needsToken = slots.map((s, i) => ({ s, i })).filter(({ s }) => s.tokenized);
  let tokenAddrs = new Map();
  if (needsToken.length) {
    const p3 = needsToken.map(({ i }) =>
      mc(HSIM_ADDRESS, S.hsiToken + padWord(r2[i]?.success ? decodeUint(r2[i].data) : 0n))
    );
    const r3 = await rpc.multicallChunked(p3, { block, chunk: 50 });
    needsToken.forEach(({ i }, k) => {
      if (r3[k]?.success) tokenAddrs.set(i, decodeAddress(r3[k].data));
    });
  }

  const hsiAddrs = slots.map((s, i) =>
    s.tokenized ? tokenAddrs.get(i) : r2[i]?.success ? decodeAddress(r2[i].data) : null
  );

  // pass 4: the HEX stake and the Hedron share behind each HSI
  const live = slots.map((s, i) => ({ s, i, addr: hsiAddrs[i] })).filter((x) => x.addr && !/^0x0+$/.test(x.addr));
  if (!live.length) return [];

  const p4 = [];
  for (const { addr } of live) {
    p4.push(mc(HEX_ADDRESS, callAddressUint(SEL.stakeLists, addr, 0)));
    p4.push(mc(addr, callNoArgs(S.share)));
  }
  const r4 = await rpc.multicallChunked(p4, { block, chunk: 50 });

  const out = [];
  live.forEach(({ s, addr }, k) => {
    const stakeRes = r4[k * 2];
    const shareRes = r4[k * 2 + 1];
    if (!stakeRes?.success) return;
    const raw = decodeStake(stakeRes.data);
    if (raw.stakeId === 0n) return;
    out.push({
      owner: s.address,
      hsiAddress: addr,
      hsiIndex: s.index,
      tokenized: s.tokenized,
      raw,
      share: shareRes?.success ? decodeShare(shareRes.data) : null,
    });
  });
  if (!out.length) return out;

  // pass 5: Communis records for these stake ids. The good-accounting bonus reaches an
  // HSI stake, and it is gated on no end bonus having been minted, so both are needed —
  // without them an already-taken bonus would render as still claimable.
  const p5 = [];
  for (const h of out) {
    p5.push(mc(COMMUNIS_ADDRESS, S.goodAcctPaid + padWord(h.raw.stakeId)));
    p5.push(mc(COMMUNIS_ADDRESS, S.endBonusPaid + padWord(h.raw.stakeId)));
  }
  const r5 = await rpc.multicallChunked(p5, { block, chunk: 50 });
  out.forEach((h, k) => {
    h.paid = {
      start: 0n, // unreachable for an HSI: _mintStartBonus is bound to msg.sender
      good: r5[k * 2]?.success ? decodeUint(r5[k * 2].data) : 0n,
      end: r5[k * 2 + 1]?.success ? decodeUint(r5[k * 2 + 1].data) : 0n,
    };
  });
  return out;
}

function summarise(byStake, hsiStakes, comStaking, prices) {
  let hdrnMintableTotal = 0n;
  let comReady = 0n;
  let comExpiringSoon = 0n;
  let expiringCount = 0;

  for (const e of byStake.values()) {
    // mintable, not accrued: a loaned or tokenized stake would revert the mint today.
    hdrnMintableTotal += e.hedron.mintable;
    if (!e.communis) continue;
    // bestNow, not start + end: the two share one maxPayout ceiling.
    comReady += e.communis.bestNow;
    if (e.communis.end.status === 'ready') {
      comExpiringSoon += e.communis.end.amount;
      expiringCount++;
    }
  }

  const comStakedTotal = comStaking.reduce((a, c) => a + c.staked, 0n);
  const comBonusDue = comStaking.reduce((a, c) => a + c.bonusDue, 0n);

  const usd = (key, raw, decimals) =>
    prices[key]?.usd == null ? null : (Number(raw) / 10 ** decimals) * prices[key].usd;

  return {
    hdrnMintable: hdrnMintableTotal,
    hdrnMintableUsd: usd('HDRN', hdrnMintableTotal, SIDE_TOKENS.HDRN.decimals),
    comReady,
    comReadyUsd: usd('COM', comReady, SIDE_TOKENS.COM.decimals),
    comExpiringSoon,
    expiringCount,
    comStakedTotal,
    comBonusDue,
    hsiCount: hsiStakes.length,
  };
}
