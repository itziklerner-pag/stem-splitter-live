/**
 * WHERE THIS HOST GETS THE MODEL BYTES, AND WHERE IT KEEPS THEM.
 *
 * The model pin is split across the Host seam, in one direction only:
 *
 *   the UNIT (`shared/config.js`) says WHAT the bytes must be — SHA-256 and
 *     byte count, checked by `shared/modelcache.js::verifyModel` on every load;
 *   the HOST (this file) says WHERE they come from and where they are kept.
 *
 * That split is the point of S7 rather than a tidy-up. P1 says exactly one
 * network request is ever made, and `fetch` and the Cache API are not `chrome.*`
 * — a gate that greps the unit for `chrome.` sees neither. Moving the URL out of
 * `shared/config.js` is the only edit that actually removes the network path
 * from the unit, and it is what lets a second Host hand over bytes from a
 * vendored file, an IPC channel or a local mirror without the unit changing:
 * the identity check runs over whatever arrives, because the unit never knew
 * where it came from.
 *
 * PINNED BY COMMIT SHA, NOT BY `main`. The 4-stem pin resolved through the
 * mutable `main` ref, so upstream could have moved the bytes under a hash we had
 * already written down — the SHA-256 would have caught it, but as a download
 * failure with no explanation. `resolve/<40-hex>` cannot move. Keep it that way.
 *
 * THE ORIGIN IS ALSO IN THE MANIFEST, and has to be: `host_permissions` and the
 * CSP `connect-src` (`extension/manifest.json:44-48`) name `huggingface.co`
 * because MV3 refuses the fetch otherwise. Those are this Host's declarations
 * about this Host, which is why they live beside it rather than in the unit —
 * but they ARE a second copy of the origin, and moving this URL to another host
 * means editing the manifest in the same commit. `tools/host.mjs` derives its
 * origin from here rather than re-typing it, so the tools cannot drift.
 *
 * SIDE-EFFECT FREE, AND THAT IS A REQUIREMENT RATHER THAN A STYLE. Three things
 * import this file, and only one of them is a browser: `offscreen/host.js`,
 * `tools/host.mjs`, and the node snippet inside `tools/fetch-model.sh`. A
 * `chrome.` reference, a DOM touch or a listener registered at module scope here
 * takes `node tools/verify.mjs` out AT IMPORT — before one step runs — and the
 * failure is a stack trace with no verdict. Constants only.
 */

/** The pinned upstream weights. Data, never script (M1). */
export const MODEL_URL = 'https://huggingface.co/arjune123/demucs-onnx/resolve/0168b73c5fbf38462be79c051b003844a4820e7a/htdemucs_6s.onnx';

/**
 * The Cache API bucket the downloaded weights live in. Host-side because the
 * Cache API is: a Host that is not a browser keeps the bytes somewhere else
 * entirely, and the unit neither knows nor asks.
 *
 * NOT bumped for the 6-stem model, deliberately. `shared/stemcache.js`
 * `pipelineVersion()` already folds `MODEL.sha256.slice(0, 12)` into every cache
 * key, so a new hash invalidates every cached track on its own. A second
 * invalidation mechanism for the same event is one more thing to forget.
 */
export const MODEL_CACHE_NAME = 'model-cache-v1';
