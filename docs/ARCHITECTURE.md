# Architecture

PlanForge is one local process with three control surfaces: a React operator
pane, an HTTP/SSE conversation API, and an MCP tool surface used by the
Architect.

```text
Browser operator
  │ HTTP + SSE
  ▼
Conversation orchestrator ─────── durable transcript store
  │
  ├── Claude Code session ── MCP ── plan / handoff / sign-off tools
  │
  └── Codex builder ─────────────── isolated Git worktree
                                      │
                                      ├── protected-file scope check
                                      ├── test-delta analysis
                                      ├── independent verifiers
                                      └── fast-forward-only merge
```

## Durable conversation model

A **Conversation** is the durable operator thread. It owns metadata and an
append-only JSONL transcript. A **Run** is one Architect process lifetime. A
**Cycle** is one plan → approval → build → verify → sign-off pass within a run.

SSE replays the transcript and then streams new entries. The browser derives
approval, build, verifier, and completion state from this record rather than
from optimistic POST responses.

## Shared control state

HTTP and MCP handlers share one run registry, one gate registry, and one
builder adapter. This prevents an approval received on one surface from
unblocking a different in-memory run.

## Builder isolation

Each approved cycle creates a dedicated Git worktree. Codex receives the
approved handoff and may write only inside that worktree. PlanForge resolves
the verifier specification independently from the target's base tree, runs it
after the build, evaluates test changes, and exposes the resulting diff to the
Architect and operator. A passing sign-off can merge only with `--ff-only`.

## Process and filesystem boundaries

- Target repositories must be standalone Git repositories under configured
  project buckets.
- Target containment uses real paths and rejects symlink escapes.
- Git hooks and target-controlled Git configuration are neutralized for build
  operations.
- Runtime conversations, per-run MCP files, output, and worktrees stay outside
  source.
- Process groups have bounded walls and identity-guarded teardown.

See [SECURITY.md](../SECURITY.md) before running PlanForge outside loopback.
