/**
 * Global master meter — Mode 3.
 *
 * A pass-through AudioWorklet that sits at the point where the two decks sum,
 * immediately before the soft clipper, and meters EVERY sample of the combined
 * bus.
 *
 * Why it has to exist at all. In Mode 1 the "master" meter came out of the
 * playback worklet, which is per deck. With two decks there are two of those and
 * neither is the master: peak(A + B) is not peak(A) + peak(B) and it is not
 * max(peak(A), peak(B)) either — two decks at -6 dBFS can sum to 0 dBFS or to
 * silence depending entirely on phase, and the number the DJ needs is the one
 * that says whether the thing leaving the building is clipping.
 *
 * Why not an AnalyserNode (docs/AUDIO.md §4.3): it hands you whatever the last
 * 2048 samples happened to be when you polled, so it misses every peak between
 * polls. That is tolerable for the audibility PROBE in live.js, whose question is
 * "is this bus at digital zero", and not tolerable for a clip LED.
 *
 * HARD RULE (R0): this file must never name `SharedArrayBuffer` and must never
 * read `crossOriginIsolated` — both are undefined in AudioWorkletGlobalScope
 * when the document is not cross-origin isolated, and we ship without the
 * COOP/COEP keys deliberately.
 *
 * Pass-through, not a sink: an AudioWorkletNode with no outputs is not pulled by
 * Chrome, so a metering node hung off the side of the graph would silently stop
 * reporting. It is IN the chain, and if it ever stops running the audio stops
 * with it — which is the failure mode we want, because it is the loud one.
 */

const Q = 128;

class MasterMeterProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions || {};
    this.sr = o.sampleRate || sampleRate;
    this.every = Math.max(Q, Math.round(this.sr / (o.meterHz || 30)));
    this.acc = 0;
    this.pkL = 0; this.pkR = 0;
    this.sqL = 0; this.sqR = 0;
    this.n = 0;
    this.clip = 0;
    this.running = true;
    this.port.onmessage = (e) => {
      if (e.data && e.data.t === 'stop') this.running = false;
    };
  }

  process(inputs, outputs) {
    if (!this.running) return false;
    const inp = inputs[0];
    const out = outputs[0];
    const oL = out[0], oR = out.length > 1 ? out[1] : out[0];
    const n = oL.length;

    // A disconnected input arrives as an empty array, not as zeros. Emit silence
    // and keep the meters honest rather than reading undefined.
    if (!inp || inp.length === 0) {
      oL.fill(0); if (oR !== oL) oR.fill(0);
      this.acc += n;
      this.maybePost();
      return true;
    }
    const iL = inp[0], iR = inp.length > 1 ? inp[1] : inp[0];

    let pl = this.pkL, pr = this.pkR, sl = this.sqL, sr = this.sqR;
    for (let i = 0; i < n; i++) {
      const l = iL[i], r = iR[i];
      oL[i] = l; oR[i] = r;
      const al = l < 0 ? -l : l, ar = r < 0 ? -r : r;
      if (al > pl) pl = al;
      if (ar > pr) pr = ar;
      sl += l * l; sr += r * r;
    }
    this.pkL = pl; this.pkR = pr; this.sqL = sl; this.sqR = sr;
    this.n += n;
    // Armed off the PRE-soft-clip peak, same reasoning as the per-deck meter:
    // the user should learn to pull down rather than lean on the safety net.
    if (pl > 0.99 || pr > 0.99) this.clip = 1;
    this.acc += n;
    this.maybePost();
    return true;
  }

  maybePost() {
    if (this.acc < this.every) return;
    this.acc = 0;
    const n = this.n || 1;
    this.port.postMessage({
      t: 'master',
      peakL: this.pkL, peakR: this.pkR,
      rmsL: Math.sqrt(this.sqL / n), rmsR: Math.sqrt(this.sqR / n),
      clip: this.clip,
    });
    this.pkL = 0; this.pkR = 0; this.sqL = 0; this.sqR = 0; this.n = 0; this.clip = 0;
  }
}

registerProcessor('master-meter', MasterMeterProcessor);
