/**
 * A throwaway TLS file host that answers AS `huggingface.co`, routed by path.
 *
 * `qa/seed-host.mjs` does the same trick for exactly one file (the weights) and
 * answers every path with it. The dual-deck probe needs THREE large files — the
 * weights plus a different audio fixture per deck — and it needs them to arrive
 * as bytes rather than as a 60 MB base64 string through `page.evaluate`, which
 * is what every earlier probe did and what makes them slow to start.
 *
 * Why it has to pretend to be huggingface.co: the manifest's
 * `connect-src 'self' blob: https://huggingface.co https://*.hf.co` correctly
 * refuses `http://127.0.0.1:<port>`, and refusing it is the
 * point of the directive. Playwright's `route.fulfill()` cannot carry a 172 MiB
 * body — the CDP channel dies — so we stand up real TLS and point Chromium's
 * host resolver at it.
 *
 *   const host = await startHost({ '/weights.onnx': '/path/to/model.onnx',
 *                                  '/fx/a.wav':     '/path/to/a.wav' });
 *   chromium.launchPersistentContext(dir, { args: [...host.chromiumArgs] });
 *   // in the page: fetch('https://huggingface.co/fx/a.wav')
 *   host.close();
 */
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { MODEL } from '../extension/shared/config.js';
import { MODEL_URL as PINNED_URL } from '../extension/offscreen/host-pin.js';

/**
 * THE MODEL PIN, DERIVED — never re-typed, and now derived from BOTH HALVES.
 *
 * Every probe in tools/ and qa/ needs three things about the weights: the URL to
 * intercept, the path to route on, and how many bytes to expect. Each of them
 * used to carry its own copy of the 4-stem literal, so the 6-stem re-pin
 * (`htdemucs_embedded.onnx` -> `htdemucs_6s.onnx`, 180,534,758 -> 114,559,139 B)
 * broke ELEVEN files at once and each in the same two ways: the intercept missed,
 * so the extension tried to reach the real Hugging Face, and the byte assertion
 * compared against a number no file on disk has.
 *
 * S7 SPLIT THAT SOURCE IN TWO, and this file follows the split rather than
 * papering over it: the identity (SHA-256, byte count) comes from the unit's
 * `extension/shared/config.js`, and the URL from the extension host's
 * `extension/offscreen/host-pin.js`, because a Host is what decides where bytes
 * come from. Both are still single sources of truth. A second literal is how the
 * eleven-file breakage happens again, so there is not one here either — INCLUDING
 * the origin, which used to be typed out separately on the line below and is now
 * read off the URL it has to match. A host-side re-pin to a different origin now
 * moves the resolver rule and the certificate's CN with it, instead of quietly
 * routing the real host's name at a server holding the new host's file.
 */
export const MODEL_URL = PINNED_URL;
/** The origin the extension's CSP `connect-src` authorises, and this host impersonates. */
export const MODEL_HOST = new URL(MODEL_URL).hostname;
/** The path component — what `startHost()` routes on. */
export const MODEL_ROUTE = new URL(MODEL_URL).pathname;
export const MODEL_BYTES = MODEL.bytes;

/**
 * Where the local copy lives, relative to the repo root. Not committed —
 * `.gitignore` excludes `*.onnx`, so the repo carries the pin and never the
 * 114 MB. `bash tools/fetch-model.sh` puts it here.
 *
 * NOT derived from the URL basename, deliberately: upstream names are not
 * unique enough to tell two exports apart, and `tools/model-parity.mjs` pins
 * this same path. It is checked by SIZE at every call site that seeds from it,
 * so pointing this at the wrong export is a red, not a mystery.
 */
export const MODEL_SEED_REL = 'models/htdemucs_6s.onnx';
/** @param {string} root repo root */
export const modelSeed = (root) => path.join(root, MODEL_SEED_REL);


/**
 * Refuse to start on the wrong weights, and say which weights they are.
 *
 * The 4-stem `htdemucs_embedded.onnx` is still on every machine that ever ran
 * this suite, and pointing a probe at it does not fail where the mistake was
 * made: the extension downloads nothing, hash-verifies, and reports an
 * unexplained SHA-256 mismatch about forty seconds and one browser launch
 * later. Size is the one property that separates them without hashing 114 MB,
 * and it separates them by 66 MB.
 *
 * Exits 2 rather than throwing so the message is the last line on the terminal.
 * @param {string} file @returns {string} the resolved absolute path
 */
export function requireModelSeed(file) {
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) {
    console.error(`\nno model weights at ${abs}\n  -> curl -L -o ${MODEL_SEED_REL} '${MODEL_URL}'\n`);
    process.exit(2);
  }
  const got = fs.statSync(abs).size;
  if (got !== MODEL_BYTES) {
    console.error(`\n${abs} is ${got} bytes; shared/config.js pins MODEL.bytes = ${MODEL_BYTES}.\n`
      + `  That is not the model this branch ships — most likely the 4-stem htdemucs_embedded.onnx.\n`
      + `  -> curl -L -o ${MODEL_SEED_REL} '${MODEL_URL}'\n`);
    process.exit(2);
  }
  return abs;
}

/** @param {Record<string,string>} routes URL path -> absolute file path */
export async function startHost(routes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cert-'));
  const key = path.join(dir, 'k.pem'), cert = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert, '-days', '1', '-subj', `/CN=${MODEL_HOST}`], { stdio: 'ignore' });

  const files = {};
  for (const [route, file] of Object.entries(routes)) {
    const abs = path.resolve(file);
    files[route] = { file: abs, size: fs.statSync(abs).size };
  }

  const hits = {};
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const u = new URL(req.url, 'https://x');
    const hit = files[u.pathname];
    if (!hit) { res.writeHead(404).end('no route'); return; }
    hits[u.pathname] = (hits[u.pathname] || 0) + 1;
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(hit.size),
      'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(hit.file).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    port,
    hits,
    url: (route) => `https://${MODEL_HOST}${route}`,
    chromiumArgs: [
      `--host-resolver-rules=MAP ${MODEL_HOST} 127.0.0.1:${port}`,
      '--ignore-certificate-errors',
    ],
    close() { server.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}
