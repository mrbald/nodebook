# What Nodebook stores and what it can rebuild

Back up your vault's Markdown files, linked assets and hidden `.distill/` directory. An unfinished or unmerged import can contain model output that exists only in its run folder. Keep the original documents too if you want **Open original** to keep working.

| Location | What it holds | What a rebuild does |
| --- | --- | --- |
| Vault notes, including `.map.md`, `Distilled/` and `Sources/` | Your text, links, outline maps, confirmed matches, merged notes, converted source documents and linked figures. | Nodebook reads these files to rebuild search and the graph. |
| `<vault>/.distill/` | Staged notes and source text, import checkpoints, source records and figures, and merge records used by Undo. | Keep these files with your vault. Running a model again may give different notes. |
| `<vault>/.distill/<run>/run.db` | One run's searchable index for browsing its staged notes. | Nodebook rebuilds this database from the run's files when it is missing. |
| `<vault>/.nodebook/index.db` | Vault search, indexed relations and local embeddings. | Nodebook rescans vault files. Rebuilding embeddings takes time and requires the model. |
| Nodebook's app profile | App preferences, the remembered layout, saved reading copies for damaged text imports, and cached figure analyses. | Keep a separate profile backup. Saved reading copies and figure analyses use the vault’s path when Nodebook looks them up. A reading copy changes how a historical source is displayed. Citations still refer to the original imported text. |

Older versions stored runs in `.nodebook/distill/`. Opening the vault migrates eligible runs to `.distill/`. If an older vault contains work you need, keep both directories until you have checked its runs. [Storage and migration](../src/main/distill/artifact.ts) · [Reading copies](../src/main/distill/readingCopy.ts)

## Which notes participate?

**Before merge**, each run has its own database. Vault search, Ask and the ordinary vault map read the vault index. The run's notes live outside it. **Standalone** shows a run by itself. **Overlay** temporarily combines its graph with the vault graph to let you compare them. Opening either view keeps the run staged.

**After merge**, the new notes live under `Distilled/<run>/`. The converted document goes into `Sources/`, where runs can share the same copy. Links and citations point to the vault files. A `kind:` in a note's frontmatter describes its content, for example a document, theme, concept, claim or entity. A whole document remains searchable. The map hides source hubs by default and whole-note similarity excludes documents. [Import and undo](distill-documents.md) · [Match decisions](body-of-knowledge.md)

The database boundary controls visibility. An earlier design proposed a `scope` column for authored, extracted, canonical, staged and saved-view records. Staged rows live in a separate database today, so a vault query cannot include them by accidentally omitting a filter. [Staged index](../src/main/distill/staged.ts)

## What records a decision?

Writing `same_as:: [[Existing note]]` in a note records a confirmed identity. A typed relation records a link's meaning. Editing and saving either field changes the graph after indexing. Read-time grouping, ranking and layout can be computed again.

A `.map.md` outline you write is also part of the vault. Focus, hidden notes and pins in an open graph are temporary. The layout choice is an app preference. A future named graph view would need separate storage so that regenerating it could never overwrite a person's outline. [Map controls and files](mindmap-mode.md)

## Limits for future changes

- **Evidence.** A distilled citation records a source span and supporting quote. Nodebook checks the quote when opening the source and can relocate it if the text moves. Combining conflicting claims across sources or tracking evidence finer than a quote remains open.
- **Undo.** The importer previews a merge, checks the plan again and writes a manifest of expected file hashes before copying files. Undo uses that record to remove unchanged files it owns, send edited ones to the system Trash, and preserve shared files still in use. A general transaction for changes spanning many independent imports remains open.
- **Scale and identity.** Performance trials cover particular vaults and books. A general capacity target and rules for persistent cluster identity across imports remain open. [Quality trials](quality-trials.md) · [Growing a vault across sources](body-of-knowledge.md)
