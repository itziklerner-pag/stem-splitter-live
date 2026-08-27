// wav.js — RIFF/WAVE writer + minimal reader. See docs/AUDIO.md §5 for the byte map.
// Supports 32-bit IEEE float (default, recommended), 24-bit PCM, 16-bit PCM (+TPDF dither).
//
// THREE WRITERS, ONE ENCODER. `encodeWav` builds a whole file in one buffer;
// `WavStreamEncoder` emits the same bytes a chunk at a time into a
// `WritableStream`; `WavSyncWriter` appends into an OPFS
// `FileSystemSyncAccessHandle` without knowing the length in advance. They share
// `wavFormat`, `wavHeader` and `writeFrames` on purpose: the streaming path must
// be the SAME encoder as the whole-buffer one, and the cheapest way to be sure of
// that is for there to be only one copy of the sample-writing loop. `test.js`
// group('wavstream') asserts the bytes agree anyway, because sharing the loop
// does not prove the composition around it — the header, the chunk boundaries,
// the RIFF pad byte and the frame accounting — is right.
//
// WHY STREAMING EXISTS. Six 32f stems of a four-minute track are ~508 MB, and
// `encodeWav` allocates the entire file before it writes a byte
// (`new ArrayBuffer(8 + riffSize)`). That is the ceiling ARCHITECTURE R6 names
// for export and stemcache.js's header names for the cache write.
//
// WHY THE KNOWN-LENGTH VARIANT NEEDS NO SEEK. An ahead-of-time export knows its
// frame count before it starts, so the RIFF sizes are correct in the first bytes
// written and are never patched. That is what lets the export target a plain
// `WritableStream` — a Host that hands over an append-only sink does not have to
// hand over a seekable one. The OPFS variant is the other case: the live cache
// write does not know the length until the pipeline stops, so it patches three
// fields at close, which is exactly what a sync access handle is for.

const FMT_PCM = 1;
const FMT_IEEE_FLOAT = 3;

/** The RIFF size field is a uint32, so a WAVE file cannot reach 4 GiB. */
const RIFF_MAX = 0xfffffffe;
const NO_BYTES = new Uint8Array(0);

/**
 * Resolve and validate a format ONCE, for all three writers. Every default and
 * every refusal in here was `encodeWav`'s before it was shared, and the order is
 * preserved: a channel-length mismatch is the caller's first mistake, then the
 * float/depth pair, then the depth itself.
 * @param {number} numChannels
 * @param {{sampleRate?:number, bitDepth?:16|24|32, float?:boolean, dither?:boolean}} opts
 */
function wavFormat(numChannels, opts = {}) {
  const sampleRate = opts.sampleRate ?? 44100;
  const bitDepth = opts.bitDepth ?? 32;
  const isFloat = opts.float ?? (bitDepth === 32);
  const dither = opts.dither ?? (bitDepth === 16 && !isFloat);
  if (isFloat && bitDepth !== 32) throw new RangeError('float requires bitDepth 32');
  if (![16, 24, 32].includes(bitDepth)) throw new RangeError('bitDepth must be 16, 24 or 32');

  const bytesPerSample = bitDepth >> 3;
  const fmtSize = isFloat ? 18 : 16;                 // non-PCM needs cbSize
  const factSize = isFloat ? 12 : 0;                 // 'fact' chunk, required for non-PCM
  return {
    sampleRate, bitDepth, isFloat, dither, numChannels, bytesPerSample,
    blockAlign: numChannels * bytesPerSample,
    fmtSize, factSize,
    // Everything up to and including the 'data' chunk's size field. Fixed by the
    // format alone, which is why an unknown-length write can lay it down first
    // and patch three fields inside it later.
    headerSize: 12 + (8 + fmtSize) + factSize + 8,
  };
}

/** Byte offset of the `fact` chunk's frame count, and of the `data` chunk's size. */
const factFramesAt = (fmt) => 12 + 8 + fmt.fmtSize + 8;
const dataSizeAt = (fmt) => fmt.headerSize - 4;

/**
 * The RIFF size field for a given payload, and the 4 GiB refusal.
 * CALLED BY ALL THREE WRITERS, and by `WavSyncWriter.append` BEFORE it writes,
 * because a file that has already crossed the ceiling cannot be un-crossed: the
 * size field would wrap and the result would be a plausible-looking short file.
 */
function riffSizeFor(fmt, dataSize) {
  const riffSize = (fmt.headerSize - 8) + dataSize + (dataSize & 1);
  if (riffSize > RIFF_MAX) throw new RangeError('exceeds 4 GiB RIFF limit — use RF64/WAVE64');
  return riffSize;
}

/**
 * The header bytes for `numFrames` frames. Complete and final when the frame
 * count is known up front — no seek, no patch, no second pass.
 * @returns {Uint8Array} exactly `fmt.headerSize` bytes
 */
function wavHeader(fmt, numFrames) {
  const dataSize = numFrames * fmt.blockAlign;
  const riffSize = riffSizeFor(fmt, dataSize);
  const out = new Uint8Array(fmt.headerSize);
  const dv = new DataView(out.buffer);
  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };

  str('RIFF'); u32(riffSize); str('WAVE');
  str('fmt '); u32(fmt.fmtSize);
  u16(fmt.isFloat ? FMT_IEEE_FLOAT : FMT_PCM);
  u16(fmt.numChannels);
  u32(fmt.sampleRate);
  u32(fmt.sampleRate * fmt.blockAlign);   // byteRate
  u16(fmt.blockAlign);
  u16(fmt.bitDepth);
  if (fmt.fmtSize === 18) u16(0);         // cbSize
  if (fmt.factSize) { str('fact'); u32(4); u32(numFrames); }
  str('data'); u32(dataSize);
  return out;
}

/**
 * Interleave and convert `count` frames of planar float into `dv` at `p`.
 * THE ONE SAMPLE-WRITING LOOP IN THIS FILE. Frames outer, channels inner — the
 * interleave order is what makes a chunked write byte-identical to a whole-buffer
 * one, and it is only true while a chunk boundary is a FRAME boundary.
 * @returns {number} the new write offset
 */
function writeFrames(dv, p, fmt, channels, count) {
  const { numChannels, bitDepth, isFloat, dither } = fmt;
  if (isFloat) {
    // NO CLAMP, deliberately: htdemucs outputs are not bounded to ±1.0 and 32f
    // export is defined as the untouched model output (AUDIO.md §5.3).
    for (let i = 0; i < count; i++)
      for (let c = 0; c < numChannels; c++) { dv.setFloat32(p, channels[c][i], true); p += 4; }
  } else if (bitDepth === 16) {
    const scale = 32768, lo = -32768, hi = 32767;
    for (let i = 0; i < count; i++)
      for (let c = 0; c < numChannels; c++) {
        let v = channels[c][i] * scale;
        if (dither) v += (Math.random() - Math.random());   // TPDF, 2 LSB pk-pk
        v = Math.round(v);
        dv.setInt16(p, v < lo ? lo : v > hi ? hi : v, true); p += 2;
      }
  } else { // 24
    const scale = 8388608, lo = -8388608, hi = 8388607;
    for (let i = 0; i < count; i++)
      for (let c = 0; c < numChannels; c++) {
        let v = channels[c][i] * scale;
        if (dither) v += (Math.random() - Math.random());
        v = Math.round(v);
        v = v < lo ? lo : v > hi ? hi : v;
        if (v < 0) v += 0x1000000;
        dv.setUint8(p++, v & 0xff); dv.setUint8(p++, (v >> 8) & 0xff); dv.setUint8(p++, (v >> 16) & 0xff);
      }
  }
  return p;
}

/**
 * @param {Float32Array[]} channels  planar, equal length
 * @param {{sampleRate?:number, bitDepth?:16|24|32, float?:boolean, dither?:boolean}} opts
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, opts = {}) {
  const numChannels = channels.length;
  const numFrames = channels[0].length;
  for (const c of channels) if (c.length !== numFrames) throw new RangeError('channel length mismatch');

  const fmt = wavFormat(numChannels, opts);
  const dataSize = numFrames * fmt.blockAlign;
  const pad = dataSize & 1;                          // RIFF chunks are word aligned
  const riffSize = riffSizeFor(fmt, dataSize);

  const buf = new ArrayBuffer(8 + riffSize);
  const dv = new DataView(buf);
  new Uint8Array(buf).set(wavHeader(fmt, numFrames), 0);
  let p = writeFrames(dv, fmt.headerSize, fmt, channels, numFrames);
  if (pad) dv.setUint8(p++, 0);
  return buf;
}

/** Minimal reader for the subset we write (and for museval/reference material). */
export function decodeWav(arrayBuffer) {
  const dv = new DataView(arrayBuffer);
  const tag = (o) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a RIFF/WAVE file');
  let p = 12, fmt = null, data = null;
  while (p + 8 <= dv.byteLength) {
    const id = tag(p), size = dv.getUint32(p + 4, true), body = p + 8;
    if (id === 'fmt ') {
      let format = dv.getUint16(body, true);
      const numChannels = dv.getUint16(body + 2, true);
      const sampleRate = dv.getUint32(body + 4, true);
      const bitDepth = dv.getUint16(body + 14, true);
      if (format === 0xfffe && size >= 40) format = dv.getUint16(body + 24, true); // EXTENSIBLE
      fmt = { format, numChannels, sampleRate, bitDepth };
    } else if (id === 'data') data = { offset: body, size: Math.min(size, dv.byteLength - body) };
    p = body + size + (size & 1);
  }
  if (!fmt || !data) throw new Error('missing fmt or data chunk');
  const bps = fmt.bitDepth >> 3, blockAlign = fmt.numChannels * bps;
  const frames = Math.floor(data.size / blockAlign);
  const chans = Array.from({ length: fmt.numChannels }, () => new Float32Array(frames));
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < fmt.numChannels; c++) {
      const o = data.offset + i * blockAlign + c * bps;
      let v;
      if (fmt.format === FMT_IEEE_FLOAT) v = bps === 8 ? dv.getFloat64(o, true) : dv.getFloat32(o, true);
      else if (bps === 2) v = dv.getInt16(o, true) / 32768;
      else if (bps === 3) { let u = dv.getUint8(o) | (dv.getUint8(o + 1) << 8) | (dv.getUint8(o + 2) << 16); if (u & 0x800000) u -= 0x1000000; v = u / 8388608; }
      else if (bps === 4) v = dv.getInt32(o, true) / 2147483648;
      else if (bps === 1) v = (dv.getUint8(o) - 128) / 128;
      else throw new Error('unsupported bit depth ' + fmt.bitDepth);
      chans[c][i] = v;
    }
  }
  return { channels: chans, sampleRate: fmt.sampleRate, bitDepth: fmt.bitDepth, float: fmt.format === FMT_IEEE_FLOAT };
}

/**
 * KNOWN-LENGTH, APPEND-ONLY. The same bytes `encodeWav` would produce, emitted a
 * chunk at a time, without ever holding the file.
 *
 *   const enc = new WavStreamEncoder(2, { sampleRate: SR, bitDepth: 32, float: true, frames: n });
 *   await enc.pipeTo(sink, chunks);            // or drive it by hand:
 *   w.write(enc.header()); w.write(enc.chunk([l, r], len)); ...; w.write(enc.end());
 *
 * THE FRAME COUNT IS THE CONTRACT. It goes into the header before any audio is
 * written, so it cannot be revised afterwards: a sink that has taken the first
 * chunk has already taken a file length. Both ways of getting it wrong therefore
 * THROW rather than truncate — a long write is refused by `chunk()` before the
 * bytes are built, a short one by `end()` — because the failure this replaces is
 * a file whose header says four minutes and whose data stops at three.
 *
 * @param {number} numChannels  a channel COUNT; the planes arrive per chunk
 * @param {{sampleRate?:number, bitDepth?:16|24|32, float?:boolean, dither?:boolean, frames:number}} opts
 */
export class WavStreamEncoder {
  constructor(numChannels, opts = {}) {
    if (!Number.isInteger(numChannels) || numChannels < 1) {
      const got = Array.isArray(numChannels) || ArrayBuffer.isView(numChannels)
        ? `${numChannels.length} planes` : `${typeof numChannels} ${numChannels}`;
      throw new RangeError(`wav stream: first argument is a channel COUNT, not the audio — got ${got}`);
    }
    const frames = opts.frames;
    if (!Number.isInteger(frames) || frames < 0) {
      throw new RangeError(`wav stream: frames must be known before the header is written, got ${frames} — `
        + 'an unknown length needs WavSyncWriter and a seekable handle');
    }
    this.fmt = wavFormat(numChannels, opts);
    this.frames = frames;
    this.written = 0;
    this.dataSize = frames * this.fmt.blockAlign;
    /** Refuses the 4 GiB ceiling HERE, before a caller streams three GiB to find out. */
    this.byteLength = 8 + riffSizeFor(this.fmt, this.dataSize);
    this.headerSize = this.fmt.headerSize;
  }

  /** The complete, final header. Correct on the first chunk; never patched. */
  header() { return wavHeader(this.fmt, this.frames); }

  /**
   * @param {Float32Array[]} channels planar, `numChannels` of them
   * @param {number} [len] frames to take from the head of each plane
   * @returns {Uint8Array} interleaved, converted bytes
   */
  chunk(channels, len = channels[0].length) {
    if (this.written + len > this.frames) {
      throw new RangeError(`wav stream: ${this.written + len} frames offered but the header declares `
        + `${this.frames} — a long write would run past the size already in the file`);
    }
    if (channels.length !== this.fmt.numChannels) {
      throw new RangeError(`wav stream: ${channels.length} planes for a ${this.fmt.numChannels}-channel file`);
    }
    for (const c of channels) {
      if (c.length < len) throw new RangeError(`wav stream: a plane holds ${c.length} frames, ${len} asked for`);
    }
    const out = new Uint8Array(len * this.fmt.blockAlign);
    writeFrames(new DataView(out.buffer), 0, this.fmt, channels, len);
    this.written += len;
    return out;
  }

  /**
   * The RIFF pad byte, if the payload is odd. THROWS on a short write: the
   * header already promised `frames`, so stopping early is a corrupt file and
   * not a smaller one.
   * @returns {Uint8Array} zero or one byte
   */
  end() {
    if (this.written !== this.frames) {
      throw new RangeError(`wav stream: ${this.written} of ${this.frames} frames written — `
        + 'the header describes bytes that were never sent');
    }
    return (this.dataSize & 1) ? new Uint8Array(1) : NO_BYTES;
  }

  /**
   * Drive a whole encode into a `WritableStream`. `source` yields `[channels, len]`.
   * A refusal ABORTS the sink rather than closing it, so a Host that turns the
   * writable into a file is told the file is not a file.
   */
  async pipeTo(writable, source) {
    const w = writable.getWriter();
    try {
      await w.write(this.header());
      for await (const [channels, len] of source) await w.write(this.chunk(channels, len));
      const tail = this.end();
      if (tail.length) await w.write(tail);
      await w.close();
    } catch (err) {
      await w.abort(err).catch(() => {});
      throw err;
    } finally {
      w.releaseLock();
    }
  }
}

/**
 * UNKNOWN LENGTH, into an OPFS `FileSystemSyncAccessHandle` — the cache write.
 * The live pipeline does not know how long the track is until it stops, so the
 * three length-bearing fields (RIFF size, `fact` frames, `data` size) go down as
 * zeros and are patched at `close()`. That is the whole reason this variant needs
 * a seekable handle and the streaming one does not.
 *
 * DUCK-TYPED ON FOUR MEMBERS — `write(buf, {at})`, `truncate`, `flush`, `close` —
 * the way `readWindow` is duck-typed in engine/live.js, so the suite can drive it
 * over a fake and OPFS is not a precondition for testing the encoder.
 *
 * @param {{write:Function, truncate:Function, flush:Function, close:Function}} handle
 * @param {number} numChannels
 */
export class WavSyncWriter {
  constructor(handle, numChannels, opts = {}) {
    if (!Number.isInteger(numChannels) || numChannels < 1) {
      throw new RangeError(`wav sync: second argument is a channel COUNT, got ${typeof numChannels} ${numChannels}`);
    }
    this.handle = handle;
    this.fmt = wavFormat(numChannels, opts);
    this.frames = 0;
    this.at = this.fmt.headerSize;
    this.closed = false;
    // A placeholder header, so the audio starts at the right offset. Every field
    // in it is final except the three the frame count feeds.
    handle.write(wavHeader(this.fmt, 0), { at: 0 });
  }

  /** @param {Float32Array[]} channels planar @param {number} [len] */
  append(channels, len = channels[0].length) {
    if (this.closed) throw new Error('wav sync: append after close');
    // THE CEILING FIRST, BEFORE ANY BYTE IS WRITTEN. A file that has crossed
    // 4 GiB cannot be repaired at close: the size field wraps and what is left on
    // disk is a short file that parses.
    riffSizeFor(this.fmt, (this.frames + len) * this.fmt.blockAlign);
    if (channels.length !== this.fmt.numChannels) {
      throw new RangeError(`wav sync: ${channels.length} planes for a ${this.fmt.numChannels}-channel file`);
    }
    for (const c of channels) {
      if (c.length < len) throw new RangeError(`wav sync: a plane holds ${c.length} frames, ${len} asked for`);
    }
    const out = new Uint8Array(len * this.fmt.blockAlign);
    writeFrames(new DataView(out.buffer), 0, this.fmt, channels, len);
    this.handle.write(out, { at: this.at });
    this.at += out.byteLength;
    this.frames += len;
  }

  /**
   * Pad, patch the three lengths, truncate away anything a previous longer file
   * left behind, flush, close. Closes the HANDLE: it is called close().
   * @returns {{frames:number, byteLength:number}}
   */
  close() {
    if (this.closed) throw new Error('wav sync: close twice');
    this.closed = true;
    const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
    const dataSize = this.frames * this.fmt.blockAlign;
    if (dataSize & 1) { this.handle.write(new Uint8Array(1), { at: this.at }); this.at += 1; }
    const riffSize = riffSizeFor(this.fmt, dataSize);
    this.handle.write(u32(riffSize), { at: 4 });
    if (this.fmt.factSize) this.handle.write(u32(this.frames), { at: factFramesAt(this.fmt) });
    this.handle.write(u32(dataSize), { at: dataSizeAt(this.fmt) });
    this.handle.truncate(this.at);
    this.handle.flush();
    this.handle.close();
    return { frames: this.frames, byteLength: this.at };
  }
}
