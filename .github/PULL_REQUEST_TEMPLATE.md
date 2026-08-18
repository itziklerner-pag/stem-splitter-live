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
      parsing, and nothing that lets the extension write a media file.
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
