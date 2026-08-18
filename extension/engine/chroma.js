/**
 * Musical key / scale detection for the play-along display.
 *
 * PURE FUNCTIONS ONLY. No AudioContext, no DOM, no AnalyserNode, no chrome.*.
 * The caller feeds magnitude spectra in; this file feeds key names out. That is
 * what makes `node extension/engine/chroma.js` a real check rather than a mock.
 *
 *   spectrum -> foldChroma()          12-bin pitch-class energy for one frame
 *            -> accumulator           per-frame-normalised running sum
 *            -> correlateKey()        24 Temperley correlations -> argmax
 *            -> displayKey()          concert + written key, named and spelled
 *
 * ---------------------------------------------------------------------------
 * WHY TEMPERLEY (2001) AND NOT KRUMHANSL-KESSLER
 *
 * KK's weights come from probe-tone experiments on trained listeners hearing
 * isolated tones after a cadence. They over-weight tonic and dominant, and on
 * real audio — where every note drags its own third and fifth in as harmonics 3
 * and 5 — that bias reliably reports the DOMINANT of the true key. "Detected G
 * major, actually C major" is the signature failure and it is not subtle: it is
 * a constant +7 offset across a whole library. Temperley's Kostka-Payne weights
 * are fitted to notated common-practice scores instead, and the flatter tonic /
 * dominant ratio is exactly the property that survives harmonic leakage.
 *
 * ---------------------------------------------------------------------------
 * THE TAP POINT, AND WHY `displayKey` ADDS THE SHIFT (ruled; read before editing)
 *
 * The chroma tap sits on the `other` stem UPSTREAM of the pitch shifter. So the
 * spectra this file sees are at the RECORDING's concert pitch, and the user's
 * ±6 semitone transpose is NOT in them. `displayKey` must therefore ADD
 * `audioShiftSemitones`.
 *
 * Had the tap been on the master bus DOWNSTREAM of the shifter, the shift would
 * already be baked into the chroma and adding it would double-count. Same
 * feature, opposite sign, and BOTH look correct in review — which is why the
 * tap point is written here and not left to be inferred. If someone moves the
 * tap, this function changes with it, and `transpose-composition` in the
 * self-check is the thing that will not let it be moved silently.
 *
 * COROLLARY FOR THE CALLER: store `concertTonic` and re-derive the display on
 * every change (transpose moved, instrument changed). NEVER store the shifted
 * tonic and shift it again — that is the double-count, one call site later.
 */

// ============================================================ profiles

export const MODES = ['major', 'minor'];

/**
 * Temperley (2001) Kostka-Payne key profiles. Index 0 is the TONIC's own weight,
 * index i is the weight of the pitch i semitones above the tonic.
 */
export const TEMPERLEY = {
  major: Object.freeze([5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0]),
  minor: Object.freeze([5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0]),
};

/**
 * Pearson's numerator is sum((x-xbar)(p-pbar)) and sum(p-pbar) is 0, so the
 * chroma mean cancels out of the numerator entirely and only the profile's
 * centred form and its norm are needed. Both are constant, so both are computed
 * once here at module load: 24 correlations then cost 24 dot products of 12.
 */
function prepareProfile(p) {
  let mean = 0;
  for (let i = 0; i < 12; i++) mean += p[i];
  mean /= 12;
  const centred = new Float64Array(12);
  let ss = 0;
  for (let i = 0; i < 12; i++) { centred[i] = p[i] - mean; ss += centred[i] * centred[i]; }
  return { centred, norm: Math.sqrt(ss) };
}
const PROFILES = [prepareProfile(TEMPERLEY.major), prepareProfile(TEMPERLEY.minor)];

// ============================================================ spectrum -> chroma

export const A4_HZ = 440;

/** 2.69 Hz/bin at 44 100. Set by the LOW end: a semitone at C2 (65.4 Hz) spans
 *  3.9 Hz, so 8192 (5.38 Hz/bin) cannot resolve adjacent bass semitones AT ALL. */
export const CHROMA_FFT_SIZE = 16384;

/** Analysis band. Below 100 Hz is fundamentals only (and the kick); above 5 kHz
 *  is cymbals and high harmonics. Both are noise for pitch-class estimation. */
export const CHROMA_MIN_HZ = 100;
export const CHROMA_MAX_HZ = 5000;

/**
 * Per-frame relative gate, dB below that frame's in-band peak. Bins quieter than
 * this contribute nothing.
 *
 * This is not cosmetic. The band holds ~1820 bins and the compression is sqrt,
 * which LIFTS small values: 1820 bins sitting at the byte-path floor
 * (-100 dBFS -> 1e-5 linear -> sqrt 3.2e-3) sum to 5.8, while one loud partial
 * at -30 dBFS contributes 0.18. Without a gate the noise floor outvotes the
 * music 30:1 and the chroma is flat. Relative to the frame peak, so it is
 * scale-invariant and identical on the byte and float paths.
 */
export const CHROMA_GATE_DB = 40;

/** AnalyserNode's defaults, and the range the byte LUT is built against. */
export const DEFAULT_MIN_DB = -100;
export const DEFAULT_MAX_DB = -30;

const binMaps = new Map();

/**
 * bin -> pitch class, precomputed. -1 means out of band.
 *
 *   f = k * sr / fftSize ;  m = 69 + 12*log2(f/440) ;  pc = ((round(m) % 12) + 12) % 12
 *
 * MIDI 60 is C4 and 60 mod 12 === 0, so pitch class 0 is C with no extra offset.
 * This table is the single largest CPU win available here — it turns the fold
 * into a lookup plus an add, and it is where the +69 and the A440 reference
 * live, which is why `chroma-maps-a440` tests it in isolation.
 */
export function binPitchClasses(sampleRate, fftSize, minHz = CHROMA_MIN_HZ, maxHz = CHROMA_MAX_HZ) {
  const key = `${sampleRate}|${fftSize}|${minHz}|${maxHz}`;
  let map = binMaps.get(key);
  if (map) return map;
  const half = fftSize >> 1;
  map = new Int16Array(half).fill(-1);
  for (let k = 1; k < half; k++) {
    const f = k * sampleRate / fftSize;
    if (f < minHz || f > maxHz) continue;
    const m = Math.round(69 + 12 * Math.log2(f / A4_HZ));
    map[k] = ((m % 12) + 12) % 12;
  }
  binMaps.set(key, map);
  return map;
}

const byteLuts = new Map();

/**
 * 256-entry byte -> linear magnitude table for `getByteFrequencyData` input.
 *
 * The browser caller uses the byte API because the float one would cost ~1820
 * `Math.pow` calls per frame just to undo the dB mapping. This deletes them.
 *
 * Entry 0 is 0, not 10^(minDb/20): a byte of 0 means "at or below
 * minDecibels", i.e. the floor, and treating the floor as a real magnitude is
 * what CHROMA_GATE_DB exists to clean up anyway.
 */
export function byteMagnitudeLut(minDecibels = DEFAULT_MIN_DB, maxDecibels = DEFAULT_MAX_DB) {
  const key = `${minDecibels}|${maxDecibels}`;
  let lut = byteLuts.get(key);
  if (lut) return lut;
  lut = new Float32Array(256);
  const span = maxDecibels - minDecibels;
  for (let b = 1; b < 256; b++) lut[b] = Math.pow(10, (minDecibels + (b / 255) * span) / 20);
  byteLuts.set(key, lut);
  return lut;
}

/**
 * Fold one magnitude spectrum into 12 pitch classes. Returns `out` (or a fresh
 * Float32Array(12)); pitch class 0 = C.
 *
 * `magnitudes` is either
 *   - a BYTE array (any 1-byte typed array), read as `getByteFrequencyData`
 *     output and mapped through the LUT above, or
 *   - a FLOAT array of LINEAR magnitudes, e.g. sqrt(re^2+im^2) from fft.js.
 *     NOTE: `getFloatFrequencyData` returns dB, not linear. Do not pass it here
 *     without converting; it will read as "everything below the gate" and the
 *     frame will fold to zeros.
 *
 * The result is NOT normalised — the accumulator does that, because normalising
 * is only meaningful once per frame and doing it twice would be silent.
 * A silent frame returns all zeros, and the accumulator treats that as "no
 * frame", never as a data point.
 */
export function foldChroma(magnitudes, sampleRate, fftSize, opts = {}) {
  const half = fftSize >> 1;
  if (!magnitudes || magnitudes.length < half) {
    // Fail loudly. A short spectrum silently folds a narrower band and the key
    // it reports would be a real-looking answer to a question nobody asked.
    throw new RangeError(`foldChroma: need >= ${half} magnitude bins for fftSize ${fftSize}, got ${magnitudes ? magnitudes.length : 'none'}`);
  }
  const map = binPitchClasses(sampleRate, fftSize, opts.minHz ?? CHROMA_MIN_HZ, opts.maxHz ?? CHROMA_MAX_HZ);
  // BYTES_PER_ELEMENT rather than `instanceof`: a typed array from a worker or
  // another realm is not `instanceof` this realm's Uint8Array.
  const lut = magnitudes.BYTES_PER_ELEMENT === 1
    ? byteMagnitudeLut(opts.minDecibels ?? DEFAULT_MIN_DB, opts.maxDecibels ?? DEFAULT_MAX_DB)
    : null;

  let peak = 0;
  for (let k = 0; k < half; k++) {
    if (map[k] < 0) continue;
    const m = lut ? lut[magnitudes[k]] : magnitudes[k];
    if (m > peak) peak = m;
  }

  const out = opts.out || new Float32Array(12);
  out.fill(0);
  if (!(peak > 0)) return out;   // silent (or dB-valued) frame: zeros, and the caller must not count it

  const gate = peak * Math.pow(10, -(opts.gateDb ?? CHROMA_GATE_DB) / 20);
  for (let k = 0; k < half; k++) {
    const pc = map[k];
    if (pc < 0) continue;
    const m = lut ? lut[magnitudes[k]] : magnitudes[k];
    const d = m - gate;
    // sqrt, not raw magnitude: raw lets one loud bass note outweigh a whole
    // chord's worth of harmony. Subtractive rather than hard gating so a bin
    // hovering at the threshold cannot flicker the chroma frame to frame.
    if (d > 0) out[pc] += Math.sqrt(d);
  }
  return out;
}

/**
 * Running chroma. EVERY frame is normalised to sum 1 before it is added.
 *
 * This matters more than the profile choice: without it the loudest ten seconds
 * of the track decide the key, so a track with a big chorus in a borrowed key
 * reports the chorus. With it, one frame is one vote.
 *
 * `opts` is passed straight through to foldChroma (minHz/maxHz/gateDb/
 * minDecibels/maxDecibels) and is held, not copied per frame.
 */
export function createChromaAccumulator(opts = {}) {
  const sum = new Float64Array(12);
  const frame = new Float32Array(12);
  const foldOpts = { ...opts, out: frame };
  let frames = 0, silentFrames = 0;

  return {
    /** frames actually counted (a silent frame is not one of them). */
    get frames() { return frames; },
    /** frames rejected as silent. Non-zero is normal; ALL silent is a red flag. */
    get silentFrames() { return silentFrames; },

    /** @returns true if the frame carried energy and was counted. */
    add(magnitudes, sampleRate, fftSize) {
      foldChroma(magnitudes, sampleRate, fftSize, { ...foldOpts, out: frame });
      let total = 0;
      for (let i = 0; i < 12; i++) total += frame[i];
      if (!(total > 0)) { silentFrames++; return false; }
      const inv = 1 / total;
      for (let i = 0; i < 12; i++) sum[i] += frame[i] * inv;
      frames++;
      return true;
    },

    /** Mean chroma, or NULL if nothing has been counted. Null is not a key. */
    chroma() {
      if (frames === 0) return null;
      const c = new Float32Array(12);
      for (let i = 0; i < 12; i++) c[i] = sum[i] / frames;
      return c;
    },

    /** correlateKey of the accumulated chroma, with `frames` attached, or null. */
    estimate() {
      const c = this.chroma();
      if (!c) return null;
      const est = correlateKey(c);
      if (est) est.frames = frames;
      return est;
    },

    reset() { sum.fill(0); frames = 0; silentFrames = 0; },
  };
}

// ============================================================ chroma -> key

/**
 * 24 Pearson correlations (12 tonics x 2 modes), argmax.
 *
 * ROTATION DIRECTION. `chroma[(tonic + i) % 12]` is lined up against
 * `profile[i]`, i.e. profile index i is the pitch i semitones ABOVE the tonic.
 * For C major that puts chroma[0] (C) against profile[0] (the tonic weight,
 * 5.0). Getting this backwards produces a CONSTANT offset on every track and no
 * other symptom at all, which is why `key-sweep-all-12` exists — a reversed
 * rotation fails all twelve at once, and a single-key test would just look like
 * one bad track.
 *
 * @returns {{tonic:number, mode:string, modeIndex:number, confidence:number,
 *            r:number, scores:Float64Array}|null}
 *   `scores[modeIndex*12 + tonic]`, kept because the display gate has to compare
 *   a challenger against a SPECIFIC incumbent, not against the runner-up.
 *   NULL means "no estimate" — no energy, or a perfectly flat chroma in which
 *   every rotation scores identically. Never treat null as a default key.
 */
export function correlateKey(chroma) {
  if (!chroma || chroma.length !== 12) {
    throw new TypeError(`correlateKey: need a 12-element chroma vector, got ${chroma ? chroma.length : chroma}`);
  }
  let mean = 0;
  for (let i = 0; i < 12; i++) mean += chroma[i];
  mean /= 12;
  let ss = 0;
  for (let i = 0; i < 12; i++) { const d = chroma[i] - mean; ss += d * d; }
  if (!(ss > 0)) return null;             // flat or empty: there is no argmax to report
  const denom = Math.sqrt(ss);

  const scores = new Float64Array(24);
  let best = -Infinity, bestIdx = -1, second = -Infinity;
  for (let m = 0; m < 2; m++) {
    const P = PROFILES[m].centred, pn = PROFILES[m].norm;
    for (let t = 0; t < 12; t++) {
      let num = 0;
      for (let i = 0; i < 12; i++) num += chroma[(t + i) % 12] * P[i];
      const r = num / (denom * pn);
      scores[m * 12 + t] = r;
      if (r > best) { second = best; best = r; bestIdx = m * 12 + t; }
      else if (r > second) { second = r; }
    }
  }
  return {
    tonic: bestIdx % 12,
    modeIndex: (bestIdx / 12) | 0,
    mode: MODES[(bestIdx / 12) | 0],
    r: best,
    confidence: best - second,
    scores,
  };
}

// ============================================================ naming

/**
 * Conventional spellings, indexed by pitch class (0 = C). Hardcoded on purpose:
 * enharmonic choice is a musical decision, not formatting, and twelve strings in
 * a table are auditable at a glance where a circle-of-fifths distance computed
 * at runtime is not. pc 3 minor is Eb minor (6 flats), not D# minor (6 sharps).
 */
const MAJOR_TONICS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_TONICS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTAL = { '-2': 'bb', '-1': 'b', 0: '', 1: '#', 2: '##' };
const SCALE_STEPS = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],   // natural minor — what a horn player fingers
};

function checkMode(mode) {
  if (mode !== 'major' && mode !== 'minor') throw new TypeError(`mode must be 'major' or 'minor', got ${JSON.stringify(mode)}`);
  return mode;
}
function checkTonic(tonic) {
  if (!Number.isInteger(tonic) || tonic < 0 || tonic > 11) throw new RangeError(`tonic must be an integer pitch class 0..11, got ${tonic}`);
  return tonic;
}

/** Just the tonic's letter: `tonicName(6, 'minor')` -> 'F#'. */
export function tonicName(tonic, mode) {
  checkTonic(tonic); checkMode(mode);
  return (mode === 'major' ? MAJOR_TONICS : MINOR_TONICS)[tonic];
}

/** `keyName(6, 'minor')` -> 'F# minor'. */
export function keyName(tonic, mode) {
  return `${tonicName(tonic, mode)} ${mode}`;
}

/**
 * The seven notes as they are written: `scaleNotes(3, 'minor')`
 * -> ['Eb','F','Gb','Ab','Bb','Cb','Db'].
 *
 * Letter names advance one per degree and the accidental is whatever makes the
 * pitch class come out right — that is what produces Cb rather than B in Eb
 * minor, and E# rather than F in F# major. A horn player reading a chart needs
 * the spelling that matches the key signature, not the enharmonic nearest name.
 */
export function scaleNotes(tonic, mode) {
  checkTonic(tonic); checkMode(mode);
  const name = tonicName(tonic, mode);
  const letterIdx = LETTERS.indexOf(name[0]);
  const steps = SCALE_STEPS[mode];
  const notes = new Array(7);
  for (let d = 0; d < 7; d++) {
    const li = (letterIdx + d) % 7;
    const target = (tonic + steps[d]) % 12;
    const alter = ((target - LETTER_PC[li] + 18) % 12) - 6;
    const acc = ACCIDENTAL[alter];
    if (acc === undefined) throw new RangeError(`scaleNotes: ${name} ${mode} degree ${d} needs ${alter} accidentals`);
    notes[d] = LETTERS[li] + acc;
  }
  return notes;
}

/** `scaleLine(3,'minor')` -> 'Eb minor: Eb F Gb Ab Bb Cb Db'. */
export function scaleLine(tonic, mode) {
  return `${keyName(tonic, mode)}: ${scaleNotes(tonic, mode).join(' ')}`;
}

// ============================================================ transposing display

/**
 * Written pitch minus concert pitch, semitones. An Eb alto reading a written C
 * sounds an Eb, so the written part is 9 semitones ABOVE concert; a Bb tenor
 * reads 2 above (and an octave-plus down, which does not affect the key name).
 */
export const INSTRUMENTS = Object.freeze({
  concert: { offset: 0, label: 'concert' },
  alto: { offset: 9, label: 'alto sax' },
  bari: { offset: 9, label: 'bari sax' },
  tenor: { offset: 2, label: 'tenor sax' },
  soprano: { offset: 2, label: 'soprano sax' },
});

const pc12 = (n) => ((n % 12) + 12) % 12;

/**
 * The whole display model, from the detector's raw output to what goes on screen.
 *
 * @param concertTonic         pitch class the DETECTOR reported, 0..11. This is
 *                             the recording's own key: the tap is upstream of
 *                             the pitch shifter (see the file header).
 * @param mode                 'major' | 'minor'. NEVER rotates. Transposition
 *                             moves the tonic; major stays major.
 * @param audioShiftSemitones  SEMITONES ADDED TO THE AUDIO'S CONCERT PITCH by
 *                             the transpose control. +2 means the user is now
 *                             hearing the record a whole tone higher, so C major
 *                             audio sounds as D major. Because the tap is
 *                             UPSTREAM, this is not yet in `concertTonic` and
 *                             must be added here. Adding it downstream too is
 *                             the double-count `transpose-composition` catches.
 * @param instrument           key of INSTRUMENTS.
 *
 * ONE function, ONE composition, and the tonic is reduced mod 12 exactly once
 * per returned value. AGENTS.md's entry-point rule is here because this repo has
 * had four defects from a value being right at one call site and wrong at
 * another; splitting "apply the shift" and "apply the horn" into two exported
 * functions is precisely how that happens a fifth time.
 *
 * Returns BOTH keys, ALWAYS LABELLED. The player needs the written key to read
 * and the concert key to talk to the guitarist and to sanity-check the tool. An
 * unlabelled key name on this screen is a bug, not a shorter string.
 */
export function displayKey(concertTonic, mode, audioShiftSemitones = 0, instrument = 'concert') {
  checkTonic(concertTonic);
  checkMode(mode);
  if (!Number.isInteger(audioShiftSemitones)) throw new TypeError(`audioShiftSemitones must be an integer, got ${audioShiftSemitones}`);
  const inst = INSTRUMENTS[instrument];
  if (!inst) throw new RangeError(`unknown instrument ${JSON.stringify(instrument)}; expected one of ${Object.keys(INSTRUMENTS).join(', ')}`);

  const sounding = pc12(concertTonic + audioShiftSemitones);
  const written = pc12(concertTonic + audioShiftSemitones + inst.offset);

  return {
    mode,
    audioShiftSemitones,
    instrument,
    instrumentLabel: inst.label,
    instrumentOffset: inst.offset,
    concert: {
      tonic: sounding,
      key: keyName(sounding, mode),
      notes: scaleNotes(sounding, mode),
      scale: scaleLine(sounding, mode),
      label: `${keyName(sounding, mode)} (concert)`,
    },
    written: {
      tonic: written,
      key: keyName(written, mode),
      notes: scaleNotes(written, mode),
      scale: scaleLine(written, mode),
      label: `${keyName(written, mode)} (${inst.label})`,
    },
  };
}

// ============================================================ display policy

/**
 * When a key may be shown, and when it may CHANGE. Policy as code, not prose,
 * because a value that lives in a doc gets re-decided by whoever writes the UI.
 *
 *   minListenSec   nothing at all before this, behind an explicit 'listening'
 *                  state. An early guess on 2 s of an intro is wrong often
 *                  enough to cost the user's trust in the whole feature.
 *   minConfidence  r_best - r_second below this is not an answer.
 *   switchMargin   how far a challenger must beat the INCUMBENT (not the
 *                  runner-up) before it counts as a challenge at all.
 *   switchUpdates  consecutive updates it must hold that margin for.
 *
 * The failure this prevents is specific: a label flickering between F# minor and
 * A major — the relative pair, which shares all seven notes — is worse than no
 * label for someone holding a horn, because they will re-finger mid-phrase.
 */
export const DISPLAY_POLICY = Object.freeze({
  minListenSec: 8,
  minConfidence: 0.05,
  switchMargin: 0.05,
  switchUpdates: 3,
});

/**
 * Hysteresis gate over a stream of `correlateKey` results.
 *
 * `update(estimate, elapsedSec)` -> `{ state, tonic, mode, confidence, streak }`
 * where state is 'listening' (nothing to show yet), 'showing' (the label is the
 * current winner) or 'holding' (a label is up but this update could not confirm
 * it — the estimate was null or too weak). It never blanks a label it has
 * already shown; going back to "listening" mid-song reads as a crash.
 */
export function createKeyDisplay(policy = DISPLAY_POLICY) {
  let shown = null;            // {tonic, modeIndex}
  let challenger = null;       // {tonic, modeIndex}
  let streak = 0;

  const same = (a, b) => a && b && a.tonic === b.tonic && a.modeIndex === b.modeIndex;
  const paint = (state, confidence) => ({
    state,
    tonic: shown ? shown.tonic : -1,
    mode: shown ? MODES[shown.modeIndex] : null,
    confidence,
    streak,
  });

  return {
    update(estimate, elapsedSec) {
      if (!estimate || elapsedSec < policy.minListenSec) {
        return paint(shown ? 'holding' : 'listening', estimate ? estimate.confidence : 0);
      }
      const best = { tonic: estimate.tonic, modeIndex: estimate.modeIndex };
      if (!shown) {
        if (estimate.confidence < policy.minConfidence) return paint('listening', estimate.confidence);
        shown = best; challenger = null; streak = 0;
        return paint('showing', estimate.confidence);
      }
      if (same(best, shown)) { challenger = null; streak = 0; return paint('showing', estimate.confidence); }

      const margin = estimate.scores[best.modeIndex * 12 + best.tonic] - estimate.scores[shown.modeIndex * 12 + shown.tonic];
      if (margin < policy.switchMargin || estimate.confidence < policy.minConfidence) {
        challenger = null; streak = 0;
        return paint('showing', estimate.confidence);
      }
      streak = same(best, challenger) ? streak + 1 : 1;
      challenger = best;
      if (streak >= policy.switchUpdates) { shown = best; challenger = null; streak = 0; }
      return paint('showing', estimate.confidence);
    },
    reset() { shown = null; challenger = null; streak = 0; },
  };
}

// ============================================================================
// self-check:  node extension/engine/chroma.js
// ============================================================================
// Deterministic, no audio device, no OfflineAudioContext (it does not exist in
// Node, so a test built on it could never run in the fast gate — and
// docs/AUDIO.md §1.3 has a standing warning about that route in Blink anyway).
// Audio is synthesised in plain JS and analysed through engine/fft.js.

async function selfCheck() {
  const { stft } = await import('./fft.js');

  let failures = 0, assertions = 0;
  const ok = (name, cond, detail = '') => {
    assertions++;
    console.log(`${cond ? ' ok  ' : 'FAIL '}${name}${detail ? '   ' + detail : ''}`);
    if (!cond) failures++;
  };
  const mulberry32 = (a) => () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  const SR = 44100;
  const N = CHROMA_FFT_SIZE;
  const HOP = 4096;

  // ---- synthesis -----------------------------------------------------------
  // Six harmonics at 1/n with an attack/decay envelope. NOT pure sines: a
  // pure-sine chord is unrealistically easy and never exercises harmonic
  // leakage, and harmonic leakage IS the difficulty — harmonic 3 lands a fifth
  // above and harmonic 5 a major third above every single note played, which is
  // exactly the bias that makes Krumhansl-Kessler report the dominant.
  const HARMONICS = 6;

  function addNote(buf, sr, midi, startSec, durSec, amp, rnd) {
    const f0 = A4_HZ * Math.pow(2, (midi - 69) / 12);
    const s0 = Math.round(startSec * sr), n = Math.round(durSec * sr);
    const atk = Math.max(1, Math.round(0.015 * sr));
    const rel = Math.max(1, Math.round(0.030 * sr));
    const phases = [];
    for (let h = 1; h <= HARMONICS; h++) phases.push(rnd() * 2 * Math.PI);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      let e = i < atk ? i / atk : Math.exp(-2.0 * (i - atk) / n);
      if (i > n - rel) e *= (n - i) / rel;
      let v = 0;
      for (let h = 1; h <= HARMONICS; h++) {
        const f = f0 * h;
        if (f > sr / 2) break;
        v += Math.sin(2 * Math.PI * f * t + phases[h - 1]) / h;
      }
      const j = s0 + i;
      if (j >= 0 && j < buf.length) buf[j] += amp * e * v;
    }
  }

  // Progressions as semitone offsets from the key's tonic.
  //   major  I - IV - V7 - I     covers all seven diatonic degrees
  //   minor  i - iv - V7 - i     the V7's major third IS the raised leading
  //                              tone (E# in C#7 -> F# minor), and it is the
  //                              only thing that separates a minor key from its
  //                              relative major, which share all seven notes.
  const PROG = {
    major: [{ bass: 0, chord: [0, 4, 7] }, { bass: 5, chord: [5, 9, 12] }, { bass: 7, chord: [7, 11, 14, 17] }, { bass: 0, chord: [0, 4, 7] }],
    minor: [{ bass: 0, chord: [0, 3, 7] }, { bass: 5, chord: [5, 8, 12] }, { bass: 7, chord: [7, 11, 14, 17] }, { bass: 0, chord: [0, 3, 7] }],
  };

  function renderProgression(tonic, mode, seed, { bars = 4, barSec = 2.0 } = {}) {
    const rnd = mulberry32(seed);
    const n = Math.round(bars * barSec * SR);
    const buf = new Float32Array(n);
    const prog = PROG[mode];
    for (let b = 0; b < bars; b++) {
      const c = prog[b % prog.length];
      const t0 = b * barSec;
      // MIDI 48 / 60 / 72 are all C, so `base + tonic` is the intended pitch
      // class. Using a base whose own pitch class is not 0 transposes that voice
      // alone -- a base of 45 (A2) put the bass a major sixth off and silently
      // turned every minor progression into its own Dorian, which reads as major.
      addNote(buf, SR, 48 + tonic + c.bass, t0, barSec * 0.95, 0.55, rnd);          // bass, 131-330 Hz
      for (const iv of c.chord) addNote(buf, SR, 60 + tonic + iv, t0, barSec * 0.95, 0.30, rnd);
      // melody: chord tones on the beat, last bar lands on the tonic
      for (let q = 0; q < 4; q++) {
        const isLast = b === bars - 1;
        const deg = isLast ? (q === 3 ? 0 : c.chord[q % c.chord.length] - c.chord[0]) : c.chord[q % c.chord.length] - c.chord[0];
        addNote(buf, SR, 72 + tonic + c.chord[0] + deg, t0 + q * barSec / 4, barSec / 4 * 0.9, 0.22, rnd);
      }
    }
    let peak = 0;
    for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(buf[i]));
    for (let i = 0; i < n; i++) buf[i] *= 0.9 / peak;
    return buf;
  }

  const rms = (x) => { let s = 0; for (let i = 0; i < x.length; i++) s += x[i] * x[i]; return Math.sqrt(s / x.length); };

  /** Band-limited noise bursts on 8ths — a drum kit's contribution to a spectrum. */
  function drumTrack(n, seed, level) {
    const rnd = mulberry32(seed);
    const buf = new Float32Array(n);
    let lp1 = 0, lp2 = 0, hp = 0;
    const aLp = 1 - Math.exp(-2 * Math.PI * 5000 / SR);
    const aHp = 1 - Math.exp(-2 * Math.PI * 150 / SR);
    for (let i = 0; i < n; i++) {
      const w = rnd() * 2 - 1;
      lp1 += aLp * (w - lp1); lp2 += aLp * (lp1 - lp2);
      hp += aHp * (lp2 - hp);
      buf[i] = lp2 - hp;
    }
    const step = Math.round(SR * 0.25);
    const env = new Float32Array(n);
    for (let s = 0; s < n; s += step) {
      const decay = (s / step) % 2 === 0 ? 0.09 : 0.05;   // backbeat longer than the hat
      const len = Math.min(n - s, Math.round(decay * 4 * SR));
      for (let i = 0; i < len; i++) env[s + i] = Math.max(env[s + i], Math.exp(-i / (decay * SR)));
    }
    for (let i = 0; i < n; i++) buf[i] *= env[i];
    const r = rms(buf) || 1e-9;
    for (let i = 0; i < n; i++) buf[i] *= level / r;
    return buf;
  }

  // ---- analysis ------------------------------------------------------------
  function frames(pcm) {
    const S = stft(pcm, N, HOP);
    const mag = new Float32Array(S.numBins);
    const out = [];
    for (let f = 0; f < S.numFrames; f++) {
      const off = f * S.numBins;
      for (let k = 0; k < S.numBins; k++) {
        const re = S.real[off + k], im = S.imag[off + k];
        mag[k] = Math.sqrt(re * re + im * im);
      }
      out.push(Float32Array.from(mag));
    }
    return out;
  }
  function analyse(pcm) {
    const acc = createChromaAccumulator();
    for (const m of frames(pcm)) acc.add(m, SR, N);
    return acc;
  }
  /** The key that came second, named. What lost tells you which bias is live. */
  function runnerUp(est) {
    const win = est.modeIndex * 12 + est.tonic;
    let r = -Infinity, idx = -1;
    for (let i = 0; i < 24; i++) if (i !== win && est.scores[i] > r) { r = est.scores[i]; idx = i; }
    return `${keyName(idx % 12, MODES[(idx / 12) | 0])} ${r.toFixed(4)}`;
  }

  console.log(`\n--- chroma: ${N}-point (${(SR / N).toFixed(2)} Hz/bin), band ${CHROMA_MIN_HZ}-${CHROMA_MAX_HZ} Hz, gate -${CHROMA_GATE_DB} dB ---`);
  {
    const map = binPitchClasses(SR, N);
    let inBand = 0;
    for (let k = 0; k < map.length; k++) if (map[k] >= 0) inBand++;
    console.log(`      ${inBand} of ${map.length} bins in band`);
  }

  // ---- chroma-maps-a440 -------------------------------------------------
  // The only test that fails cleanly when the +69 or the A440 reference is
  // wrong: one tone, one expected pitch class, nothing else in the signal.
  console.log('\n--- 1. bin -> pitch class ------------------------------------------------');
  {
    const n = SR * 2;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = 0.9 * Math.sin(2 * Math.PI * 440 * i / SR);
    const acc = analyse(x);
    const c = acc.chroma();
    ok('a440-frames-were-counted', acc.frames > 0, `${acc.frames} frames, ${acc.silentFrames} silent`);
    ok('a440-chroma-is-not-null', c !== null);
    if (c) {
      let total = 0;
      for (let i = 0; i < 12; i++) total += c[i];
      const share = c[9] / total;
      ok('chroma-maps-a440', share > 0.95, `pc9 (A) holds ${(share * 100).toFixed(2)} % of the weight`);
    } else {
      ok('chroma-maps-a440', false, 'no chroma to inspect');
    }
  }

  // ---- byte path -----------------------------------------------------------
  console.log('\n--- 2. byte path vs float path -------------------------------------------');
  {
    const pcm = renderProgression(0, 'major', 101);
    const fs = frames(pcm);
    let gPeak = 0;
    for (const m of fs) for (let k = 0; k < m.length; k++) if (m[k] > gPeak) gPeak = m[k];
    const maxDb = 20 * Math.log10(gPeak) + 1, minDb = maxDb - 70;
    const accF = createChromaAccumulator();
    const accB = createChromaAccumulator({ minDecibels: minDb, maxDecibels: maxDb });
    const bytes = new Uint8Array(fs[0].length);
    for (const m of fs) {
      accF.add(m, SR, N);
      for (let k = 0; k < m.length; k++) {
        const db = 20 * Math.log10(m[k] || 1e-300);
        bytes[k] = Math.max(0, Math.min(255, Math.round(255 * (db - minDb) / (maxDb - minDb))));
      }
      accB.add(bytes, SR, N);
    }
    const cf = accF.chroma(), cb = accB.chroma();
    ok('byte-path-produced-a-chroma', cf !== null && cb !== null, `${accF.frames} float frames, ${accB.frames} byte frames`);
    if (cf && cb) {
      let dot = 0, na = 0, nb = 0;
      for (let i = 0; i < 12; i++) { dot += cf[i] * cb[i]; na += cf[i] * cf[i]; nb += cb[i] * cb[i]; }
      const cos = dot / Math.sqrt(na * nb);
      const ef = correlateKey(cf), eb = correlateKey(cb);
      ok('byte-path-matches-float-path', cos > 0.99 && ef && eb && ef.tonic === eb.tonic && ef.mode === eb.mode,
        `cos=${cos.toFixed(5)}, ${ef ? keyName(ef.tonic, ef.mode) : 'null'} vs ${eb ? keyName(eb.tonic, eb.mode) : 'null'}`);
    } else {
      ok('byte-path-matches-float-path', false, 'one of the two paths produced nothing');
    }
  }

  // ---- key-sweep-all-12 -------------------------------------------------
  // The strongest cheap test available. A mod-12 off-by-one or a reversed
  // rotation fails ALL TWELVE with a constant offset, which is unmistakable;
  // a single-key test just looks like one bad track.
  console.log('\n--- 3. key sweep, all 12 tonics ------------------------------------------');
  // Run BOTH modes. A reversed rotation or a mod-12 off-by-one fails all twelve
  // at once with a CONSTANT offset -- unmistakable, where a single-key test just
  // looks like one bad track. The offsets row is printed for exactly that
  // reason: twelve zeroes is the shape of a correct rotation.
  for (const mode of MODES) {
    let hits = 0, minConf = Infinity, worst = '', second = '';
    const offsets = [];
    for (let t = 0; t < 12; t++) {
      const acc = analyse(renderProgression(t, mode, 200 + t + (mode === 'minor' ? 50 : 0)));
      const est = acc.estimate();
      if (!est) { offsets.push('null'); continue; }   // null is a miss, not a skip
      offsets.push(pc12(est.tonic - t));
      if (est.tonic === t && est.mode === mode) hits++;
      if (est.confidence < minConf) { minConf = est.confidence; worst = keyName(t, mode); second = runnerUp(est); }
      if (est.tonic !== t || est.mode !== mode) {
        console.log(`        ${keyName(t, mode)} -> ${keyName(est.tonic, est.mode)}  conf ${est.confidence.toFixed(4)}  2nd ${runnerUp(est)}`);
      }
    }
    const name = mode === 'major' ? 'key-sweep-all-12' : 'key-sweep-all-12-minor';
    ok(name, hits === 12 && offsets.length === 12,
      `${mode} I-${mode === 'major' ? 'IV' : 'iv'}-V7-${mode === 'major' ? 'I' : 'i'}: ${hits}/12, offsets [${offsets.join(' ')}], weakest ${worst} conf ${minConf.toFixed(4)} over ${second}`);
    ok(`key-sweep-${mode}-confidence-clears-the-display-gate`, minConf >= DISPLAY_POLICY.minConfidence,
      `min ${minConf.toFixed(4)} vs gate ${DISPLAY_POLICY.minConfidence}`);
  }

  // ---- mode-parallel ----------------------------------------------------
  console.log('\n--- 4. parallel major vs minor -------------------------------------------');
  {
    const maj = analyse(renderProgression(6, 'major', 301)).estimate();   // F# major
    const min = analyse(renderProgression(6, 'minor', 302)).estimate();   // F#m Bm C#7 F#m
    ok('mode-parallel-both-estimated', maj !== null && min !== null);
    if (maj && min) {
      ok('mode-parallel', maj.mode === 'major' && min.mode === 'minor' && maj.tonic === 6 && min.tonic === 6,
        `${keyName(maj.tonic, maj.mode)} conf ${maj.confidence.toFixed(4)} over ${runnerUp(maj)} | ${keyName(min.tonic, min.mode)} conf ${min.confidence.toFixed(4)} over ${runnerUp(min)}`);
    } else {
      ok('mode-parallel', false, 'a progression produced no estimate');
    }
  }

  // ---- mode-relative ----------------------------------------------------
  // The known-hard case: C major and A minor share all seven notes. The only
  // acoustic difference is which note the bass sits on and the G# the
  // harmonic-minor V7 brings in.
  //
  // ponytail: this passes here because the synthesis puts the root of every
  // chord in the bass and closes on the tonic. On real audio with a walking
  // bass, an inverted tonic chord, or a modal-borrowing chorus, the two
  // candidates can invert and the relative pair is exactly what the display
  // hysteresis exists to stop flickering. CEILING: a 12-bin chroma cannot see
  // WHICH note is in the bass — that information is thrown away by the fold.
  // UPGRADE PATH: accumulate a SECOND chroma from the `bass` stem alone over
  // 60-250 Hz and use it as a tie-breaker whenever the top two candidates are a
  // relative pair (tonics 3 apart, opposite modes) and `confidence` is under
  // ~0.08; the bass histogram's argmax is the tonic. That is one more
  // accumulator and about ten lines, and it needs the bass stem, which is why
  // it is not here yet.
  console.log('\n--- 5. relative major vs minor (C major vs A minor) ----------------------');
  {
    const cmaj = analyse(renderProgression(0, 'major', 401)).estimate();  // C  F  G7 C
    const amin = analyse(renderProgression(9, 'minor', 402)).estimate();  // Am Dm E7 Am
    ok('mode-relative-both-estimated', cmaj !== null && amin !== null);
    if (cmaj && amin) {
      const cRival = cmaj.scores[1 * 12 + 9];      // A minor's score on the C major track
      const aRival = amin.scores[0 * 12 + 0];      // C major's score on the A minor track
      ok('mode-relative', cmaj.tonic === 0 && cmaj.mode === 'major' && amin.tonic === 9 && amin.mode === 'minor',
        `${keyName(cmaj.tonic, cmaj.mode)} beats its relative A minor by ${(cmaj.r - cRival).toFixed(4)} | ${keyName(amin.tonic, amin.mode)} beats its relative C major by ${(amin.r - aRival).toFixed(4)}`);
      ok('mode-relative-margin-clears-the-display-gate',
        Math.min(cmaj.confidence, amin.confidence) >= DISPLAY_POLICY.minConfidence,
        `conf ${cmaj.confidence.toFixed(4)} / ${amin.confidence.toFixed(4)} vs gate ${DISPLAY_POLICY.minConfidence}`);
    } else {
      ok('mode-relative', false, 'a progression produced no estimate');
      ok('mode-relative-margin-clears-the-display-gate', false, 'no estimate to measure');
    }
  }

  // ---- transpose-composition -------------------------------------------
  // Pure function, no audio, milliseconds — and the only thing that catches a
  // double-count or a flipped sign, both of which look right in review.
  console.log('\n--- 6. transpose x instrument composition --------------------------------');
  {
    const OFF = { concert: 0, alto: 9, bari: 9, tenor: 2, soprano: 2 };
    let cases = 0, bad = 0, first = '';
    for (const mode of MODES) {
      for (let t = 0; t < 12; t++) {
        for (let shift = -6; shift <= 6; shift++) {
          for (const inst of ['concert', 'alto', 'tenor']) {
            const d = displayKey(t, mode, shift, inst);
            const wantConcert = pc12(t + shift);
            const wantWritten = pc12(t + shift + OFF[inst]);
            cases++;
            const good = d.concert.tonic === wantConcert
              && d.written.tonic === wantWritten
              && d.mode === mode
              && d.concert.key === keyName(wantConcert, mode)
              && d.written.key === keyName(wantWritten, mode)
              && d.concert.label.includes('concert')
              && d.written.label.includes(INSTRUMENTS[inst].label);
            if (!good) { bad++; if (!first) first = `${keyName(t, mode)} ${shift >= 0 ? '+' : ''}${shift} ${inst} -> ${d.concert.key} / ${d.written.key}`; }
          }
        }
      }
    }
    const fs = displayKey(6, 'minor', 0, 'alto');
    const ts = displayKey(6, 'minor', 0, 'tenor');
    const up2 = displayKey(0, 'major', 2, 'concert');
    ok('transpose-composition', bad === 0 && cases === 2 * 12 * 13 * 3, `${cases - bad}/${cases}${first ? ' first bad: ' + first : ''}`);
    ok('transpose-sign-and-spelling',
      fs.written.key === 'Eb minor' && ts.written.key === 'G# minor' && up2.concert.key === 'D major'
      && fs.concert.key === 'F# minor' && fs.written.scale === 'Eb minor: Eb F Gb Ab Bb Cb Db',
      `F#m -> alto ${fs.written.key} / tenor ${ts.written.key}; C major +2 -> ${up2.concert.key}; "${fs.written.scale}"`);
    // Mode never rotates, and every one of the 24 scales spells with 7 distinct letters.
    let letterBad = '';
    for (const mode of MODES) for (let t = 0; t < 12; t++) {
      const notes = scaleNotes(t, mode);
      const letters = new Set(notes.map((n) => n[0]));
      if (letters.size !== 7) letterBad = `${keyName(t, mode)}: ${notes.join(' ')}`;
    }
    ok('scale-spelling-uses-seven-distinct-letters', letterBad === '', letterBad || '24/24 keys');
  }

  // ---- drums-collapse-confidence ---------------------------------------
  // Turns "exclude drums" from an opinion in a doc into a measured claim.
  console.log('\n--- 7. drums collapse confidence -----------------------------------------');
  {
    const clean = renderProgression(6, 'minor', 501);
    const cleanEst = analyse(clean).estimate();
    const NOISE_OVER_MUSIC_DB = 3.5;    // drums at +3.5 dB RMS over the harmonic content
    const level = rms(clean) * Math.pow(10, NOISE_OVER_MUSIC_DB / 20);
    const noise = drumTrack(clean.length, 502, level);
    const mixed = new Float32Array(clean.length);
    for (let i = 0; i < clean.length; i++) mixed[i] = clean[i] + noise[i];
    const acc = analyse(mixed);
    const noisyEst = acc.estimate();
    ok('drums-both-mixes-were-measured', cleanEst !== null && noisyEst !== null && acc.frames > 0,
      `${acc.frames} noisy frames`);
    if (cleanEst && noisyEst) {
      ok('drums-collapse-confidence',
        cleanEst.confidence >= DISPLAY_POLICY.minConfidence && noisyEst.confidence < DISPLAY_POLICY.minConfidence,
        `drums +${NOISE_OVER_MUSIC_DB} dB: clean ${keyName(cleanEst.tonic, cleanEst.mode)} conf ${cleanEst.confidence.toFixed(4)} >= ${DISPLAY_POLICY.minConfidence} > noisy ${keyName(noisyEst.tonic, noisyEst.mode)} conf ${noisyEst.confidence.toFixed(4)}`);
    } else {
      ok('drums-collapse-confidence', false, 'a mix produced no estimate');
    }
  }

  // ---- per-frame normalisation --------------------------------------------
  // Added because a mutation that deleted the normalisation entirely passed
  // every other assertion in this file: the synthesised fixtures are all one
  // loudness, so nothing here could see it. That is a check reporting coverage
  // it does not have, which AGENTS.md rates worse than no check.
  console.log('\n--- 8. per-frame normalisation -------------------------------------------');
  {
    // 12 s of QUIET C major then 4 s of LOUD F# major -- the tritone, the most
    // distant key there is. One frame is one vote, so C major must win 3:1 on
    // duration. Without the normalisation the loud four seconds decide the whole
    // track, which is the real failure "the chorus is louder, so the chorus is
    // the key".
    const quiet = renderProgression(0, 'major', 801, { bars: 6, barSec: 2.0 });
    const loud = renderProgression(6, 'major', 802, { bars: 2, barSec: 2.0 });
    for (let i = 0; i < quiet.length; i++) quiet[i] *= 0.08;      // -22 dB
    const pcm = new Float32Array(quiet.length + loud.length);
    pcm.set(quiet, 0); pcm.set(loud, quiet.length);
    const fs = frames(pcm);
    const acc = createChromaAccumulator();
    for (const m of fs) acc.add(m, SR, N);
    const est = acc.estimate();
    // Control: the SAME frames summed WITHOUT the per-frame normalisation. It is
    // asserted on, not just printed -- if the control ever stops landing on the
    // loud key the fixture has lost its discriminating power and this assertion
    // must go red rather than quietly stop testing anything.
    const raw = new Float32Array(12), one = new Float32Array(12);
    for (const m of fs) { foldChroma(m, SR, N, { out: one }); for (let i = 0; i < 12; i++) raw[i] += one[i]; }
    const rawEst = correlateKey(raw);
    ok('normalisation-control-and-test-both-produced-an-estimate', est !== null && rawEst !== null, `${fs.length} frames`);
    ok('frame-normalisation-outvotes-the-loud-section',
      est !== null && rawEst !== null && est.tonic === 0 && est.mode === 'major' && rawEst.tonic === 6,
      `12 s quiet C major + 4 s loud (-22 dB apart) F# major: normalised -> ${est ? keyName(est.tonic, est.mode) : 'null'} conf ${est ? est.confidence.toFixed(4) : '-'}, raw-sum control -> ${rawEst ? keyName(rawEst.tonic, rawEst.mode) : 'null'}`);
  }

  // ---- display gate --------------------------------------------------------
  console.log('\n--- 9. display gate ------------------------------------------------------');
  {
    const mk = (tonic, modeIndex, rBest, rIncumbent, incumbent) => {
      const scores = new Float64Array(24);
      scores[modeIndex * 12 + tonic] = rBest;
      if (incumbent) scores[incumbent.modeIndex * 12 + incumbent.tonic] = rIncumbent;
      return { tonic, modeIndex, mode: MODES[modeIndex], r: rBest, confidence: rBest - rIncumbent, scores };
    };
    const g = createKeyDisplay();
    const early = g.update(mk(6, 1, 0.9, 0.5), 4);
    ok('gate-says-listening-before-minListenSec', early.state === 'listening' && early.mode === null, `at 4 s: ${early.state}`);
    const shown = g.update(mk(6, 1, 0.9, 0.5), 9);
    ok('gate-shows-after-minListenSec', shown.state === 'showing' && shown.tonic === 6 && shown.mode === 'minor', `${shown.state} ${shown.mode}`);
    const inc = { tonic: 6, modeIndex: 1 };
    let s = null;
    for (let i = 0; i < 2; i++) s = g.update(mk(9, 0, 0.9, 0.80, inc), 12 + i);   // A major, +0.10 over F# minor
    ok('gate-holds-through-two-strong-challenges', s.tonic === 6 && s.streak === 2, `streak ${s.streak}, still ${keyName(s.tonic, s.mode)}`);
    s = g.update(mk(9, 0, 0.9, 0.80, inc), 14);
    ok('gate-switches-on-the-third', s.tonic === 9 && s.mode === 'major', `${keyName(s.tonic, s.mode)}`);
    const g2 = createKeyDisplay();
    g2.update(mk(0, 0, 0.9, 0.5), 9);
    let t = null;
    for (let i = 0; i < 6; i++) t = g2.update(mk(9, 1, 0.9, 0.88, { tonic: 0, modeIndex: 0 }), 12 + i);  // relative pair, +0.02
    ok('gate-never-switches-on-a-sub-margin-relative-rival', t.tonic === 0 && t.mode === 'major',
      `after 6 updates at +0.02: ${keyName(t.tonic, t.mode)}`);
    const held = g2.update(null, 20);
    ok('gate-holds-a-label-when-an-update-has-no-estimate', held.state === 'holding' && held.tonic === 0, held.state);
  }

  // ---- refusals ------------------------------------------------------------
  // Every "we could not measure" branch, asserted. These are the paths the rest
  // of the product's null-handling rests on: if `estimate()` ever returned a
  // plausible-looking key for an empty accumulator, every `!est ||` guard
  // downstream would report coverage it does not have.
  console.log('\n--- 10. refusals ---------------------------------------------------------');
  {
    const threw = (fn) => { try { fn(); return false; } catch (e) { return true; } };
    ok('foldChroma-throws-on-a-short-spectrum',
      threw(() => foldChroma(new Float32Array(1024), SR, N)),
      'a short spectrum would silently fold a narrower band and still name a key');
    ok('correlateKey-throws-on-a-non-12-vector', threw(() => correlateKey(new Float32Array(11))));
    ok('correlateKey-throws-on-null', threw(() => correlateKey(null)));
    ok('correlateKey-returns-null-on-an-empty-chroma', correlateKey(new Float32Array(12)) === null);
    const flat = new Float32Array(12).fill(0.25);
    ok('correlateKey-returns-null-on-a-flat-chroma', correlateKey(flat) === null, 'every rotation scores identically; there is no argmax');
    const acc = createChromaAccumulator();
    ok('accumulator-chroma-is-null-before-any-frame', acc.chroma() === null && acc.estimate() === null && acc.frames === 0);
    const silent = new Float32Array(N / 2);
    ok('a-silent-frame-is-not-counted-as-a-frame',
      acc.add(silent, SR, N) === false && acc.frames === 0 && acc.silentFrames === 1,
      `frames ${acc.frames}, silent ${acc.silentFrames}`);
    ok('displayKey-throws-on-a-bad-tonic-mode-shift-or-instrument',
      threw(() => displayKey(12, 'major', 0, 'alto'))
      && threw(() => displayKey(0, 'dorian', 0, 'alto'))
      && threw(() => displayKey(0, 'major', 1.5, 'alto'))
      && threw(() => displayKey(0, 'major', 0, 'trumpet')));
  }

  // ---- cost ----------------------------------------------------------------
  console.log('\n--- 11. cost -------------------------------------------------------------');
  {
    const pcm = renderProgression(0, 'major', 601);
    const fs = frames(pcm);
    const acc = createChromaAccumulator();
    const reps = 40;
    let t0 = process.hrtime.bigint();
    for (let r = 0; r < reps; r++) for (const m of fs) acc.add(m, SR, N);
    let dt = Number(process.hrtime.bigint() - t0) / 1e6;
    const perFrame = dt / (reps * fs.length);
    const c = acc.chroma();
    t0 = process.hrtime.bigint();
    for (let r = 0; r < 20000; r++) correlateKey(c);
    const perKey = Number(process.hrtime.bigint() - t0) / 1e6 / 20000;
    console.log(`      foldChroma+accumulate ${perFrame.toFixed(3)} ms/frame  (${(reps * fs.length)} frames)`);
    console.log(`      correlateKey          ${(perKey * 1000).toFixed(1)} us/estimate`);
    ok('cost-fold-under-2ms-per-frame', perFrame < 2, `${perFrame.toFixed(3)} ms`);
    ok('cost-correlate-under-50us', perKey < 0.05, `${(perKey * 1000).toFixed(1)} us`);
  }

  console.log(failures ? `\n${failures} FAILURE(S) of ${assertions}\n` : `\nall ${assertions} chroma checks passed\n`);
  process.exit(failures ? 1 : 0);
}

// Node only, and only when this file IS the entry point. No top-level await:
// the extension imports this module synchronously and must not be made async.
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return selfCheck();
  }).catch((e) => { console.error(e); process.exit(1); });
}
