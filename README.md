# pi-project-memory

A project-scoped durable-memory extension for [Pi]. It adapts the filesystem architecture of `@yandy0725/pi-memory` for conservative learning and explicit, ripgrep-based recall.

## Design

```text
~/.pi/memory/<project-hash>/
├── MEMORY.md             # tiny one-line-per-topic index
├── model-validation.md   # durable entries
├── deployment.md
├── .review-state.json    # per-session extraction checkpoints/counters
└── .dream-meta.json
```

- Git repositories are identified by Git root; other directories use absolute cwd.
- Every project gets a separate hashed namespace under `~/.pi/memory` by default.
- `PI_MEMORY_DIR` can override that base directory for project-local launcher setups.
- Session startup injects only `MEMORY.md` (up to 50 topic lines / 8 KB).
- Detailed recall is explicit through `memory(action="search")` and `rg --json`.
- Search prefers Pi's managed binary at `<Pi agent dir>/bin/rg` (the same location Pi's built-in grep uses), then falls back to `rg` on `PATH`.
- Automatic extraction reviews only unreviewed conversation at 10 assistant responses, 30 tool calls, before compaction, or shutdown with at least 4 responses.
- Each review stores 0–5 durable memories; zero is intentionally common.
- `/dream` deduplicates, prunes, merges, and reindexes memory for precision.

There are no daily logs, scratchpads, embeddings, vector databases, global memory, or per-prompt retrieval calls.

## Requirements

- Pi 0.80.2+
- Node.js 22+
- [`rg` (ripgrep)] available on `PATH`

## Install locally

```bash
bun install
bun run test
bun run typecheck
pi install /absolute/path/to/pi-project-memory
```

For development without installation:

```bash
pi -e ./index.ts
```

## Tools and commands

### `memory`

- `action="add"`: add one durable entry to an existing/adaptive topic
- `action="remove"`: remove an entry by exact title
- `action="search", scope="memory"`: current-project `rg` search returning complete entry blocks
- `action="search", scope="sessions"`: search Pi session history for the current project

If a search misses, retry with synonyms, alternate identifiers, or an explicit regex OR expression such as `leakage|contamination`.

### Commands

- `/memory` — status
- `/memory on|off` — runtime toggle
- `/memory retry` — re-review the current session (useful after an interrupted/failed review)
- `/dream` — precision-oriented consolidation

## Configuration

Configuration files:

- Global: `~/.pi/agent/memory.json`
- Trusted-project override: `.pi/memory.json`
- `PI_MEMORY_DIR` overrides `memoryDir` (useful for a project-local launcher); the project hash is still appended.

```json
{
  "memIndexMaxLines": 50,
  "memIndexMaxBytes": 8192,
  "search": { "maxResults": 12, "maxBytes": 16384 },
  "extractMemories": {
    "enabled": true,
    "responseThreshold": 10,
    "toolCallThreshold": 30,
    "shutdownResponseThreshold": 4,
    "maxMemories": 5,
    "maxContextTokens": 12000,
    "thinkLevel": "high"
  }
}
```

## Topic format

```md
---
name: Model Validation
description: grouped CV, leakage controls, validation decisions
updated: 2026-08-10
---

## Group folds by patient

Use patient-level groups because row-level folds leak repeated observations and inflate validation performance.
```

`MEMORY.md` contains only:

```md
- [Model Validation](model-validation.md) — grouped CV, leakage controls, validation decisions
```

## Attribution

Based on the MIT-licensed [`@yandy0725/pi-memory`](https://github.com/yandy/pi-packages/tree/main/pi-memory). This adaptation removes automatic topic surfacing and introduces conservative checkpointed extraction plus ripgrep recall.

[Pi]: https://github.com/earendil-works/pi-mono
