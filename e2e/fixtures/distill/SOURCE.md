# Fixture provenance and licence (top-level files)

`book-en/` has its own `SOURCE.md`. This file covers the two fixtures that
live directly under `e2e/fixtures/distill/`.

## chapter-ru.md

Anton Chekhov, "Крыжовник" ("Gooseberries", 1898) — the second story of his
"little trilogy" (Человек в футляре / Крыжовник / О любви). Full text, ~19.8K
characters (brief target ~15K; kept whole rather than cut mid-scene, since a
truncated ending would make the golden concept/edge set less honest).

Text: Russian Wikisource, <https://ru.wikisource.org/wiki/Крыжовник_(Чехов)>,
fetched as wikitext and cleaned (dropped `<ref>` editorial footnotes and wiki
link brackets; no wording changed). Wikisource marks the page `PD-old-70`.

Licence: public domain — Chekhov died in 1904, more than 70 years before any
plausible use here, in every "life + 70" jurisdiction; the story was first
published in 1898 and is also public domain in the US (pre-1929).

## paper.pdf

Eighteen consecutive chapters (I-III, V-XVIII — chapter IV keeps its
original heading style rather than the synthesized `## N.` one; nothing is
missing) of Albert Einstein's *Relativity: The Special and General Theory*
(1916/1924, translated by Robert W. Lawson), ~77K characters of body prose.

Text: Project Gutenberg EBook #30155,
<https://www.gutenberg.org/files/30155/30155-0.txt>. Cleaned into
`paper-source.txt` (the input `scripts/make-paper-pdf.mjs` lays out into
pages): dropped Gutenberg's footnote markers/blocks and the equation-image
placeholders the plain-text edition leaves behind (`image001`, bare
one-line formulas like `x' = x - vt`) since a from-scratch PDF writer has
no math typesetting — the surrounding prose is unchanged, so a few
sentences now trail off where a dropped equation used to sit (an honest
side effect, and itself a realistic symptom of PDF text extraction losing
embedded formula images). Curly quotes/dashes and the handful of `°`/`->`
symbols were flattened to plain ASCII, matching the generator's plain
Helvetica/WinAnsi text writer. `make-paper-pdf.mjs` then adds the running
header, the page-number footer, and the deliberate mid-word line-break
hyphenation — none of that is in the source text.

Licence: Einstein died in 1955; the 1916/1924 work and this 2009 Gutenberg
translation edition are public domain in the US (pre-1929 publication) and
free of known copyright restrictions for this use.
