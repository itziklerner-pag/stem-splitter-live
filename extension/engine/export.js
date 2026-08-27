/**
 * E1 — THE DELIVERABLE: the six untouched model outputs, written out.
 *
 * WHAT AN EXPORT IS, and it is a definition rather than a description. Export is
 * the six model outputs — drums, bass, other, vocals, guitar, piano, in `STEMS`
 * order — written as 32-bit float, 44 100 Hz, stereo WAV, at unity, with NOTHING
 * THE DECK DID APPLIED: not the faders, not mute or solo, not the crossfader,
 * not transpose, not speed. A fader pulled to −20 dB before an export changes
 * nothing in the written file. That is why this module imports no mixer, no
 * deck and no worklet: the samples come out of the 32f cache entry and go into a
 * sink, and there is no place on the path for a gain to be applied.
 *
 * NEVER CALL THESE "THE MIX". What you are hearing — faders, mute/solo,
 * transpose and speed baked in — is a BOUNCE, it is a different deliverable for
 * a different person, and it is not this file (upstream issue #17).
 *
 * WHY IT READS THE CACHE AND NOT THE MODEL. `shared/stemcache.js`'s header: the
 * model runs once, and the 32f tier exists so an export re-reads the same
 * untouched outputs the deck plays from rather than re-deriving them. A second
 * run of the separator would be a second answer to a question already answered.
 *
 * WHY IT IS HERE AND NOT IN `offscreen/engine.js`. Everything below is pure
 * arithmetic and shape — no `AudioContext`, no OPFS, no `chrome.`, no Host — so
 * it runs under plain node and `test.js` drives the whole path over fakes. The
 * two things it cannot do for itself arrive as callbacks: `openStem` (where the
 * frames come from) and `exportSink` (where the bytes go). That is the same
 * division `engine/live.js` keeps against `offscreen/live.js`.
 *
 * THE MEMORY CLAIM, WHICH IS THE WHOLE REASON U1 AND `WavWindowReader` EXIST.
 * Six 32f stems of a four-minute track are ~508 MB. This module holds ONE window
 * of ONE stem at a time — `EXPORT_CHUNK_FRAMES` frames of planar float plus the
 * interleaved bytes of the same window, about 2.8 MB at the default — and that
 * figure does not move when the track gets longer. Materialising either side
 * would put the ceiling back; `StemCache.get()` and `encodeWav` are both the
 * wrong call from here, and both are the right call from a deck.
 *
 * WHY ALL SIX FILES ARE WRITTEN IN LOCKSTEP rather than one after another. An
 * export is ONE user gesture over N files, so a cancelled one must not leave
 * some of them finished: every sink gets its header, then every sink gets window
 * 0, then window 1, and the six `close()` calls happen back to back at the end.
 * Cancel anywhere before that aborts all six, and "a cancelled export leaves no
 * partial file" is then true of every file rather than of the one that happened
 * to be open. Writing them in sequence would have been simpler and would have
 * left five complete WAVs on a user's disk after they pressed Stop.
 */

import { SR, STEMS } from '../shared/config.js';
import { WavStreamEncoder } from '../shared/wav.js';

/**
 * Frames per window, per stem. 4 s at 44 100 Hz.
 *
 * IT IS A BUFFER SIZE AND NOTHING ELSE — no geometry depends on it, because a
 * copy has no seams: window k of a stem is written where window k−1 stopped, and
 * `WavStreamEncoder` refuses a frame total that disagrees with its own header.
 * Chosen so the resident window is small (1.4 MB of planes plus 1.4 MB of
 * interleaved bytes at stereo 32f) while the progress the run emits stays
 * countable — one message per stem per window, so a four-minute track reports
 * 6 × 60 = 360 times rather than six times or sixty thousand.
 */
export const EXPORT_CHUNK_FRAMES = SR * 4;

/** What a deliverable is, in one place, so no caller has to spell it. */
export const EXPORT_FORMAT = Object.freeze({ sampleRate: SR, bitDepth: 32, float: true, channels: 2 });

/**
 * THE CLOSED ERROR VOCABULARY, DECLARED BEFORE THE FIRST ONE IS SHIPPED (#29).
 *
 * `ARM_CODES` is the lesson this set is written against: a closed set of eight
 * that nothing checked, five of whose members are tab nouns, and a Host that
 * invented a plausible-looking code got an undismissable banner with a dead
 * Restart button and nothing red anywhere. `EXPORT_ERROR.code` is the same kind
 * of thing — a value that crosses the seam and that a surface branches on — and
 * the vocabulary is declared here, in the unit, on the day the first code is
 * emitted rather than after a second product has invented three of its own.
 *
 * Each member is a DIFFERENT REMEDY, which is the test for whether a code earns
 * its place:
 *
 *   NO_ENTRY      nothing is cached under that key. Separate the track first.
 *   WRONG_TIER    the entry is not the untouched 32-bit-float output — it is a
 *                 16-bit listen copy, and exporting it would be a
 *                 re-quantisation presented as the model's own samples.
 *   BAD_STEM      a stem was asked for that the six-stem contract has no name
 *                 for. The caller's list is wrong, not the cache.
 *   BAD_FORMAT    a format other than 32-bit float was asked for. E1 is DEFINED
 *                 as the untouched output; anything else is a different
 *                 deliverable and needs a different name.
 *   SINK_REFUSED  the Host would not open the destinations — the ordinary case
 *                 is the user cancelling the folder dialog. Nothing was written.
 *   SINK_SHORT    the Host opened SOME of them. Five of six files is not a
 *                 smaller export, it is a broken one.
 *   READ_FAILED   the cache entry could not be read back, or disagrees with its
 *                 own manifest row. The entry is the problem; re-separate.
 *   WRITE_FAILED  a destination rejected mid-write — a full disk, a folder
 *                 deleted under the run, a revoked permission.
 *   CANCELLED     the user stopped it. Every destination was aborted.
 *   BUSY          an export is already running. Two exports would interleave
 *                 windows into each other's sinks.
 */
export const EXPORT_CODES = new Set([
  'NO_ENTRY', 'WRONG_TIER', 'BAD_STEM', 'BAD_FORMAT',
  'SINK_REFUSED', 'SINK_SHORT', 'READ_FAILED', 'WRITE_FAILED',
  'CANCELLED', 'BUSY',
]);

/**
 * IS THIS A CODE A SURFACE KNOWS WHAT TO DO WITH? The shape `checkArmCode`
 * (`ui/audio-math.js`) established, for the same reason and with the same one
 * side effect: a pure predicate whose caller has to remember to log is a check
 * the next product loses exactly the way the arm vocabulary was lost.
 *
 * IT DOES NOT THROW AND IT DOES NOT CHANGE THE MESSAGE. The export has already
 * failed; replacing the user's actual problem with a second one about our own
 * vocabulary would take the first off the screen. The developer is told; the
 * user sees the failure they had.
 *
 * @param {string} code the code as it will be sent
 * @param {string} [where] the entry point, quoted in the error
 * @returns {null|string} null when legal, otherwise the sentence that was logged
 */
export function checkExportCode(code, where = 'EXPORT_ERROR') {
  if (EXPORT_CODES.has(code)) return null;
  const msg = `${where}: code ${JSON.stringify(code)} is not one of the ${EXPORT_CODES.size} this deliverable path declares `
    + `— ${[...EXPORT_CODES].join(', ')}. A surface branches on this value to decide what to offer the user, so an `
    + 'unknown one gets the fallback treatment for a failure it does not describe. Pick a member of that set, or add one upstream.';
  console.error(msg);
  return msg;
}

/** A failure with a code from the set above. `message` is for a person. */
export class ExportError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExportError';
    this.code = code;
  }
}

/* ------------------------------------------------------------------- naming
 * WHO OWNS SANITISATION — both halves, and neither alone is enough.
 *
 * THE UNIT CHOOSES THE BASE NAMES; THE HOST OWNS THE DIRECTORY. `exportSink`'s
 * declaration says so: "`files` are BASE NAMES the unit chose; the Host owns the
 * directory, the dialog and any collision policy". So the unit's obligation is
 * that every name it hands over is A SINGLE PATH COMPONENT — a Host that joins
 * `chosenFolder + separator + name` must not be able to be walked out of the
 * folder it asked the user for. That is what the functions below guarantee and
 * what the suite asserts, with `path.posix.resolve` and `path.win32.resolve` as
 * the instruments rather than a re-reading of these same rules.
 *
 * THE HOST STILL OWNS ITS OWN REFUSAL. It knows things the unit cannot: the
 * filesystem's case rules, its length limits, whether the folder still exists,
 * and what to do about a collision. A Host that took these names on faith and
 * concatenated them without checking would be trusting a stranger's arithmetic
 * about its own filesystem. The division is: the unit guarantees the names are
 * *ordinary*, the Host guarantees they are *safe here*.
 *
 * THE TITLE IS SANITISED TOO, not just the file names, because the Host makes a
 * FOLDER out of `plan.title` (`<title>/<title> - <stem>.wav`). A safe file name
 * inside an unsafe folder name escapes exactly as well.
 */

/**
 * Path separators, the Windows-illegal set, and the C0/DEL control range.
 * Spelled with `\u` escapes rather than literal control characters: a raw
 * 0x00-0x1f range inside a character class is invisible in every editor and
 * every diff that would ever have to check this rule, and it makes the file
 * itself non-text.
 */
const ILLEGAL = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;
/** Windows device names. `NUL.wav` is the null device: it accepts every byte and keeps none. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
/**
 * The longest title that leaves room for ` - <stem>.wav` inside a 255-BYTE name,
 * which is the common limit on ext4, APFS and NTFS alike. Measured in UTF-8
 * BYTES rather than characters: a title of 200 emoji is 800 bytes and a filename
 * limit counts bytes.
 */
const MAX_TITLE_BYTES = 200;

const utf8 = new TextEncoder();

/**
 * A title reduced to one ordinary path component.
 *
 * WHY EVERY RULE IS HERE, so none of them is removed as paranoia:
 *   `/` and `\`   a separator makes the name a PATH, and `../../x` leaves the folder.
 *   `:`           a drive-relative path on Windows (`C:x`) and an alternate data
 *                 stream (`f:s`); a separator on classic macOS.
 *   `* ? " < > |` illegal on Windows; a name containing one cannot be created.
 *   C0 and DEL    illegal in a name on Windows and unprintable in the dialog the
 *                 user is looking at.
 *   leading `.`   a hidden file on every unix, and the user cannot find it.
 *   trailing `.`  Windows strips it, so `x.` and `x` are the SAME file — a
 *                 collision the unit would never see and the Host cannot explain.
 *   trailing ` `  Windows strips it too, with the same consequence.
 *   `.` and `..`  the two names that are directories rather than files.
 *   device names  `NUL` accepts every byte and keeps none.
 *
 * IT NEVER RETURNS EMPTY. A title of nothing but slashes reduces to underscores,
 * and a title of nothing at all becomes `export`: a name the user did not choose
 * is better than a run that fails after the dialog, and a name that is the empty
 * string is a path component that is not one.
 */
export function safeTitle(title) {
  let s = String(title == null ? '' : title).replace(ILLEGAL, '_');
  // Leading dots and trailing dots/spaces are stripped AFTER the substitution,
  // so a title of `..` is still `..` when it reaches here and is caught, rather
  // than having become `__` and slipped through as an ordinary name.
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  // UTF-8 BYTES, and code points are dropped whole so the result never ends in
  // half a character. `Array.from` iterates code points, not UTF-16 units.
  if (utf8.encode(s).length > MAX_TITLE_BYTES) {
    let out = '', bytes = 0;
    for (const cp of Array.from(s)) {
      const n = utf8.encode(cp).length;
      if (bytes + n > MAX_TITLE_BYTES) break;
      out += cp; bytes += n;
    }
    s = out.replace(/[.\s]+$/, '');
  }
  if (!s) return 'export';
  return RESERVED.test(s) ? `_${s}` : s;
}

/**
 * The base names, in `STEMS` order, for a title and a set of stems.
 *
 * ORDER IS `STEMS`, NEVER THE CALLER'S. `STEMS` is the six-stem contract's own
 * order (`docs/SIX-STEM-CONTRACT.md`) and every other surface in this tree — the
 * worklet's gain slots, the stem ring's planes, the model's output layout — is
 * indexed by it. A caller that asked for `['vocals','drums']` and got them back
 * in that order would have a list whose index means something different from
 * every other list of stems in the product.
 *
 * @param {string} title
 * @param {string[]} [stems] a subset of STEMS; the caller's order is ignored
 * @returns {string[]} base names, one per stem, in STEMS order
 */
export function exportFileNames(title, stems = STEMS) {
  const want = new Set(stems);
  const t = safeTitle(title);
  return STEMS.filter((s) => want.has(s)).map((s) => `${t} - ${s}.wav`);
}

/* -------------------------------------------------------------------- the run */

/**
 * ONE EXPORT. Construct it, `run()` it, `cancel()` it from wherever the cancel
 * message lands.
 *
 * @param {object} plan
 * @param {{key:string, frames:number, title?:string, depth?:number}} plan.entry
 *   the manifest row, already looked up. `frames` is the contract: it goes into
 *   a RIFF header that is final on the first chunk, so a run that discovered a
 *   different length half way through would already have shipped the wrong one.
 * @param {string[]} [plan.stems] a subset of STEMS. Default: all six.
 * @param {{bitDepth?:number, float?:boolean}} [plan.format] refused unless 32f.
 * @param {(stem:string) => Promise<object>} plan.openStem
 *   a reader for one stem, duck-typed on `frames`, `sampleRate`, `bitDepth`,
 *   `float`, `channels` and `read(from, count, planes)` — i.e. an opened
 *   `WavWindowReader`. It is a callback so this module needs no OPFS.
 * @param {(plan:{title:string, files:string[]}) => Promise<Record<string, WritableStream>>} plan.exportSink
 *   the Host duty, verbatim. A refusal is a rejection, never an empty map.
 * @param {(p:object) => void} [plan.onProgress]
 * @param {number} [plan.chunkFrames]
 */
export class ExportRun {
  constructor(plan) {
    this.entry = plan.entry;
    this.stems = plan.stems || STEMS;
    this.format = plan.format || null;
    this.openStem = plan.openStem;
    this.exportSink = plan.exportSink;
    this.onProgress = plan.onProgress || (() => {});
    this.chunkFrames = plan.chunkFrames || EXPORT_CHUNK_FRAMES;
    /**
     * THE CANCEL FLAG, checked BETWEEN windows and never inside one. A window is
     * one `read` and one `write`; abandoning either half would leave a sink
     * holding a fraction of a frame, and a WAV whose data length is not a
     * multiple of its block align is a file no reader can align.
     */
    this.cancelled = false;
    this.started = false;
    this.files = [];
    this.bytes = 0;
  }

  /** Ask the run to stop at the next window boundary. Idempotent. */
  cancel() { this.cancelled = true; }

  /** @returns {Promise<{files:string[], bytes:number, frames:number}>} */
  async run() {
    if (this.started) throw new ExportError('BUSY', 'this export has already run — build a new one');
    this.started = true;
    const t0 = Date.now();
    const entry = this.entry;

    if (!entry || typeof entry.key !== 'string') {
      throw new ExportError('NO_ENTRY', 'nothing is cached under that key — separate the track before exporting it');
    }
    const frames = entry.frames;
    if (!Number.isInteger(frames) || frames <= 0) {
      throw new ExportError('READ_FAILED', `the cache entry for ${entry.key} declares ${frames} frames, `
        + 'which is not a length a file can be written to');
    }
    if (entry.depth != null && entry.depth !== EXPORT_FORMAT.bitDepth) {
      throw new ExportError('WRONG_TIER', `${entry.key} is a ${entry.depth}-bit entry. An export is defined as the `
        + `untouched ${EXPORT_FORMAT.bitDepth}-bit-float model output, and writing a ${entry.depth}-bit entry out as `
        + "float would present a re-quantisation as the model's own samples");
    }
    // THE FORMAT IS VALIDATED, NOT APPLIED. The field is on the wire
    // (`EXPORT_START { format? }`) so a caller can SAY what it expects; the one
    // thing this path will ever produce is the untouched output, so any other
    // answer is refused by name rather than silently honoured or silently
    // ignored. A silently ignored format field is how a caller ends up believing
    // it received 16-bit files.
    if (this.format) {
      const bd = this.format.bitDepth ?? EXPORT_FORMAT.bitDepth;
      const fl = this.format.float ?? true;
      if (bd !== EXPORT_FORMAT.bitDepth || fl !== true) {
        throw new ExportError('BAD_FORMAT', `this path writes ${EXPORT_FORMAT.bitDepth}-bit float only — `
          + `${bd}-bit ${fl ? 'float' : 'fixed point'} was asked for. E1 is defined as the untouched model output; `
          + 'a fixed-point deliverable is a different thing and needs a different name');
      }
    }
    const unknown = this.stems.filter((s) => !STEMS.includes(s));
    if (unknown.length) {
      throw new ExportError('BAD_STEM', `${unknown.join(', ')}: the six-stem contract has no such stem — ${STEMS.join(', ')}`);
    }
    const order = STEMS.filter((s) => this.stems.includes(s));
    if (!order.length) {
      throw new ExportError('BAD_STEM', 'an export of no stems is not a smaller export');
    }

    const title = safeTitle(entry.title || entry.key);
    const names = exportFileNames(entry.title || entry.key, order);

    // ---- read side: open every stem and check it against its own header ----
    const readers = [];
    for (const stem of order) {
      let r;
      try { r = await this.openStem(stem); } catch (e) {
        throw new ExportError('READ_FAILED', `${entry.key}: the ${stem} stem would not open — ${(e && e.message) || e}`);
      }
      // THE FILE'S OWN HEADER, NOT THE MANIFEST ROW. The row says what the entry
      // was filed as; the header says what the bytes are. A tier that wrote 16
      // bit into a directory keyed for 32 would agree with itself in the
      // manifest and disagree here, which is the only place it can be caught.
      if (r.sampleRate !== EXPORT_FORMAT.sampleRate || r.bitDepth !== EXPORT_FORMAT.bitDepth
        || r.float !== true || r.channels !== EXPORT_FORMAT.channels) {
        throw new ExportError('WRONG_TIER', `${entry.key}: the ${stem} file's own header says `
          + `${r.bitDepth}-bit ${r.float ? 'float' : 'fixed point'}, ${r.sampleRate} Hz, ${r.channels} ch — `
          + `an export is ${EXPORT_FORMAT.bitDepth}-bit float, ${EXPORT_FORMAT.sampleRate} Hz, ${EXPORT_FORMAT.channels} ch`);
      }
      if (r.frames !== frames) {
        throw new ExportError('READ_FAILED', `${entry.key}: the manifest says ${frames} frames and the ${stem} file `
          + `holds ${r.frames} — the entry disagrees with itself, so neither number can be written into a header`);
      }
      readers.push(r);
    }
    this.#tick('read', 0, order.length, 0, t0);
    if (this.cancelled) throw new ExportError('CANCELLED', 'the export was stopped before anything was opened');

    // ---- the sinks: ONE call, all of them, and a refusal is a rejection ----
    let sinks;
    try {
      sinks = await this.exportSink({ title, files: names.slice() });
    } catch (e) {
      throw new ExportError('SINK_REFUSED', `nowhere to write: ${(e && e.message) || e}`);
    }
    const missing = names.filter((n) => !sinks || !sinks[n] || typeof sinks[n].getWriter !== 'function');
    if (missing.length) {
      // Abort whatever DID come back. A Host that opened four of six has four
      // files on a user's disk that no export will ever finish.
      await Promise.all(names
        .filter((n) => sinks && sinks[n] && typeof sinks[n].abort === 'function')
        .map((n) => sinks[n].abort(new Error('export refused: the sink map was short')).catch(() => {})));
      throw new ExportError('SINK_SHORT', `the Host opened ${names.length - missing.length} of ${names.length} `
        + `destinations — missing ${missing.join(', ')}. Five of six files is a broken export, not a smaller one`);
    }

    const writers = names.map((n) => sinks[n].getWriter());
    const encs = names.map(() => new WavStreamEncoder(EXPORT_FORMAT.channels, {
      sampleRate: EXPORT_FORMAT.sampleRate, bitDepth: EXPORT_FORMAT.bitDepth, float: true, dither: false, frames,
    }));
    /** ONE window's planes, reused for every stem and every window. */
    const planes = [new Float32Array(this.chunkFrames), new Float32Array(this.chunkFrames)];
    const windows = Math.ceil(frames / this.chunkFrames);
    const total = windows * order.length;
    let done = 0;

    /** Abort EVERY writer — never close one — and release the locks. */
    const abortAll = async (reason) => {
      await Promise.all(writers.map((w) => w.abort(reason).catch(() => {})));
      for (const w of writers) { try { w.releaseLock(); } catch { /* already released */ } }
    };

    try {
      for (const [i, w] of writers.entries()) { await w.write(encs[i].header()); this.bytes += encs[i].headerSize; }
      for (let off = 0; off < frames; off += this.chunkFrames) {
        const len = Math.min(this.chunkFrames, frames - off);
        for (let k = 0; k < order.length; k++) {
          if (this.cancelled) {
            throw new ExportError('CANCELLED', `stopped after ${off} of ${frames} frames — `
              + `all ${names.length} destinations were aborted, so nothing partial is left behind`);
          }
          await readers[k].read(off, len, planes);
          const bytes = encs[k].chunk(planes, len);
          await writers[k].write(bytes);
          this.bytes += bytes.byteLength;
          done++;
          this.#tick('write', k + 1, order.length, done / total, t0);
        }
      }
      // EVERY TAIL, THEN EVERY CLOSE. `end()` throws unless exactly `frames`
      // frames were written, so a short run cannot reach the closes at all.
      const tails = encs.map((e) => e.end());
      for (const [i, w] of writers.entries()) {
        if (tails[i].length) { await w.write(tails[i]); this.bytes += tails[i].length; }
      }
      for (const w of writers) await w.close();
      for (const w of writers) { try { w.releaseLock(); } catch { /* a closed writer releases itself */ } }
    } catch (e) {
      await abortAll(e);
      if (e instanceof ExportError) throw e;
      throw new ExportError('WRITE_FAILED', `${entry.key}: writing stopped — ${(e && e.message) || e}. `
        + `All ${names.length} destinations were aborted rather than closed, so no half-written file is left behind`);
    }

    this.files = names;
    return { files: names, bytes: this.bytes, frames };
  }

  #tick(stage, file, files, pct, t0) {
    const elapsedMs = Date.now() - t0;
    this.onProgress({
      stage,
      file,
      files,
      pct,
      elapsedMs,
      // ETA from the fraction done, or null while there is nothing to divide by.
      // A null is honest; a zero would render as "finished".
      etaMs: pct > 0 ? Math.round(elapsedMs * (1 - pct) / pct) : null,
    });
  }
}
