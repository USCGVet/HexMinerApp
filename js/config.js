/**
 * Chain configuration.
 *
 * HEX lives at the same address on both chains: PulseChain forked Ethereum's state,
 * so the contract bytecode, LAUNCH_TIME and all pre-fork stakes are identical. The
 * two tokens have diverged in price though — pHEX and eHEX trade independently — so
 * each chain is priced from its own DEX pair.
 *
 * Every address below was verified live against the chain (token ordering, decimals
 * and pool depth) rather than assumed.
 */

export const HEX_ADDRESS = '0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';

export const CHAINS = {
  1: {
    id: 1,
    key: 'eth',
    name: 'Ethereum',
    short: 'ETH',
    hexSymbol: 'eHEX',
    nativeSymbol: 'ETH',
    accent: '#7c9dff',
    explorer: 'https://etherscan.io',
    dexscreener: 'ethereum',
    rpcs: [
      'https://uscgvetpassthru.azurewebsites.net/api/infura/proxy/',
      'https://ethereum-rpc.publicnode.com',
      'https://eth.drpc.org',
      'https://rpc.mevblocker.io',
    ],
    // Uniswap V2 HEX/WETH — the deepest eHEX market (~$290k total liquidity).
    hexPair: {
      address: '0x55D5c232D921B9eAA6b37b5845E439aCD04b4DBa',
      quote: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      quoteSymbol: 'WETH',
      quoteIsUsd: false,
    },
    // Uniswap V2 WETH/USDC — ~$8.9M deep, used to price the quote token in USD.
    nativeUsdPair: {
      address: '0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc',
      base: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2', // WETH
      quote: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // USDC
      quoteSymbol: 'USDC',
    },
  },

  369: {
    id: 369,
    key: 'pls',
    name: 'PulseChain',
    short: 'PLS',
    hexSymbol: 'pHEX',
    nativeSymbol: 'PLS',
    accent: '#22d3ee',
    explorer: 'https://scan.pulsechain.com',
    dexscreener: 'pulsechain',
    rpcs: [
      'https://rpc.pulsechain.com',
      'https://rpc-pulsechain.g4mm4.io',
      'https://pulsechain-rpc.publicnode.com',
    ],
    // PulseX V1 HEX/WPLS — the deepest pHEX market (~$410k total liquidity).
    hexPair: {
      address: '0xf1F4ee610b2bAbB05C635F726eF8B0C568c8dc65',
      quote: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27', // WPLS
      quoteSymbol: 'WPLS',
      quoteIsUsd: false,
    },
    // PulseX V1 WPLS/DAI — ~$390k deep, the most liquid PLS/stable market.
    nativeUsdPair: {
      address: '0xE56043671df55dE5CDf8459710433C10324DE0aE',
      base: '0xA1077a294dDE1B09bB078844df40758a5D0f9a27', // WPLS
      quote: '0xefD766cCb38EaF1dfd701853BFCe31359239F305', // DAI from Ethereum
      quoteSymbol: 'DAI',
    },
  },
};

export const CHAIN_IDS = [1, 369];

// ---------------------------------------------------------------- settings store

const KEY = 'hexminer.settings.v2';

const DEFAULTS = {
  addresses: [],          // [{ address, label }]
  enabledChains: [1, 369],
  customRpcs: {},         // { [chainId]: url }
  refreshSeconds: 0,      // 0 = manual only
};

export function loadSettings() {
  let s;
  try {
    s = JSON.parse(localStorage.getItem(KEY) || 'null');
  } catch {
    s = null;
  }
  if (!s) s = migrateLegacy();
  const merged = { ...DEFAULTS, ...(s || {}) };
  merged.addresses = (merged.addresses || []).filter((a) => isAddress(a.address));
  merged.enabledChains = (merged.enabledChains || []).filter((c) => CHAINS[c]);
  if (!merged.enabledChains.length) merged.enabledChains = [...DEFAULTS.enabledChains];
  return merged;
}

export function saveSettings(s) {
  localStorage.setItem(KEY, JSON.stringify(s));
}

/** Carry over the single address / RPC choice the previous version stored. */
function migrateLegacy() {
  const old = localStorage.getItem('ethAddress');
  if (!old || !isAddress(old)) return null;
  const oldRpc = localStorage.getItem('rpcSelection') || '';
  const chain = oldRpc.includes('pulsechain') ? 369 : 1;
  return {
    addresses: [{ address: normalize(old), label: '' }],
    // keep showing the chain they had selected first, but enable both
    enabledChains: chain === 369 ? [369, 1] : [1, 369],
  };
}

export const isAddress = (a) => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a.trim());
export const normalize = (a) => a.trim().toLowerCase();

export function rpcsFor(chainId, settings) {
  const chain = CHAINS[chainId];
  const custom = settings?.customRpcs?.[chainId];
  const list = [...chain.rpcs];
  if (custom && /^https?:\/\//i.test(custom)) list.unshift(custom.trim());
  return list;
}
