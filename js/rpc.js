/**
 * JSON-RPC client with endpoint failover and Multicall3 batching.
 *
 * The previous version issued one HTTP request per contract read, sequentially, inside
 * a per-stake loop — roughly 5 + 5n round trips for n stakes. Everything here is
 * batched through Multicall3 and pinned to a single block, so a wallet with 30 stakes
 * loads in a handful of requests and every number comes from the same instant.
 */

import { encodeAggregate3, decodeAggregate3, SEL, padWord } from './abi.js';
import { MULTICALL3 } from './config.js';

const DEFAULT_TIMEOUT = 20000;

export class RpcError extends Error {}

export class Rpc {
  /**
   * @param {string[]} urls tried in order; the first that works is remembered.
   * @param opts.stickyKey persist the winning endpoint under this key, so an endpoint
   *        that is unreachable from this origin (a CORS allowlist, a firewall) is not
   *        retried on every single load.
   */
  constructor(urls, { timeout = DEFAULT_TIMEOUT, stickyKey = null } = {}) {
    if (!urls || !urls.length) throw new RpcError('no RPC endpoints configured');
    this.urls = [...urls];
    this.timeout = timeout;
    this.stickyKey = stickyKey;
    this.activeUrl = null;
    this.failures = [];

    if (stickyKey) {
      try {
        const remembered = localStorage.getItem(`hexminer.rpc.${stickyKey}`);
        // Only honour it if it is still one of the configured endpoints.
        if (remembered && this.urls.includes(remembered)) {
          this.urls = [remembered, ...this.urls.filter((u) => u !== remembered)];
        }
      } catch {
        /* storage unavailable; order stays as configured */
      }
    }
  }

  #remember(url) {
    if (!this.stickyKey) return;
    try {
      localStorage.setItem(`hexminer.rpc.${this.stickyKey}`, url);
    } catch {
      /* non-fatal */
    }
  }

  async #post(url, payload) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeout);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) throw new RpcError(`HTTP ${res.status}`);
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        throw new RpcError('non-JSON response');
      }
      return json;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Send a payload, moving down the endpoint list on failure. */
  async #send(payload) {
    const ordered = this.activeUrl
      ? [this.activeUrl, ...this.urls.filter((u) => u !== this.activeUrl)]
      : this.urls;

    let lastErr;
    // Two passes: public endpoints throttle bursts, so if every one of them refuses on the
    // first sweep a short pause is usually enough for the next sweep to succeed.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await sleep(500);
      for (const url of ordered) {
        try {
          const json = await this.#post(url, payload);
          const items = Array.isArray(payload) ? json : [json];
          if (!Array.isArray(items)) throw new RpcError('malformed response');
          const bad = items.find((r) => r && r.error);
          if (bad) throw new RpcError(bad.error.message || 'rpc error');
          if (this.activeUrl !== url) this.#remember(url);
          this.activeUrl = url;
          return json;
        } catch (e) {
          lastErr = e;
          this.failures.push(`${short(url)}: ${e.message}`);
          if (this.activeUrl === url) this.activeUrl = null;
        }
      }
    }
    throw new RpcError(`all endpoints failed (${lastErr?.message || 'unknown'})`);
  }

  async call(method, params) {
    const json = await this.#send({ jsonrpc: '2.0', id: 1, method, params });
    return json.result;
  }

  /** One HTTP request, many independent JSON-RPC calls. */
  async batch(calls) {
    if (!calls.length) return [];
    const payload = calls.map((c, i) => ({ jsonrpc: '2.0', id: i + 1, method: c.method, params: c.params }));
    const json = await this.#send(payload);
    const byId = new Map(json.map((r) => [r.id, r.result]));
    return calls.map((_, i) => byId.get(i + 1));
  }

  blockNumber() {
    return this.call('eth_blockNumber', []).then((h) => BigInt(h));
  }

  ethCall(to, data, block = 'latest') {
    return this.call('eth_call', [{ to, data }, block]);
  }

  /**
   * Run many contract reads in one eth_call via Multicall3.
   * @param calls [{target, callData, allowFailure?}]
   * @returns [{success, data}]
   */
  async multicall(calls, block = 'latest') {
    if (!calls.length) return [];
    const data = encodeAggregate3(
      calls.map((c) => ({ target: c.target, allowFailure: c.allowFailure !== false, callData: c.callData }))
    );
    const raw = await this.ethCall(MULTICALL3, data, block);
    if (!raw || raw === '0x') throw new RpcError('multicall returned empty');
    return decodeAggregate3(raw);
  }

  /**
   * Multicall, automatically split so no single request gets too large, and with a
   * per-call fallback if Multicall3 itself is unavailable on the chain.
   */
  async multicallChunked(calls, { block = 'latest', chunk = 60 } = {}) {
    const chunks = [];
    for (let i = 0; i < calls.length; i += chunk) chunks.push(calls.slice(i, i + chunk));
    try {
      const results = await Promise.all(chunks.map((c) => this.multicall(c, block)));
      return results.flat();
    } catch (e) {
      // Fall back to plain batched eth_calls (still one request per chunk).
      const results = await Promise.all(
        chunks.map((c) =>
          this.batch(c.map((x) => ({ method: 'eth_call', params: [{ to: x.target, data: x.callData }, block] })))
        )
      );
      return results.flat().map((data) => ({ success: data != null && data !== '0x', data: data ?? '0x' }));
    }
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Forget the remembered endpoint for a chain (e.g. the user set a new custom RPC). */
export function clearStickyRpc(chainId) {
  try {
    localStorage.removeItem(`hexminer.rpc.${chainId}`);
  } catch {
    /* non-fatal */
  }
}

const short = (u) => {
  try {
    return new URL(u).host;
  } catch {
    return u;
  }
};

/** Convenience: build a Multicall3 entry. */
export const mc = (target, callData) => ({ target, callData });

/** dailyDataRange(begin, end) call data. */
export const dailyDataRangeCall = (hexAddr, begin, end) =>
  mc(hexAddr, SEL.dailyDataRange + padWord(begin) + padWord(end));
