# How Nodebook finds related notes and themes

A line on a note map can represent a link someone wrote or a suggestion based on similar wording and meaning. Vault themes are groups you can browse. Book imports can save themes as Markdown notes.

| What do you want to find? | Where to look | What the result means |
| --- | --- | --- |
| Which notes connect this part of the map? | Open a note map and choose **Colour → Links**. | Notes in the same link group share a color. A larger dot means the note ranks higher based on its incoming links and the importance of the notes linking to it (PageRank). |
| Which notes discuss a similar topic? | Enable local search by meaning. On a local vault map, use **Related**. For topic colors, choose **Colour → Meaning**. | A dashed Related line suggests an unlinked note. It writes nothing to either file. |
| Which groups can I browse across the vault? | Open **Whole vault map**, then **Themes**. | Browse groups or **Notes without a theme**. Each group's label comes from a representative note. Vault themes are read-only. |
| How is one imported book organized? | Open the run, choose **Scope → Standalone** and, when available, **View → Themes**. | The overview uses the book's stored theme notes and membership links. Inspect a connection between themes to see the notes and relationships behind it. |

## What determines a group?

**Link colors** use label propagation. Notes take the most common group label among their neighbors until the labels settle or the iteration limit is reached. **Meaning colors** apply that grouping to nearby note vectors. A note vector is the normalized average of the vectors for its passages. The `[talk] relatedMinScore` setting controls the minimum similarity used for Related and meaning colors. Source documents are searchable but excluded from these whole-note comparisons. [Map algorithms](../src/renderer/src/graph/structure.ts) · [Note vectors](../src/main/rag/store.ts)

**Vault themes** use links and any local note vectors already available. Strong links within a group help distinguish it from the rest of the vault. A single chain of weak links may leave notes ungrouped. Confirmed aliases count together. The calculation runs without a chat provider and never creates theme notes. Adding notes can change a group's members or representative title. [Vault theme calculation](../src/main/vaultThemes.ts)

**Distilled themes** group the run's generated notes by meaning. For a run with at least six notes, the importer can group their vectors using k-means. It asks the configured chat provider for names in a single batch, using member titles and summary excerpts. If naming fails, each unnamed group uses the title of the note closest to its center. The importer writes a theme note and a `part_of:: [[Theme]]` field in its members. A book overview derives its connections from links between those members. [Theme generation](../src/main/distill/themes.ts) · [Book overview](../src/main/distill/bookOverview.ts)

## Design options

The note graph can contain cycles and several relations between the same two notes. A generated hierarchy would summarize selected paths. Any future saved hierarchy needs its own representation to preserve hand-authored outlines. Other proposals include model-suggested names for vault groups or missing links, summaries for selected regions, and a 2D layout based on vector similarity. Current map controls and storage rules are described in [Explore the knowledge map](mindmap-mode.md) and [State ownership](state-and-scopes.md).
