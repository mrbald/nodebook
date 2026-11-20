# Turn a document into cited notes

Open a vault and choose **File → Distill a Document…**. Nodebook asks a model to draft notes from the document. You can open each note beside its source passage, check the quote, and decide whether to add the notes to your vault. Each import gets its own saved run, so you can read the same book with a different focus.

## Choose a file and a provider

Nodebook reads PDF, EPUB, Word `.docx`, HTML, Markdown and plain text. Save an older Word `.doc` as `.docx` first. Keep the original file if you will need its layout, pagination or illustrations. The source that Nodebook saves is a Markdown conversion.

For a document with text, open **Settings**, set a provider under `[talk.chat]`, and save. Extraction sends passages, your optional focus and previously identified concept names to that provider. To name themes, Nodebook can also send draft titles and summaries. Ollama uses a local server by default. For Ollama and OpenAI-compatible servers, the configured address determines the destination. Anthropic and signed-in Codex or Claude Code use their provider services. A custom `cli` receives the prompt through the command you set. [Command-line provider setup](cli-providers.md)

1. Select the file. For text, Markdown or HTML, read the encoding preview. If the letters look wrong, select another encoding and check again. Nodebook reads the original bytes locally.
2. Leave the focus blank for a general reading, select **Arguments**, **Timeline** or **People**, or enter your own request. For example, enter “Which conclusions do the authors support with experiments?” Select **Distill**.
3. Read any warnings about missing PDF text, skipped figures or pages the importer could not inspect for figures. Continue if the available material is enough. Otherwise cancel and choose a more complete edition. An OCR edition can supply searchable page text for a scanned PDF. When a file has preserved figures but no usable authored passages, Nodebook can stage the source and images without calling a model.
4. If the reading exceeds your budget, the dialog shows how many evenly spaced steps it will read and the estimated share of the extracted text. Accept that reading or cancel, raise `[distill] maxCalls` in Settings, and start again. The default is 120 planned reading steps. Retries, splitting a long step, and naming themes can add provider calls.

A run reads the selected passages in document order. The completion message reports how much extracted text received a usable answer and counts missing or ambiguous quotes. A PDF can have missing pages even when the model reads 100% of the extracted text.

## Pause or resume a run

Choose **Pause** in the progress indicator. Completed steps stay in the vault. Switching to a different vault also pauses the run. Open the same vault and choose **Resume** under **Distilled runs** to continue. If the provider stopped responding, check its address, credentials or CLI sign-in in Settings before resuming. Only one run can be active at a time.

## Check a claim against its source

1. Under **Distilled runs**, open the run. Choose **Scope → Standalone** to see its book. On a note map, double-click a content note or focus it and press Enter. In a theme overview, select a theme and open a note from its list.
2. Under **Sources**, choose a page or section and its quote. Read the highlighted passage in context. Check whether the summary follows from it and whether relationships point in the right direction. Each extracted concept, claim or entity needs a matching quote. Theme names and links are suggestions to review.
3. Return to the note using the button with its name, then go back to the map. **Scope → Overlay** puts the staged book and your existing notes in the same view. The **Origin** colour key identifies the two sets. A dotted line joins notes with the same name for review.

**View → Themes** is available when the book has at least two themes and at least one note clearly belongs to a single theme. Select a theme to see its members. Choose **Explore** for the member map or a list of subthemes. Select a link count between two themes to see the note pairs behind it. **Unassigned notes** lists notes outside these groups when there are any. Choose **View → Note map** for the whole book. By default, eligible books with more than 200 content notes open on Themes. Change `[distill] themeOverviewThreshold` in Settings and reopen the book to use a different threshold. Use `0` to start on Themes whenever available.

### Read charts and illustrations

PDF, EPUB, Word and HTML imports can preserve figures. HTML import reads supported local or inline images and skips remote images. PDF figures may be cropped from a page or kept as a page image. The importer reports skipped candidates and uninspected pages when applicable.

Open an image in the source, or choose one from **Figures** beside a note that cites its page or section. **Actual size** enlarges small labels. When the list has several figures, use **Find a figure** to search by label, caption or recognized words. Open **Text recognized in figure** to read the available transcription. After merge, use the vault search box and choose **View figure**. Text recognition runs locally with Apple Vision on macOS or an installed Tesseract on other platforms. It can miss or misread labels.

Choose **Analyze figure** to send that image, its label, location, caption and available recognized text to the displayed provider. The model must accept images. The answer appears under **AI interpretation** and is saved in this app profile. Check numbers, units and trends against the image. Ordinary text distillation uses authored passages and excludes the generated image links and recognized text as evidence.

## Merge the notes you reviewed

Choose **Merge book…** on the run's toolbar. Read the preview before choosing **Merge**.

| What the preview finds | What Merge does |
| --- | --- |
| A new note | Copies it into `Distilled/<run>/` as editable Markdown. |
| A note with the same name and identical content | Skips the copy. |
| The same name with different content | Keeps both. The new file gets the name shown in the preview, such as `Options (Sapiens)`. |
| A possible match under another name | Offers a checkbox when semantic search finds a close match. Leaving it empty keeps the notes separate. |

For any suggested match, tick the checkbox only when both notes describe the same thing. Merge writes `same_as:: [[Other note]]` into the new copy. The map shows one dot. Opening either note brings the other's summary, quotes and sources into the side panel. Both files remain editable. Delete the `same_as` line to separate them again.

The converted document goes into `Sources/`, with its figure files under `Sources/figures/`. Runs can share an identical source. Open a merged note's **Sources** to read a citation. Open the source note itself and choose **Open original** to launch the file in its usual app if it is still at the recorded path. The **Source** toggle shows source documents on a vault map.

## Undo, discard or restore

| What you want to do | What happens |
| --- | --- |
| Remove a merge | Open the merged run and choose **Undo** in the banner. If you dismissed it, choose **Undo merge** in the book toolbar. Nodebook removes unchanged files added by the merge. It sends edited merged files to the system Trash for recovery. It keeps sources shared by other recorded merges and figure assets still in use. You can merge the staged run again. |
| Remove a staged run | Choose the discard button beside the run and confirm **Discard**. This deletes its staged notes and its checkpoint. A paused run loses its progress. Discarding a merged run leaves the vault copies in place **and removes the Undo merge action**. Undo first if you want to remove those copies too. |
| Restore a vault from backup | Restore the vault folder with `Distilled/`, `Sources/`, their figure files and the hidden `.distill/` folder, then use **File → Open Vault…**. `.distill/` holds unmerged work and undo records. The vault index in `.nodebook/` can be rebuilt. For **Open original**, keep the original document at its recorded path. To recover saved reading copies and figure interpretations, restore the app profile too and open the vault at its original path. |

### Recover readable text from an older import

For an older staged plain-text or Markdown source with damaged characters, choose **Scope → Standalone**, then **View → Note map** if the book opens on its themes. Open the source document node. Choose **Locate original…** and select the original text or Markdown file. Nodebook checks that its bytes reproduce the damaged text. A newly saved copy containing only replacement characters cannot restore the missing letters.

Check the encoding preview and choose **Use reading copy**. **Show run text** lets you see the earlier text. Nodebook saves the corrected display copy in this app profile. The old notes, their citations and the merged source still use the historical text. To generate corrected notes and citations, distill the original file as a new run with the right encoding.

## Maintainer reference

### Files and recovery contracts

| Location under the vault | What depends on it |
| --- | --- |
| `.distill/sources/<sha1>.md`, `.distill/sources.json` | The converted text is identified by its hash. The source record tracks the original file and its revision, conversion details and figure inventory. Validated images use `sources/figures/<sha256>.<ext>` within `.distill/`. A preview can read a prior conversion. Starting the run publishes a new one. |
| `.distill/<run>/run.json`, `source.md`, `progress.jsonl` | The run records its source, start time, provider/model and optional focus. Resume uses the saved text, window plan and completed steps. A different focus starts a separate run. |
| `.distill/<run>/notes/`, `meta.json`, `run.db` | The Markdown files and referenced figures are the staged book. `meta.json` marks completion and records the source, note count and available hash, focus, themes and statistics. `run.db` is a rebuildable index for this run. Staged notes stay outside vault search and backlinks until merge. |
| `.distill/<run>/merge.json` | Merge records destination paths and hashes before copying. Writes use temporary files and rename. Undo uses the record to remove unchanged files and send edited or unverifiable files to Trash. Merge rechecks a proposed `same_as` against the named target before writing it. |

Citations use single-colon frontmatter fields for source, chunk, offsets, quote and page or section. The Markdown body has `source:: [[Book]]` and other `key:: value` relationships for the index. A citation resolves against the converted source note, including its generated header. Conversion retains page headings and preserves fixed-pitch PDF code listings where recognized. [Note format](../src/main/distill/emit.ts) · [Source storage](../src/main/distill/sources.ts) · [Run files and merge](../src/main/distill/artifact.ts)

### Reading and checking the text

The planner packs consecutive chunks into windows. A window includes the focus and titles already found. An oversized request can split into shorter ones. Persistent provider failures across three successive windows stop the run. Coverage counts the weight of text for which the model returned a usable response. Missing pages, sampled windows and failed requests measure different losses. [Planner and retries](../src/main/distill/run.ts)

Extraction checks the chunk named in the reply first. If the quote is missing there, it searches the rest of that window and then the document, accepting only a unique fallback match. It keeps the actual source span and drops an item with no surviving evidence. It combines near-duplicate titles, remaps their links, and adds links for explicit mentions. Distinct concepts may cite the same passage. Local embeddings group larger results into themes after extraction. A failed theme pass can leave a usable run of cited notes. [Quote matching](../src/main/distill/extract.ts) · [Figure evidence tests](../src/main/distill/sourceEvidence.test.ts) · [Duplicate handling](../src/main/distill/dedup.ts)

### Reproduce the measurements

Run `npm run eval:distill` for an offline check of conversion, coverage, citations and links. The fixtures are seven Federalist essays (`book-en`), a generated PDF (`paper.pdf`) with running headers and broken lines, and a Chekhov story (`chapter-ru.md`). The default uses a deterministic text extractor and a hashing embedder. A real chat provider replaces the extractor while the embedder stays fixed. The harness saves the scores and the notes used to compute them under `scripts/out/`. [Harness](../scripts/distill-eval.test.ts) · [Golden concepts and edges](../e2e/fixtures/distill/golden.json) · [Scoring](../src/main/distill/eval/metrics.ts)

```sh
# Use a signed-in provider. This uses its account limits.
DISTILL_EVAL_PROVIDER=claude-cli DISTILL_EVAL_MODEL=sonnet npm run eval:distill

# Re-score the saved outputs for that provider without another model run.
DISTILL_EVAL_PROVIDER=claude-cli DISTILL_EVAL_REPLAY=1 npm run eval:distill
```

Other providers use `DISTILL_EVAL_MODEL`, `DISTILL_EVAL_BASE_URL`, `DISTILL_EVAL_COMMAND` and the corresponding API key as needed. `npm run test:e2e` exercises the app with test providers. `npm run test:e2e:live` exercises the built app with real embeddings and a signed-in Claude Code CLI. It uses the network and checks whether each note belongs to one theme and whether theme names are distinct and in the document's language. [Live test](../e2e/live/distill-live.spec.ts)

The offline evaluation checks conversion, passage coverage, quote matching and links. The stub extracts items with fixed rules. Use real-provider trials to assess how well a model understood the text.

### Recorded results, September 2026

In the 2 September fixture runs, sampling four passages per cluster covered 34% of the English essays, 39% of the PDF and 56% of the Russian story. Reading consecutive windows covered 100% on all three with the deterministic extractor. On the English essays, the note count per 10,000 characters rose from 5.36 to 10.34, and five disconnected groups became one. On a separate 26-page pandas sample, fourfold larger windows reduced Haiku's output from 50 to 24 items. An earlier rule merged notes whenever they shared a quote. It made 85 of 132 merges on the pandas book, all judged incorrect in that inspection. These observations informed the window budget and title-based duplicate handling.

The 2 September live app run used `federalist-84.md` (25 KB), real local embeddings and Claude Code with Sonnet. Five windows yielded 49 extracted items with matching quotes. After five merges, the map contained 44 notes, seven themes, 136 edges and no unresolved targets. The run took 6.4 minutes including the first model download.

On 3 September the harness changed edge precision to count only predicted links whose endpoints map to two distinct concepts in the curated answer set. A missing expected link counts against recall. An unlisted relationship between two known concepts counts against precision even if the relationship is valid. The answer set covers few pairs, so read precision with its denominator. The table uses the revised scoring rule.

| Fixture | Stub concept recall | Stub edge precision (pairs judged) | Sonnet concept recall | Sonnet edge precision (pairs judged) | Sonnet edge recall |
| --- | ---: | ---: | ---: | ---: | ---: |
| English essays | 0.32 | 0.17 (6) | 0.27 | 0.50 (6) | 0.14 |
| Generated PDF | 0.29 | 0.00 (2) | 0.43 | 0.50 (4) | 0.09 |
| Russian story | 0.26 | 0.60 (5) | 0.26 | 0.75 (4) | 0.14 |

Two Sonnet runs on the same English essays produced concept recalls of 0.45 and 0.27, with two and nine merges respectively. The full three-fixture runs took 24 and 23 minutes. The second run supplied the Sonnet values in the table. The November trials include direct review of claims and link direction on shorter excerpts. [Quality trials](quality-trials.md)

The [archived measurement tables](https://github.com/mrbald/nodebook/blob/v0.1.1/docs/distill-documents.md#L309-L457) include all recorded metrics and the earlier scoring rules.
