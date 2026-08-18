/**
 * Model weights: fetched ONCE from the pinned upstream host as *data*, SHA-256
 * verified, and kept in the Cache API.
 *
 * M1 compliance: this is data, never script. Nothing is ever `import`ed or
 * evaluated from the network. P1 compliance: after the first successful fetch
 * this function makes zero network requests — `cache.match` short-circuits
 * before `fetch` is even referenced.
 *
 * The hash is checked on EVERY load, not just the first: a truncated or
 * corrupted cache entry must never reach InferenceSession.create (SCOPE AC-2.5.d).
 */

import { MODEL, CACHE_NAME } from './config.js';

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

async function readAll(res, onProgress) {
  const total = Number(res.headers.get('Content-Length')) || MODEL.bytes;
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.length;
    onProgress(got, total);
  }
  const buf = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { buf.set(p, o); o += p.length; }
  return buf;
}

/**
 * @param {(phase:'cache'|'download'|'verify', got:number, total:number)=>void} onProgress
 * @returns {Promise<{buffer: ArrayBuffer, fromCache: boolean, ms: number}>}
 */
export async function loadModel(onProgress = () => {}) {
  const t0 = performance.now();
  const cache = await caches.open(CACHE_NAME);

  const hit = await cache.match(MODEL.url);
  // Announce cache-vs-network BEFORE any bytes move. `fromCache` in the return
  // value is a post-hoc record and arrives ~2 minutes too late to choose the
  // wording on a progress card; `phase` is the authoritative signal and this is
  // what makes it authoritative from the instant the answer is known, rather
  // than from the first byte of a fetch whose headers may take a second.
  onProgress(hit ? 'cache' : 'download', 0, MODEL.bytes);
  if (hit) {
    const bytes = await readAll(hit, (g, t) => onProgress('cache', g, t));
    onProgress('verify', bytes.length, bytes.length);
    const got = hex(await crypto.subtle.digest('SHA-256', bytes));
    if (got === MODEL.sha256) {
      return { buffer: bytes.buffer, fromCache: true, ms: performance.now() - t0 };
    }
    await cache.delete(MODEL.url);   // corrupt entry — never load it
  }

  const res = await fetch(MODEL.url);
  if (!res.ok) throw new Error(`model fetch failed: HTTP ${res.status}`);
  const bytes = await readAll(res, (g, t) => onProgress('download', g, t));
  onProgress('verify', bytes.length, bytes.length);
  const got = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (got !== MODEL.sha256) {
    throw new Error(`model integrity check failed: sha256 ${got} != ${MODEL.sha256}`);
  }
  await cache.put(MODEL.url, new Response(bytes, {
    headers: { 'Content-Length': String(bytes.length), 'Content-Type': 'application/octet-stream' },
  }));
  return { buffer: bytes.buffer, fromCache: false, ms: performance.now() - t0 };
}

/** Is the model already on disk? Cheap — does not read the body. */
export async function isModelCached() {
  const cache = await caches.open(CACHE_NAME);
  return !!(await cache.match(MODEL.url));
}

export async function clearModel() {
  await caches.delete(CACHE_NAME);
}
