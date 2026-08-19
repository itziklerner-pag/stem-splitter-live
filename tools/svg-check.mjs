/**
 * Every tracked SVG is well-formed enough for a browser to load it as an image.
 *
 *   node tools/svg-check.mjs
 *
 * `brand/mark.svg` and `brand/wordmark.svg` both shipped with a literal `--`
 * inside an XML comment — `tokens.css --color-stem-*` and
 * `tokens.css --split-font-sans`, written the way the custom properties are
 * written everywhere else in the tree. XML forbids `--` inside a comment, so
 * both files were not XML, and had not been since they were drawn.
 *
 * WHY IT SURVIVED, WHICH IS THE WHOLE REASON THIS GATE EXISTS. An SVG is parsed
 * by two different parsers depending on how it is reached, and only one of them
 * is strict:
 *
 *   inlined into a document   HTML parser, lenient about `--`   renders
 *   fetched via <img src>     XML parser, strict                does not render
 *
 * `brand/render.mjs` takes the first path — it inlines the source into a page
 * and screenshots it — so every PNG the project ships kept generating correctly
 * from a broken source, including `extension/icons/48.png` and `128.png`. The
 * README takes the second path, and GitHub's own sanitiser hides the failure
 * there too. Nothing anyone looked at was visibly wrong. The file was.
 *
 * The consequence is narrow but real: `<img src="brand/mark.svg">` decodes to
 * nothing, `naturalWidth` is 0, and any surface that references the mark as an
 * image gets a broken-image glyph instead of the logo.
 *
 * Watched going red before it was gated: reverting either file turns it red,
 * and so does adding `--` to a comment in any of the four SVGs that were always
 * fine.
 *
 * ponytail: hand-rolled comment scan rather than a real XML parser, because
 * Node ships no XML parser and the failure class here is exactly one rule.
 * It answers "is this comment legal", not "is this document valid XML". If a
 * different malformation ever ships — an unclosed tag, a bare `&` — swap the
 * body for a real parse. The call shape stays the same.
 *
 * Scope is `git ls-files` — the tracked tree, which is what gets published.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.join(import.meta.dirname, '..');

/**
 * XML 1.0 §2.5: a comment is `<!--` … `-->`, the text between may not contain
 * `--`, and may not end in `-`. Returns the offending comments, each with the
 * line it starts on so the message points at something you can open.
 */
export function illegalComments(src) {
  const bad = [];
  let i = src.indexOf('<!--');
  while (i !== -1) {
    const end = src.indexOf('-->', i + 4);
    if (end === -1) {
      bad.push({ line: lineOf(src, i), why: 'comment is never closed' });
      break;
    }
    const body = src.slice(i + 4, end);
    if (body.includes('--')) {
      bad.push({ line: lineOf(src, i), why: 'contains `--`, which XML forbids inside a comment' });
    } else if (body.endsWith('-')) {
      bad.push({ line: lineOf(src, i), why: 'ends in `-`, which makes the closing `--->` illegal' });
    }
    // Resume just past `-->`. Advancing any further would step over a comment
    // that opens immediately after this one closes.
    i = src.indexOf('<!--', end + 3);
  }
  return bad;
}

const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;

let passed = 0, failed = 0;

/**
 * The runner classifies a suite that exits 0 while printing no count as VOID —
 * "silence is not a pass" — so every assertion here, self-check and file alike,
 * lands in one counter and one `N passed, M failed` summary line.
 */
function demo() {
  const one = s => illegalComments(s).length;
  const eq = (got, want, why) => {
    if (got === want) { passed++; return; }
    failed++;
    console.error(`x  self-check: ${why} — expected ${want}, got ${got}`);
  };

  eq(one('<svg><!-- plain --></svg>'), 0, 'a plain comment is legal');
  eq(one('<svg><!-- an em dash — is fine --></svg>'), 0, 'non-ASCII dashes are not hyphens');
  eq(one('<svg><rect/></svg>'), 0, 'no comment, nothing to say');
  eq(one('<svg><!-- a -- b --></svg>'), 1, 'double hyphen is illegal');
  eq(one('<svg><!-- tokens.css --color-stem-* --></svg>'), 1, 'the bug this gate exists for');
  eq(one('<svg><!-- trailing ---></svg>'), 1, 'a comment may not end in a hyphen');
  eq(one('<svg><!-- trailing - --></svg>'), 0, 'a hyphen before the space is fine');
  eq(one('<svg><!-- a -- b --><!-- c -- d --></svg>'), 2, 'each bad comment is reported');
  eq(one('<svg><!-- fine --><!-- a -- b --></svg>'), 1, 'a good comment does not mask a later bad one');
  eq(one('<svg><!-- never closed'), 1, 'an unclosed comment is caught, not ignored');
}

demo();

const files = execFileSync('git', ['ls-files', '*.svg'], { cwd: ROOT, encoding: 'utf8' })
  .split('\n').filter(Boolean);

// An empty tree is the VOID case wearing a summary line: the glob is wrong, not
// the repo clean. Fail rather than print `0 passed, 0 failed`.
if (!files.length) {
  console.error('x  no tracked SVGs found — the glob is wrong, not the tree clean');
  console.log('0 passed, 1 failed');
  process.exit(1);
}

let broken = 0;
for (const f of files) {
  const bad = illegalComments(fs.readFileSync(path.join(ROOT, f), 'utf8'));
  if (!bad.length) { passed++; console.log(`ok ${f}`); continue; }
  broken++; failed++;
  for (const b of bad) console.error(`x  ${f}:${b.line}  ${b.why}`);
}

if (broken) {
  console.error(
    `\n${broken} of ${files.length} tracked SVGs are not XML.\n` +
    'A browser renders these when they are inlined into a page and refuses to\n' +
    'render them through <img src>, so render.mjs will keep producing correct\n' +
    'PNGs from a file the README cannot display. See the header of this file.');
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
