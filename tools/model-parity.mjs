#!/usr/bin/env node
/**
 * THE PARITY GATE — does the pinned ONNX file still match what `engine/demucs.js`
 * believes about it, and does `shared/config.js` still match what was read off
 * the real PyTorch checkpoint?
 *
 *   node tools/model-parity.mjs [--model <path>]     (~2 s, no browser, no deps)
 *
 * WHY THIS FILE EXISTS. A demucs export with the wrong STFT channel packing, the
 * wrong source order, or swapped output ranks still runs, still returns six
 * confident-looking stems, and is silently WRONG. Nothing in the product can
 * detect any of the three at runtime — `keytap.js`'s `tap-point-is-the-other-stem`
 * only checks that `STEMS` agrees with ITSELF, not that it agrees with the
 * checkpoint. This is the tripwire for that whole class.
 *
 * ── what is verified HERE, on every run ──────────────────────────────────────
 * The graph facts, read straight out of the .onnx protobuf: the two input names
 * and shapes IN POSITIONAL ORDER (`demucs.js` binds `inputNames[0]`/`[1]`), the
 * two output ranks and shapes (`demucs.js` dispatches on `dims.length`, so
 * "exactly one rank-5 and exactly one rank-4" is a precondition, not a detail),
 * that both INPUT axes are static, and the file's identity by size and SHA-256.
 * The time branch is declared with symbolic axis NAMES and ORT resolves them off
 * the static inputs — see the note above that assertion before "tightening" it.
 *
 * ── what is verified ELSEWHERE, and pinned here by hash ──────────────────────
 * `model.sources` is NOT recoverable from an .onnx file — the graph carries no
 * source names. It was read off the real `htdemucs_6s` PyTorch checkpoint
 * (demucs 4.1.0, `get_model('htdemucs_6s').sources`) and is recorded below as
 * VERIFIED_SOURCES. That fixture is only meaningful for the exact bytes it was
 * taken against, which is why `model-sha256-matches-the-pin` is not a
 * nice-to-have: IF THE HASH MOVES, THE SOURCE ORDER IS UNVERIFIED AGAIN and the
 * red on that check is the instruction to re-run the PyTorch comparison. Do not
 * "fix" a hash mismatch by editing the hash.
 *
 * The same script also measured that the channel-major `[L.re, L.im, R.re, R.im]`
 * packing is the correct one — uniquely, against a sweep of the alternatives.
 * That is a numeric claim about audio, it needs PyTorch to re-check, and it is
 * deliberately NOT faked here: the upstream torch reference is the re-run, and its
 * per-stem output is held to a policy by the PARITY_EVIDENCE block below.
 *
 * ── the rule this file is written to ─────────────────────────────────────────
 * AGENTS.md: an assertion must FAIL when it cannot look. There is no `!model ||`
 * anywhere below. A missing model file, an unreadable config, a graph whose
 * inputs will not parse — each is a FAIL that names itself, never a skip. The
 * cost of that choice is that this gate needs the 114 MB file on disk; the
 * failure message says exactly how to get it. A gate that goes green because it
 * could not find the thing it grades is the defect it is meant to catch.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Read off `get_model('htdemucs_6s').sources`, demucs 4.1.0 / torch 2.13.0,
 * against the file whose SHA-256 is `MODEL.sha256` in shared/config.js.
 * `other` at index 2 is what keeps `keytap.js`'s KEY_TAP_PLANE_L/R = 4/5 valid.
 */
const VERIFIED_SOURCES = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

/**
 * PARITY EVIDENCE — recorded, not measured here. Regenerate with:
 *
 *     python3 tools/parity-ref.py   (not in this repo — see the note below)
 *
 * A real parity run needs torch, demucs 4.1.0 and the PyTorch checkpoint, so it
 * CANNOT be part of a hermetic 2 s gate and this file does not pretend otherwise.
 * What it can do is hold the last run's numbers to a policy, so a re-run that
 * came out worse — or never covered a stem at all — cannot be pasted in quietly.
 *
 * `rms` IS THE LOAD-BEARING COLUMN, and it is why this block exists at all.
 * The residual and correlation say how close ONNX was to PyTorch; `rms` says how
 * much signal that stem actually had when the comparison was made. The first
 * parity run scored `other` at 2.8e-07 residual and looked immaculate — on a
 * stem the model had put at 5.7e-05 RMS, i.e. silence. A packing or index error
 * confined to `other` would have passed it, and `other` is the one stem
 * `engine/keytap.js` taps. `LOW_SIGNAL_FLOOR` turns that from a footnote into a
 * red: a stem whose evidence was gathered near silence FAILS here.
 *
 * ── THE ONE FRAMING (quote this, with its population, and nothing else) ──────
 * Three ranges for this same result were once in circulation — 4.4e-05 vs
 * 0.57-0.98, 4.06e-05 vs 0.47-1.04, and 2.3e-05 vs 2.8e-02 — because each was
 * taken off a different case set and a different denominator and none of them
 * said which. The last was also simply stale. An unqualified range is how that
 * happened, so every number below names its population.
 *
 * Denominator throughout: the L2 norm of the INPUT SEGMENT. Never ||ref_stem||,
 * which collapses toward zero on a stem the model left silent.
 *
 *   population                                     ours            wrong packings
 *   all 5 cases x 3 wrong packings, whole-tensor   2.43e-05..4.13e-05   0.0515..1.318
 *     -> worst-case separation min(wrong)/max(ours) = 1246x
 *   real-music cases only, whole-tensor            4.06e-05..4.13e-05   0.4699..1.037
 *   synthetic high-signal only, whole-tensor       2.43e-05..4.10e-05   0.0515..1.318
 *   per-stem, RMS >= 0.01, whole-stem (n=15)       7.69e-06..4.07e-05   0.00181..0.9414
 *
 * THE CONSERVATIVE BOUND IS THE PER-STEM ONE, and it is quoted because it is the
 * tightest honest number: `bass` at 0.094 RMS under the channel-swap packing D on
 * real clip_mix@0 lands at 0.00181 against our 1.19e-05 — only 152x. Bass is
 * near-mono in these mixes, so swapping L and R barely moves it. Still decisive,
 * but it is 152x and not 1246x, and a reader leaning on the safety margin should
 * be leaning on the smaller one.
 *
 * These values were computed from the checkpoint by a torch reference, which COMPUTES the
 * framing into its `headline` block rather than anyone transcribing it. They are
 * valid only for PARITY_EVIDENCE_SHA below; that is what the staleness assertion
 * is for.
 */
const PARITY_EVIDENCE_SHA = 'b19cdf832edeb50274b36d6928a8bf83202237c71a4836c4cca45e843316ee17';
const PARITY_EVIDENCE = {
  drums:  { rms: 0.090301, resid: 1.916e-5, corr: 1.0,       case: 'real clip_mix@0' },
  bass:   { rms: 0.099306, resid: 1.099e-5, corr: 1.0,       case: 'real clip60_mix@343980' },
  other:  { rms: 0.19317,  resid: 4.073e-5, corr: 1.0,       case: 'synth string pad' },
  vocals: { rms: 0.14196,  resid: 2.034e-5, corr: 1.0,       case: 'real clip60_mix@1400000' },
  guitar: { rms: 0.085895, resid: 2.361e-5, corr: 1.0,       case: 'real clip60_mix@343980' },
  piano:  { rms: 0.18497,  resid: 2.298e-5, corr: 0.9999999, case: 'synth organ' },
};
/** Below this RMS a stem's parity result is a statement about silence. */
const LOW_SIGNAL_FLOOR = 0.01;
/**
 * Per-stem, above the signal floor, ours ran 7.69e-06..4.07e-05 and the nearest
 * wrong packing was 1.81e-03 (`bass` under the channel swap). 1e-3 sits between
 * them, ~25x above our worst and just under the tightest wrong one.
 */
const RESID_GATE = 1e-3;
const CORR_GATE = 0.9999;

/** Graph shape contract, from engine/demucs.js's MODEL INPUT CONTRACT header. */
const SEGMENT = 343980, BINS = 2048, FRAMES = 336;
const WANT_IN = [[1, 2, SEGMENT], [1, 4, BINS, FRAMES]];
const WANT_FREQ = [1, VERIFIED_SOURCES.length, 4, BINS, FRAMES];
const WANT_TIME = [1, VERIFIED_SOURCES.length, 2, SEGMENT];

// ─────────────────────────────────────────────────── a minimal .onnx reader
// Enough protobuf to walk ModelProto -> GraphProto -> input/output ValueInfo.
// Node bodies and initializers are skipped by length and never decoded, so this
// stays fast on a 114 MB file.
function varint(buf, p) {
  let x = 0, shift = 0;
  for (;;) {
    if (p >= buf.length) throw new Error('truncated varint');
    const b = buf[p++];
    x += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) return [x, p];
    shift += 7;
    if (shift > 63) throw new Error('varint too long');
  }
}

function* fields(buf, start, end) {
  let p = start;
  while (p < end) {
    const [key, p1] = varint(buf, p);
    const field = key >>> 3, wire = key & 7;
    let vs = p1, ve, v = null;
    if (wire === 0) { [v, ve] = varint(buf, p1); vs = p1; }
    else if (wire === 1) ve = p1 + 8;
    else if (wire === 2) { const [len, p2] = varint(buf, p1); vs = p2; ve = p2 + len; }
    else if (wire === 5) ve = p1 + 4;
    else throw new Error(`unsupported wire type ${wire} at ${p}`);
    if (ve > end) throw new Error('field overruns its parent');
    yield { field, wire, vs, ve, v };
    p = ve;
  }
}

const sub = (buf, s, e, want) => {
  for (const f of fields(buf, s, e)) if (f.field === want && f.wire === 2) return f;
  return null;
};

/** TensorShapeProto.Dimension -> a Number (static) or a String (dynamic axis). */
function dimension(buf, s, e) {
  for (const f of fields(buf, s, e)) {
    if (f.field === 1 && f.wire === 0) return f.v;                        // dim_value
    if (f.field === 2 && f.wire === 2) return buf.toString('utf8', f.vs, f.ve); // dim_param
  }
  return null;                                                            // rank-known, dim unknown
}

/** ValueInfoProto -> { name, dims }. `dims === null` means the type was absent. */
function valueInfo(buf, s, e) {
  let name = null, dims = null;
  for (const f of fields(buf, s, e)) {
    if (f.field === 1 && f.wire === 2) name = buf.toString('utf8', f.vs, f.ve);
    else if (f.field === 2 && f.wire === 2) {              // TypeProto
      const t = sub(buf, f.vs, f.ve, 1);                   // .tensor_type
      if (t) {
        const sh = sub(buf, t.vs, t.ve, 2);                // .shape
        if (sh) {
          dims = [];
          for (const d of fields(buf, sh.vs, sh.ve)) {
            if (d.field === 1 && d.wire === 2) dims.push(dimension(buf, d.vs, d.ve));
          }
        }
      }
    }
  }
  return { name, dims };
}

function readGraph(buf) {
  const g = sub(buf, 0, buf.length, 7);                     // ModelProto.graph
  if (!g) throw new Error('no GraphProto (field 7) in this file — not an ONNX model?');
  const inputs = [], outputs = [], initializers = new Set();
  for (const f of fields(buf, g.vs, g.ve)) {
    if (f.field === 11 && f.wire === 2) inputs.push(valueInfo(buf, f.vs, f.ve));
    else if (f.field === 12 && f.wire === 2) outputs.push(valueInfo(buf, f.vs, f.ve));
    else if (f.field === 5 && f.wire === 2) {               // TensorProto.name = 1
      const n = sub(buf, f.vs, f.ve, 1);
      if (n) initializers.add(buf.toString('utf8', n.vs, n.ve));
    }
  }
  // Older IR versions list initializers as graph inputs too; ORT hides those, and
  // `demucs.js` indexes the ORT view, so match it.
  return { inputs: inputs.filter((i) => !initializers.has(i.name)), outputs };
}

// ─────────────────────────────────────────────────────────────── assertions
let pass = 0, fail = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`  PASS ${name}${detail ? `  ${detail}` : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? `  ${detail}` : ''}`); }
}

/**
 * Everything this gate inspects is loaded HERE, and every failure to load is
 * reported as a failed named assertion rather than a crash or an early return,
 * so the count never silently shrinks. `assertions never skipped` is the point.
 */
function main() {
  const argi = process.argv.indexOf('--model');
  const CANDIDATES = argi > -1 && process.argv[argi + 1]
    ? [path.resolve(process.argv[argi + 1])]
    : [process.env.STEM_SPLITTER_LIVE_MODEL, path.join(ROOT, 'models/htdemucs_6s.onnx')].filter(Boolean).map((p) => path.resolve(p));

  // ---- the code side: shared/config.js + engine/keytap.js -------------------
  let cfg = null, cfgErr = '';
  try { cfg = globalThis.__CFG; } catch { /* set by the loader below */ }
  check('shared/config.js loaded', !!cfg, cfg ? '' : `could not import — ${globalThis.__CFG_ERR || cfgErr}`);
  if (!cfg) cfg = { STEMS: null, MODEL: null };

  check('STEMS matches the order read off the PyTorch checkpoint',
    eq(cfg.STEMS, VERIFIED_SOURCES),
    `config=${JSON.stringify(cfg.STEMS)} verified=${JSON.stringify(VERIFIED_SOURCES)}`);

  check('other is at stem index 2',
    Array.isArray(cfg.STEMS) && cfg.STEMS.indexOf('other') === 2,
    `indexOf(other)=${Array.isArray(cfg.STEMS) ? cfg.STEMS.indexOf('other') : 'STEMS unreadable'}`);

  // ---- the recorded parity evidence ---------------------------------------
  // Each of these inspects a real entry and fails naming the stem, so a stem
  // added to STEMS without a parity re-run cannot slip through as "not listed".
  const stems = Array.isArray(cfg.STEMS) ? cfg.STEMS : [];
  const missing = stems.filter((s) => !PARITY_EVIDENCE[s]);
  check('every stem in STEMS has a recorded parity measurement',
    stems.length > 0 && missing.length === 0,
    stems.length ? (missing.length ? `no evidence for: ${missing.join(', ')} — re-derive the evidence from the checkpoint`
      : `${stems.length} stems covered`) : 'STEMS unreadable — could not look');

  check('the parity evidence was taken against the currently pinned model',
    !!cfg.MODEL && PARITY_EVIDENCE_SHA === cfg.MODEL.sha256,
    `evidence@${PARITY_EVIDENCE_SHA.slice(0, 12)} pin@${cfg.MODEL ? cfg.MODEL.sha256.slice(0, 12) : '?'}`
      + (cfg.MODEL && PARITY_EVIDENCE_SHA !== cfg.MODEL.sha256 ? ' — STALE, re-derive the evidence from the checkpoint' : ''));

  // THE `other` GAP, made permanent. A stem confirmed only near silence is not
  // confirmed; this is the assertion that would have been red before the organ
  // and string-pad cases were added to parity_6s.py.
  const quiet = stems.filter((s) => !PARITY_EVIDENCE[s] || PARITY_EVIDENCE[s].rms < LOW_SIGNAL_FLOOR);
  check(`every stem's parity was confirmed above the ${LOW_SIGNAL_FLOOR} RMS low-signal floor`,
    stems.length > 0 && quiet.length === 0,
    stems.length ? (quiet.length ? `confirmed only near silence: ${quiet.map((s) => `${s}@${PARITY_EVIDENCE[s] ? PARITY_EVIDENCE[s].rms : 'no evidence'}`).join(', ')}`
      : `quietest is ${stems.reduce((a, s) => (PARITY_EVIDENCE[s].rms < PARITY_EVIDENCE[a].rms ? s : a), stems[0])}`
        + ` @${Math.min(...stems.map((s) => PARITY_EVIDENCE[s].rms))} RMS`) : 'STEMS unreadable — could not look');

  const loose = stems.filter((s) => !PARITY_EVIDENCE[s] || PARITY_EVIDENCE[s].resid > RESID_GATE);
  check(`every stem's recorded residual is within ${RESID_GATE} of the segment norm`,
    stems.length > 0 && loose.length === 0,
    stems.length ? (loose.length ? `over gate: ${loose.join(', ')}`
      : `worst ${Math.max(...stems.map((s) => PARITY_EVIDENCE[s].resid)).toExponential(3)}`) : 'STEMS unreadable — could not look');

  const decorr = stems.filter((s) => !PARITY_EVIDENCE[s] || PARITY_EVIDENCE[s].corr < CORR_GATE);
  check(`every stem's recorded correlation with PyTorch is at least ${CORR_GATE}`,
    stems.length > 0 && decorr.length === 0,
    stems.length ? (decorr.length ? `below gate: ${decorr.join(', ')}`
      : `worst ${Math.min(...stems.map((s) => PARITY_EVIDENCE[s].corr))}`) : 'STEMS unreadable — could not look');

  // keytap's two constants are DERIVED from `other`'s index; read the source
  // rather than importing, which would drag in the whole chroma chain.
  let kL = null, kR = null, kErr = '';
  try {
    const src = fs.readFileSync(path.join(ROOT, 'extension/engine/keytap.js'), 'utf8');
    kL = (src.match(/KEY_TAP_PLANE_L\s*=\s*(\d+)/) || [])[1];
    kR = (src.match(/KEY_TAP_PLANE_R\s*=\s*(\d+)/) || [])[1];
    kL = kL === undefined ? null : Number(kL);
    kR = kR === undefined ? null : Number(kR);
  } catch (e) { kErr = e.message; }
  const oi = Array.isArray(cfg.STEMS) ? cfg.STEMS.indexOf('other') : -1;
  check('keytap KEY_TAP_PLANE_L/R follow from other\'s index via stemIdx*2+ch',
    kL !== null && kR !== null && oi >= 0 && kL === oi * 2 && kR === oi * 2 + 1,
    `planes=${kL}/${kR} expected=${oi >= 0 ? `${oi * 2}/${oi * 2 + 1}` : 'unknown'}${kErr ? ` readErr=${kErr}` : ''}`);

  // ---- the file side -------------------------------------------------------
  const found = CANDIDATES.find((p) => fs.existsSync(p)) || null;
  check('the pinned model file is on disk', !!found,
    found ? found : `looked in: ${CANDIDATES.join(', ')} — fetch it with: `
      + `bash tools/fetch-model.sh   # or: curl -L -o models/htdemucs_6s.onnx '${cfg.MODEL ? cfg.MODEL.url : '<MODEL.url>'}'`);

  // A missing file must not silently shrink the assertion count: every remaining
  // check is emitted, and each one fails naming the fact it could not look at.
  const blind = found ? '' : 'model file absent — this assertion could not look';
  let buf = null, readErr = '';
  if (found) { try { buf = fs.readFileSync(found); } catch (e) { readErr = e.message; } }

  check('model byte count matches shared/config.js MODEL.bytes',
    !!buf && !!cfg.MODEL && buf.length === cfg.MODEL.bytes,
    buf ? `${buf.length} vs pinned ${cfg.MODEL ? cfg.MODEL.bytes : '?'}` : (readErr || blind));

  const sha = buf ? crypto.createHash('sha256').update(buf).digest('hex') : null;
  check('model SHA-256 matches shared/config.js MODEL.sha256 (the source-order fixture is pinned to it)',
    !!sha && !!cfg.MODEL && sha === cfg.MODEL.sha256,
    sha ? `${sha.slice(0, 16)}... vs pinned ${cfg.MODEL ? cfg.MODEL.sha256.slice(0, 16) : '?'}...` : (readErr || blind));

  let g = null, gErr = '';
  if (buf) { try { g = readGraph(buf); } catch (e) { gErr = e.message; } }

  check('the graph exposes exactly two inputs', !!g && g.inputs.length === 2,
    g ? `${g.inputs.length}: ${g.inputs.map((i) => i.name).join(', ')}` : (gErr || blind));
  check('the graph exposes exactly two outputs', !!g && g.outputs.length === 2,
    g ? `${g.outputs.length}: ${g.outputs.map((o) => o.name).join(', ')}` : (gErr || blind));

  // demucs.js binds inputs POSITIONALLY (inputNames[0]/[1]); order is the contract.
  for (const [i, want] of WANT_IN.entries()) {
    const got = g && g.inputs[i] ? g.inputs[i].dims : null;
    check(`input[${i}] is ${i === 0 ? 'the waveform' : 'the STFT'} ${JSON.stringify(want)} (demucs.js binds positionally)`,
      eq(got, want), got ? `${g.inputs[i].name} ${JSON.stringify(got)}` : (gErr || blind));
  }

  // demucs.js dispatches the two outputs on dims.length alone. If both came back
  // rank-5, or the ranks swapped, it mis-assigns the branches in silence.
  const ranks = g ? g.outputs.map((o) => (o.dims ? o.dims.length : null)) : null;
  check('exactly one output is rank-5 (the freq branch demucs.js selects on dims.length===5)',
    !!ranks && ranks.filter((r) => r === 5).length === 1, ranks ? `ranks=${JSON.stringify(ranks)}` : (gErr || blind));
  check('exactly one output is rank-4 (the time branch demucs.js selects on dims.length===4)',
    !!ranks && ranks.filter((r) => r === 4).length === 1, ranks ? `ranks=${JSON.stringify(ranks)}` : (gErr || blind));

  const freq = g ? g.outputs.find((o) => o.dims && o.dims.length === 5) : null;
  const time = g ? g.outputs.find((o) => o.dims && o.dims.length === 4) : null;
  check(`the rank-5 output is the freq branch ${JSON.stringify(WANT_FREQ)}`,
    !!freq && eq(freq.dims, WANT_FREQ), freq ? `${freq.name} ${JSON.stringify(freq.dims)}` : (gErr || blind));

  /**
   * THE TIME BRANCH IS DECLARED SYMBOLICALLY AND THAT IS NOT A DEFECT — the
   * assertion that demanded four literal integers here was wrong, and it is the
   * exact AGENTS.md failure mode (an invariant the code never promised). This
   * export names the time output's axes `Add5012_dim_0..3` rather than baking
   * constants in; because BOTH GRAPH INPUTS ARE FULLY STATIC, ORT's shape
   * inference resolves them, and it does: `get_outputs()` reports
   * [1, 6, 2, 343980] at the pinned SHA, matching `demucs.js`'s contract.
   *
   * So the provable claim is the weaker, true one: no axis that IS declared as a
   * constant may contradict the expected shape. A re-export that hard-coded a
   * wrong length still goes red; one that merely names its axes does not.
   */
  const timeBad = time ? time.dims
    .map((d, i) => (typeof d === 'number' && d !== WANT_TIME[i] ? `${i}:${d}!=${WANT_TIME[i]}` : null))
    .filter(Boolean) : null;
  check(`no declared time-branch axis contradicts ${JSON.stringify(WANT_TIME)} (symbolic axes are resolved by ORT from the static inputs)`,
    !!time && timeBad.length === 0,
    time ? `${time.name} ${JSON.stringify(time.dims)}${timeBad.length ? ` conflicts ${timeBad.join(',')}` : ''}` : (gErr || blind));

  /**
   * The Kani95 fallback's known liability is DYNAMIC INPUT axes, and the inputs
   * are the entry point where it matters: static inputs are what let ORT resolve
   * the whole graph ahead of time and what ORT-Web's WebGPU EP wants. Scoping
   * this to the inputs is the point, not a weakening — the outputs of THIS export
   * are symbolic by construction (see above), so an all-axes version would fail
   * forever on a file that is fine.
   */
  const inDims = g ? g.inputs.flatMap((v) => v.dims || [null]) : null;
  const dyn = inDims ? inDims.filter((d) => typeof d !== 'number') : null;
  check('every INPUT axis is a static integer (this is the axis kind the WebGPU EP needs pinned)',
    !!inDims && inDims.length > 0 && dyn.length === 0,
    inDims ? (dyn.length ? `dynamic: ${JSON.stringify(dyn)}` : `${inDims.length} axes, all static`) : (gErr || blind));

  // Ties the code's stem count to the graph's, which is the number that actually
  // shapes the output buffers in postProcess(). Taken off the freq branch because
  // that is the branch whose stem axis is a declared constant.
  check('STEMS.length equals the stem axis of the freq branch',
    !!freq && Array.isArray(cfg.STEMS) && freq.dims[1] === cfg.STEMS.length,
    freq ? `freq stem axis=${freq.dims[1]} STEMS.length=${Array.isArray(cfg.STEMS) ? cfg.STEMS.length : '?'}` : (gErr || blind));

  console.log(`\nmodel-parity: ${pass} passed, ${fail} failed`);
  if (fail) {
    console.log('A red here means the shipped engine\'s beliefs and the pinned file have diverged.');
    console.log('If the SHA moved, the stem ORDER is unverified again — re-run the PyTorch comparison');
    console.log('before touching VERIFIED_SOURCES. Do not edit the hash to make this green.');
  }
  process.exit(fail ? 1 : 0);
}

// config.js is ESM with top-level exports only; import it, but never let an
// import failure become a silent skip.
try {
  globalThis.__CFG = await import(pathToFileURL(path.join(ROOT, 'extension/shared/config.js')).href);
} catch (e) {
  globalThis.__CFG = null;
  globalThis.__CFG_ERR = e.message;
}
main();
