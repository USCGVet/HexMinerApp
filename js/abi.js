/**
 * Minimal ABI codec — no external dependencies.
 *
 * Function selectors are hardcoded rather than derived, because keccak256 is not
 * available natively in the browser and pulling in a hashing library to hash
 * eleven constant strings would be the only reason to have a dependency at all.
 * Every selector below was generated from its signature and is listed with it.
 */

export const SEL = {
  // HEX
  balanceOf:       '0x70a08231', // balanceOf(address)
  stakeCount:      '0x33060d90', // stakeCount(address)
  stakeLists:      '0x2607443b', // stakeLists(address,uint256)
  currentDay:      '0x5c9302c9', // currentDay()
  globalInfo:      '0xf04b5fa0', // globalInfo()
  dailyDataRange:  '0x6a210a0e', // dailyDataRange(uint256,uint256)
  dailyData:       '0x90de6871', // dailyData(uint256)
  totalSupply:     '0x18160ddd', // totalSupply()
  allocatedSupply: '0x3a70a5ca', // allocatedSupply()
  // ERC20
  decimals:        '0x313ce567', // decimals()
  symbol:          '0x95d89b41', // symbol()
  // Uniswap-V2-style pair
  getReserves:     '0x0902f1ac', // getReserves()
  token0:          '0x0dfe1681', // token0()
  token1:          '0xd21220a7', // token1()
  // Multicall3
  aggregate3:      '0x82ad56cb', // aggregate3((address,bool,bytes)[])
};

const strip = (h) => (h.startsWith('0x') || h.startsWith('0X') ? h.slice(2) : h).toLowerCase();

/** BigInt/number -> 64 hex chars (one ABI word), no 0x prefix. */
export function padWord(v) {
  const n = BigInt(v);
  if (n < 0n) throw new Error('padWord: negative');
  const h = n.toString(16);
  if (h.length > 64) throw new Error('padWord: overflow');
  return h.padStart(64, '0');
}

/** '0xabc…' address -> one left-padded ABI word. */
export function encAddress(a) {
  const h = strip(a);
  if (h.length !== 40) throw new Error(`encAddress: bad address ${a}`);
  return h.padStart(64, '0');
}

/** Read the 32-byte word at a byte offset as a BigInt. */
function wordAt(h, byteOff) {
  const s = h.slice(byteOff * 2, byteOff * 2 + 64);
  if (s.length < 64) throw new Error('wordAt: out of range');
  return BigInt('0x' + s);
}

const addressFromWord = (v) => '0x' + v.toString(16).padStart(40, '0').slice(-40);

// ---------------------------------------------------------------- encoders

export const callNoArgs = (sel) => sel;
export const callAddress = (sel, a) => sel + encAddress(a);
export const callUint = (sel, v) => sel + padWord(v);
export const callAddressUint = (sel, a, v) => sel + encAddress(a) + padWord(v);
export const callUintUint = (sel, a, b) => sel + padWord(a) + padWord(b);

/**
 * Encode Multicall3 aggregate3((address target, bool allowFailure, bytes callData)[]).
 * The tuple is dynamic (it contains bytes), so the array holds element offsets
 * relative to the start of the element region.
 */
export function encodeAggregate3(calls) {
  const elems = calls.map((c) => {
    const d = strip(c.callData);
    if (d.length % 2) throw new Error('encodeAggregate3: odd-length callData');
    const len = d.length / 2;
    const padLen = (32 - (len % 32)) % 32;
    const body = d + '0'.repeat(padLen * 2);
    // address, bool, offset-to-bytes (always 0x60: three head words), length, data
    return encAddress(c.target) + padWord(c.allowFailure ? 1 : 0) + padWord(0x60) + padWord(len) + body;
  });

  let cursor = elems.length * 32; // element offsets start after the offset words
  const offsets = elems.map((e) => {
    const at = cursor;
    cursor += e.length / 2;
    return padWord(at);
  });

  return SEL.aggregate3 + padWord(0x20) + padWord(elems.length) + offsets.join('') + elems.join('');
}

// ---------------------------------------------------------------- decoders

/** Decode aggregate3's (bool success, bytes returnData)[] return. */
export function decodeAggregate3(raw) {
  const h = strip(raw);
  if (!h) throw new Error('decodeAggregate3: empty response');
  const arrOff = Number(wordAt(h, 0));
  const n = Number(wordAt(h, arrOff));
  const base = arrOff + 32;
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = base + Number(wordAt(h, base + i * 32));
    const success = wordAt(h, el) !== 0n;
    const bOff = el + Number(wordAt(h, el + 32));
    const bLen = Number(wordAt(h, bOff));
    out.push({ success, data: '0x' + h.slice((bOff + 32) * 2, (bOff + 32 + bLen) * 2) });
  }
  return out;
}

/** Decode a dynamic uint256[] (e.g. dailyDataRange). */
export function decodeUintArray(raw) {
  const h = strip(raw);
  if (!h) return [];
  const off = Number(wordAt(h, 0));
  const n = Number(wordAt(h, off));
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = wordAt(h, off + 32 + i * 32);
  return out;
}

/** Decode a fixed-size tuple/array of n words (e.g. globalInfo -> uint256[13]). */
export function decodeWords(raw, n) {
  const h = strip(raw);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = wordAt(h, i * 32);
  return out;
}

export const decodeUint = (raw) => wordAt(strip(raw), 0);
export const decodeAddress = (raw) => addressFromWord(wordAt(strip(raw), 0));

/** Decode a dynamic string return (symbol()). Tolerates bytes32-style returns. */
export function decodeString(raw) {
  const h = strip(raw);
  if (!h) return '';
  try {
    const off = Number(wordAt(h, 0));
    const len = Number(wordAt(h, off));
    const bytes = h.slice((off + 32) * 2, (off + 32 + len) * 2);
    return hexToUtf8(bytes);
  } catch {
    return hexToUtf8(h).replace(/\0+$/, '');
  }
}

function hexToUtf8(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return new TextDecoder().decode(bytes).replace(/\0+$/, '');
}

/** Decode HEX stakeLists(address,uint256) -> StakeStore. */
export function decodeStake(raw) {
  const w = decodeWords(raw, 7);
  return {
    stakeId: w[0],
    stakedHearts: w[1],
    stakeShares: w[2],
    lockedDay: w[3],
    stakedDays: w[4],
    unlockedDay: w[5],
    isAutoStake: w[6] !== 0n,
  };
}

/** Decode Uniswap-V2 getReserves() -> {reserve0, reserve1, blockTimestampLast}. */
export function decodeReserves(raw) {
  const w = decodeWords(raw, 3);
  return { reserve0: w[0], reserve1: w[1], blockTimestampLast: w[2] };
}
