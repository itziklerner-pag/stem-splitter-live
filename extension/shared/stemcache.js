/**
 * Stem cache — the thing that makes Mode 3 possible.
 *
 * Two live decks do not fit: measured p95(A+B) 2496 ms against a 1950 ms
 * deadline, 0.78x margin, deck B 58 % separated (`tools/dual-live-probe.mjs`).
 * A CACHED deck costs 0 % GPU and has zero latency, so Mode 3 is one live deck
 * plus one cached deck. docs/AUDIO.md §8.3 called this from first principles
 * before any live code existed.
 *
 * ---------------------------------------------------------------------------
 * FORMAT — 16-bit PCM, and only for playback.
 *
 * Export always re-derives from the model at 32f, so no lossy artefact can ever
 * reach a deliverable; the cache is a playback convenience and nothing else.
 * 16-bit is ~254 MB/track at six stems (169 MB at four) against ~508 MB for 32f,
 * which doubles how many tracks fit under a given cap. Stems are more revealing
 * of codec artefacts than full mixes (no masking material), which is why this is
 * PCM and not Opus — AUDIO.md §8.3 puts the floor at 128 kbps/stem if that ever
 * changes.
 *
 * Dither: NO. `encodeWav` dithers by default and that is right for a
 * deliverable, but this file is read back and summed with its siblings, so
 * `STEMS.length` independent TPDF noise floors would add — and that argument got
 * STRONGER at six stems, not weaker. The stems must also sum to the mix the way
 * the model produced them. `dither: false` is deliberate.
 *
 * ---------------------------------------------------------------------------
 * KEY — videoId + pipeline version.
 *
 * A pipeline change MUST invalidate. Silently-stale stems are the worst class of
 * bug this project can ship: they sound plausible, they are wrong, and nothing
 * in the UI can tell you. `pipelineVersion()` folds in everything that changes
 * the samples — the model hash, the segment geometry, the seam crossfade law,
 * and the hop, because cached stems come from ONE REAL-TIME PASS through the
 * causal window and that window is hop-dependent (a 1.95 s hop and a 3.9 s hop
 * produce measurably different stems: corr 0.9909 vs 0.9938 against offline).
 *
 * ---------------------------------------------------------------------------
 * PRIMING IS ONE REAL-TIME PASS AND CANNOT BE SPED UP. Raising
 * `video.playbackRate` still captures at 48 kHz, so at 3x everything above
 * 8 kHz is gone; `preservesPitch` phase-vocodes exactly the fine structure the
 * separator relies on. Design the UX around "prime this while the previous
 * track plays" (AUDIO.md §8.3), never around a trick.
 */

import { SR, SEGMENT, STEMS, MODEL, SEAM_XFADE_LAW, SEAM_XFADE_MS } from './config.js';
import { encodeWav, decodeWav } from './wav.js';

export const CACHE_DIR = 'stemcache';
const MANIFEST = 'manifest.json';

/**
 * Bump when the cache LAYOUT changes in a way the reader cannot detect —
 * a different file naming scheme, a different channel order, a different
 * bit depth. Model/geometry/law changes are folded in automatically below.
 */
const CACHE_FORMAT = 1;

/**
 * Everything that changes the samples. Anything omitted here is a silently-stale
 * cache entry waiting to happen, so err on the side of including it: a spurious
 * miss costs one real-time re-prime, a spurious HIT costs the user's trust.
 */
export function pipelineVersion(hopSeconds) {
  const parts = [
    `f${CACHE_FORMAT}`,
    MODEL.sha256.slice(0, 12),
    `sr${SR}`, `seg${SEGMENT}`,
    `hop${Math.round(hopSeconds * 1000)}`,
    `x${SEAM_XFADE_MS}${SEAM_XFADE_LAW === 'linear' ? 'L' : 'P'}`,
  ];
  return parts.join('-');
}

/**
 * The track identity, off the TAB's address bar.
 *
 * L1, AND READ THIS BEFORE FLAGGING IT. A function in this project that takes a
 * YouTube URL apart is exactly the shape of the thing L1 forbids, so the
 * distinction has to be stated rather than assumed: this reads the **page**
 * address the user is looking at — the same string already in the tab title bar,
 * already carried on `source.url` since the first commit, and already shown in
 * the deck header. It is a NAME for the track, used as a cache key.
 *
 * It does not resolve, fetch or parse a media stream URL; it never touches
 * `player_response`, `/videoplayback`, `innertube`, `<video>.src`, `currentSrc`
 * or `buffered`. Audio still arrives only through `chrome.tabCapture`, and the
 * cache is filled from that capture in one real-time pass. Swap this for a
 * random UUID per tab and the ONLY thing that breaks is recognising the same
 * track on a later visit — which is the tell that it is an identifier and not an
 * acquisition path.
 *
 * Returns null for anything that is not a recognisable video page, and null
 * means "do not cache this listen" rather than "make something up": a key that
 * collides across two different tracks serves the wrong stems, and stale-but-
 * plausible is the worst failure this file has.
 */
export function videoIdFromUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '');
  const id = (s) => (/^[A-Za-z0-9_-]{11}$/.test(s || '') ? s : null);
  if (host === 'youtu.be') return id(u.pathname.slice(1).split('/')[0]);
  if (host !== 'youtube.com' && host !== 'm.youtube.com' && host !== 'music.youtube.com') return null;
  if (u.pathname === '/watch') return id(u.searchParams.get('v'));
  const m = u.pathname.match(/^\/(?:embed|shorts|live|v)\/([^/?#]+)/);
  return m ? id(m[1]) : null;
}

/** Cache key. `videoId` is opaque to us — the caller supplies it. */
export function cacheKey(videoId, hopSeconds) {
  const id = String(videoId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${id}--${pipelineVersion(hopSeconds)}`;
}

/**
 * 16-bit stereo: 4 bytes/frame/stem, `STEMS.length` stems, plus ONE 44-byte WAV
 * header PER STEM FILE — `put()` writes `${key}.${stem}.wav` for every stem, so
 * the header count is the stem count.
 *
 * The `4 * 44` this used to read was the stem count of the day standing in for a
 * file count, which is the same number by coincidence and stops being it the
 * moment the model widens. (It is 88 bytes against ~254 MB, so it never showed
 * up as a defect — which is exactly why it had to be read rather than measured.)
 */
export const bytesForSeconds = (seconds) =>
  Math.round(seconds * SR) * 4 * STEMS.length + STEMS.length * 44;

// ------------------------------------------------------------- prime policy
/**
 * A prime is ALL OR NOTHING. These two are the whole policy, kept pure and here
 * rather than inline in the engine because they are the part that can be wrong
 * in a way nothing downstream can detect: a cache entry that covers 1:47 to the
 * end, or stops 40 s early, plays back as a track that is subtly not the track.
 * A spurious refusal costs one real-time re-prime; a spurious acceptance costs
 * the user's trust in every entry.
 *
 * Both return `null` for "go ahead" and a human-readable reason otherwise, so
 * the engine can log WHY nothing was cached — a prime that silently does not
 * happen is indistinguishable from one that failed.
 */

/** How far into a track a prime may start and still be called complete. */
export const PRIME_START_MAX_SEC = 1.0;

/**
 * How much of the tail a prime may be missing and still commit.
 *
 * The live pipeline is causal: when the video reaches the end, the last output
 * buffer's worth of captured audio has not been separated yet and never will be,
 * because the capture stops with it. Every prime is about one buffer short.
 *
 * ponytail: the cached track ends up to this much before the video does. Ceiling
 * is one output-buffer depth (2.4-4 s at the shipping hops), which on music is an
 * outro tail rather than a downbeat. Upgrade path: drain the pipeline's ring
 * after the capture ends — `LivePipeline` has no drain path today.
 */
export const PRIME_TAIL_MAX_SEC = 6.0;

/**
 * May this listen start a prime? `page` is the tab's transport, or null when
 * nobody has told us — which is a REFUSAL, not a default. Only the embedded
 * build has a content script, so in the side-panel build this is always null and
 * nothing is ever cached; assuming a playhead we cannot see is how a cache entry
 * that starts mid-track gets written.
 *
 * @param {string|null} videoId
 * @param {{currentTime:number, duration:number}|null} page
 */
export function primeRefusal(videoId, page) {
  if (!videoId) return 'not a recognisable video page';
  if (!page) return 'no page transport (this build has no content script)';
  if (!(page.duration > 0)) return 'the page reports no duration';
  if (!(page.currentTime <= PRIME_START_MAX_SEC)) {
    return `the video is already ${Number(page.currentTime).toFixed(1)} s in`;
  }
  return null;
}

/**
 * May this prime become a cache entry? Requires the track to have played to the
 * END — a pause at 5:55 of a 6:00 track caches nothing, deliberately, because
 * "nearly all of it" is the ambiguity this policy exists to remove.
 *
 * @param {{aborted:boolean, frames:number}|null} writer
 * @param {{duration:number, ended:boolean}|null} page
 */
export function commitRefusal(writer, page, tailMaxSec = PRIME_TAIL_MAX_SEC) {
  if (!writer) return 'nothing was being primed';
  if (writer.aborted) return 'the prime was interrupted';
  if (!writer.frames) return 'nothing was captured';
  const got = writer.frames / SR;
  if (!page) return 'no page transport to check completeness against';
  if (!page.ended) return `the track did not play to the end (${got.toFixed(1)} s)`;
  const missing = page.duration - got;
  if (missing > tailMaxSec) {
    return `${missing.toFixed(1)} s short of the page's ${Number(page.duration).toFixed(1)} s`;
  }
  return null;
}

// ------------------------------------------------------------------- storage
/**
 * The OPFS directory ONE CACHE OWNS, named by the caller rather than by this
 * module. Every read and every write in the class below goes through here, so a
 * hard-coded name here is not a default — it is every instance sharing one
 * directory no matter what it was constructed with.
 */
async function dir(name) {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(name, { create: true });
}
async function readJson(d, name, fallback) {
  try {
    const f = await (await d.getFileHandle(name)).getFile();
    return JSON.parse(await f.text());
  } catch { return fallback; }
}
async function writeFile(d, name, data) {
  const fh = await d.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(data);
  await w.close();
}

/**
 * The manifest is the ONLY index. A file on disk with no manifest entry is
 * garbage from an interrupted write and is deleted on the next sweep — which is
 * why the manifest is written LAST, after every stem file has closed. A crash
 * mid-prime therefore leaves an incomplete entry invisible rather than
 * half-readable.
 */
async function loadManifest(d) {
  const m = await readJson(d, MANIFEST, null);
  return m && Array.isArray(m.entries) ? m : { v: CACHE_FORMAT, entries: [] };
}

/**
 * WHICH entries eviction would remove, as pure arithmetic — the decision is
 * separated from the deleting so it can be tested, and so a UI can show it
 * BEFORE anything is deleted. Predictability is the requirement here: a cache
 * that silently drops a set prepared the night before a gig is a bug even when
 * every line of it is correct.
 *
 * Strict LRU on `usedAt`, oldest first. `pin` is never a candidate — you cannot
 * evict the track that is currently playing, which is otherwise exactly what
 * would happen when the other deck primes something large.
 *
 * @param {{key:string, bytes:number, usedAt:number, title?:string}[]} entries
 * @param {number} maxBytes
 * @param {string|null} pin
 */
export function planEviction(entries, maxBytes, pin = null) {
  let total = entries.reduce((a, e) => a + e.bytes, 0);
  const removed = [];
  // Ties broken by key so the order is deterministic rather than
  // implementation-defined; two entries used in the same millisecond is a real
  // case when a prime finishes and is immediately played.
  const order = entries.slice().sort((a, b) => (a.usedAt - b.usedAt) || (a.key < b.key ? -1 : 1));
  for (const e of order) {
    if (total <= maxBytes) break;
    if (e.key === pin) continue;
    total -= e.bytes;
    removed.push({ key: e.key, bytes: e.bytes, title: e.title || null });
  }
  return { removed, bytes: total, wouldExceed: total > maxBytes };
}

export class StemCache {
  /**
   * @param {number} maxBytes size cap; eviction is LRU down to this
   * @param {string} dirName  the OPFS directory this cache owns, under the
   *   storage root. Defaults to `CACHE_DIR`, so the live 16-bit cache is
   *   constructed exactly as it always was.
   *
   * IT IS A CONSTRUCTOR ARGUMENT BECAUSE A SECOND TIER IS A SECOND DIRECTORY,
   * and until this existed the directory was a module constant that every
   * instance shared. Two caches over one directory is not a smaller version of
   * two caches — `list()` returns the other tier's entries, `evict()` deletes
   * against the wrong cap, and `clear()` destroys a cache the caller never
   * named. The name travels with the instance so none of those can be reached.
   */
  constructor(maxBytes, dirName = CACHE_DIR) {
    this.maxBytes = maxBytes;
    this.dirName = dirName;
  }

  async list() {
    const d = await dir(this.dirName);
    const m = await loadManifest(d);
    return m.entries;
  }

  async has(key) {
    return (await this.list()).some((e) => e.key === key);
  }

  /** Total bytes tracked by the manifest. */
  async size() {
    return (await this.list()).reduce((a, e) => a + e.bytes, 0);
  }

  /**
   * Read one entry back. Touches `usedAt` so LRU means what it says — a track
   * you keep playing is a track you keep.
   * @returns {Promise<{meta:object, stems:Record<string,Float32Array[]>}|null>}
   */
  async get(key) {
    const d = await dir(this.dirName);
    const m = await loadManifest(d);
    const e = m.entries.find((x) => x.key === key);
    if (!e) return null;
    const stems = {};
    for (const s of STEMS) {
      try {
        const f = await (await d.getFileHandle(`${key}.${s}.wav`)).getFile();
        const w = decodeWav(await f.arrayBuffer());
        stems[s] = w.channels;
      } catch {
        // A missing file with a manifest entry means the entry is a lie. Drop it
        // rather than return STEMS.length - 1 stems and a hole.
        await this.delete(key);
        return null;
      }
    }
    e.usedAt = Date.now();
    await writeFile(d, MANIFEST, JSON.stringify(m));
    return { meta: e, stems };
  }

  /**
   * @param {string} key
   * @param {object} meta  free-form; `videoId`, `title`, `seconds`, `hopSeconds`
   * @param {Record<string, Float32Array[]>} stems  stem name -> [L, R]
   */
  async put(key, meta, stems) {
    const d = await dir(this.dirName);
    let bytes = 0;
    for (const s of STEMS) {
      const ch = stems[s];
      if (!ch || ch.length !== 2) throw new Error(`stem cache: ${s} must be [L, R]`);
      // 16-bit, NO dither — see the header. Six dithered stems summed would
      // stack six independent noise floors on a signal that gets re-mixed.
      const wav = encodeWav(ch, { sampleRate: SR, bitDepth: 16, float: false, dither: false });
      await writeFile(d, `${key}.${s}.wav`, wav);
      bytes += wav.byteLength;
    }
    const m = await loadManifest(d);
    const now = Date.now();
    m.entries = m.entries.filter((x) => x.key !== key);
    // Written LAST: until this line the entry does not exist, so an interrupted
    // prime cannot leave a readable-but-incomplete track in the cache.
    m.entries.push({ key, bytes, madeAt: now, usedAt: now, frames: stems[STEMS[0]][0].length, ...meta });
    await writeFile(d, MANIFEST, JSON.stringify(m));
    return this.evict();
  }

  async delete(key) {
    const d = await dir(this.dirName);
    for (const s of STEMS) await d.removeEntry(`${key}.${s}.wav`).catch(() => {});
    const m = await loadManifest(d);
    m.entries = m.entries.filter((x) => x.key !== key);
    await writeFile(d, MANIFEST, JSON.stringify(m));
  }

  /**
   * LRU down to the cap. Predictable on purpose: oldest `usedAt` first, and the
   * entry currently being played is never a candidate because the caller passes
   * it as `pin`. Returns what it removed so the UI can say so — a cache that
   * silently deletes a prepared set the night before a gig is a bug even though
   * every line of it is correct.
   */
  async evict(pin = null) {
    const d = await dir(this.dirName);
    const m = await loadManifest(d);
    const plan = planEviction(m.entries, this.maxBytes, pin);
    for (const e of plan.removed) {
      for (const s of STEMS) await d.removeEntry(`${e.key}.${s}.wav`).catch(() => {});
    }
    if (plan.removed.length) {
      const gone = new Set(plan.removed.map((e) => e.key));
      m.entries = m.entries.filter((x) => !gone.has(x.key));
      await writeFile(d, MANIFEST, JSON.stringify(m));
    }
    return { ...plan, maxBytes: this.maxBytes, tracks: m.entries.length };
  }

  /**
   * Drop everything, including files the manifest has lost track of.
   *
   * THIS ONE DELETES A WHOLE DIRECTORY, so it is the call that punishes a
   * module-constant name hardest: pointed at the wrong tier it destroys a cache
   * the caller never named and then reports success, because `removeEntry` on a
   * directory that is not there is caught and ignored two lines down. It reads
   * `this.dirName` for that reason and not for symmetry.
   */
  async clear() {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(this.dirName, { recursive: true }).catch(() => {});
  }

  /** What the UI needs to render the cache: cap, use, and the tracks in LRU order. */
  async report() {
    const entries = await this.list();
    const bytes = entries.reduce((a, e) => a + e.bytes, 0);
    return {
      bytes, maxBytes: this.maxBytes, tracks: entries.length,
      pct: this.maxBytes ? +(bytes / this.maxBytes).toFixed(4) : 0,
      entries: entries.slice().sort((a, b) => b.usedAt - a.usedAt),
    };
  }
}

/**
 * Accumulates stems as the live pipeline emits them, one hop at a time, so a
 * cache entry is a by-product of a normal listen rather than a separate pass.
 * Holds the whole track in memory: 6 stems x 2 ch x 32f is ~508 MB for 4 minutes
 * before it is written as ~254 MB of 16-bit.
 *
 * ponytail: whole-track in RAM. Ceiling is the SCOPE envelope of 10-minute
 * tracks (~1.27 GB here at six stems, on top of ORT's ~1.7 GB — this got 1.5x
 * worse with the widening and is now the largest single allocation in the
 * product). Upgrade path: append each hop
 * straight into a `FileSystemSyncAccessHandle` per stem in a worker and patch
 * the RIFF sizes at the end — the same fix ARCHITECTURE R6 names for export.
 */
export class CacheWriter {
  constructor(key, meta) {
    this.key = key;
    this.meta = meta;
    this.chunks = STEMS.map(() => [[], []]);
    this.frames = 0;
    this.aborted = false;
  }

  /** @param {Float32Array[]} planes STEMS.length*2 planes, stem-major [L,R] per stem */
  append(planes, len) {
    if (this.aborted) return;
    // A SHORT PLANE ARRAY IS THE SIX-STEM WIDENING ARRIVING HALF-DONE, and it is
    // the exact shape of the silently-stale entry this file exists to prevent: a
    // caller still passing 8 planes would cache four stems, commit, and read back
    // as a track that is missing its guitar and piano with nothing to say so.
    // Named rather than left to throw a TypeError on `undefined.slice`.
    if (!Array.isArray(planes) || planes.length < STEMS.length * 2) {
      throw new Error(`stem cache: append needs ${STEMS.length * 2} planes for ${STEMS.length} stems, got ${Array.isArray(planes) ? planes.length : typeof planes}`);
    }
    for (let k = 0; k < STEMS.length; k++) {
      for (let c = 0; c < 2; c++) {
        this.chunks[k][c].push(planes[k * 2 + c].slice(0, len));
      }
    }
    this.frames += len;
  }

  /** A prime that was interrupted must not become a cache entry. */
  abort() { this.aborted = true; this.chunks = STEMS.map(() => [[], []]); this.frames = 0; }

  stems() {
    const out = {};
    STEMS.forEach((s, k) => {
      out[s] = [0, 1].map((c) => {
        const a = new Float32Array(this.frames);
        let o = 0;
        for (const part of this.chunks[k][c]) { a.set(part, o); o += part.length; }
        return a;
      });
    });
    return out;
  }

  async commit(cache) {
    if (this.aborted || this.frames === 0) return null;
    const meta = { ...this.meta, seconds: +(this.frames / SR).toFixed(2) };
    const r = await cache.put(this.key, meta, this.stems());
    return { key: this.key, frames: this.frames, ...r };
  }
}
