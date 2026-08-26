#!/usr/bin/env node
/**
 * THE AUDIO-PATH CHECK FOR THE INFERENCE SEAM — real weights, real worker, real
 * ONNX Runtime, driven through the Host seam exactly as the extension drives it.
 *
 *   node tools/backend-audio.mjs [--model <path>] [--segments N>=2] [--gpu]
 *
 * WHY IT EXISTS. `CONTRIBUTING.md:190` — "new code that touches the audio path
 * needs the manual check too: load unpacked, play something, confirm you hear
 * it." S6 moved the inference worker behind a `Backend` interface, which is
 * about as central to the audio path as an edit gets, and every other gate in
 * this tree stops short of the model: `test.js`'s `backend` group drives a FAKE
 * backend on purpose, `tools/model-parity.mjs` reads the .onnx as a protobuf and
 * never runs it, and `tools/embed-smoke.mjs` never arms a tab. Nothing in the
 * repo had ever put a waveform in one end of the seam and looked at what came
 * out of the other.
 *
 * WHAT IT IS NOT. It is not a listening test and does not claim to be: an ear is
 * the only instrument for "does it sound right", and this reports numbers a
 * human can sanity-check instead. It is the strongest thing available to an
 * agent with no interactive Chrome, and the numbers are printed rather than only
 * thresholded so that the human check has something to read.
 *
 * ── what is driven ──────────────────────────────────────────────────────────
 * `offscreen/deck.js` `Deck` -> `shared/host.js` `serialiseBackend` ->
 * `workers/workerbackend.js` `WorkerBackend` -> `workers/inference.worker.js` ->
 * `engine/demucs.js` -> ORT -> the pinned 114,559,139-byte `htdemucs_6s.onnx`.
 * `Deck.infer()` goes through the real `GpuScheduler`, so the token, the
 * demotion checks and the estimator feed are all in the path too.
 *
 * The ONLY stubs are the things a browser tab would have supplied and that have
 * nothing to do with inference: the AudioContext (`null`, never touched on this
 * path), the master bus, the capture ring, and `modelBytes`, which hands over
 * the file from disk instead of the Cache API. There is no fake worker, no fake
 * session and no fake model anywhere below.
 *
 * ── why a browser at all ────────────────────────────────────────────────────
 * `extension/vendor/ort/ort.all.bundle.min.mjs` is the WEB build: it wants
 * `fetch`, a module `Worker` and WebAssembly instantiation from a URL. There is
 * no `onnxruntime-node` in this repo's dependencies (`package.json` has exactly
 * one: playwright), so a Node harness would have to vendor a second runtime and
 * would then be testing that one instead of the one that ships.
 *
 * The page is served over http with COOP/COEP so `crossOriginIsolated` is true
 * and ORT's threaded wasm can use SharedArrayBuffer. An extension page gets that
 * for free and this one does not; it is one of the two environmental differences
 * between this harness and the shipped extension.
 *
 * ── WHICH EP, AND WHY IT IS wasm BY DEFAULT ─────────────────────────────────
 * The other difference, and it is the one to read before quoting a timing from
 * here. Chromium under `xvfb` has no GPU, so its WebGPU adapter is the SOFTWARE
 * one — and `inference.worker.js` only falls back to wasm when
 * `InferenceSession.create(..., 'webgpu')` THROWS, which a software adapter does
 * not. Measured: the session came up, the GPU process grew past 4 GB, and one
 * segment had not finished after 35 minutes. That is not the shipped GPU path
 * and it is not a useful substitute for it — it is a rasteriser pretending.
 *
 * So `--disable-gpu` is the DEFAULT here, which takes the same code down the
 * `wasm` branch: a real, shipped fallback that every user without WebGPU gets,
 * and the one this box can run in minutes rather than hours. `--gpu` opts back
 * in for a machine that has a real adapter, where WebGPU is the path worth
 * measuring. The numbers below always say which EP produced them.
 *
 * ── the rule this file is written to ────────────────────────────────────────
 * AGENTS.md: an assertion must FAIL when it cannot look. There is no
 * skip-when-absent below. A missing model, a browser that will not start, a
 * session that will not create — each is a FAIL that names itself. A harness
 * that goes green because it could not find the thing it grades is the defect it
 * exists to catch.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { STEMS, SEGMENT, MODEL } from '../extension/shared/config.js';
import { MODEL_SEED_REL, modelSeed } from './host.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const MODEL_PATH = path.resolve(arg('--model', modelSeed(ROOT)));
/**
 * TWO IS THE FLOOR, not the default. A single segment cannot observe a WEDGED
 * session — that is what the second one is for — so `--segments 1` would be a
 * flag that guarantees a red rather than a cheaper run. Ask for more if you want
 * a longer soak; you cannot ask for less than the claim needs.
 */
const SEGMENTS = Math.max(2, Number(arg('--segments', '2')) || 2);
const WANT_GPU = argv.includes('--gpu');

let pass = 0;
let fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  PASS ${name}${detail ? '  ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? '  ' + detail : ''}`); }
};

/* ------------------------------------------------------------------ the file */
if (!fs.existsSync(MODEL_PATH)) {
  console.error(`backend-audio: the weights are not on disk: ${MODEL_PATH}\n`
    + `  -> bash tools/fetch-model.sh   (puts the pinned export at ${MODEL_SEED_REL})`);
  console.log('0 passed, 1 failed');
  process.exit(1);
}
const MODEL_SIZE = fs.statSync(MODEL_PATH).size;
if (MODEL_SIZE !== MODEL.bytes) {
  // A seed of the wrong SIZE is the 4-stem export still sitting on the machine.
  // Nothing downstream survives it and none of it says why.
  console.error(`backend-audio: the weights are the WRONG FILE: ${MODEL_PATH}\n`
    + `  -> ${MODEL_SIZE} bytes, but extension/shared/config.js pins ${MODEL.bytes}`);
  console.log('0 passed, 1 failed');
  process.exit(1);
}

/* ---------------------------------------------------------------- the server */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.json': 'application/json',
};

/**
 * The harness page. It is served rather than written into `extension/`, because
 * a file dropped into the unit would be picked up by `tools/tree-check.mjs` and
 * by S9's unit closure as if it shipped.
 *
 * It imports the SHIPPED modules by their real paths. Nothing is re-implemented
 * here: `run()` builds a `Deck` over a stub bundle and drives `ensureSession()`
 * and `infer()`, which is the same pair `LivePipeline` drives per chunk.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><title>backend-audio</title>
<script type="module">
import { Deck } from '/offscreen/deck.js';
import { WorkerBackend } from '/workers/workerbackend.js';
import { GpuScheduler } from '/engine/scheduler.js';
import { SEGMENT, SR, STEMS } from '/shared/config.js';

const log = [];
const say = (line) => { log.push(line); console.log('[backend-audio] ' + line); };

/**
 * A MIX WITH SOMETHING FOR EACH BRANCH TO FIND — 7.8 s at 44 100 Hz, stereo.
 *
 * Not noise and not a single tone: a separator handed white noise has nothing to
 * separate, and one handed a sine puts it all in whichever stem wins. This is a
 * bass line an octave below middle C, a three-note chord above it, a hi-hat-ish
 * noise burst on every eighth and a kick-ish thump on every beat, panned so the
 * two channels are not identical. It is synthetic and no one would call it
 * music; what it is is broadband, harmonic, transient and stereo, which are the
 * four things the model's branches respond to.
 */
function makeMix() {
  const n = SEGMENT;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  const bpm = 120;
  const beat = (60 / bpm) * SR;
  let seed = 12345;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return (seed / 0x3fffffff) - 1; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const bass = 0.35 * Math.sin(2 * Math.PI * 65.41 * t) * (0.6 + 0.4 * Math.sin(2 * Math.PI * t / 2));
    const chord = 0.12 * (Math.sin(2 * Math.PI * 261.63 * t)
      + Math.sin(2 * Math.PI * 329.63 * t) + Math.sin(2 * Math.PI * 392.0 * t));
    const lead = 0.15 * Math.sin(2 * Math.PI * 523.25 * t + 3 * Math.sin(2 * Math.PI * 5 * t));
    const phase = (i % beat) / beat;
    const kick = phase < 0.08 ? 0.5 * Math.sin(2 * Math.PI * 55 * t) * (1 - phase / 0.08) : 0;
    const eighth = (i % (beat / 2)) / (beat / 2);
    const hat = eighth < 0.02 ? 0.25 * rnd() * (1 - eighth / 0.02) : 0;
    L[i] = bass + chord + 0.7 * lead + kick + hat;
    R[i] = bass + 0.7 * chord + lead + kick + 0.6 * hat;
  }
  return { L, R };
}

const rms = (a) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * a[i]; return Math.sqrt(s / a.length); };
const peak = (a) => { let p = 0; for (let i = 0; i < a.length; i++) { const v = Math.abs(a[i]); if (v > p) p = v; } return p; };
const finite = (a) => { for (let i = 0; i < a.length; i++) if (!Number.isFinite(a[i])) return false; return true; };

window.run = async (segments) => {
  const t0 = performance.now();
  const gpu = new GpuScheduler({ priority: 'A', armed: true });
  const asked = [];
  const spawned = [];
  const shared = {
    ctx: () => null,
    master: () => null,
    gpu,
    modelBytes: async () => {
      const res = await fetch('/model.onnx');
      if (!res.ok) throw new Error('model fetch failed: HTTP ' + res.status);
      return await res.arrayBuffer();
    },
    send: () => {},
    log: (line) => say(line),
    armRefMs: () => 0,
    anyLoading: () => false,
    othersLoading: () => false,
    assetUrl: (rel) => { asked.push(rel); return new URL('/' + rel, location.href).href; },
    createBackend: (hooks) => { const b = new WorkerBackend({ assetUrl: shared.assetUrl, ...hooks }); spawned.push(b); return b; },
    onWorkerState: () => {},
    onModelProgress: (d, m) => say('phase ' + m.phase),
  };

  const deck = new Deck('A', shared);
  say('loading the weights and creating the session');
  await deck.ensureSession();
  const loadMs = performance.now() - t0;
  say('session ' + deck.ep + ' ready in ' + (loadMs / 1000).toFixed(1) + ' s — separating ' + segments + ' segment(s)');

  const { L, R } = makeMix();
  const mixRms = [rms(L), rms(R)];
  const runs = [];
  for (let s = 0; s < segments; s++) {
    const mixBuf = new ArrayBuffer(2 * SEGMENT * 4);
    const outBuf = new ArrayBuffer(STEMS.length * 2 * SEGMENT * 4);
    const mix = new Float32Array(mixBuf);
    mix.set(L, 0);
    mix.set(R, SEGMENT);
    const t1 = performance.now();
    const r = await deck.infer(mixBuf, outBuf, Infinity);
    const wallMs = performance.now() - t1;
    say('segment ' + s + ' back in ' + (wallMs / 1000).toFixed(1) + ' s');
    if (!r || r.demoted) { runs.push({ demoted: true, why: r && r.why }); continue; }
    const flat = new Float32Array(r.stems);
    const stems = STEMS.map((name, k) => {
      const l = flat.subarray((k * 2 + 0) * SEGMENT, (k * 2 + 1) * SEGMENT);
      const rr = flat.subarray((k * 2 + 1) * SEGMENT, (k * 2 + 2) * SEGMENT);
      return { name, rmsL: rms(l), rmsR: rms(rr), peak: Math.max(peak(l), peak(rr)), finite: finite(l) && finite(rr) };
    });
    // Sigma stems vs the mix: htdemucs reconstructs its input as the sum of its
    // sources, so this is the one numeric property of the OUTPUT that can be
    // checked without a reference separation.
    let num = 0; let den = 0;
    for (let ch = 0; ch < 2; ch++) {
      const src = ch === 0 ? L : R;
      for (let i = 0; i < SEGMENT; i++) {
        let sum = 0;
        for (let k = 0; k < STEMS.length; k++) sum += flat[(k * 2 + ch) * SEGMENT + i];
        const d = sum - src[i];
        num += d * d; den += src[i] * src[i];
      }
    }
    runs.push({
      wallMs, prepMs: r.prepMs, inferMs: r.inferMs, postMs: r.postMs,
      mixBytes: r.mix.byteLength, stemBytes: r.stems.byteLength,
      // The originals are DETACHED if they were really transferred rather than
      // copied — a detached ArrayBuffer reads byteLength 0. Identity is NOT the
      // test: a transfer moves the memory and hands back a NEW wrapper object,
      // which is exactly why LivePipeline.runChunk re-adopts with
      // this.mixBuf = res.mix instead of assuming its own is still good.
      lentMix: mixBuf.byteLength, lentOut: outBuf.byteLength,
      residualDb: 20 * Math.log10(Math.sqrt(num) / Math.sqrt(den)),
      stems,
    });
  }
  return {
    ep: deck.ep, session: deck.session, threads: deck.threads, adapter: deck.adapter,
    loadMs, mixRms, runs, log, asked, spawned: spawned.length,
    stemOrder: STEMS, segment: SEGMENT, sr: SR,
  };
};
</script>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  const head = {
    // crossOriginIsolated, so ORT's threaded wasm may use SharedArrayBuffer.
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
  };
  if (url.pathname === '/' || url.pathname === '/index.html') {
    res.writeHead(200, { ...head, 'Content-Type': MIME['.html'] });
    res.end(PAGE);
    return;
  }
  if (url.pathname === '/model.onnx') {
    res.writeHead(200, { ...head, 'Content-Type': MIME['.onnx'], 'Content-Length': String(MODEL_SIZE) });
    fs.createReadStream(MODEL_PATH).pipe(res);
    return;
  }
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(ROOT, 'extension', rel);
  // Refuse anything outside extension/ — this server reads the repo.
  if (!file.startsWith(path.join(ROOT, 'extension') + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, head);
    res.end('not here');
    return;
  }
  res.writeHead(200, { ...head, 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

/**
 * HEADLESS, UNLIKE `tools/embed-smoke.mjs`. That one is headed because MV3
 * service workers do not load in the headless shell; there is no extension here
 * and no service worker, so this needs no display and does not ask for one.
 */
const browser = await chromium.launch({
  args: [
    '--no-sandbox', '--disable-dev-shm-usage',
    // See the EP note at the head of this file. Software WebGPU does not throw,
    // so the worker never falls back, and one segment on a rasteriser is hours.
    ...(WANT_GPU ? ['--enable-unsafe-webgpu'] : ['--disable-gpu']),
  ],
});
let out = null;
let boom = null;
const consoleLines = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => {
    const text = m.text();
    consoleLines.push(`${m.type()}: ${text}`);
    // The page's own progress markers, printed as they land. A wasm-EP segment
    // is minutes, and a harness that prints nothing for ten of them is
    // indistinguishable from one that has hung.
    if (text.startsWith('[backend-audio]')) console.log(`  ${text.replace('[backend-audio]', '·')}`);
  });
  page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
  await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await page.waitForFunction('typeof window.run === "function"', null, { timeout: 30_000 });
  // `page.evaluate` has no timeout of its own, which is what this needs: a
  // wasm-EP segment on a machine with no GPU is minutes, not seconds.
  out = await page.evaluate((n) => window.run(n), SEGMENTS);
} catch (e) {
  boom = e;
} finally {
  await browser.close().catch(() => {});
  server.close();
}

/* ------------------------------------------------------------------ verdict */
console.log('');
if (!out) {
  ok('the seam ran one segment through the real weights', false,
    `the harness could not complete: ${boom && boom.message}\n       ${consoleLines.slice(-8).join('\n       ')}`);
  console.log(`\nbackend-audio: ${pass} passed, ${fail} failed`);
  process.exit(1);
}

console.log(`  · ${MODEL_PATH} (${MODEL_SIZE} B), EP ${out.ep}, threads ${out.threads}, `
  + `adapter ${out.adapter ? out.adapter.vendor + '/' + out.adapter.architecture : 'none'}, `
  + `session in ${(out.loadMs / 1000).toFixed(1)} s`);
console.log('');

ok('THE SESSION CAME UP ON THE REAL WEIGHTS, THROUGH THE REAL SEAM  '
  + '[entry point: offscreen/deck.js ensureSession() -> shared/host.js -> workers/workerbackend.js]',
  out.session === 'ready' && (out.ep === 'webgpu' || out.ep === 'wasm') && out.spawned === 1,
  out.session !== 'ready'
    ? `the deck ended ${out.session}`
    : `ep ${out.ep}, ${out.spawned} backend built`);

ok('...and the Host was asked for the ORT directory and NOTHING ELSE on this path  '
  + '[entry point: workers/workerbackend.js, the Host resolver it was handed]',
  out.asked.length > 0 && out.asked.every((p) => p.startsWith('vendor/ort/')),
  out.asked.length === 0 ? 'the resolver was never called, so this inspected nothing' : out.asked.join(', '));

const good = out.runs.filter((r) => !r.demoted);
/**
 * EVERY SEGMENT RAN — no demotion, no throw, and the second one is the half that
 * matters: it is the only thing here that could observe a WEDGED session, which
 * is what a concurrent `run()` on one wasm instance leaves behind and what the
 * seam's queue exists to make unreachable. A suite that separated one segment
 * and stopped would be green on a worker that can never separate another.
 */
ok(`ALL ${out.runs.length} SEGMENT(S) SEPARATED ON ONE SESSION — no demotion, no throw, and nothing wedged behind the first  `
  + '[entry point: offscreen/deck.js infer() through GpuScheduler, over the real ORT session]',
  good.length === out.runs.length && good.length > 1,
  good.length === 0
    ? 'nothing ran at all'
    : good.length < 2
      ? `only ${good.length} segment ran, so a session wedged by the first could not have been seen`
      : out.runs.map((r) => (r.demoted ? `demoted: ${r.why}` : `${(r.wallMs / 1000).toFixed(1)} s`)).join(', '));

for (const [i, r] of good.entries()) {
  const tag = good.length > 1 ? ` [segment ${i}]` : '';
  ok(`THE BUFFERS WERE LENT AND CAME BACK — MOVED, NOT COPIED, IN BOTH DIRECTIONS${tag}  `
    + '[entry point: workers/workerbackend.js separate(), through the real worker]',
    r.lentMix === 0 && r.lentOut === 0
    && r.mixBytes === 2 * SEGMENT * 4 && r.stemBytes === STEMS.length * 2 * SEGMENT * 4,
    r.lentMix !== 0 || r.lentOut !== 0
      ? `the caller's originals are still attached (${r.lentMix} B / ${r.lentOut} B) — nothing was transferred, so `
        + '19.3 MB was copied across the thread boundary instead, twice, per hop'
      : r.mixBytes !== 2 * SEGMENT * 4 || r.stemBytes !== STEMS.length * 2 * SEGMENT * 4
        ? `what came back is the wrong size: mix ${r.mixBytes} B, stems ${r.stemBytes} B — the caller re-adopts `
          + 'these for the next segment'
        : `out ${2 * SEGMENT * 4} + ${STEMS.length * 2 * SEGMENT * 4} B detached, back ${r.mixBytes} + ${r.stemBytes} B `
          + `(${STEMS.length} stems x 2 ch x ${SEGMENT} floats)`);

  const table = r.stems.map((s) => `${s.name} ${s.rmsL.toFixed(4)}/${s.rmsR.toFixed(4)}`).join('  ');
  ok(`${STEMS.length * 2} STEM PLANES CAME BACK, EACH WITH FINITE, NON-SILENT AUDIO${tag}  `
    + `[entry point: engine/demucs.js postProcess(), layout (k*2+ch)*SEGMENT+i, mix RMS ${out.mixRms[0].toFixed(4)}/${out.mixRms[1].toFixed(4)}]`,
    r.stems.length === STEMS.length
    && r.stems.every((s) => s.finite && s.rmsL > 0 && s.rmsR > 0 && s.peak < 8),
    r.stems.length !== STEMS.length
      ? `${r.stems.length} planes, not ${STEMS.length}`
      : r.stems.some((s) => !s.finite)
        ? `a stem carries NaN or Infinity: ${r.stems.filter((s) => !s.finite).map((s) => s.name).join(', ')}`
        : r.stems.some((s) => s.rmsL <= 0 || s.rmsR <= 0)
          ? `a stem is digital silence in a channel: ${r.stems.filter((s) => s.rmsL <= 0 || s.rmsR <= 0).map((s) => s.name).join(', ')}`
          : r.stems.some((s) => s.peak >= 8)
            ? `a stem clips absurdly: ${r.stems.filter((s) => s.peak >= 8).map((s) => `${s.name} ${s.peak.toFixed(1)}`).join(', ')}`
            : table);

  /**
   * AND THE LABELS LINE UP WITH THE MODEL'S CHANNELS — which is an ORDER claim,
   * and the one thing the block above deliberately does not make.
   *
   * `tools/model-parity.mjs` pins `STEMS` against the PyTorch checkpoint's
   * `model.sources` by hash, because a graph carries no source names. That check
   * is about the file. This one is about the running system, and it is possible
   * only because the input is known: the synthetic mix has a bass line, a kick,
   * a hat and a chord in it, and NO voice, NO guitar and NO piano. So the three
   * loud planes must be exactly `drums`, `bass` and `other`, and the three that
   * are all but silent must be exactly `vocals`, `guitar` and `piano`.
   *
   * Any permutation — of `STEMS`, of the model's channel order, of the plane
   * stride — moves a loud stem onto a quiet label. Nothing else here would
   * notice: a permutation preserves every RMS in the set, preserves the sum, and
   * preserves the buffer's size.
   *
   * The margin is three orders of magnitude wide (measured: loud 0.059 to 0.166,
   * quiet 0.00004 to 0.00011), so the thresholds are not tuned to a machine.
   */
  const LOUD = ['drums', 'bass', 'other'];
  const QUIET = ['vocals', 'guitar', 'piano'];
  const byName = new Map(r.stems.map((s, k) => [STEMS[k], s]));
  const loudOk = LOUD.every((n) => byName.get(n) && byName.get(n).rmsL > 0.01);
  const quietOk = QUIET.every((n) => byName.get(n) && byName.get(n).rmsL < 0.001);
  ok(`...AND THE LABELS LINE UP WITH THE MODEL'S CHANNELS: an input with no voice, guitar or piano in it puts its energy in the other three${tag}  `
    + '[entry point: shared/config.js STEMS against the running graph — the FILE is pinned by tools/model-parity.mjs]',
    loudOk && quietOk,
    !loudOk
      ? `a stem that must carry this mix is silent: ${LOUD.filter((n) => !(byName.get(n) && byName.get(n).rmsL > 0.01)).join(', ')} — `
        + `got ${LOUD.map((n) => `${n} ${byName.get(n) ? byName.get(n).rmsL.toFixed(5) : 'missing'}`).join(', ')}`
      : !quietOk
        ? `a stem that must be empty is not: ${QUIET.map((n) => `${n} ${byName.get(n) ? byName.get(n).rmsL.toFixed(5) : 'missing'}`).join(', ')} — `
          + 'the labels and the model\'s channels have drifted apart'
        : `loud ${LOUD.map((n) => byName.get(n).rmsL.toFixed(3)).join('/')}, quiet ${QUIET.map((n) => byName.get(n).rmsL.toFixed(5)).join('/')}`);

  /**
   * Σ SOURCES REBUILDS THE MIX. This is `docs/AUDIO.md`'s own definition of the
   * model's job and the only property of the OUTPUT that can be checked without
   * a reference separation: htdemucs is trained to decompose its input, so the
   * six stems must add back up to what went in. It is also the assertion that
   * would catch the whole class of layout mistakes — a transposed stride, a
   * channel swap, an off-by-one plane — none of which changes any RMS enough to
   * notice but all of which destroy the sum.
   *
   * The threshold is loose on purpose: the export is not bit-exactly
   * conservative (the time branch and the iSTFT of the freq branch are summed in
   * float32 over 343,980 samples). What it is not is uncorrelated, which is what
   * a layout bug produces — a wrong layout lands near 0 dB, not near -20.
   */
  ok(`Σ STEMS RECONSTRUCTS THE MIX${tag} — the model's own definition of its job, and what a layout mistake destroys  `
    + '[entry point: the flat stems buffer, summed per channel against the input]',
    Number.isFinite(r.residualDb) && r.residualDb < -12,
    `residual ${r.residualDb.toFixed(1)} dB  (prep ${r.prepMs.toFixed(0)} ms, infer ${r.inferMs.toFixed(0)} ms, post ${r.postMs.toFixed(0)} ms)`);
}

console.log('');
console.log('  per-stem RMS (L/R) and peak — for the human half of the audio-path check:');
for (const [i, r] of good.entries()) {
  console.log(`    segment ${i}:`);
  for (const s of r.stems) {
    console.log(`      ${s.name.padEnd(7)} rms ${s.rmsL.toFixed(5)} / ${s.rmsR.toFixed(5)}   peak ${s.peak.toFixed(4)}`);
  }
  console.log(`      ${'Σ'.padEnd(7)} residual vs mix ${r.residualDb.toFixed(1)} dB   (mix rms ${out.mixRms[0].toFixed(5)} / ${out.mixRms[1].toFixed(5)})`);
}

console.log(`\nbackend-audio: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
