# Nodebook quality trials, 18 November 2026

## Graph layout

Use Force for the ordinary vault map and Routed for staged book maps. Both remain selectable. A linked vault opens quickly in Force. On the dense book, Routed gave each note its own space and kept the UI responsive while the worker computed the routes.

| Fixture | Layout | Overlapping node boxes | Links crossing unrelated node boxes¹ | Edge crossings² | Time to layout | Longest frame gap |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Linked vault, 11 notes, 27 links | Force | 2 | 7 | 21 | 2 ms | 10 ms |
| Same vault | Routed | 0 | 0 | 15 | 89 ms | 10 ms |
| Staged Federalist book, 200 notes, 613 links | Force | 1,458 | 5,798 | 4,872 | 271 ms | 272 ms |
| Same book | Routed | 0 | 0 | 12,980 | 394 ms | 10 ms |

¹ Each intersection with an unrelated box counts separately. ² Counts intersections inside two edge segments, excluding touches and shared straight runs.

These are paired observations on one Mac. Routed bends increased edge crossings on the book. Its overview hides titles until the user zooms or chooses **Zoom to titles**. At the expanded 299-note, 849-link cap, Routed attached all 849 routes with zero overlapping boxes. The book came from the saved September distill evaluation. Its original full text and model output were not regenerated for this layout trial.

## Local search

Keep multilingual E5 on WASM as the default. EmbeddingGemma 2 retrieved one extra cross-language match on this sample and ran successfully on WebGPU. Its q4 and q8 exports both failed to load on the tested WASM runtime because the runtime lacked the required quantized gather operator.

| Question set | Keyword | E5 hybrid | EmbeddingGemma 2 hybrid |
| --- | ---: | ---: | ---: |
| English question, English note, relevant note in top 5 | 0/12 | 12/12 | 12/12 |
| Russian question, same English note, relevant note in top 5 | 0/12 | 11/12 | 12/12 |
| Two-source question, at least one relevant note in top 5 | 0/6 | 6/6 | 6/6 |
| Two-source Ask, all annotated supporting sentences in eight passages | 5/6 | 6/6 | 6/6 |
| Warm search p95 | 0.9 ms | 37 ms | 23 ms |
| Peak sampled renderer working set | — | 1,997 MiB | 1,333 MiB |

The trial used 72 notes and 30 public human-annotated questions. For XQuAD, use the first English paragraph and first question of every fourth article among the first 48, then match the Russian question by ID to the English note. For HotpotQA, use the first six distractor-validation records and all ten context articles per record. A relevant note is one named by the annotation. The Ask score requires the actual supporting sentences to appear in the retrieved text. Sidebar keyword search requires all query terms, while Ask also searches terms independently. This sample represents natural questions and does not measure keyword lookups by title or identifier. [XQuAD](https://github.com/google-deepmind/xquad) · [HotpotQA](https://hotpotqa.github.io/)

The Mac arm64 trial used a fresh Nodebook package with Electron 43.3.0, locally served weights, and one worker at a time. Query timing combines warm worker inference with Nodebook's SQLite lookup in the test driver. It excludes typing debounce and rendering. Memory covers the renderer and omits separate GPU-process memory. E5 used Transformers.js 4.2.0, q8 WASM with four threads, and the shipped query/passage prefixes. The experimental text-only Gemma worker used 4.3.1, q4 WebGPU, titled documents, and separate search and QA prefixes. Candidate weights and runtime are trial inputs. Existing app dependencies and model settings continue to select the baseline. [E5 weights](https://huggingface.co/Xenova/multilingual-e5-base/tree/1ec9243030a27d1a115d5c340572074c125b58b2) · [Gemma weights](https://huggingface.co/onnx-community/embeddinggemma-2-ONNX/tree/daa72c51243991dfcaf9f9137d2c573d8f7790c0)

## Book import

Keep chat-provider selection with the user. Sonnet and Opus each covered all six target ideas on both runs. Opus produced the strongest single set of factual links and also produced a run with two weak links. Its runs took roughly twice as long.

| Masked output | Provider model | Ideas covered | Sampled claims supported by their quotes | Factual links supported in the stated direction | Wall time | CLI-reported USD equivalent |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| Elm | Sonnet 5.5 | 6/6 | 2/2 | 5/8 | 16.8 s | 0.069 |
| Ash | Sonnet 5.5 | 6/6 | 2/2 | 4/5 | 17.9 s | 0.049 |
| Oak | Opus 5.5 | 6/6 | 2/2 | 5/5 | 33.7 s | 0.171 |
| Birch | Opus 5.5 | 6/6 | 2/2 | 4/6 | 40.1 s | 0.142 |

Each run used the same excerpts of Federalist 10 (fixture lines 44–87) and 47 (81–101), the production distill pipeline, a fixed test embedder for grouping, one extraction call and one theme call. The focus asked for the authors' claims, qualifications and relations. A separate model reviewer saw the excerpts and the four masked outputs before the key was opened. The six ideas were the definition of faction, the two remedies, liberty as a condition of faction, unequal faculties and property, partial versus whole departmental power, and the veto and appointments example.

The reviewer checked citations on the faction definition and the separation-of-powers qualification, and scored every explicitly typed factual edge except source, membership, mention and topic links. For example, one output claimed the interpretation depended on the constitutional example, where the passage also invokes Montesquieu's words. All four readings covered the material, but citation matching alone could not catch that distinction. This was model judgment on two short excerpts. Dollar figures are the CLI's estimates for subscription usage. No invoice or per-call cash charge was measured.

### Codex subscription comparison

The current Nodebook project uses GPT-6.2 Sol for engineering and routine imports, GPT-6.2 Astra for judgment-heavy work, and Opus 5.5 through Claude CLI for an independent perspective when needed. Provider selection in the distributed application remains a user preference.

The same two excerpts, focus, extractor, and fixed test embedder were used for two imports with each GPT model. Codex CLI recorded the requested model ID and the existing local `xhigh` effort for every call. For a common comparison, Opus 5.5 scored all eight outputs in shuffled order under new labels, with no access to the author identities. Each row below pools two imports scored by that reviewer. The earlier table records the original reviewer's judgments.

| Model | Ideas covered | Sampled claims supported | Supported factual links | Import time per run | Chat calls per run |
| --- | ---: | ---: | ---: | --- | --- |
| GPT-6.2 Sol | 12/12 | 4/4 | 7/7 | 77 s, 89 s | 2, 2 |
| GPT-6.2 Astra | 11/12 | 4/4 | 7/7 | 44 s, 58 s | 1, 2 |
| Sonnet 5.5 | 12/12 | 4/4 | 12/13 | 17 s, 18 s | 2, 2 |
| Opus 5.5 | 12/12 | 4/4 | 10/11 | 34 s, 40 s | 2, 2 |

Sol covered all six ideas twice. In one Astra output, a quotation preserved Madison's point that liberty enables faction, but the generated note body omitted it. That run also produced too few notes to trigger the theme call. Both GPT models produced fewer factual links than the Claude models. With two trials and different numbers of links, these results support Sol for the current import workload and do not establish a general model ranking. The two reviewers also differed on marginal relation labels.

Codex CLI reported 51,053 and 51,104 input tokens for the Sol runs (22,016 and 38,144 cached) and 53,752 and 27,358 for Astra (22,144 and 27,264 cached). These include CLI context. The Codex subscription runs supplied token counts without a per-run dollar charge.

For a separate visual check, the two-page attendance fixture places the full chart on an image-only second page. Nodebook flagged page 2 before import. A model reading of the rendered original recovered all four quarterly values (73, 70, 37, 29) before the answer key was opened. This single labeled chart demonstrates the value of showing which pages need attention. Automated visual extraction needs separate trials on scans, tables and unlabeled charts before adoption.
