# Connect notes from several sources

Merge a distilled book when you want its notes to appear in vault search, Ask and the knowledge map. Keep the run staged if you want to explore one reading on its own. You can import the same source with a different focus and compare the readings before merging. [Import, merge and undo](distill-documents.md)

## Decide whether two notes describe the same thing

1. Open the run's merge preview. A staged note with the same name and contents as a vault note can be reused. If the name matches but the text differs, Nodebook proposes keeping both files under distinct names.
2. With local search by meaning enabled, the preview can also suggest notes with different names. For example, “RL” and “Reinforcement Learning” might be a match. Check what both notes mean before accepting. “RL” could also mean something else.
3. Select the matches you agree with, then merge. For each confirmed pair, Nodebook adds a field such as `same_as:: [[Reinforcement Learning]]` to the incoming note. Leaving a suggestion unchecked keeps the two notes independent.

The map draws a confirmed group as one node and lists the other names as aliases. When you read a member note, its panel also shows the other members' summaries, quotes and citations. Shared citations appear once. Each contribution stays in its original file. Removing a `same_as::` line separates the notes if no other confirmed link still connects them. [Merge rules](../src/main/distill/mergePlan.ts) · [Combined citations](../src/renderer/src/twins.ts)

## How suggestions work today

Name matching works without an embedding model. For a new name, Nodebook can compare the incoming note's average passage vector with indexed vault note vectors. It proposes a pair only when each is the other's closest candidate and the score meets `[talk] relatedMinScore`. Each note gets at most one such proposal. When vectors are unavailable, the merge can proceed with name matching. The preview is checked again at merge time so that confirmation applies to the pair the user saw. [Similarity matching](../src/main/distill/sameAs.ts) · [Merge handler](../src/main/index.ts)

A vector describes the note as a whole. Two notes may discuss the same subject but make different claims. The text and its citations let the reader decide whether the proposed identity holds.

## Research on stable maps

The original plan had four stages. **K1** delivered merging into a vault, sharing a converted source and reading confirmed notes' evidence together. **K2** delivered both name-based and whole-note similarity suggestions. Finer comparisons at the claim or concept level, and optional model help choosing a common name, remain open.

**K3** asks how a small addition to the vault can produce a small, understandable map change. Force layout already reuses positions within a view. Persistent identities for groups across imports remain a proposal. One approach would match old and new groups by overlapping membership, carry forward names and colors, and require stronger evidence before splitting or joining groups.

**K4** would show the proposed structural changes, such as which notes joined a group or why a group split. The merge preview already lets you confirm note identity for one run. A general change history across runs remains open. Written links continue to update on save, while a durable identity change requires a decision recorded in the notes. [State ownership](state-and-scopes.md) · [Automatic map structure](auto-mindmap.md)
