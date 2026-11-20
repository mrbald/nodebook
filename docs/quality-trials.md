# Nodebook quality trials

These November 2026 trials compare graph layouts, local search models and book imports. The timings describe the tested Mac and fixtures. The product guides cover the current controls. [Maps](mindmap-mode.md) · [Search](talk-to-docs.md) · [Book imports](distill-documents.md)

## How two layouts handled a crowded map

On 18 November, Force laid out the 11-note vault in 2 ms. On the 200-note book map, Routed eliminated overlapping node boxes and reduced the longest gap between screen updates from 272 ms to 10 ms. Its routes crossed one another more often.

| Fixture | Layout | Overlapping node boxes | Links crossing unrelated node boxes¹ | Edge crossings² | Time to layout | Longest frame gap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Linked vault, 11 notes, 27 links | Force | 2 | 7 | 21 | 2 ms | 10 ms |
| Same vault | Routed | 0 | 0 | 15 | 89 ms | 10 ms |
| Staged Federalist book, 200 notes, 613 links | Force | 1,458 | 5,798 | 4,872 | 271 ms | 272 ms |
| Same book | Routed | 0 | 0 | 12,980 | 394 ms | 10 ms |

¹ A link crossing two unrelated boxes counts twice. ² An intersection inside two edge segments counts as a crossing. Touches and shared straight segments are excluded.

When the book map expanded to 299 notes and 849 links, Routed attached all 849 routes and kept the node boxes apart. The book came from a saved September Federalist import. The trial reused that output. It informed the v0.1.1 layout defaults. This checkout opens note maps in Force by default.

## What local search found

The default E5 model worked on the bundled WebAssembly runtime. EmbeddingGemma 2 found one more relevant note for a Russian question and ran on WebGPU. Its q4 and q8 versions failed to load on the tested WebAssembly runtime, which lacked the quantized gather operation they needed.

| Question set | Keyword | E5 hybrid | EmbeddingGemma 2 hybrid |
| --- | ---: | ---: | ---: |
| English question, English note, relevant note in top 5 | 0/12 | 12/12 | 12/12 |
| Russian question, same English note, relevant note in top 5 | 0/12 | 11/12 | 12/12 |
| Two-source question, at least one relevant note in top 5 | 0/6 | 6/6 | 6/6 |
| Two-source Ask, all annotated supporting sentences in eight passages | 5/6 | 6/6 | 6/6 |
| Warm search p95 | 0.9 ms | 37 ms | 23 ms |
| Peak sampled renderer working set | — | 1,997 MiB | 1,333 MiB |

**What the scores mean.** The fixtures contained 72 notes and 30 questions with human annotations. A search hit counted if the annotated note appeared in the first five results. An Ask result counted if its eight retrieved passages contained all the annotated supporting sentences. These were natural questions. A title or identifier lookup is a different test. Sidebar keyword search required every query term. Ask also searched for terms independently.

**How to reproduce the sample.** For XQuAD, take the first English paragraph and question from every fourth article in the first 48. Match each Russian question to its English note by ID. For HotpotQA, take the first six distractor-validation records and all ten context articles per record. [XQuAD](https://github.com/google-deepmind/xquad) · [HotpotQA](https://hotpotqa.github.io/)

**Timing and memory.** The Apple silicon package used Electron 43.3.0, locally served weights and one worker at a time. Warm search p95 is the time within which 95% of measured searches finished. It includes worker inference and SQLite lookup. It excludes the delay after typing and the time to draw results. Memory is the sampled renderer working set. Separate GPU-process memory was unmeasured.

E5 used Transformers.js 4.2.0, q8 WASM, four threads and the product’s query and passage prefixes. The experimental Gemma worker used Transformers.js 4.3.1, q4 WebGPU, document titles and separate prefixes for search and questions. [E5 weights](https://huggingface.co/Xenova/multilingual-e5-base/tree/1ec9243030a27d1a115d5c340572074c125b58b2) · [Gemma weights](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0)

## How well imported notes represented the source

**Same reading, four imports.** Each run read lines 44–87 of Federalist 10 and 81–101 of Federalist 47. The focus asked for claims, qualifications and relationships. The production pipeline used one extraction call, a fixed test embedder and one call to name the themes. A separate model reviewed the excerpts and the anonymized results.

The six target ideas were the definition of faction, its two remedies, liberty as a condition of faction, unequal faculties and property, partial versus whole departmental power, and the examples of vetoes and appointments. The reviewer checked two claims and every explicitly typed factual link, including its direction. Source, theme, mention and topic links were excluded.

| Masked output | Provider model | Ideas covered | Sampled claims supported by their quotes | Factual links supported in the stated direction | Wall time | CLI-reported USD equivalent |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Elm | Sonnet 5.5 | 6/6 | 2/2 | 5/8 | 16.8 s | 0.069 |
| Ash | Sonnet 5.5 | 6/6 | 2/2 | 4/5 | 17.9 s | 0.049 |
| Oak | Opus 5.5 | 6/6 | 2/2 | 5/5 | 33.7 s | 0.171 |
| Birch | Opus 5.5 | 6/6 | 2/2 | 4/6 | 40.1 s | 0.142 |

Both models covered all six ideas twice. One output attributed an interpretation to the constitutional example alone, although the passage also cited Montesquieu. Matching the words of a quotation did not establish that the relationship was accurate. The dollar figures are CLI estimates of subscription usage. The trial did not measure a cash charge.

### Codex subscription comparison

Sol and Astra each read the same excerpts twice with the same focus and test embedder. Codex CLI recorded the requested model and `xhigh` effort for each call. Opus 5.5 then reviewed all eight outputs in shuffled order without knowing which model produced each one. The counts below combine two imports per model. This second reviewer sometimes scored a link differently from the first.

| Model | Ideas covered | Sampled claims supported | Supported factual links | Import time per run | Chat calls per run |
| --- | ---: | ---: | ---: | --- | --- |
| GPT-6.2 Sol | 12/12 | 4/4 | 7/7 | 77 s, 89 s | 2, 2 |
| GPT-6.2 Astra | 11/12 | 4/4 | 7/7 | 44 s, 58 s | 1, 2 |
| Sonnet 5.5 | 12/12 | 4/4 | 12/13 | 17 s, 18 s | 2, 2 |
| Opus 5.5 | 12/12 | 4/4 | 10/11 | 34 s, 40 s | 2, 2 |

One Astra note quoted Madison on liberty but omitted that point from its summary. That run produced too few notes to trigger theme naming. Both GPT models produced fewer factual links than the Claude models. These two trials per model informed the project’s choice of Sol for routine imports. Readers choose their own provider in Nodebook.

Sol used 51,053 and 51,104 input tokens, including 22,016 and 38,144 cached tokens. Astra used 53,752 and 27,358, including 22,144 and 27,264 cached tokens. These counts include CLI context. The Codex runs reported no per-run dollar charge.

### Reading a chart

The two-page attendance fixture places a chart on its image-only second page. Nodebook flagged that page before import. A model reading the rendered original recovered all four quarterly values (73, 70, 37 and 29) before seeing the answer key. This trial tested one labelled chart. Current figure tests also check preservation and offline access after merge. [Figure tests](../e2e/figures.spec.ts)
