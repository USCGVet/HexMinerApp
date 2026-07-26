/** Settings page: addresses, chains, RPC overrides, cache. */

import { CHAINS, CHAIN_IDS, loadSettings, saveSettings, isAddress, normalize } from './config.js';
import { clearDailyDataCache } from './hexdata.js';
import { clearStickyRpc } from './rpc.js';
import { esc, shortAddr } from './format.js';

let settings = loadSettings();
const $ = (id) => document.getElementById(id);

function persist(message) {
  saveSettings(settings);
  if (message) flash(message, 'ok');
}

function flash(msg, kind = 'ok') {
  $('flash').innerHTML = `<div class="notice ${kind}">${esc(msg)}</div>`;
  clearTimeout(flash.t);
  flash.t = setTimeout(() => {
    $('flash').innerHTML = '';
  }, 3500);
}

// ---------------------------------------------------------------- addresses

function renderAddresses() {
  const list = $('addrList');
  if (!settings.addresses.length) {
    list.innerHTML = `<p class="muted small">No addresses yet. Add one below, or connect a wallet to read its address.</p>`;
    return;
  }
  list.innerHTML = settings.addresses
    .map(
      (a, i) => `
    <div class="addr-row">
      <span class="mono" title="${esc(a.address)}">${esc(a.address)}</span>
      ${a.label ? `<span class="owner">${esc(a.label)}</span>` : ''}
      <a class="muted small" href="${esc(CHAINS[1].explorer)}/address/${esc(a.address)}" target="_blank" rel="noopener noreferrer">explorer ↗</a>
      <button class="btn btn-danger" data-remove="${i}" type="button">Remove</button>
    </div>`
    )
    .join('');

  list.querySelectorAll('[data-remove]').forEach((b) =>
    b.addEventListener('click', () => {
      const i = Number(b.dataset.remove);
      const removed = settings.addresses[i];
      settings.addresses.splice(i, 1);
      persist(`Removed ${shortAddr(removed.address)}.`);
      renderAddresses();
    })
  );
}

function addAddress(raw, label) {
  const input = $('addrInput');
  if (!isAddress(raw)) {
    input.classList.add('invalid');
    flash('That is not a valid Ethereum address — it should be 0x followed by 40 hex characters.', 'bad');
    return false;
  }
  const addr = normalize(raw);
  if (settings.addresses.some((a) => a.address === addr)) {
    flash('That address is already being tracked.', 'bad');
    return false;
  }
  input.classList.remove('invalid');
  settings.addresses.push({ address: addr, label: (label || '').trim() });
  persist(`Added ${shortAddr(addr)}.`);
  renderAddresses();
  return true;
}

// ---------------------------------------------------------------- chains & rpc

function renderChains() {
  $('chainToggles').innerHTML = CHAIN_IDS.map(
    (id) => `
    <label class="check">
      <input type="checkbox" data-chain="${id}" ${settings.enabledChains.includes(id) ? 'checked' : ''}>
      <span>${esc(CHAINS[id].name)} <span class="muted small">(${esc(CHAINS[id].hexSymbol)})</span></span>
    </label>`
  ).join('');

  $('chainToggles')
    .querySelectorAll('[data-chain]')
    .forEach((cb) =>
      cb.addEventListener('change', () => {
        const id = Number(cb.dataset.chain);
        const on = cb.checked;
        const next = on
          ? [...new Set([...settings.enabledChains, id])]
          : settings.enabledChains.filter((c) => c !== id);
        if (!next.length) {
          cb.checked = true;
          flash('At least one chain must stay enabled.', 'bad');
          return;
        }
        settings.enabledChains = next.sort((a, b) => CHAIN_IDS.indexOf(a) - CHAIN_IDS.indexOf(b));
        persist('Chains updated.');
      })
    );
}

function renderRpcFields() {
  $('rpcFields').innerHTML = CHAIN_IDS.map(
    (id) => `
    <div class="field">
      <label for="rpc-${id}">${esc(CHAINS[id].name)} RPC override</label>
      <input type="url" id="rpc-${id}" spellcheck="false" autocomplete="off"
             placeholder="${esc(CHAINS[id].rpcs[0])}"
             value="${esc(settings.customRpcs?.[id] || '')}">
      <p class="muted small" style="margin:6px 0 0">
        Optional. Tried first, with the built-in endpoints as automatic fallback.
      </p>
    </div>`
  ).join('');

  CHAIN_IDS.forEach((id) => {
    const el = $(`rpc-${id}`);
    el.addEventListener('change', () => {
      const v = el.value.trim();
      settings.customRpcs = settings.customRpcs || {};
      if (!v) {
        delete settings.customRpcs[id];
        clearStickyRpc(id);
        persist(`${CHAINS[id].name} RPC reset to defaults.`);
      } else if (!/^https?:\/\//i.test(v)) {
        flash('RPC URL must start with http:// or https://', 'bad');
        return;
      } else {
        settings.customRpcs[id] = v;
        // a fresh choice must be tried first, ahead of any previously remembered endpoint
        clearStickyRpc(id);
        persist(`${CHAINS[id].name} RPC saved.`);
      }
    });
  });
}

// ---------------------------------------------------------------- wallet

async function connectWallet() {
  const eth = window.ethereum;
  if (!eth) {
    flash('No browser wallet detected. Paste an address instead — watch-only works fine here.', 'bad');
    return;
  }
  try {
    const accounts = await eth.request({ method: 'eth_requestAccounts' });
    let added = 0;
    for (const a of accounts || []) {
      if (isAddress(a) && !settings.addresses.some((x) => x.address === normalize(a))) {
        settings.addresses.push({ address: normalize(a), label: '' });
        added++;
      }
    }
    if (added) {
      persist(`Added ${added} address${added === 1 ? '' : 'es'} from your wallet.`);
      renderAddresses();
    } else {
      flash('Your wallet returned no new addresses.', 'bad');
    }
  } catch (e) {
    if (e?.code !== 4001) flash(`Could not read accounts: ${e.message || e}`, 'bad');
  }
}

// ---------------------------------------------------------------- boot

document.addEventListener('DOMContentLoaded', () => {
  renderAddresses();
  renderChains();
  renderRpcFields();

  $('refreshSel').value = String(settings.refreshSeconds || 0);
  $('refreshSel').addEventListener('change', (e) => {
    settings.refreshSeconds = Number(e.target.value);
    persist('Auto-refresh updated.');
  });

  $('addForm').addEventListener('submit', (e) => {
    e.preventDefault();
    if (addAddress($('addrInput').value, $('labelInput').value)) {
      $('addrInput').value = '';
      $('labelInput').value = '';
    }
  });

  $('addrInput').addEventListener('input', () => $('addrInput').classList.remove('invalid'));
  $('connectBtn').addEventListener('click', connectWallet);

  $('clearCacheBtn').addEventListener('click', () => {
    clearDailyDataCache();
    flash('Daily-data cache cleared. The next load will re-read every day from chain.', 'ok');
  });
});
