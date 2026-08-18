/**
 * Inference worker — the ONLY place ONNX Runtime is instantiated.
 *
 * Why a worker and not the offscreen main thread (spike/FINDINGS.md §10.1):
 * even on WebGPU there is ~283 ms of JS STFT/iSTFT per segment, and the WASM
 * fallback blocks for seconds at a time. The offscreen main thread has to stay
 * responsive to do overlap-add and talk to the UI.
 *
 * Hard constraints encoded here:
 *   - one session, one in-flight run(). ORT-Web serialises run() across all
 *     sessions on a wasm instance, and a rejected concurrent call permanently
 *     wedges the session (FINDINGS §6/§11).
 *   - graphOptimizationLevel: 'basic'. 'all' is untested for this graph.
 *   - warm up once immediately after create(): first inference is 843-2584 ms
 *     (shader compile) vs ~450 ms steady.
 *   - drop the 172 MiB model ArrayBuffer the instant create() returns.
 */

import * as ort from '../vendor/ort/ort.all.bundle.min.mjs';
import { DemucsEngine } from '../engine/demucs.js';
import { SEGMENT } from '../shared/config.js';

let engine = null;
let busy = false;

const post = (m, transfer) => self.postMessage(m, transfer || []);

async function adapterInfo() {
  try {
    if (!self.navigator || !navigator.gpu) return null;
    const a = await navigator.gpu.requestAdapter();
    if (!a) return null;
    const i = a.info || {};
    return { vendor: i.vendor || null, architecture: i.architecture || null };
  } catch { return null; }
}

async function init(wasmDirUrl) {
  // Must be set BEFORE any session is created. Must be a DIRECTORY url — R0
  // measured `{wasm: <file url>}` failing with "w is not a function".
  ort.env.wasm.wasmPaths = wasmDirUrl;
  // ORT's proxy worker uses a blob: URL, which our CSP (script-src 'self') blocks.
  // It is also pointless: we are already off the main thread.
  ort.env.wasm.proxy = false;
  // Pin explicitly. ORT contains a `!crossOriginIsolated -> 1` branch that may or
  // may not fire; R0 measured 45.3 ms -> 12.2 ms going 1 -> 4 threads, and a
  // regression at 8 on a 12-core machine.
  const hc = (self.navigator && navigator.hardwareConcurrency) || 4;
  ort.env.wasm.numThreads = Math.min(4, Math.max(1, hc >> 1));
  ort.env.logLevel = 'warning';
  post({ type: 'READY', numThreads: ort.env.wasm.numThreads, adapter: await adapterInfo() });
}

async function loadModel(buffer) {
  engine = new DemucsEngine(ort);
  let ep = 'webgpu';
  let createMs;
  try {
    createMs = await engine.load(buffer, 'webgpu');
  } catch (e) {
    post({ type: 'MODEL_PROGRESS', phase: 'session', note: `webgpu unavailable (${e.message}) — falling back to wasm` });
    ep = 'wasm';
    createMs = await engine.load(buffer, 'wasm');
  }
  buffer = null;   // 172 MiB of duplicated JS heap — let it go now

  post({ type: 'MODEL_PROGRESS', phase: 'warmup' });
  const t0 = performance.now();
  const z = new Float32Array(SEGMENT);
  await engine.runSegment(z, z);
  const warmupMs = performance.now() - t0;

  post({
    type: 'MODEL_READY', ep, createMs, warmupMs,
    inputNames: engine.inputNames, outputNames: engine.outputNames, segment: SEGMENT,
  });
}

self.onmessage = async (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'INIT':
        return void await init(m.wasmDirUrl);

      case 'LOAD_MODEL': {
        // Review finding M4: `buffer = null` inside loadModel only cleared the
        // parameter binding — `m.buffer` (reachable through this closure) kept
        // the same 172 MiB ArrayBuffer alive across InferenceSession.create AND
        // the warm-up inference, i.e. right through the peak-memory moment
        // (FINDINGS §3 measured 1761 MB renderer RSS with it resident). Drop the
        // message's own reference before handing it on.
        const b = m.buffer;
        m.buffer = null;
        return void await loadModel(b);
      }

      case 'INFER': {
        if (busy) throw new Error('INFER while a run is already in flight — refusing (would wedge the session)');
        busy = true;
        try {
          const mix = new Float32Array(m.mix);
          const segL = mix.subarray(0, SEGMENT);
          const segR = mix.subarray(SEGMENT, 2 * SEGMENT);
          const r = await engine.runSegment(segL, segR, new Float32Array(m.out));
          post({
            type: 'RESULT', id: m.id, stems: r.stems.buffer, mix: m.mix,
            prepMs: r.prepMs, inferMs: r.inferMs, postMs: r.postMs,
          }, [r.stems.buffer, m.mix]);
        } finally { busy = false; }
        return;
      }

      // Sent by offscreen.js::teardown(). Releases ORT's ~1.7 GB wasm heap.
      case 'DISPOSE':
        if (engine && engine.session) await engine.session.release().catch(() => {});
        engine = null;
        return;
    }
  } catch (err) {
    // Deliberately does NOT clear `busy`. The only writer is the INFER case,
    // which owns it under try/finally. Clearing it here would release the guard
    // on behalf of a run that is still in flight — which is exactly how you get
    // two concurrent session.run() calls and a permanently wedged session
    // (spike/FINDINGS.md §6).
    post({ type: 'ERROR', id: m && m.id, message: String((err && err.message) || err), stack: err && err.stack });
  }
};
