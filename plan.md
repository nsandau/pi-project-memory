
# Goal

Adapt `@yandy0725/pi-memory` into a simple, project-scoped memory system optimized for high-precision durable knowledge.

Core architecture:

```text
MEMORY.md = tiny topic index
topic files = actual durable knowledge
ripgrep = on-demand recall -> check that pi's read tool uses rg
LLM extraction = automatic learning
Pi session history = transcript/history
```

## 1. Keep unchanged

* Project identity:

  * Git repo → Git root
  * otherwise → absolute cwd
* Project-hashed memory namespaces
* Plain Markdown topic files
* Adaptive/model-created topic categories
* `MEMORY.md` as compact topic index
* `memory add/remove`
* `/memory`
* `/dream` consolidation
* Path traversal protection

Do not add daily logs or scratchpads.

## 2. Remove auto-surfacing

Disable/remove the `before_agent_start` side-LLM that selects and injects topic files on every prompt.

At session start inject only `MEMORY.md`.

The agent should retrieve detailed historical memory only when needed.

## 3. Replace memory search with ripgrep

Replace the existing substring scanner with an `rg`-backed implementation.

`memory(action="search", query=...)` should:

* search only the current project's memory directory
* search topic `*.md` files
* exclude `MEMORY.md` where appropriate
* use case-insensitive search
* support multiple terms / regex OR expressions
* use `rg --json` or equivalent structured output
* return complete `## Entry` blocks containing matches
* deduplicate returned entries
* cap result count/output size
* never search another project's namespace

The agent should be encouraged to reformulate searches with synonyms/related identifiers if the first search fails.

No qmd, embeddings, vector DB, or semantic search.

## 4. Change automatic extraction cadence

Currently extraction runs after every `agent_end`.

Change it to review when any of these occur:

```text
agent responses since review >= 10
OR
tool calls since review >= 30
OR
before context compaction
OR
session shutdown with >= 4 unreviewed agent responses
```

Persist counters/checkpoint state per project.

Extraction must analyze only conversation that has not already been reviewed.

Run extraction asynchronously using the existing headless/subagent mechanism.

## 5. Make extraction conservative

Each review should extract `0–5` durable memories.

Zero is expected and should be common.

Store only information likely to matter in future sessions, including:

* decisions and rationale
* assumptions
* methodological choices
* project conventions
* important corrections
* dataset/provenance quirks
* non-obvious implementation details
* failed approaches and why they failed
* important bugs/pitfalls
* reproducibility-critical information
* durable findings or robustness observations
* useful references that materially affect the work

Do not store:

* routine edits
* temporary task state
* verbose session summaries
* easily rediscoverable code facts
* speculative conclusions
* duplicate information

Prefer `what + why + context` over bare facts.

## 6. Adaptive topic taxonomy

Do not hard-code categories.

For every extracted memory:

1. Inspect `MEMORY.md`.
2. Prefer an existing topic if appropriate.
3. Create a new topic only when existing topics do not fit.
4. Use descriptive, stable filenames.
5. Keep topic fragmentation low.

Examples may naturally become:

```text
cohort-definition.md
model-validation.md
failed-approaches.md
paper-revisions.md
deployment.md
api-design.md
```

but these are examples, not predefined categories.

## 7. Keep MEMORY.md extremely compact

`MEMORY.md` must contain only one concise line per topic:

```md
- [Model validation](model-validation.md) — grouped CV, leakage controls, validation decisions
```

No detailed memories belong there.

Tighten defaults substantially from the current 200-line/25KB limits. Target approximately:

```text
<= 50 topic lines
<= 8 KB
```

Descriptions should state what can be found in the topic, not attempt to summarize every entry.

## 8. Improve consolidation

Adapt `/dream` to enforce the same philosophy:

* merge duplicate entries
* remove obsolete/superseded knowledge
* resolve contradictions where possible
* merge overlapping topic files
* rename unclear topics
* delete empty topics
* regenerate a precise `MEMORY.md`
* preserve important rationale/provenance

The goal is precision, not accumulation.

## 9. Tests

Add tests covering:

* Git-root project identity unchanged
* cwd fallback unchanged
* memory from project A never appears in project B
* `rg` search returns complete matching `##` blocks
* multiple search terms work
* output is bounded
* extraction does not run before threshold
* extraction runs at 10 responses
* 30 tool calls triggers extraction
* compaction triggers pending extraction
* shutdown triggers pending extraction
* already-reviewed conversation is not reviewed twice
* extraction may produce zero memories
* adaptive topic creation works
* existing topic preferred over unnecessary new topic
* MEMORY.md stays an index rather than storing full entries

## Non-goals

Do not add:

* qmd
* embeddings
* semantic/vector search
* global memory
* per-prompt retrieval LLM calls
* daily logs
* scratchpads
* fixed research/coding taxonomies
* daemon/background service
* additional databases
