/**
 * First run. One button, one download, and an honest report of what it is doing.
 *
 * The whole page is a thin driver over the same `MODEL_LOAD` the deck sends —
 * the engine, the cache and the SHA-256 check are shared with every other
 * surface. Nothing here knows how a model is fetched.
 */

import { MODEL } from '../shared/config.js';
import { BUS } from '../shared/host.js';
import { fmtBytes } from './audio-math.js';
import { isMac, chordLabel } from './embed-state.js';

const $ = (id) => document.getElementById(id);
const text = (el, v) => { if (el && el.textContent !== v) el.textContent = v; };

/**
 * The setup page shares the deck's address on the bus and reads it, like every
 * other context since Host interface v1 (S11), out of `BUS` in the seam's own
 * declaration rather than out of a literal. It is a second listener on
 * `to: BUS.deck` — the model-download progress it paints comes off the same
 * `STATE` messages the deck reads, which is why `EngineHost.send` is documented
 * as a FAN-OUT and not a point-to-point link.
 */
const toOff = (m) => chrome.runtime.sendMessage({ v: 1, to: BUS.engine, from: BUS.deck, ...m }).catch(() => {});
const toSw = (m) => chrome.runtime.sendMessage({ v: 1, to: BUS.host, from: BUS.deck, ...m }).catch(() => {});

let model = { status: 'unknown', got: 0, total: MODEL.bytes, phase: null, error: null };

/**
 * The phases that carry a byte count, and therefore the only ones a percentage
 * may be quoted for. The Host (`offscreen/host.js`) reports real `got`/`total`
 * for `cache` and `download`; the unit's `shared/modelcache.js` reports
 * `got === total` for `verify` — which is a SHA-256 over 109 MB that has not
 * started, not a download that has finished —
 * and `session`/`warmup` (the ~8 s shader compile) carry no numbers at all.
 * Quoting 100 % through any of those three is the exact shape of a hang.
 */
const COUNTED = new Set(['cache', 'download']);

const PHASE_NOTE = {
  cache:    'reading the copy already on this computer',
  download: 'downloading',
  verify:   'verifying the checksum',
  session:  'preparing the GPU',
  warmup:   'compiling shaders',
};

function paint() {
  text($('size'), fmtBytes(model.total || MODEL.bytes));

  const loading = model.status === 'loading';
  const done = model.status === 'ready' || model.status === 'cached';
  const failed = model.status === 'error';
  const counted = loading && COUNTED.has(model.phase) && model.total > 0;
  const p = done ? 1 : counted ? Math.min(1, model.got / model.total) : 0;

  document.body.dataset.model = done ? 'done' : loading ? 'loading' : failed ? 'error' : 'idle';

  // The block itself is permanent — see the comment on it in welcome.html.
  // Only the track comes and goes: there is no bar to draw before the user has
  // asked for anything, and none to draw for a failure either.
  $('prog').classList.toggle('prog--busy', loading && !counted);

  const bar = $('bar');
  bar.style.setProperty('--p', String(p));
  // An indeterminate progressbar is spelled by the ABSENCE of aria-valuenow.
  // Leaving a stale number there would tell a screen reader a percentage the
  // sighted user is explicitly not being shown.
  if (counted || done) bar.setAttribute('aria-valuenow', String(Math.round(p * 100)));
  else bar.removeAttribute('aria-valuenow');
  bar.hidden = !(loading || done);

  const go = $('go');
  go.disabled = loading || done;
  // "Downloading…" only while bytes are actually moving. The checksum pass and
  // the shader compile are not a download, and a button that says otherwise
  // contradicts the status line directly beneath it.
  text(go, done ? 'Ready'
    : loading ? (model.phase === 'download' ? 'Downloading…' : 'Setting up…')
    : failed ? 'Try again' : 'Download now');

  text($('pct'), counted ? `${Math.round(p * 100)}%` : done ? '100%' : '');

  if (loading) {
    // The byte pair, not just the percent: on a 109 MB fetch "38.2 MB of
    // 109.3 MB" is what tells someone on a slow line whether to wait.
    const label = PHASE_NOTE[model.phase] || 'working';
    text($('note'), counted
      ? `${label} — ${fmtBytes(model.got)} of ${fmtBytes(model.total)}`
      : label);
  } else if (done) {
    text($('note'), 'Done — nothing else to set up. You can close this tab.');
  } else if (failed) {
    text($('note'), model.error || 'The download failed. Check the connection and try again.');
  } else {
    text($('note'), '');
  }
}

chrome.runtime.onMessage.addListener((m) => {
  if (!m || m.to !== BUS.deck || m.type !== 'STATE') return false;
  if (m.state && m.state.model) { model = { ...model, ...m.state.model }; paint(); }
  return false;
});

$('go').addEventListener('click', () => {
  // MODEL_LOAD builds the ORT session as well as fetching the weights, so this
  // one message covers the whole one-time cost. Doing it here means the first
  // press of play on a video is not also an 8 s shader compile.
  toOff({ type: 'MODEL_LOAD' });
  model.status = 'loading';
  model.phase = null;
  model.got = 0;
  paint();
});

/**
 * The arm shortcut, read from Chrome rather than typed into the markup — the
 * user can rebind it at chrome://extensions/shortcuts, and a page that states a
 * chord the browser is not bound to is worse than one that omits it.
 *
 * WHAT IS DRAWN WAS ALREADY RIGHT ON A MAC, and that is worth stating because
 * the deck's overlay next door was not. Chrome returns this one ALREADY DRAWN
 * as `⌃⇧9` on macOS — not as the `MacCtrl+Shift+9` token the manifest declares
 * — which tools/embed-smoke.mjs now reads out of the real extension and prints.
 * `chordLabel()` passes that through and normalises the token form Chrome uses
 * on the other platforms, so neither can reach the page as a manifest keyword.
 *
 * WHAT WAS NOT RIGHT IS THE ANNOUNCED FORM. `⌃⇧9` read character by character
 * is not an instruction, and `aria-label` on a bare `<span>` names nothing —
 * hence `role="img"`, exactly as the deck's key caps do it. Off a Mac the
 * string is words already and both attributes stay off.
 */
(async () => {
  let all = [];
  try { all = await chrome.commands.getAll(); } catch (e) { /* no chrome.commands */ }
  const cmd = all.find((c) => c.name === 'arm-tab');
  const el = $('chord');
  const chord = chordLabel(cmd && cmd.shortcut, isMac());
  text(el, chord ? chord.text : 'set one at chrome://extensions/shortcuts');
  if (chord && chord.say !== chord.text) {
    el.setAttribute('role', 'img');
    el.setAttribute('aria-label', chord.say);
  } else {
    el.removeAttribute('role');
    el.removeAttribute('aria-label');
  }
})();

// The offscreen document may not exist yet on a fresh install; only the service
// worker can create it, and STATUS is what makes it report whether the weights
// are already on disk.
toSw({ type: 'SW_ENSURE_OFFSCREEN' });
toOff({ type: 'STATUS' });
let tries = 0;
const boot = setInterval(() => {
  if (model.status !== 'unknown' || ++tries > 20) return clearInterval(boot);
  toSw({ type: 'SW_ENSURE_OFFSCREEN' });
  toOff({ type: 'STATUS' });
}, 400);
paint();

// Exposed for the automated harness only (tools/embed-smoke.mjs).
globalThis.__welcome = { get model() { return model; } };
