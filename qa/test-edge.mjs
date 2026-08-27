/**
 * QA additions to `node test.js` — the cases the dev's 45 checks do not cover.
 * No browser, no deps.
 *
 *   node qa/test-edge.mjs
 *
 * Everything here was written after observing the real pipeline.
 */
import { encodeWav, decodeWav } from '../extension/shared/wav.js';
import { SEGMENT, STRIDE, SR } from '../extension/shared/config.js';
import { RingConsumer, ringByteLength } from '../extension/shared/ring.js';

let pass = 0, fail = 0;
const ok = (n, c, d = '') => { c ? (pass++, console.log(`  \x1b[32mPASS\x1b[0m ${n}${d ? '  ' + d : ''}`))
                                 : (fail++, console.log(`  \x1b[31mFAIL\x1b[0m ${n}${d ? '  ' + d : ''}`)); };
const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);
const noise = (n, seed = 1) => { let s = seed >>> 0; const x = new Float32Array(n);
  for (let i = 0; i < n; i++) { s = (s * 1664525 + 1013904223) >>> 0; x[i] = (s / 4294967296) * 2 - 1; } return x; };
const residualDb = (a, b) => { let n = 0, d = 0; for (let i = 0; i < a.length; i++) { const e = a[i] - b[i]; n += e * e; d += b[i] * b[i]; }
  return d === 0 ? (n === 0 ? -Infinity : Infinity) : 10 * Math.log10(n / d); };

// ===========================================================================
head('wav — degenerate buffers');
{
  const z = encodeWav([new Float32Array(0), new Float32Array(0)], { sampleRate: SR });
  const back = decodeWav(z);
  ok('0 frames encodes to a valid, readable RIFF (58-byte header, no data)',
    back.channels[0].length === 0 && z.byteLength === 58, `${z.byteLength} bytes`);
}
{
  const one = encodeWav([Float32Array.of(0.5), Float32Array.of(-0.5)], { sampleRate: SR });
  ok('1 frame round-trips', decodeWav(one).channels[1][0] === -0.5);
}
{
  const m = encodeWav([noise(100, 2)], { sampleRate: SR });
  const d = decodeWav(m);
  ok('mono encodes and decodes as 1 channel', d.channels.length === 1 && d.channels[0].length === 100);
}
{
  let threw = false;
  try { decodeWav(new Uint8Array(64).fill(7).buffer); } catch { threw = true; }
  ok('garbage bytes are rejected, not silently mis-parsed', threw);
}
{
  // BUG (QA-04, informational): a data chunk that claims more bytes than the
  // file holds is silently truncated instead of rejected.
  const buf = new Uint8Array(encodeWav([noise(1000, 3), noise(1000, 4)], { sampleRate: SR }));
  new DataView(buf.buffer).setUint32(54, 0x7ffffff0, true);
  let frames = -1, threw = false;
  try { frames = decodeWav(buf.buffer).channels[0].length; } catch { threw = true; }
  ok('a lying dataSize is clamped to the real file length (documented leniency, not a throw)',
    !threw && frames === 1000, `${frames} frames`);
}
{
  // AUDIO.md §5.3: assert rather than emit a corrupt file past the RIFF limit.
  let threw = false;
  try { encodeWav([{ length: 0x20000000 }, { length: 0x20000000 }], { sampleRate: SR }); } catch { threw = true; }
  ok('a buffer past the 4 GiB RIFF limit throws instead of wrapping the size field', threw);
}

// ===========================================================================
head('wav — the exported header is exactly what a DAW needs (AC-2.3.b)');
{
  const buf = encodeWav([noise(64, 5), noise(64, 6)], { sampleRate: SR, bitDepth: 32, float: true });
  const dv = new DataView(buf);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  ok('fact chunk numFrames equals the data chunk frame count',
    tag(38) === 'fact' && dv.getUint32(46, true) === dv.getUint32(54, true) / 8);
  ok('RIFF size field is consistent with the real byte length',
    dv.getUint32(4, true) + 8 === buf.byteLength);
}

// ===========================================================================
head('ring — overrun accounting when the producer laps the consumer mid-capture');
if (typeof SharedArrayBuffer !== 'function') ok('SharedArrayBuffer available in node', false, 'not in this build');
else {
  const CAP = 1 << 10;
  const sab = new SharedArrayBuffer(ringByteLength(CAP));
  const ring = new RingConsumer(sab, CAP);
  const hdr = new Int32Array(sab, 0, 16);
  const pl = new Float32Array(sab, 64, CAP), pr = new Float32Array(sab, 64 + CAP * 4, CAP);
  // write 3.5 capacities without a single drain — the R0-documented failure mode
  const total = CAP * 3 + CAP / 2;
  for (let i = 0; i < total; i++) { pl[i & (CAP - 1)] = i; pr[i & (CAP - 1)] = -i; }
  Atomics.store(hdr, 0, total);
  const d = ring.drain();
  ok('an overrun returns exactly `capacity` frames and reports the rest as dropped',
    d.l.length === CAP && d.dropped === total - CAP, `${d.l.length} frames, ${d.dropped} dropped`);
  ok('the frames returned after an overrun are the NEWEST ones, in order',
    d.l[d.l.length - 1] === total - 1 && d.l[0] === total - CAP);
  ok('`dropped` is non-zero, so the offscreen document can refuse to claim a lossless capture',
    d.dropped > 0, `${d.dropped}`);
}

// ===========================================================================
head('config — constants still match the ONNX graph');
ok('SEGMENT / STRIDE / SR / overlap', SEGMENT === 343980 && STRIDE === 257985 && SR === 44100 &&
  STRIDE === Math.floor(SEGMENT * 0.75), `${SEGMENT} ${STRIDE} ${SR}`);
ok('STRIDE < SEGMENT, so consecutive windows overlap at all', STRIDE < SEGMENT);
/**
 * WHAT THE OVERLAP ACTUALLY BUYS — MEASURED, because the line above used to claim
 * it in its NAME and never check it.
 *
 * It was called "STRIDE < SEGMENT so every interior sample gets >= 2
 * contributions". The inequality is true and the sentence is not: two everywhere
 * would need STRIDE <= SEGMENT/2, and 257 985 > 171 990. At this stride a sample
 * is covered ONCE OR TWICE, and 72.7 % of a long track is covered exactly once.
 * Everyone downstream read the name — this file, the Phase 4 contract, and the
 * brief for the ahead-of-time runner all repeated it before anyone counted.
 *
 * The real property is the one this asserts, and the overlap-add in
 * `extension/engine/offline.js` depends on it: a cover count that is NOT CONSTANT
 * is one you cannot divide by, which is why its joins use complementary ramps
 * that already sum to one rather than accumulating a weight and normalising
 * afterwards.
 */
{
  const n = STRIDE * 6 + SEGMENT;
  const windows = Math.ceil((n - SEGMENT) / STRIDE) + 1;
  const cover = new Uint8Array(n);
  for (let k = 0; k < windows; k++) {
    for (let i = k * STRIDE; i < Math.min(n, k * STRIDE + SEGMENT); i++) cover[i]++;
  }
  const seen = [...new Set(cover)].sort((a, b) => a - b);
  const once = cover.reduce((a, c) => a + (c === 1 ? 1 : 0), 0);
  ok('...and a sample is covered ONCE or TWICE — never none, never three — so an '
    + 'overlap-add over this geometry cannot divide by a constant cover count',
  seen.length === 2 && seen[0] === 1 && seen[1] === 2 && once > n / 2 && windows > 2,
  `${windows} windows, coverage {${seen.join(',')}}, ${once} of ${n} covered once`);
}

console.log(`\n${fail ? '\x1b[31m' : '\x1b[32m'}${pass} passed, ${fail} failed\x1b[0m`);
process.exit(fail ? 1 : 0);
