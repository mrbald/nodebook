# Explore the knowledge map

The knowledge map shows links between notes in a vault. Open a note and choose **View → Knowledge Map** to explore its neighbors. Choose **Whole vault map** in the sidebar to find well-connected notes across the vault. A search result's **Show on map** starts at that result.

## Follow a connection

1. Select a note and point to one of its lines. The map shows the relationship and the note at the other end. If two relationships share a line, you can read both names. If the destination is offscreen, look for its name at the edge of the map.
2. Click the line to select its destination. Where lines cross, choose the name you want or press Escape to dismiss the choices. If the destination is outside the map window, the map pans just far enough to show it at the same zoom. **Back to previous note** restores your starting note and view. In the right panel, point to a relationship or focus its linked title to trace it. Click the title or press Enter to follow it.
3. Use **Focus here** to build a local map around the selected note, or **Open ↗** to read it. The local **Depth** controls show one to three steps in either direction. **Expand** adds neighbors around one note.
4. To reduce clutter, hide a relation type in the legend or right-click a note to hide it. **show all** restores them. Vault maps hide source-document hubs by default. Switch **Source** on to include them.

The whole-vault map starts with a limited set ranked by the number of connections. Use **show more** when the panel offers it. A dashed outline indicates a link target that has no note yet. Two files with the same name keep separate nodes. A folder-qualified wikilink can disambiguate its target. [Graph queries and link resolution](../src/main/graph.ts)

## Choose what to keep

| Action | What happens |
| --- | --- |
| Drag, pin or hide a note, or hide a link type | Changes the open map. **Clear placements** resets dragged positions and pins. |
| Choose a layout | Nodebook remembers the choice across note maps and restarts. **Force** is the initial layout. **Routed (ELK)** shows directed connections in layers. The standalone book theme overview has its own arrangement. |
| Choose **+ name** on an outgoing plain link in an editable vault note | Writes a typed field such as `cites:: [[Field notes]]` into the source note. Reindexing updates the map. Staged notes are read-only. |
| Write a file ending in `.map.md` | Keeps your own outline and any explicitly listed edges in a Markdown file. Open it in Nodebook to browse the collapsible outline. |

There is no **Save view** command for capturing filters, placements and focus. To keep a particular reading order, write an outline with a text editor in the vault, for example `Fieldwork.map.md`.

```markdown
# Fieldwork
- [[Field notes]]
  - [[Interview guide]]

## Edges
- [[Field notes]] cites [[Interview guide]]
```

Indentation puts the interview guide under field notes. The last bullet names a connection for this outline. The knowledge map reads relationships from the notes themselves and excludes outline files. [Outline format](../src/renderer/src/map/parseMap.ts)

## How the map stays current

The index stores each note's path and the relations found in its text. Saving a note updates those rows. The map queries a slice of them. It preserves the direction of each relation even when two notes link to one another. A tree layout changes their placement on screen. An outline can show one reading order through a graph with many other paths.

Force layout reuses positions when the same map changes and respects manual placements. Other layouts include **Tree**, **Radial**, **Groups** and **Blocks**. For how Nodebook computes sizes, colors and theme groups, see [Automatic map structure](auto-mindmap.md). For what is stored on disk, see [State ownership](state-and-scopes.md).
