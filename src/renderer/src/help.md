# Use Nodebook

A vault is a folder of Markdown notes. You can open the same files in another editor. Notes use CommonMark, with support for task lists, tables and links between notes.

## Create and save a note

1. Choose **File → Open Vault…** and select a folder, or **File → New Vault…** to start one. Use **File → Open Recent** to return to it later.
2. Choose **File → New Note**, give the note a name, and start writing. To put it in a particular folder, right-click the folder in the sidebar and choose **New note**.
3. Choose **File → Save**. A dot beside the note marks unsaved edits. By default Nodebook also saves when you switch away or close the window.

Under **Settings**, the `[editor]` option `autosaveDelayMs` sets how long to wait after you stop typing before saving. The default of `0` turns timed saving off. Set `autosaveOnSwitch = false` if you want to choose **Save**, **Discard** or **Cancel** when leaving an edited note. **Cancel** keeps the editor open with your changes.

If another program changes the file while you edit, **Overwrite** replaces its version with yours. If it removes the file, **Restore** writes your version back. Choose **Cancel** to keep editing and decide later.

Right-click a note or folder to rename or delete it. **Move to Trash** sends the saved files to your system Trash, where you can restore them. If the dialog mentions unsaved edits, choosing **Move to Trash** discards those edits.

## Write, read and print Markdown

Use **View** below the note. **Live preview** shows formatting as you write and reveals the Markdown around the cursor. **Code** shows the raw text. **Reading** opens a read-only view.

Try these in a note.

````markdown
# Field notes

- [ ] Check the date
- Record the **result** and its *source*.

> A quotation from the interview.

[Project website](https://example.org)

```python
print("First observation")
```
````

For a paper copy, choose **File → Print…**. To save the formatted note as a PDF, choose **File → Export PDF…**.

## Link two notes

Create and save a note called `Ada Lovelace`. In a second note, type `[[`, choose **Ada Lovelace** from the suggestions, and save. Click `[[Ada Lovelace]]` to follow the link. Use `[[people/Ada Lovelace]]` if different folders contain the same name. Match the spelling and case. In Code mode, hold Command on macOS or Ctrl on Windows and Linux as you click a link.

The right panel shows which notes link here. Give a link a name when the relationship matters. For example, this line in a book note puts its author on the knowledge map.

```
author:: [[Ada Lovelace]]
```

You can also record a plain value such as `status:: draft`. Put fields in the body of the note, outside code blocks, so Nodebook can index them.

## Find a note or ask a question

Choose **File → Find Note…**, type a few words from a note, then select a result. Use Down and Up to move through results and Enter to open one. **Show on map** opens the note's neighbours. Clear the search box to see the file tree again.

If search misses a file you added in another editor, reopen the vault from **File → Open Recent**. Nodebook checks the folder for changes when it opens. If a book import is running, let it finish first.

For words with a similar meaning, choose **Search by meaning** beneath the box, then **Enable**. The default multilingual model downloads on first use (about 285 MB). It indexes text on your computer. Use the same box to search in another language or for an idea expressed in different words. A sparkle marks a result found by meaning. **Turn off** removes the current vault's semantic index.

For a written answer, choose **Ask your notes**. It finds relevant passages by keyword and, when available, by meaning. It sends your question and those passages to your chat provider. If it finds no passages, it tells you before contacting the provider. Select a citation to read the passage in its note.

## Choose where questions and documents go

Choose **Settings** at the bottom of the sidebar and find `[talk.chat]`. Ask and text distillation use this provider. Semantic search works without one. Use **Reveal defaults** to see all the settings beside yours. Save the settings to apply them. **Reset to defaults** replaces your settings file.

- For a model on your computer, install Ollama, run `ollama pull llama3.2`, and set `provider = "ollama"` and `model = "llama3.2"`. The default address is local. If you set `baseUrl` to another host, it receives the requests.
- For an OpenAI-compatible server, set `provider = "openai-compat"`, `baseUrl` and `model`. Use `OPENAI_API_KEY` if the server requires a key. For the Anthropic API, set `provider = "anthropic"` and `ANTHROPIC_API_KEY`. Keys placed directly in Settings are stored as plain text.
- To use your signed-in Codex or Claude Code app, set `provider = "codex-cli"` or `provider = "claude-cli"`. The command runs on your machine, uses its provider service and counts against the account's limits. With `provider = "cli"`, your configured command receives the prompt on standard input.
- `provider = "none"` is the default. Keyword search and local search by meaning remain available.

## Explore the knowledge map

Choose **Map** beneath an open note to see its links, or **Whole vault map** in the sidebar to start with the most connected notes. Select a dot to see the note's title, excerpt and links in the right panel. Choose **Open ↗** to read it. The **Back to map** button returns you to your place. With the map focused, use arrow keys to move, Space to inspect and Enter to open a note.

To follow a connection, select a note and point to one of its lines. The map highlights the line and names the note at the other end, even if it is offscreen. Click the line or the name to select that note at the same zoom. Where lines cross, choose a destination by name or press Escape to dismiss the choices. **Back to previous note** returns to your starting place. To use the keyboard, Tab to a linked title in the right panel and press Enter.

- Use **Depth** on a local map to show more or fewer steps from the current note. **Expand** follows one selected note's links. A dashed outline marks a link whose note is missing.
- Drag the background to move around. Scroll or use **−** and **+** to zoom. Drag a dot to move it or choose **Pin** to keep it in place. **Fit view** brings the notes back into view. **Clear placements** removes manual positions and pins.
- **Layout** changes the arrangement. Each layout shows fewer titles when the map gets crowded. Point to a note for its title, or zoom in for more detail. **Routed (ELK)** shows the notes as cards when there is room to read them. Nodebook remembers your choice of layout.
- Select a relationship in the legend to hide or show its links. Right-click a dot to hide it. **show all** restores hidden items. On a local vault map, **Related** adds suggested connections based on meaning when semantic search is ready. To record a relationship on an ordinary outgoing link, choose **+ name**. This writes a field into the note.
- On the whole-vault map, choose **Themes** for groups based on your links and any local semantic index. Open a group or **Notes without a theme** to browse its notes. **Back to note map** restores the map. Turn **Source** on to include the source documents of merged books.

To keep your own outline as a map, write it in an ordinary note first. Save the note, then use **Rename** in the sidebar to give it a name ending in `.map.md`. Nodebook opens it as a collapsible tree. Indent bullets to put one item inside another. An optional **Edges** section names relationships.

```
- [[Computing]]
  - [[Analytical Engine]]
  - [[Ada Lovelace]]

## Edges
- [[Ada Lovelace]] studied [[Analytical Engine]]
```

## Distill a document into notes

1. Open a vault and choose **File → Distill a Document…**. Select a PDF, EPUB, Word `.docx`, HTML, Markdown or text file. Convert older `.doc` files to `.docx` first.
2. For text, Markdown and HTML, check the encoding preview. If the letters look wrong, choose another encoding. You can leave the focus blank, choose **Arguments**, **Timeline** or **People**, or enter your own. Select **Distill**. The provider receives passages of the converted document and your focus.
3. Check any warnings. For a PDF with missing text, continue with the extracted pages or cancel and use a text or OCR edition. If the reading exceeds your budget, the dialog shows what share of the extracted text it will read. Cancel and raise `[distill] maxCalls` in Settings for more coverage. A source containing only preserved figures can be staged without a model call.
4. When the run finishes, read the coverage message. Open its name under **Distilled runs**. In **Scope → Standalone**, choose a note on the book map and press Enter to read it. Under **Sources**, select a quote to see the surrounding passage. Use the back buttons to return. A matching quote tells you where to check the model's interpretation.

**Pause** keeps completed steps. Switching to another vault also pauses the run. Open the original vault and choose **Resume** under **Distilled runs** to continue. A second import of the same document creates a separate run.

Choose **View → Themes** when the book has at least two themes and at least one note clearly belongs to a single theme. Select a theme and choose **Explore** to see its notes. Select a connection count to see which notes connect two themes. Use the path above the map to go back. **View → Note map** shows individual notes. **Scope → Overlay** shows the book alongside your vault. A dotted line between two notes with the same name marks a possible clash to review at merge.

## Inspect a figure

Open a picture in a source, or select **Figures** beside a note that cites its page or section. Use **Actual size** for small labels. Use **Find a figure** to search a long list. Open **Text recognized in figure** to read any text Nodebook found in the image. After merge you can search the vault for a figure's label, caption or locally recognized text, then choose **View figure**.

**Analyze figure** sends the selected image, its label, location, caption and available recognized text to the provider shown. Choose it when you want an interpretation from a model that accepts images. The answer is saved as **AI interpretation** in this app profile. Check numbers and units against the figure itself.

## Merge, undo or recover a document

Choose **Merge book…** on a book's map. The preview lists new notes, identical notes it will skip, and name clashes. A clash gets a new filename. Tick a proposed match only if the notes describe the same thing. This adds a `same_as::` link to the new copy. The map then groups them, and each note's panel shows both sets of sources. Delete that link to separate them again.

Choose **Merge** to add editable notes under `Distilled/` and a converted source under `Sources/`. Open the source note and choose **Open original** to read the original file if it is still at its recorded location.

- To undo a merge, reopen the run and choose **Undo** in the banner. If you dismissed the banner, choose **Undo merge** in the book toolbar. Nodebook removes unchanged files added by the merge. Edited merged files go to the system Trash. A converted source shared by another merged run stays in use. You can reopen the staged book and merge again.
- **Discard** beside a run deletes its staged copy. For a paused run this loses its progress. For a merged run the vault copies stay, but you lose **Undo merge**. Include the hidden `.distill/` folder in vault backups to keep staged runs and their undo records. Keep the original documents separately.
- If an older staged text or Markdown source shows damaged characters, choose **Standalone** and open the book’s **Note map**. Open its source document and choose **Locate original…**. Select the original bytes, check the preview and choose **Use reading copy**. This copy is for reading in this app profile. The existing notes, citations and merge still use the historical text. Import the original again for notes based on the corrected text.

## Keyboard shortcuts

Use Command on macOS and Ctrl on Windows and Linux with each key below.

- **O** opens a vault. **N** creates a note. **K** finds a note.
- **S** saves the open note or settings. **P** opens Print.
- **1** shows Code. **2** shows Live preview. **3** shows Reading.
- **E** switches to Reading or returns from Reading to Live preview.
- **G** opens the current note's knowledge map. **Comma** opens Preferences.
