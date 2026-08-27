/**
 * THE MODEL'S IDENTITY, AND THE POLICY AROUND IT — the UNIT's half of the model
 * pin. No `fetch`, no Cache API, no URL: the bytes arrive from the Host
 * (`EngineHost.modelBytes`) and this file decides whether they are the model.
 *
 * WHY THE SPLIT IS THIS WAY ROUND (S7). P1 says exactly one network request is
 * ever made and M1 says the weights are data, never script. Both are properties
 * of the UNIT, and both used to be enforced by code that also owned the URL —
 * so a second Host could have satisfied `assertHost`, handed over bytes from
 * anywhere, and skipped the check entirely. VERIFICATION DOES NOT FOLLOW THE
 * FETCH ACROSS THE SEAM: whatever a Host hands over is counted and hashed HERE,
 * on EVERY load, and a Host has no way to opt out of it. Every load rather than
 * only the first is the same rule as before S7 — a truncated or corrupted entry
 * must never reach InferenceSession.create (SCOPE AC-2.5.d) — and the store it
 * comes out of is now the Host's, which makes it matter more, not less.
 *
 * THE FILE KEEPS ITS NAME on purpose even though it no longer caches anything:
 * it is still the module the model's bytes go through, `offscreen/engine.js` is
 * still its only importer, and renaming it in the same commit that moves its
 * contents would make the diff unreadable for the one review that most needs
 * reading. S11 owns the naming pass over the whole seam.
 */

import { MODEL } from './config.js';
import { MODEL_SOURCES } from './host.js';

function hex(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
  return s;
}

/**
 * Are these bytes the model? Resolves with them if so; rejects naming the
 * property that failed AND both of its values if not.
 *
 * BYTE COUNT FIRST, THEN SHA-256 — and the byte count is NEW in S7. Before it,
 * a truncated download reported an unexplained SHA-256 mismatch, which is the
 * failure `tools/host.mjs::requireModelSeed` already refuses to inflict on
 * anyone: a length is the one property that separates "this file was cut short"
 * from "these are the wrong weights" without leaving the reader to guess which.
 * It also costs nothing, which is why it goes first — there is no reason to hash
 * 109 MB to discover that 109 MB did not arrive.
 *
 * THE PIN IS A PARAMETER so that a check of this function can drive it over
 * bytes that can actually be constructed. The alternative — a test hard-coding
 * the real SHA-256 beside a fabricated buffer — is a second copy of the pin,
 * which is the exact thing `shared/config.js` exists to prevent. The DEFAULT is
 * the shipped pin and every production caller takes it: nothing in `extension/`
 * passes this argument.
 *
 * @param {Uint8Array} bytes
 * @param {{sha256: string, bytes: number}} pin
 * @returns {Promise<Uint8Array>} `bytes`, so a caller can check and use in one expression
 */
export async function verifyModel(bytes, pin = MODEL) {
  if (bytes.length !== pin.bytes) {
    throw new Error(`model integrity check failed: ${bytes.length} bytes != ${pin.bytes}`);
  }
  const got = hex(await crypto.subtle.digest('SHA-256', bytes));
  if (got !== pin.sha256) {
    throw new Error(`model integrity check failed: sha256 ${got} != ${pin.sha256}`);
  }
  return bytes;
}

/**
 * RULE 2 OF THE HOST'S MODEL BYTES, CHECKED HERE RATHER THAN TRUSTED
 * (`shared/host.js`: "`bytes` OWNS ITS WHOLE BUFFER, AND IT IS FRESH EVERY
 * CALL"). The unit HASHES `bytes` and hands on `bytes.buffer`, and those are
 * only the same bytes if the view owns the whole buffer — so without this, a
 * Host could pass `verifyModel` over 4 KB and have the worker bind a session
 * over the 8 KB it was a window into. That is not a hypothetical shape: it is
 * what `subarray` returns, and what `Buffer.concat` hands back off Node's pool,
 * i.e. the first thing a second Host writes.
 *
 * A HOST DEFECT IS NOT A CORRUPT STORE. It fails the same way however often it
 * is asked, so this throws where it stands — no `clearModel`, no second ask —
 * and the counts in `test.js` say so (1 ask, 0 clears).
 *
 * THE THREE MESSAGES ARE THE POINT. Each names the mistake instead of letting it
 * surface later as something else: a view surfaces as an ORT session error long
 * after a green integrity check; an `ArrayBuffer` where a `Uint8Array` was meant
 * hashes perfectly well and then reports `undefined bytes`; and a TRANSFERRED
 * buffer — what a Host that memoized its bytes hands back on the next load —
 * reports `0 bytes` against the pin, which blames the Host's bytes for something
 * the unit did to them.
 *
 * @param {Uint8Array} bytes  whatever `host.modelBytes()` handed over
 */
function requireWholeBuffer(bytes) {
  if (!(bytes instanceof Uint8Array)) {
    const got = bytes === null ? 'null' : ((bytes && bytes.constructor && bytes.constructor.name) || typeof bytes);
    throw new Error(`the Host's model bytes must be a Uint8Array, not ${got}: `
      + 'the unit hashes the view and transfers its buffer, and needs both to know they are the same bytes');
  }
  if (bytes.byteLength === 0) {
    throw new Error('the Host handed over 0 model bytes: either nothing arrived, or this is an array kept from an '
      + 'earlier load whose buffer the unit has since TRANSFERRED into the inference worker — a Host must return a '
      + 'fresh buffer per call and must not hold on to one');
  }
  if (bytes.byteOffset !== 0 || bytes.byteLength !== bytes.buffer.byteLength) {
    throw new Error(`the Host's model bytes must own their whole buffer: got ${bytes.byteLength} bytes at offset `
      + `${bytes.byteOffset} of a ${bytes.buffer.byteLength} byte buffer — the unit verifies the view and transfers `
      + 'the buffer, so a Host that hands over a slice loads bytes nothing checked');
  }
}

/**
 * A FRESH ArrayBuffer of VERIFIED weights, out of whatever the Host keeps them
 * in.
 *
 * WHAT THE HOST OWES, AND WHAT IT DOES NOT. `host.modelBytes(onProgress)` is a
 * byte source and nothing more — it may serve from a cache, from the network or
 * from a file next to the binary, and it is never asked whether the bytes are
 * good. `host.clearModel()` throws away whatever it kept. The two rules that
 * follow from that live HERE rather than in any Host:
 *
 *   1. BYTES THAT FAIL THE CHECK ARE NEVER LEFT WHERE THE NEXT LOAD FINDS THEM.
 *      A streaming Host stores what it fetched before this function has seen a
 *      byte of it — it has to, that is what streaming is — so a corrupt download
 *      would otherwise be served back for ever, failing identically every time,
 *      with no way out but clearing browser storage by hand.
 *   2. A BAD STORED COPY COSTS ONE RE-DOWNLOAD, NOT A DEAD DECK. If the Host
 *      said the bytes came from its own store, that store is dropped and the
 *      Host is asked once more — which can no longer hit it, so it is a real
 *      fetch. If the bytes that just failed came off the wire, asking again
 *      would spend another 109 MB to fail the same way, so it throws.
 *
 * Two calls to `modelBytes` in the worst case and never three, which is a COUNT
 * the check on this function asserts rather than a timeout it waits out.
 *
 * A CLEAR THAT FAILS DOES NOT REPLACE THE REASON IT WAS CLEARING. For a second
 * Host a clear that can fail is ordinary — a locked file, an IPC round trip, a
 * read-only bundle — and letting its rejection out would lose both the retry and
 * the integrity error that caused it, turning a recoverable corrupt copy into a
 * dead deck reported under the wrong cause. The ceiling still holds: a clear
 * that did nothing means the next ask hands back the same bytes, which is
 * attempt two, which throws.
 *
 * THE BUFFER MUST BE FRESH PER CALL, AND THAT IS THE HOST'S OBLIGATION rather
 * than a fact about this one: `LOAD_MODEL` TRANSFERS it into the inference
 * worker (`offscreen/deck.js`), which detaches it, and two decks each ask. A
 * Host that memoized its bytes — the obvious optimisation once they arrive over
 * IPC or off a vendored file — would hand back a detached array on the second
 * load. `requireWholeBuffer` above is what says so, in those words.
 *
 * WHERE THE BYTES CAME FROM IS TAKEN OFF THE PHASE, NOT INFERRED FROM
 * `fromCache` (#28). The Host announces its phase before any bytes move, and
 * that announcement is the only three-valued thing on this path: `cache`,
 * `download`, or `bundled` for a Host that ships the weights beside its binary.
 * `fromCache` stays what it always was — the retry decision — and is not asked
 * to double as the provenance, which is how the engine came to say "downloaded"
 * about a file no request ever touched. See `MODEL_SOURCES` in `./host.js`.
 *
 * IT IS THE SUCCESSFUL ATTEMPT'S SOURCE, so `source` is reset per pass: a heal
 * is a bad `cache` followed by a good `download`, and reporting the first would
 * word the log line about bytes that were thrown away.
 *
 * @param {{modelBytes: Function, clearModel: Function}} host the EngineHost
 * @param {(phase:'cache'|'download'|'bundled'|'verify', got:number, total:number)=>void} onProgress
 * @param {{sha256: string, bytes: number}} pin  see `verifyModel`
 * @returns {Promise<{buffer: ArrayBuffer, fromCache: boolean, source: string|null, ms: number}>}
 */
export async function loadModel(host, onProgress = () => {}, pin = MODEL) {
  const t0 = performance.now();
  let source = null;
  // TWO ATTEMPTS AT MOST, and that ceiling is structural rather than a comment:
  // the loop cannot reach a third pass, so a Host that keeps handing over the
  // same corrupt bytes fails rather than downloading them for ever.
  for (let attempt = 1; ; attempt++) {
    source = null;
    // The Host's progress passes through unchanged; the only thing added is the
    // ONE READ that records which source it announced. Filtered to the declared
    // vocabulary so that `'verify'` — which this function announces itself, a
    // few lines down — can never be mistaken for a provenance.
    const got = await host.modelBytes((phase, ...rest) => {
      if (Object.prototype.hasOwnProperty.call(MODEL_SOURCES, phase)) source = phase;
      onProgress(phase, ...rest);
    });
    requireWholeBuffer(got.bytes);
    // `got.bytes.length` and not the pin's: a short buffer reports the length it
    // actually has on its way to failing, rather than one it never had.
    onProgress('verify', got.bytes.length, got.bytes.length);
    try {
      await verifyModel(got.bytes, pin);
      return { buffer: got.bytes.buffer, fromCache: got.fromCache, source, ms: performance.now() - t0 };
    } catch (bad) {
      // A clear that itself fails must not become the error the user is shown:
      // `bad` is why we are here, and the ceiling copes with a clear that did
      // nothing.
      try { await host.clearModel(); } catch { /* swallowed on purpose — see above */ }
      if (attempt === 2 || !got.fromCache) throw bad;
    }
  }
}
