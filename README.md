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

| Code path | Ethereum | PulseChain | Mismatches |
|---|---|---|---|
| pre-BPD, matured | 1394 | 1256 | 0 |
| pre-BPD, matured + late penalty | 716 | 696 | 0 |
| pre-BPD, ended early | 142 | 108 | 0 |
| post-BPD, matured | 349 | 311 | 0 |
| post-BPD, matured + late penalty | 89 | 65 | 0 |
| post-BPD, ended early | 44 | 48 | 0 |
| **total** | **2734** | **2484** | **0** |

Payout **and** penalty **and** served-days matched exactly in all **5,218** cases across both
chains. A further five live stakes were cross-checked by simulating `stakeEnd()` through
`debug_traceCall` and reading the payout straight out of the emitted event — also exact.

Big Pay Day works out to **≈3,641.66 HEX per T-share**, matching the long-published figure.

---

## What it shows

**Portfolio** — combined value across both chains, liquid balance, staked principal, interest
earned, and total T-shares.

Anything that needs your attention lives behind the **bell** in the header rather than in
banners across the top: stakes that have finished their term (penalty-free for 14 days), stakes
past that grace period losing 1/700th of their return per day, stakes already settled by
`stakeGoodAccounting()`, unminted HXR/Savant, and stakes blocked by the HexRewards index bug.
The bell takes the colour of the most severe notice — red for a warning, green for something
ready, cyan for information — so urgency is still visible at a glance without a wall of text.
Click, click-away, or Escape to dismiss.

**Per stake** — principal, interest, Big Pay Day slice where it applies, T-shares, term,
progress, start/end dates, realised yield, and *if ended today*: the exact net return and the
exact penalty the contract would take.

A stake with a non-zero `unlockedDay` has already had `stakeGoodAccounting()` called on it and
is shown as **good accounting** rather than as late. That call settles the stake — shares leave
the pool, the payout stops growing, and the late-end penalty is fixed at the day it ran — so the
penalty is measured against the stored `unlockedDay`, exactly as `_stakeEnd()`'s `prevUnlocked`
branch does. Measuring against today instead shows a penalty the contract will never charge.

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

### Hedron and Communis

Two stake-minting contracts this project did not author. Unlike HexRewards and Savant they live
on **both** chains, at the same addresses — deployed before the fork, so the bytecode is
identical either side (checked by codehash) while the supplies have diverged since.

| | address (both chains) | decimals |
|---|---|---|
| Hedron | `0x3819f64f282bf135d62168C1e513280dAF905e06` | 9 |
| Communis | `0x5A9780Bfe63f3ec57f01b087cD65BD656C9034A8` | 12 |
| HSI Manager | `0x8BD3d1472A656e312E94fB1BbdD599B8C51D18e3` | — |

**Hedron** is not a one-shot claim. It pays `stakeShares × days served since the last mint`, so
the mintable amount grows every day and is never used up — nothing is lost by waiting, only by
ending the stake. Two bonuses compound on top, each `payout × multiplier / 10`: a launch-phase
bonus fixed on the share at first mint, and a loan-to-mint multiplier that has been zero on
every Hedron day so far on both chains. Mint records are keyed by stake ID, so the index
collision that afflicts HexRewards cannot happen here.

**Communis** pays three separate bonuses, all keyed by stake ID:

- **start bonus** — available from the stake's start day, but scaled by the stake's original
  share rate over the current global share rate. HEX's share rate only rises, so this shrinks
  every day you wait.
- **end bonus** — the largest of the three, and the only hard deadline in this app: it opens
  when the term ends and is **gone 37 days later**, permanently, for everyone.
- **good accounting bonus** — 1% of the stake's max payout, paid to *whoever* calls it once
  that 37-day window has passed and the stake is still locked. Anyone can take it, and doing so
  runs HEX `stakeGoodAccounting()` on the stake as a side effect. The app flags your own stakes
  that are exposed to this.

The start and end bonuses **share one ceiling and do not add up**: `_mintEndBonus` pays
`maxPayout − stakeIdStartBonusPayout`, so minting the start bonus first reduces the end bonus
one for one, and the pair together can never exceed `maxPayout`. Totals count the larger of
the two that is actually reachable, never their sum.

Communis also lets COM be staked back into itself against the debt an end-bonus mint creates;
staked amount, debt cover and the 91-day payout schedule are all shown.

### HSI stakes

Hedron also mints against **HSI** stakes — HEX stakes wrapped in their own contract and held by
the HSI Manager. These are real HEX stakes that never appear in a wallet's own `stakeLists`, so
before this they were invisible here. Both kinds are now loaded and folded into the portfolio:
detokenized ones from the manager's list, and tokenized ones through its ERC-721 enumeration.

A **tokenized** HSI cannot be minted against at all until it is detokenized: `mintInstanced`
resolves the HSI through the manager's `hsiLists`, and `hexStakeTokenize` prunes it out of that
list, so the call would revert. Its accrual is shown on the card and labelled, but it is not
counted as mintable — the same treatment a loaned stake gets.

Two of Communis's three bonuses are out of reach for an HSI, but **not all three**.
`_mintStartBonus` and `_mintEndBonus` read `HEX.stakeLists(msg.sender, …)`, and an HSI's stake
belongs to the HSI contract, so neither can ever be minted against one.
`mintGoodAccountingBonus(address stakeOwner, …)` takes the owner as a *parameter*, so it does
reach an HSI — meaning a stranger can take 1% of its max payout and force `stakeGoodAccounting()`
on it once it is 38+ days past its end day. The app reads those records and warns about it.

### Verifying the two of them

Communis exposes `getPayout` and `getStartBonusPayout` as `pure`, so the transcription was
checked against the deployed contract itself over 312 realistic stakes — share rates 100k–421k,
principals from 1,000 HEX to 500M, terms 180–5,555 days, covering all three bonus-percentage
branches and both the same-day and share-rate-penalised cases. **1,992 values compared, zero
mismatches.**

Hedron has no equivalent view, so the reference is its own history: **105 real Mint events
across 30 stakes, zero mismatches**, covering first mints, incremental mints, and launch bonuses
of 0, 90 and 100. The loan-to-mint multiplier could not be exercised because it has never fired —
scanning all 1,625 Hedron days on both chains found it zero everywhere, with loaned supply at
0.00008% of minted against a 50% threshold. It is implemented faithfully regardless.

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
and report pool size and time since the last trade next to every price — all four pools are thin
enough that the quote needs that context to be read honestly ([Thin pools](#thin-pools)). Taker is
flagged **fixed supply**: 1,000,000 exist and the contract has no mint function.

Token values are kept in their own panel rather than folded into the headline HEX total — not as a
warning, just so the HEX number stays a HEX number.

### JDAI

JDAI has its own tab: what it is, the peg target, implied gold price, the pool quote, and links
into the DApp. Deliberately light — vault management belongs in the JDAI DApp, and this page
exists so HEX stakers discover that JDAI and Taker exist.

The peg target leads, not the DEX quote, because only 19.69 JDAI exist and the single PulseX
`JDAI/WPLS` pool holds about $10 — see [Thin pools](#thin-pools).

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

### Thin pools

The four secondary tokens are a different situation. Each has exactly one pool — the PulseX V2
pair against WPLS, confirmed against both factories — and every one of them is dust:

| Token | Pool | Depth | Quote |
|---|---|---|---|
| HXR | `0xD5A8…F612` | ~$43 | ~$14.71 |
| SAVANT | `0xaAA8…0742` | ~$22 | ~$16.42 |
| JDAI | `0x7065…350f` | ~$10 | ~$5.13 |
| TKR | `0x205C…F0f0` | ~$39 | ~$0.158 |

Constant-product math on those reserves is arithmetically right and economically meaningless: a
$100 buy in the JDAI pool moves the price roughly 400×. So a quote is never shown on its own. The
pair's reserves and its `blockTimestampLast` come back with every price read, and any pool under
$1,000 of liquidity or three days without a trade is flagged **thin market** — its price is
de-emphasised, and derived claims that would read as market signal are withheld rather than
computed. On the JDAI page that means no premium-to-peg figure while the pool is this thin; a
+26% "premium" out of a $10 pool is noise, not information.

DexScreener does not index pools this small, so it cannot serve as a second opinion here — depth
is read from the pair itself.

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

### Opening an address from the URL

Any address can be viewed straight from a link, with nothing saved:

```
https://…/0x81605CA8235f53C15DA90b769b67fB62339C5f5a
https://…/index.html?a=0x81605CA8235f53C15DA90b769b67fB62339C5f5a
https://…/index.html#0x81605CA8235f53C15DA90b769b67fB62339C5f5a
```

Several addresses can be listed at once, comma-separated, up to ten — they combine into one
portfolio exactly as saved addresses do. A banner names whoever is being viewed, with one
button to adopt the address into your own list and one to go back to your portfolio.

A link **never** writes to your saved addresses: sharing a stake should not quietly replace
what the recipient is tracking, so the URL applies to that page load only and adopting it is
an explicit click. The address also rides along the Portfolio / Charts / JDAI nav links, but
not to Settings, which edits the saved list a view link has nothing to do with.

The bare `/0x…` form needs `404.html`. GitHub Pages has no rewrite rules, so a path with no
file behind it falls back to that page, which recognises the address and forwards it to
`index.html?a=…`. It is the only reason the file exists.

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
404.html          turns /0x… into index.html?a=0x… (GitHub Pages has no rewrites)
styles.css        dark "blue laser" theme
js/
  hexmath.js      contract arithmetic (the part that must be exact)
  tokens.js       HexRewards / Savant / JDAI / Taker — mint math and vault math
  hexdata.js      snapshot loading + dailyData cache
  rpc.js          JSON-RPC failover + Multicall3 batching
  abi.js          minimal ABI codec, hardcoded selectors
  config.js       chains, addresses, settings store
  sidestakes.js   Hedron / Communis mint math, HSI stakes — both chains
  urlview.js      address-in-the-URL parsing, banner and nav propagation
  charts.js       SVG line charts with hover
  format.js       display formatting
  version.js      version string, stamped into every footer at runtime
  app.js / chart-page.js / jdai-page.js / settings-page.js / tokencard.js
```

There is no build step — the files are served as written. `js/version.js` holds the version
in one place and appends it to each footer, so a deploy is visible on the page itself. Bump
`APP_VERSION` and `BUILD_DATE` there in the same commit that ships a change.

---

## Scope

Deliberately **read-only**. It computes exactly what `stakeEnd()` would return, but never asks
you to sign anything and holds no keys.
