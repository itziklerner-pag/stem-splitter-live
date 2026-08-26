#!/usr/bin/env node
/**
 * ONE SHA-256 PER UNIT FILE — write `extension/unit.sha256`.
 *
 *     node tools/unit-hash.mjs            # rewrite the sums file
 *     node tools/unit-hash.mjs --print    # print it, write nothing
 *
 * WHY THIS FILE EXISTS. ADR 0001 decision 3 says a second product vendors the
 * engine and the deck "by pinned tag plus SHA-256, with the same discipline
 * `tools/fetch-vendor.sh` applies to ONNX Runtime". `fetch-vendor.sh` fetches a
 * pinned version and then compares each file against a hash recorded in the
 * script — `verify()` — and refuses the drop on a mismatch. This is the same
 * shape for the unit: the tag says WHICH bytes, the sums file says WHETHER they
 * arrived, and `tools/unit-check.mjs` is what stops the sums file drifting away
 * from the tree it claims to describe.
 *
 * THE OUTPUT IS `shasum -c` FORMAT ON PURPOSE, and that is the whole reason it
 * is a flat text file rather than JSON: a vendoring product verifies the copy
 * with a command it already has —
 *
 *     shasum -a 256 -c extension/unit.sha256      # macOS, and Linux with perl
 *     sha256sum -c extension/unit.sha256          # GNU coreutils
 *
 * — run from the copy's root, with no tooling from this repository at all. That
 * matters: the copy has not run `npm install`, may not have node on the path at
 * that point in its own bootstrap, and `docs/VENDORING.md` is written to be
 * followed by a human on a fresh machine.
 *
 * CONSEQUENCE: THE FILE CARRIES NO COMMENTS. Neither checker tolerates a line
 * it cannot parse — GNU `sha256sum` warns and exits non-zero on one — so
 * everything there is to say about the file is said here and in
 * `docs/VENDORING.md`. Paths are REPO-RELATIVE (`extension/...`) rather than
 * relative to the sums file, because the layout the copy preserves is the
 * repo-relative one and the checker resolves against the current directory.
 *
 * WHAT IS IN IT, AND WHY THE LIST IS DERIVED RATHER THAN TYPED.
 *
 *   - Every file ADR 0001 decision 3 names, read out of `extension/unit.json`'s
 *     `required` clauses — whole directories through `git ls-files`, explicit
 *     lists verbatim. That set is EXACTLY the crawl's closure, and it is not
 *     taken on trust: `tools/unit-check.mjs` asserts both inclusions already
 *     ("the closure contains …" and "every file the crawl reaches is a file ADR
 *     0001 decision 3 names"), so deriving from the declaration here and
 *     crawling there gives two independent routes to one list, each able to go
 *     red on a change the other cannot see.
 *   - `extension/unit.json` itself. It is declared `outside` the unit — it is a
 *     manifest, not code the unit runs — and it is hashed anyway, because it is
 *     the first file a vendoring product opens and it is the one that says what
 *     everything else must be. A copy that verified every file against a
 *     manifest it took on faith has checked its own homework. S11 decided this;
 *     the `outside` entry in `unit.json` asked the question.
 *
 * WHAT IS DELIBERATELY NOT IN IT — the two Host holes (`offscreen/host.js`,
 * `ui/host.js`), `offscreen/host-pin.js`, `content.js`, `speed.js`, the suites
 * and the runners. Those travel with a copy (`docs/VENDORING.md` says which and
 * why) but a hole is a file the copy REPLACES, so a recorded hash of ours is a
 * hash of a file that is not meant to survive contact. Hashing it would make the
 * expected case indistinguishable from the failure case, which is the shape
 * `AGENTS.md` is written against. The tag authenticates the rest of the archive.
 *
 * IT WRITES; IT IS THE ONLY TOOL IN `tools/` THAT DOES. `tools/unit-check.mjs`
 * and `tools/tree-check.mjs` read and nothing else, deliberately. This one is a
 * generator, so it is not a verify step and never runs inside
 * `tools/verify.mjs`: the gate is the ASSERTION in `unit-check`, and a generator
 * that ran as part of the gate would fix the drift it exists to report.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(ROOT, 'extension');
const DECL = path.join(EXT, 'unit.json');
const OUT = path.join(EXT, 'unit.sha256');

/**
 * The one path that is hashed without being unit. See the header: the manifest
 * is what everything else is verified against, so it is verified too.
 */
export const MANIFEST = 'extension/unit.json';

/** `.png` is the only thing under `extension/` with no source to classify; `tools/unit-check.mjs` uses the same predicate. */
const NOT_SOURCE = /\.png$/;

/**
 * The unit's files, repo-relative and sorted, exactly as `extension/unit.json`'s
 * `required` clauses declare them.
 *
 * A `dir` clause expands through `git ls-files`, so a new DSP module that
 * nothing imports is hashed the moment it is committed — which is the same
 * reason ADR 0001 decision 3 words those two clauses as directories.
 *
 * FAILS WHEN IT CANNOT LOOK. A clause that expands to nothing, or a declaration
 * that cannot be read, throws here rather than producing a short sums file: a
 * sums file with three lines in it verifies three files and reports success,
 * which is the green-on-nothing failure this repository has shipped four of.
 */
export function unitFiles(root = ROOT) {
  const decl = JSON.parse(fs.readFileSync(path.join(root, 'extension/unit.json'), 'utf8'));
  const clauses = decl.required || [];
  if (!clauses.length) throw new Error('unit.json declares no `required` clauses — there is no unit to hash');
  const out = new Set();
  for (const c of clauses) {
    const paths = c.dir
      ? execFileSync('git', ['ls-files', `extension/${c.dir}`], { cwd: root, encoding: 'utf8' })
        .split('\n').filter(Boolean).filter((p) => !NOT_SOURCE.test(p))
      : (c.paths || []).map((p) => `extension/${p}`);
    if (!paths.length) throw new Error(`unit.json clause "${c.adr}" expands to no paths — the glob is wrong, not the directory empty`);
    for (const p of paths) out.add(p);
  }
  out.add(MANIFEST);
  return [...out].sort();
}

/** `shasum -c` format: the digest, two spaces, the path. Nothing else on the line. */
export const sumsFor = (files, root = ROOT) => files.map((rel) => {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) throw new Error(`${rel} is declared by unit.json and is not on disk`);
  return `${crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex')}  ${rel}`;
}).join('\n') + '\n';

if (import.meta.url === `file://${process.argv[1]}`) {
  const files = unitFiles();
  const body = sumsFor(files);
  if (process.argv.includes('--print')) {
    process.stdout.write(body);
  } else {
    fs.writeFileSync(OUT, body);
    console.log(`unit-hash: ${files.length} files -> extension/unit.sha256`);
    console.log('           verify a copy with `shasum -a 256 -c extension/unit.sha256` from its root');
  }
}
