# Optional Routing & Disk-Truth Guide (`@import` for `CLAUDE.md`)

> **Note:** When `spillway-mcp` (`agy-subagent`) starts over MCP `stdio`, it automatically delivers its routing and Disk-Truth instructions to Claude Code (**Opus / Fable / Sonnet**) via the MCP `initialize` response (`result.instructions`). You do **not** need to modify `CLAUDE.md` for the router to work.
>
> If your team prefers to keep an explicit reference inside `.claude/CLAUDE.md`, you can `@import` this file or include the block below.

---

## Tiered Offload & Disk-Truth Rules (Opus / Fable / Sonnet)

1. **ZERO-TRUST MEMORY (Disk-Evidence Verification):**
   Treat prior conversation history as stale. Never answer architectural questions or propose edits from memory—always call `local_file_scout` (`0x` cloud quota burn) to verify current disk state and cite `<file>:<line>` evidence first.

2. **Tier 3 Local GPU First-Pass Offload (`0x` Cloud Quota Burn):**
   * **`local_file_scout(file_paths, query)`**: Server-side file reader + local GPU forensic extractor. Extracts verbatim `<file>:L<line>` signatures and imports (`<300 tokens`), or outputs `"NOT_FOUND_ON_DISK: [symbol/query]"` if absent. Automatically escalates to `gemini-3.8-flash-low` if the local GPU server is offline.
   * **`local_exec_and_triage(command, working_dir)`**: Runs allow-listed test, typecheck, and lint suites (`pytest`, `npm test`, `tsc`, `cargo check`, `go test`). Returns short logs (`<= 40 lines`) directly and scrubs verbose logs (`> 40 lines`) through the local GPU so passing test noise never pollutes cloud context.
   * **`local_draft_leaf_code(target_file, spec, reference_files)`**: Generates routine boilerplate, unit tests, or schemas on disk via the local GPU with an empty/truncation overwrite guard (`>= 15 chars`, closed fences), returning `git diff --stat`.

3. **Tier 1 & Tier 2 Cloud Gemini Routing (`agy` Subagent Governor):**
   * **`flash-low` / `flash-medium` (`1x` burn):** Wide repo discovery, log triage, and disjoint-directory parallel swarms (`agy_spawn_swarm`).
   * **`flash-high` (`2x` burn):** Multi-file module summaries and second-opinion verification before spending Argon quota.
   * **`argon-low` / `argon-medium` (`4x` burn):** Cross-module bug tracing and scoped multi-file edits (`agy_delegate_edit`).
   * **`argon-high` (`6x` burn):** Deep architectural design and security/race-condition audits across 30+ files.

4. **Headless `agy` Shell Rules:**
   Headless `agy -p` only permits exact allow-listed read-only git commands (one command per tool call, never chained with `;` or `&&`). Always name the target files for `agy` to read with its file-reading tool.
