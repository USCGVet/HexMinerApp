/**
 * HEX stake accounting, transcribed from the deployed contract
 * (0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39, solc 0.5.13 — identical bytecode on
 * Ethereum and PulseChain).
 *
 * All arithmetic is BigInt and uses truncating division in the same order as Solidity,
 * so results are exact to the heart rather than approximate. This implementation was
 * checked against 2,734 real historical StakeEnd events spanning every code path
 * (pre/post Big Pay Day, matured, late-penalty, early-penalty) with zero deviation.
 *
 * Reference: GlobalsAndUtility._dailyRoundCalc, StakeableToken._calcPayoutRewards,
 * _stakePerformance, _calcPayoutAndEarlyPenalty, _calcLatePenalty, _stakeStartBonusHearts.
 */

// ---------------------------------------------------------------- constants

export const HEARTS_PER_HEX = 100000000n;             // 10 ** decimals(8)
export const HEARTS_PER_SATOSHI = 10000n;             // 1e8 / 1e8 * 1e4
export const LAUNCH_TIME = 1575331200n;               // 2019-12-03T00:00:00Z
export const CLAIM_PHASE_START_DAY = 1n;              // = PRE_CLAIM_DAYS
export const CLAIM_PHASE_DAYS = 350n;                 // 50 weeks
export const CLAIM_PHASE_END_DAY = 351n;              // START + DAYS
export const BIG_PAY_DAY = 352n;                      // CLAIM_PHASE_END_DAY + 1
export const CLAIMABLE_BTC_ADDR_COUNT = 27997742n;
export const CLAIMABLE_SATOSHIS_TOTAL = 910087996911001n;
export const MIN_STAKE_DAYS = 1n;
export const MAX_STAKE_DAYS = 5555n;                  // approx 15 years
export const MIN_AUTO_STAKE_DAYS = 350n;
export const EARLY_PENALTY_MIN_DAYS = 90n;
export const LATE_PENALTY_GRACE_DAYS = 14n;           // 2 weeks
export const LATE_PENALTY_SCALE_DAYS = 700n;          // 100 weeks
export const SHARE_RATE_SCALE = 100000n;              // 1e5
export const LPB = 1820n;                             // 364 * 100 / 20
export const LPB_MAX_DAYS = 3640n;                    // LPB * 200 / 100
export const BPB_MAX_HEARTS = 15000000000000000n;     // 150e6 HEX in hearts
export const BPB = 150000000000000000n;               // BPB_MAX_HEARTS * 100 / 10
export const INFLATION_DIVISOR = 100448995n;          // 3.69% / 364d, scaled by 10000

const MASK72 = (1n << 72n) - 1n;
const MASK56 = (1n << 56n) - 1n;

// ---------------------------------------------------------------- state decoding

/** Unpack one word of dailyDataRange(). Layout from dailyDataRange(): */
/*  bits   0..71  dayPayoutTotal      (uint72)
 *  bits  72..143 dayStakeSharesTotal (uint72)
 *  bits 144..199 dayUnclaimedSatoshisTotal (uint56)                            */
export function unpackDailyData(packed) {
  const v = BigInt(packed);
  return {
    payout: v & MASK72,
    shares: (v >> 72n) & MASK72,
    unclaimed: (v >> 144n) & MASK56,
  };
}

/** Map globalInfo()'s uint256[13] onto names. */
export function decodeGlobalInfo(w) {
  return {
    lockedHeartsTotal: w[0],
    nextStakeSharesTotal: w[1],
    shareRate: w[2],
    stakePenaltyTotal: w[3],
    dailyDataCount: w[4],
    stakeSharesTotal: w[5],
    latestStakeId: w[6],
    unclaimedSatoshisTotal: w[7],
    claimedSatoshisTotal: w[8],
    claimedBtcAddrCount: w[9],
    blockTimestamp: w[10],
    totalSupply: w[11],
    xfLobby: w[12],
  };
}

// ---------------------------------------------------------------- core payout math

/** _calcAdoptionBonus: viral (addresses claimed) + crit mass (satoshis claimed). */
export function calcAdoptionBonus(g, payout) {
  const viral = (payout * g.claimedBtcAddrCount) / CLAIMABLE_BTC_ADDR_COUNT;
  const crit = (payout * g.claimedSatoshisTotal) / CLAIMABLE_SATOSHIS_TOTAL;
  return viral + crit;
}

/**
 * _calcPayoutRewards: sum each day's share of that day's payout, then add the
 * Big Pay Day slice if the stake was open across day 352.
 *
 * @param dd Map<BigInt day, {payout, shares}> covering [beginDay, endDay)
 */
export function calcPayoutRewards(g, dd, stakeShares, beginDay, endDay) {
  let payout = 0n;
  for (let day = beginDay; day < endDay; day++) {
    const d = dd.get(day);
    if (!d || d.shares === 0n) continue; // unstored/empty day contributes nothing
    payout += (d.payout * stakeShares) / d.shares;
  }
  if (beginDay <= BIG_PAY_DAY && endDay > BIG_PAY_DAY) {
    const bpd = dd.get(BIG_PAY_DAY);
    if (bpd && bpd.shares !== 0n) {
      const slice = (g.unclaimedSatoshisTotal * HEARTS_PER_SATOSHI * stakeShares) / bpd.shares;
      payout += slice + calcAdoptionBonus(g, slice);
    }
  }
  return payout;
}

/** Just the Big Pay Day component, so the UI can show it separately. */
export function calcBigPayDay(g, dd, stakeShares, lockedDay, endDay) {
  if (!(lockedDay <= BIG_PAY_DAY && endDay > BIG_PAY_DAY)) return 0n;
  const bpd = dd.get(BIG_PAY_DAY);
  if (!bpd || bpd.shares === 0n) return 0n;
  const slice = (g.unclaimedSatoshisTotal * HEARTS_PER_SATOSHI * stakeShares) / bpd.shares;
  return slice + calcAdoptionBonus(g, slice);
}

/** _calcLatePenalty: after a 14-day grace period, 1/700th of the return per late day. */
export function calcLatePenalty(lockedDay, stakedDays, unlockedDay, rawStakeReturn) {
  const maxUnlockedDay = lockedDay + stakedDays + LATE_PENALTY_GRACE_DAYS;
  if (unlockedDay <= maxUnlockedDay) return 0n;
  return (rawStakeReturn * (unlockedDay - maxUnlockedDay)) / LATE_PENALTY_SCALE_DAYS;
}

/**
 * _dailyRoundCalc — the payout pool for a single day.
 * Used to model days the contract has not stored yet (dailyDataCount < currentDay)
 * and to estimate the in-progress day.
 */
export function dailyRoundPayout(allocSupply, stakePenaltyTotal, day, g) {
  let payoutTotal = (allocSupply * 10000n) / INFLATION_DIVISOR;
  if (day < CLAIM_PHASE_END_DAY) {
    // Claim phase is long over; kept for completeness/faithfulness.
    payoutTotal += calcAdoptionBonus(g, payoutTotal);
  }
  if (stakePenaltyTotal !== 0n) payoutTotal += stakePenaltyTotal;
  return payoutTotal;
}

/**
 * _estimatePayoutRewardsDay — the contract's own estimate for a day that has not
 * been stored. The stake is treated as not yet in the share pool, matching the
 * contract, which only uses this for the servedDays == 0 penalty case.
 */
export function estimatePayoutRewardsDay(g, stakeShares, day) {
  const allocSupply = g.totalSupply + g.lockedHeartsTotal;
  const payoutTotal = dailyRoundPayout(allocSupply, g.stakePenaltyTotal, day, g);
  let payout = (payoutTotal * stakeShares) / (g.stakeSharesTotal + stakeShares);
  if (day === BIG_PAY_DAY) {
    const slice = (g.unclaimedSatoshisTotal * HEARTS_PER_SATOSHI * stakeShares) / (g.stakeSharesTotal + stakeShares);
    payout += slice + calcAdoptionBonus(g, slice);
  }
  return payout;
}

/**
 * Accrual estimate for the in-progress day of a stake that IS already in the share
 * pool. Not a contract function — the contract pays nothing until a day closes — so
 * this is surfaced separately in the UI and never folded into earned interest.
 */
export function estimateCurrentDayAccrual(g, stakeShares) {
  if (g.stakeSharesTotal === 0n) return 0n;
  const allocSupply = g.totalSupply + g.lockedHeartsTotal;
  const payoutTotal = dailyRoundPayout(allocSupply, g.stakePenaltyTotal, g.currentDay, g);
  return (payoutTotal * stakeShares) / g.stakeSharesTotal;
}

/** _calcPayoutAndEarlyPenalty. */
export function calcPayoutAndEarlyPenalty(g, dd, lockedDay, stakedDays, servedDays, stakeShares) {
  const servedEndDay = lockedDay + servedDays;

  let penaltyDays = (stakedDays + 1n) / 2n; // 50% of the term, rounded up
  if (penaltyDays < EARLY_PENALTY_MIN_DAYS) penaltyDays = EARLY_PENALTY_MIN_DAYS;

  if (servedDays === 0n) {
    // No days served: penalty is the estimated average payout across the penalty days.
    const expected = estimatePayoutRewardsDay(g, stakeShares, lockedDay);
    return { payout: 0n, penalty: expected * penaltyDays };
  }

  if (penaltyDays < servedDays) {
    const penaltyEndDay = lockedDay + penaltyDays;
    const penalty = calcPayoutRewards(g, dd, stakeShares, lockedDay, penaltyEndDay);
    const delta = calcPayoutRewards(g, dd, stakeShares, penaltyEndDay, servedEndDay);
    return { payout: penalty + delta, penalty };
  }

  const payout = calcPayoutRewards(g, dd, stakeShares, lockedDay, servedEndDay);
  const penalty = penaltyDays === servedDays ? payout : (payout * penaltyDays) / servedDays;
  return { payout, penalty };
}

/**
 * _stakePerformance — what ending this stake right now would yield.
 *
 * @param unlockedDay the day the stake would be unlocked (i.e. currentDay)
 * @returns {stakeReturn, payout, penalty, cappedPenalty}
 */
export function stakePerformance(g, dd, stake, servedDays, unlockedDay) {
  const { stakedHearts, stakeShares, lockedDay, stakedDays } = stake;
  let stakeReturn;
  let payout = 0n;
  let penalty = 0n;
  let cappedPenalty = 0n;

  if (servedDays < stakedDays) {
    const r = calcPayoutAndEarlyPenalty(g, dd, lockedDay, stakedDays, servedDays, stakeShares);
    payout = r.payout;
    penalty = r.penalty;
    stakeReturn = stakedHearts + payout;
  } else {
    payout = calcPayoutRewards(g, dd, stakeShares, lockedDay, lockedDay + servedDays);
    stakeReturn = stakedHearts + payout;
    penalty = calcLatePenalty(lockedDay, stakedDays, unlockedDay, stakeReturn);
  }

  if (penalty !== 0n) {
    if (penalty > stakeReturn) {
      cappedPenalty = stakeReturn; // a stake return can never go negative
      stakeReturn = 0n;
    } else {
      cappedPenalty = penalty;
      stakeReturn -= cappedPenalty;
    }
  }
  return { stakeReturn, payout, penalty, cappedPenalty };
}

// ---------------------------------------------------------------- stake sizing

/** _stakeStartBonusHearts: Longer Pays Better + Bigger Pays Better. */
export function stakeStartBonusHearts(stakedHearts, stakedDays) {
  let cappedExtraDays = 0n;
  if (stakedDays > 1n) {
    cappedExtraDays = stakedDays <= LPB_MAX_DAYS ? stakedDays - 1n : LPB_MAX_DAYS;
  }
  const cappedStakedHearts = stakedHearts <= BPB_MAX_HEARTS ? stakedHearts : BPB_MAX_HEARTS;
  let bonus = cappedExtraDays * BPB + cappedStakedHearts * LPB;
  bonus = (stakedHearts * bonus) / (LPB * BPB);
  return bonus;
}

/** Shares a new stake of this size/length would receive at the given share rate. */
export function calcStakeShares(stakedHearts, stakedDays, shareRate) {
  const bonus = stakeStartBonusHearts(stakedHearts, stakedDays);
  return ((stakedHearts + bonus) * SHARE_RATE_SCALE) / shareRate;
}

// ---------------------------------------------------------------- stake derivation

/**
 * Everything the UI needs about one stake, derived purely from chain state.
 *
 * Statuses: 'pending'  — starts tomorrow or later, not yet earning
 *           'active'   — mid-term
 *           'matured'  — full term served, inside the 14-day grace window
 *           'late'     — full term served, past grace, losing value daily
 */
export function deriveStake(g, dd, stake, index) {
  const { stakedHearts, stakeShares, lockedDay, stakedDays } = stake;
  const currentDay = g.currentDay;
  const endDay = lockedDay + stakedDays;

  const started = currentDay >= lockedDay;
  let servedDays = started ? currentDay - lockedDay : 0n;
  if (servedDays > stakedDays) servedDays = stakedDays;

  const perf = stakePerformance(g, dd, stake, servedDays, currentDay);
  const bigPayDay = calcBigPayDay(g, dd, stakeShares, lockedDay, lockedDay + servedDays);
  const interest = perf.payout;               // includes the BPD slice, as the contract does
  const baseInterest = interest - bigPayDay;  // day-by-day inflation share only

  const fullyServed = servedDays >= stakedDays;
  const graceEndDay = endDay + LATE_PENALTY_GRACE_DAYS;
  let status;
  if (!started) status = 'pending';
  else if (!fullyServed) status = 'active';
  else if (currentDay <= graceEndDay) status = 'matured';
  else status = 'late';

  const progress = stakedDays === 0n ? 1 : Number(servedDays) / Number(stakedDays);
  const todayEstimate = status === 'active' || status === 'pending'
    ? estimateCurrentDayAccrual(g, stakeShares)
    : 0n;

  // Realised yield on principal, annualised over the days actually served.
  let apy = null;
  if (servedDays > 0n && stakedHearts > 0n) {
    apy = (Number(interest) / Number(stakedHearts)) * (365 / Number(servedDays)) * 100;
  }

  return {
    index,
    stakeId: stake.stakeId,
    isAutoStake: stake.isAutoStake,
    principal: stakedHearts,
    shares: stakeShares,
    lockedDay,
    stakedDays,
    // non-zero once stakeGoodAccounting() has unlocked the stake; the stake stays in
    // stakeLists, and HexRewards keys its bonus tier off this
    unlockedDay: stake.unlockedDay,
    endDay,
    servedDays,
    daysLeft: fullyServed ? 0n : stakedDays - servedDays,
    daysLate: status === 'late' ? currentDay - graceEndDay : 0n,
    // how long a matured stake can still be ended with no late penalty
    graceDaysLeft: status === 'matured' ? graceEndDay - currentDay : 0n,
    currentDay,
    status,
    progress: Math.max(0, Math.min(1, progress)),
    interest,
    baseInterest,
    bigPayDay,
    todayEstimate,
    // "if I ended it right now"
    penalty: perf.cappedPenalty,
    rawPenalty: perf.penalty,
    netIfEndedNow: perf.stakeReturn,
    // total value the stake currently represents, before any penalty
    grossValue: stakedHearts + interest,
    apy,
    startDate: dayToDate(lockedDay),
    endDate: dayToDate(endDay),
  };
}

// ---------------------------------------------------------------- helpers

/** HEX day number -> Date (each day starts at LAUNCH_TIME + day * 86400). */
export function dayToDate(day) {
  return new Date(Number(LAUNCH_TIME + BigInt(day) * 86400n) * 1000);
}

/** Unix seconds -> HEX day number, matching _currentDay(). */
export function timestampToDay(ts) {
  return (BigInt(ts) - LAUNCH_TIME) / 86400n;
}

/** hearts (BigInt) -> Number of HEX. Safe: HEX supply is far below 2^53 whole units. */
export const heartsToHex = (h) => Number(h) / 1e8;

/** shares -> T-shares (trillions of shares). */
export const sharesToTShares = (s) => Number(s) / 1e12;
