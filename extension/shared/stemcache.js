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
/**
 * The 32-bit-float tier's directory — the desktop's, and a SEPARATE one.
 *
 * Separate storage is belt to the key's braces below. The key stops a 32f entry
 * being mistaken for a 16-bit one; the directory stops the two tiers sharing a
 * manifest, a cap and an eviction order, which is what makes one tier able to
 * evict the other's working set.
 */
export const CACHE_DIR_32F = 'stemcache-f32';
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
export function pipelineVersion(hopSeconds, tier = {}) {
  const { depth = 16, geometry = 'causal' } = tier;
  const parts = [
    `f${CACHE_FORMAT}`,
    MODEL.sha256.slice(0, 12),
    `sr${SR}`, `seg${SEGMENT}`,
    `hop${Math.round(hopSeconds * 1000)}`,
    `x${SEAM_XFADE_MS}${SEAM_XFADE_LAW === 'linear' ? 'L' : 'P'}`,
  ];
  /**
   * THE TIER COMPONENT IS CONDITIONAL, AND THAT IS THE WHOLE POINT OF IT.
   *
   * Appending `-d16i-gc` unconditionally would change every key every existing
   * user already has, and this file's own eviction note calls a cache that
   * silently drops a set prepared the night before a gig a bug even when every
   * line of it is correct. A legacy 16-bit causal entry therefore keeps a
   * byte-identical key, and only a tier that is genuinely NEW is spelled out.
   *
   * A conditional component is somewhere a bug can hide; discarding every
   * prepared set on upgrade is a bug that is certain. That is the trade, made
   * deliberately.
   *
   * BOTH HALVES CHANGE THE SAMPLES, which is the bar this function's header
   * sets for inclusion. `depth` is what the bytes on disk are. `geometry` is
   * whether the stems came from the live path's CAUSAL window — past audio only,
   * because at capture time there is no future — or from an ahead-of-time run
   * that could see the whole file and used a symmetric window. Same weights,
   * same seam law, measurably different stems.
   */
  if (!(depth === 16 && geometry === 'causal')) {
    parts.push(`d${depth}${depth === 32 ? 'f' : 'i'}`, geometry === 'causal' ? 'gc' : 'go');
  }
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

/**
 * Cache key. `videoId` is opaque to us — the caller supplies it.
 * @param {{depth?:16|32, geometry?:'causal'|'offline'}} [tier] omit for the live tier
 */
export function cacheKey(videoId, hopSeconds, tier) {
  const id = String(videoId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64);
  return `${id}--${pipelineVersion(hopSeconds, tier)}`;
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
export const bytesForSeconds = (seconds, depth = 16) =>
  Math.round(seconds * SR) * ((depth >> 3) * 2) * STEMS.length + STEMS.length * 44;

const EMPTY_PINS = new Set();
/**
 * Pins, however the caller spelled them. ONE implementation, because the two
 * callers below must agree about what is pinned: `separationRefusal` decides
 * whether a run may start from the same set `planEviction` would refuse to
 * delete, and two copies of this could drift into answering differently for the
 * same argument.
 *
 * A BARE STRING IS ONE KEY, NOT AN ITERABLE OF CHARACTERS. `new Set('abc')` is
 * three single-character keys and matches nothing, so the string branch is not a
 * convenience — without it the live path's single-pin call silently pins nothing.
 */
const pinSet = (pins) => (pins == null ? EMPTY_PINS
  : typeof pins === 'string' ? new Set([pins]) : new Set(pins));

/**
 * MAY THIS SOURCE START AN AHEAD-OF-TIME SEPARATION? Pure, and it answers BEFORE
 * the decode and before the model, for the same reason `primeRefusal` answers
 * before a capture: the alternative is a four-minute run that succeeds and then
 * cannot be stored.
 *
 * WITHOUT THIS, "PINNED WHILE OPEN" IS A SLOW LEAK. Two long sources open and
 * pinned, a third separation completes, `evict()` can remove nothing because
 * everything left is pinned, and the tier sits over its cap with no recovery
 * until a deck closes. `planEviction` reports that honestly as `wouldExceed` and
 * nothing acts on it, because `put()` evicts AFTER it has written.
 *
 * Returns `null` for "go ahead" and a human-readable reason otherwise, the same
 * contract the two prime refusals above use, so the caller can log WHY nothing
 * was separated — a run that silently does not happen is indistinguishable from
 * one that failed.
 *
 * @param {number} seconds  the decoded source's duration
 * @param {{key:string, bytes:number}[]} entries  the tier's manifest
 * @param {number} maxBytes
 * @param {string|Iterable<string>|null} pins  keys pinned because their source is open
 * @param {16|32} depth
 */
export function separationRefusal(seconds, entries, maxBytes, pins = null, depth = 32) {
  if (!(seconds > 0)) return 'the source decoded to nothing';
  const gib = (b) => `${(b / 1024 ** 3).toFixed(2)} GiB`;
  const need = bytesForSeconds(seconds, depth);
  if (need > maxBytes) {
    return `this track needs ${gib(need)} and the whole cache is ${gib(maxBytes)}`;
  }
  const pinned = pinSet(pins);
  const pinnedBytes = (entries || []).reduce((a, e) => a + (pinned.has(e.key) ? e.bytes : 0), 0);
  if (pinnedBytes + need > maxBytes) {
    return `${gib(pinnedBytes)} is pinned by the tracks that are open, which leaves less than `
      + `the ${gib(need)} this one needs`;
  }
  return null;
}

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

// ------------------------------------------------------- the File source
/**
 * A FILE SOURCE HAS NO videoId, AND `null` IS NOT A USABLE STAND-IN FOR ONE.
 *
 * `videoIdFromUrl` returns null for anything that is not a YouTube page, and
 * `cacheKey(null, hop)` is then the literal string `'null--<pipelineVersion>'` —
 * ONE key shared by every file the user ever opens, serving the first file's
 * stems for the second with nothing anywhere able to tell: same six names, same
 * length shape, plausible audio. That is the stale-but-plausible failure this
 * file's header calls the worst bug it has, arriving through a MISSING key
 * rather than a stale one.
 *
 * TODAY'S TREE DOES NOT REACH IT, and saying so is the point. `trackKey()`
 * (`offscreen/engine.js:547-551`) guards with `if (!videoId) return null` and
 * caches nothing, which is right for a YouTube tab that is not on a video page.
 * Reuse that guard for a File source and it is still wrong, just quietly: a file
 * ALWAYS has no videoId, so the answer is always "never cache this", and the
 * ahead-of-time tier the whole Phase exists to fill would stay empty for ever.
 * A File source needs an identity of its own — the two failures a shared one
 * gives are collide-everything or cache-nothing, and neither is a cache.
 *
 * The identity is therefore WHAT THE FILE IS, not what it is called: the SHA-256
 * of every byte of it. Not the name (two files can share one), not the size
 * (many do), not a prefix plus the length — a prefix-and-length hash collides on
 * exactly the pair a file-manager copy produces, a re-tagged duplicate, or two
 * renders from one session, and each of those is a pair a DJ really does have on
 * disk. The whole point of the identity is that a wrong hit serves the wrong
 * stems, so the identity may not be an estimate of the file.
 *
 * WHAT IT COSTS, MEASURED RATHER THAN BUDGETED: ~0.31 s for 100 MB on this box,
 * three runs, `crypto.subtle.digest` on a warm 100 MB buffer in Node 22 — the
 * phase contract priced it at ~1 s, so the ruling holds with room to spare and
 * the figure is written down rather than left as a guess for the next reader.
 *
 * The cost is still real and it belongs on the "separating…" path, because the
 * key NAMES the track: it has to exist before the UI can say which track is
 * being worked on. Read the bytes, hash them, then tell the user — a spinner
 * that names the wrong track is worse than one that names none.
 */

/** The SHA-256 of the empty input, which is what every empty file hashes to. */
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

/** A file identity as this module spells one: SHA-256, lower-case hex. */
const isFileId = (id) => typeof id === 'string' && /^[0-9a-f]{64}$/.test(id);

/** `byteLength` if this really is a buffer, else null — "cannot look" stays visible. */
const byteLengthOf = (b) => (b instanceof ArrayBuffer || ArrayBuffer.isView(b) ? b.byteLength : null);

/**
 * The identity of a File source: SHA-256 over the whole file, lower-case hex.
 *
 * THROWS RATHER THAN RETURNING null, which is the opposite of `videoIdFromUrl`
 * one screen up, and the difference is the point. A page that is not a video
 * page is an ordinary answer — the user is on their subscriptions feed — so null
 * is information. A File source that reached here without its bytes is a broken
 * Host: `sourceBytes` (`shared/host.js`) is documented to reject rather than
 * return empty for this exact reason. A null here would flow straight into
 * `cacheKey(null, …)` and become the collision above, so it is not allowed to be
 * a value.
 *
 * `crypto.subtle` IS SECURE-CONTEXT-ONLY and is a Host duty nothing else in this
 * module needs: an extension page and an Electron renderer on a protocol
 * registered `secure` both have it, a plain `http://` one does not. Named here
 * because the failure is otherwise `Cannot read properties of undefined` from a
 * line that looks like arithmetic.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes  the ENCODED file, as `sourceBytes` hands it over
 * @returns {Promise<string>} 64 lower-case hex characters
 */
export async function fileIdFromBytes(bytes) {
  if (byteLengthOf(bytes) == null) {
    throw new Error(`stem cache: a file identity is the file's bytes, and none arrived (got ${
      bytes === null ? 'null' : typeof bytes})`);
  }
  const subtle = globalThis.crypto && globalThis.crypto.subtle;
  if (!subtle) {
    throw new Error('stem cache: crypto.subtle is absent, so a File source cannot be identified — '
      + 'the Host must serve the unit from a secure context');
  }
  const digest = new Uint8Array(await subtle.digest('SHA-256', bytes));
  let hex = '';
  for (const b of digest) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Identify a File source AND key it, in one call.
 *
 * ONE CALL BECAUSE THE HASH IS THE EXPENSIVE HALF. The caller needs the id for
 * the manifest and the key for the cache, and a surface that made it ask twice
 * would hash a 100 MB file twice for one separation — a second of wall clock
 * spent to produce a number it already had. This is the shape `offscreen/
 * engine.js`'s `trackKey()` already returns for a Live source (`{videoId, key}`);
 * it is the same job for a Source whose name is its content.
 *
 * THE ID IS EXACTLY 64 CHARACTERS AND `cacheKey` TRUNCATES AT 64. That is a fit,
 * not a coincidence to be relied on quietly: `cacheKey`'s `slice(0, 64)` exists
 * to bound a caller-supplied name, and a longer identity would be silently cut
 * down to one — still 236 bits and still safe, but no longer the digest anyone
 * could reproduce with `shasum`. The suite asserts the whole digest survives, so
 * a future prefix goes red here rather than becoming a key nobody can check.
 *
 * @param {ArrayBuffer|ArrayBufferView} bytes
 * @param {number} hopSeconds
 * @param {{depth?:16|32, geometry?:'causal'|'offline'}} [tier]
 * @returns {Promise<{id:string, key:string}>}
 */
export async function fileIdentity(bytes, hopSeconds, tier) {
  const id = await fileIdFromBytes(bytes);
  return { id, key: cacheKey(id, hopSeconds, tier) };
}

/**
 * May this File source start a separation? The File half of `primeRefusal`, and
 * it exists because `primeRefusal` cannot be used here: its first line refuses
 * on `!videoId`, and a File source correctly has none.
 *
 * Same contract as every other refusal in this file — `null` for "go ahead", a
 * human-readable reason otherwise — so a run that does not happen can say why
 * instead of being indistinguishable from one that failed.
 *
 * IT ANSWERS AFTER THE HASH AND BEFORE THE MODEL. `separationRefusal` above is
 * the capacity question and answers before the bytes are even fetched; this is
 * the identity question and needs the bytes in hand. Both run; neither replaces
 * the other.
 *
 * @param {string|null} fileId  from `fileIdFromBytes`
 * @param {ArrayBuffer|ArrayBufferView|null} bytes  the encoded file `sourceBytes` returned
 */
export function fileRefusal(fileId, bytes) {
  /**
   * THE ONE THAT MUST NOT REGRESS, and it is first for the same reason
   * `primeRefusal`'s is: this is where a caller that skipped the hash arrives.
   * `videoIdFromUrl(d.source && d.source.url)` (`offscreen/engine.js:548`)
   * returns `null` for a File source, and a caller that passed that value on
   * would be one line from `cacheKey(null, …)` — the key `'null--…'` every file
   * shares. Refusing makes that unreachable rather than merely unlikely.
   */
  if (!isFileId(fileId)) {
    return 'this source has no content identity (a file is keyed by its bytes, not its address)';
  }
  const n = byteLengthOf(bytes);
  if (n == null) return 'no bytes came back for this file';
  /**
   * AN EMPTY FILE HAS A PERFECTLY VALID-LOOKING IDENTITY — every one of them
   * hashes to `EMPTY_SHA256` — so the length is checked as well as the digest.
   * Either alone is a hole: the digest catches a caller that hashed nothing and
   * kept the id, the length catches one that passed a fresh empty buffer. A
   * zero-length source decodes to a zero-length track and caches as a track that
   * is silently not the track, which is what `sourceBytes` is documented to
   * throw rather than allow.
   */
  if (n === 0 || fileId === EMPTY_SHA256) return 'the file is empty';
  return null;
}

/**
 * May this separation become a cache entry? The File half of `commitRefusal`,
 * and it exists because `commitRefusal` cannot be used here either: it requires
 * `page.ended`, and a File source has no page transport at all — no content
 * script, no `<video>`, nothing to have ended.
 *
 * THERE IS NO TAIL TOLERANCE HERE, and that is the substantive difference from
 * the live policy rather than an omission. `PRIME_TAIL_MAX_SEC` exists because
 * the live pipeline is causal: when the capture stops, the last buffer's worth
 * of audio has not been separated and never will be, so every live prime is
 * about one buffer short and refusing that would refuse everything. An
 * ahead-of-time run over a decoded file has no deadline and no future it cannot
 * see — it knows the frame count before it starts, from the decode. So the
 * completeness test is EQUALITY, and a run that came up short is a bug in the
 * runner, not a track that ended early.
 *
 * COUNTS, NOT SECONDS. The evidence is two frame counters, and converting them
 * to seconds to compare them would only add a rounding boundary to argue about.
 *
 * @param {{aborted:boolean, frames:number}|null} writer
 * @param {{frames:number}|null} source  the DECODED source: what the file holds
 */
export function fileCommitRefusal(writer, source) {
  if (!writer) return 'nothing was being separated';
  if (writer.aborted) return 'the separation was cancelled';
  if (!writer.frames) return 'nothing was separated';
  /**
   * NO DECODED LENGTH IS A REFUSAL, NOT A DEFAULT — the same ruling
   * `primeRefusal` makes about a missing page transport. Committing on the
   * writer's own frame count alone would mean the entry is complete because the
   * only thing that could have contradicted it was absent.
   */
  if (!source || !(source.frames > 0)) return 'no decoded source to check completeness against';
  if (writer.frames !== source.frames) {
    const d = writer.frames - source.frames;
    const n = Math.abs(d);
    return `${n} frame${n === 1 ? '' : 's'} ${d < 0 ? 'short of' : 'past'} the file's ${source.frames}`;
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
 * PINS ARE A SET, NOT A KEY, AND THEY ARE RUNTIME STATE. A second tier can have
 * several entries open at once — two decks playing plus an export reading — and
 * every one of them is un-evictable while it is open. A single string cannot say
 * that. It stays accepted so the live path's one call site is unchanged.
 *
 * NOT PERSISTED, and that is deliberate: a pin written into the manifest would
 * survive a crash and leave an entry nothing could ever evict, which is a leak
 * that looks exactly like a cache doing its job.
 *
 * @param {{key:string, bytes:number, usedAt:number, title?:string}[]} entries
 * @param {number} maxBytes
 * @param {string|Iterable<string>|null} pins
 */
export function planEviction(entries, maxBytes, pins = null) {
  const pinned = pinSet(pins);
  let total = entries.reduce((a, e) => a + e.bytes, 0);
  const removed = [];
  // Ties broken by key so the order is deterministic rather than
  // implementation-defined; two entries used in the same millisecond is a real
  // case when a prime finishes and is immediately played.
  const order = entries.slice().sort((a, b) => (a.usedAt - b.usedAt) || (a.key < b.key ? -1 : 1));
  for (const e of order) {
    if (total <= maxBytes) break;
    if (pinned.has(e.key)) continue;
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
  constructor(maxBytes, dirName = CACHE_DIR, tier = {}) {
    this.maxBytes = maxBytes;
    this.dirName = dirName;
    /**
     * WHAT THE BYTES ON DISK ARE, and it lives on the instance because `put()`
     * has to encode at it and the manifest has to record it. 16 is the shipping
     * live tier and stays the default, so `new StemCache(cap)` is unchanged.
     */
    this.depth = tier.depth ?? 16;
    /** Which window produced the stems. See `pipelineVersion`. */
    this.geometry = tier.geometry ?? 'causal';
  }

  /**
   * The key for a track IN THIS TIER. Here rather than left to the caller
   * because the instance already knows its depth and geometry, and a caller
   * that computed the key with one tier and wrote it with another would produce
   * an entry whose name disagrees with its bytes — readable, plausible, wrong.
   */
  keyFor(id, hopSeconds) {
    return cacheKey(id, hopSeconds, { depth: this.depth, geometry: this.geometry });
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
      // The DEPTH IS THE INSTANCE'S. `float` is derived rather than passed so a
      // 32-bit tier cannot be written as 32-bit fixed point, which `encodeWav`
      // would accept and which no reader would flag.
      // NO DITHER at either depth — see the header. At 32f it would be noise
      // added to an exact representation; at 16 it is six independent noise
      // floors summed at playback.
      const wav = encodeWav(ch, {
        sampleRate: SR, bitDepth: this.depth, float: this.depth === 32, dither: false,
      });
      await writeFile(d, `${key}.${s}.wav`, wav);
      bytes += wav.byteLength;
    }
    const m = await loadManifest(d);
    const now = Date.now();
    m.entries = m.entries.filter((x) => x.key !== key);
    // Written LAST: until this line the entry does not exist, so an interrupted
    // prime cannot leave a readable-but-incomplete track in the cache.
    /**
     * `depth` and `geometry` are recorded as well as keyed. The key is what
     * stops a lookup crossing tiers; these are what let a reader, a UI or a
     * later migration ask what an entry IS without parsing its name.
     *
     * `drops` DEFAULTS TO 0 AND IS SPREAD OVER BY `meta`. An ahead-of-time run
     * cannot drop a chunk — there is no deadline to miss — so 0 is the truth for
     * it by construction, and `CacheWriter.commit()` passes the real count for a
     * live prime. Until now nothing recorded that a cached entry contains
     * passthrough spans, so no surface could warn about one.
     */
    m.entries.push({
      key, bytes, madeAt: now, usedAt: now, frames: stems[STEMS[0]][0].length,
      depth: this.depth, geometry: this.geometry, drops: 0, ...meta,
    });
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
  async evict(pins = null) {
    const d = await dir(this.dirName);
    const m = await loadManifest(d);
    const plan = planEviction(m.entries, this.maxBytes, pins);
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
    /**
     * Chunks the pipeline could not separate in time and published as
     * passthrough. They are real audio and the entry is still worth keeping —
     * but it is NOT six separated stems for that span, and until this counter
     * existed nothing on the entry said so. `commit()` carries it to the
     * manifest.
     *
     * NOTHING IN THE SHIPPING TREE CALLS `noteDrop()` YET, and that is said out
     * loud rather than left for a reader to discover: `offscreen/live.js` knows
     * when it published a passthrough span and is where the call belongs, and
     * wiring it is the live-recording slice's, not this one's. What lands here
     * is the field, the accessor and the round trip through the manifest, so the
     * slice that wires it has somewhere to write and something that already goes
     * red if the value stops arriving. An ahead-of-time run has no deadline to
     * miss and leaves this 0 by construction.
     */
    this.drops = 0;
  }

  /** One chunk went out unseparated. See `drops`. */
  noteDrop(n = 1) { this.drops += n; }

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
    /**
     * AND THE LENGTH HAS TO BE ONE THE PLANES CAN HONOUR.
     *
     * `slice(0, len)` CLAMPS: ask for more frames than a plane holds and it
     * hands back a shorter array without complaint, while `this.frames` advances
     * by the full `len`. The two then disagree, and `stems()` below builds a
     * buffer of `frames` and fills only part of it — so the entry commits with
     * DIGITAL SILENCE where the tail should be, reads back as the right length,
     * and sounds like a track that fades to nothing. That is the silently-stale
     * entry this whole file is written against, arriving through an argument
     * rather than through a stale key.
     *
     * A non-integer `len` is the other half: `frames += undefined` is NaN, and
     * `new Float32Array(NaN)` is empty, which turns the next `stems()` into a
     * `RangeError: offset is out of bounds` thrown from inside `set` — a crash
     * three layers from the mistake, with nothing naming the caller.
     */
    if (!Number.isInteger(len) || len < 0) {
      throw new Error(`stem cache: append needs an integer frame count, got ${typeof len} ${len}`);
    }
    for (let i = 0; i < STEMS.length * 2; i++) {
      if (planes[i].length < len) {
        throw new Error(`stem cache: append was asked for ${len} frames but plane ${i} holds `
          + `${planes[i].length} — slice() would shorten it silently while the frame counter took `
          + 'the full length, and the entry would commit with silence where the audio should be');
      }
    }
    for (let k = 0; k < STEMS.length; k++) {
      for (let c = 0; c < 2; c++) {
        this.chunks[k][c].push(planes[k * 2 + c].slice(0, len));
      }
    }
    this.frames += len;
  }

  /** A prime that was interrupted must not become a cache entry. */
  abort() { this.aborted = true; this.chunks = STEMS.map(() => [[], []]); this.frames = 0; this.drops = 0; }

  stems() {
    const out = {};
    STEMS.forEach((s, k) => {
      out[s] = [0, 1].map((c) => {
        const parts = this.chunks[k][c];
        /**
         * REPORTS RATHER THAN CRASHING. This used to assume the appended
         * lengths summed to `this.frames`, and when they did not it threw
         * `RangeError: offset is out of bounds` from inside `Float32Array.set`
         * — a stack trace with no caller in it, and, inside a suite, a crash
         * that takes the whole file's verdict down instead of failing one
         * assertion. `append()` above now refuses the inputs that cause it; this
         * is the second line, because the two counters are what the entry's
         * correctness rests on and a guard that names them is cheap.
         */
        let have = 0;
        for (const part of parts) have += part.length;
        if (have !== this.frames) {
          throw new Error(`stem cache: ${s} ${c ? 'R' : 'L'} holds ${have} frames but the writer `
            + `counted ${this.frames} — the appended lengths and the frame counter disagree, so this `
            + `entry would be ${have < this.frames ? 'padded with silence' : 'truncated'} rather than the track`);
        }
        const a = new Float32Array(this.frames);
        let o = 0;
        for (const part of parts) { a.set(part, o); o += part.length; }
        return a;
      });
    });
    return out;
  }

  async commit(cache) {
    if (this.aborted || this.frames === 0) return null;
    const meta = { ...this.meta, seconds: +(this.frames / SR).toFixed(2), drops: this.drops };
    const r = await cache.put(this.key, meta, this.stems());
    return { key: this.key, frames: this.frames, ...r };
  }
}
