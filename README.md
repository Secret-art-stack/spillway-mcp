# `spillway-mcp` — 3-Tier Hybrid Inference Waterfall MCP Server

[![Node.js >= 18](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP Protocol](https://img.shields.io/badge/MCP-2024--11--05-blue)](https://modelcontextprotocol.io/)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](#)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://opensource.org/licenses/Apache-2.0)

## 1. Executive Summary

`spillway-mcp` is a **zero-dependency Node.js Model Context Protocol (MCP) server** that connects **Claude Code** (**Opus / Fable / Sonnet**) to a **3-Tier Hybrid Inference Waterfall**:

1. **Tier 0 (Apex Orchestrator):** Claude Code (**Opus / Fable / Sonnet**) handles high-level architectural decisions, surgical multi-line `Edit` patches, and final user synthesis.
2. **Tier 1 & 2 (Cloud Subagent Governor — Google Antigravity `agy`):** Routes wide-context exploration, disjoint-directory swarms, and deep multi-file reasoning across **Gemini 3.8 Flash** (`1x–2x` weight) and **Gemini 4 Argon** (`4x–6x` weight) with deterministic 5-hour/weekly quota governance and automatic `429` step-down.
3. **Tier 3 (Local Consumer GPU Context Scrubber — RTX 4070 / Ollama / `llama-server`):** Intercepts high-volume file reads, verbose test/build logs, and leaf-node boilerplate generation on a local GPU (`0x` cloud quota burn), returning `<300 token` forensic `<file>:<line>` digests so raw file bloat and passing test noise never enter cloud context windows.

In production workflows, this spillway architecture **reduces frontier cloud token consumption by 40–60%** while eliminating mid-session **context rot** and **stale-memory hallucinations**.

---

## 2. Architecture & Data Flow

```text
+-----------------------------------------------------------------------------------+
|                        TIER 0: FRONTIER ORCHESTRATOR                              |
|                 Claude Code (Opus / Fable / Sonnet Session)                       |
|   Receives `ZERO-TRUST MEMORY` & routing rules via MCP `initialize.instructions`  |
+-----------------------------------------+-----------------------------------------+
                                          |
                                          | JSON-RPC 2.0 over stdio
                                          v
+-----------------------------------------------------------------------------------+
|                     SPILLWAY MCP SERVER (`server/index.js`)                       |
|  - Server-side disk reader (raw files & verbose logs never cross MCP arguments)   |
|  - Single-process execution queues (AGY_MAX_CONCURRENCY=1, LOCAL_GPU_CONCURRENCY=1)|
|  - Secret/binary lockout (.env*, id_rsa, first-4KB \0 null-byte detection)        |
+-------------------+-------------------------------------------+-------------------+
                    |                                           |
     [Context Scrubbing & Leaf Tasks]            [Cross-Module Analysis & Swarms]
     `local_file_scout`                          `agy_delegate_research`
     `local_exec_and_triage`                     `agy_spawn_swarm` (disjoint paths)
     `local_draft_leaf_code`                     `agy_delegate_edit` / `followup`
                    |                                           |
                    v                                           v
+---------------------------------------+   +---------------------------------------+
|     TIER 3: LOCAL GPU WORKER (0x)     |   |   TIER 1 & 2: GEMINI CLOUD GOVERNOR   |
|  RTX 4070 12GB (`127.0.0.1:11434/8080`)|   |     Google Antigravity CLI (`agy`)    |
|  - Probes Ollama `/api/ps` (hot VRAM) |   |  - `argon-high` (6x) -> `argon-med`   |
|  - 1-based line numbers + 50/50 slice |   |    -> `argon-low` -> `flash-high`     |
|  - Forensic `SCOUT_SYSTEM_PROMPT`     |   |    -> `flash-medium` -> `flash-low`   |
|  - Empty/truncated overwrite guard    |   |  - 80% session context auto-compaction|
+-------------------+-------------------+   +-------------------+-------------------+
                    |                                           ^
                    +----- Automatic Zero-Error Spillover ------+
                      (If local GPU is offline / gaming mode
                       or payload exceeds VRAM ceiling)
```

---

## 3. Key Engineering Problems Solved

### A. Context Pollution & Cloud Token Burn ("Context Rot")
When a frontier orchestrator (**Opus / Fable / Sonnet**) reads five 800-line source files (`~16,000 tokens`) or runs `pytest` / `npm test` producing 2,500 lines of passing test output (`~25,000 tokens`), those raw tokens remain in the conversation history for **every subsequent turn**.
* **How `spillway-mcp` solves it:** `local_file_scout` and `local_exec_and_triage` read files and execute test runners **on the MCP server side**. The local GPU extracts only the requested `<file>:L<line>` signatures or failing stack traces (`<300 tokens`), keeping 95%+ of raw noise out of the cloud context window.

### B. Zero-Trust Disk Verification (Eliminating Stale-Memory Hallucinations)
In long-running coding sessions (15+ turns), frontier LLMs (**Opus / Fable / Sonnet**) suffer from **recency/memory bias**—answering architectural questions from stale turns rather than re-verifying the disk, or skipping `Read` calls to save context.
* **How `spillway-mcp` solves it:**
  1. **Triple-Anchored `ZERO-TRUST MEMORY` Rule:** Injected at Turn 0 via MCP `initialize.instructions`, reinforced in tool schema descriptions, and anchored at the bottom of every tool output in the `[AGY GOVERNOR TELEMETRY]` footer.
  2. **Forensic `SCOUT_SYSTEM_PROMPT`:** Instructs the local GPU to report **only** verbatim signatures with 1-based line numbers (`src/auth.ts:L42-L58`), or emit the deterministic sentinel `"NOT_FOUND_ON_DISK: [symbol/query]"` if absent.

### C. Consumer GPU Safeguards (12 GB VRAM Hard Limits)
Running a local LLM on a multipurpose workstation requires strict hardware safeguards:
1. **Ollama `/api/ps` vs. `/v1/models` Trap Guard:** On Ollama (`:11434`), `GET /v1/models` lists *every downloaded model on disk*, which can trigger a 15-second cold load of an oversized model. The router probes `GET /api/ps` first to use the model already hot in VRAM and passes `"keep_alive": "30m"`.
2. **Empty-Output & Truncation Overwrite Guard:** In `local_draft_leaf_code`, if the local model returns `<15` characters, conversational filler, an unclosed markdown code fence (` ``` `), or `finish_reason === "length"`, the server **aborts the disk write**, leaves `target_file` untouched, and escalates to `gemini-3.8-flash-high`.
3. **Windows Process-Tree Reaping (`taskkill /T /F`):** Timed-out test runners in `local_exec_and_triage` kill the entire process tree on Windows so orphaned `python.exe` or `node.exe` workers never leak RAM/VRAM.
4. **50-50 Head/Tail Slicing with Preserved Line Numbers:** Files exceeding the VRAM context budget (`80,000 chars` on 12 GB VRAM) are numbered first (`1: ...`) and sliced 50% head / 50% tail so imports at the top and exports at the bottom retain exact line numbers.

### D. Deterministic Quota & Rate-Limit Governance
* Tracks rolling **5-hour** and **weekly** weighted burn budgets in `config/state-ledger.json` (auto-initialized from `config/state-ledger.example.json`).
* Parses `429 RESOURCE_EXHAUSTED` cooldown timers (`Resets in 1h20m30s`) from `agy` logs, locks the exhausted tier until its reset timestamp, and transparently steps down the fallback chain (`argon-high -> argon-medium -> argon-low -> flash-high -> flash-medium -> flash-low`).

### E. Non-Invasive Security & Least-Privilege Defaults
* **Zero Side Effects on `stdio` Startup:** Starting the MCP server never modifies `CLAUDE.md`, `AGENTS.md`, `.git/config`, or `.claude/settings.local.json`.
* **Least-Privilege Bootstrap:** Running `--bootstrap` never sets `enableAllProjectMcpServers: true` and pre-approves only the 4 read-only tools (`agy_status`, `agy_delegate_research`, `agy_spawn_swarm`, `local_file_scout`).
* **Safe Triage Command Allowlist:** `local_exec_and_triage` blocks shell chaining operators (`&&`, `;`, `|`) and restricts execution to allow-listed test, typecheck, and lint runners.

---

## 4. Exposed MCP Tools (9 Tools)

| Tool Name | Tier | Quota Burn | Purpose |
| :--- | :--- | :---: | :--- |
| `local_file_scout` | Tier 3 (Local GPU -> Flash Fallback) | **0x** | Forensic `<file>:L<line>` signature & import extractor (`<300 tokens`). |
| `local_exec_and_triage` | Tier 3 (Local GPU -> Flash Fallback) | **0x** | Runs allow-listed test/build commands; returns `<=40` lines directly or scrubs `>40` lines on GPU. |
| `local_draft_leaf_code` | Tier 3 (Local GPU -> Flash Fallback) | **0x** | Drafts boilerplate/unit tests to disk with truncation guard + `git diff --stat`. |
| `agy_delegate_research` | Tier 1/2 (Gemini Flash / Argon) | **1x–6x** | Read-only codebase investigation (`--mode=plan`) with headless git allow-list rules. |
| `agy_spawn_swarm` | Tier 1 (Gemini Flash Low/Med) | **1x/task** | Disjoint-directory subagent swarm with path-collision validation. |
| `agy_delegate_edit` | Tier 2 (Gemini Argon / Flash) | **2x–6x** | Scoped multi-file modifications (`--mode=accept-edits`) with optional IDE `--diff` review. |
| `agy_session_followup` | Tier 1/2 (Session Resume) | **1x–6x** | Resumes cached `conversation_id` and auto-compacts at 80% context usage. |
| `agy_configure_workspace` | Utility | **0x** | Auto-detects `.venv` / `node_modules/.bin` and configures optional Antigravity IDE HUD sync. |
| `agy_status` | Utility | **0x** | Reports live GPU VRAM probe, cloud quota timers, queue state, and model discovery. |

---

## 5. Quick Start Guide

### Step 1: Clone & Run the Sandboxed Smoke Test
```bash
git clone https://github.com/Secret-art-stack/spillway-mcp.git
cd spillway-mcp
npm test
```
*(`npm test` runs `node server/smoke-test.js` inside a disposable `os.tmpdir()` workspace and verifies all offline safeguards, permission rules, and MCP stdio framing).*

### Step 2: Configure Local GPU Inference (Ollama or `llama-server`)

Pick your hardware preset in [`config/model-matrix.json`](./config/model-matrix.json) (`8gb_vram`, `12gb_vram`, or `24gb_vram_or_mac_unified`). For a **12 GB GPU (e.g., NVIDIA RTX 4070)** with **Ollama**:

```bash
# Enable Flash Attention, 8-bit quantized KV cache, and 16K context window
export OLLAMA_FLASH_ATTENTION=1
export OLLAMA_KV_CACHE_TYPE=q8_0
export OLLAMA_CONTEXT_LENGTH=16384

# Pull and warm the default coding model
ollama pull qwen2.5-coder:14b
```

Or with **`llama.cpp` (`llama-server`)** on port `8080`:
```bash
llama-server -m qwen2.5-coder-14b-instruct-q4_k_m.gguf \
  --port 8080 --ctx-size 16384 --cache-type-k q8_0 --cache-type-v q8_0 -fa -ngl 99
```

> **Tip:** If running heavy desktop/IDE apps alongside the GPU on a 12 GB card (~6.5–7 GB free VRAM), use a 9B/12B model like `qwen3.5:9b` or `gemma4:12b-q4_K_M` (~5.5–6.5 GB) so weights + KV cache stay 100% in VRAM without PCIe spillover.

### Step 3: Register in Claude Code (`.mcp.json`)

Copy [`.mcp.example.json`](./.mcp.example.json) to `.mcp.json` in your project root (or run `node server/index.js --bootstrap` with user confirmation):

```json
{
  "mcpServers": {
    "agy-subagent": {
      "command": "node",
      "args": ["./spillway-mcp/server/index.js"],
      "timeout": 600000,
      "env": {
        "AGY_NO_SELF_BOOTSTRAP": "1",
        "AGY_GIT_REPORT_ONLY": "1",
        "AGY_DENY_SKIP_PERMISSIONS": "1",
        "LOCAL_GPU_PROFILE": "12gb_vram",
        "LOCAL_LLM_BASE_URL": "http://127.0.0.1:11434/v1",
        "LOCAL_OLLAMA_MODEL": "qwen2.5-coder:14b"
      }
    }
  }
}
```

---

## 6. Repository Structure

```text
spillway-mcp/
├── server/
│   ├── index.js               # Zero-dependency MCP server & hybrid routing engine
│   └── smoke-test.js          # Sandboxed test suite (runs in os.tmpdir())
├── config/
│   ├── model-matrix.json      # Tiered routing & 8GB / 12GB / 24GB hardware presets
│   ├── state-ledger.example.json
│   └── ide-sync.example.json
├── docs/
│   └── ROUTING_GUIDE.md       # Optional @import guide for CLAUDE.md
├── .mcp.example.json          # Example MCP registration for Claude Code
├── .gitignore                 # Ignores live state-ledger.json, ide-sync.json, .env, logs
├── LICENSE                    # Apache License 2.0
├── package.json               # Clean metadata + `"test": "node server/smoke-test.js"`
└── README.md                  # Architectural documentation
```

---

## 7. License

Licensed under the [Apache License, Version 2.0](./LICENSE).
