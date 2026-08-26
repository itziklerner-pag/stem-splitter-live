/**
 * Spotify Basic Pitch's three output heads -> a list of closed notes.
 *
 * PURE ARITHMETIC. No ORT, no worker, no browser API, no `chrome.*`. It does not
 * know what a stem is and it does not know what a second of video is — it speaks
 * LANE SAMPLES AT 22 050 Hz and nothing else, which is what makes
 * `node extension/engine/notes.js` a real check rather than a mock. Everything
 * that has to know about the product (which stem a lane is, which source second a
 * lane sample is, which spans were covered) lives in `offscreen/transcribe.js`.
 *
 *   [172, 88]  note head     activation: "this pitch is sounding in this frame"
 *   [172, 88]  onset head    activation: "this pitch STARTS in this frame"
 *   [172, 264] contour head  fine pitch, 3 bins per semitone — ACCEPTED, IGNORED
 *     -> argrelmax over the onset head, threshold 0.5
 *     -> forward walk over the note head, threshold 0.3, tolerance 11 frames
 *     -> minimum length 11 frames, energy claimed at bin-1/bin/bin+1
 *     -> { pitch, vel, onSample, offSample }
 *
 * ============================================================== ATTRIBUTION
 *
 * The algorithm is a port of `basic_pitch/note_creation.py::output_to_notes_polyphonic`
 * and `::argrelmax` from spotify/basic-pitch @ 9991303bba609a3b93089d13ec80d1d495083596
 * (tag v0.4.0), Apache-2.0, (c) Spotify AB. The weights this decodes are the same
 * project's `icassp_2022/nmp.onnx` and are redistributed here under the same
 * licence — see `NOTICE.md` and ADR 0002. The thresholds are that repository's
 * FUNCTION-SIGNATURE DEFAULTS in `basic_pitch/inference.py::predict`, not named
 * `DEFAULT_*` constants; `shared/config.js`'s `BASIC_PITCH` says so where it
 * carries them, and this file re-types none of them.
 *
 * ============================= THE FRAME GRID — the one thing to get right =====
 *
 * The model is run on overlapping 43 844-sample windows every 36 164 samples and
 * 15 frames are dropped from each end of each window's 172, leaving 142. The
 * tempting move is to concatenate those 142-frame blocks and index the result as
 * one uniform stream. THAT IS ARITHMETICALLY WRONG AND IT DRIFTS: 142 * 256 =
 * 36 352 against a hop of 36 164, so a naive global frame index gains 188 samples
 * = 8.5 ms per window = 0.52 %, which is about 1.25 s over a four-minute song —
 * a transcription that starts in time and ends a bar and a half late. So the
 * mapping is fixed AT THE WINDOW, never at the stream:
 *
 *     kept frame k (0 <= k < 142) of window w sits at lane sample
 *         w * BASIC_PITCH.hop + k * BASIC_PITCH.fftHop
 *
 * Derivation, so it can be checked rather than believed. Window `w`'s input
 * starts at lane sample `w*36164 - 3840`; the negative indices are the pre-roll
 * zeros, which is why the pre-roll is `3840 = 15 * 256` and not a free parameter.
 * Model frame `f` covers input offset `f*256`. Keeping `f` in [15, 157) gives
 * `k = f - 15` at `w*36164 - 3840 + (k+15)*256 = w*36164 + k*256`. The pre-roll
 * cancels exactly. `frame-map-*` below asserts it, and asserts the naive map
 * disagrees by exactly 188*w — so the assertion is about the DRIFT and not about
 * a formula copied twice into two places that agree with each other.
 *
 * The consequence, stated rather than discovered: consecutive windows leave a
 * 68-sample (3.1 ms) SEAM in the frame grid every 1.64 s. That is under one frame
 * period, and it has a useful side effect — window w's frame 141 and window w+1's
 * frame 0 describe the same 11.6 ms of audio, 73 % overlapped, so upstream's
 * `while i < n_frames - 1` bound doubles here as the de-duplication of the seam.
 *
 * ponytail: CEILING — an onset time carries up to 3.1 ms of grid quantisation at
 * a window seam, and a note that spans a seam has its length counted one frame
 * generously. UPGRADE PATH — overlap the kept ranges rather than butting them,
 * and pick the frame nearer its own window's centre; that costs a second decode
 * pass over the overlap and buys 3 ms, which is worth doing the day anything
 * downstream can use 3 ms and not before.
 *
 * ================================== WHAT THIS BUILD DOES NOT DO, AND THE COST ==
 *
 * `melodia_trick` is OFF and `infer_onsets` is OFF. Both are WHOLE-MATRIX
 * operations upstream: the melodia trick re-mines the residual energy of the
 * entire file after every onset-led note has been taken, and `get_infered_onsets`
 * normalises by a maximum taken over the whole matrix. Run per 142-frame window —
 * which is what live transcription is — both become window-dependent: the same
 * audio decodes differently depending on where the window boundary fell, and both
 * invent notes at window edges, where there is least evidence.
 *
 * THE HONEST COST, written here rather than hidden: THIS BUILD FINDS FEWER NOTES
 * THAN THE UPSTREAM CLI ON LEGATO AND QUIET PASSAGES. A note whose onset the
 * onset head missed is never recovered, where upstream's melodia trick would have
 * found it in the leftover frame energy.
 *
 * ponytail: CEILING — no onset-free note is ever recovered. UPGRADE PATH — a
 * second, non-real-time pass over a retained activation matrix at flush time,
 * with the maximum taken over the retained matrix rather than the window. That is
 * a feature with a caller behind it (a "polish the take" gesture), not a cleanup,
 * and it needs the activation matrix kept for the length of a song: four minutes
 * is 240 * 86.13 = 20 672 frames, so 7.3 MB per lane for the note head alone at
 * float32 and 36 MB per lane if all three heads are kept — 36 MB times five lanes
 * is a decision, not a detail.
 *
 * ponytail: THE CONTOUR HEAD IS DECODED TO NOTHING. `decodeWindow` accepts it and
 * ignores it; `contourBinToMidi` exists so its geometry is checkable and is called
 * by nothing but the suite. CEILING — no pitch bend and no fine tuning: a bent
 * note, a vibrato and a portamento all land on the nearest equal-tempered
 * semitone, and a glissando becomes a staircase. UPGRADE PATH — take the
 * energy-weighted mean contour bin over each note's span, subtract the note's own
 * semitone, and emit a pitch-bend event per note in `shared/midi.js`; that needs a
 * bend RANGE agreed with the writer (GM default is +/-2 semitones) and it needs the
 * contour tensor to cross the worker boundary, which today it does not.
 *
 * ================================================== WHY IT IS A CARRY, NOT A MAP
 *
 * Upstream sees the whole file at once and can walk a note forward as far as it
 * likes. Here a window is 142 frames and a note may still be sounding when it
 * ends, so `decodeWindow` returns CLOSED notes only and keeps the open ones in a
 * carry — one slot per bin, no allocation. The carry is also what gives kept frame
 * 0 of window w>0 a left neighbour, so an onset landing on the first frame of a
 * window is not silently unfindable. `breakDecoder` is the other half: when the
 * lane's stream is cut (an uncovered span, a dropped window) the open notes are
 * closed where they last had energy and the next window starts fresh, because a
 * note may not span a discontinuity.
 */

import { BASIC_PITCH } from '../shared/config.js';

/**
 * Minimum note length in frames. DERIVED, never typed: `round(0.1277 * 86.1328125)`
 * = 11. A note of exactly this length is REJECTED (upstream's test is
 * `i - start <= min_note_len`), which is why `min-length-*` below asserts both 11
 * and 12 — one of them alone would pass against a threshold that was never read.
 */
const MIN_LEN_FRAMES = Math.round((BASIC_PITCH.minNoteMs / 1000) * BASIC_PITCH.fps);

/**
 * MIDI pitch for a note/onset bin. bin i -> BASIC_PITCH.midiLow + i.
 * @param {number} bin 0..87  @returns {number} 21..108
 */
export function binToMidi(bin) {
  return BASIC_PITCH.midiLow + bin;
}

/**
 * MIDI pitch (fractional) for a contour bin. j -> 21 + (j - 1) / 3.
 * Present because the geometry is part of the pin and a reader must be able to
 * check it; NOTHING in this build consumes the contour head today. Declared,
 * asserted, and not wired — see the ponytail in this file's header.
 * @param {number} bin 0..263  @returns {number}
 */
export function contourBinToMidi(bin) {
  return BASIC_PITCH.midiLow + (bin - 1) / 3;
}

/**
 * Kept frame `k` of window `w` -> lane sample at 22 050 Hz. The header derives it
 * and `frame-map-*` asserts it against the naive map it is easy to write instead.
 * Module-private on purpose: nothing outside needs the grid, because every value
 * that leaves this file is already in lane samples.
 */
function laneSample(w, k) {
  return w * BASIC_PITCH.hop + k * BASIC_PITCH.fftHop;
}

/** @returns {object} fresh carry: no open notes, no window seen. */
export function newDecoder() {
  const { bins, keep } = BASIC_PITCH;
  const st = {
    // The residual energy matrix, upstream's `remaining_energy`, for the window
    // being decoded. Allocated ONCE per lane (142 * 88 float32 = 50 KB) and
    // overwritten per window, because `decodeWindow` MUST NOT allocate per frame.
    res: new Float32Array(keep * bins),
    // Kept frame 141's onset row from the previous window, so frame 0 of the next
    // one has a left neighbour and an onset there is findable.
    prevOnset: new Float32Array(bins),

    // ---- open notes carried ACROSS windows, one slot per bin. Parallel typed
    // arrays rather than objects so a carry costs nothing to keep and nothing to
    // clear. `onS[b] < 0` means "no open note in this bin".
    onS: new Float64Array(bins).fill(-1),   // onset lane sample
    endS: new Float64Array(bins),           // exclusive end lane sample, at the last above-threshold frame
    run: new Int32Array(bins),              // frames advanced since the onset frame
    endRun: new Int32Array(bins),           // `run` at that last above-threshold frame
    bel: new Int32Array(bins),              // consecutive frames below frameThreshold
    sum: new Float64Array(bins),            // running sum of the NOTE head over [onset .. here]
    sumE: new Float64Array(bins),           // that sum at the last above-threshold frame

    // ---- notes opened by THIS window that are still open when it ends. Kept
    // apart from the carry above because the two can be live at the same time: a
    // retriggered pitch has a new note starting while the old one is still being
    // closed, and one array cannot hold both.
    cOnS: new Float64Array(bins).fill(-1),
    cEndS: new Float64Array(bins),
    cRun: new Int32Array(bins),
    cEndRun: new Int32Array(bins),
    cBel: new Int32Array(bins),
    cSum: new Float64Array(bins),
    cSumE: new Float64Array(bins),

    fresh: true,        // the next window starts a stream, so its frame 0 has no left neighbour
    seen: false,        // any window decoded yet
    lastW: -1,          // the last window index decoded
    skips: 0,           // forward window jumps absorbed as implicit breaks
  };
  return st;
}

/** Close every open note at the last frame it actually had energy. */
function closeCarry(st, out) {
  const { bins } = BASIC_PITCH;
  for (let b = 0; b < bins; b++) {
    if (st.onS[b] < 0) continue;
    emit(out, b, st.onS[b], st.endS[b], st.endRun[b], st.sumE[b]);
    st.onS[b] = -1;
  }
}

/**
 * Push one closed note, if it is long enough to be one.
 *
 * `endRun + 1` is the length in frames: upstream's `i - note_start_idx` where `i`
 * has already been backed off past the trailing sub-threshold run. `<=` and not
 * `<`, exactly as upstream: a note of exactly MIN_LEN_FRAMES is rejected.
 *
 * Velocity is `clamp(round(127 * mean), 1, 127)` over the note head's ORIGINAL
 * values across the note's own span — not the residual, which has been zeroed by
 * whatever claimed it, and not the whole walk, which includes the trailing frames
 * the back-off removed. Clamped to 1 at the bottom because a MIDI note-on with
 * velocity 0 IS A NOTE-OFF, so a very quiet note would silently vanish inside the
 * file rather than be quiet in it. That clamp is a GUARD, not a live path: at the
 * shipped thresholds the walk already bounds the mean at
 * `frameThreshold / (energyTol + 1)` = 0.025 -> vel 3, and `8. velocity` asserts
 * that bound rather than the clamp, which no input can reach.
 */
function emit(out, bin, onSample, endSample, endRun, sumE) {
  const len = endRun + 1;
  if (len <= MIN_LEN_FRAMES) return false;
  const amp = sumE / len;
  const vel = Math.max(1, Math.min(127, Math.round(127 * amp)));
  out.push({ pitch: binToMidi(bin), vel, onSample, offSample: endSample });
  return true;
}

/** Claim `[k0, k1)` at `bin-1`, `bin` and `bin+1` so nothing can re-claim it. */
function claim(res, bins, bin, k0, k1) {
  const lo = bin > 0 ? bin - 1 : bin;
  const hi = bin < bins - 1 ? bin + 1 : bin;
  for (let k = k0; k < k1; k++) {
    const row = k * bins;
    for (let b = lo; b <= hi; b++) res[row + b] = 0;
  }
}

/**
 * Decode ONE window's three heads into closed notes, carrying open notes
 * across the window boundary.
 *
 * @param {object} st            per-lane carry, from `newDecoder()`
 * @param {Float32Array} note    [172*88],  row-major, frame-major
 * @param {Float32Array} onset   [172*88],  same layout
 * @param {Float32Array} contour [172*264], accepted and IGNORED (see above)
 * @param {number} w             window index, 0-based, monotonic per lane
 * @returns {Array<{pitch:number, vel:number, onSample:number, offSample:number}>}
 *   CLOSED notes only, in lane samples at 22050 Hz, sorted by onSample then
 *   pitch. A note still sounding at the end of the window stays in `st` and is
 *   returned by a LATER call or by `flushDecoder`.
 *
 * MUST NOT allocate per frame. MUST NOT return an open note. MUST NOT read
 * frames outside the kept range.
 */
export function decodeWindow(st, note, onset, contour, w) {
  const {
    bins, keep, trim, frames, contourBins,
    onsetThreshold, frameThreshold, energyTol, fftHop,
  } = BASIC_PITCH;

  // ---- the shape guards. AGENTS.md: if the thing being inspected is missing,
  // that IS the failure. A short tensor decoded as if it were whole produces a
  // plausible note list from garbage, with no error anywhere. `>=` and not `===`
  // because a caller handing a larger scratch buffer is harmless — only the
  // kept frames are ever read — while a SHORT one is the defect.
  if (!(note && note.length >= frames * bins)) {
    throw new Error(`decodeWindow: note head is ${note ? note.length : 'absent'}, needs ${frames * bins}`);
  }
  if (!(onset && onset.length >= frames * bins)) {
    throw new Error(`decodeWindow: onset head is ${onset ? onset.length : 'absent'}, needs ${frames * bins}`);
  }
  if (!(contour && contour.length >= frames * contourBins)) {
    throw new Error(`decodeWindow: contour head is ${contour ? contour.length : 'absent'}, needs ${frames * contourBins}`);
  }
  if (!Number.isInteger(w) || w < 0) {
    throw new Error(`decodeWindow: window index must be a non-negative integer, got ${w}`);
  }

  const out = [];

  // ---- window ordering. A repeated or backward window is the call site being
  // wrong about its own counter and there is no sane thing to do with it, so it
  // throws. A FORWARD jump is different: §2.8's backpressure drops the oldest
  // queued window and sends BREAK for its lane, so a gap in `w` is a discontinuity
  // that has already happened. Treating it as an implicit break is the same
  // action the caller is required to take, taken here as well rather than
  // instead — a note may not span a hole in the audio.
  if (st.seen && w <= st.lastW) {
    throw new Error(`decodeWindow: window ${w} is not after ${st.lastW}; windows are monotonic per lane`);
  }
  if (st.seen && !st.fresh && w > st.lastW + 1) {
    closeCarry(st, out);
    st.fresh = true;
    st.skips++;
  }

  // ---- 1. the residual energy matrix: this window's kept frames of the note
  // head, which the walks below consume and zero. `set` over a view, so no
  // per-frame loop and no allocation beyond the view itself.
  const res = st.res;
  res.set(note.subarray(trim * bins, (trim + keep) * bins));

  // ---- 2. the onset pass, BACKWARDS IN TIME.
  //
  // The order is not cosmetic and it is upstream's: `onset_time_idx[::-1]`, over
  // indices numpy returns in (time, then bin) ascending order, so descending
  // frame outside and descending bin inside is the same sequence. It decides
  // which note claims shared energy when two onsets overlap — the later one
  // claims first, so a repeated pitch RETRIGGERS instead of the first note
  // swallowing the second.
  //
  // The peak test is upstream's `argrelmax`: strictly greater than the frame
  // before, greater than OR EQUAL TO the frame after. The asymmetry matters — a
  // flat-topped onset (three frames at 0.9) has no strictly-greater-both-sides
  // frame at all, so a symmetric `>` would find NOTHING there. `> prev` and
  // `>= next` picks the first frame of the plateau, which is where the note
  // started.
  //
  // Kept frame 141 is not a candidate (no right neighbour, and upstream's
  // `note_start_idx >= n_frames - 1: continue` excludes it anyway). Kept frame 0
  // is a candidate only when the carry holds the previous window's last onset
  // row; on a fresh stream it has no left neighbour and is skipped.
  const firstK = st.fresh || !st.seen ? 1 : 0;
  for (let k = keep - 2; k >= firstK; k--) {
    const row = (k + trim) * bins;
    const prevRow = (k - 1 + trim) * bins;
    const nextRow = (k + 1 + trim) * bins;
    for (let b = bins - 1; b >= 0; b--) {
      const v = onset[row + b];
      if (!(v >= onsetThreshold)) continue;
      const left = k === 0 ? st.prevOnset[b] : onset[prevRow + b];
      if (!(v > left)) continue;
      if (!(v >= onset[nextRow + b])) continue;

      // ---- 3. walk forward over the residual while the note head holds up,
      // tolerating up to `energyTol` consecutive frames below `frameThreshold`.
      // `endRun`/`endS`/`sumE` remember the last frame that was actually above
      // it, which is upstream's `i -= k` back-off expressed as a high-water mark
      // instead of a subtraction — the same number, and it survives a window
      // boundary, where a subtraction would go negative.
      let run = 0, bel = 0, endRun = 0;
      let sum = note[row + b];
      let sumE = sum;
      let endS = laneSample(w, k) + fftHop;
      let i = k + 1;
      for (; i < keep - 1; i++) {
        run++;
        sum += note[(i + trim) * bins + b];
        if (res[i * bins + b] < frameThreshold) {
          bel++;
          if (bel >= energyTol) break;
        } else {
          bel = 0; endRun = run; sumE = sum; endS = laneSample(w, i) + fftHop;
        }
      }

      if (bel >= energyTol) {
        // Closed inside this window. Upstream drops a too-short note BEFORE
        // zeroing anything, so a rejected candidate leaves the energy for
        // whatever else wants it — keep that order.
        if (emit(out, b, laneSample(w, k), endS, endRun, sumE)) {
          claim(res, bins, b, k, k + endRun + 1);
        }
      } else {
        // Still sounding when the window ran out. It becomes this window's open
        // note for the bin. There can only ever be one: an onset processed
        // earlier in this loop is LATER in time, and if it stayed open it zeroed
        // the residual from its own frame to the end, so any earlier onset in the
        // same bin closes at that frame rather than running past it.
        st.cOnS[b] = laneSample(w, k);
        st.cEndS[b] = endS;
        st.cRun[b] = run; st.cEndRun[b] = endRun; st.cBel[b] = bel;
        st.cSum[b] = sum; st.cSumE[b] = sumE;
        // Claimed to the end of the window, not to `endRun`: the note is still
        // going, so the frames it has not resolved yet are not free either.
        claim(res, bins, b, k, keep);
      }
    }
  }

  // ---- 4. the carried notes, LAST, because they started earliest and upstream
  // takes notes latest-first. Doing this before the onset pass would let a note
  // held over from the previous window swallow the retrigger that starts inside
  // this one, which is the difference between a repeated chord and one long chord.
  //
  // Deviation, named rather than hidden: upstream orders EVERY note by start time
  // descending, including two carried notes relative to each other; this walks
  // them in bin order. The two differ only when two carried notes are a SEMITONE
  // apart, where the b+/-1 claim of one touches the other, and the difference is
  // which of the two keeps the shared energy.
  for (let b = 0; b < bins; b++) {
    if (st.onS[b] < 0) continue;
    let run = st.run[b], bel = st.bel[b], endRun = st.endRun[b];
    let sum = st.sum[b], sumE = st.sumE[b], endS = st.endS[b];
    let lastAbove = -1;
    let i = 0;
    for (; i < keep - 1; i++) {
      run++;
      sum += note[(i + trim) * bins + b];
      if (res[i * bins + b] < frameThreshold) {
        bel++;
        if (bel >= energyTol) break;
      } else {
        bel = 0; endRun = run; sumE = sum; endS = laneSample(w, i) + fftHop; lastAbove = i;
      }
    }
    claim(res, bins, b, 0, lastAbove + 1);

    if (bel >= energyTol) {
      emit(out, b, st.onS[b], endS, endRun, sumE);
      st.onS[b] = -1;
    } else if (st.cOnS[b] >= 0) {
      // A new onset in this bin owns the rest of the window, so this note cannot
      // continue past it even though it has not run out of tolerance yet. Close
      // it where it last had energy — which is at or before the new onset,
      // because the new onset zeroed everything from its own frame onward.
      emit(out, b, st.onS[b], endS, endRun, sumE);
      st.onS[b] = -1;
    } else {
      st.run[b] = run; st.bel[b] = bel; st.endRun[b] = endRun;
      st.sum[b] = sum; st.sumE[b] = sumE; st.endS[b] = endS;
    }
  }

  // ---- 5. install this window's still-open notes into the carry.
  for (let b = 0; b < bins; b++) {
    if (st.cOnS[b] < 0) continue;
    st.onS[b] = st.cOnS[b]; st.endS[b] = st.cEndS[b];
    st.run[b] = st.cRun[b]; st.endRun[b] = st.cEndRun[b]; st.bel[b] = st.cBel[b];
    st.sum[b] = st.cSum[b]; st.sumE[b] = st.cSumE[b];
    st.cOnS[b] = -1;
  }

  st.prevOnset.set(onset.subarray((keep - 1 + trim) * bins, (keep + trim) * bins));
  st.lastW = w;
  st.seen = true;
  st.fresh = false;

  out.sort((x, y) => x.onSample - y.onSample || x.pitch - y.pitch);
  return out;
}

/**
 * Close every open note at the last decoded frame and empty the carry.
 * @returns {Array<{pitch, vel, onSample, offSample}>}
 *
 * "At the last decoded frame" is the ceiling; what is actually written is the
 * last frame at which the note was above `frameThreshold`, which is at most
 * `energyTol` frames (128 ms) earlier and never later. Using the window's end
 * would append up to 128 ms of note that the model did not report, and a
 * transcription that invents sustain is worse than one that clips it.
 */
export function flushDecoder(st) {
  const out = [];
  closeCarry(st, out);
  resetCarry(st);
  st.seen = false;
  st.lastW = -1;
  out.sort((x, y) => x.onSample - y.onSample || x.pitch - y.pitch);
  return out;
}

/**
 * The lane's stream was cut (an uncovered span, a dropped window). Close every
 * open note at the last decoded frame, return them, and mark the carry so the
 * NEXT window is treated as a fresh start rather than a continuation.
 * @returns {Array<{pitch, vel, onSample, offSample}>}
 *
 * `seen` and `lastW` are deliberately KEPT: the lane's window counter has not
 * restarted, and the monotonicity guard in `decodeWindow` still has to hold
 * across the break. What is thrown away is the musical continuity — the open
 * notes and the previous window's onset row, so frame 0 of the next window has no
 * left neighbour and cannot be read as a continuation of audio nobody heard.
 */
export function breakDecoder(st) {
  const out = [];
  closeCarry(st, out);
  resetCarry(st);
  out.sort((x, y) => x.onSample - y.onSample || x.pitch - y.pitch);
  return out;
}

function resetCarry(st) {
  st.onS.fill(-1); st.cOnS.fill(-1);
  st.endS.fill(0); st.run.fill(0); st.endRun.fill(0); st.bel.fill(0);
  st.sum.fill(0); st.sumE.fill(0);
  st.cEndS.fill(0); st.cRun.fill(0); st.cEndRun.fill(0); st.cBel.fill(0);
  st.cSum.fill(0); st.cSumE.fill(0);
  st.prevOnset.fill(0);
  st.fresh = true;
}

// ===================================================================== self-check
//
// `node extension/engine/notes.js`. Everything below this line is the runnable
// check and is NOT part of the module's surface.
//
// The fixtures are ACTIVATION MATRICES built by hand, not audio: this file's job
// starts after the model, so feeding it synthesised audio would test ORT and not
// this. Every note's bin, first frame and length is chosen by the fixture, so
// every assertion below compares against a number the fixture wrote rather than
// against a number a previous run produced.

async function selfCheck() {
  let pass = 0, fail = 0;
  const ok = (name, cond, detail = '') => {
    if (cond) { pass++; console.log(`  \x1b[32mPASS\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
    else { fail++; console.log(`  \x1b[31mFAIL\x1b[0m ${name}${detail ? '  ' + detail : ''}`); }
  };
  const head = (s) => console.log(`\n\x1b[1m${s}\x1b[0m`);

  const { bins, keep, trim, frames, contourBins, fftHop, hop, sr, fps } = BASIC_PITCH;

  const blank = () => ({
    note: new Float32Array(frames * bins),
    onset: new Float32Array(frames * bins),
    contour: new Float32Array(frames * contourBins),
  });

  /**
   * Put one note into a fixture: an onset spike at kept frame `k0` of bin `b`,
   * and `len` frames of note-head energy from `k0`. The onset head is a SPIKE and
   * not a plateau because that is what the model emits, and because a plateau
   * would be testing `argrelmax`'s tie-breaking rather than the decoder.
   */
  const put = (fx, b, k0, len, amp = 1.0, onsetAmp = 1.0) => {
    fx.onset[(k0 + trim) * bins + b] = onsetAmp;
    for (let k = k0; k < k0 + len; k++) fx.note[(k + trim) * bins + b] = amp;
  };
  /** Note-head energy with no onset spike — a continuation into a later window. */
  const hold = (fx, b, k0, len, amp = 1.0) => {
    for (let k = k0; k < k0 + len; k++) fx.note[(k + trim) * bins + b] = amp;
  };
  const fill = (fx, v) => { fx.note.fill(v); fx.onset.fill(v); fx.contour.fill(v); };

  const pitches = (ns) => ns.map((n) => n.pitch);
  const onSamples = (ns) => ns.map((n) => n.onSample);
  const lens = (ns) => ns.map((n) => (n.offSample - n.onSample) / fftHop);

  head('1. the bin maps');
  {
    ok('bin-map-note-head-spans-the-88-key-piano',
      binToMidi(0) === 21 && binToMidi(87) === 108,
      `bin 0 -> ${binToMidi(0)} (A0), bin 87 -> ${binToMidi(87)} (C8)`);
    ok('bin-map-contour-head-is-three-bins-per-semitone',
      contourBinToMidi(1) === 21 && contourBinToMidi(4) === 22 && contourBinToMidi(263) === 21 + 262 / 3,
      `contour bin 1 -> ${contourBinToMidi(1)}, bin 4 -> ${contourBinToMidi(4)}, bin 263 -> ${contourBinToMidi(263).toFixed(4)}`);
    // The two maps are not the same map, and writing binToMidi where
    // contourBinToMidi belongs is a whole-file transposition that separates
    // plausibly. Assert the offset that distinguishes them.
    ok('bin-map-the-two-maps-disagree-where-they-must',
      binToMidi(1) !== contourBinToMidi(1) && binToMidi(0) === contourBinToMidi(1),
      `note bin 1 -> ${binToMidi(1)} but contour bin 1 -> ${contourBinToMidi(1)}; the contour head's bin 0 sits a third of a semitone BELOW A0`);
  }

  head('2. the frame map, and the naive map that drifts');
  {
    let good = true, worstDrift = 0, driftOk = true;
    const rows = [];
    for (let w = 0; w <= 3; w++) {
      for (const k of [0, keep - 1]) {
        const want = w * hop + k * fftHop;
        const got = laneSample(w, k);
        if (got !== want) good = false;
        const naive = (w * keep + k) * fftHop;
        if (naive - got !== 188 * w) driftOk = false;
        worstDrift = Math.max(worstDrift, naive - got);
        rows.push(`w=${w} k=${k}: ${got}`);
      }
    }
    ok('frame-map-is-hop-times-w-plus-fftHop-times-k', good, rows.join('  '));
    ok('frame-map-CONTROL-the-naive-concatenated-map-drifts-by-188-per-window', driftOk,
      `(w*142 + k)*256 runs ahead by exactly 188*w samples; at w=3 that is ${worstDrift} samples = ${(worstDrift / sr * 1000).toFixed(1)} ms, and over a 4-minute song ${(146 * 188 / sr).toFixed(2)} s`);
    ok('frame-map-a-window-is-not-142-frames-long', keep * fftHop !== hop,
      `142 * 256 = ${keep * fftHop} but the hop is ${hop} — that ${keep * fftHop - hop}-sample difference IS the drift above`);
  }

  head('3. one note  (the contract fixture)');
  {
    const st = newDecoder();
    const fx = blank();
    put(fx, 39, 20, 30);                       // bin 39 -> MIDI 60, middle C
    const got = decodeWindow(st, fx.note, fx.onset, fx.contour, 0);
    ok('one-note-count', got.length === 1, `${got.length} notes`);
    ok('one-note-pitch-is-middle-c', got.length === 1 && got[0].pitch === 60,
      `bin 39 -> MIDI ${got[0] && got[0].pitch}`);
    ok('one-note-onset-sample-is-frame-20', got.length === 1 && got[0].onSample === 20 * fftHop,
      `${got[0] && got[0].onSample}, wanted ${20 * fftHop} (= ${(20 * fftHop / sr).toFixed(4)} s)`);
    ok('one-note-length-is-30-frames', got.length === 1 && lens(got)[0] === 30,
      `${got.length === 1 ? lens(got)[0] : '-'} frames = ${got.length === 1 ? ((got[0].offSample - got[0].onSample) / sr * 1000).toFixed(1) : '-'} ms`);
    ok('one-note-velocity-is-full-scale', got.length === 1 && got[0].vel === 127,
      `activation 1.0 -> vel ${got[0] && got[0].vel}`);
  }

  head('4. a chord and a melody  (exact pitches, onsets within one frame, durations)');
  {
    // C major triad, all three voices struck together at frame 20 for 30 frames.
    const st = newDecoder();
    const fx = blank();
    for (const b of [39, 43, 46]) put(fx, b, 20, 30);        // MIDI 60, 64, 67
    const chord = decodeWindow(st, fx.note, fx.onset, fx.contour, 0);
    ok('chord-three-notes-out', chord.length === 3, `${chord.length} notes: ${pitches(chord).join(', ')}`);
    ok('chord-pitches-are-c-major', String(pitches(chord)) === String([60, 64, 67]),
      `[${pitches(chord)}]`);
    ok('chord-all-three-share-one-onset', String(onSamples(chord)) === String([20 * fftHop, 20 * fftHop, 20 * fftHop]),
      `[${onSamples(chord)}]`);
    ok('chord-all-three-share-one-duration', String(lens(chord)) === String([30, 30, 30]), `[${lens(chord)}] frames`);

    // A melody: four notes, four different pitches, four different lengths.
    const st2 = newDecoder();
    const fy = blank();
    const mel = [[43, 10, 20], [46, 35, 15], [51, 55, 40], [48, 100, 25]];   // 64, 67, 72, 69
    for (const [b, k, n] of mel) put(fy, b, k, n);
    const tune = decodeWindow(st2, fy.note, fy.onset, fy.contour, 0);
    ok('melody-note-count', tune.length === 4, `${tune.length} notes`);
    ok('melody-pitches-exact', String(pitches(tune)) === String([64, 67, 72, 69]), `[${pitches(tune)}]`);
    ok('melody-durations-exact', String(lens(tune)) === String([20, 15, 40, 25]), `[${lens(tune)}] frames`);

    let worstFrames = 0;
    for (let i = 0; i < mel.length && i < tune.length; i++) {
      worstFrames = Math.max(worstFrames, Math.abs(tune[i].onSample - mel[i][1] * fftHop) / fftHop);
    }
    ok('melody-onsets-within-one-frame', tune.length === 4 && worstFrames <= 1,
      `worst error ${worstFrames} frames (${(worstFrames / fps * 1000).toFixed(2)} ms); the frame period is ${(1000 / fps).toFixed(2)} ms`);
    console.log(`      onsets in seconds: ${tune.map((n) => (n.onSample / sr).toFixed(4)).join(', ')}`);
  }

  head('5. the minimum length can reject  (11 out, 12 in)');
  {
    for (const [len, want] of [[MIN_LEN_FRAMES, 0], [MIN_LEN_FRAMES + 1, 1]]) {
      const st = newDecoder();
      const fx = blank();
      put(fx, 39, 20, len);
      const got = decodeWindow(st, fx.note, fx.onset, fx.contour, 0);
      ok(`min-length-${len}-frames-yields-${want}`, got.length === want,
        `${got.length} notes; the rule is "> ${MIN_LEN_FRAMES}", derived from ${BASIC_PITCH.minNoteMs} ms at ${fps} fps`);
    }
    ok('min-length-is-derived-not-typed', MIN_LEN_FRAMES === 11,
      `round(${BASIC_PITCH.minNoteMs} / 1000 * ${fps}) = ${MIN_LEN_FRAMES}`);
  }

  head('6. the carry  (a note that outlives its window keeps its original onset)');
  {
    const st = newDecoder();
    const w0 = blank();
    put(w0, 39, 130, keep - 130);              // onset at frame 130, energy to frame 141
    const a = decodeWindow(st, w0.note, w0.onset, w0.contour, 0);
    ok('carry-window-0-returns-nothing', a.length === 0,
      `${a.length} notes — the note is still sounding at frame ${keep - 1}, so it is not closed and must not be reported`);
    ok('carry-window-0-left-an-open-note', st.onS[39] === 130 * fftHop,
      `open at bin 39, onset lane sample ${st.onS[39]}`);

    const w1 = blank();
    hold(w1, 39, 0, 5);                        // it rings on for five more frames, then stops
    const b = decodeWindow(st, w1.note, w1.onset, w1.contour, 1);
    ok('carry-window-1-returns-the-note', b.length === 1, `${b.length} notes`);
    ok('carry-onset-is-the-ORIGINAL-onset-not-a-restart',
      b.length === 1 && b[0].onSample === 0 * hop + 130 * fftHop,
      `${b[0] && b[0].onSample}, wanted ${130 * fftHop}; a restart would have said ${hop}`);
    ok('carry-note-ends-in-the-second-window',
      b.length === 1 && b[0].offSample === hop + 4 * fftHop + fftHop,
      `${b[0] && b[0].offSample} = window 1 frame 4 + one frame, the last frame it had energy`);
    ok('carry-length-spans-the-seam',
      b.length === 1 && b[0].offSample - b[0].onSample === hop + 5 * fftHop - 130 * fftHop,
      `${b.length === 1 ? ((b[0].offSample - b[0].onSample) / sr * 1000).toFixed(1) : '-'} ms across the window boundary`);
  }

  head('7. breakDecoder closes and marks');
  {
    const st = newDecoder();
    const w0 = blank();
    put(w0, 39, 100, keep - 100);              // open at the end of window 0
    const a = decodeWindow(st, w0.note, w0.onset, w0.contour, 0);
    ok('break-nothing-closed-before-the-break', a.length === 0, `${a.length} notes`);

    const broke = breakDecoder(st);
    ok('break-returns-the-open-note-closed', broke.length === 1 && broke[0].pitch === 60,
      `${broke.length} notes, pitch ${broke[0] && broke[0].pitch}`);
    ok('break-closes-at-the-last-frame-that-had-energy',
      broke.length === 1 && broke[0].offSample === (keep - 2) * fftHop + fftHop,
      `${broke[0] && broke[0].offSample} = frame ${keep - 2} + one frame; frame ${keep - 1} is never walked (it is the seam duplicate of the next window's frame 0)`);
    ok('break-emptied-the-carry', st.onS[39] === -1, `bin 39 open sample ${st.onS[39]}`);

    // The mark. Same window 1 fixture, an onset on kept frame 0, fed to two
    // decoders that differ ONLY in whether a break happened.
    const w1 = blank();
    put(w1, 50, 0, 30);                        // MIDI 71, onset on the very first kept frame
    const afterBreak = decodeWindow(st, w1.note, w1.onset, w1.contour, 1);
    ok('break-frame-0-is-not-an-onset-candidate-on-a-fresh-start', afterBreak.length === 0,
      `${afterBreak.length} notes — with no previous window there is no left neighbour, so frame 0 cannot be a local maximum`);

    const st2 = newDecoder();
    const q0 = blank();
    put(q0, 39, 20, 30);                       // a window 0 that closes cleanly, so the carry is empty but SEEN
    decodeWindow(st2, q0.note, q0.onset, q0.contour, 0);
    const continued = decodeWindow(st2, w1.note, w1.onset, w1.contour, 1);
    ok('break-CONTROL-without-the-break-that-same-frame-0-onset-is-found',
      continued.length === 1 && continued[0].pitch === 71 && continued[0].onSample === hop,
      `${continued.length} notes, pitch ${continued[0] && continued[0].pitch} at ${continued[0] && continued[0].onSample}; the ONLY difference from the run above is the break, so the mark is what decided`);
  }

  head('8. velocity');
  {
    const cases = [[1.0, 127, 127], [0.31, 1, 40], [0.5, 60, 68], [0.9, 110, 118]];
    for (const [amp, lo, hi] of cases) {
      const st = newDecoder();
      const fx = blank();
      put(fx, 39, 20, 30, amp, 1.0);
      const got = decodeWindow(st, fx.note, fx.onset, fx.contour, 0);
      const v = got.length === 1 ? got[0].vel : -1;
      ok(`velocity-activation-${amp}-lands-in-${lo}..${hi}`, v >= lo && v <= hi,
        `vel ${v} = clamp(round(127 * ${amp}), 1, 127)`);
    }
    // MIDI velocity 0 IS note-off, so a note that rounded to 0 would silently
    // disappear inside the file. But `vel >= 1` over ANY fixture answers a
    // constant — AGENTS.md's saturated estimator in its other direction — because
    // what keeps 0 off the wire is not the clamp in `emit`, it is the GEOMETRY: a
    // note must clear `frameThreshold` at its last counted frame and may carry at
    // most `energyTol - 1` below-threshold frames before it, so the mean cannot
    // fall below `frameThreshold / (energyTol + 1)`. Assert that bound at the
    // sparsest note this decoder will still emit — an onset with NO note-head
    // energy under it, then one frame at exactly the threshold, as late as the
    // tolerance allows. It goes red the day the geometry moves far enough for
    // velocity 0 to be reachable, which is the day the clamp stops being dead.
    //
    // WATCHED BOTH FORMS, SAME BREAK. `emit`'s `amp = sumE / len` changed to
    // `sumE / (len * 200)`, so `round(127 * amp)` is 0 and the clamp in `emit`
    // is the only thing keeping a velocity on the wire at all:
    //   old  `PASS velocity-never-zero  ... gives vel 1`
    //   new  `FAIL velocity-quietest-emittable-note-clears-zero-by-geometry
    //         ... gives vel 1; round(127 * 0.3 / 12) = 3`
    // At `/ (len * 20)` the old one still passed at vel 2 while four of the five
    // velocity assertions around it went red — it is the one line in the section
    // that a collapsed estimator cannot reach. Reverted, 52/52.
    const st = newDecoder();
    const fx = blank();
    const gap = BASIC_PITCH.energyTol;
    fx.onset[(1 + trim) * bins + 39] = 1.0;
    fx.note[(1 + gap + trim) * bins + 39] = BASIC_PITCH.frameThreshold;
    const got = [...decodeWindow(st, fx.note, fx.onset, fx.contour, 0), ...flushDecoder(st)];
    const bound = Math.round(127 * BASIC_PITCH.frameThreshold / (BASIC_PITCH.energyTol + 1));
    ok('velocity-quietest-emittable-note-clears-zero-by-geometry',
      got.length === 1 && got[0].vel === bound && bound >= 1,
      `the sparsest emittable note (one frame at ${BASIC_PITCH.frameThreshold}, ${gap} frames after the onset) gives vel ${got[0] && got[0].vel}; round(127 * ${BASIC_PITCH.frameThreshold} / ${BASIC_PITCH.energyTol + 1}) = ${bound}`);
    // THE CONTROL, and it is what makes "sparsest" a measurement rather than a
    // word: the SAME fixture with that one frame moved ONE further out is not a
    // note at all — the walk runs out of tolerance before it reaches the energy,
    // `endRun` never leaves 0, and a one-frame note is under MIN_LEN_FRAMES. So
    // the bound above is the true floor of the emittable range and not a
    // convenient point inside it. Without this line the assertion above is a
    // number measured somewhere in the middle of a range nobody bounded.
    //
    // WATCHED IT FAIL: `if (bel >= energyTol) break;` widened to `energyTol + 2`
    // in both walks. This line prints `... emits 1 note(s)` while the bound above
    // stays green at vel 3 — and under the estimator break above the two swap
    // over, which is what says they are two claims and not one written twice.
    // Reverted, 52/52.
    const st2 = newDecoder();
    const fx2 = blank();
    fx2.onset[(1 + trim) * bins + 39] = 1.0;
    fx2.note[(2 + gap + trim) * bins + 39] = BASIC_PITCH.frameThreshold;
    const none = [...decodeWindow(st2, fx2.note, fx2.onset, fx2.contour, 0), ...flushDecoder(st2)];
    ok('velocity-CONTROL-one-frame-sparser-is-not-a-note-at-all',
      none.length === 0,
      `the same onset with its single above-threshold frame ${gap + 1} frames out instead of ${gap} emits ${none.length} note(s) — ${BASIC_PITCH.energyTol} consecutive sub-threshold frames end the walk, so nothing quieter than the line above can be emitted at all`);
  }

  head('9. the two degenerate matrices, and the control that must lose');
  {
    /**
     * THE CONTROL. A decoder that THRESHOLDS the onset head instead of
     * peak-picking it — the obvious implementation, and the one this file is not.
     * It is counted rather than fully decoded because the count is the whole
     * difference: how many (frame, bin) pairs would be taken as note starts.
     */
    const naiveOnsetCount = (onset) => {
      let n = 0;
      for (let k = 0; k < keep - 1; k++) {
        for (let b = 0; b < bins; b++) if (onset[(k + trim) * bins + b] >= BASIC_PITCH.onsetThreshold) n++;
      }
      return n;
    };

    // ---- all zeros. Nothing in, nothing out, including across a flush.
    {
      const st = newDecoder();
      const z = blank();
      let total = 0;
      for (let w = 0; w < 3; w++) total += decodeWindow(st, z.note, z.onset, z.contour, w).length;
      total += flushDecoder(st).length;
      ok('degenerate-all-zeros-produces-zero-notes', total === 0, `${total} notes over 3 windows and a flush`);
      ok('degenerate-all-zeros-CONTROL-agrees', naiveOnsetCount(z.onset) === 0,
        'the threshold-only rule also finds nothing here, which is why this case alone cannot tell the two apart');
    }

    // ---- every bin at 1.0. This is the matrix a broken model, a mis-bound
    // output name or an uninitialised buffer produces, and the question AGENTS.md
    // asks is what it ACTUALLY does — not whether it "looks wrong".
    {
      const st = newDecoder();
      const one = blank();
      fill(one, 1.0);
      let total = 0;
      const per = [];
      for (let w = 0; w < 3; w++) { const n = decodeWindow(st, one.note, one.onset, one.contour, w).length; per.push(n); total += n; }
      const flushed = flushDecoder(st).length;
      ok('degenerate-all-ones-produces-zero-notes', total === 0 && flushed === 0,
        `windows [${per}] and flush ${flushed}: a saturated onset head has NO strict local maximum anywhere, so nothing is ever a note start. It is a blank, not a wall of 88 sustained notes, and a blank is what this deck shows when it has nothing.`);

      const naive = naiveOnsetCount(one.onset);
      ok('degenerate-all-ones-CONTROL-the-threshold-only-rule-LOSES', naive >= keep * bins - bins,
        `it fires on ${naive} of ${(keep - 1) * bins} (frame, bin) pairs — the entire matrix — against this decoder's ${total}. That is the discrimination: same input, ${naive} against ${total}.`);
    }

    // ---- and the control is not simply always-different: on real-shaped input
    // the two agree, which is what makes the divergence above mean something.
    {
      const fy = blank();
      for (const [b, k, n] of [[43, 10, 20], [46, 35, 15], [51, 55, 40], [48, 100, 25]]) put(fy, b, k, n);
      const st = newDecoder();
      const got = decodeWindow(st, fy.note, fy.onset, fy.contour, 0);
      ok('degenerate-CONTROL-agrees-with-this-decoder-on-a-real-melody',
        naiveOnsetCount(fy.onset) === got.length && got.length === 4,
        `threshold-only finds ${naiveOnsetCount(fy.onset)} onsets, this decoder emits ${got.length} notes — a control that disagreed everywhere would be measuring nothing`);
    }
  }

  head('10. the guards  (a short tensor is a failure, not a quiet decode)');
  {
    const threw = (f) => { try { f(); return false; } catch { return true; } };
    const st = newDecoder();
    const fx = blank();
    ok('guard-short-note-head-throws',
      threw(() => decodeWindow(st, fx.note.subarray(0, 100), fx.onset, fx.contour, 0)), 'note head truncated to 100');
    ok('guard-missing-onset-head-throws',
      threw(() => decodeWindow(st, fx.note, undefined, fx.contour, 0)), 'onset head absent — absence IS the failure');
    ok('guard-short-contour-head-throws',
      threw(() => decodeWindow(st, fx.note, fx.onset, fx.contour.subarray(0, 100), 0)),
      'accepted and ignored is not the same as unchecked: a caller who passes the wrong tensor here has probably passed the wrong ones above too');

    const st2 = newDecoder();
    decodeWindow(st2, fx.note, fx.onset, fx.contour, 5);
    ok('guard-repeated-window-throws', threw(() => decodeWindow(st2, fx.note, fx.onset, fx.contour, 5)), 'window 5 twice');
    ok('guard-backward-window-throws', threw(() => decodeWindow(st2, fx.note, fx.onset, fx.contour, 3)), 'window 3 after window 5');
    ok('guard-forward-window-does-not-throw', !threw(() => decodeWindow(st2, fx.note, fx.onset, fx.contour, 6)),
      'window 6 after window 5 — the guard above has to let the normal case through, or it is rejecting everything');

    // A forward JUMP is a dropped window, which §2.8 already answers with BREAK.
    // It is absorbed as an implicit break rather than thrown, and the counter
    // says so — otherwise the absorption would be indistinguishable from nothing
    // having happened.
    const st3 = newDecoder();
    const w0 = blank();
    put(w0, 39, 100, keep - 100);
    decodeWindow(st3, w0.note, w0.onset, w0.contour, 0);
    const jumped = decodeWindow(st3, fx.note, fx.onset, fx.contour, 4);
    ok('guard-forward-jump-is-absorbed-as-a-break',
      st3.skips === 1 && jumped.length === 1 && jumped[0].pitch === 60,
      `skips=${st3.skips}, and the note left open by window 0 came back closed rather than being stitched across the hole`);
  }

  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail ? 1 : 0);
}

// Node only, and only when this file IS the entry point. No top-level await: the
// worker imports this module synchronously and must not be made async.
if (typeof process !== 'undefined' && process.argv && process.argv[1]) {
  import('node:url').then(({ pathToFileURL }) => {
    if (import.meta.url === pathToFileURL(process.argv[1]).href) return selfCheck();
  }).catch((e) => { console.error(e); process.exit(1); });
}
