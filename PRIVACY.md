# Privacy Policy

**Stem Splitter Live** · last updated 26 August 2026

## The short version

**Stem Splitter Live collects no data about you. None. There is no server to
send it to.**

The extension makes **exactly one network request in its entire lifetime**: it
downloads the machine-learning model, once, from a fixed public URL. After that
it never contacts the network again — not for telemetry, not for analytics, not
for crash reports, not for fonts, not for update checks of its own.

Your audio is separated on your own machine and never leaves it.

## What we collect

Nothing.

- No personal information, no name, no email address, no account.
- No usage analytics, no telemetry, no event logging, no crash reporting.
- No audio, ever. Not a sample, not a fingerprint, not a hash.
- No browsing history, no page content, no URLs.
- No cookies, no advertising identifiers, no device fingerprinting.
- No data is sold, shared, or transferred to anyone, because none is collected.

## The one network request

On first run the extension downloads the model weights (109 MB) from
`huggingface.co`, verifies them against a SHA-256 hash built into the extension,
and caches them on your device. This is an ordinary file download. It carries no
identifier of you or your installation beyond what any HTTP request necessarily
reveals to the host — Hugging Face's own privacy policy governs what they log.

After that download completes, **the extension works with every network
interface disabled.** This is not a claim we make loosely; it is one of the
project's acceptance tests.

## What is stored on your device, and only your device

| what | where | why |
|---|---|---|
| Your fader, mute, solo and transpose settings | `chrome.storage.local` | so the deck looks the same next time |
| Which tab you armed, and the last arming error | `chrome.storage.session` | cleared when you close the browser |
| The model weights | Cache Storage | so you download 109 MB once, not once per session |
| Separated stems for tracks you have played | OPFS (origin-private file system) | so replaying a track does not re-run the model. Capped at 4 GiB, oldest evicted first |
| The MIDI take you are recording, and the finished pack until you save or discard it | the deck's own memory, in the page — **not written to disk at all** | so a cancelled save dialog is not a lost take. Closing the deck, closing the tab or reloading discards it. Nothing about a take is persisted anywhere |

All of it is local. None of it is transmitted. Uninstalling the extension
removes all of it.

If you do save a MIDI pack, the resulting `.zip` is an ordinary file that goes
wherever your browser puts downloads. From that point it is your file and the
extension has no further relationship with it — it cannot read it back, and it
does not record that you saved one.

To clear it yourself without uninstalling: `chrome://settings/content/all` →
find the extension → Clear data.

## Permissions, and exactly why each one exists

Chrome shows you this list at install time. Here is what each entry is actually
for.

| permission | why it is needed |
|---|---|
| `tabCapture` | **The core function.** It is how the extension hears the audio your tab is already playing. It is what gets separated into stems. Capture only starts when you explicitly arm a tab by clicking the toolbar icon or pressing `Ctrl+Shift+9`, and only on that tab. |
| `offscreen` | The audio engine — the `AudioContext`, the model session, the worklets — has to live in an offscreen document, because a Manifest V3 service worker cannot host an audio graph. |
| `storage` | The local settings and armed-tab state in the table above. |
| `unlimitedStorage` | The model is 109 MB and the stem cache can reach 4 GiB. Chrome's default quota is not enough to cache either. |
| `activeTab` | Grants access to the tab you explicitly arm, at the moment you arm it, and no other. |
| Access to `youtube.com` | The deck is drawn into the YouTube watch page. The extension runs on no other site. |
| Access to `huggingface.co` | The one-time model download and nothing else. |

## What the extension deliberately does not do

These are architectural rules in this project, not just current behaviour. They
are enforced in code review and, where testable, by automated gates.

- **It never resolves, fetches, or parses a media stream URL.** No downloader, no
  `yt-dlp`, no stream-URL scraping. It reads exactly three values from the page's
  `<video>` element — whether it is paused, the current time, and the duration —
  to keep the deck in sync. It never reads `src`, `currentSrc`, `buffered` or
  `srcObject`, never calls `captureStream()`, and never runs code in the page's
  own JavaScript context.
- **It cannot produce a file that reproduces the audio it captured.** The one
  file it hands you is a MIDI transcription: note numbers, onsets, lengths and
  velocities, and no samples of anything. What holds that line is an allowlist
  of exactly two file types in `extension/shared/midi.js` and an automated gate,
  `qa/midi-pack.mjs`, which builds a real pack, asserts every entry of it begins
  `MThd`, and asserts that the same pack containing a WAV is **refused**. The
  extension still does not request the `downloads` permission and a check still
  asserts its continued absence — but that permission is no longer offered as
  the reason, because it never was one: any extension page can create a `Blob`.
  This claim was wider until 26 August 2026, and
  [ADR 0002](docs/adr/0002-midi-transcription-narrows-the-no-file-property.md)
  records what was narrowed and what it cost.
- **It loads no remote code.** Manifest V3 forbids it; the model and the runtime
  are fetched as *data* and cached, never as executable script from a CDN.

## Children

The extension is not directed at children and collects no data from anyone,
including children.

## Changes to this policy

If the data practices ever change, this document changes with it, the change is
noted in [`CHANGELOG.md`](CHANGELOG.md), and — as Chrome Web Store policy
requires — users are notified in the extension itself before the change takes
effect. Given that the current practice is "collect nothing", any change at all
would be a significant one.

**That last clause is an obligation on this release, and it is not discharged
yet.** The MIDI transcription added on 26 August 2026 does not change what is
collected — still nothing — but it does change what the extension can produce,
and the claim above it ("it cannot save a file") was narrowed to say so. The
in-extension notice this clause promises is **product work that must land before
release**, not after it: a clause that describes a mechanism the build does not
have is exactly the kind of sentence this document exists not to contain. It is
recorded here, in the document that makes the promise, rather than in a tracker.

## Verifying any of this yourself

You do not have to take our word for it. The extension is open source and has no
build step, so what is in the repository is what runs.

1. Open `chrome://extensions`, enable Developer mode, and inspect the offscreen
   document and the service worker.
2. Watch the Network tab. After the model is cached, you will see nothing.
3. Turn off Wi-Fi and use it. It works.

Source: <https://github.com/itziklerner-pag/stem-splitter-live>

## Contact

Questions about this policy: **privacy@stemsplitter.live**, or open an issue on
GitHub.
