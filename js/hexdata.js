/**
 * Loads a complete, self-consistent snapshot of one chain.
 *
 * Two things make this fast:
 *  1. Every read is pinned to one block number, so currentDay, globals, balances and
 *     stakes can never disagree with each other mid-load.
 *  2. dailyData is append-only in the contract — once a day is stored it never
 *     changes — so it is cached locally and only the new days are fetched. First load
 *     pulls ~2,400 days; later loads pull the handful that have closed since.
 */

import {
  SEL, callAddress, callAddressUint, callNoArgs, padWord,
  decodeUint, decodeAddress, decodeUintArray, decodeWords, decodeStake, decodeReserves,
} from './abi.js';
import { HEX_ADDRESS, CHAINS, rpcsFor } from './config.js';
import { Rpc, mc } from './rpc.js';
import { unpackDailyData, decodeGlobalInfo, deriveStake, BIG_PAY_DAY } from './hexmath.js';
import { loadPulseTokens, TOKENS_CHAIN_ID } from './tokens.js';
import { loadSideStakes, attachHsiEntries } from './sidestakes.js';

const CACHE_PREFIX = 'hexminer.dailydata.v1.';
const DAYS_PER_CALL = 500;

// ---------------------------------------------------------------- dailyData cache

function readCache(chainId) {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + chainId);
    if (!raw) return [];
    const arr = raw.split(',');
    return arr[0] === '' ? [] : arr;
  } catch {
    return [];
  }
}

function writeCache(chainId, hexWords) {
  try {
    localStorage.setItem(CACHE_PREFIX + chainId, hexWords.join(','));
  } catch {
    /* quota exceeded — the app still works, just re-fetches next time */
  }
}

export function clearDailyDataCache() {
  for (const id of Object.keys(CHAINS)) localStorage.removeItem(CACHE_PREFIX + id);
}

/**
 * Fetch dailyDataRange(start, end), halving the range and retrying if the request is
 * rejected. Public endpoints throttle bursts and occasionally refuse a large response;
 * without this a single transient failure discards the entire chain snapshot.
 */
async function fetchDayRange(rpc, start, end, block, depth = 0) {
  try {
    const r = await rpc.multicallChunked(
      [mc(HEX_ADDRESS, SEL.dailyDataRange + padWord(start) + padWord(end))],
      { block, chunk: 1 }
    );
    if (!r[0]?.success) throw new Error(`dailyDataRange(${start},${end}) reverted`);
    return decodeUintArray(r[0].data);
  } catch (e) {
    // Give up splitting once the range is tiny — at that point it is a real failure.
    if (end - start <= 16 || depth > 6) {
      throw new Error(`could not read daily data for days ${start}–${end}: ${e.message}`);
    }
    const mid = start + Math.ceil((end - start) / 2);
    const first = await fetchDayRange(rpc, start, mid, block, depth + 1);
    const second = await fetchDayRange(rpc, mid, end, block, depth + 1);
    return [...first, ...second];
  }
}

/**
 * Return a Map<BigInt day, {payout, shares, unclaimed}> for days [0, dailyDataCount).
 * Uses the cache for days already known and fetches only the remainder.
 */
async function loadDailyData(rpc, chainId, dailyDataCount, block, onProgress) {
  const cached = readCache(chainId);
  const have = Math.min(cached.length, Number(dailyDataCount));
  const need = Number(dailyDataCount) - have;

  const words = cached.slice(0, have);

  if (need > 0) {
    onProgress?.(`fetching ${need} day${need === 1 ? '' : 's'} of daily data`);
    // Sequential rather than parallel: public endpoints rate-limit bursts, and one
    // rejected request here would otherwise cost the whole chain's snapshot.
    for (let start = have; start < Number(dailyDataCount); start += DAYS_PER_CALL) {
      const end = Math.min(start + DAYS_PER_CALL, Number(dailyDataCount));
      const values = await fetchDayRange(rpc, start, end, block);
      for (const v of values) words.push('0x' + v.toString(16));
    }
    writeCache(chainId, words);
  }

  const dd = new Map();
  for (let i = 0; i < words.length; i++) dd.set(BigInt(i), unpackDailyData(words[i]));
  return dd;
}

// ---------------------------------------------------------------- price

/**
 * Price HEX in USD from the configured pair, detecting token ordering at runtime
 * instead of assuming it. A hardcoded assumption about which side is token0 silently
 * inverts the price when wrong, which is exactly the failure the old version had.
 */
async function loadPrice(rpc, chain, block) {
  const hp = chain.hexPair;
  const np = chain.nativeUsdPair;

  const calls = [
    mc(hp.address, callNoArgs(SEL.token0)),
    mc(hp.address, callNoArgs(SEL.getReserves)),
    mc(hp.quote, callNoArgs(SEL.decimals)),
    mc(np.address, callNoArgs(SEL.token0)),
    mc(np.address, callNoArgs(SEL.getReserves)),
    mc(np.quote, callNoArgs(SEL.decimals)),
  ];
  const r = await rpc.multicallChunked(calls, { block });
  if (r.some((x) => !x.success)) throw new Error('price pair read failed');

  // HEX per quote token
  const hexIsToken0 = decodeAddress(r[0].data).toLowerCase() === HEX_ADDRESS.toLowerCase();
  const hexRes = decodeReserves(r[1].data);
  const quoteDecimals = Number(decodeUint(r[2].data));
  const hexReserve = hexIsToken0 ? hexRes.reserve0 : hexRes.reserve1;
  const quoteReserve = hexIsToken0 ? hexRes.reserve1 : hexRes.reserve0;
  if (hexReserve === 0n) throw new Error('HEX pair has no liquidity');
  const hexPerQuote = ratio(quoteReserve, quoteDecimals, hexReserve, 8);

  // quote token in USD
  let quoteUsd = 1;
  if (!hp.quoteIsUsd) {
    const baseIsToken0 = decodeAddress(r[3].data).toLowerCase() === np.base.toLowerCase();
    const nRes = decodeReserves(r[4].data);
    const usdDecimals = Number(decodeUint(r[5].data));
    const baseReserve = baseIsToken0 ? nRes.reserve0 : nRes.reserve1;
    const usdReserve = baseIsToken0 ? nRes.reserve1 : nRes.reserve0;
    if (baseReserve === 0n) throw new Error('native/USD pair has no liquidity');
    quoteUsd = ratio(usdReserve, usdDecimals, baseReserve, 18);
  }

  return {
    hexUsd: hexPerQuote * quoteUsd,
    quoteSymbol: hp.quoteSymbol,
    hexPerQuote,
    quoteUsd,
    // the quote token here is the chain's wrapped native, so this doubles as the
    // native price used to value the secondary PulseChain tokens
    nativeUsd: hp.quoteIsUsd ? null : quoteUsd,
    liquidityUsd: (Number(quoteReserve) / 10 ** quoteDecimals) * quoteUsd * 2,
  };
}

const ratio = (num, numDec, den, denDec) =>
  (Number(num) / 10 ** numDec) / (Number(den) / 10 ** denDec);

/**
 * Optional enrichment: 24h change and volume for any pair. Never blocks a load, and the
 * app is fully functional without it — on-chain reserves remain the source of truth.
 */
export async function loadPairExtras(chainSlug, pairAddress) {
  try {
    const url = `https://api.dexscreener.com/latest/dex/pairs/${chainSlug}/${pairAddress}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const j = await res.json();
    const p = (j.pairs || [])[0];
    if (!p) return null;
    return {
      priceUsd: p.priceUsd ? Number(p.priceUsd) : null,
      change24h: p.priceChange?.h24 != null ? Number(p.priceChange.h24) : null,
      change6h: p.priceChange?.h6 != null ? Number(p.priceChange.h6) : null,
      volume24h: p.volume?.h24 != null ? Number(p.volume.h24) : null,
      liquidityUsd: p.liquidity?.usd != null ? Number(p.liquidity.usd) : null,
      dexId: p.dexId || null,
    };
  } catch {
    return null;
  }
}

/** The HEX pair for a chain. */
export const loadMarketExtras = (chain) => loadPairExtras(chain.dexscreener, chain.hexPair.address);

// ---------------------------------------------------------------- main loader

/**
 * @param chainId 1 | 369
 * @param addresses array of lowercase 0x addresses
 * @returns snapshot { chain, globals, price, wallets, stakes, totals, block }
 */
export async function loadChainSnapshot(chainId, addresses, settings, onProgress) {
  const chain = CHAINS[chainId];
  const rpc = new Rpc(rpcsFor(chainId, settings), { stickyKey: String(chainId) });

  onProgress?.('connecting');
  const block = '0x' + (await rpc.blockNumber()).toString(16);

  // Pass 1: globals + price + per-address balance and stake count, all at one block.
  onProgress?.('reading contract state');
  const head = [
    mc(HEX_ADDRESS, callNoArgs(SEL.globalInfo)),
    mc(HEX_ADDRESS, callNoArgs(SEL.currentDay)),
    ...addresses.flatMap((a) => [
      mc(HEX_ADDRESS, callAddress(SEL.balanceOf, a)),
      mc(HEX_ADDRESS, callAddress(SEL.stakeCount, a)),
    ]),
  ];
  const [headResults, price] = await Promise.all([
    rpc.multicallChunked(head, { block }),
    loadPrice(rpc, chain, block).catch((e) => ({ error: e.message, hexUsd: null })),
  ]);

  if (!headResults[0].success) throw new Error('globalInfo() failed — is this the right chain?');
  const globals = decodeGlobalInfo(decodeWords(headResults[0].data, 13));
  globals.currentDay = decodeUint(headResults[1].data);

  const wallets = addresses.map((address, i) => ({
    address,
    balance: headResults[2 + i * 2].success ? decodeUint(headResults[2 + i * 2].data) : 0n,
    stakeCount: headResults[3 + i * 2].success ? Number(decodeUint(headResults[3 + i * 2].data)) : 0,
  }));

  // Pass 2: dailyData (cached) and every stake, in parallel.
  const stakeCalls = [];
  for (const w of wallets) {
    for (let i = 0; i < w.stakeCount; i++) {
      stakeCalls.push({ owner: w.address, index: i, call: mc(HEX_ADDRESS, callAddressUint(SEL.stakeLists, w.address, i)) });
    }
  }

  const [dd, stakeResults] = await Promise.all([
    loadDailyData(rpc, chainId, globals.dailyDataCount, block, onProgress),
    stakeCalls.length
      ? (onProgress?.(`reading ${stakeCalls.length} stake${stakeCalls.length === 1 ? '' : 's'}`),
        rpc.multicallChunked(stakeCalls.map((s) => s.call), { block }))
      : Promise.resolve([]),
  ]);

  // The Big Pay Day share total is needed for any stake open across day 352.
  if (!dd.has(BIG_PAY_DAY) && globals.dailyDataCount > BIG_PAY_DAY) {
    const r = await rpc.multicallChunked([mc(HEX_ADDRESS, SEL.dailyData + padWord(BIG_PAY_DAY))], { block });
    if (r[0]?.success) {
      const w = decodeWords(r[0].data, 3);
      dd.set(BIG_PAY_DAY, { payout: w[0], shares: w[1], unclaimed: w[2] });
    }
  }

  // Derive the wallet's own stakes. These stay separate from HSI stakes below, because
  // HexRewards and Savant address a stake by its index in the caller's own stakeLists —
  // a numbering an HSI stake simply is not part of.
  const nativeStakes = [];
  stakeResults.forEach((r, i) => {
    if (!r.success) return;
    const meta = stakeCalls[i];
    const raw = decodeStake(r.data);
    if (raw.stakeId === 0n) return; // defensive: not a live entry
    const d = deriveStake(globals, dd, raw, meta.index);
    d.owner = meta.owner;
    nativeStakes.push(d);
  });

  // Hedron and Communis mint against these same stakes on BOTH chains, and Hedron also
  // covers HSI stakes — HEX stakes held by their own contracts, which never appear in a
  // wallet's stakeLists and so would otherwise be invisible here.
  let side = null;
  let hsiStakes = [];
  try {
    onProgress?.('reading Hedron and Communis');
    side = await loadSideStakes(rpc, chainId, block, addresses, nativeStakes, globals, price.hexUsd, onProgress);

    hsiStakes = side.hsiStakes.map((h) => {
      const d = deriveStake(globals, dd, h.raw, 0);
      d.owner = h.owner;
      d.isHsi = true;
      d.hsiAddress = h.hsiAddress;
      d.tokenized = h.tokenized;
      // Identified by HSI address rather than a list position, so it can never be
      // mistaken for — or collide with — a native stake index.
      d.index = `hsi-${h.hsiAddress.slice(2, 10)}`;
      return d;
    });
    attachHsiEntries(side, hsiStakes, globals);
  } catch (e) {
    side = { error: e.message || String(e) };
  }

  // PulseChain also hosts the secondary DApps that mint against these same stakes.
  // Native stakes only: both address their claim slots through the caller's stakeLists.
  let tokens = null;
  if (chainId === TOKENS_CHAIN_ID && price.nativeUsd) {
    onProgress?.('reading HexRewards, Savant and JDAI');
    try {
      tokens = await loadPulseTokens(rpc, block, addresses, nativeStakes, price.nativeUsd);
    } catch (e) {
      tokens = { error: e.message || String(e) };
    }
  }

  const stakes = [...nativeStakes, ...hsiStakes];
  const totals = summarise(wallets, stakes, price.hexUsd);

  return {
    chain,
    chainId,
    globals,
    price,
    wallets,
    stakes,
    nativeStakes,
    hsiStakes,
    totals,
    tokens,
    side,
    dailyData: dd,
    block: BigInt(block),
    rpcUrl: rpc.activeUrl,
    rpcFailures: rpc.failures,
  };
}

/**
 * Just the PulseChain token state — no HEX stakes, no dailyData.
 *
 * The JDAI page only needs prices and balances, so it would be wasteful (and needlessly
 * fragile) to pull ~2,400 days of daily data and every stake to render two token cards.
 */
export async function loadTokensSnapshot(addresses, settings, onProgress) {
  const chain = CHAINS[TOKENS_CHAIN_ID];
  const rpc = new Rpc(rpcsFor(TOKENS_CHAIN_ID, settings), { stickyKey: String(TOKENS_CHAIN_ID) });

  onProgress?.('connecting');
  const block = '0x' + (await rpc.blockNumber()).toString(16);

  onProgress?.('reading prices');
  const price = await loadPrice(rpc, chain, block);
  if (!price.nativeUsd) throw new Error('could not price PLS');

  onProgress?.('reading JDAI and Taker');
  const tokens = await loadPulseTokens(rpc, block, addresses, [], price.nativeUsd);

  return { chain, chainId: TOKENS_CHAIN_ID, price, tokens, block: BigInt(block), rpcUrl: rpc.activeUrl };
}

function summarise(wallets, stakes, hexUsd) {
  const liquid = wallets.reduce((a, w) => a + w.balance, 0n);
  const principal = stakes.reduce((a, s) => a + s.principal, 0n);
  const interest = stakes.reduce((a, s) => a + s.interest, 0n);
  const bigPayDay = stakes.reduce((a, s) => a + s.bigPayDay, 0n);
  const shares = stakes.reduce((a, s) => a + s.shares, 0n);
  const penaltyIfEndedNow = stakes.reduce((a, s) => a + s.penalty, 0n);
  const netIfEndedNow = stakes.reduce((a, s) => a + s.netIfEndedNow, 0n);
  const todayEstimate = stakes.reduce((a, s) => a + s.todayEstimate, 0n);
  const totalHex = liquid + principal + interest;
  return {
    liquid,
    principal,
    interest,
    bigPayDay,
    baseInterest: interest - bigPayDay,
    shares,
    penaltyIfEndedNow,
    netIfEndedNow,
    todayEstimate,
    totalHex,
    stakeCount: stakes.length,
    hexUsd,
    totalUsd: hexUsd == null ? null : (Number(totalHex) / 1e8) * hexUsd,
  };
}
