// wav.js — RIFF/WAVE writer + minimal reader. See docs/AUDIO.md §5 for the byte map.
// Supports 32-bit IEEE float (default, recommended), 24-bit PCM, 16-bit PCM (+TPDF dither).

const FMT_PCM = 1;
const FMT_IEEE_FLOAT = 3;

/**
 * @param {Float32Array[]} channels  planar, equal length
 * @param {{sampleRate?:number, bitDepth?:16|24|32, float?:boolean, dither?:boolean}} opts
 * @returns {ArrayBuffer}
 */
export function encodeWav(channels, opts = {}) {
  const sampleRate = opts.sampleRate ?? 44100;
  const bitDepth = opts.bitDepth ?? 32;
  const isFloat = opts.float ?? (bitDepth === 32);
  const dither = opts.dither ?? (bitDepth === 16 && !isFloat);

  const numChannels = channels.length;
  const numFrames = channels[0].length;
  for (const c of channels) if (c.length !== numFrames) throw new RangeError('channel length mismatch');
  if (isFloat && bitDepth !== 32) throw new RangeError('float requires bitDepth 32');
  if (![16, 24, 32].includes(bitDepth)) throw new RangeError('bitDepth must be 16, 24 or 32');

  const bytesPerSample = bitDepth >> 3;
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = numFrames * blockAlign;
  const fmtSize = isFloat ? 18 : 16;                 // non-PCM needs cbSize
  const factSize = isFloat ? 12 : 0;                 // 'fact' chunk, required for non-PCM
  const pad = dataSize & 1;                          // RIFF chunks are word aligned
  const riffSize = 4 + (8 + fmtSize) + factSize + (8 + dataSize) + pad;

  if (riffSize > 0xfffffffe) throw new RangeError('exceeds 4 GiB RIFF limit — use RF64/WAVE64');

  const buf = new ArrayBuffer(8 + riffSize);
  const dv = new DataView(buf);
  let p = 0;
  const str = (s) => { for (let i = 0; i < s.length; i++) dv.setUint8(p++, s.charCodeAt(i)); };
  const u32 = (v) => { dv.setUint32(p, v, true); p += 4; };
  const u16 = (v) => { dv.setUint16(p, v, true); p += 2; };

  str('RIFF'); u32(riffSize); str('WAVE');
  str('fmt '); u32(fmtSize);
  u16(isFloat ? FMT_IEEE_FLOAT : FMT_PCM);
  u16(numChannels);
  u32(sampleRate);
  u32(sampleRate * blockAlign);   // byteRate
  u16(blockAlign);
  u16(bitDepth);
  if (fmtSize === 18) u16(0);     // cbSize
  if (factSize) { str('fact'); u32(4); u32(numFrames); }
  str('data'); u32(dataSize);

  if (isFloat) {
    for (let i = 0; i < numFrames; i++)
      for (let c = 0; c < numChannels; c++) { dv.setFloat32(p, channels[c][i], true); p += 4; }
  } else if (bitDepth === 16) {
    const scale = 32768, lo = -32768, hi = 32767;
    for (let i = 0; i < numFrames; i++)
      for (let c = 0; c < numChannels; c++) {
        let v = channels[c][i] * scale;
        if (dither) v += (Math.random() - Math.random());   // TPDF, 2 LSB pk-pk
        v = Math.round(v);
        dv.setInt16(p, v < lo ? lo : v > hi ? hi : v, true); p += 2;
      }
  } else { // 24
    const scale = 8388608, lo = -8388608, hi = 8388607;
    for (let i = 0; i < numFrames; i++)
      for (let c = 0; c < numChannels; c++) {
        let v = channels[c][i] * scale;
        if (dither) v += (Math.random() - Math.random());
        v = Math.round(v);
        v = v < lo ? lo : v > hi ? hi : v;
        if (v < 0) v += 0x1000000;
        dv.setUint8(p++, v & 0xff); dv.setUint8(p++, (v >> 8) & 0xff); dv.setUint8(p++, (v >> 16) & 0xff);
      }
  }
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
