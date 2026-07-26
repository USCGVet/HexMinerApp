# HEX Miner

A read-only dashboard for HEX stakes on **Ethereum** and **PulseChain**, showing what every
stake has actually earned and what ending it today would pay — computed with the HEX
contract's own arithmetic rather than approximated.

No build step, no framework, no CDN, no runtime dependencies. Open `index.html` and it runs.

---

## Why the numbers here are exact

The interest a HEX stake has earned is not a rate you can multiply out. It is the sum, day by
day, of that stake's share of each day's payout, using truncating integer division at every
step, plus a one-off Big Pay Day slice for stakes open across day 352:

```
payout = Σ  dayPayoutTotal[d] × stakeShares / dayStakeSharesTotal[d]      for d in [lockedDay, endDay)

if lockedDay ≤ 352 < endDay:
    slice   = unclaimedSatoshisTotal × HEARTS_PER_SATOSHI × stakeShares / dayStakeSharesTotal[352]
    payout += slice + adoptionBonus(slice)
```

Every constant is taken from the deployed source
(`0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39`, solc 0.5.13 — identical bytecode on both
chains), and all arithmetic is `BigInt`, so results match the contract to the heart.

`js/hexmath.js` is a direct transcription of `_calcPayoutRewards`, `_stakePerformance`,
`_calcPayoutAndEarlyPenalty`, `_calcLatePenalty`, `_stakeStartBonusHearts` and
`_dailyRoundCalc`.

### Verification

The implementation was checked against **2,734 real historical `StakeEnd` events** pulled from
Ethereum. `dailyData` is append-only in the contract and the claim-phase globals froze on day
351, so today's chain state reproduces any post-Big-Pay-Day stake end exactly. Result:

| Code path | Stakes checked | Mismatches |
|---|---|---|
| pre-BPD, matured | 1394 | 0 |
| pre-BPD, matured + late penalty | 716 | 0 |
| pre-BPD, ended early | 142 | 0 |
| post-BPD, matured | 349 | 0 |
| post-BPD, matured + late penalty | 89 | 0 |
| post-BPD, ended early | 44 | 0 |

Payout **and** penalty **and** served-days matched exactly in all 2,734 cases. A further five
live stakes were cross-checked by simulating `stakeEnd()` through `debug_traceCall` and reading
the payout straight out of the emitted event — also exact.

Big Pay Day works out to **≈3,641.66 HEX per T-share**, matching the long-published figure.

---

## What it shows

**Portfolio** — combined value across both chains, liquid balance, staked principal, interest
earned, and total T-shares.

Anything that needs your attention lives behind the **bell** in the header rather than in
banners across the top: stakes that have finished their term (penalty-free for 14 days), stakes
past that grace period losing 1/700th of their return per day, unminted HXR/Savant, and stakes
blocked by the HexRewards index bug. The bell takes the colour of the most severe notice — red
for a warning, green for something ready, cyan for information — so urgency is still visible at
a glance without a wall of text. Click, click-away, or Escape to dismiss.

**Per stake** — principal, interest, Big Pay Day slice where it applies, T-shares, term,
progress, start/end dates, realised yield, and *if ended today*: the exact net return and the
exact penalty the contract would take.

**Charts** — payout per T-share per day, cumulative HEX per T-share, total T-shares staked,
and the daily payout pool. All from `dailyData`, so no price API or indexer is involved.

---

## Secondary PulseChain DApps

Four more contracts are integrated, all **PulseChain-only** — Ethereum stakes cannot mint them:

| | Address | Role |
|---|---|---|
| **HexRewards** (HXR) | `0xCfCb89f0…7d9B` | mints against your HEX stakes |
| **Savant** | `0xf16e17e4…1809` | same, with the HexRewards bug fixed |
| **JDAI** | `0x1610E75C…bB72` | gold-pegged unstablecoin (MakerDAO fork) — own tab |
| **Taker** (TKR) | `0xd9e59020…dB7B` | JDAI governance, fixed supply of 1,000,000 |

### The ordering that matters

Both HXR and Savant mint by reading `stakeLists` on the HEX contract. `stakeEnd()` **removes**
a stake from that list, so ending a stake before minting destroys the mint permanently. The
dashboard raises a loud alert whenever a finished stake still has an unminted reward, and shows
per-stake exactly what each contract would mint now versus at full term.

The full-term bonus is worth a lot — a 5555-day stake mints 0.2777 HXR at half term but
**5.555 HXR** at full term, a 20× difference. The two contracts reach it differently:

- **Savant** needs only `consumedDays == stakedDays`. Let the term finish, then claim.
- **HexRewards** additionally requires `unlockedDay != 0`, which means calling HEX's
  `stakeGoodAccounting()` first. That keeps the stake in `stakeLists` (unlike `stakeEnd`) and,
  on a late stake, freezes the late-end penalty. Skip it and you get 1/10th of the reward.

### The HexRewards index bug

`HexRewards` records claims as `claimed[user][stakeIndex]`; `Savant` fixed this to
`claimed[user][stakeId]`. HEX removes stakes with swap-and-pop, so indexes are **not stable** —
ending a stake moves your last stake into the freed index, landing it on an already-consumed
claim slot. That stake can then never mint HXR.

The dashboard detects this and proves it rather than guessing: `rewardNow` is monotonically
non-decreasing for a given stake, so a recorded claim *larger* than what the stake at that index
could currently mint cannot have come from that stake. Those stakes are flagged **index taken**,
excluded from "mintable", and the affected Savant claims are shown as still available.

*(On one live wallet checked during development, 3 of 37 stakes were provably in this state.)*

### Tier capacity

Stakes with `stakeId` past each contract's `STAKEID_PROTECTION` (HXR 817340, Savant 819820) must
first register via `claimStake()` into one of 9 size tiers, each capped at 369 stakes.
`tierStakesCount` only ever increments, so a full tier is permanently closed. As of writing,
**HexRewards tier 0 (1k–10k HEX) is full at 369/369** and Savant tier 0 has 46 slots left — the
dashboard shows remaining capacity per tier and marks affected stakes rather than promising a
reward that cannot be claimed.

Reward and tier arithmetic was verified against both deployed contracts' own `calculateReward()`
and `determineTier()` — 160 reward combinations and every tier boundary, all exact.

### Supply is the point

HXR and Savant are intentionally scarce — closer to trading cards than to a liquidity play. Every
token in existence was minted by someone staking HEX, one claim per stake, with tiers capped at
369 stakes each. The cards lead with **in existence** rather than market cap, show tier capacity,
and report pool size as a plain figure with no editorialising. Taker is flagged **fixed supply**:
1,000,000 exist and the contract has no mint function.

Token values are kept in their own panel rather than folded into the headline HEX total — not as a
warning, just so the HEX number stays a HEX number.

### JDAI

JDAI has its own tab: what it is, live price, peg target, premium, implied gold price, and links
into the DApp. Deliberately light — vault management belongs in the JDAI DApp, and this page
exists so HEX stakers discover that JDAI and Taker exist.

`par` is JDAI's target price and tracks 1/1000 oz of gold (currently ≈ $4.08, implying
≈ $4,084/oz). If a tracked address happens to have a vault, one compact summary is shown. Vault
health uses the **oracle** price recovered from Spotter's `spot` (`price = spot × mat × par`)
rather than the DEX price, and the safe flag is the Vat's own integer test
`art × rate ≤ ink × spot`, so it agrees with the protocol exactly.

---

## Pricing

pHEX and eHEX are separate markets and trade at different prices, so each chain is priced from
its own pool, and token ordering and decimals are read from the pair at runtime rather than
assumed:

| Chain | HEX pair | USD reference |
|---|---|---|
| Ethereum | Uniswap V2 `HEX/WETH` `0x55D5…4DBa` | Uniswap V2 `WETH/USDC` `0xB4e1…C9Dc` |
| PulseChain | PulseX V1 `HEX/WPLS` `0xf1F4…dc65` | PulseX V1 `WPLS/DAI` `0xE560…E0aE` |

These are the deepest available pools. DexScreener is used only to add 24h change and volume,
and the app works fine without it.

---

## Performance

All reads for a chain go through Multicall3 pinned to a single block, so every figure comes
from the same instant and cannot disagree mid-load. `dailyData` is append-only, so ~2,400 days
are cached in `localStorage` and only newly closed days are fetched.

A wallet with 40+ stakes loads in well under a second; a warm reload is roughly twice as fast
again. (For comparison, the previous version issued about `5 + 5n` sequential HTTP requests for
`n` stakes.)

Endpoints fail over automatically, and the one that works is remembered so a blocked endpoint
is not retried on every load.

---

## Configuration

Everything lives in **Settings** and is stored only in your browser:

- **Addresses** — track as many as you like; they combine into one portfolio. Watch-only is
  fine. "Connect wallet" only reads the address, and the app never requests a signature.
- **Chains** — enable Ethereum, PulseChain, or both.
- **RPC override** — optional per chain, tried first with the built-ins as fallback.

### Why public endpoints only

Earlier versions routed Ethereum through a personal Azure Functions proxy. It does still work,
but it was benchmarked against the public endpoints on this app's heaviest call
(`dailyDataRange` over 500 days, 8 rounds each) and came out worst on both axes:

| Endpoint | Success | avg | p90 |
|---|---|---|---|
| `eth.blockrazor.xyz` | 8/8 | 65 ms | 112 ms |
| `eth-mainnet.public.blastapi.io` | 8/8 | 68 ms | 143 ms |
| `eth.drpc.org` | 8/8 | 93 ms | 151 ms |
| `virginia.rpc.blxrbdn.com` | 8/8 | 58 ms | 158 ms |
| `ethereum-rpc.publicnode.com` | 8/8 | 91 ms | 243 ms |
| *(Azure proxy)* | **7/8** | 185 ms | **795 ms** |

It was the only endpoint to fail a round — intermittently returning a non-JSON *"Unable to…"*
body, most likely App Service throttling or a cold instance. It also carried a CORS allowlist,
so it worked from `uscgvet.github.io` but was rejected from `localhost` during development.

Removing it means one less thing to host, pay for, and keep whitelisted. Nothing in the app
references it any more, so the Azure resource can be decommissioned. If you ever want it back,
paste it into the RPC override in Settings — that is tried first, with these as fallback.

PulseChain endpoints are ordered the same way: `pulsechain-rpc.publicnode.com` (98 ms avg),
`rpc-pulsechain.g4mm4.io` (best p90 at 225 ms), then the official `rpc.pulsechain.com`.

---

## Layout

```
index.html        portfolio dashboard (HEX + stake-minted tokens)
chart.html        protocol charts
jdai.html         JDAI + Taker
settings.html     addresses, chains, RPCs
styles.css        dark "blue laser" theme
js/
  hexmath.js      contract arithmetic (the part that must be exact)
  tokens.js       HexRewards / Savant / JDAI / Taker — mint math and vault math
  hexdata.js      snapshot loading + dailyData cache
  rpc.js          JSON-RPC failover + Multicall3 batching
  abi.js          minimal ABI codec, hardcoded selectors
  config.js       chains, addresses, settings store
  charts.js       SVG line charts with hover
  format.js       display formatting
  app.js / chart-page.js / jdai-page.js / settings-page.js
```

---

## Scope

Deliberately **read-only**. It computes exactly what `stakeEnd()` would return, but never asks
you to sign anything and holds no keys.
