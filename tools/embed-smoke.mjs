#!/usr/bin/env node
/**
 * The embedded build's entry point, driven as itself.
 *
 *     node tools/build-embed.mjs && node tools/embed-smoke.mjs      (~15 s)
 *
 * WHY THIS EXISTS RATHER THAN A NOTE IN THE README. The gesture this build is
 * about — click the icon, the deck appears in the page — crosses four contexts
 * (invocation, service worker, content script, iframe) and NONE of the existing
 * gates touch three of them. `tools/run-ext.mjs` drives extension pages in their
 * own windows; it would stay 100 % green with the injection completely broken.
 * That is `AGENTS.md`'s entry-point rule, and this build is a new entry
 * point, so it gets its own gate on the day it ships rather than after the
 * first silent failure.
 *
 * THE YOUTUBE PAGE IS SERVED LOCALLY, for two reasons and both are rules: P1
 * forbids the network, and a test that depends on YouTube's markup fails on
 * YouTube's schedule rather than on ours. The fixture reproduces only the three
 * ids `content.js` anchors to — if YouTube moves them, that is a REAL failure
 * this test cannot see, and the ponytail note in content.js names it.
 *
 * The route is scoped to youtube.com deliberately: a `**\/*` route also
 * intercepts the frame's own `chrome-extension://` module loads and serves them
 * as text/html, which silently blanks the deck. Cost: one run.
 */

import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/**
 * The SOURCE TREE, loaded unpacked. There is no build step: `extension/` is the
 * extension. (It used to be `out/extension-embed`, laid down by an overlay build
 * that existed only to share one engine between this build and a two-deck
 * console. With the console gone the overlay had one consumer and no reason to
 * exist, so the tree it produced is now the tree in git.)
 */
const EXT = path.join(ROOT, 'extension');
if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error(`embed-smoke: no manifest at ${EXT}`);
  process.exit(1);
}
if (!fs.existsSync(path.join(EXT, 'vendor', 'ort'))) {
  console.error('embed-smoke: extension/vendor/ort is missing — run `bash tools/fetch-vendor.sh` first');
  process.exit(1);
}

let fails = 0, checks = 0;
/**
 * THE ASSERTION NAME STOPS AT TWO SPACES. `assertionNames()` in
 * `tools/verify.mjs` splits each printed line on the first double space and
 * keeps the left half as the name, which is what `coverageDrift()` diffs run to
 * run. So a measured value — a tab id, an elapsed millisecond count, a pixel
 * height — goes AFTER two spaces or the name churns on every run, and the first
 * change that also moves the assertion COUNT gets those churning names reported
 * as gone/added beside its real one. Three assertions in this file carried a
 * measured value in the name until S4 moved them.
 */
const ok = (c, what) => { checks++; console.log(`${c ? 'ok  ' : 'FAIL'} ${what}`); if (!c) fails++; };

/**
 * A REAL `<video>`, because the thing under test is `paused` and event
 * plumbing, and a stub that never actually plays would prove neither. 8 kHz
 * silence, inline: no fixture file, no network, and `play()` on a muted element
 * is allowed without a user gesture.
 *
 * SIXTY SECONDS, AND THE LENGTH IS LOAD-BEARING — do not trim it back.
 *
 * This was half a second on a `loop`ing element. Every wrap fires `seeking`,
 * `content.js` reports `seeking` as a content JUMP (`JUMP_EVENTS`), and the
 * deck restarts its pipeline on a jump exactly as it does when a user scrubs.
 * So the fixture injected a seek into EVERY assertion whose window was longer
 * than half a second — events no assertion in this file is about. It cost one
 * of them outright: the `data-pending` latency pair below was red on this box
 * because a wrap restarted the deck mid-window, a real capture attached, and
 * the engine's own 10 Hz LIVE_STATE overwrote the injected `latencySec: 1.5`
 * with 0 before the press could be measured.
 *
 * Sixty seconds is longer than the whole suite takes to run (~25 s), so no
 * window can reach the end of the clip. The element does NOT loop either, and
 * that is the belt to this brace: a clip that somehow does run out pauses the
 * video, which is a red on the very next `deckSees()`, rather than silently
 * going on generating seeks. The one assertion that needs a jump drives it
 * itself by writing `currentTime`, and so does the one that needs a jump NOT to
 * start anything.
 */
function silentWavDataUri(seconds = 60, rate = 8000) {
  const n = Math.round(seconds * rate);
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  return `data:audio/wav;base64,${buf.toString('base64')}`;
}

/**
 * THE FIXTURE, and every element in it is here because a specific claim needs it.
 *
 * IT IS ALSO THE PART OF THIS FILE THAT HAS FAILED US TWICE, so read the two
 * cases before trimming anything out of it. Both were bugs reported from
 * a real watch page while this suite was 87/87 green, and both were invisible
 * here for the same reason: this fixture reproduced a page YouTube had stopped
 * shipping.
 *
 *   1. THE DECK WAS INVISIBLE. YouTube's ambient mode paints the video's glow
 *      over 327 px of it, and this fixture had no ambient mode — reproduced
 *      below, to the measured geometry.
 *   2. AUTOPLAY SUPPRESSION DID NOTHING. The control moved from a <button> to a
 *      <div> inside one, and this fixture reproduced the <button> — so the
 *      suppression assertions passed against markup that no longer exists.
 *
 * The rule that comes out of both: **an element reproduced here is a claim about
 * what YouTube ships today, and it goes stale silently.** When one of these is
 * re-checked against the real site, say so with a date.
 *
 *  - `#primary-inner`, `#player`, `#below` — the three anchors `content.js`
 *    inserts against. If YouTube moves them that is a real failure this test
 *    cannot see, and the ponytail note in content.js names it.
 *  - a REAL `<video>`, because the thing under test is `paused` and event
 *    plumbing, and a stub that never plays would prove neither. It is sixty
 *    seconds long and it does NOT loop, and both of those are load-bearing —
 *    see `silentWavDataUri` for the assertion a looping half-second cost.
 *  - **YouTube's ambient-mode glow**, `#cinematics` — a `position: absolute`,
 *    `pointer-events: none` box inside the `position: relative` `#player`,
 *    INFLATED past the player on every side so a blur has room. Measured on a
 *    real dark-theme watch page 2026-08-15 at 1728x1000: the player was 678 px
 *    tall, its glow box was `-842..514 x -285..1522` — i.e. 339 px below the
 *    player and 301 px past each side. The deck mounts 12 px below the player,
 *    so 327 px of it are inside that box, which is its header and its whole
 *    rack. Being POSITIONED, it paints above our static iframe (CSS 2.1 App. E:
 *    in-flow non-positioned boxes at step 4, positioned `z-index: auto`
 *    descendants at step 8); being `pointer-events: none`, it is invisible to
 *    `elementFromPoint`, to `boundingBox()` and to every computed style this
 *    file reads. Only pixels see it, which is why `paintedPixels()` exists.
 *  - **YouTube's autoplay control**, reproduced with the nesting it actually has
 *    (checked against youtube.com 2026-08-15, `ytp-delhi-modern` control bar):
 *    `button.ytp-autonav-toggle` wrapping `div.ytp-autonav-toggle-button-
 *    container` wrapping `div.ytp-autonav-toggle-button[aria-checked]`. The
 *    STATE is on the inner div and the HANDLER is on the button, and a click on
 *    the div reaches it by bubbling — all three facts are load-bearing, because
 *    the selector that shipped required the class to be on a <button> and so
 *    matched nothing on any real video. Without this control the suppression
 *    path cannot be driven at all — the deck would sit in `looking` for six
 *    seconds and then report `missing`, which is the FAILURE branch, so every
 *    green would have been a green on the path nobody ships.
 *  - `window.__keys`, a stand-in for YouTube's own 1-9 seek-to-percentage
 *    handler, on `document` in the BUBBLE phase — where a page's handler sits,
 *    and therefore the thing `stopPropagation()` from our capture-phase listener
 *    has to beat. It is the only witness that a key we did NOT take still
 *    reaches the page, and the only witness that a key we did take does not.
 *  - a dark theme, a 16:9 player and a real two-column width, because the deck
 *    is a guest in that layout and every geometry number in this file is only
 *    worth what the box around it is worth.
 */
const PAGE = `<html dark><head><meta charset="utf-8"><style>
  html { background: #0f0f0f; color: #f1f1f1; font: 14px Roboto, Arial, sans-serif; }
  body { margin: 0; }
  #columns { display: flex; gap: 24px; padding: 24px 24px 0; }
  #primary { flex: 1; min-width: 0; max-width: 1280px; }
  #secondary { width: 402px; flex: none; }
  /* #player is POSITIONED on the real page, which is what lets anything inside
     it paint over what comes after it. */
  #player { position: relative; }
  #player-container-inner { position: relative; width: 100%; padding-top: 56.25%; background: #000; }
  #movie_player { position: absolute; inset: 0; }
  video { width: 100%; height: 100%; background: #101010; }
  /* THE AMBIENT GLOW. Geometry from the real page (see the note above); the
     paint is a flat wash rather than a blurred video frame because what is
     under test is the PAINT ORDER, not the picture. It fades out over its last
     sixth exactly as the real one's mask does — which is why the
     screenshots showed a deck cut in half rather than a deck gone. */
  #cinematics {
    position: absolute; top: -339px; bottom: -339px; left: -301px; right: -301px;
    pointer-events: none; overflow: hidden;
  }
  #cinematics canvas {
    position: absolute; inset: 0; width: 100%; height: 100%;
    background: linear-gradient(to bottom, #0f0f0f 0 84%, rgba(15,15,15,0) 100%);
  }
  .ytp-right-controls { position: absolute; right: 12px; bottom: 8px; z-index: 2; }
  #below { position: relative; }
</style></head><body><div id="columns"><div id="primary"><div id="primary-inner">
  <div id="player">
    <div id="player-container-inner"><div id="movie_player">
      <video id="v" muted playsinline src="${silentWavDataUri()}"></video>
      <div class="ytp-right-controls">
        <div class="ytp-right-controls-left">
          <button class="ytp-button ytp-autonav-toggle" aria-label="Autoplay is on">
            <div class="ytp-autonav-toggle-button-container">
              <div class="ytp-autonav-toggle-button" aria-checked="true"></div>
            </div>
          </button>
        </div>
      </div>
    </div></div>
    <div id="cinematics"><canvas></canvas></div>
  </div>
  <div id="below">TITLE AND DESCRIPTION<input id="typehere" type="text"></div>
</div></div><div id="secondary">UP NEXT</div></div>
<script>
  // The handler is on the BUTTON and the state is on the inner DIV, as on the
  // real control — so a click on either lands on the same toggle.
  const t = document.querySelector('.ytp-autonav-toggle-button');
  document.querySelector('button.ytp-autonav-toggle').addEventListener('click', () => {
    t.setAttribute('aria-checked', t.getAttribute('aria-checked') === 'true' ? 'false' : 'true');
  });
  window.__keys = [];
  document.addEventListener('keydown', (e) => { window.__keys.push(e.code); });
</script>
</body></html>`;

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'embed-smoke-'));
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  args: [
    `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    '--enable-unsafe-extension-debugging', '--window-position=4000,4000',
  ],
});
try {
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  ok(!!sw, 'the service worker booted in the embedded build');

  // ------------------------------------------------------------- first run
  /**
   * INSTALL OPENS THE ONBOARDING TAB. Asserted here rather than left to a
   * manual check, because it is the only surface that exists before the user
   * has done anything, and because it BROKE THIS TEST the first time it ran:
   * the new tab took focus, so the arm chord below reached the welcome page
   * instead of the video and armed nothing. That is not a test artefact — it is
   * what a real user gets if they press the shortcut while this tab is up, and
   * the answer (TAB_UNSUPPORTED, "Chrome pages cannot be captured") is correct.
   */
  const welcome = ctx.pages().find((p) => p.url().endsWith('ui/welcome.html'))
    || await ctx.waitForEvent('page', { timeout: 8000 }).catch(() => null);
  ok(!!welcome && welcome.url().endsWith('ui/welcome.html'),
    'installing opened the one-time setup page — the download is offered before it is needed');
  if (welcome) {
    await welcome.waitForLoadState('domcontentloaded').catch(() => {});
    const size = await welcome.locator('#size').textContent().catch(() => '');
    ok(/MB/.test(size), `...naming the size up front (${size.trim()})`);
    ok(await welcome.locator('#go').isEnabled(),
      '...with a button that asks rather than a download already in flight');
    /**
     * `typeof st === 'string'` because the `.catch` makes `st` null on any
     * failure to read, and `null !== 'loading'` PASSES — the assertion would
     * report "nothing is downloading" on precisely the runs where it could not
     * see whether anything was. The two lines above are the independent evidence
     * that the instrument exists: `#size` is painted by welcome.js's `paint()`,
     * so a run that got here has already run the module that defines
     * `__welcome`.
     */
    const st = await welcome.evaluate(() => globalThis.__welcome.model.status).catch(() => null);
    ok(typeof st === 'string' && st !== 'loading', `...and nothing fetched yet (model ${st})`);
    /**
     * STEP 2 NAMES A KEY THAT EXISTS, AND SAYS IT OUT LOUD.
     *
     * The chord is read from `chrome.commands.getAll()` rather than typed into
     * the markup. THE RAW STRING IS PRINTED HERE ON PURPOSE: it is the only
     * place in this repo that records what Chrome actually returns, and it
     * settled the question — on macOS it comes back already drawn as `⌃⇧9`,
     * NOT as the `MacCtrl+Shift+9` token the manifest declares. The first
     * version of the fix next door was written the other way round.
     *
     * TWO ASSERTIONS BECAUSE THERE ARE TWO CHANNELS. What is drawn was already
     * right here (unlike the deck's overlay); what is ANNOUNCED was not — a
     * screen reader given `⌃⇧9` and no accessible name reads out three
     * characters. Each half is checked against a real string with the chord's
     * presence as the floor, so neither can pass on an empty page.
     */
    const rawChord = await welcome.evaluate(async () => {
      const all = await chrome.commands.getAll().catch(() => []);
      const c = all.find((x) => x.name === 'arm-tab');
      return (c && c.shortcut) || '';
    }).catch(() => '');
    const chordEl = welcome.locator('#chord');
    const shownChord = (await chordEl.textContent().catch(() => '') || '').trim();
    const saidChord = await chordEl.evaluate((el) => el.getAttribute('aria-label') || '').catch(() => '');
    ok(/9$/.test(shownChord) && !/MacCtrl|Command|^set one/.test(shownChord),
      `...and step 2 names a key the user has: Chrome returns "${rawChord}" for arm-tab and the page shows "${shownChord}" — a manifest token on the page is a chord nobody can press`);
    ok(/^[A-Za-z]/.test(shownChord) ? saidChord === '' : /^[A-Za-z]+( [A-Za-z0-9]+)+$/.test(saidChord),
      `...and the chord is ANNOUNCED in words when it is DRAWN in glyphs (shown "${shownChord}", announced "${saidChord || '(nothing — the text is already words)'}") — "⌃⇧9" read out character by character is not an instruction`);
    await welcome.close();
  }

  const page = await ctx.newPage();
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(m.text()); });
  await page.route('https://www.youtube.com/**', (r) => r.fulfill({
    status: 200, contentType: 'text/html', body: PAGE,
  }));
  await page.goto('https://www.youtube.com/watch?v=smoke');
  await page.waitForTimeout(500);

  ok(await page.locator('#stem-splitter-live-deck').count() === 0,
    'nothing is injected until the user asks — a content script on every video page must stay invisible');

  /**
   * The arm chord, dispatched through CDP. It is the same entry point the
   * toolbar click reaches (`chrome.commands` and `chrome.action` both mint the
   * per-tab grant), and it is the only one reachable without a mouse on browser
   * chrome, which macOS refuses.
   */
  const cdp = await ctx.newCDPSession(page);
  const chord = { modifiers: 2 | 8, windowsVirtualKeyCode: 57, nativeVirtualKeyCode: 57, code: 'Digit9', key: '9' };
  const press = async () => {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...chord });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...chord });
  };

  // The chord goes to the ACTIVE tab, so the test has to be as sure as the user
  // is about which tab that is.
  await page.bringToFront();
  await press();
  await page.waitForSelector('#stem-splitter-live-deck', { timeout: 8000 }).catch(() => {});
  ok(await page.locator('#stem-splitter-live-deck').count() === 1, 'the arm gesture injected the deck into the page');

  const a = await sw.evaluate(async () => (await chrome.storage.session.get('session')).session || {});
  // The tab id goes AFTER two spaces: `assertionNames()` in tools/verify.mjs cuts
  // a name at the first double space, so a per-run value inside the name makes
  // this assertion read as gone-and-added in every drift report that fires.
  ok(!!a.tabId, `...and armed the tab it was pressed in  tabId ${a.tabId}`);
  /**
   * ONE DECK, ASSERTED WHERE A REGRESSION WOULD ACTUALLY SHOW.
   *
   * This used to read `sessionB` out of session storage and assert it was empty.
   * That assertion was true when a second deck existed and the build declined to
   * use it — but deck B is gone, so nothing can write that key and the check
   * could no longer fail. An assertion that passes because the thing it inspects
   * was never written is worse than no assertion (AGENTS.md).
   *
   * The two facts below CAN fail, and they are the two that would break first if
   * a second deck came back: the manifest's chord list and the set of session
   * keys the worker actually writes.
   */
  const cmds = await sw.evaluate(() => Object.keys(chrome.runtime.getManifest().commands || {}).sort());
  ok(cmds.join(',') === 'arm-tab',
    `the manifest declares exactly one arm chord (got [${cmds.join(', ')}]) — a second one is a second deck`);
  const keys = await sw.evaluate(async () => Object.keys(await chrome.storage.session.get(null)).sort());
  ok(!keys.includes('sessionB'),
    `the armed worker writes no deck-B session (session keys after arming: [${keys.join(', ')}])`);

  ok(await page.evaluate(() => [...document.querySelector('#primary-inner').children]
    .map((e) => e.id).join(',')) === 'player,stem-splitter-live-deck,below',
  'it lands between the player and the title, which is the whole placement decision');

  const frame = page.frameLocator('#stem-splitter-live-deck');
  /**
   * WAIT FOR THE BOOT, NOT FOR A NEIGHBOUR OF IT — and this line has now paid
   * for the difference twice over.
   *
   * It used to be `waitFor('#stat-chip').catch(() => {})` followed by a bare
   * `.count()`. Both halves were wrong and they hid each other:
   *
   *   - `#stat-chip` is in embed.html's STATIC markup, so it resolves the
   *     instant the document parses. The six `.strip`s are built by
   *     `buildStrips()` in embed.js — a MODULE, so it runs after parse. Waiting
   *     for the chip therefore establishes nothing at all about the strips; the
   *     only reason the count ever passed is that the four `sw.evaluate()` round
   *     trips above it happened to cost more than embed.js's boot.
   *   - `.count()` does not auto-wait. It reports whatever is there at the
   *     instant it is asked, so the assertion named a count from a moment it had
   *     never established. That is `!x || (real check)` one level over: the
   *     precondition was optional, so the reading was a race.
   *   - and the `.catch(() => {})` meant a deck that never booted at all would
   *     have gone unreported as a boot failure, arriving instead as a confusing
   *     count of 0.
   *
   * So: poll for the deck's OWN boot marker. `globalThis.__embed` is assigned at
   * the foot of embed.js, after `buildStrips()` — so `__embed` present is proof
   * the strips have been built, and the count below is then a plain reading
   * rather than a sample. Two assertions, because they fail for different
   * reasons and a red should say which: the deck did not boot, or it booted
   * wrong.
   *
   * `BOOT_BUDGET_MS` IS THIS POLL'S TIMEOUT AND NOT A SPEED CLAIM, and the
   * distinction is written down because the first draft of this line got it
   * wrong. It printed "9040 ms of 8000" and reported `ok` — the detail read like
   * a gate the condition did not encode, which is the latencySec family exactly.
   * The condition is `deckBooted`, full stop: a deck that never boots leaves
   * `__embed` undefined, the loop gives up at the cap and the assertion goes red
   * with `NOT BOOTED`. A deck that boots SLOWLY is not a failure of this claim
   * and must not turn it red on a loaded machine (AGENTS.md: a claim that can be
   * carried by a state does not get carried by a stopwatch). The elapsed time is
   * printed as an OBSERVATION so the cap cannot quietly stop being generous.
   */
  const bootT0 = Date.now();
  const BOOT_BUDGET_MS = 8000;
  let deckBooted = false, bootMs = 0;
  for (;;) {
    deckBooted = await frame.locator('body')
      .evaluate(() => !!globalThis.__embed).catch(() => false);
    bootMs = Date.now() - bootT0;
    if (deckBooted || bootMs > BOOT_BUDGET_MS) break;
    await page.waitForTimeout(16);
  }
  ok(deckBooted,
    'the deck page\'s module finished booting inside the frame — every assertion below reads state this module defines'
    + `  ${deckBooted ? `__embed present after ${bootMs} ms` : `NOT BOOTED — no __embed after ${bootMs} ms, gave up at the ${BOOT_BUDGET_MS} ms cap`}`);
  const nStrips = await frame.locator('.strip').count();
  ok(deckBooted && nStrips === 6,
    `...and built six stem strips (${nStrips}) — read after the marker above, so a wrong count here is the RACK and never the clock`);

  /**
   * THE MIXER IS VERTICAL, asserted as GEOMETRY rather than as a class name.
   * The thing that was wrong before the relayout was native `<input
   * type=range>` sliders lying on their side, and every selector in this file
   * would have matched them just as well — only the box tells the two apart.
   */
  ok(await frame.locator('[role=slider]').count() === 7,
    '...six stem faders and a master, all one widget — seven sliders, no eighth control grown back');
  const fbox = await frame.locator('.strip[data-stem="vocals"] .fader').boundingBox();
  ok(!!fbox && fbox.height >= fbox.width * 2,
    `...and the fader TRAVELS VERTICALLY (${fbox ? `${Math.round(fbox.width)}x${Math.round(fbox.height)}` : 'no box'} px) — a horizontal range slider passes every selector here and is the thing this replaced`);

  /**
   * ONE LINE, LEFT TO RIGHT, ACROSS ALL SIX — and with six strips this is a
   * sweep rather than a pair.
   *
   * The old form compared `vocals` against `drums` only. That is the pair a
   * WRAP would keep intact: three-per-row puts `other` at the start of row two,
   * under `vocals`, and the two-strip check passes on it. The claim the rack
   * actually makes is that every strip is right of the one before it on the
   * same baseline, which is what makes the digits 1-4 a fixed left-to-right map
   * and what makes guitar and piano — which have NO digit — findable by
   * position at all. So: read all six boxes and require the whole run.
   *
   * `boxes.length === 6 &&` is the "must fail when it cannot look" half: a
   * missing strip gives `null` from `boundingBox()`, and `[].every()` and a
   * short `every()` are both `true`.
   */
  const ORDER = ['vocals', 'drums', 'bass', 'other', 'guitar', 'piano'];
  const boxes = [];
  for (const st of ORDER) boxes.push(await frame.locator(`.strip[data-stem="${st}"]`).boundingBox());
  const laidOut = boxes.length === ORDER.length && boxes.every((b) => !!b)
    && boxes.every((b, i) => i === 0 || (b.x > boxes[i - 1].x && Math.abs(b.y - boxes[0].y) <= 1));
  ok(laidOut,
    `...and all six strips sit side by side on ONE line, in display order (${boxes.map((b, i) => `${ORDER[i]} ${b ? Math.round(b.x) : 'MISSING'}`).join(', ')}) — a wrap would put "other" under "vocals" and the 1-4 map would stop being left-to-right`);
  /**
   * ...AND THE BAND IS INSIDE THE VIDEO'S COLUMN. `body` is `overflow: hidden`,
   * so six strips that do not fit are not a scrollbar — they are the master
   * fader silently cut off the right edge, which is invisible to every other
   * assertion in this file. Measured against the frame's own client width.
   */
  const fit = await frame.locator('.rack').evaluate((r) => ({
    right: Math.ceil(r.getBoundingClientRect().right),
    scroll: r.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  ok(fit.client > 0 && fit.right <= fit.client && fit.scroll <= Math.ceil(fit.right) + 1,
    `...and the whole rack fits inside the frame (right edge ${fit.right} px of ${fit.client}, content ${fit.scroll}) — overflow here is a cut-off master, not a scrollbar`);

  // ------------------------------------------------- is any of it ON SCREEN
  /**
   * EVERY ASSERTION ABOVE THIS ONE PASSED WHILE THE DECK WAS INVISIBLE.
   *
   * Reported from a real watch page against an 87/87 green build:
   * the four strips and the master were a black rectangle. They were in the DOM,
   * bound, metered and laid out to the pixel — `count() === 4`, `boundingBox()`,
   * `getComputedStyle` and `elementFromPoint` all said the deck was fine, and
   * all of them were RIGHT. YouTube's ambient-mode glow was painting on top of
   * it (see `mount()` in content.js, and `#cinematics` in the fixture above).
   *
   * The thing none of those instruments can do is look at the composited page,
   * so that is what this does: screenshot the HOST PAGE over the rack's box and
   * count the deck's own pixels in it. A cover is opaque; the deck is not.
   *
   * ponytail: ceiling — this proves "something of ours is painting there", not
   * "the right thing is". A wrong-but-bright rack passes. Upgrade path is a
   * reference image per surface (Chromatic/BackstopJS-style), which needs a
   * baseline store and a review step this repo has no home for yet; the failure
   * it would add over this one is a redesign nobody meant, which is a smaller
   * failure than a deck that is not on screen at all.
   */
  /**
   * @param {import('playwright').Locator} loc  a locator INSIDE the deck frame
   * @returns {Promise<{n:number,bright:number,pct:number}|null>} null = could
   *   not sample, which is a FAILURE for every caller and never an excuse.
   */
  const paintedPixels = async (loc) => {
    await page.locator('#stem-splitter-live-deck').scrollIntoViewIfNeeded().catch(() => {});
    const b = await loc.boundingBox().catch(() => null);
    if (!b || b.width < 8 || b.height < 8) return null;
    /**
     * `page.screenshot({clip})`, not `loc.screenshot()`: both composite the host
     * page, but the element form scrolls and crops on Playwright's terms, and an
     * assertion about WHERE something is painted has to own its own coordinates.
     * The clip is in the main frame's viewport space, which is exactly what
     * `boundingBox()` returns through a frameLocator — the fact that cost this
     * file a run once already, under the modal assertion below.
     */
    const shot = await page.screenshot({
      clip: { x: b.x, y: b.y, width: b.width, height: b.height },
    }).catch(() => null);
    if (!shot) return null;
    return page.evaluate(async (b64) => {
      const img = new Image();
      img.src = `data:image/png;base64,${b64}`;
      await img.decode();
      const c = new OffscreenCanvas(img.width, img.height);
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, img.width, img.height).data;
      let bright = 0;
      const n = d.length / 4;
      // 96/255 is above every SURFACE in the deck (the strip card is ~0x1a) and
      // below every piece of TEXT and every fader cap. It counts glyphs, labels,
      // borders and caps — the things a wash removes.
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] >= 96 || d[i + 1] >= 96 || d[i + 2] >= 96) bright++;
      }
      return { n, bright, pct: Math.round((bright / n) * 1000) / 10 };
    }, shot.toString('base64')).catch(() => null);
  };

  /**
   * THE THRESHOLD IS MEASURED, BOTH WAYS, and both numbers belong here because a
   * count with only one of them is a number nobody can re-derive:
   *   healthy deck      6242 lit of 188462 (3.3 %)
   *   glow over the top 1211 lit of 188462 (0.6 %) — the gain readouts along the
   *                     bottom edge survive, exactly as they did in a
   *                     screenshot, so this is NOT a floor of zero.
   * 3000 sits 2.1x under the healthy figure and 2.5x over the broken one.
   */
  const rackPx = await paintedPixels(frame.locator('.rack'));
  ok(!!rackPx && rackPx.bright >= 3000,
    `THE RACK IS ON SCREEN, measured in the host page's own pixels (${rackPx ? `${rackPx.bright} lit of ${rackPx.n}, ${rackPx.pct} %` : 'COULD NOT SAMPLE'}) — every other assertion in this file passed on a build where YouTube's ambient glow painted over all of it`);
  /**
   * THE STRIP HEADER, on its own, because it is the row the cover eats FIRST —
   * the glow box starts above the deck and fades downwards, so the deck dies
   * top-first: in a second screenshot the gain readouts at the bottom of
   * each strip were still legible while the name, the glyph and the `1`-`4` hint
   * above them were gone. An average taken over the whole rack can survive that;
   * this cannot.
   */
  const hdPx = await paintedPixels(frame.locator('.strip[data-stem="vocals"] .strip__hd'));
  ok(!!hdPx && hdPx.pct >= 4,
    `...including the row that goes first — the VOCALS name, glyph and key hint (${hdPx ? `${hdPx.pct} % lit of ${hdPx.n} px` : 'COULD NOT SAMPLE'})`);
  /**
   * THE TWO NEWEST STRIPS, and this is a DESIGN §2.4 acceptance criterion rather
   * than a nicety: every strip carries FOUR identity channels — glyph, name,
   * fixed position and digit — and guitar and piano are the two that only got
   * the fourth on 2026-08-17, when the `Digit5`-`Digit8` carve-out was retired.
   * So the glyph and the name have to actually be there, and the key slot has to
   * carry the digit `shortcut()` honours. A strip printing a digit the handler
   * REFUSES is the failure this pins: the user presses it and watches the video
   * jump instead. `5` and `6` are asserted against `vocals`' `1` in the same
   * line so an empty slot cannot read as agreement.
   */
  const idBits = await frame.locator('.rack').evaluate(() => {
    const read = (stem) => {
      const el = document.querySelector(`.strip[data-stem="${stem}"]`);
      if (!el) return null;
      const use = el.querySelector('.strip__hd .i use');
      return {
        glyph: use ? use.getAttribute('href') : null,
        name: (el.querySelector('.strip__hd .name') || {}).textContent || '',
        key: (el.querySelector('.strip__key') || { textContent: null }).textContent,
      };
    };
    return { guitar: read('guitar'), piano: read('piano'), vocals: read('vocals') };
  });
  ok(!!idBits.guitar && !!idBits.piano && !!idBits.vocals,
    'the guitar, piano and vocals strips are all present to be inspected');
  ok(idBits.guitar.glyph === '#i-guitar' && idBits.guitar.name === 'Guitar'
    && idBits.piano.glyph === '#i-piano' && idBits.piano.name === 'Piano',
  `the two newest strips carry their glyph and spelled-out name (${JSON.stringify(idBits.guitar)} / ${JSON.stringify(idBits.piano)})`);
  ok(idBits.guitar.key === '5' && idBits.piano.key === '6' && idBits.vocals.key === '1',
    `...and each advertises its own digit, the fifth and sixth of six (guitar "${idBits.guitar.key}", piano "${idBits.piano.key}", vocals "${idBits.vocals.key}") — an EMPTY slot here is the retired carve-out coming back, and a 7 would be a key the handler refuses and YouTube honours`);
  /**
   * THERE IS NO TRANSPORT BUTTON, and that is an assertion rather than an
   * omission: the user's own player is the only play control in this build, and
   * a second one reappearing is the regression this line catches.
   */
  ok(await frame.locator('#transport').count() === 0,
    '...and NO play button of its own — YouTube\'s is the only transport');
  ok(await frame.locator('#stat-chip').textContent() === 'Press play',
    '...and an armed deck on a paused video says exactly that');
  ok(!pageErrors.length, `...with no page errors${pageErrors.length ? `: ${pageErrors[0]}` : ''}`);
  /**
   * VISIBILITY, not the `hidden` property. A healthy deck showed a permanently
   * visible EMPTY red banner for its whole life, because `.banner`'s
   * `display: flex` outranks the UA `[hidden] { display: none }` — so the
   * property was set correctly and the box was on screen anyway. Asserting
   * `.hidden === true` would have passed throughout. Reported from a screenshot.
   */
  /**
   * `count() === 1 &&` because `isVisible()` is `false` for an element that is
   * not there, and `#banner` is asserted only NEGATIVELY in this whole file
   * (here and again under the autonav banner) — so renaming or deleting it would
   * leave both lines green while the error surface no longer existed. The
   * existence half is a separate clause with its own failure text.
   */
  ok(await frame.locator('#banner').count() === 1 && !await frame.locator('#banner').isVisible(),
    '...and NO error banner on a healthy deck — asserted as pixels AND as presence, since the property was always right and a deleted banner is also invisible');

  // ------------------------------------------------ follow the user's player
  /**
   * The SIGNAL, end to end: page `<video>` -> content script -> the deck's own
   * state. What it does with the signal is `follow()` in embed-state.js, which
   * is pure and asserted there; this is the wire between them, and the wire is
   * the half that cannot be tested in node.
   */
  const deckSees = () => frame.locator('body').evaluate(() => globalThis.__embed.videoPlaying);
  const modelStatus = () => frame.locator('body').evaluate(() => globalThis.__embed.modelStatus);
  const frameH = () => page.locator('#stem-splitter-live-deck').evaluate((el) => Math.round(el.getBoundingClientRect().height));

  ok(await deckSees() === false,
    'the deck is told the video is PAUSED on boot — not left at null, which would make it start anyway');

  /**
   * The check that the download is not a SIDE EFFECT. This profile is fresh, so
   * the weights are absent; if merely opening the deck still sent DECK_PREPARE
   * the status here would be 'loading' and 172 MiB would be in flight.
   */
  ok(await modelStatus() === 'absent',
    'opening the deck downloaded NOTHING — the model is still absent, not loading');

  // ---------------------------------------------------- press play, once
  // One gesture, three claims: the signal arrives, the download is ASKED for,
  // and nothing was started behind the question.
  const hBefore = await frameH();
  await page.locator('#v').evaluate((v) => v.play());
  await page.waitForTimeout(700);

  ok(await deckSees() === true, 'pressing play on the page reaches the deck');
  ok(await frame.locator('#modeldlg').evaluate((d) => d.open) === true,
    '...and with no model it asks first, rather than starting a silent 172 MiB fetch');
  ok((await frame.locator('#mdl-size').textContent()).includes('MB'),
    '...stating the size, which is the only fact that makes it a decision');
  ok(await frame.locator('body').evaluate(() => globalThis.__embed.status) === 'idle',
    '...with no pipeline started behind it — asking and starting are not the same gesture');
  /**
   * THE MODAL FITS. This used to assert `frameH() > hBefore` — a PROXY for
   * fitting, and one the code never promised: `reportHeight()` sends
   * `max(deck, modalFloor)`, so the frame only grows while the deck is shorter
   * than the dialog plus its scrim. The deck was 309 px when that was written
   * and is 425 px now, so the proxy went red on a build where nothing is wrong
   * and the modal has MORE room than before. That is the latencySec family
   * exactly (AGENTS.md): an assertion encoding an invariant the code never made.
   * Replaced with the claim that was always the point — the dialog's box is
   * inside the frame's, with the scrim margin around it.
   */
  /**
   * Measured in the FRAME'S OWN coordinates. `boundingBox()` through a
   * frameLocator returns page coordinates, and the frame sits ~300 px down the
   * fixture — so comparing that against the frame's height compares two
   * different origins and fails on a deck where the modal fits perfectly. It
   * did, on the first run of this line.
   */
  const dlgBox = await frame.locator('#modeldlg').evaluate((d) => {
    const r = d.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: document.documentElement.clientHeight };
  });
  const hModal = await frameH();
  ok(dlgBox.top >= 0 && dlgBox.bottom <= dlgBox.vh,
    `...and the dialog fits INSIDE the frame (${Math.round(dlgBox.top)}..${Math.round(dlgBox.bottom)} px of ${Math.round(dlgBox.vh)}) — a clipped modal is what the measured floor exists to prevent`);
  ok(hModal >= hBefore,
    `...and the frame never SHRANK to open it (${hBefore} -> ${hModal} px)`);

  await frame.locator('#mdl-no').click();
  await page.waitForTimeout(400);
  ok(await frame.locator('#modeldlg').evaluate((d) => d.open) === false, 'declining closes it');
  const stAfter = await modelStatus();
  ok(stAfter === 'absent', `...and still downloads nothing (model ${stAfter})`);
  /**
   * The engine's own account, because the UI state is not evidence here: the
   * defect this catches STOPPED ITSELF a second later, so every subsequent
   * screenful was correct while 172 MiB was already in flight. `deck A capture
   * started` in the engine log is the fact that was true and invisible.
   */
  const englog = await frame.locator('body').evaluate(() => globalThis.__embed.log);
  ok(Array.isArray(englog) && englog.length > 0, '...and the engine log is readable, so the next line can look');
  ok(!englog.some((l) => /capture started/.test(l)),
    '...and the ENGINE never started a capture — the UI settling back to idle hid this the first time');
  ok(await frameH() === hBefore, '...and the frame goes back to the size it was');

  await page.locator('#v').evaluate((v) => v.pause());
  await page.waitForTimeout(400);
  ok(await deckSees() === false, 'pausing reaches the deck too');
  ok(await frame.locator('#stat-chip').textContent() === 'Press play',
    '...and it goes back to naming the control the user has');

  // -------------------------------------------------------- content jumps
  /**
   * A seek invalidates the ~2.4 s already in the ring: it is audio from a part
   * of the track the user has left. The deck is not running here (no model), so
   * what is asserted is the SIGNAL reaching it — the restart it triggers when
   * running is `onContentJump()`, and the decision not to restart an idle deck
   * is the same line of code.
   */
  const jumps = () => frame.locator('body').evaluate(() => globalThis.__embed.jumps);
  const j0 = await jumps();
  await page.locator('#v').evaluate((v) => { v.currentTime = 0.2; });
  await page.waitForTimeout(400);
  ok(await jumps() > j0, 'a seek in the page reaches the deck as a content jump');
  ok(await frame.locator('body').evaluate(() => globalThis.__embed.status) === 'idle',
    '...and does not start anything on an idle deck');

  /**
   * THE HEIGHT CHANNEL, tested by MOVING IT.
   *
   * Asserting "the frame is about as tall as its content" passes on the initial
   * guess in `content.js` whether or not a single HEIGHT message ever arrived —
   * it reported coverage it did not have on the first run of this file, and the
   * measurement it was hiding was real: `documentElement.scrollHeight` is
   * floored by the viewport, so the deck could grow and never shrink. So: force
   * a size change, and require the frame to follow it BOTH WAYS.
   */
  const h0 = await frameH();
  await frame.locator('body').evaluate((body) => {
    const d = document.createElement('div');
    d.id = 'smoke-pad'; d.style.height = '200px';
    body.appendChild(d);
  });
  await page.waitForTimeout(400);
  const h1 = await frameH();
  ok(h1 >= h0 + 190, `the frame grows with the deck's content (${h0} -> ${h1} px)`);
  await frame.locator('body').evaluate(() => document.getElementById('smoke-pad').remove());
  await page.waitForTimeout(400);
  ok(await frameH() <= h0 + 2, `...and shrinks back (${h1} -> ${await frameH()} px), which the viewport-floored measure could not`);

  // ============================================================== keyboard
  /**
   * THE SHORTCUTS, DRIVEN FROM THE PAGE — which is the only entry point worth
   * testing. A key pressed while the DECK has focus reaches it through the
   * frame's own listener and proves nothing about the gesture the feature is
   * for: the user clicks YouTube's play button, so focus is on the YouTube
   * document, and every digit belongs to YouTube's seek-to-percentage handler
   * until `content.js` takes it.
   *
   * `window.__keys` in the fixture is that handler's stand-in, and it is the
   * INSTRUMENT for both halves — it is how "we took the key" and "we handed the
   * key back" are told apart. The first assertion below establishes that keys
   * are landing on the page at all, because every later one would pass for the
   * wrong reason if focus were still inside the frame.
   */
  const keysSeen = () => page.evaluate(() => window.__keys.slice());
  const clearKeys = () => page.evaluate(() => { window.__keys.length = 0; });
  const focusHost = () => page.locator('#below').click({ position: { x: 4, y: 4 } });
  const muted = (stem) => frame.locator(`.strip[data-stem="${stem}"]`).getAttribute('data-muted');
  const soloed = (stem) => frame.locator(`.strip[data-stem="${stem}"]`).getAttribute('data-solo');

  await focusHost();
  await clearKeys();
  await page.keyboard.press('Digit7');
  await page.waitForTimeout(150);
  ok((await keysSeen()).includes('Digit7'),
    'INSTRUMENT CHECK: a key pressed now reaches the PAGE\'s own handler — without this every line below could pass with focus inside the frame');
  /**
   * THE BOUNDARY, DRIVEN. `7` is the first digit past the rack's six strips and
   * stays YouTube's jump-to-70 %. The instrument check above already proved the
   * press reached the page; this proves it did not ALSO reach us. Every strip is
   * inspected, not just the one that would be the obvious victim, because a
   * stray handler that muted the wrong stem would pass a one-stem check.
   *
   * IT WAS `Digit5` UNTIL 2026-08-17 and the swap is the whole point: `5` is
   * guitar's key now, so the old form of this pair would have been an instrument
   * check on a key we intercept — i.e. an instrument that had stopped working,
   * reporting green.
   */
  const anyMuted = async () => {
    const n = await frame.locator('.strip[data-muted="true"]').count();
    const total = await frame.locator('.strip').count();
    return { n, total };
  };
  const after7 = await anyMuted();
  ok(after7.total === 6 && after7.n === 0,
    `...and 7 muted NOTHING here (${after7.n} of ${after7.total} strips muted): the rack takes as many digits as it has strips, and 7 is one past the last`);

  /**
   * ...AND THE TWO DIGITS THE SAME RULING GAVE US, from the same entry point.
   * The negative above only says `7` is not ours; without these two, retiring
   * the carve-out could have moved the boundary in `hostKeys()` and nowhere
   * else, and every assertion in this block would still be green.
   */
  await clearKeys();
  await page.keyboard.press('Digit5');
  await page.waitForTimeout(150);
  ok(await muted('guitar') === 'true' && await muted('piano') === 'false',
    '5 mutes GUITAR from the YouTube page — the fifth strip got its digit on 2026-08-17 and this is the assertion that says so');
  ok(!(await keysSeen()).includes('Digit5'),
    '...and YouTube never saw it — otherwise the same press also seeks the video to 50 %');
  await page.keyboard.press('Digit6');
  await page.waitForTimeout(150);
  ok(await muted('piano') === 'true', '...and 6 PIANO, the sixth and last');
  await page.keyboard.press('Digit5');
  await page.keyboard.press('Digit6');
  await page.waitForTimeout(150);
  const cleared = await anyMuted();
  ok(cleared.n === 0, `...both toggles, so the rack is clean again for the lines below (${cleared.n} muted)`);

  await clearKeys();
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(150);
  ok(await muted('vocals') === 'true', '1 mutes the vocals from the YouTube page, where the user\'s hands actually are');
  ok(!(await keysSeen()).includes('Digit1'),
    '...and YouTube never saw it — otherwise the same press also seeks the video to 10 %');
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(150);
  ok(await muted('vocals') === 'false', '...and it is a toggle: the same key brings the vocal back');

  await page.keyboard.press('Shift+Digit2');
  await page.waitForTimeout(150);
  ok(await soloed('drums') === 'true', 'Shift+2 solos the drums — matched on event.code, since Shift+2 is "@" on this layout');
  await clearKeys();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok(await soloed('drums') === 'false', 'Esc clears the solo — the "get me back to normal" key');
  ok(!(await keysSeen()).includes('Escape'), '...and YouTube did not get that one');

  /**
   * THE OTHER HALF OF ESCAPE, and the reason `hostKeys()` is a function. With
   * no solo and no overlay there is nothing for us to do with it, and Esc on
   * YouTube exits full screen — so it must go straight through.
   */
  await clearKeys();
  await page.keyboard.press('Escape');
  await page.waitForTimeout(150);
  ok((await keysSeen()).includes('Escape'),
    'with nothing to clear, Esc is YOUTUBE\'S again — an extension that breaks their full-screen exit reads as a broken page');

  await clearKeys();
  await page.keyboard.press('Shift+Slash');
  await page.waitForTimeout(200);
  ok(await frame.locator('#keysdlg').evaluate((d) => d.open) === true, '? opens the shortcut list');
  /**
   * BOTH HALVES. The negative alone ("does not mention deck B") is true of an
   * EMPTY table, so an overlay that rendered nothing would report that it listed
   * exactly the right bindings. The positive clause is the floor: the table has
   * to name the two gestures this build definitely has before its silence about
   * the others means anything. `Space` IS named in the dialog's fine print
   * below the table, deliberately — hence `.keytbl`, not `#keysdlg`.
   */
  const keytbl = await frame.locator('.keytbl').textContent();
  ok(/mute/i.test(keytbl) && /solo/i.test(keytbl) && !/Deck B|crossfader|Space/i.test(keytbl),
    `...listing only the bindings this build has — mute and solo present, no deck B, no crossfader, and Space is not ours (${keytbl.replace(/\s+/g, ' ').trim().length} chars read)`);

  /**
   * THE KEY CAPS ARE LETTERED FOR THE KEYBOARD IN FRONT OF THE USER.
   * `Alt` is not a key on a Mac; `⌥` is, and the binding was always correct —
   * Option is what sets `event.altKey` — so this is the whole of the defect.
   *
   * DRIVEN THROUGH `__embed.relabel()` WITH BOTH VALUES, and that is the point
   * rather than a convenience: a browser assertion that derived its own
   * expectation from `isMac()` would agree with the DOM on every machine
   * whether the DOM had followed it or not, and would be a second copy of the
   * measurement wearing the word "control". Here the two renderings are taken
   * on ONE machine and required to differ, so a `relabel()` that ignored its
   * argument goes red on any runner. The platform is put back afterwards and
   * that restoration is itself asserted.
   */
  const caps = () => frame.locator('body').evaluate(() => [...document.querySelectorAll('[data-mod]')]
    .map((el) => `${el.dataset.mod}|${el.textContent}|${el.getAttribute('role') || '-'}|${el.getAttribute('aria-label') || '-'}`));
  const bootMac = await frame.locator('body').evaluate(() => globalThis.__embed.mac);
  await frame.locator('body').evaluate(() => globalThis.__embed.relabel(true));
  const macCaps = await caps();
  await frame.locator('body').evaluate(() => globalThis.__embed.relabel(false));
  const pcCaps = await caps();
  await frame.locator('body').evaluate((_b, m) => globalThis.__embed.relabel(m), bootMac);
  const backCaps = await caps();

  ok(macCaps.length >= 8 && macCaps.every((c) => c === 'alt|⌥|img|Option' || c === 'shift|⇧|img|Shift'),
    `on an Apple keyboard EVERY modifier cap is the glyph and carries an accessible name — role="img" is what makes aria-label count on a span, so "⌥" is announced as "Option" rather than as a character (${macCaps.length} caps: ${[...new Set(macCaps)].join(', ')})`);
  ok(pcCaps.length === macCaps.length && pcCaps.every((c) => c === 'alt|Alt|-|-' || c === 'shift|Shift|-|-'),
    `...and off one they are the words, with the role and the label taken back off: the text is already the accessible name and a duplicate is one more thing to drift (${[...new Set(pcCaps)].join(', ')})`);
  ok(macCaps.join() !== pcCaps.join() && !macCaps.some((c) => c.includes('|Alt|')),
    'THE TWO RENDERINGS ARE ACTUALLY TWO: a relabel() that ignored its argument would produce identical lists here, and the shipped defect was exactly the mac list containing the word "Alt"');
  ok(backCaps.join() === (bootMac ? macCaps : pcCaps).join(),
    `...and the deck is left lettered for the machine it booted on (mac=${bootMac}), so nothing after this reads a DOM the harness rewrote`);

  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  ok(await frame.locator('#keysdlg').evaluate((d) => d.open) === false, '...and Esc closes it');

  /** The one that gets reported as "it ate my comment". */
  await page.locator('#typehere').click();
  await clearKeys();
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(150);
  ok(await muted('vocals') === 'false' && (await keysSeen()).includes('Digit1'),
    'a digit typed into a text field on the page is NOT a shortcut — it goes where it was typed');

  // Alt+1 resets that fader, and the arrows move it: DESIGN §11.3, on the
  // ported widget rather than assumed from the console's.
  const vocFader = frame.locator('.strip[data-stem="vocals"] .fader');
  await vocFader.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-1',
    'the focused fader still answers the arrow keys — 2 x 0.5 dB down');

  /**
   * THE FADER ON A MAC (2026-08-17). `Home`, `End`, `PageUp` and `PageDown`
   * are all `fn`+an arrow on a MacBook and the browser often eats them first, so
   * the ARIA landmark convention AND the coarse step were bindings with no keys
   * on that hardware. `Alt`+`↑`/`↓` is the landmark replacement, `Shift`+`Alt`+
   * `↑`/`↓` the coarse one, and all four original keys are kept as aliases.
   *
   * EVERY STEP BELOW MOVES THE VALUE AWAY FROM WHAT THE NEXT ONE ASSERTS, and
   * that ordering is load-bearing rather than tidy. Written the obvious way —
   * Alt+Up, Alt+Down, Home, End — `Home` asserts unity on a fader `Alt+Up` has
   * ALREADY left at unity, so deleting the `Home` case entirely still passes it.
   * Verified by deleting the case: only `End` went red. An assertion that passes
   * because nothing had to happen is the AGENTS.md failure this file is full of
   * warnings about, so every landmark is approached from the OTHER landmark or
   * from an arrow step, and every COARSE step is approached from a value no
   * landmark produces — -1 and 5, never 0 or -60. A ±6 dB step measured from
   * unity would land on values the landmark assertions also use, and a ±6 dB
   * step measured from −∞ would be testing the FLOOR_DB fallback instead.
   *
   * -60 is `aria-valuenow` for −∞ (MIN_DB), which is what `paintFader` writes
   * when the fader is at true zero.
   */
  await page.keyboard.press('Alt+ArrowDown');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-60',
    'Alt+Down takes the focused fader from -1 to −∞ — the End key\'s job, on a chord a MacBook has');
  await page.keyboard.press('Alt+ArrowUp');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '0',
    '...and Alt+Up back to unity, which is the same apply(0) Alt+1 and the Alt-click go through');

  // Off unity by an ARROW, so everything below travels from a value no landmark
  // created. -1 is also NOT on the ±6 dB grid from 0, so a coarse step that
  // silently ran from unity would miss.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-1', '...and the arrows still step it, 2 x 0.5 dB down');

  /**
   * THE COARSE STEP, and it is a RELATIVE move, which is why the start value is
   * asserted immediately above rather than assumed. Each of the four failures it
   * can have lands somewhere different from `5`: the chord falling through to
   * the landmark case gives `0` (which is what it did before this branch
   * existed), the fine step gives `-0.9`, the plain step `-0.5`, and no handler
   * at all leaves `-1`.
   */
  await page.keyboard.press('Shift+Alt+ArrowUp');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '5',
    'Shift+Alt+Up is the COARSE +6 dB step, -1 -> 5 — PageUp\'s job, on a chord a MacBook has');
  await page.keyboard.press('Shift+Alt+ArrowDown');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-1', '...and Shift+Alt+Down is -6 dB, 5 -> -1');

  /**
   * RE-ANCHOR, and it is not tidiness. Without it, breaking the COARSE CHORD
   * also reddened both PageUp/PageDown assertions below, because the chord's
   * failure left the fader at −∞ instead of -1 and the aliases were then
   * measured from the wrong place — four reds for one defect, and no way to read
   * which was the cause. Verified by breaking it: 4 red before this block, 2
   * after. The anchor is set by mechanisms this file has ALREADY asserted (the
   * Alt+Up landmark, then two arrow steps) and its value is asserted here, so a
   * green anchor is what makes a PageUp red attributable to PageUp.
   */
  await page.keyboard.press('Alt+ArrowUp');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-1',
    '...and the fader is re-anchored at -1 by keys already pinned above, so the two alias assertions below cannot inherit a coarse-step failure');
  await page.keyboard.press('PageUp');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '5',
    'PAGE UP STILL WORKS, -1 -> 5 — the alias is kept, exactly as Home and End are');
  await page.keyboard.press('PageDown');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-1', '...and so does Page Down, 5 -> -1');

  await page.keyboard.press('Home');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '0',
    'HOME STILL WORKS, from -1 — the alias is kept, because removing it helps nobody on a keyboard that has the key');
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '-60', '...and so does End, from unity');

  await focusHost();
  await page.keyboard.press('Alt+Digit1');
  await page.waitForTimeout(150);
  ok(await vocFader.getAttribute('aria-valuenow') === '0', 'Alt+1 puts that fader back to unity, from the page');

  // ============================================================= transpose
  /**
   * THE WIRE, not the label. The contract is `{ type: 'PITCH', deck, semitones }`
   * with integer semitones — the same `chrome.runtime` envelope every other
   * UI -> engine message uses, and the one `offscreen.js` switches on. The only
   * place it can be observed is the outgoing message, so `sendMessage` is
   * wrapped for the duration.
   *
   * IT IS NOT `{ t: 'pitch' }`. That is the worklet's shape, one boundary
   * further down (main thread -> audio thread, over the node's MessagePort), and
   * it stays as it is. This filter matched the worklet shape for a whole batch
   * after the UI wire moved: the assertion below did not merely go red, it took
   * the two assertions AFTER it down with it — `every()` and `!some()` are both
   * true of the empty array, so they reported green while inspecting nothing.
   * Every predicate in this block now states the count it needs first.
   */
  await frame.locator('body').evaluate(() => {
    globalThis.__sent = [];
    const orig = chrome.runtime.sendMessage.bind(chrome.runtime);
    chrome.runtime.sendMessage = (m) => { globalThis.__sent.push(m); return orig(m); };
  });
  const sent = () => frame.locator('body').evaluate(
    () => globalThis.__sent.filter((m) => m && m.type === 'PITCH'));

  await frame.locator('#tr-up').click();
  await frame.locator('#tr-up').click();
  await page.waitForTimeout(150);
  const pitchMsgs = await sent();
  ok(pitchMsgs.length === 2 && pitchMsgs[1].deck === 'A' && pitchMsgs[1].semitones === 2,
    `the transpose control posts { type: 'PITCH', deck, semitones } — got ${JSON.stringify(pitchMsgs)}`);
  /**
   * `length === 2 &&` is not belt-and-braces on the line above, it is the
   * assertion. `[].every(...)` is `true`, so without the count this line says
   * "all the messages were integers" on a run where there were no messages —
   * which is precisely how it survived the wire-shape change reporting green.
   */
  ok(pitchMsgs.length === 2 && pitchMsgs.every((m) => Number.isInteger(m.semitones)),
    `...as INTEGER semitones: the shifter has thirteen ratios and nothing between them (${pitchMsgs.length} messages inspected)`);
  ok(await frame.locator('#tr-v').getAttribute('data-home') === 'false'
    && (await frame.locator('#tr-v').textContent()).trim() === '+2',
    '...and 0 stops looking like the home position the moment it is not one');

  /**
   * THE CEILING. Clicked until the control stops accepting clicks rather than a
   * fixed count, so this measures where the ceiling IS instead of asserting it
   * is where the loop happens to stop.
   */
  let clicks = 0;
  while (clicks < 12 && !await frame.locator('#tr-up').isDisabled()) {
    await frame.locator('#tr-up').click();
    clicks++;
  }
  await page.waitForTimeout(150);
  const capped = await sent();
  const top = await frame.locator('body').evaluate(() => globalThis.__embed.transpose);
  /**
   * `capped.length >= 4` for the same reason: `![].some(...)` is `true`, so the
   * "nothing above +6 reached the shifter" half is free on an empty array. Four
   * is the floor the walk from +2 to +6 guarantees, and `capped` is cumulative,
   * so the real count is 2 + clicks — a floor, not an equality, because one
   * swallowed click is a different assertion than this one.
   */
  ok(top === 6 && capped.length >= 4 && !capped.some((m) => m.semitones > 6),
    `+6 is the ceiling and nothing above it ever reaches the shifter (stopped at ${top} after ${clicks} clicks from +2, ${capped.length} messages inspected)`);
  ok(await frame.locator('#tr-up').isDisabled(),
    '...and the control says so rather than swallowing clicks silently');

  await frame.locator('#tr-v').click();
  await page.waitForTimeout(150);
  ok(await frame.locator('body').evaluate(() => globalThis.__embed.transpose) === 0
    && await frame.locator('#tr-v').getAttribute('data-home') === 'true',
    'the readout is also the way home — a ±6 control with no reset makes the user count clicks back to the record\'s own pitch');

  // ================================================================== speed
  /**
   * VARISPEED, AND ONLY THE THREE CLAIMS A REAL BLINK CAN CARRY. The ladder,
   * the clamp, the far threshold and the gate are pure and are asserted in
   * `embed/speed.js` (38 checks) and `embed/ui/embed-state.js`; none of them
   * needs a browser and none of them is repeated here. What is here is the
   * three things node cannot see: a MODIFIER riding a synthesised click, a
   * greyed control actually being inert, and the pending -> live paint.
   *
   * All three were verified by hand before they were written down, so they are
   * REGRESSION GUARDS rather than open questions — which matters, because a red
   * here is a claim about Blink and the first instinct will be to widen it.
   */
  const spShown = () => frame.locator('#sp-v').textContent();
  const spState = () => frame.locator('#spbox').getAttribute('data-state');
  const elRate = () => page.locator('#movie_player video').evaluate((v) => v.playbackRate);
  /**
   * The deck's own outgoing SPEED messages, off the same `__sent` wrapper the
   * transpose block installed. It is the INSTRUMENT for "the control did
   * nothing", and a count of them is taken on both sides of the greyed click —
   * because `content.js` refuses a 'set' during an ad as well, so the element's
   * rate alone would report the deck inert on a run where it was not.
   */
  const spSent = () => frame.locator('body').evaluate(
    () => globalThis.__sent.filter((m) => m && m.type === 'SPEED').length);

  /**
   * `Shift` + Enter, on a FOCUSED button of ours. This is the one clause of the
   * speed gesture that is an assumption about Blink rather than about our code:
   * Enter on a focused `<button>` synthesises a click, and the claim is that the
   * synthesised click carries `shiftKey`. If it does not, the coarse step is
   * keyboard-unreachable and the fallback is a `keydown` handler on the two
   * buttons — which is why this is asserted instead of assumed.
   *
   * IT DISCRIMINATES. Plain Enter from home lands on `0.98×` (one rung, a third
   * of a semitone); the Shift branch lands on `0.50×` (a whole octave). A build
   * where the modifier is dropped does not merely lose a feature, it reads
   * `0.98×` here — so this control can lose.
   */
  await frame.locator('#sp-v').click();          // home first, whatever ran above
  await page.waitForTimeout(250);
  await frame.locator('#sp-dn').press('Shift+Enter');
  await page.waitForTimeout(400);
  const shiftShown = (await spShown()).trim();
  const shiftRate = await elRate();
  ok(shiftShown === '0.50×' && Math.abs(shiftRate - 0.5) < 1e-6,
    `Shift+Enter on #sp-dn from home lands on 0.50× — the modifier rides Blink's synthesised click, and a build that dropped it would read 0.98× here (readout "${shiftShown}", element ${shiftRate}, gate ${await spState()})`);

  /**
   * A GREYED CONTROL MUST BE INERT, NOT MERELY GREY. Rows 9-11 of the state
   * table use `aria-disabled` rather than `disabled` on purpose — the button
   * stays focusable so the reason under it can be read — and an `aria-disabled`
   * button is still fully clickable. The early return in `setSpeed()` is the
   * only thing that makes it do nothing, and it is not visible from the DOM.
   *
   * `ad-showing` is a CLASS and not an event, so a media event has to wake
   * content.js's look — which is exactly how a real ad is noticed
   * (`applySpeed`'s 'poll' reason, and the ad-END edge it promotes).
   */
  await frame.locator('#sp-v').click();          // back to 1.00x, the rate this claim names
  await page.waitForTimeout(300);
  await page.evaluate(() => {
    document.querySelector('#movie_player').classList.add('ad-showing');
    document.querySelector('#movie_player video').dispatchEvent(new Event('timeupdate'));
  });
  await page.waitForTimeout(400);
  const greyed = await spState();
  /**
   * THE PRECONDITION, AND IT IS THE HALF THAT MAKES THE CLAIM MEAN ANYTHING.
   * `paintSpeed()` uses `aria-disabled` for a reasoned lockout and the real
   * `disabled` attribute only for an end stop — so during an ad the button is
   * greyed but still fully clickable, and the early return in `setSpeed()` is
   * the only thing making it inert. If a build swapped this to native
   * `disabled`, the DOM would refuse to dispatch the click and the inertness
   * assertion below would pass WITHOUT THE HANDLER EVER RUNNING — the vacuous
   * shape wearing the platform's clothes. So the two attributes are asserted
   * explicitly, and `native === false` is what licenses the forced click.
   */
  const dnState = await frame.locator('#sp-dn').evaluate((b) => ({
    aria: b.getAttribute('aria-disabled'), native: b.disabled,
  }));
  ok(greyed === 'ad' && dnState.aria === 'true' && dnState.native === false,
    `an ad greys the speed control with aria-disabled and leaves it CLICKABLE (state "${greyed}", aria-disabled "${dnState.aria}", disabled ${dnState.native}) — a reasoned lockout stays in the tab order so the reason under it can be read, and native disabled would make the next two lines vacuous`);

  /**
   * THE CLICK HAS TO ACTUALLY HAPPEN, and this is what the assertion here used
   * to get wrong. A plain `.click()` is refused by Playwright's own
   * actionability check — an `aria-disabled` control is "not enabled" to it — so
   * it timed out after 30 s and THREW, taking the rest of the file with it. The
   * claim ("a greyed button is inert") could never once execute.
   *
   * `force: true` is the fix rather than a DOM `dispatchEvent` because it drives
   * the real input path: Blink synthesises the same trusted click a user's mouse
   * would, on the same coordinates, through the same hit test. A synthetic
   * `new MouseEvent(...)` would prove only that our own listener ignores our own
   * event.
   *
   * BUT "the framework declined to click" is not evidence of inertness — it is
   * the vacuous shape in a new costume — so the delivery is INSTRUMENTED. Our
   * own listener on the same button counts the clicks that arrive. If the click
   * does not land, `adClicks` is 0 and the instrument check goes red instead of
   * the inertness claim going green for free.
   */
  await frame.locator('#sp-dn').evaluate((b) => {
    globalThis.__adClicks = 0;
    b.addEventListener('click', () => { globalThis.__adClicks++; });
  });
  const sentBefore = await spSent();
  /**
   * The throw is converted to a red HERE rather than allowed to escape, for the
   * reason the catch at the foot of this file states: an unexpected throw
   * denies a verdict to every assertion after it, and a gesture that cannot be
   * performed is a failure of THIS claim and of nothing else.
   */
  let clickErr = null;
  try {
    await frame.locator('#sp-dn').click({ force: true, timeout: 5000 });
  } catch (e) { clickErr = String(e && e.message).split('\n')[0]; }
  await page.waitForTimeout(400);
  const adClicks = await frame.locator('body').evaluate(() => globalThis.__adClicks);
  ok(clickErr === null && adClicks === 1,
    `INSTRUMENT CHECK: the forced click REACHED the greyed button's own click handler (${adClicks} click${adClicks === 1 ? '' : 's'} seen${clickErr ? `, click threw: ${clickErr}` : ''}) — without this the line below reports inertness on a run where nothing was ever clicked`);

  const sentAfter = await spSent();
  const adRate = await elRate();
  const adShown = (await spShown()).trim();
  /**
   * AND NOW THE CLAIM, on a click that is known to have landed.
   *
   * HOW IT GOES RED. Delete `if (!spGate().ok) return;` from `setSpeed()` and
   * the handler runs: `spPending` is set and `paintSpeed()` repaints, so the
   * readout reads `0.98×`; `toOff({type:'SPEED'})` fires, so `sentAfter` is
   * `sentBefore + 1`. Both witnesses move on a build that is grey but live.
   *
   * THE READOUT AND THE MESSAGE COUNT ARE THE DISCRIMINATORS; the element's
   * rate is not. `content.js` refuses a 'set' during an ad on its own, so
   * `adRate` would stay at 1 even with our handler wide open — it is here as
   * the end-to-end backstop, not as the thing that can lose.
   *
   * `sentBefore >= 1` is not decoration. `sentAfter === sentBefore` is `0 === 0`
   * on a run where the wrapper was never installed or the message shape moved,
   * which is the empty-array shape this file's transpose block already paid for
   * once. The presses above guarantee at least one, so the instrument is known
   * to be able to see before it is asked to see nothing.
   */
  ok(sentBefore >= 1 && sentAfter === sentBefore && adShown === '1.00×' && Math.abs(adRate - 1) < 1e-6,
    `a click on a greyed speed button CHANGES NOTHING — readout still "${adShown}", element still ${adRate}, and the deck sent ${sentAfter - sentBefore} more SPEED messages (${sentBefore} seen before the click)`);
  await page.evaluate(() => {
    document.querySelector('#movie_player').classList.remove('ad-showing');
    document.querySelector('#movie_player video').dispatchEvent(new Event('timeupdate'));
  });
  await page.waitForTimeout(400);

  /**
   * PENDING IS THE LATENCY, DRAWN. The press paints immediately but OUTLINED,
   * and the value FILLS when the change has been on the wire for `latencySec`.
   * Both halves are asserted, because an outline that never fills is a control
   * stuck looking broken and a fill that arrives instantly is the latency not
   * being drawn at all.
   *
   * The video has to be PLAYING for this: `spRemainMs()` returns 0 on a deck
   * that is not running, and `follow()` would answer 'stop' to a `running`
   * status under a paused player — so an injected LIVE_STATE alone would be
   * undone by `reconcile()` in the same message. The model dialog does not
   * reappear (it was declined above), so nothing is started behind this.
   *
   * THE FILL IS DRIVEN BY MESSAGE ARRIVAL AND BY NOTHING ELSE, which is why the
   * second `runState()` below is what makes it happen and a bare wait is not.
   */
  const runState = (latencySec) => sw.evaluate((L) => chrome.runtime.sendMessage({
    v: 1, to: 'ui', from: 'off', type: 'LIVE_STATE', status: 'running', latencySec: L,
  }).catch(() => {}), latencySec);

  await page.locator('#v').evaluate((v) => v.play());
  await page.waitForTimeout(400);
  await runState(1.5);
  await page.waitForTimeout(200);
  await frame.locator('#sp-up').click();
  await page.waitForTimeout(200);
  const pendingOn = await frame.locator('#spbox').getAttribute('data-pending');
  const pendingShown = (await spShown()).trim();
  await page.waitForTimeout(1600);
  await runState(1.5);
  await page.waitForTimeout(300);
  const pendingOff = await frame.locator('#spbox').getAttribute('data-pending');
  ok(pendingOn === 'true' && pendingOff === 'false' && pendingShown === '1.02×',
    `the value is OUTLINED on the press and FILLS when the audio catches up — data-pending ${pendingOn} -> ${pendingOff} across a 1.5 s latency, and it paints the new rate straight away ("${pendingShown}")`);

  // ------------------------------------------- a jump does not undo the "no"
  /**
   * DECLINING IS AN ANSWER, AND A SEEK IS NOT A NEW QUESTION.
   *
   * The block at the top of this file proves that answering "no" to the
   * one-time download starts nothing. It proves it for ONE route: the play
   * gesture, which reaches `startLive()` through `reconcile()`'s
   * `modelInTheWay()` gate. `onContentJump()` is the other route — it reaches
   * `startLive()` through `restartLive()`, with no gesture behind it at all,
   * because a seek is the page's event and not the user's consent. Ungated, a
   * scrub on a deck the user had just said "no" to attached a capture and put
   * the weights on the wire; the UI settled back within a second and every
   * screenful after that was correct, which is the same way the first defect
   * hid (see `deck A capture started` above).
   *
   * This is the state where the two can disagree and the only one: the deck
   * believes it is `running` (injected above, and still injected — nothing real
   * is running) while the model is `absent` and declined.
   *
   * The jump is DRIVEN, by writing `currentTime`. The fixture no longer
   * produces seeks of its own (see `silentWavDataUri`), and a claim left to a
   * clock would be measuring the fixture instead of the guard.
   */
  const jBefore = await jumps();
  const stAtJump = await frame.locator('body').evaluate(() => globalThis.__embed.status);
  await page.locator('#v').evaluate((v) => { v.currentTime = 12; });
  await page.waitForTimeout(700);
  const jAfter = await jumps();
  const jumpLog = await frame.locator('body').evaluate(() => globalThis.__embed.log);
  /**
   * THE INSTRUMENT CHECK, and it is not decoration: the line under it asserts
   * that NOTHING happened, and "nothing happened" is what a message that never
   * arrived also looks like. `RUNNING.has(live.status)` is `onContentJump()`'s
   * own first guard, so a deck that had fallen back to `idle` would take the
   * early return and pass the next line without ever reaching `restartLive()`.
   * Both halves have to be true before the silence below means anything, and so
   * does having an engine log to read.
   */
  ok(jAfter === jBefore + 1 && stAtJump === 'running' && jumpLog.length > 0,
    `INSTRUMENT CHECK: the seek arrived at onContentJump() on a RUNNING deck, past its own status guard, with an engine log to read  status ${stAtJump}, jumps ${jBefore} -> ${jAfter}, ${jumpLog.length} log lines`);
  const stJumped = await modelStatus();
  ok(!jumpLog.some((l) => /capture started/.test(l)) && stJumped === 'absent',
    `...and that jump started NO capture and NO fetch on a deck whose model was DECLINED — onContentJump() -> restartLive() must carry reconcile()'s model gate, or a scrub spends the download the user just refused  model ${stJumped}`);

  // Leave the page and the deck as they were found: home, paused, idle.
  await frame.locator('#sp-v').click();
  await page.waitForTimeout(200);
  await page.locator('#v').evaluate((v) => v.pause());
  await page.waitForTimeout(400);

  // ============================================================ key display
  /**
   * THE ENGINE SENDS THE CONCERT TONIC AND NOTHING ELSE. Driven from the
   * service worker, which is the only context that can post an extension
   * message into this frame — and it is the same `LIVE_STATE` the engine sends,
   * so this is the real handler and not a stub.
   */
  const sendKey = (key) => sw.evaluate((k) => chrome.runtime.sendMessage({
    v: 1, to: 'ui', from: 'off', type: 'LIVE_STATE', status: 'idle', key: k,
  }).catch(() => {}), key);
  const keyView = () => frame.locator('body').evaluate(() => globalThis.__embed.key);

  await sendKey({ state: 'listening' });
  await page.waitForTimeout(250);
  const listening = await keyView();
  ok(listening.show === 'listening' && !listening.written,
    'LISTENING COMES FIRST and shows no key at all — an early guess on two seconds of an intro costs the user\'s trust in the whole feature');
  ok(/listening/i.test(await frame.locator('#key-state').textContent()),
    '...and it says so in words, rather than showing an empty box that reads as broken');

  /**
   * PICK THE HORN, do not inherit it. Everything from here to the tenor check
   * asserts the ALTO spelling, and until now it got alto by being embed.js's
   * module default — an entry point these assertions never named. The default
   * is `concert` as of 2026-08-17, where written and concert are the same key
   * and paintKey collapses the second line, so an unpinned horn would have made
   * this whole block measure the default rather than the transposition.
   */
  await frame.locator('#inst').selectOption('alto');
  await page.waitForTimeout(150);

  await sendKey({ state: 'locked', concertTonic: 6, mode: 'minor', confidence: 0.3 });
  await page.waitForTimeout(250);
  const locked = await keyView();
  ok(locked.written === 'Eb minor (alto sax)' && locked.concert === 'F# minor (concert)',
    `a locked key shows BOTH, both labelled — got "${locked.written}" / "${locked.concert}"`);
  ok(locked.scale === 'Eb minor: Eb F Gb Ab Bb Cb Db',
    `...and the scale as it is FINGERED, in the spelling the key signature uses — got "${locked.scale}"`);

  await frame.locator('#tr-up').click();
  await frame.locator('#tr-up').click();
  await page.waitForTimeout(200);
  const shifted = await keyView();
  ok(shifted.concert === 'G# minor (concert)' && shifted.written === 'F minor (alto sax)',
    `+2 moves the key with the audio — got "${shifted.concert}" / "${shifted.written}"`);

  /**
   * THE DOUBLE-COUNT, which is the whole reason chroma.js's header exists. A UI
   * that stores the SHIFTED tonic and shifts it again looks correct at every
   * single value and is wrong by twice the excursion the moment the control
   * comes back — so the assertion is a SWEEP, not a reading.
   */
  await frame.locator('#tr-v').click();
  await page.waitForTimeout(200);
  const home = await keyView();
  ok(home.concert === 'F# minor (concert)' && home.written === 'Eb minor (alto sax)',
    `sweeping the transpose out and back lands on the ORIGINAL key — got "${home.concert}" (a stored shifted tonic reads B minor here)`);

  await frame.locator('#inst').selectOption('tenor');
  await page.waitForTimeout(200);
  const tenor = await keyView();
  ok(tenor.written === 'G# minor (tenor sax)' && tenor.concert === 'F# minor (concert)',
    `the horn changes only the written key — got "${tenor.written}" / "${tenor.concert}"`);
  await frame.locator('#inst').selectOption('alto');
  await page.waitForTimeout(150);

  await sendKey({ state: 'locked', concertTonic: 99, mode: 'minor' });
  await page.waitForTimeout(250);
  ok((await keyView()).show === 'bad' && /unavailable/i.test(await frame.locator('#key-state').textContent()),
    'a key payload this build cannot read is a VISIBLE state — an empty readout would look healthy on exactly the runs where the engine is wrong');
  await sendKey({ state: 'locked', concertTonic: 6, mode: 'minor', confidence: 0.3 });
  await page.waitForTimeout(200);

  // ============================================================== autoplay
  /**
   * END TO END: the checkbox writes `storage.local`, the content script's own
   * `onChanged` listener picks it up, and YOUTUBE'S OWN TOGGLE moves. The
   * fixture's toggle is the observable at the far end, so this is the whole
   * chain and not just the write.
   */
  const ytAutonav = () => page.locator('.ytp-autonav-toggle-button').getAttribute('aria-checked');
  const storedPrefs = () => sw.evaluate(async () => (await chrome.storage.local.get('prefs')).prefs || null);

  ok(await ytAutonav() === 'false',
    'mounting the deck turned YouTube\'s own autoplay-next OFF, by pressing YouTube\'s own control');
  ok(await page.locator('#stem-splitter-live-deck').getAttribute('data-autonav') === 'off',
    '...and the content script reported that outcome by name');
  ok(await frame.locator('#autonav-cb').isChecked(),
    '...and the checkbox agrees: checked means "stop at the end", which is the default');

  await frame.locator('#autonav-cb').uncheck();
  await page.waitForTimeout(500);
  const p1 = await storedPrefs();
  ok(!!p1 && p1.autoplayNext === true,
    `unchecking stores autoplayNext: true — the key names YOUTUBE's behaviour, so it is the inverse (got ${JSON.stringify(p1)})`);
  ok(await ytAutonav() === 'true',
    '...and their toggle goes straight back to the value we took, without waiting for the next video');

  await frame.locator('#autonav-cb').check();
  await page.waitForTimeout(500);
  const p2 = await storedPrefs();
  ok(!!p2 && p2.autoplayNext === false, `re-checking stores autoplayNext: false (got ${JSON.stringify(p2)})`);
  ok(await ytAutonav() === 'false', '...and suppression is imposed again, both directions on one control');

  /**
   * THE FAILURE BANNER. Posted from the page's main world, which is the same
   * origin and the same `parent` the deck's guard requires — the states
   * themselves need YouTube's markup to have changed, which is not reproducible
   * in a fixture and is exactly why `content.js` reports them by name.
   */
  const forceNav = (state) => page.evaluate((st) => document.getElementById('stem-splitter-live-deck')
    .contentWindow.postMessage({ from: 'stem-splitter-live-host', type: 'AUTONAV', state: st, suppress: true }, '*'), state);

  await forceNav('missing');
  await page.waitForTimeout(250);
  ok(await frame.locator('#nav-banner').isVisible(), 'a missing autoplay toggle raises a banner — silence would be the feature failing invisibly');
  ok(/autoplay/i.test(await frame.locator('#nav-p').textContent()),
    `...that says what it means for the user (${(await frame.locator('#nav-p').textContent()).slice(0, 48)}…)`);
  ok(await frame.locator('body').evaluate(() => globalThis.__embed.halted) === false,
    '...and it does NOT latch the deck — the audio is fine, and halting it would be far worse than the thing being reported');
  ok(!await frame.locator('#banner').isVisible(),
    '...and it is not the error banner: an arm refusal and this must not be able to hide each other');

  await frame.locator('#nav-x').click();
  await page.waitForTimeout(200);
  ok(!await frame.locator('#nav-banner').isVisible(), 'it is dismissible — advisory, not fatal');
  await forceNav('lost');
  await page.waitForTimeout(250);
  ok(await frame.locator('#nav-banner').isVisible(),
    '...but a DIFFERENT failure comes back: dismissing "missing" is not consent to silence "lost", which means their preference is still flipped');
  await forceNav('off');
  await page.waitForTimeout(250);
  ok(!await frame.locator('#nav-banner').isVisible(), 'and a healthy state clears it');
  await forceNav('stuck');
  await page.waitForTimeout(250);
  ok(await frame.locator('#nav-banner').isVisible(),
    '...along with the dismissal, so a failure that recurs after a good run is allowed to say so again');
  await frame.locator('#nav-x').click();

  // ================================================== the frame's own height
  /**
   * THREE new surfaces went into a frame that was 309 px. `overflow: hidden`
   * means anything past the reported height is not scrolled to — it is cut off.
   */
  /**
   * WAIT FOR THE CHANNEL, NOT FOR A CLOCK — and the difference is the whole
   * reason this line was flaky.
   *
   * The height is a CROSS-DOCUMENT message: the deck's ResizeObserver fires,
   * `reportHeight()` posts to `parent`, and content.js writes `frame.style
   * .height`. The last thing above is `#nav-x`, which removes a 63 px banner —
   * so at the instant that click resolves, the deck's `body.scrollHeight` has
   * ALREADY shrunk and the frame has not been told yet. Sampling both there
   * compares a post-dismiss content height against a pre-dismiss frame height.
   * Measured on this machine: `frame=488 body=425` at that instant, `425/425`
   * five milliseconds later — 5/5 runs, and the same defect showed as 2/5 on the
   * machine it was first reported from. It was never a product race; it was this
   * file reading during the one message it had not waited for.
   *
   * So: poll the CONDITION. The settle is bounded by one ResizeObserver
   * delivery plus one postMessage hop plus one style write — there is no timer
   * anywhere in that path, which is what makes a bound legitimate here rather
   * than a longer sleep with a story attached. The budget is two orders of
   * magnitude above the measurement, and the observed settle is printed on every
   * run so the bound cannot quietly stop holding.
   *
   * The click above deliberately keeps NO settle wait of its own: that is what
   * exercises this poll on every run and keeps the number honest.
   */
  const settleT0 = Date.now();
  const SETTLE_BUDGET_MS = 2000;
  let hFinal = 0, bodyH = 0, settleMs = 0;
  for (;;) {
    hFinal = await frameH();
    bodyH = await frame.locator('body').evaluate(() => document.body.scrollHeight);
    settleMs = Date.now() - settleT0;
    if (Math.abs(hFinal - bodyH) <= 1 || settleMs > SETTLE_BUDGET_MS) break;
    await page.waitForTimeout(16);
  }
  /**
   * `bodyH > 0` is the "it must fail when it cannot look" half: a deck that
   * failed to lay out reports `scrollHeight` 0, and `Math.abs(0 - 0) <= 1`
   * would otherwise call that a perfect fit.
   */
  ok(bodyH > 0 && Math.abs(hFinal - bodyH) <= 1,
    'the frame is exactly as tall as the deck — the host clamps at 900 and never scrolls'
    + `  ${hFinal} px frame, ${bodyH} px content, settled in ${settleMs} ms of ${SETTLE_BUDGET_MS}`);
  ok(hFinal < 900, `...and inside the clamp with room to spare (${hFinal} px)`);

  // ===================================================== the armed-state gate
  /**
   * THE PRODUCT RULING, and the half that is easy to forget: with NO deck armed,
   * YouTube's seek-to-percentage must work exactly as it does with this
   * extension uninstalled. Eject is the real gesture that gets there — the deck
   * stays on screen and stops being armed.
   */
  await frame.locator('#eject').click();
  await page.waitForTimeout(400);
  ok(await frame.locator('#stat-chip').textContent() === 'Not armed', 'ejecting disarms the deck and says so');
  await focusHost();
  await clearKeys();
  await page.keyboard.press('Digit1');
  await page.waitForTimeout(200);
  ok((await keysSeen()).includes('Digit1'),
    'WITH NO DECK ARMED, 1 REACHES YOUTUBE UNTOUCHED — we are a guest on their page and their shortcut is theirs again');
  ok(await muted('vocals') === 'false', '...and mutes nothing here: an unarmed deck has no audio to mute');

  await press();
  await page.waitForTimeout(700);
  ok(await page.locator('#stem-splitter-live-deck').count() === 0,
    'a second press puts the deck away — the icon is a show/hide gesture');

  // ============================== the durable arm refusal, and the chord to fix it
  /**
   * APPEND ABOVE THIS BLOCK, NOT BELOW IT. Everything from here to the end of
   * the `try` runs against a DISARMED deck with a BANNER UP, and both of those
   * are states earlier assertions in this file assert the NEGATION of: `#banner`
   * is checked hidden twice, and the armed-state assertions read
   * `session.tabId`. This block writes `session: { tabId: null, … }` and seeds a
   * refusal deliberately, so an assertion appended after it is reading a
   * different deck from the one it thinks it is — and its last act replaces the
   * frame's `chrome.commands` table for the rest of the run.
   * `extension/shared/host.js` carries the same note for its duty lists, for the
   * same reason.
   *
   * THE ONE READ ON THIS PAGE THAT NO BROWSER ASSERTION HAS EVER COVERED.
   *
   * A refusal to arm is sent AND persisted (`sw/service-worker.js`), because the
   * deck page is created BY the arm gesture: on a refusal it is still loading
   * while the worker posts `ARM_ERROR` to nobody, and `toUi()` swallows the
   * rejection. Reading `chrome.storage.session` at boot is therefore the ONLY
   * reason a refused arm says anything at all here — and until now the only
   * thing that checked it was a unit test of `armErrorFresh()`, which is the
   * freshness rule and not the read.
   *
   * WHY IT IS DRIVEN THIS WAY AND NOT BY ARMING SOMETHING THAT FAILS. A refusal
   * seeded before the chord press cannot survive it: a successful arm calls
   * `clearArm()` unconditionally, which is exactly the behaviour that stops a
   * stale refusal outliving the problem it described. So the record is written
   * and the deck is then asked to mount by the SAME message the worker itself
   * sends on a refusal — `{type:'STEM_SPLITTER_LIVE_EMBED', mode:'show'}`,
   * posted from the service worker, which is the file's existing technique for
   * injecting a real message onto a real bus.
   *
   * AND THE SESSION IS CLEARED IN THE SAME WRITE, for a second assertion out of
   * one remount: a deck with nothing armed is the only state in which the
   * not-armed hint is on screen at all.
   */
  const armedTabId = await sw.evaluate(async () => {
    const s = (await chrome.storage.session.get('session')).session || {};
    return s.tabId || null;
  });
  ok(!!armedTabId,
    'INSTRUMENT CHECK: the worker still knows which tab this run armed, so the remount below has somewhere to go'
    + `  tabId ${armedTabId}`);

  /**
   * A SENTINEL, not a plausible message. Nothing else in this build can produce
   * this string, so a banner carrying it came from the record seeded two lines
   * below and from nowhere else — which is what makes the claim "the boot read
   * painted it" rather than "a banner is up".
   */
  const SEEDED_ARM_MSG = 'embed-smoke seeded this refusal into session storage before the deck existed.';
  await sw.evaluate(async ([tabId, message]) => {
    await chrome.storage.session.set({
      // Nothing armed: this is what the deck's not-armed hint needs, and what
      // `getSession()` hands back to the SW_STATUS the fresh deck sends.
      session: { tabId: null, title: null, url: null, armedAt: null },
      // `at` is epoch ms and must be recent: `armErrorFresh()` refuses a record
      // older than ARM_ERROR_TTL_MS, which is the rule that stops a refusal from
      // a previous sitting painting as current.
      armError: { code: 'TAB_BUSY', message, at: Date.now(), seq: 4242 },
    });
    await chrome.tabs.sendMessage(tabId, {
      v: 1, to: 'tab', from: 'sw', type: 'STEM_SPLITTER_LIVE_EMBED', mode: 'show',
    });
  }, [armedTabId, SEEDED_ARM_MSG]);

  await page.waitForSelector('#stem-splitter-live-deck', { timeout: 8000 }).catch(() => {});
  const reT0 = Date.now();
  let reBooted = false, reMs = 0;
  for (;;) {
    reBooted = await frame.locator('body').evaluate(() => !!globalThis.__embed).catch(() => false);
    reMs = Date.now() - reT0;
    if (reBooted || reMs > BOOT_BUDGET_MS) break;
    await page.waitForTimeout(16);
  }
  ok(reBooted,
    'the refusal message remounted the deck — every claim below reads a deck that booted with the record already in storage'
    + `  ${reBooted ? `__embed present after ${reMs} ms` : `NOT BOOTED — no __embed after ${reMs} ms, gave up at the ${BOOT_BUDGET_MS} ms cap`}`);

  // Wait for the CONDITION, not for a clock: the boot read is one storage round
  // trip inside the page and there is no timer anywhere in that path.
  await frame.locator('#banner').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
  const bannerUp = await frame.locator('#banner').isVisible().catch(() => false);
  const bannerMsg = ((await frame.locator('#err-p').textContent().catch(() => '')) || '').trim();
  const bannerTitle = ((await frame.locator('#err-t').textContent().catch(() => '')) || '').trim();
  /**
   * `#banner` IS ASSERTED NEGATIVELY TWICE EARLIER IN THIS RUN — on the armed
   * deck at boot and again after the autoplay block — so "a banner is up" is a
   * state this build demonstrably does not reach on its own. That is the
   * control, and the sentinel above is the belt to its brace.
   */
  ok(reBooted && bannerUp && bannerMsg === SEEDED_ARM_MSG,
    'A REFUSAL PERSISTED BEFORE THE DECK EXISTED IS PAINTED BY THE DECK\'S BOOT READ — the only path by which a refused arm says anything at all'
    + `  banner ${bannerUp ? 'visible' : 'HIDDEN'}, message ${JSON.stringify(bannerMsg)}`);
  ok(bannerUp && /TAB_BUSY/.test(bannerTitle) && !/Restart/i.test(bannerTitle),
    '...and it is headlined as the arm family rather than as a stopped deck, because nothing here ever started'
    + `  ${JSON.stringify(bannerTitle)}`);

  /**
   * THE NOT-ARMED HINT NAMES A CHORD THE USER HAS — and NO MORE THAN THAT is
   * claimed here, which is the correction review forced on this block.
   *
   * `chrome.commands.getAll()` is read out of the SERVICE WORKER, a different
   * context from the deck reached by a different path, and the first version of
   * this comment called that "two independent readings of one binding". It is
   * not. On every machine this suite runs on — and on CI — the binding IS the
   * manifest's suggested key, so a deck that ignored the platform and TYPED
   * `Ctrl+Shift+9` into `paintArmHint()` passes this equality unchanged. Both
   * mutations were run: a literal in `paintArmHint`, and a boot site that calls
   * `host.armShortcut()` and throws the answer away. Neither moved this number.
   * That is a control that cannot lose, and AGENTS.md is explicit about what
   * that is worth.
   *
   * SO THE READING IS MADE INDEPENDENT BELOW instead of being asserted to be.
   * The block after this one replaces the frame's command table with a chord no
   * manifest in this repo declares and remounts the deck — the only arrangement
   * in which "drawn" and "returned" are two different values that can disagree.
   * This pair stays because it is the claim about the REAL binding (the chord
   * the user would actually press is the chord on screen), and because it is the
   * same pair the setup page gets: what is DRAWN, and what is ANNOUNCED.
   */
  const deckRawChord = await sw.evaluate(async () => {
    const all = await chrome.commands.getAll().catch(() => []);
    const c = all.find((x) => x.name === 'arm-tab');
    return (c && c.shortcut) || '';
  }).catch(() => '');
  const hintLead = ((await frame.locator('#src-lead').textContent().catch(() => '')) || '');
  const hintChord = ((await frame.locator('#src-chord').textContent().catch(() => '')) || '').trim();
  const hintSaid = await frame.locator('#src-chord')
    .evaluate((el) => el.getAttribute('aria-label') || '').catch(() => '');
  ok(deckRawChord !== '' && hintChord === deckRawChord && /toolbar icon/.test(hintLead),
    'THE DECK\'S NOT-ARMED HINT NAMES A CHORD THE BROWSER HAS BOUND, beside the toolbar icon it already named'
    + `  chrome.commands.getAll() says "${deckRawChord}" for arm-tab, the deck drew "${hintChord}"`);
  /**
   * The same branch `welcome.js` makes, asserted the same way: an accessible
   * name exactly when the chord is drawn in GLYPHS. Setting one unconditionally
   * is not a neutral extra — it replaces text a screen reader could already
   * read, which is what this build shipped on every non-Mac machine until
   * `chordLabel()` was corrected to join both forms with the separator it draws.
   */
  ok(/^[A-Za-z]/.test(hintChord) ? hintSaid === '' : /^[A-Za-z]+( [A-Za-z0-9]+)+$/.test(hintSaid),
    '...and the deck ANNOUNCES it in words exactly when it DRAWS it in glyphs, the same test the setup page makes'
    + `  drawn "${hintChord}", announced "${hintSaid || '(nothing — the text is already words)'}"`);

  /**
   * ON SCREEN, NOT MERELY IN `textContent` — because `.hint` is
   * `overflow: hidden; text-overflow: ellipsis; white-space: nowrap`, and the
   * chord is the LAST thing on the line. Everything above reads `textContent`,
   * which survives clipping perfectly intact: a chord ellipsised away is a chord
   * every assertion in this block still passes on.
   *
   * THE SENTENCE GREW BY THE LENGTH OF A KEY CAP in this slice, so this is the
   * line that goes red the day it grows again past the width the deck actually
   * gets. `scrollWidth === clientWidth` is the whole test on a nowrap box.
   * FLOOR: a chord must be drawn at all, so an empty hint cannot pass it by
   * being trivially narrow.
   */
  const hintBox = await frame.locator('#src-sub')
    .evaluate((el) => ({ scroll: el.scrollWidth, client: el.clientWidth }))
    .catch(() => null);
  ok(hintChord !== '' && !!hintBox && hintBox.scroll <= hintBox.client,
    '...and the whole sentence FITS the deck, so the chord is not the first thing an ellipsis eats'
    + `  #src-sub scrollWidth ${hintBox ? hintBox.scroll : '?'} px, clientWidth ${hintBox ? hintBox.client : '?'} px`);

  /**
   * THE CHORD IS READ FROM THE PLATFORM, AND THIS IS THE ONLY ARRANGEMENT IN
   * WHICH THAT CAN GO RED.
   *
   * The equality above compares the deck's chord with the browser's, and on
   * every machine that runs this suite those are the same string for a second
   * reason: the manifest suggests it. So the command table in the DECK'S FRAME
   * is replaced, before the frame exists, with a chord no manifest in this repo
   * declares and no keyboard in this harness is bound to — and the deck is
   * remounted so its boot read runs under the replacement. A deck that types a
   * chord, or that calls `host.armShortcut()` and discards the answer, now draws
   * `Ctrl+Shift+9` at a browser that says `Alt+Shift+7`.
   *
   * WHY AN INIT SCRIPT AND NOT A PATCH AFTER MOUNT: the chord is asked for ONCE,
   * at boot, and never followed (a rebind happens on another page, and this deck
   * is created by the arm gesture). There is no second read to intercept, so the
   * patch has to be in place before the frame's module evaluates.
   *
   * WHY A REMOUNT AND NOT A RELOAD: `content.js` owns the frame, `mount()` is a
   * no-op while one is connected, and `'toggle'` from the service worker is the
   * gesture that removes it. Two real messages on the real bus, which is this
   * file's technique everywhere else.
   *
   * THE INJECTED CHORD IS DELIBERATELY NOT THE MANIFEST'S in either of its
   * parts: `Alt` is not `Ctrl`, `7` is not `9`. A deck that got half of it from
   * the platform and half from a template cannot pass.
   */
  const INJECTED_CHORD = 'Alt+Shift+7';
  await page.addInitScript((chord) => {
    // Only the extension frame HAS a command table; the YouTube page has no
    // `chrome` at all and must be left exactly as it was.
    try {
      if (globalThis.chrome && chrome.commands && typeof chrome.commands.getAll === 'function') {
        chrome.commands.getAll = () => Promise.resolve([{ name: 'arm-tab', shortcut: chord, description: '' }]);
      }
    } catch (e) { /* a context without `chrome` is not one we meant to patch */ }
  }, INJECTED_CHORD);

  await sw.evaluate(async (tabId) => {
    const msg = (mode) => chrome.tabs.sendMessage(tabId, {
      v: 1, to: 'tab', from: 'sw', type: 'STEM_SPLITTER_LIVE_EMBED', mode,
    });
    await msg('toggle');   // the show/hide gesture: this removes the frame
    await new Promise((r) => setTimeout(r, 200));
    await msg('show');     // and this builds a new one, under the patch
  }, armedTabId);

  // Wait for the CONDITION, not for a clock — the same shape as the remount
  // above. A deck that draws the wrong chord spins to the cap and then reports
  // the chord it drew, which is the sentence worth reading.
  let injChord = '', injMs = 0;
  {
    const t0 = Date.now();
    for (;;) {
      injChord = ((await frame.locator('#src-chord').textContent().catch(() => '')) || '').trim();
      injMs = Date.now() - t0;
      if (injChord === INJECTED_CHORD || injMs > BOOT_BUDGET_MS) break;
      await page.waitForTimeout(16);
    }
  }
  const injSaid = await frame.locator('#src-chord')
    .evaluate((el) => el.getAttribute('aria-label') || '').catch(() => '');
  ok(injChord === INJECTED_CHORD && injSaid === '',
    'THE DECK DRAWS WHAT THE PLATFORM RETURNED: a command table answering with a chord no manifest here declares puts THAT chord on the deck'
    + `  the frame's chrome.commands.getAll() was made to answer "${INJECTED_CHORD}" and the deck drew "${injChord}"`
    + `${injSaid ? `, announced "${injSaid}" — a chord already drawn in words needs no accessible name` : ''}`
    + `  (settled in ${injMs} ms of ${BOOT_BUDGET_MS})`);
} catch (e) {
  /**
   * AN UNEXPECTED THROW IS ONE RED, NOT A CRASH — because a crash is loud but
   * it is not a VERDICT, and it denies one to every assertion after it.
   *
   * This was not hypothetical. A `.click()` on an `aria-disabled` button timed
   * out at line ~840 and threw; the exception escaped this block, so the summary
   * line below never printed and the run ended in a stack trace with 65 of the
   * file's assertions reported and the rest simply absent. `tools/verify.mjs`
   * did classify it RED (non-zero exit), so nothing was hidden — but "CRASHED
   * after start" is the least informative true thing available, and 28
   * assertions went unrun in every run for as long as it stood.
   *
   * WHAT THIS DOES AND WHAT IT DELIBERATELY DOES NOT DO. It converts the escape
   * into one failing assertion, so the run prints its summary, its count and its
   * named failures — a verdict. It does NOT resume the suite. This file is one
   * long stateful gesture: the deck is armed, the model declined, the speed at
   * home, the transpose swept back. Continuing past an unexpected throw would
   * emit reds that are cascade artefacts rather than verdicts, which is the
   * expensive kind of noise (AGENTS.md: a red is either investigated or the
   * assertion is corrected).
   *
   * The right granularity is at the gesture: a step that can legitimately fail
   * to EXECUTE catches its own throw and turns it into that step's red, the way
   * the forced click in the ad-gate block does and the way `test.js` does at
   * every `runChunk` that can reject. This catch is the backstop for the ones
   * nobody predicted, and the shrinking assertion count in the summary is
   * itself the report that the run was truncated.
   */
  ok(false, `the suite ran to the end — it THREW instead: ${String(e && e.message).split('\n')[0]}`);
  console.error(e && e.stack ? e.stack : e);
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}

console.log(fails ? `\n${fails}/${checks} FAILED` : `\nembed-smoke: ${checks}/${checks} passed`);
process.exit(fails ? 1 : 0);
