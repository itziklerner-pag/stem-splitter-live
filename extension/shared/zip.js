/**
 * zip.js — a STORED-only ZIP writer, and a reader for what it writes.
 *
 * WHY THIS FILE EXISTS. The product hands the user exactly one thing: seven
 * `.mid` files (ADR 0002 / the owner's ruling R2, §5 of the pack layout). Seven
 * files is a folder, and the only container every desktop opens without asking
 * for software is a zip. Everything here is the smallest subset of APPNOTE.TXT
 * that produces one: local file header, the bytes, central directory, end of
 * central directory. No DEFLATE, no zip64, no data descriptor, no comment.
 *
 * NO DEFLATE, ON PURPOSE. Ruling R10 forbids it and MIDI is already compact —
 * the seven entries of a four-minute pack are tens of kilobytes in total. A
 * deflate implementation would be the largest single thing in this repository
 * that nothing else needed, and `CONTRIBUTING.md`'s bias is fewest files, least
 * tooling that works.
 *
 * ---------------------------------------------------------------------------
 * LITTLE-ENDIAN, AND THAT IS THE OPPOSITE OF ITS ONLY CALLER.
 *
 * Every multi-byte field in a zip is LITTLE-endian. Every multi-byte field in
 * `shared/midi.js`, which is the only module that calls this one, is BIG-endian
 * — Standard MIDI Files are big-endian and always were. Two byte orders, two
 * files, and the two byte sinks are deliberately separate objects with
 * different names that are not exported: `LeSink` here, `BeSink` there.
 *
 * A single shared writer with an `endian` flag would put a boolean between a
 * caller and the byte order of the format it is writing, and the failure that
 * produces is a plausible-looking file that no tool can open — the worst class
 * of bug a codec can have, because it passes every test the codec writes for
 * itself. Keeping them apart is what makes "this file is little-endian" a
 * property of the file rather than of an argument.
 *
 * ---------------------------------------------------------------------------
 * IT HAS A READER BECAUSE THE DELIVERY GUARD HAS TO LOOK INSIDE.
 *
 * `shared/midi.js::assertDeliverable` refuses to hand over an archive whose
 * entries are not all MIDI, so it has to parse the archive it is asked to
 * vouch for. That is the reader's caller, and it is why the reader THROWS
 * rather than returning a partial list: a reader that silently dropped an entry
 * it could not parse would let the guard vouch for bytes it never saw, which is
 * the one thing the guard exists to stop.
 *
 * `qa/midi-pack.mjs` is the third opinion. A writer checked only by its own
 * reader checks that the two agree, not that the bytes are a zip — so the gate
 * asserts the STRUCTURE by offset (signature, header size, flags, method,
 * sizes, the central directory's back-pointer) rather than by shelling out to
 * `unzip`, which would be a tool this repo does not have and a test this repo
 * could not run.
 *
 *   covered by  node qa/midi-pack.mjs
 */

/* Signatures, sizes and the two fixed fields, named once. */
const SIG_LFH = 0x04034b50;      // local file header
const SIG_CDH = 0x02014b50;      // central directory header
const SIG_EOCD = 0x06054b50;     // end of central directory
const LFH_BYTES = 30;            // + name
const CDH_BYTES = 46;            // + name
const EOCD_BYTES = 22;           // + comment, and we write none
const VERSION = 0x0014;          // 2.0 — the version that defines STORED
const METHOD_STORED = 0;
const FLAG_UTF8 = 0x0800;        // bit 11: the name is UTF-8, not CP437
const FLAG_DATA_DESC = 0x0008;   // bit 3: sizes follow the data. NEVER set here.

/**
 * THE TIMESTAMP IS FIXED, and that is a feature.
 *
 * MS-DOS time 0x0000 / date 0x0021 is 1980-01-01 00:00:00, the earliest instant
 * the format can express. Two runs over the same notes therefore produce
 * BYTE-IDENTICAL archives, so a diff in the gate is a defect rather than a
 * clock — the same reason `qa/` gates count instead of timing (AGENTS.md,
 * "if a claim can be carried by a COUNT, do not carry it with a stopwatch").
 *
 * ponytail: ceiling — every file in the pack shows a 1980 mtime in the user's
 * file manager, which looks like a bug to anyone who notices. Upgrade path:
 * take the timestamp as an argument from the deck, which is the only context
 * that has a clock, and give the gate a fixed one; that costs a parameter on
 * `zipStore` and an argument at one call site, and it is worth doing the day
 * somebody complains, not before.
 */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021;

/* The table, built once at module load: 1 KB, and the difference between a
 * byte loop and eight bit loops per byte. */
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

/**
 * IEEE 802.3 CRC-32, reflected, polynomial 0xEDB88320.
 *
 * KNOWN ANSWER: `crc32(bytes('123456789')) === 0xCBF43926`. That vector is the
 * check value every CRC-32 catalogue publishes, and `qa/midi-pack.mjs` asserts
 * it — because a table that is wrong in a way both halves share passes a round
 * trip and fails only against a number written down somewhere else.
 *
 * @param {Uint8Array} bytes
 * @returns {number} unsigned 32-bit
 */
export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** The little-endian byte sink. Fixed-size: the archive's length is known before a byte is written. */
class LeSink {
  /** @param {number} bytes exact archive length */
  constructor(bytes) { this.b = new Uint8Array(bytes); this.p = 0; }
  u16(v) { this.b[this.p++] = v & 0xff; this.b[this.p++] = (v >>> 8) & 0xff; }
  u32(v) {
    this.b[this.p++] = v & 0xff; this.b[this.p++] = (v >>> 8) & 0xff;
    this.b[this.p++] = (v >>> 16) & 0xff; this.b[this.p++] = (v >>> 24) & 0xff;
  }
  raw(a) { this.b.set(a, this.p); this.p += a.length; }
}

/**
 * Write a STORED archive.
 *
 * @param {Array<{name: string, bytes: Uint8Array}>} entries in the order they
 *        are to appear. Names are ASCII, no path separator, no leading dot.
 * @returns {Uint8Array} the whole archive.
 *
 * Version-needed 0x0014, method 0, no data descriptor, no zip64, no archive
 * comment, external attributes 0, fixed DOS timestamp.
 *
 * THE GENERAL-PURPOSE FLAGS, both bits, because both are load-bearing:
 *
 *  - BIT 3 IS ALWAYS 0. It means "the CRC and the sizes follow the data in a
 *    descriptor, because they were not known when the header was written". They
 *    ARE known here — this writer holds the whole entry in memory before it
 *    writes a byte — and a reader that meets bit 3 has to go looking for a
 *    descriptor that is not there. Streaming writers set it; this one cannot.
 *  - BIT 11 IS SET ONLY WHEN THE NAME NEEDS IT. It declares the name UTF-8
 *    rather than CP437. The seven pack entry names are ASCII by construction,
 *    which is a subset of both, so they carry flags 0x0000 and the archive is
 *    byte-identical to the one the contract pins. A caller that ever hands over
 *    a non-ASCII name gets 0x0800, because a UTF-8 name flagged as CP437 is
 *    mojibake in every extractor on the planet and silently so.
 *
 * MUST NOT compress. MUST NOT sort or rename. MUST NOT allocate per byte.
 */
export function zipStore(entries) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new Error('zipStore: no entries — an empty archive is never what a caller meant');
  }
  const enc = new TextEncoder();
  const recs = entries.map((e, i) => {
    if (!e || typeof e.name !== 'string' || e.name.length === 0) {
      throw new Error(`zipStore: entry ${i} has no name`);
    }
    if (/[/\\]/.test(e.name) || e.name.startsWith('.')) {
      throw new Error(`zipStore: entry ${i} name ${JSON.stringify(e.name)} — no path separator and no leading dot`);
    }
    if (!(e.bytes instanceof Uint8Array)) {
      throw new Error(`zipStore: entry ${JSON.stringify(e.name)} carries ${e.bytes === null ? 'null' : typeof e.bytes}, not a Uint8Array`);
    }
    const name = enc.encode(e.name);
    if (name.length > 0xffff) throw new Error(`zipStore: entry name is ${name.length} bytes, the field holds 0xffff`);
    let ascii = true;
    for (let k = 0; k < name.length; k++) if (name[k] >= 0x80) { ascii = false; break; }
    return { name, flags: ascii ? 0x0000 : FLAG_UTF8, bytes: e.bytes, crc: crc32(e.bytes), off: 0 };
  });

  let total = EOCD_BYTES;
  for (const r of recs) total += LFH_BYTES + r.name.length + r.bytes.length + CDH_BYTES + r.name.length;
  if (total > 0xffffffff) throw new Error('zipStore: archive exceeds 4 GiB — that needs zip64, which this writer does not do');

  const s = new LeSink(total);
  for (const r of recs) {
    r.off = s.p;
    s.u32(SIG_LFH); s.u16(VERSION); s.u16(r.flags); s.u16(METHOD_STORED);
    s.u16(DOS_TIME); s.u16(DOS_DATE);
    s.u32(r.crc); s.u32(r.bytes.length); s.u32(r.bytes.length);
    s.u16(r.name.length); s.u16(0);            // no extra field
    s.raw(r.name); s.raw(r.bytes);
  }
  const cdOff = s.p;
  for (const r of recs) {
    s.u32(SIG_CDH); s.u16(VERSION); s.u16(VERSION); s.u16(r.flags); s.u16(METHOD_STORED);
    s.u16(DOS_TIME); s.u16(DOS_DATE);
    s.u32(r.crc); s.u32(r.bytes.length); s.u32(r.bytes.length);
    s.u16(r.name.length); s.u16(0); s.u16(0);  // name, extra, comment
    s.u16(0); s.u16(0); s.u32(0);              // disk, internal attrs, external attrs
    s.u32(r.off);
    s.raw(r.name);
  }
  const cdSize = s.p - cdOff;
  s.u32(SIG_EOCD); s.u16(0); s.u16(0);
  s.u16(recs.length); s.u16(recs.length);
  s.u32(cdSize); s.u32(cdOff); s.u16(0);       // no archive comment
  if (s.p !== total) throw new Error(`zipStore: wrote ${s.p} bytes, sized ${total} — the size arithmetic and the writer disagree`);
  return s.b;
}

/**
 * Read a STORED archive back.
 *
 * @param {Uint8Array} bytes
 * @returns {Array<{name: string, bytes: Uint8Array}>} in central-directory order
 * @throws {Error} naming what was wrong — bad EOCD, bad signature, unsupported
 *         method, CRC mismatch, truncated entry.
 *
 * IT MUST THROW RATHER THAN RETURN A PARTIAL LIST. Its caller is a guard that
 * decides whether bytes may leave the product; a list that quietly lost the one
 * entry the reader could not parse is a guard that vouches for bytes it never
 * saw. Every failure below is loud for that reason, and every one of them names
 * the entry it was looking at.
 *
 * The central directory is the authority on what is in an archive — that is
 * what makes a zip readable from the end and what an extractor uses — so this
 * walks the directory and cross-checks each local header against it, rather
 * than walking local headers and hoping the directory agrees.
 */
export function zipEntries(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    throw new Error(`zipEntries: not a byte array (${bytes === null ? 'null' : typeof bytes})`);
  }
  if (bytes.length < EOCD_BYTES) {
    throw new Error(`zipEntries: ${bytes.length} bytes is shorter than an empty zip's ${EOCD_BYTES}-byte end record`);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();

  // Scan back for the end record. It is the last 22 bytes unless there is an
  // archive comment; we write none, but a reader that could only read its own
  // writer's output would not be an independent check of anything.
  let eocd = -1;
  const floor = Math.max(0, bytes.length - EOCD_BYTES - 0xffff);
  for (let p = bytes.length - EOCD_BYTES; p >= floor; p--) {
    if (dv.getUint32(p, true) === SIG_EOCD) { eocd = p; break; }
  }
  if (eocd < 0) throw new Error('zipEntries: no end-of-central-directory record — these bytes are not a zip');

  const count = dv.getUint16(eocd + 10, true);
  const cdSize = dv.getUint32(eocd + 12, true);
  const cdOff = dv.getUint32(eocd + 16, true);
  if (cdOff + cdSize > bytes.length) {
    throw new Error(`zipEntries: the central directory says ${cdOff}+${cdSize} and the archive is ${bytes.length} bytes — truncated`);
  }

  const out = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + CDH_BYTES > cdOff + cdSize) throw new Error(`zipEntries: central directory ends inside entry ${i}`);
    if (dv.getUint32(p, true) !== SIG_CDH) throw new Error(`zipEntries: bad central directory signature at entry ${i}`);
    const flags = dv.getUint16(p + 8, true);
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true);
    const elen = dv.getUint16(p + 30, true);
    const clen = dv.getUint16(p + 32, true);
    const lfh = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + CDH_BYTES, p + CDH_BYTES + nlen));
    p += CDH_BYTES + nlen + elen + clen;

    if (method !== METHOD_STORED) {
      throw new Error(`zipEntries: entry "${name}" uses compression method ${method} — this reader is STORED (0) only`);
    }
    if (flags & FLAG_DATA_DESC) {
      throw new Error(`zipEntries: entry "${name}" sets general-purpose bit 3, so its size and CRC live in a data descriptor this reader does not read`);
    }
    if (csize !== usize) {
      throw new Error(`zipEntries: entry "${name}" is stored but its sizes differ (${csize} vs ${usize})`);
    }
    if (lfh + LFH_BYTES > bytes.length || dv.getUint32(lfh, true) !== SIG_LFH) {
      throw new Error(`zipEntries: entry "${name}" points at ${lfh}, where there is no local file header`);
    }
    const lnlen = dv.getUint16(lfh + 26, true);
    const lelen = dv.getUint16(lfh + 28, true);
    const lname = dec.decode(bytes.subarray(lfh + LFH_BYTES, lfh + LFH_BYTES + lnlen));
    if (lname !== name) {
      throw new Error(`zipEntries: the directory calls it "${name}" and its local header calls it "${lname}"`);
    }
    const from = lfh + LFH_BYTES + lnlen + lelen;
    if (from + csize > bytes.length) {
      throw new Error(`zipEntries: entry "${name}" claims ${csize} bytes at ${from} and the archive ends at ${bytes.length} — truncated`);
    }
    const data = bytes.slice(from, from + csize);
    const got = crc32(data);
    if (got !== crc) {
      throw new Error(`zipEntries: CRC mismatch in entry "${name}" — header says 0x${crc.toString(16).padStart(8, '0')}, the ${data.length} stored bytes hash to 0x${got.toString(16).padStart(8, '0')}`);
    }
    out.push({ name, bytes: data });
  }
  return out;
}
