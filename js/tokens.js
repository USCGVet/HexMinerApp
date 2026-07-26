/**
 * Secondary PulseChain DApps: HexRewards (HXR), Savant, JDAI and Taker (TKR).
 *
 * HXR and Savant both mint against your HEX stakes, reading `stakeLists` on the HEX
 * contract directly. That makes the ordering critical: `stakeEnd()` removes a stake from
 * `stakeLists` (swap-and-pop), so once a stake is ended its mint is unreachable forever.
 * This module computes, per stake, exactly what each contract would mint right now and
 * what it would mint if held to full term.
 *
 * The two contracts are NOT the same code — differences that matter:
 *
 *   HexRewards  calculateReward(consumedDays, stakedDays, unlockedDay)
 *               claimed[user][stakeIndex]   <-- keyed by INDEX (the bug)
 *               full-term bonus needs unlockedDay != 0, i.e. HEX stakeGoodAccounting()
 *               STAKEID_PROTECTION = 817340
 *
 *   Savant      calculateReward(consumedDays, stakedDays)
 *               claimed[user][stakeId]      <-- keyed by ID (fixed)
 *               full-term bonus needs only consumedDays == stakedDays
 *               requires stakedHearts >= 1000 HEX
 *               STAKEID_PROTECTION = 819820
 *
 * Both reward formulas were verified against the deployed contracts' own pure
 * calculateReward() across 160 input combinations, plus determineTier() across every
 * tier boundary — all exact.
 */

import {
  SEL, callAddress, callAddressUint, callNoArgs, callUint, padWord, encAddress,
  decodeUint, decodeAddress, decodeWords, decodeReserves,
} from './abi.js';
import { mc } from './rpc.js';

// --------------------------------------------------------------- selectors

const S = {
  getClaimedRewardIndex: '0x57bf814e', // getClaimedReward(address,uint256)  — HexRewards
  getClaimedRewardId:    '0x3559f409', // getClaimedReward(address,uint40)   — Savant
  isStakeRegistered:     '0x615d3461', // isStakeRegistered(uint40)
  tierStakesCount:       '0x858b4e98', // tierStakesCount(uint256)
  ilks:                  '0xd9638d36', // ilks(bytes32)
  urns:                  '0x2424be5c', // urns(bytes32,address)
  debt:                  '0x0dca59c1', // debt()
  Line:                  '0xbabe8a3f', // Line()
  par:                   '0x495d32cb', // par()
};

// --------------------------------------------------------------- config

export const PULSE_TOKENS = {
  HXR: {
    key: 'HXR',
    name: 'HexRewards',
    symbol: 'HXR',
    address: '0xCfCb89f00576A775d9f81961A37ba7DCf12C7d9B',
    decimals: 18,
    // PulseX V2 HEX-stake token / WPLS — deeper than the V1 pool
    pair: '0xD5A8de033c8697cEaa844CA596cc7583c4f8F612',
    dexscreenerPair: '0xD5A8de033c8697cEaa844CA596cc7583c4f8F612',
    app: 'https://uscgvet.github.io/HexRewards/',
    accent: '#7c9dff',
    group: 'stake',
    blurb: 'Minted only by HEX stakers, one claim per stake.',
    mints: true,
    stakeIdProtection: 817340n,
    claimedBy: 'index',
    needsGoodAccounting: true,
    minStakedHex: 0n,
  },
  SAVANT: {
    key: 'SAVANT',
    name: 'Savant',
    symbol: 'SAVANT',
    address: '0xf16e17e4a01bf99b0a03fd3ab697bc87906e1809',
    decimals: 18,
    pair: '0xaAA8894584aAF0092372f0C753769a50f6060742',
    dexscreenerPair: '0xaAA8894584aAF0092372f0C753769a50f6060742',
    app: 'https://uscgvet.github.io/Savant/',
    accent: '#22d3ee',
    group: 'stake',
    blurb: 'The second stake-minted token, with the HexRewards claim bug fixed.',
    mints: true,
    stakeIdProtection: 819820n,
    claimedBy: 'id',
    needsGoodAccounting: false,
    minStakedHex: 100000000000n, // 1,000 HEX in hearts
  },
  JDAI: {
    key: 'JDAI',
    name: 'JDAI Unstablecoin',
    symbol: 'JDAI',
    address: '0x1610E75C9b48BF550137820452dE4049bB22bB72',
    decimals: 18,
    pair: '0x70658Ce6D6C09acdE646F6ea9C57Ba64f4Dc350f',
    dexscreenerPair: '0x70658Ce6D6C09acdE646F6ea9C57Ba64f4Dc350f',
    app: 'https://uscgvet.github.io/jdai-dapp/',
    accent: '#ffc94a',
    group: 'jdai',
    blurb: 'Borrow against PLS. Pegged to 1/1000 oz of gold rather than a dollar.',
    mints: false,
  },
  TKR: {
    key: 'TKR',
    name: 'Taker',
    symbol: 'TKR',
    address: '0xd9e59020089916A8EfA7Dd0B605d55219D72dB7B',
    decimals: 18,
    pair: '0x205C6d44d84E82606E4E921f87b51b71ba85F0f0',
    dexscreenerPair: '0x205c6d44d84e82606e4e921f87b51b71ba85f0f0',
    app: 'https://uscgvet.github.io/jdai-dapp/',
    accent: '#a78bfa',
    group: 'jdai',
    blurb: 'JDAI governance. Fixed supply of 1,000,000 — none can ever be minted.',
    fixedSupply: true,
    mints: false,
    // name()/symbol() are bytes32 on this DSToken-style contract, so they are not read
  },
};

/** JDAI is a MakerDAO fork; these are its core contracts. */
export const JDAI_SYSTEM = {
  vat: '0x7086692dEe57ebEf0dC66A786198C406CfC259cD',
  spotter: '0x08E744BBe065911F45B86812a0F783bB35fb65eb',
  medianizer: '0x361630052FfbA8b40473A142264932eBD482426D',
  jug: '0xa2817B5a84F0f0fC182D1fB2FAD4Fd7E7dbb762E',
  ethJoin: '0x7a86c0a6078FA1e2053b0ff9d015B39387570162',
  daiJoin: '0xBD767F3Fbdc24c5761e6c2a6C936986683584Ad8',
  ilk: '0x504c532d41000000000000000000000000000000000000000000000000000000', // "PLS-A"
};

export const TOKENS_CHAIN_ID = 369; // all of the above are PulseChain-only

/** Tokens shown on the portfolio page vs. the JDAI page. */
export const stakeTokens = () => Object.values(PULSE_TOKENS).filter((t) => t.group === 'stake');
export const jdaiTokens = () => Object.values(PULSE_TOKENS).filter((t) => t.group === 'jdai');

// --------------------------------------------------------------- mint math

const REWARD_PER_DAY = 10000000000000n; // 1e13 == 0.00001 token
const MAX_STAKE_DAYS = 5555n;
const MAX_STAKES_PER_TIER = 369n;

/** HexRewards.calculateReward — the full-term bonus requires unlockedDay != 0. */
export function hxrReward(consumedDays, stakedDays, unlockedDay) {
  let perDay;
  if (stakedDays === MAX_STAKE_DAYS) {
    perDay = unlockedDay === 0n || consumedDays < stakedDays ? REWARD_PER_DAY * 10n : REWARD_PER_DAY * 100n;
  } else {
    perDay = unlockedDay === 0n || consumedDays < stakedDays ? REWARD_PER_DAY : REWARD_PER_DAY * 10n;
  }
  return consumedDays * perDay;
}

/** Savant.calculateReward — the full-term bonus needs only a completed term. */
export function savantReward(consumedDays, stakedDays) {
  let perDay;
  if (stakedDays === MAX_STAKE_DAYS) {
    perDay = consumedDays < stakedDays ? REWARD_PER_DAY * 10n : REWARD_PER_DAY * 100n;
  } else {
    perDay = consumedDays < stakedDays ? REWARD_PER_DAY : REWARD_PER_DAY * 10n;
  }
  return consumedDays * perDay;
}

/** determineTier — identical in both contracts. Tier 9 means "too small to register". */
export function determineTier(hearts) {
  if (hearts < 100000000000n) return 9;          // < 1,000 HEX
  if (hearts < 1000000000000n) return 0;         // < 10k
  if (hearts < 10000000000000n) return 1;        // < 100k
  if (hearts < 100000000000000n) return 2;       // < 1M
  if (hearts < 1000000000000000n) return 3;      // < 10M
  if (hearts < 10000000000000000n) return 4;     // < 100M
  if (hearts < 100000000000000000n) return 5;    // < 1B
  if (hearts < 1000000000000000000n) return 6;   // < 10B
  if (hearts < 10000000000000000000n) return 7;  // < 100B
  return 8;
}

export const TIER_LABELS = [
  '1k–10k', '10k–100k', '100k–1M', '1M–10M', '10M–100M',
  '100M–1B', '1B–10B', '10B–100B', '100B+',
];

/** Same rule as the contracts' calculateConsumedDays(). */
export function consumedDays(currentDay, lockedDay, stakedDays) {
  if (currentDay >= lockedDay + stakedDays) return stakedDays;
  if (currentDay > lockedDay) return currentDay - lockedDay;
  return 0n;
}

// --------------------------------------------------------------- loading

/**
 * Load balances, prices, mint state and the JDAI vault for one set of addresses.
 * PulseChain only — returns null for any other chain.
 *
 * @param rpc      an Rpc instance already pointed at PulseChain
 * @param block    hex block tag, so this agrees with the HEX snapshot
 * @param stakes   derived PulseChain stakes (need owner, index, stakeId, principal,
 *                 lockedDay, stakedDays, unlockedDay)
 * @param plsUsd   PLS price in USD, reused from the HEX price read
 */
export async function loadPulseTokens(rpc, block, addresses, stakes, plsUsd) {
  const list = Object.values(PULSE_TOKENS);
  const calls = [];
  const at = (label) => calls.push(label) - 1;

  // --- prices: token0 + reserves for each pool
  const priceIdx = {};
  for (const t of list) {
    priceIdx[t.key] = calls.length;
    calls.push(mc(t.pair, callNoArgs(SEL.token0)), mc(t.pair, callNoArgs(SEL.getReserves)));
  }

  // --- balances per address
  const balIdx = {};
  for (const t of list) {
    balIdx[t.key] = calls.length;
    for (const a of addresses) calls.push(mc(t.address, callAddress(SEL.balanceOf, a)));
  }

  // --- supplies
  const supplyIdx = calls.length;
  for (const t of list) calls.push(mc(t.address, callNoArgs(SEL.totalSupply)));

  // --- tier occupancy for the two minting contracts
  const tierIdx = {};
  for (const t of list.filter((x) => x.mints)) {
    tierIdx[t.key] = calls.length;
    for (let i = 0; i < 9; i++) calls.push(mc(t.address, S.tierStakesCount + padWord(i)));
  }

  // --- per-stake mint state
  const stakeIdx = calls.length;
  for (const s of stakes) {
    // HexRewards: registration by stakeId, claim slot by INDEX
    calls.push(mc(PULSE_TOKENS.HXR.address, S.isStakeRegistered + padWord(s.stakeId)));
    calls.push(mc(PULSE_TOKENS.HXR.address, S.getClaimedRewardIndex + encAddress(s.owner) + padWord(s.index)));
    // Savant: registration and claim both by stakeId
    calls.push(mc(PULSE_TOKENS.SAVANT.address, S.isStakeRegistered + padWord(s.stakeId)));
    calls.push(mc(PULSE_TOKENS.SAVANT.address, S.getClaimedRewardId + encAddress(s.owner) + padWord(s.stakeId)));
  }

  // --- JDAI system + per-address vault
  const jdaiIdx = calls.length;
  calls.push(
    mc(JDAI_SYSTEM.vat, S.ilks + JDAI_SYSTEM.ilk.slice(2)),
    mc(JDAI_SYSTEM.vat, callNoArgs(S.debt)),
    mc(JDAI_SYSTEM.vat, callNoArgs(S.Line)),
    mc(JDAI_SYSTEM.spotter, callNoArgs(S.par)),
    mc(JDAI_SYSTEM.spotter, S.ilks + JDAI_SYSTEM.ilk.slice(2))
  );
  const vaultIdx = calls.length;
  for (const a of addresses) {
    calls.push(mc(JDAI_SYSTEM.vat, S.urns + JDAI_SYSTEM.ilk.slice(2) + encAddress(a)));
  }

  const r = await rpc.multicallChunked(calls, { block, chunk: 50 });
  const okUint = (i) => (r[i]?.success ? decodeUint(r[i].data) : 0n);

  // ---- prices
  const prices = {};
  for (const t of list) {
    const i = priceIdx[t.key];
    if (!r[i]?.success || !r[i + 1]?.success) {
      prices[t.key] = { usd: null, liquidityUsd: null };
      continue;
    }
    const tokenIsToken0 = decodeAddress(r[i].data).toLowerCase() === t.address.toLowerCase();
    const res = decodeReserves(r[i + 1].data);
    const tokRes = tokenIsToken0 ? res.reserve0 : res.reserve1;
    const plsRes = tokenIsToken0 ? res.reserve1 : res.reserve0;
    if (tokRes === 0n || plsRes === 0n) {
      prices[t.key] = { usd: null, liquidityUsd: 0 };
      continue;
    }
    const tokAmt = Number(tokRes) / 10 ** t.decimals;
    const plsAmt = Number(plsRes) / 1e18;
    const usd = (plsAmt / tokAmt) * plsUsd;
    prices[t.key] = {
      usd,
      // both sides of the pool, which is what DexScreener reports as liquidity
      liquidityUsd: plsAmt * plsUsd * 2,
    };
  }

  // ---- balances & supply
  const balances = {};
  list.forEach((t) => {
    const base = balIdx[t.key];
    balances[t.key] = addresses.reduce((sum, _a, k) => sum + okUint(base + k), 0n);
  });
  const supplies = {};
  list.forEach((t, k) => {
    supplies[t.key] = okUint(supplyIdx + k);
  });

  // ---- tiers
  const tiers = {};
  for (const t of list.filter((x) => x.mints)) {
    const base = tierIdx[t.key];
    tiers[t.key] = Array.from({ length: 9 }, (_, i) => ({
      used: Number(okUint(base + i)),
      max: Number(MAX_STAKES_PER_TIER),
    }));
  }

  // ---- per-stake mint state
  const mintByStake = new Map();
  stakes.forEach((s, k) => {
    const b = stakeIdx + k * 4;
    const unlockedDay = s.unlockedDay ?? 0n;
    const cd = consumedDays(s.currentDay, s.lockedDay, s.stakedDays);
    const fullTerm = cd >= s.stakedDays && s.stakedDays > 0n;

    const hxr = mintEntry({
      cfg: PULSE_TOKENS.HXR,
      stake: s,
      consumed: cd,
      fullTerm,
      unlockedDay,
      registered: r[b]?.success ? decodeUint(r[b].data) !== 0n : false,
      claimed: r[b + 1]?.success ? decodeUint(r[b + 1].data) : 0n,
      tiers: tiers.HXR,
      rewardNow: hxrReward(cd, s.stakedDays, unlockedDay),
      rewardBest: hxrReward(s.stakedDays, s.stakedDays, 1n),
    });

    const sav = mintEntry({
      cfg: PULSE_TOKENS.SAVANT,
      stake: s,
      consumed: cd,
      fullTerm,
      unlockedDay,
      registered: r[b + 2]?.success ? decodeUint(r[b + 2].data) !== 0n : false,
      claimed: r[b + 3]?.success ? decodeUint(r[b + 3].data) : 0n,
      tiers: tiers.SAVANT,
      rewardNow: savantReward(cd, s.stakedDays),
      rewardBest: savantReward(s.stakedDays, s.stakedDays),
    });

    mintByStake.set(`${s.owner}:${s.index}`, { HXR: hxr, SAVANT: sav });
  });

  // ---- JDAI system
  const ilk = r[jdaiIdx]?.success ? decodeWords(r[jdaiIdx].data, 5) : null;
  const spotIlk = r[jdaiIdx + 4]?.success ? decodeWords(r[jdaiIdx + 4].data, 2) : null;
  const jdai = {
    // par is the target price: JDAI tracks 1/1000 oz of gold, so par ≈ gold/1000
    par: okUint(jdaiIdx + 3),
    totalDebt: okUint(jdaiIdx + 1),
    debtCeiling: okUint(jdaiIdx + 2),
    art: ilk ? ilk[0] : 0n,
    rate: ilk ? ilk[1] : 0n,
    spot: ilk ? ilk[2] : 0n,
    line: ilk ? ilk[3] : 0n,
    dust: ilk ? ilk[4] : 0n,
    mat: spotIlk ? spotIlk[1] : 0n,
    vaults: [],
  };
  addresses.forEach((a, k) => {
    const i = vaultIdx + k;
    if (!r[i]?.success) return;
    const w = decodeWords(r[i].data, 2);
    if (w[0] === 0n && w[1] === 0n) return; // no vault
    jdai.vaults.push({ address: a, ink: w[0], art: w[1] });
  });

  return { prices, balances, supplies, tiers, mintByStake, jdai, plsUsd };
}

/**
 * Decide whether a stake can mint from one contract right now, and why not if it can't.
 * Mirrors the require()s in each claimReward().
 */
function mintEntry({ cfg, stake, consumed, fullTerm, unlockedDay, registered, claimed, tiers, rewardNow, rewardBest }) {
  const tier = determineTier(stake.principal);
  const needsRegistration = stake.stakeId > cfg.stakeIdProtection;
  const tierState = tier < 9 ? tiers[tier] : null;
  const tierFull = tierState ? tierState.used >= tierState.max : false;

  let status = 'ready';
  let reason = null;

  /*
    Proving an index collision (HexRewards only).

    rewardNow is monotonically non-decreasing for a given stake: consumedDays only grows,
    and the per-day rate only ever steps up. So a recorded claim LARGER than what this
    stake could mint right now cannot have come from this stake — the index was consumed
    by a different stake that has since been ended, and HEX moved this one into the freed
    slot. This stake can never mint HexRewards.

    The converse is not provable: claimed <= rewardNow is consistent with an ordinary
    earlier claim on this same stake, so it is reported as a normal "minted".
  */
  const collision = cfg.claimedBy === 'index' && claimed > 0n && claimed > rewardNow;

  if (collision) {
    status = 'index-taken';
    reason =
      `index ${stake.index} already holds a claim of ${formatToken(claimed)} ${cfg.symbol} that is larger than ` +
      `this stake could mint — the slot belongs to a different, already-ended stake, so this stake cannot mint ${cfg.symbol}`;
  } else if (claimed > 0n) {
    status = 'claimed';
  } else if (cfg.minStakedHex > 0n && stake.principal < cfg.minStakedHex) {
    status = 'ineligible';
    reason = `${cfg.symbol} requires a stake of at least 1,000 HEX`;
  } else if (consumed === 0n) {
    status = 'waiting';
    reason = 'nothing accrues until the stake\'s first day is served';
  } else if (needsRegistration && !registered) {
    if (tier === 9) {
      status = 'ineligible';
      reason = 'stakes under 1,000 HEX cannot be registered to a tier';
    } else if (tierFull) {
      status = 'blocked';
      reason = `tier ${tier} (${TIER_LABELS[tier]} HEX) is full at ${tierState.max}/${tierState.max} — this stake cannot register`;
    } else {
      status = 'needs-registration';
      reason = `register first (claimStake) — tier ${tier} has ${tierState.max - tierState.used} of ${tierState.max} slots left`;
    }
  }

  // Ending the stake destroys the opportunity, so flag anything still unclaimed AND
  // still reachable. 'blocked' means the tier filled permanently (tierStakesCount only
  // ever increments), so nothing is actually at stake there.
  const reachable = status === 'ready' || status === 'needs-registration' || status === 'waiting';
  const atRisk = reachable && rewardNow > 0n;
  // How much this stake's own claim slot is worth losing to the index bug.
  const lostToCollision = collision ? rewardNow : 0n;

  return {
    token: cfg.key,
    symbol: cfg.symbol,
    status,
    reason,
    claimed,
    rewardNow,
    rewardBest,
    // HexRewards needs stakeGoodAccounting() before claiming to unlock the 10x/100x tier
    boostNeedsGoodAccounting: cfg.needsGoodAccounting && fullTerm && unlockedDay === 0n,
    boostMultiple: rewardNow > 0n ? Number(rewardBest) / Number(rewardNow) : null,
    tier,
    tierFull,
    registered,
    needsRegistration,
    atRisk,
    indexKeyed: cfg.claimedBy === 'index',
    collision,
    lostToCollision,
  };
}

/** Local helper so reason strings can quote amounts without importing the formatters. */
function formatToken(v) {
  return (Number(v) / 1e18).toLocaleString('en-US', { minimumFractionDigits: 5, maximumFractionDigits: 5 });
}

// --------------------------------------------------------------- JDAI helpers

const RAY = 1000000000000000000000000000n; // 1e27
const WAD = 1000000000000000000n;          // 1e18

/** JDAI's target price in USD (par is a ray). */
export const jdaiTargetUsd = (par) => Number(par) / 1e27;

/** Minimum collateral ratio, e.g. 1.5 => 150%. */
export const jdaiMat = (mat) => Number(mat) / 1e27;

/**
 * The collateral price the protocol itself is using, recovered from `spot`.
 * Spotter stores spot = (oraclePrice / par) / mat, so oraclePrice = spot * mat * par.
 * This is what liquidation is measured against — not the DEX price.
 */
export function jdaiOraclePlsUsd(jdai) {
  const mat = jdaiMat(jdai.mat);
  const par = jdaiTargetUsd(jdai.par);
  if (!mat || !par) return null;
  return (Number(jdai.spot) / 1e27) * mat * par;
}

/**
 * Vault health. ink is PLS collateral (wad), art is normalised debt (wad);
 * actual JDAI owed = art * rate / RAY.
 *
 * `safe` is the contract's own test (ink * spot >= art * rate) evaluated in integer math,
 * so it agrees with the Vat exactly rather than approximately.
 */
export function jdaiVaultStats(vault, jdai, dexPlsUsd) {
  const debtWad = (vault.art * jdai.rate) / RAY;
  const debtJdai = Number(debtWad) / 1e18;
  const targetUsd = jdaiTargetUsd(jdai.par);
  const mat = jdaiMat(jdai.mat) || 1.5;
  const oraclePlsUsd = jdaiOraclePlsUsd(jdai);

  const collateralPls = Number(vault.ink) / 1e18;
  const collateralUsd = collateralPls * (oraclePlsUsd ?? dexPlsUsd);
  const collateralUsdDex = collateralPls * dexPlsUsd;
  const debtUsd = debtJdai * targetUsd;

  // Collateralisation measured at the oracle price, the same basis as liquidation.
  const ratio = debtUsd > 0 ? collateralUsd / debtUsd : null;
  // PLS price at which this vault stops being safe.
  const liquidationPls = collateralPls > 0 && debtUsd > 0 ? (debtUsd * mat) / collateralPls : null;

  return {
    collateralPls,
    collateralUsd,
    collateralUsdDex,
    debtWad,
    debtJdai,
    debtUsd,
    ratio,
    mat,
    oraclePlsUsd,
    liquidationPls,
    // exact Vat safety test: art * rate <= ink * spot
    safe: vault.art * jdai.rate <= vault.ink * jdai.spot,
  };
}
