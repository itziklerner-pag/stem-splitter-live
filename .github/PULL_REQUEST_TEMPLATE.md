<!--
  Thanks for contributing. Keep this to one logical change — if it needs two
  subject lines, it is two PRs.
-->

## What this changes

<!-- One or two sentences. The subject line of the commit is usually enough. -->

## Why

<!-- The failure it prevents, or the decision it implements. -->

## Evidence

<!--
  If the change claims a number, put the number AND the window it was measured
  over. Never a median from a soak shorter than ~300 s. If it claims no number,
  delete this section.
-->

```
node tools/verify.mjs --quick
```

<!-- paste the summary line -->

---

## The three rules

These override everything else in the project, and a PR that crosses one is
rejected regardless of how well it works. Please confirm:

- [ ] **L1** — this does not obtain audio from anywhere other than
      `chrome.tabCapture`. No stream-URL resolution, no `yt-dlp`, no player-response
      parsing, and **no audio export**. The line is not "no files": a
      TRANSCRIPTION of what was heard is allowed, a COPY of it is not. The one
      thing this build hands over is a zip of `.mid`, and what holds the line is
      [`qa/midi-pack.mjs`](../blob/main/qa/midi-pack.mjs) against the
      `{application/zip, audio/midi}` allowlist in `extension/shared/midi.js` —
      widen that allowlist and the gate goes red. Not the absent `downloads`
      permission, which never enforced this
      ([ADR 0002](../blob/main/docs/adr/0002-midi-transcription-narrows-the-no-file-property.md)).
- [ ] **P1** — this adds no network request after the model download. No telemetry,
      no analytics, no error reporting, no fonts, no update pings.
- [ ] **M1** — this loads no remote code. Anything fetched is fetched as *data*
      and cached, never as script from a remote host.

## Checklist

- [ ] `node tools/verify.mjs --quick` is green
- [ ] Non-trivial logic leaves one runnable check behind, and I read
      [`AGENTS.md`](../blob/main/AGENTS.md) before writing the assertion
- [ ] I watched the new assertion **fail** on purpose before trusting it
- [ ] If this touches the audio path, I loaded it unpacked and listened to it
- [ ] Commits are signed off (`git commit -s`)
