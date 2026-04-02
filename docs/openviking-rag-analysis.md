# OpenViking RAG Logic Notes

## 1. Core Positioning

OpenViking is not just a vector database. It treats context as a navigable file system and uses a layered retrieval model:

- `L0`: one-line abstract, used for quick filtering
- `L1`: overview, used for navigation and rerank
- `L2`: full content, used as evidence when needed

Its design goal is closer to "context operating system for agents" than "flat chunk search engine".

## 2. What Happens When a Document Is Added

When one document comes in, the pipeline is roughly:

1. Parse source content
2. Normalize it into a resource tree
3. Store the resource under `viking://resources/...`
4. Generate layered summaries asynchronously
5. Build vector index entries

Likely stored artifacts:

- Original or parsed full content as `L2`
- `.abstract.md` for `L0`
- `.overview.md` for `L1`
- metadata such as `uri`, `parent_uri`, `level`, `context_type`
- vector and sparse vector index entries

Storage shape:

- File-like content goes into AGFS / VikingFS
- Index-like retrieval data goes into vector storage

## 3. How Retrieval Works

OpenViking retrieval is hierarchical, not purely flat.

High-level flow:

1. User query is rewritten into several typed queries
2. System first finds likely root directories or high-score context regions
3. It recursively searches child directories and files
4. It reranks results
5. It loads `L2` only when it decides the content is worth expanding

This means its retrieval logic is closer to:

`query -> likely directory -> likely file -> full content`

instead of:

`query -> full corpus chunk top-k -> answer`

## 4. Example: Finding Voice-Related Content

Assume the context tree looks like:

```text
viking://resources/airi/
  docs/
    voice/
      browser-web-speech-api.md
      elevenlabs.md
    character/
      persona.md
```

If the user asks:

> AIRI voice recognition and voice playback use what?

The likely search path is:

1. Rewrite query into things like:
   - `AIRI voice recognition`
   - `AIRI speech playback`
   - `AIRI TTS provider`
2. Match directory summaries
3. Route into `viking://resources/airi/docs/voice/`
4. Search child files inside that directory
5. Expand `browser-web-speech-api.md` and `elevenlabs.md`

This is why directory quality matters a lot.

## 5. Why It Does Not Start With Full-Text Only

A pure full-text-first strategy is stronger for exact terms, but weaker on structure.

If you only do:

`query -> full content top-k`

you may get chunks that contain one matching sentence but belong to documents that are globally irrelevant.

Example:

- Query: `Does AIRI use ElevenLabs by default?`
- Document A: actually explains AIRI default TTS
- Document B: only mentions ElevenLabs once in an optional integration example

Pure chunk recall may return B because it contains the exact word, even if the whole document is off-topic.

OpenViking tries to avoid that by using:

- directory-level routing
- abstract-based semantic filtering
- recursive narrowing
- document-level context

## 6. Main Risk in OpenViking

Its biggest risk is the opposite:

If `L0` or `L1` misses a crucial detail that exists in `L2`, the system may never route into the correct file.

Example:

### L2 full content

```text
Speech recognition uses Browser Web Speech API.
Speech playback uses ElevenLabs TTS.
```

### Weak L0 abstract

```text
This document describes AIRI voice interaction settings.
```

If the query is:

> Does AIRI use ElevenLabs?

and the abstract does not mention `ElevenLabs`, retrieval can miss the file or rank it too low.

## 7. Does OpenViking Have a Fallback Against This?

Partially, yes. Fully, no.

What helps:

- multiple rewritten queries instead of one raw query
- recursive directory descent
- parent-child score propagation
- layered context loading

What is still weak:

- rerank still depends heavily on abstract-like representations
- `L2` is primarily treated as an evidence layer, not a first-class semantic recall entry in the retrieval flow
- there is no clearly documented "if abstract routing fails, force full-content fallback" path

So the architecture reduces summary failure risk, but does not eliminate it.

## 8. Why Pure Full-Text Recall Is Also Not Enough

If you always start from full text, you get another problem:

- one or two local sentences may match
- but the whole document may still be globally irrelevant

So good retrieval needs two different notions of relevance:

- local relevance: a chunk contains query-related text
- global relevance: the full document is actually about the query

Chunk recall can prove local relevance only.
Directory / summary / document validation is still needed to prove global relevance.

## 9. Better Hybrid Strategy

The most robust design is not:

- summary only

and not:

- full text only

It should be:

1. Full-text recall discovers candidate evidence
2. Directory and summary layers validate whether the document is globally relevant
3. Neighbor chunks confirm whether the topic is sustained, not accidental
4. Final ranking combines:
   - exact term match
   - semantic match
   - directory relevance
   - document-level consistency

In other words:

`full text finds clues`

`directory and abstract confirm the narrative`

## 10. Practical Rule of Thumb

Use abstract/directory-first when the user asks:

- broad topic questions
- "where is this knowledge located"
- concept-oriented questions

Use full-text-first or at least full-text fallback when the user asks:

- exact API names
- config keys
- class or function names
- error codes
- parameter names
- protocol fields

## 11. Final Takeaway

OpenViking is strong as a context navigation system.

It is weaker if you expect it to guarantee that any detail hidden only in the full body can always be directly recalled.

If you care about not missing exact technical facts, a stronger hybrid design is:

`query -> full-text evidence recall -> document validation -> directory-aware rerank -> L2 evidence expansion`

That is usually safer than relying on summary layers alone.
