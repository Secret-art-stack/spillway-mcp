#!/usr/bin/env node
/**
 * Antigravity (agy v1.4.2+) Subagent Governor & Visual HUD — MCP Server
 *
 * Connects Claude Code (Primary Lead) to Google Antigravity CLI (agy.exe)
 * as a subordinate worker agent capable of spawning parallel subagents,
 * tracking Gemini 4 Argon & 3.8 Flash quotas, auto-compacting sessions at 80%,
 * provisioning project workspace environments from Claude's perspective,
 * and synchronizing with the Antigravity IDE Visual HUD.
 *
 * CRITICAL GOTCHA #1: Zero stdout pollution. All logs strictly go to stderr.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

// Redirect all console methods to stderr to prevent JSON-RPC stdout framing corruption
const logStderr = (...args) => {
  const ts = new Date().toISOString();
  process.stderr.write(
    `[AGY-GOVERNOR ${ts}] ${args
      .map(a => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')}\n`
  );
};
// Only hijack console when running as the MCP server / CLI. When this file is
// require()'d as a library (e.g. by smoke-test.js to read the allow-list), the
// caller keeps its own stdout.
if (require.main === module) {
  console.log = logStderr;
  console.info = logStderr;
  console.warn = logStderr;
  console.error = logStderr;
}

// ============================================================================
// Headless agy permission model (verified against agy v1.4.2 on 2026-10-21)
// ----------------------------------------------------------------------------
// In headless `agy -p` mode (--mode plan or --mode accept-edits; `auto` is not
// available on every account) agy AUTO-DENIES every shell command that is not on
// its allow-list. It does not prompt and does not fail loudly: it returns JSON
// with `response: ""` and `denied_actions: [{ action: "command",
// display_name: "RunCommand" }]`.
//
// Allow rules are read from two user-level files and match the EXACT full
// command line only:
//   * %USERPROFILE%\.gemini\antigravity-cli\settings.json
//       -> permissions.allow            (logged "CLI settings initialized: permissions=...")
//   * %USERPROFILE%\.gemini\config\projects\default-cli-project.json
//       -> permissionGrants.permissionGrants.allow
//          (logged "ApplyProjectPermissionGrants: stored N allow")
// `command(git log -1 --oneline)` matches that one line and nothing else.
// Bare binaries `command(git)`, prefixes `command(git log)`, wildcards
// `command(git *)` / `command(git:*)` and chained lines (`a; b`, `a && b`) all
// fail the match. Commands run through PowerShell.
//
// The bootstrap below merges AGY_READONLY_COMMAND_ALLOWLIST into both files
// non-destructively, and every delegated prompt is prefixed with rules telling
// the model to use exactly these lines, one per tool call.
// ============================================================================
const AGY_READONLY_COMMAND_VOCABULARY = Object.freeze([
  'git status --short',
  'git status',
  'git diff --stat',
  'git diff',
  'git diff HEAD',
  'git diff HEAD --stat',
  'git log -1 --oneline',
  'git log -20 --oneline',
  'git log --oneline -20',
  'git show --stat HEAD',
  'git ls-files',
  'git branch --show-current'
]);
// Exact-match allow rules as agy stores them. Extend this list (and re-run
// `--bootstrap`) to teach agy a new read-only command.
const AGY_READONLY_COMMAND_ALLOWLIST = Object.freeze(
  AGY_READONLY_COMMAND_VOCABULARY.map(cmd => `command(${cmd})`)
);

// Two concurrent `agy -p` processes interfere (one exits 1 and the permission
// state can corrupt), so every agy run goes through a single in-process queue.
const AGY_MAX_CONCURRENCY = 1;

// Soft budget for async job handoff (540s = 9 min, safely below .mcp.json's 600s client timeout).
// Override via AGY_SOFT_TIMEOUT_MS env var or per-call softTimeoutMs.
const DEFAULT_AGY_SOFT_TIMEOUT_MS = 540000;

// Hard watchdog ceiling (1800s = 30 min, well above the soft budget) to reap genuinely hung agy processes.
// Override via AGY_RUN_MAX_MS env var or per-call hardTimeoutMs.
const DEFAULT_AGY_RUN_MAX_MS = 1800000;

// The local consumer GPU can only keep ONE LLM loaded in VRAM at a time
// without PCIe system RAM thrashing. All local GPU requests serialize here.
const LOCAL_GPU_MAX_CONCURRENCY = 1;

const AGY_CLI_SETTINGS_PATH = path.join(os.homedir(), '.gemini', 'antigravity-cli', 'settings.json');
const AGY_DEFAULT_PROJECT_GRANTS_PATH = path.join(
  os.homedir(),
  '.gemini',
  'config',
  'projects',
  'default-cli-project.json'
);

// Directory & Configuration Paths (Supports both standalone config/ layout and embedded .agy-subagent/ layout)
const SUBAGENT_ROOT = path.resolve(__dirname, '..');
const CONFIG_DIR = process.env.AGY_CONFIG_DIR
  ? path.resolve(process.env.AGY_CONFIG_DIR)
  : fs.existsSync(path.join(SUBAGENT_ROOT, 'config'))
  ? path.join(SUBAGENT_ROOT, 'config')
  : SUBAGENT_ROOT;
const WORKSPACE_ROOT = process.env.AGY_WORKSPACE_ROOT
  ? path.resolve(process.env.AGY_WORKSPACE_ROOT)
  : path.basename(SUBAGENT_ROOT) === '.agy-subagent'
  ? path.resolve(SUBAGENT_ROOT, '..')
  : process.cwd();
const MODEL_MATRIX_PATH = path.join(CONFIG_DIR, 'model-matrix.json');
const STATE_LEDGER_PATH = path.join(CONFIG_DIR, 'state-ledger.json');
const STATE_LEDGER_EXAMPLE_PATH = path.join(CONFIG_DIR, 'state-ledger.example.json');
const IDE_SYNC_PATH = path.join(CONFIG_DIR, 'ide-sync.json');
const IDE_SYNC_EXAMPLE_PATH = path.join(CONFIG_DIR, 'ide-sync.example.json');
const TEMP_LOG_DIR = path.join(os.tmpdir(), 'agy-subagent-logs');

if (!fs.existsSync(TEMP_LOG_DIR)) {
  fs.mkdirSync(TEMP_LOG_DIR, { recursive: true });
}

// Expand Windows environment variables like %LOCALAPPDATA% or %USERPROFILE%
function expandEnvVars(str) {
  if (!str || typeof str !== 'string') return str;
  return str.replace(/%([^%]+)%/g, (_, key) => process.env[key] || '');
}

// Resolve agy.exe binary path (Gotcha #2: Windows Binary Path Resolution)
function resolveAgyBinary() {
  const candidates = [
    process.env.AGY_BIN_PATH,
    path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
      'agy',
      'bin',
      'agy.exe'
    ),
    path.join(os.homedir(), 'AppData', 'Local', 'agy', 'bin', 'agy.exe'),
    path.join(os.homedir(), '.local', 'bin', 'agy')
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return 'agy';
}

// Resolve Antigravity IDE binary for Visual HUD operations (--reuse-window, --diff)
function resolveIdeBinary(ideSyncConfig) {
  const rawCandidates = (ideSyncConfig?.paths?.ide_cli_candidates || []).map(expandEnvVars);
  for (const candidate of rawCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return resolveAgyBinary();
}

// Auto-initialize runtime state files from *.example.json templates if missing
function ensureRuntimeStateFiles() {
  const initialized = [];
  if (!fs.existsSync(STATE_LEDGER_PATH) && fs.existsSync(STATE_LEDGER_EXAMPLE_PATH)) {
    fs.copyFileSync(STATE_LEDGER_EXAMPLE_PATH, STATE_LEDGER_PATH);
    initialized.push(STATE_LEDGER_PATH);
  }
  if (!fs.existsSync(IDE_SYNC_PATH) && fs.existsSync(IDE_SYNC_EXAMPLE_PATH)) {
    fs.copyFileSync(IDE_SYNC_EXAMPLE_PATH, IDE_SYNC_PATH);
    initialized.push(IDE_SYNC_PATH);
  }
  return initialized;
}

// Safe JSON Read/Write helpers (auto-initializes from .example.json if needed)
function readJsonSafe(filePath, fallbackObj = {}) {
  try {
    if (!fs.existsSync(filePath)) {
      if (filePath === STATE_LEDGER_PATH || filePath === IDE_SYNC_PATH) {
        ensureRuntimeStateFiles();
      }
    }
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (err) {
    logStderr(`Failed reading ${filePath}: ${err.message}`);
  }
  return fallbackObj;
}

function writeJsonSafe(filePath, data) {
  try {
    const tmpPath = `${filePath}.tmp.${process.pid}`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
    } catch (innerErr) {
      logStderr(`Failed writing ${filePath}: ${innerErr.message}`);
    }
  }
}

// Gotcha #5: Pre-flight check for Git Worktree Bug ([extensions] worktreeConfig = true).
// Default is report-only (autoFix = false) so the server never silently edits .git/config.
// Honors AGY_GIT_REPORT_ONLY=1 (always report-only) and AGY_GIT_AUTOFIX_WORKTREE=1 (opt-in fix).
function checkAndFixGitWorktreeConfig(cwd = WORKSPACE_ROOT, autoFix = false) {
  let effectiveAutoFix = Boolean(autoFix) || process.env.AGY_GIT_AUTOFIX_WORKTREE === '1';
  if (process.env.AGY_GIT_REPORT_ONLY === '1') {
    effectiveAutoFix = false;
  }
  const gitConfigPath = path.join(cwd, '.git', 'config');
  if (!fs.existsSync(gitConfigPath)) {
    return { checked: true, found_worktree_config: false, action: 'no_git_config' };
  }
  try {
    const raw = fs.readFileSync(gitConfigPath, 'utf8');
    const worktreeRegex = /^\s*worktreeConfig\s*=\s*true\s*$/im;
    if (worktreeRegex.test(raw)) {
      const worktreesDir = path.join(cwd, '.git', 'worktrees');
      const hasActiveWorktrees =
        fs.existsSync(worktreesDir) && fs.readdirSync(worktreesDir).length > 0;

      if (effectiveAutoFix && !hasActiveWorktrees) {
        const cleaned = raw.replace(
          worktreeRegex,
          '# worktreeConfig = true (stripped by agy-subagent governor)'
        );
        fs.writeFileSync(gitConfigPath, cleaned, 'utf8');
        logStderr(`Stripped stale 'worktreeConfig = true' from ${gitConfigPath}`);
        return {
          checked: true,
          found_worktree_config: true,
          action: 'stripped_stale_worktree_config'
        };
      }
      return {
        checked: true,
        found_worktree_config: true,
        has_active_worktrees: hasActiveWorktrees,
        action: 'warning_worktree_config_present'
      };
    }
    return { checked: true, found_worktree_config: false, action: 'clean' };
  } catch (err) {
    return { checked: false, error: err.message };
  }
}

// Auto-detect project toolchains, virtualenvs, and workspace settings in `cwd`
function detectWorkspaceEnvironment(cwd = WORKSPACE_ROOT) {
  const detectedToolchains = [];
  const extraPathEntries = [];
  let pythonInterpreter = null;

  // Check Python virtualenvs (.venv, venv, env)
  const venvCandidates = ['.venv', 'venv', 'env'];
  for (const v of venvCandidates) {
    const winScripts = path.join(cwd, v, 'Scripts');
    const winPy = path.join(winScripts, 'python.exe');
    const nixBin = path.join(cwd, v, 'bin');
    const nixPy = path.join(nixBin, 'python');
    if (fs.existsSync(winPy)) {
      pythonInterpreter = winPy;
      extraPathEntries.push(winScripts);
      detectedToolchains.push(`python-venv (${v})`);
      break;
    } else if (fs.existsSync(nixPy)) {
      pythonInterpreter = nixPy;
      extraPathEntries.push(nixBin);
      detectedToolchains.push(`python-venv (${v})`);
      break;
    }
  }

  if (
    fs.existsSync(path.join(cwd, 'pyproject.toml')) ||
    fs.existsSync(path.join(cwd, 'requirements.txt'))
  ) {
    if (!detectedToolchains.some(t => t.startsWith('python'))) {
      detectedToolchains.push('python');
    }
  }

  // Check Node.js / TypeScript
  if (fs.existsSync(path.join(cwd, 'package.json'))) {
    detectedToolchains.push('node');
    const nodeBin = path.join(cwd, 'node_modules', '.bin');
    if (fs.existsSync(nodeBin)) {
      extraPathEntries.push(nodeBin);
    }
  }

  // Check Rust / Go / .NET
  if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) detectedToolchains.push('rust');
  if (fs.existsSync(path.join(cwd, 'go.mod'))) detectedToolchains.push('go');

  return {
    workspace_root: cwd,
    project_name: path.basename(cwd),
    detected_toolchains: detectedToolchains,
    extra_path_entries: extraPathEntries,
    python_interpreter: pythonInterpreter
  };
}

// Provision & Sync Workspace Environment (Controlled from Claude's perspective)
function configureWorkspaceEnvironment(options = {}, cwd = WORKSPACE_ROOT) {
  const ideSync = readJsonSafe(IDE_SYNC_PATH);
  const autoDetected = detectWorkspaceEnvironment(cwd);

  const prevEnv = ideSync.workspace_environment || {};
  const mergedAddDirs = Array.from(
    new Set([...(prevEnv.add_dirs || []), ...(options.add_dirs || [])])
  ).map(d => (path.isAbsolute(d) ? d : path.resolve(cwd, d)));

  const mergedPaths = Array.from(
    new Set([
      ...autoDetected.extra_path_entries,
      ...(prevEnv.extra_path_entries || []),
      ...(options.extra_path_entries || [])
    ])
  );

  const mergedEnvOverrides = {
    ...(prevEnv.env_overrides || {}),
    ...(options.env_overrides || {})
  };

  const pythonInterp =
    options.python_interpreter || autoDetected.python_interpreter || prevEnv.python_interpreter || null;

  // Non-destructively sync .vscode/settings.json for Antigravity IDE if requested (default true)
  let vscodeSynced = prevEnv.vscode_settings_synced || false;
  if (options.sync_vscode_settings !== false) {
    try {
      const vscodeDir = path.join(cwd, '.vscode');
      const settingsFile = path.join(vscodeDir, 'settings.json');
      const existingSettings = readJsonSafe(settingsFile, {});
      let modified = false;

      if (pythonInterp && !existingSettings['python.defaultInterpreterPath']) {
        existingSettings['python.defaultInterpreterPath'] = pythonInterp;
        modified = true;
      }
      if (options.vscode_settings && typeof options.vscode_settings === 'object') {
        Object.assign(existingSettings, options.vscode_settings);
        modified = true;
      }
      if (modified) {
        if (!fs.existsSync(vscodeDir)) fs.mkdirSync(vscodeDir, { recursive: true });
        writeJsonSafe(settingsFile, existingSettings);
        vscodeSynced = true;
      }
    } catch (err) {
      logStderr(`Failed syncing .vscode/settings.json: ${err.message}`);
    }
  }

  // Handle IDE window attachment safely (prevents hijacking an unrelated IDE window)
  if (typeof options.attach_ide === 'boolean') {
    ideSync.ide_window_attached = options.attach_ide;
  }
  if (typeof options.follow_files === 'boolean') {
    ideSync.follow_files = options.follow_files;
  }
  if (typeof options.visual_review_gate === 'boolean') {
    ideSync.visual_review_gate = options.visual_review_gate;
  }

  let openedIdeWindow = false;
  if (options.open_ide_window === true) {
    const ideBin = resolveIdeBinary(ideSync);
    try {
      const ideArgs = [cwd, ...mergedAddDirs];
      const child = spawn(ideBin, ideArgs, {
        cwd,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.unref();
      ideSync.ide_window_attached = true;
      openedIdeWindow = true;
    } catch (err) {
      logStderr(`Failed launching Antigravity IDE for workspace ${cwd}: ${err.message}`);
    }
  }

  ideSync.workspace_environment = {
    workspace_root: cwd,
    project_name: options.project_name || autoDetected.project_name,
    add_dirs: mergedAddDirs,
    extra_path_entries: mergedPaths,
    env_overrides: mergedEnvOverrides,
    detected_toolchains: autoDetected.detected_toolchains,
    python_interpreter: pythonInterp,
    vscode_settings_synced: vscodeSynced,
    last_configured_at: new Date().toISOString()
  };

  if (path.resolve(cwd) === path.resolve(WORKSPACE_ROOT)) {
    writeJsonSafe(IDE_SYNC_PATH, ideSync);
  }

  return {
    ide_window_attached: ideSync.ide_window_attached,
    opened_ide_window: openedIdeWindow,
    workspace_environment: ideSync.workspace_environment
  };
}

function isPidAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return Boolean(err && err.code === 'EPERM');
  }
}

// Reconcile orphaned 'running' / 'queued' jobs & sessions in state-ledger.json whose owning
// MCP server or child PID exited before completion.
function reconcileOrphanedJobsAndSessions(
  ledger,
  { persistIfChanged = false, forceMarkNonLocal = false } = {}
) {
  if (!ledger || typeof ledger !== 'object') return false;
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  let changed = false;

  if (ledger.jobs && typeof ledger.jobs === 'object') {
    for (const [jobId, job] of Object.entries(ledger.jobs)) {
      if (!job || (job.state !== 'running' && job.state !== 'queued')) continue;
      if (agyActiveJobs.has(jobId)) continue;

      const alive = job.pid ? isPidAlive(job.pid) : false;
      const startMs = Date.parse(job.started_at || job.queued_at || 0);
      const isStaleQueued =
        job.state === 'queued' &&
        !job.pid &&
        (forceMarkNonLocal || !Number.isFinite(startMs) || now - startMs > 5000);

      if ((job.state === 'running' && !alive) || isStaleQueued) {
        const elapsedS = computeLiveElapsedSeconds(job);
        const orphanMsg =
          job.error ||
          'Orphaned in-flight job: previous MCP server or agy process exited before completion.';
        job.state = 'failed';
        job.finished_at = job.finished_at || nowIso;
        job.elapsed_s = elapsedS;
        job.error = orphanMsg;
        if (!job.result) {
          job.result = {
            ok: false,
            cancelled: false,
            timedOut: false,
            jobId: job.job_id || jobId,
            state: 'failed',
            startedAt: job.started_at || job.queued_at || nowIso,
            elapsedSeconds: elapsedS,
            modelUsed: job.model || null,
            stepDownReason: null,
            conversationId: job.conversation_id || null,
            responseText: '',
            deniedActions: [],
            responseEmpty: true,
            governorAlerts: [],
            logFilePath: job.log_file || null,
            error: orphanMsg
          };
        }
        changed = true;
      }
    }
  }

  if (ledger.sessions && typeof ledger.sessions === 'object') {
    for (const [sid, sess] of Object.entries(ledger.sessions)) {
      if (!sess || (sess.state !== 'running' && sess.state !== 'queued')) continue;
      const inLocalMap =
        (sess.job_id && agyActiveJobs.has(sess.job_id)) || agyActiveJobs.has(sid);
      if (inLocalMap) continue;

      const alive = sess.pid ? isPidAlive(sess.pid) : false;
      const startMs = Date.parse(sess.started_at || sess.created_at || 0);
      const isStaleQueued =
        sess.state === 'queued' &&
        !sess.pid &&
        (forceMarkNonLocal || !Number.isFinite(startMs) || now - startMs > 5000);

      if ((sess.state === 'running' && !alive) || isStaleQueued) {
        sess.state = 'failed';
        sess.finished_at = sess.finished_at || nowIso;
        sess.elapsed_s = computeLiveElapsedSeconds(sess);
        sess.error =
          sess.error ||
          'Orphaned in-flight session: previous MCP server or agy process exited before completion.';
        sess.last_updated_at = nowIso;
        changed = true;
      }
    }
  }

  if (
    typeof ledger.active_session_id === 'string' &&
    (ledger.active_session_id.startsWith('job-') ||
      ledger.active_session_id.startsWith('pending-'))
  ) {
    const mappedConv = ledger.jobs?.[ledger.active_session_id]?.conversation_id;
    if (
      mappedConv &&
      !mappedConv.startsWith('job-') &&
      !mappedConv.startsWith('pending-')
    ) {
      ledger.active_session_id = mappedConv;
    } else {
      const validSessionIds = Object.keys(ledger.sessions || {}).filter(
        k => !k.startsWith('job-') && !k.startsWith('pending-')
      );
      ledger.active_session_id =
        validSessionIds.length > 0 ? validSessionIds[validSessionIds.length - 1] : null;
    }
    changed = true;
  }

  if (changed && persistIfChanged) {
    ledger.last_updated_at = nowIso;
    writeJsonSafe(STATE_LEDGER_PATH, ledger);
  }
  return changed;
}

// Refresh quota rolling windows (5h & weekly) and expire old model locks
function refreshQuotaState(ledger) {
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const quotas = ledger.model_quotas || {};

  // 1. 5-Hour Rolling Window
  const w5h = quotas.shared_5h_window || {
    window_start_timestamp: nowIso,
    window_duration_seconds: 18000,
    estimated_requests_in_window: 0,
    weighted_burn_units_in_window: 0,
    max_weighted_burn_units: 240,
    estimated_remaining_pct: 100,
    locked_until_timestamp: null
  };
  const w5hStart = w5h.window_start_timestamp ? Date.parse(w5h.window_start_timestamp) : 0;
  if (!w5hStart || now - w5hStart >= (w5h.window_duration_seconds || 18000) * 1000) {
    w5h.window_start_timestamp = nowIso;
    w5h.estimated_requests_in_window = 0;
    w5h.weighted_burn_units_in_window = 0;
    w5h.estimated_remaining_pct = 100;
  }
  if (w5h.locked_until_timestamp && Date.parse(w5h.locked_until_timestamp) <= now) {
    w5h.locked_until_timestamp = null;
  }

  // 2. Weekly Rolling Window
  const wWeekly = quotas.shared_weekly_window || {
    window_start_timestamp: nowIso,
    window_duration_seconds: 604800,
    estimated_requests_in_window: 0,
    weighted_burn_units_in_window: 0,
    max_weighted_burn_units: 2400,
    estimated_remaining_pct: 100,
    locked_until_timestamp: null
  };
  const wWeeklyStart = wWeekly.window_start_timestamp ? Date.parse(wWeekly.window_start_timestamp) : 0;
  if (!wWeeklyStart || now - wWeeklyStart >= (wWeekly.window_duration_seconds || 604800) * 1000) {
    wWeekly.window_start_timestamp = nowIso;
    wWeekly.estimated_requests_in_window = 0;
    wWeekly.weighted_burn_units_in_window = 0;
    wWeekly.estimated_remaining_pct = 100;
  }
  if (wWeekly.locked_until_timestamp && Date.parse(wWeekly.locked_until_timestamp) <= now) {
    wWeekly.locked_until_timestamp = null;
  }

  // 3. Per-model locks
  const perModel = quotas.per_model_locks || {};
  for (const slug of Object.keys(perModel)) {
    const lockIso = perModel[slug].locked_until_timestamp;
    if (lockIso && Date.parse(lockIso) <= now) {
      perModel[slug].locked_until_timestamp = null;
    }
  }

  quotas.shared_5h_window = w5h;
  quotas.shared_weekly_window = wWeekly;
  quotas.per_model_locks = perModel;
  ledger.model_quotas = quotas;
  reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: false });
  return ledger;
}

// Parse cooldown duration from 429 / RESOURCE_EXHAUSTED logs (e.g., "Resets in 1h20m30s", "retry in 45s")
function parseCooldownDurationMs(logText) {
  if (!logText) return 15 * 60 * 1000;

  const hmsMatch = logText.match(
    /resets?\s+in\s+(?:(\d+)\s*h)?\s*(?:(\d+)\s*m)?\s*(?:(\d+)\s*s)?/i
  );
  if (hmsMatch && (hmsMatch[1] || hmsMatch[2] || hmsMatch[3])) {
    const h = parseInt(hmsMatch[1] || '0', 10);
    const m = parseInt(hmsMatch[2] || '0', 10);
    const s = parseInt(hmsMatch[3] || '0', 10);
    const totalMs = (h * 3600 + m * 60 + s) * 1000;
    if (totalMs > 0) return totalMs;
  }

  const secMatch = logText.match(/retry\s+(?:after|in)\s+(\d+(?:\.\d+)?)\s*s/i);
  if (secMatch) {
    return Math.ceil(parseFloat(secMatch[1]) * 1000);
  }

  return 15 * 60 * 1000;
}

// Detect 429 / Quota exhaustion in log/stderr output
function detectQuotaExhaustion(text) {
  if (!text) return null;
  const patterns = [
    /429\s+Too\s+Many\s+Requests/i,
    /RESOURCE_EXHAUSTED/i,
    /rateLimitExceeded/i,
    /quotaExceeded/i,
    /Quota\s+exceeded/i,
    /Resets\s+in\s+\d+[hms]/i,
    /exhausted\s+your\s+capacity/i
  ];
  for (const pat of patterns) {
    const match = text.match(pat);
    if (match) {
      const durationMs = parseCooldownDurationMs(text);
      return {
        matched: match[0],
        durationMs,
        lockedUntilIso: new Date(Date.now() + durationMs).toISOString()
      };
    }
  }
  return null;
}

// Resolve requested tier/slug to an available Gemini model slug with auto-stepdown & lock checks
function resolveModelSlug(requestedTierOrSlug, matrix, ledger) {
  refreshQuotaState(ledger);
  const aliases = matrix.tier_aliases || {};
  const fallbackChain = matrix.fallback_chain || [
    'gemini-4-argon-high',
    'gemini-4-argon-medium',
    'gemini-4-argon-low',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low'
  ];

  let targetSlug = aliases[requestedTierOrSlug] || requestedTierOrSlug || 'gemini-3.8-flash-medium';
  if (!targetSlug.startsWith('gemini-')) {
    targetSlug = aliases[targetSlug] || 'gemini-3.8-flash-medium';
  }

  const w5h = ledger.model_quotas?.shared_5h_window || {};
  const remainingPct =
    typeof w5h.estimated_remaining_pct === 'number' ? w5h.estimated_remaining_pct : 100;

  let stepDownReason = null;
  if (targetSlug === 'gemini-4-argon-high' && remainingPct < 30) {
    targetSlug = 'gemini-4-argon-medium';
    stepDownReason = `5h quota at ${remainingPct}% (<30% threshold)`;
  }

  const perModelLocks = ledger.model_quotas?.per_model_locks || {};
  const startIdx = Math.max(0, fallbackChain.indexOf(targetSlug));
  for (let i = startIdx; i < fallbackChain.length; i++) {
    const candidate = fallbackChain[i];
    const lockInfo = perModelLocks[candidate];
    if (!lockInfo || !lockInfo.locked_until_timestamp) {
      if (candidate !== targetSlug && !stepDownReason) {
        stepDownReason = `${targetSlug} locked until ${perModelLocks[targetSlug]?.locked_until_timestamp}`;
      }
      return { slug: candidate, stepDownReason };
    }
  }

  return {
    slug: 'gemini-3.8-flash-low',
    stepDownReason: 'All higher tiers in cooldown; falling back to gemini-3.8-flash-low'
  };
}

// Section 2B: Automated Model Discovery & Hot-Swap Watcher
async function runModelDiscovery() {
  const agyBin = resolveAgyBinary();
  const matrix = readJsonSafe(MODEL_MATRIX_PATH);
  const isJsScript = /\.m?js$/i.test(agyBin);
  const execCmd = isJsScript ? process.execPath : agyBin;
  const execArgs = isJsScript ? [agyBin, 'models'] : ['models'];

  return new Promise(resolve => {
    execFile(execCmd, execArgs, { timeout: 30000, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        logStderr(`Model discovery error: ${err.message}`);
        return resolve({
          ok: false,
          error: err.message,
          baseline_count: (matrix.baseline_models || []).length,
          discovered_models: matrix.discovered_models || []
        });
      }

      const combined = `${stdout || ''}\n${stderr || ''}`;
      const lines = combined.split(/\r?\n/);
      const geminiSlugs = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('Fetching')) continue;
        const parts = trimmed.split(/\s+/);
        const slug = parts[0];
        if (slug && slug.startsWith('gemini-')) {
          geminiSlugs.push(slug);
        }
      }

      const baselineSet = new Set(matrix.baseline_models || []);
      const discoveredSet = new Set(matrix.discovered_models || []);
      const newlyAdded = [];

      for (const slug of geminiSlugs) {
        if (!baselineSet.has(slug)) {
          if (!discoveredSet.has(slug)) {
            newlyAdded.push(slug);
            discoveredSet.add(slug);
          }
          if (!matrix.models) matrix.models = {};
          if (!matrix.models[slug]) {
            matrix.models[slug] = {
              slug,
              display_name: slug,
              family: slug.includes('flash') ? 'flash' : 'gemini-new',
              tier: 3,
              context_ceiling_tokens: 1000000,
              quota_burn_weight: 3,
              hot_discovered_at: new Date().toISOString()
            };
          }
        }
      }

      matrix.discovered_models = Array.from(discoveredSet);
      matrix.new_gemini_model_detected = matrix.discovered_models.length > 0;
      matrix.last_discovery_check = new Date().toISOString();
      writeJsonSafe(MODEL_MATRIX_PATH, matrix);

      resolve({
        ok: true,
        all_gemini_models: geminiSlugs,
        baseline_count: baselineSet.size,
        discovered_models: matrix.discovered_models,
        newly_added: newlyAdded,
        new_gemini_model_detected: matrix.new_gemini_model_detected
      });
    });
  });
}

// Kill process tree on Windows safely
function killProcessTree(child) {
  if (!child || !child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore'
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch (err) {
    logStderr(`Failed to kill process ${child.pid}: ${err.message}`);
  }
}

// ----------------------------------------------------------------------------
// Headless shell rules header. Prefixed to every prompt sent by
// agy_delegate_research, agy_spawn_swarm and agy_session_followup so the model
// never trips agy's exact-match allow-list (see the permission-model note at
// the top of this file).
// ----------------------------------------------------------------------------
function buildShellRulesHeader(vocabulary = AGY_READONLY_COMMAND_VOCABULARY) {
  return [
    '[HEADLESS SHELL RULES — READ BEFORE ACTING]',
    'You are running headless. Any shell command that is not on the exact allow-list below is silently auto-denied and your whole answer is discarded.',
    '1. Use your file-reading tool to inspect files. Prefer reading the files named in the task over searching for them.',
    `2. The ONLY shell commands you may run are these exact lines: ${vocabulary
      .map(c => `\`${c}\``)
      .join(', ')}.`,
    '3. One command per tool call, typed exactly as written: no extra flags or arguments, no paths appended, no quoting changes.',
    '4. Never chain commands with `;`, `&&`, `||` or pipes. Never run grep, rg, find, ls, cat, type, Get-Content, npm, npx, node, python or any other command.',
    '5. If a task seems to need a command that is not listed, do not try it. State what you would need and continue with the file-reading tool.',
    '[END HEADLESS SHELL RULES]'
  ].join('\n');
}

function withShellRules(prompt) {
  return `${buildShellRulesHeader()}\n\n${prompt}`;
}

// ----------------------------------------------------------------------------
// Denial / empty-response surfacing. Headless agy reports auto-denied actions
// in `denied_actions` and returns `response: ""`; without these alerts the tool
// result would be nothing but the telemetry footer.
// ----------------------------------------------------------------------------
const DENIED_ACTIONS_MARKER = '[Governor Alert: AGY DENIED ACTIONS]';
const EMPTY_RESPONSE_MARKER = '[Governor Alert: AGY EMPTY RESPONSE]';

function describeDeniedAction(d) {
  if (!d || typeof d !== 'object') return String(d);
  const label = d.display_name || d.displayName || d.action || 'unknown';
  const kind = d.action || 'unknown';
  const detail = d.command || d.command_line || d.input || d.args || d.description || null;
  const detailStr =
    detail === null ? '' : ` -> ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`;
  return `${label} (action: ${kind})${detailStr}`;
}

function buildGovernorAlerts(deniedActions, responseEmpty, attemptResult = {}) {
  const alerts = [];
  const allowedStr = AGY_READONLY_COMMAND_VOCABULARY.map(c => `\`${c}\``).join(', ');

  if (deniedActions.length > 0) {
    alerts.push(
      [
        `> ${DENIED_ACTIONS_MARKER} agy auto-denied ${deniedActions.length} action(s) in headless mode:`,
        ...deniedActions.map(d => `>   - ${describeDeniedAction(d)}`),
        '> Headless `agy -p` only runs shell commands whose EXACT full command line is on its allow-list: no bare binaries, prefixes, wildcards or `;`/`&&` chains.',
        `> Allowed right now: ${allowedStr}.`,
        '> Fix: name the files to read and use only those exact commands, one per tool call (the bridge already prefixes the prompt with these rules; make the task itself not require anything else). To allow a new read-only command, add it to AGY_READONLY_COMMAND_ALLOWLIST in .agy-subagent/server/index.js and re-run `node .agy-subagent/server/index.js --bootstrap`.'
      ].join('\n')
    );
  }

  if (responseEmpty) {
    const lines = [`> ${EMPTY_RESPONSE_MARKER} agy returned an empty response, so there is no answer to show.`];
    if (deniedActions.length > 0) {
      lines.push('> Cause: the denied action(s) listed above aborted the turn. Rephrase the task as described there and retry.');
    } else {
      const stderrTail = (attemptResult.stderr || '').trim().split(/\r?\n/).slice(-5).join(' | ');
      lines.push(
        `> No denied_actions were reported (exit code ${attemptResult.exitCode ?? 'unknown'}). Likely causes: another agy process was running concurrently, a cold start timed out, or the prompt was too large. Retry once; if it repeats, run \`agy_status\`.`
      );
      if (stderrTail) lines.push(`> agy stderr tail: ${stderrTail}`);
    }
    alerts.push(lines.join('\n'));
  }

  return alerts;
}

// Render step-down notes and governor alerts as a markdown preamble for a tool result.
function formatGovernorNotices(res, extraNotes = []) {
  const notes = [];
  if (res.stepDownReason) notes.push(`> [Governor Note: ${res.stepDownReason}]`);
  if (res.error) notes.push(`> [Governor Error: ${res.error}]`);
  for (const n of extraNotes) if (n) notes.push(n);
  for (const a of res.governorAlerts || []) notes.push(a);
  return notes.length > 0 ? `${notes.join('\n\n')}\n\n` : '';
}

// ----------------------------------------------------------------------------
// Single in-process queue for agy executions (AGY_MAX_CONCURRENCY = 1) +
// Async Job Registry, Session-at-Start Registration, Soft Timeout & Cancellation.
// Two concurrent `agy -p` processes interfere: one exits 1 and the shared
// permission state in ~/.gemini can corrupt. Every caller, including
// agy_spawn_swarm, goes through executeAgyWithGovernor, which serializes here.
// ----------------------------------------------------------------------------
let agyQueueTail = Promise.resolve();
const agyQueueState = { max_concurrency: AGY_MAX_CONCURRENCY, running: 0, waiting: 0, completed: 0 };
const agyActiveJobs = new Map();
const agyJobOrder = [];
const MAX_STORED_JOBS = 50;

function getAgySoftTimeoutMs(overrideMs) {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const envVal = Number(process.env.AGY_SOFT_TIMEOUT_MS);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_AGY_SOFT_TIMEOUT_MS;
}

function getAgyRunMaxMs(overrideMs) {
  if (typeof overrideMs === 'number' && Number.isFinite(overrideMs) && overrideMs > 0) {
    return overrideMs;
  }
  const envVal = Number(process.env.AGY_RUN_MAX_MS);
  return Number.isFinite(envVal) && envVal > 0 ? envVal : DEFAULT_AGY_RUN_MAX_MS;
}

function extractPromptPreview(prompt, rawUserPrompt) {
  const source = typeof rawUserPrompt === 'string' && rawUserPrompt.trim() ? rawUserPrompt : String(prompt || '');
  const stripped = source
    .replace(/^\[READ-ONLY RESEARCH MODE:[^\]]*\]\s*/i, '')
    .replace(/\[SWARM SUBAGENT ID:[^\]]*\]\s*/gi, '')
    .replace(/\[STRICT PATH PARTITION LOCK:[^\]]*\]\s*/gi, '')
    .replace(/\[HEADLESS SHELL RULES[\s\S]*?\[END HEADLESS SHELL RULES\]\s*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 120 ? `${stripped.slice(0, 117)}...` : stripped;
}

function computeLiveElapsedSeconds(jobOrSession) {
  if (!jobOrSession) return 0;
  if (
    typeof jobOrSession.elapsed_s === 'number' &&
    jobOrSession.state &&
    jobOrSession.state !== 'running' &&
    jobOrSession.state !== 'queued'
  ) {
    return jobOrSession.elapsed_s;
  }
  const startIso = jobOrSession.started_at || jobOrSession.queued_at || jobOrSession.created_at;
  if (!startIso) return 0;
  const parsed = Date.parse(startIso);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

function serializeJobSummary(jobRecord, includeResult = false) {
  if (!jobRecord) return null;
  const elapsedS = computeLiveElapsedSeconds(jobRecord);
  const summary = {
    job_id: jobRecord.job_id,
    state: jobRecord.state,
    tier: jobRecord.tier,
    model: jobRecord.model,
    mode: jobRecord.mode,
    cwd: jobRecord.cwd,
    prompt_preview: jobRecord.prompt_preview,
    queued_at: jobRecord.queued_at,
    started_at: jobRecord.started_at,
    finished_at: jobRecord.finished_at,
    elapsed_s: elapsedS,
    pid: jobRecord.pid || null,
    log_file: jobRecord.log_file || null,
    conversation_id: jobRecord.conversation_id || null,
    error: jobRecord.error || null
  };
  if (includeResult && jobRecord.result) {
    summary.result = jobRecord.result;
  }
  return summary;
}

// Persist job state and register/update the session in state-ledger.json at start and finish
function persistJobAndSessionState(jobRecord, phase = 'start', provisionalSessionId = null) {
  try {
    const matrix = readJsonSafe(MODEL_MATRIX_PATH);
    const ledger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
    if (!ledger.sessions || typeof ledger.sessions !== 'object') ledger.sessions = {};
    if (!ledger.jobs || typeof ledger.jobs !== 'object') ledger.jobs = {};

    const sessionId = jobRecord.conversation_id || provisionalSessionId || jobRecord.job_id;
    const modelSlug = jobRecord.model || 'gemini-3.8-flash-medium';
    const modelMeta = matrix.models?.[modelSlug] || { context_ceiling_tokens: 1000000 };
    const maxContextTokens = modelMeta.context_ceiling_tokens || 1000000;
    const nowIso = new Date().toISOString();

    if (
      phase === 'finish' &&
      provisionalSessionId &&
      provisionalSessionId !== sessionId &&
      ledger.sessions[provisionalSessionId]
    ) {
      delete ledger.sessions[provisionalSessionId];
    }

    const existing = ledger.sessions[sessionId] || {
      conversation_id: sessionId,
      cwd: jobRecord.cwd || WORKSPACE_ROOT,
      model: modelSlug,
      estimated_tokens_used: 0,
      max_context_tokens: maxContextTokens,
      turns: 0,
      created_at: jobRecord.queued_at || nowIso,
      last_updated_at: nowIso,
      compacted_from: null
    };

    existing.conversation_id = sessionId;
    existing.job_id = jobRecord.job_id;
    existing.state = jobRecord.state;
    existing.tier = jobRecord.tier;
    existing.model = modelSlug;
    existing.mode = jobRecord.mode;
    existing.prompt_preview = jobRecord.prompt_preview;
    existing.started_at = jobRecord.started_at || jobRecord.queued_at || existing.created_at;
    existing.finished_at = jobRecord.finished_at || null;
    existing.elapsed_s = computeLiveElapsedSeconds(jobRecord);
    existing.pid = jobRecord.pid || null;
    existing.log_file = jobRecord.log_file || null;
    existing.error = jobRecord.error || null;
    existing.last_updated_at = nowIso;

    ledger.sessions[sessionId] = existing;
    if (
      (phase === 'running' || phase === 'finish') &&
      sessionId &&
      !sessionId.startsWith('job-') &&
      !sessionId.startsWith('pending-')
    ) {
      ledger.active_session_id = sessionId;
    }

    ledger.jobs[jobRecord.job_id] = serializeJobSummary(jobRecord, true);

    const jobKeys = Object.keys(ledger.jobs);
    if (jobKeys.length > MAX_STORED_JOBS) {
      const removable = jobKeys.filter(
        k => ledger.jobs[k]?.state !== 'running' && ledger.jobs[k]?.state !== 'queued'
      );
      while (Object.keys(ledger.jobs).length > MAX_STORED_JOBS && removable.length > 0) {
        const oldestKey = removable.shift();
        delete ledger.jobs[oldestKey];
      }
    }

    ledger.last_updated_at = nowIso;
    writeJsonSafe(STATE_LEDGER_PATH, ledger);
  } catch (err) {
    logStderr(`Failed persisting job/session state for ${jobRecord?.job_id}: ${err.message}`);
  }
}

function getAgyQueueSnapshot() {
  let activeJob = null;
  const waitingJobs = [];
  const recentJobs = [];

  for (let i = agyJobOrder.length - 1; i >= 0; i--) {
    const jId = agyJobOrder[i];
    const entry = agyActiveJobs.get(jId);
    if (!entry) continue;
    const summary = serializeJobSummary(entry.jobRecord, false);
    if (entry.jobRecord.state === 'running' && !activeJob) {
      activeJob = summary;
    } else if (entry.jobRecord.state === 'queued') {
      waitingJobs.unshift(summary);
    }
    if (recentJobs.length < 10) {
      recentJobs.push(summary);
    }
  }

  // Merge any persisted jobs from state-ledger.json if recentJobs is empty (e.g. across CLI invocations)
  if (recentJobs.length === 0) {
    const ledger = readJsonSafe(STATE_LEDGER_PATH);
    reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: true });
    const persistedJobs = Object.values(ledger.jobs || {});
    for (let i = persistedJobs.length - 1; i >= 0 && recentJobs.length < 10; i--) {
      const pj = persistedJobs[i];
      const summary = serializeJobSummary(pj, false);
      if (pj.state === 'running' && !activeJob) activeJob = summary;
      else if (pj.state === 'queued') waitingJobs.unshift(summary);
      recentJobs.push(summary);
    }
  }

  return {
    max_concurrency: AGY_MAX_CONCURRENCY,
    running: agyQueueState.running,
    waiting: agyQueueState.waiting,
    completed: agyQueueState.completed,
    soft_timeout_ms: getAgySoftTimeoutMs(),
    hard_watchdog_ms: getAgyRunMaxMs(),
    active_job: activeJob,
    waiting_jobs: waitingJobs,
    recent_jobs: recentJobs
  };
}

function formatAsyncPendingMessage(jobRecord, softTimeoutMs) {
  const startIso = jobRecord.started_at || jobRecord.queued_at;
  const elapsedS = computeLiveElapsedSeconds(jobRecord);
  const headline = `still running, job ${jobRecord.job_id}, started ${startIso}, elapsed ${elapsedS}s; fetch with agy_job_result ${jobRecord.job_id}`;
  const budgetNote = softTimeoutMs
    ? `> [Governor Async Job Mode: Soft budget (${Math.round(
        softTimeoutMs / 1000
      )}s) reached before child exit — returning early with job ID so MCP stdio transport stays alive.]\n\n`
    : '';
  return [
    `${budgetNote}${headline}`,
    '',
    `- **Job ID:** \`${jobRecord.job_id}\``,
    `- **State:** \`${jobRecord.state}\``,
    `- **Tier / Model:** \`${jobRecord.tier}\` (\`${jobRecord.model}\`)`,
    `- **Started At:** \`${startIso}\``,
    `- **Elapsed:** \`${elapsedS}s\``,
    `- **Prompt Preview:** \`${jobRecord.prompt_preview}\``,
    `- **Fetch Result:** Call \`agy_job_result\` with \`{"job_id": "${jobRecord.job_id}"}\` (or \`{"job_id": "${jobRecord.job_id}", "wait_ms": 30000}\`).`,
    `- **Cancel Run:** Call \`agy_cancel\` with \`{"job_id": "${jobRecord.job_id}"}\` to terminate and free the queue.`
  ].join('\n');
}

function enqueueAgyRun(jobEntry, taskFn) {
  agyQueueState.waiting += 1;
  const run = agyQueueTail.then(async () => {
    agyQueueState.waiting -= 1;
    if (jobEntry?.cancelled) {
      agyQueueState.completed += 1;
      const cancelMsg =
        jobEntry.cancelReason || `Job ${jobEntry.jobRecord.job_id} was cancelled while queued.`;
      jobEntry.jobRecord.state = 'cancelled';
      jobEntry.jobRecord.finished_at = new Date().toISOString();
      jobEntry.jobRecord.elapsed_s = computeLiveElapsedSeconds(jobEntry.jobRecord);
      jobEntry.jobRecord.error = cancelMsg;
      const cancelledRes = {
        ok: false,
        cancelled: true,
        timedOut: false,
        jobId: jobEntry.jobRecord.job_id,
        state: 'cancelled',
        startedAt: jobEntry.jobRecord.queued_at,
        elapsedSeconds: jobEntry.jobRecord.elapsed_s,
        modelUsed: jobEntry.jobRecord.model,
        stepDownReason: null,
        conversationId: jobEntry.jobRecord.conversation_id,
        responseText: '',
        deniedActions: [],
        responseEmpty: true,
        governorAlerts: [],
        error: cancelMsg
      };
      jobEntry.jobRecord.result = cancelledRes;
      persistJobAndSessionState(
        jobEntry.jobRecord,
        'finish',
        jobEntry.provisionalSessionId
      );
      return cancelledRes;
    }

    agyQueueState.running += 1;
    if (jobEntry) {
      jobEntry.startedMs = Date.now();
      jobEntry.jobRecord.state = 'running';
      jobEntry.jobRecord.started_at = new Date(jobEntry.startedMs).toISOString();
      persistJobAndSessionState(jobEntry.jobRecord, 'running', jobEntry.provisionalSessionId);
    }
    try {
      return await taskFn();
    } finally {
      agyQueueState.running -= 1;
      agyQueueState.completed += 1;
    }
  });
  // Keep the chain alive even if a task rejects; the caller still sees the rejection.
  agyQueueTail = run.catch(() => {});
  return run;
}

async function cancelAgyJob(targetJobId) {
  const rawId = String(targetJobId || '').trim();
  if (!rawId) {
    return { ok: false, job_id: null, status: 'invalid', message: 'job_id is required.' };
  }

  let jobEntry = null;
  if (rawId === 'active' || rawId === 'current' || rawId === 'latest') {
    for (let i = agyJobOrder.length - 1; i >= 0; i--) {
      const candidate = agyActiveJobs.get(agyJobOrder[i]);
      if (
        candidate &&
        (candidate.jobRecord.state === 'running' || candidate.jobRecord.state === 'queued')
      ) {
        jobEntry = candidate;
        break;
      }
    }
  } else {
    jobEntry = agyActiveJobs.get(rawId) || null;
  }

  if (!jobEntry) {
    const ledger = readJsonSafe(STATE_LEDGER_PATH);
    reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: true });
    const persisted = ledger.jobs?.[rawId];
    if (persisted) {
      return {
        ok: false,
        job_id: rawId,
        status: 'already_finished',
        state: persisted.state,
        message: `Job ${rawId} is already in state '${persisted.state}' and cannot be cancelled.`
      };
    }
    return {
      ok: false,
      job_id: rawId,
      status: 'not_found',
      message: `No active or queued job found matching '${rawId}'.`
    };
  }

  const { jobRecord } = jobEntry;
  const prevState = jobRecord.state;
  if (prevState !== 'running' && prevState !== 'queued') {
    return {
      ok: false,
      job_id: jobRecord.job_id,
      status: 'already_finished',
      state: prevState,
      message: `Job ${jobRecord.job_id} already finished with state '${prevState}'.`
    };
  }

  const elapsedS = computeLiveElapsedSeconds(jobRecord);
  const pid = jobRecord.pid || jobEntry.child?.pid || null;
  jobEntry.cancelled = true;
  jobEntry.cancelReason = `Job ${jobRecord.job_id} was cancelled by caller via agy_cancel after ${elapsedS}s (previous state: ${prevState}).`;
  jobRecord.state = 'cancelled';
  jobRecord.finished_at = new Date().toISOString();
  jobRecord.elapsed_s = elapsedS;
  jobRecord.error = jobEntry.cancelReason;
  jobRecord.result = {
    ok: false,
    cancelled: true,
    timedOut: false,
    jobId: jobRecord.job_id,
    state: 'cancelled',
    startedAt: jobRecord.started_at || jobRecord.queued_at,
    elapsedSeconds: elapsedS,
    modelUsed: jobRecord.model,
    stepDownReason: null,
    conversationId: jobRecord.conversation_id,
    responseText: '',
    deniedActions: [],
    responseEmpty: true,
    governorAlerts: [],
    logFilePath: jobRecord.log_file || null,
    error: jobEntry.cancelReason
  };

  if (jobEntry.child) {
    logStderr(
      `Cancelling running agy job ${jobRecord.job_id} (PID ${pid}, elapsed ${elapsedS}s)...`
    );
    killProcessTree(jobEntry.child);
  } else {
    logStderr(`Cancelling queued agy job ${jobRecord.job_id}...`);
  }

  persistJobAndSessionState(jobRecord, 'finish', jobEntry.provisionalSessionId);

  return {
    ok: true,
    job_id: jobRecord.job_id,
    status: 'cancelled',
    previous_state: prevState,
    state: 'cancelled',
    pid,
    elapsed_s: elapsedS,
    log_file: jobRecord.log_file || null,
    message: jobEntry.cancelReason
  };
}

async function getAgyJobResult(targetJobId, waitMs = 0) {
  const rawId = String(targetJobId || '').trim();
  if (!rawId) {
    return { found: false, job_id: null, message: 'job_id is required.' };
  }

  let resolvedId = rawId;
  if (rawId === 'latest') {
    if (agyJobOrder.length > 0) {
      resolvedId = agyJobOrder[agyJobOrder.length - 1];
    } else {
      const ledger = readJsonSafe(STATE_LEDGER_PATH);
      reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: true });
      const keys = Object.keys(ledger.jobs || {});
      resolvedId = keys.length > 0 ? keys[keys.length - 1] : rawId;
    }
  }

  const jobEntry = agyActiveJobs.get(resolvedId);
  if (jobEntry) {
    const isRunningOrQueued =
      jobEntry.jobRecord.state === 'running' || jobEntry.jobRecord.state === 'queued';
    if (isRunningOrQueued && typeof waitMs === 'number' && waitMs > 0) {
      const effectiveWait = Math.min(waitMs, getAgySoftTimeoutMs());
      let waitTimer = null;
      await Promise.race([
        jobEntry.completionPromise.catch(() => {}),
        new Promise(resolve => {
          waitTimer = setTimeout(resolve, effectiveWait);
        })
      ]);
      if (waitTimer) clearTimeout(waitTimer);
    }

    const jr = jobEntry.jobRecord;
    const stillActive = jr.state === 'running' || jr.state === 'queued';
    return {
      found: true,
      job_id: jr.job_id,
      stillRunning: stillActive,
      jobRecord: serializeJobSummary(jr, true),
      result: jr.result || null
    };
  }

  const ledger = readJsonSafe(STATE_LEDGER_PATH);
  reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: true });
  const persisted = ledger.jobs?.[resolvedId];
  if (persisted) {
    const stillActive = persisted.state === 'running' || persisted.state === 'queued';
    return {
      found: true,
      job_id: persisted.job_id || resolvedId,
      stillRunning: stillActive,
      jobRecord: serializeJobSummary(persisted, true),
      result: persisted.result || null
    };
  }

  return {
    found: false,
    job_id: resolvedId,
    stillRunning: false,
    jobRecord: null,
    result: null,
    message: `Unknown job_id '${resolvedId}'. Check agy_status for active_job and recent_jobs.`
  };
}

async function executeAgyWithGovernor(options = {}) {
  // Fast-fail permission-skipping guard before queueing
  const skipPermsAllowed =
    process.env.AGY_ALLOW_SKIP_PERMISSIONS === '1' &&
    process.env.AGY_DENY_SKIP_PERMISSIONS !== '1';
  if (options.mode === 'dangerously-skip-permissions' && !skipPermsAllowed) {
    return {
      ok: false,
      modelUsed: null,
      stepDownReason: null,
      conversationId: options.conversationId || null,
      responseText: '',
      deniedActions: [],
      responseEmpty: true,
      governorAlerts: [],
      error:
        'refused: permission-skipping mode (--dangerously-skip-permissions / allow_shell: true) is disabled by default for workspace safety (or blocked by AGY_DENY_SKIP_PERMISSIONS=1). Use research mode, an edit without allow_shell, or local_exec_and_triage. Set AGY_ALLOW_SKIP_PERMISSIONS=1 in .mcp.json env to opt in.'
    };
  }

  const backlog = agyQueueState.running + agyQueueState.waiting;
  if (backlog > 0) {
    logStderr(
      `Queueing agy run behind ${backlog} other(s) (max concurrency ${AGY_MAX_CONCURRENCY}; concurrent agy processes interfere).`
    );
  }

  const matrix = readJsonSafe(MODEL_MATRIX_PATH);
  const ledger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
  const { slug: initialModel } = resolveModelSlug(options.requestedModel, matrix, ledger);
  const jobId = options.jobId || `job-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const provisionalSessionId = options.conversationId || jobId;
  const promptPreview = extractPromptPreview(options.prompt, options.rawPrompt);

  const jobRecord = {
    job_id: jobId,
    state: 'queued',
    tier: String(options.requestedModel || 'flash-medium'),
    model: initialModel,
    mode: options.mode || 'plan',
    cwd: options.cwd || WORKSPACE_ROOT,
    prompt_preview: promptPreview,
    queued_at: nowIso,
    started_at: null,
    finished_at: null,
    elapsed_s: 0,
    pid: null,
    log_file: null,
    conversation_id: provisionalSessionId,
    error: null,
    result: null
  };

  const jobEntry = {
    jobRecord,
    provisionalSessionId,
    child: null,
    cancelled: false,
    cancelReason: null,
    queuedMs: nowMs,
    startedMs: null,
    completionPromise: null
  };

  agyActiveJobs.set(jobId, jobEntry);
  agyJobOrder.push(jobId);
  while (agyJobOrder.length > MAX_STORED_JOBS) {
    const oldest = agyJobOrder.shift();
    const oldEntry = agyActiveJobs.get(oldest);
    if (
      oldEntry &&
      oldEntry.jobRecord.state !== 'running' &&
      oldEntry.jobRecord.state !== 'queued'
    ) {
      agyActiveJobs.delete(oldest);
    } else {
      agyJobOrder.unshift(oldest);
      break;
    }
  }

  // Requirement #2: Register the session and job AT START (not at completion)
  persistJobAndSessionState(jobRecord, 'start', provisionalSessionId);

  const completionPromise = enqueueAgyRun(jobEntry, async () => {
    const res = await executeAgyWithGovernorUnqueued({
      ...options,
      jobId,
      jobEntry
    });

    if (typeof options.onComplete === 'function') {
      try {
        await options.onComplete(res);
      } catch (hookErr) {
        logStderr(`Post-completion hook error for ${jobId}: ${hookErr.message}`);
      }
    }

    const wasAlreadyCancelled = jobRecord.state === 'cancelled' && Boolean(jobRecord.finished_at);
    const elapsedS = wasAlreadyCancelled
      ? jobRecord.elapsed_s
      : Math.max(
          0,
          Math.round((Date.now() - (jobEntry.startedMs || jobEntry.queuedMs)) / 1000)
        );
    const finalState =
      wasAlreadyCancelled || res.cancelled
        ? 'cancelled'
        : res.timedOut
        ? 'timed_out'
        : res.ok
        ? 'done'
        : 'failed';

    jobRecord.state = finalState;
    jobRecord.finished_at = wasAlreadyCancelled
      ? jobRecord.finished_at
      : new Date().toISOString();
    jobRecord.elapsed_s = elapsedS;
    jobRecord.model = res.modelUsed || jobRecord.model;
    jobRecord.conversation_id = res.conversationId || provisionalSessionId;
    jobRecord.log_file = res.logFilePath || jobRecord.log_file || null;
    jobRecord.error = res.error || jobRecord.error || null;

    const enrichedRes = {
      ...res,
      jobId,
      state: finalState,
      startedAt: jobRecord.started_at || jobRecord.queued_at,
      elapsedSeconds: elapsedS
    };
    jobRecord.result = enrichedRes;
    persistJobAndSessionState(jobRecord, 'finish', provisionalSessionId);
    return enrichedRes;
  });

  jobEntry.completionPromise = completionPromise;

  // Requirement #1: Soft timeout budget so slow runs return a normal async job response
  // before the client's 600s MCP timeout drops the stdio connection.
  const softTimeoutMs = getAgySoftTimeoutMs(options.softTimeoutMs);
  let softTimer = null;
  const raceOutcome = await Promise.race([
    completionPromise.then(res => ({ completed: true, res })),
    new Promise(resolve => {
      softTimer = setTimeout(() => resolve({ completed: false }), softTimeoutMs);
    })
  ]);
  if (softTimer) clearTimeout(softTimer);

  if (raceOutcome.completed) {
    return raceOutcome.res;
  }

  const startIso = jobRecord.started_at || jobRecord.queued_at;
  const elapsedS = computeLiveElapsedSeconds(jobRecord);
  logStderr(
    `[ASYNC JOB HANDOFF] Job ${jobId} still ${jobRecord.state} after soft budget (${softTimeoutMs}ms). Returning job handle to caller while child continues in background.`
  );

  return {
    ok: true,
    asyncPending: true,
    jobId,
    state: jobRecord.state,
    startedAt: startIso,
    elapsedSeconds: elapsedS,
    modelUsed: jobRecord.model,
    stepDownReason: null,
    conversationId: jobRecord.conversation_id,
    responseText: formatAsyncPendingMessage(jobRecord, softTimeoutMs),
    deniedActions: [],
    responseEmpty: false,
    governorAlerts: []
  };
}

// ============================================================================
// Tier 3 Local Consumer GPU Offload Engine & Safeguards
// ----------------------------------------------------------------------------
// 1. Ollama `/v1/models` vs `/api/ps` Trap Guard:
//    - On port 8080 (`llama-server`), `GET /v1/models` only lists the active model.
//    - On port 11434 (`Ollama`), `GET /v1/models` lists ALL models on disk and
//      picking `data[0].id` can trigger a 15s cold disk load. We probe `GET /api/ps`
//      first to use the model already hot in VRAM, or fall back to an explicit
//      `default_ollama_model` (verified via `/api/tags`) and send `"keep_alive": "30m"`.
// 2. Empty-Output & Destructive Overwrite Guard (`extractAndValidateDraftedCode`):
//    - Rejects empty, < 15 char, unclosed fence, or `finish_reason === 'length'`
//      truncated outputs before touching disk, escalating to `agy_delegate_edit` (`flash-high`).
// 3. Windows Process Tree Kill (`runSubprocessWithTreeKill`):
//    - Uses `taskkill /PID <pid> /T /F` on timeout so `cmd.exe /c pytest` or `npm test`
//      never leaves orphaned `python.exe` / `node.exe` workers.
// 4. 50-50 Head/Tail Slicing + Binary & Secret File Lockout (`local_file_scout`):
//    - Checks first 4KB for `\0` null bytes, blocks `.env*` & private keys, prepends
//      exact 1-based line numbers, and slices 50-50 head/tail preserving line numbers.
// ============================================================================
let localGpuQueueTail = Promise.resolve();
const localGpuQueueState = {
  max_concurrency: LOCAL_GPU_MAX_CONCURRENCY,
  running: 0,
  waiting: 0,
  completed: 0
};

function enqueueLocalGpuRun(taskFn) {
  localGpuQueueState.waiting += 1;
  const run = localGpuQueueTail.then(async () => {
    localGpuQueueState.waiting -= 1;
    localGpuQueueState.running += 1;
    try {
      return await taskFn();
    } finally {
      localGpuQueueState.running -= 1;
      localGpuQueueState.completed += 1;
    }
  });
  localGpuQueueTail = run.catch(() => {});
  return run;
}

function getLocalGpuConfig(matrix = null, profileOverride = null) {
  const m = matrix || readJsonSafe(MODEL_MATRIX_PATH);
  const profileKey = profileOverride || process.env.LOCAL_GPU_PROFILE || m.active_hardware_profile || '12gb_vram';
  const profileCfg = m.hardware_profiles?.[profileKey] || {};
  const cfg = { ...(m.tiers?.tier_0_local_gpu_offload || {}), ...profileCfg };
  const rawEndpoints = [
    process.env.LOCAL_LLM_BASE_URL,
    ...(Array.isArray(cfg.endpoints)
      ? cfg.endpoints
      : ['http://127.0.0.1:8080/v1', 'http://127.0.0.1:11434/v1'])
  ].filter(Boolean);
  const endpoints = Array.from(new Set(rawEndpoints.map(u => u.replace(/\/+$/, ''))));

  return {
    endpoints,
    preferred_model: process.env.LOCAL_LLM_MODEL || cfg.preferred_model || 'auto',
    default_ollama_model:
      process.env.LOCAL_OLLAMA_MODEL || cfg.default_ollama_model || 'qwen2.5-coder:14b',
    allow_cold_ollama_load:
      typeof cfg.allow_cold_ollama_load === 'boolean' ? cfg.allow_cold_ollama_load : true,
    keep_alive: cfg.keep_alive || '30m',
    probe_timeout_ms: cfg.probe_timeout_ms || 1500,
    request_timeout_ms: cfg.request_timeout_ms || 90000,
    max_scout_input_chars: cfg.max_scout_input_chars || 80000,
    max_triage_input_chars: cfg.max_triage_input_chars || 80000,
    max_draft_input_chars: cfg.max_draft_input_chars || 64000,
    scout_max_tokens: cfg.scout_max_tokens || 600,
    triage_max_tokens: cfg.triage_max_tokens || 600,
    draft_max_tokens: cfg.draft_max_tokens || 2048,
    fallback_cloud_tier_scout: cfg.fallback_cloud_tier_scout || 'flash-low',
    fallback_cloud_tier_triage: cfg.fallback_cloud_tier_triage || 'flash-low',
    fallback_cloud_tier_draft: cfg.fallback_cloud_tier_draft || 'flash-high'
  };
}

// Safeguard #1: Probe local endpoints safely (llama-server /v1/models vs Ollama /api/ps)
async function probeAndResolveLocalGpu(customConfig = null, fetchImpl = fetch) {
  const cfg = customConfig ? { ...getLocalGpuConfig(), ...customConfig } : getLocalGpuConfig();
  const probeTimeoutMs = cfg.probe_timeout_ms || 1500;
  const errors = [];

  for (const rawBaseUrl of cfg.endpoints) {
    const baseUrl = rawBaseUrl.replace(/\/+$/, '');
    const isOllamaPort = /:11434(?:\/|$)/.test(baseUrl) || /ollama/i.test(baseUrl);

    if (isOllamaPort) {
      const ollamaRoot = baseUrl.replace(/\/v1$/i, '');
      try {
        // Step 1: Always probe GET /api/ps first on Ollama to check what is HOT in VRAM
        const psRes = await fetchImpl(`${ollamaRoot}/api/ps`, {
          method: 'GET',
          signal: AbortSignal.timeout(probeTimeoutMs)
        });
        if (!psRes.ok) {
          errors.push(`${ollamaRoot}/api/ps HTTP ${psRes.status}`);
          continue;
        }
        const psJson = await psRes.json();
        const hotModels = Array.isArray(psJson?.models) ? psJson.models : [];

        if (hotModels.length > 0) {
          const hotSlug = hotModels[0].model || hotModels[0].name;
          if (hotSlug) {
            return {
              online: true,
              provider: 'ollama',
              baseUrl: baseUrl.endsWith('/v1') ? baseUrl : `${ollamaRoot}/v1`,
              model: hotSlug,
              hotInVram: true,
              keepAlive: cfg.keep_alive || '30m'
            };
          }
        }

        // Step 2: Nothing hot in VRAM (/api/ps is empty). Never pick data[0] from /v1/models!
        // Only use an explicit model slug if configured and permitted.
        const explicitSlug =
          cfg.preferred_model && cfg.preferred_model !== 'auto'
            ? cfg.preferred_model
            : cfg.allow_cold_ollama_load
            ? cfg.default_ollama_model
            : null;

        if (!explicitSlug) {
          errors.push(
            `${ollamaRoot}/api/ps reported 0 models in VRAM and cold Ollama load is disabled`
          );
          continue;
        }

        // Verify the explicit fallback model exists in /api/tags before attempting a cold load
        const tagsRes = await fetchImpl(`${ollamaRoot}/api/tags`, {
          method: 'GET',
          signal: AbortSignal.timeout(probeTimeoutMs)
        });
        if (tagsRes.ok) {
          const tagsJson = await tagsRes.json();
          const installed = (Array.isArray(tagsJson?.models) ? tagsJson.models : []).map(
            m => m.model || m.name
          );
          const matched = installed.find(
            name =>
              name === explicitSlug ||
              name?.toLowerCase() === explicitSlug.toLowerCase() ||
              name?.split(':')[0]?.toLowerCase() === explicitSlug.toLowerCase()
          );
          if (matched) {
            return {
              online: true,
              provider: 'ollama',
              baseUrl: baseUrl.endsWith('/v1') ? baseUrl : `${ollamaRoot}/v1`,
              model: matched,
              hotInVram: false,
              keepAlive: cfg.keep_alive || '30m'
            };
          }
          errors.push(
            `Ollama running at ${ollamaRoot}, /api/ps is empty, and default_ollama_model '${explicitSlug}' not in /api/tags`
          );
          continue;
        }
      } catch (err) {
        errors.push(`${baseUrl} (ollama): ${err.message}`);
        continue;
      }
    } else {
      // Port 8080 (`llama-server` / vLLM / LM Studio): GET /v1/models only serves the loaded model
      const v1Base = baseUrl.endsWith('/v1') ? baseUrl : `${baseUrl}/v1`;
      try {
        const res = await fetchImpl(`${v1Base}/models`, {
          method: 'GET',
          signal: AbortSignal.timeout(probeTimeoutMs)
        });
        if (!res.ok) {
          errors.push(`${v1Base}/models HTTP ${res.status}`);
          continue;
        }
        const json = await res.json();
        const dataArr = Array.isArray(json?.data)
          ? json.data
          : Array.isArray(json?.models)
          ? json.models
          : [];
        const firstId =
          dataArr[0]?.id || dataArr[0]?.model || dataArr[0]?.name || 'local-gpu-model';
        const resolvedModel =
          cfg.preferred_model && cfg.preferred_model !== 'auto' ? cfg.preferred_model : firstId;

        return {
          online: true,
          provider: 'llama-server',
          baseUrl: v1Base,
          model: resolvedModel,
          hotInVram: true,
          keepAlive: null
        };
      } catch (err) {
        errors.push(`${v1Base}: ${err.message}`);
        continue;
      }
    }
  }

  return {
    online: false,
    provider: null,
    baseUrl: null,
    model: null,
    hotInVram: false,
    keepAlive: null,
    reason: errors.join('; ') || 'No local inference endpoint responded'
  };
}

function recordLocalGpuTelemetry({
  localSuccess,
  charsOffloaded = 0,
  endpoint = null,
  model = null,
  status = null
}) {
  try {
    const ledger = readJsonSafe(STATE_LEDGER_PATH);
    const tel = ledger.local_gpu_telemetry || {
      total_requests: 0,
      successful_local_requests: 0,
      fallback_to_cloud_count: 0,
      total_chars_offloaded: 0,
      estimated_cloud_tokens_saved: 0,
      last_active_endpoint: null,
      last_active_model: null,
      last_status: 'unprobed'
    };
    tel.total_requests = (tel.total_requests || 0) + 1;
    if (localSuccess) {
      tel.successful_local_requests = (tel.successful_local_requests || 0) + 1;
      tel.total_chars_offloaded = (tel.total_chars_offloaded || 0) + charsOffloaded;
      tel.estimated_cloud_tokens_saved =
        (tel.estimated_cloud_tokens_saved || 0) + Math.ceil(charsOffloaded / 4);
      if (endpoint) tel.last_active_endpoint = endpoint;
      if (model) tel.last_active_model = model;
    } else {
      tel.fallback_to_cloud_count = (tel.fallback_to_cloud_count || 0) + 1;
    }
    if (status) tel.last_status = status;
    ledger.local_gpu_telemetry = tel;
    ledger.last_updated_at = new Date().toISOString();
    writeJsonSafe(STATE_LEDGER_PATH, ledger);
  } catch (err) {
    logStderr(`Failed updating local_gpu_telemetry: ${err.message}`);
  }
}

async function callLocalGpuChatCompletion({
  systemPrompt,
  userPrompt,
  maxTokens = 600,
  temperature = 0.1,
  customConfig = null,
  fetchImpl = fetch
}) {
  return enqueueLocalGpuRun(async () => {
    const cfg = customConfig ? { ...getLocalGpuConfig(), ...customConfig } : getLocalGpuConfig();
    const probe = await probeAndResolveLocalGpu(cfg, fetchImpl);
    if (!probe.online) {
      return {
        ok: false,
        offline: true,
        reason: probe.reason || 'Local GPU endpoint offline'
      };
    }

    const requestBody = {
      model: probe.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature,
      max_tokens: maxTokens,
      stream: false
    };

    // Safeguard #1: Pass keep_alive: "30m" to Ollama so the model stays hot in VRAM
    if (probe.provider === 'ollama' || probe.keepAlive) {
      requestBody.keep_alive = probe.keepAlive || '30m';
    }

    try {
      const res = await fetchImpl(`${probe.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
        signal: AbortSignal.timeout(cfg.request_timeout_ms || 90000)
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        return {
          ok: false,
          offline: false,
          provider: probe.provider,
          baseUrl: probe.baseUrl,
          model: probe.model,
          reason: `HTTP ${res.status} from ${probe.baseUrl}/chat/completions: ${errBody.slice(0, 240)}`
        };
      }

      const data = await res.json();
      const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
      const content =
        typeof choice?.message?.content === 'string'
          ? choice.message.content
          : typeof choice?.text === 'string'
          ? choice.text
          : '';
      const finishReason = choice?.finish_reason || null;

      return {
        ok: Boolean(content && content.trim()),
        offline: false,
        provider: probe.provider,
        baseUrl: probe.baseUrl,
        model: probe.model,
        hotInVram: probe.hotInVram,
        content,
        finishReason,
        usage: data?.usage || null,
        reason: content && content.trim() ? null : 'Empty content returned by local model'
      };
    } catch (err) {
      return {
        ok: false,
        offline: false,
        provider: probe.provider,
        baseUrl: probe.baseUrl,
        model: probe.model,
        reason: `Local GPU completion error: ${err.message}`
      };
    }
  });
}

// Safeguard #4: Secret file lockout & binary null-byte detector (first 4KB)
const SECRET_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.(?:pem|key|pfx|p12|kdbx|jks|keystore)$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..+)?$/i,
  /^(?:\.npmrc|\.pypirc|\.netrc|_netrc)$/i,
  /credentials\.json$/i,
  /client_secret.*\.json$/i
];
const SAFE_ENV_TEMPLATE_REGEX = /^\.env\.(?:example|sample|template|defaults|test)$/i;

function isSecretOrBlockedPath(filePath) {
  const base = path.basename(filePath || '');
  if (SAFE_ENV_TEMPLATE_REGEX.test(base)) return false;
  return SECRET_FILE_PATTERNS.some(rx => rx.test(base));
}

function isBinaryBuffer(buf, checkBytes = 4096) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return false;
  const limit = Math.min(buf.length, checkBytes);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

function isBinaryFileOnDisk(absPath) {
  let fd = null;
  try {
    fd = fs.openSync(absPath, 'r');
    const sample = Buffer.alloc(4096);
    const bytesRead = fs.readSync(fd, sample, 0, 4096, 0);
    return isBinaryBuffer(sample.subarray(0, bytesRead), bytesRead);
  } catch (_) {
    return false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {}
    }
  }
}

// Safeguard #4: 50-50 Head/Tail Slicing preserving exact 1-based line numbers
function sliceHeadTail5050(rawText, maxChars = 80000) {
  if (typeof rawText !== 'string' || rawText.length <= maxChars) {
    return { text: rawText || '', sliced: false, omittedChars: 0 };
  }
  const half = Math.floor(maxChars / 2);
  const head = rawText.slice(0, half);
  const tail = rawText.slice(rawText.length - half);
  const omittedChars = rawText.length - head.length - tail.length;
  const marker = `\n\n... [50-50 HEAD/TAIL SLICE: Omitted ${omittedChars} middle chars to fit Local GPU context ceiling] ...\n\n`;
  return {
    text: `${head}${marker}${tail}`,
    sliced: true,
    omittedChars
  };
}

function formatNumberedFileWithHeadTailSlice(rawContent, maxChars = 80000) {
  const lines = String(rawContent ?? '').split(/\r?\n/);
  const numberedLines = lines.map((line, idx) => `${idx + 1}: ${line}`);
  const fullText = numberedLines.join('\n');

  if (fullText.length <= maxChars) {
    return {
      text: fullText,
      sliced: false,
      totalLines: lines.length,
      totalChars: fullText.length,
      omittedLines: 0
    };
  }

  const halfBudget = Math.floor(maxChars / 2);
  const headLines = [];
  let headChars = 0;
  let headEndIdx = 0;

  for (let i = 0; i < numberedLines.length; i++) {
    const lineLen = numberedLines[i].length + 1;
    if (headChars + lineLen > halfBudget && headLines.length > 0) break;
    headLines.push(numberedLines[i]);
    headChars += lineLen;
    headEndIdx = i;
  }

  const tailLines = [];
  let tailChars = 0;
  let tailStartIdx = numberedLines.length;

  for (let i = numberedLines.length - 1; i > headEndIdx; i--) {
    const lineLen = numberedLines[i].length + 1;
    if (tailChars + lineLen > halfBudget && tailLines.length > 0) break;
    tailLines.push(numberedLines[i]);
    tailChars += lineLen;
    tailStartIdx = i;
  }
  tailLines.reverse();

  const omittedLines = Math.max(0, tailStartIdx - headEndIdx - 1);
  const marker = `... [50-50 HEAD/TAIL SLICE: Omitted lines ${headEndIdx + 2}..${tailStartIdx} (${omittedLines} lines) to fit Local GPU context] ...`;

  return {
    text: [...headLines, marker, ...tailLines].join('\n'),
    sliced: true,
    totalLines: lines.length,
    totalChars: fullText.length,
    omittedLines
  };
}

// Safeguard #2: Empty-Output & Destructive Overwrite Guard for `local_draft_leaf_code`
function extractAndValidateDraftedCode(rawModelOutput, finishReason = null) {
  if (typeof rawModelOutput !== 'string') {
    return { valid: false, code: '', reason: 'Model output is not a string' };
  }

  if (finishReason === 'length') {
    return {
      valid: false,
      code: '',
      reason: 'Model output hit max_tokens limit (finish_reason=length) and is truncated'
    };
  }

  let cleaned = rawModelOutput.trim();
  if (!cleaned) {
    return { valid: false, code: '', reason: 'Model returned empty output' };
  }

  // Strip reasoning <think>...</think> blocks if present; reject unclosed <think>
  if (/<think>/i.test(cleaned)) {
    if (!/<\/think>/i.test(cleaned)) {
      return {
        valid: false,
        code: '',
        reason: 'Truncated reasoning output: unclosed <think> block'
      };
    }
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  }

  // Check for markdown code fences
  const fenceMatches = cleaned.match(/```/g) || [];
  let extracted = cleaned;

  if (fenceMatches.length > 0) {
    // Odd number of ``` fences means the model failed to close its code block!
    if (fenceMatches.length % 2 !== 0) {
      return {
        valid: false,
        code: '',
        reason: 'Unclosed markdown code fence (```) detected — output was truncated'
      };
    }

    const blockRegex = /```(?:[a-zA-Z0-9_+-]+)?[ \t]*\r?\n([\s\S]*?)```/g;
    const blocks = [];
    let match;
    while ((match = blockRegex.exec(cleaned)) !== null) {
      if (match[1] && match[1].trim()) {
        blocks.push(match[1].trim());
      }
    }

    if (blocks.length === 0) {
      return {
        valid: false,
        code: '',
        reason: 'Markdown code fence contained no extractable code'
      };
    }

    // Select the largest extracted code block (or join if only one)
    blocks.sort((a, b) => b.length - a.length);
    extracted = blocks[0];
  } else {
    // No code fences: reject if it looks like conversational filler or refusal
    if (/^(?:here\s+is|sure[,!]|certainly[,!]|i\s+cannot|i'm\s+sorry|sorry[,!]|as\s+an\s+ai)/i.test(cleaned)) {
      return {
        valid: false,
        code: '',
        reason: 'Conversational filler returned without a fenced code block'
      };
    }
  }

  const trimmedCode = extracted.trim();
  if (trimmedCode.length < 15) {
    return {
      valid: false,
      code: '',
      reason: `Extracted code is too short (${trimmedCode.length} chars < 15 char minimum)`
    };
  }

  // Guard against lazy truncation placeholders inside code
  if (
    /(?:\/\/|#|--)\s*\.\.\.\s*(?:rest\s+of\s+(?:code|file|implementation)|existing\s+code\s+here)/i.test(
      trimmedCode
    )
  ) {
    return {
      valid: false,
      code: '',
      reason: 'Drafted code contains lazy truncation placeholder comments'
    };
  }

  return {
    valid: true,
    code: `${trimmedCode}\n`,
    reason: null
  };
}

// Safe Command Allowlist for local_exec_and_triage (blocks command chaining &&, ;, |)
const SAFE_TRIAGE_RUNNER_PREFIXES = Object.freeze([
  'pytest',
  'python -m pytest',
  'python -m unittest',
  'python3 -m pytest',
  'python3 -m unittest',
  'npm test',
  'npm run test',
  'npm run lint',
  'npm run typecheck',
  'npm run build',
  'npm run check',
  'pnpm test',
  'pnpm run',
  'yarn test',
  'yarn lint',
  'yarn typecheck',
  'bun test',
  'npx tsc',
  'npx vitest',
  'npx jest',
  'npx eslint',
  'npx playwright test',
  'tsc',
  'vitest',
  'jest',
  'eslint',
  'ruff',
  'flake8',
  'mypy',
  'cargo check',
  'cargo test',
  'cargo clippy',
  'cargo build',
  'go test',
  'go vet',
  'dotnet test',
  'dotnet build',
  'mvn test',
  'gradle test',
  'git status',
  'git diff',
  'git log',
  'ping'
]);

function validateSafeTriageCommand(command) {
  const trimmed = String(command || '').trim();
  if (!trimmed) {
    return { allowed: false, reason: 'Command is empty' };
  }
  if (/[;&|`\r\n]|\$\(/.test(trimmed)) {
    return {
      allowed: false,
      reason: 'Command chaining or subshell operators (&&, ||, ;, |, backticks, $()) are forbidden in local_exec_and_triage'
    };
  }
  if (process.env.AGY_ALLOW_ARBITRARY_TRIAGE_CMD === '1') {
    return { allowed: true, reason: null };
  }
  const lower = trimmed.toLowerCase();
  const matched = SAFE_TRIAGE_RUNNER_PREFIXES.some(prefix => {
    const p = prefix.trim().toLowerCase();
    return lower === p || lower.startsWith(p + ' ');
  });
  if (!matched) {
    return {
      allowed: false,
      reason: `Command "${trimmed}" is not in the safe test/typecheck/lint runner allow-list (e.g., pytest, npm test, npx tsc, cargo check, go test)`
    };
  }
  return { allowed: true, reason: null };
}

// Strip ANSI escape codes from terminal logs
function stripAnsiCodes(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
}

// Safeguard #3: Subprocess execution with Windows Process Tree Kill (`taskkill /PID <pid> /T /F`)
function runSubprocessWithTreeKill({ command, cwd = WORKSPACE_ROOT, env = process.env, timeoutMs = 120000 }) {
  return new Promise(resolve => {
    const isWin = process.platform === 'win32';
    const shellBin = isWin ? process.env.ComSpec || 'cmd.exe' : '/bin/sh';
    const shellArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command];

    let stdoutBuf = '';
    let stderrBuf = '';
    let timedOut = false;
    let settled = false;

    const child = spawn(shellBin, shellArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = setTimeout(() => {
      if (settled) return;
      timedOut = true;
      logStderr(
        `local_exec_and_triage command timed out after ${timeoutMs}ms (PID ${child.pid}). Reaping process tree...`
      );
      killProcessTree(child);
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdoutBuf += chunk.toString('utf8');
    });

    child.stderr.on('data', chunk => {
      stderrBuf += chunk.toString('utf8');
    });

    child.on('error', err => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut,
        pid: child.pid,
        stdout: stripAnsiCodes(stdoutBuf),
        stderr: stripAnsiCodes(`${stderrBuf}\n${err.message}`)
      });
    });

    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: typeof code === 'number' ? code : timedOut ? 124 : -1,
        timedOut,
        pid: child.pid,
        stdout: stripAnsiCodes(stdoutBuf),
        stderr: stripAnsiCodes(stderrBuf)
      });
    });
  });
}

// Execute agy CLI with Reactive Cooldown Parser (Section 2D), Hard Watchdog, Cancellation,
// Workspace Env Injection & Fallback Step-down.
// Never call this directly: use executeAgyWithGovernor so runs are serialized and tracked.
async function executeAgyWithGovernorUnqueued({
  prompt,
  requestedModel,
  mode = 'plan',
  conversationId = null,
  continueLatest = false,
  cwd = WORKSPACE_ROOT,
  allowFallbackRetry = true,
  hardTimeoutMs = null,
  jobId = null,
  jobEntry = null
}) {
  // Permission-skipping mode (--dangerously-skip-permissions) is off by default and
  // explicitly refused when AGY_DENY_SKIP_PERMISSIONS=1 unless AGY_ALLOW_SKIP_PERMISSIONS=1 is set.
  const skipPermsAllowed =
    process.env.AGY_ALLOW_SKIP_PERMISSIONS === '1' &&
    process.env.AGY_DENY_SKIP_PERMISSIONS !== '1';
  if (mode === 'dangerously-skip-permissions' && !skipPermsAllowed) {
    return {
      ok: false,
      modelUsed: null,
      stepDownReason: null,
      conversationId: conversationId || null,
      responseText: '',
      deniedActions: [],
      responseEmpty: true,
      governorAlerts: [],
      error:
        'refused: permission-skipping mode (--dangerously-skip-permissions / allow_shell: true) is disabled by default for workspace safety (or blocked by AGY_DENY_SKIP_PERMISSIONS=1). Use research mode, an edit without allow_shell, or local_exec_and_triage. Set AGY_ALLOW_SKIP_PERMISSIONS=1 in .mcp.json env to opt in.'
    };
  }

  const agyBin = resolveAgyBinary();
  const matrix = readJsonSafe(MODEL_MATRIX_PATH);
  const ledger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
  const ideSync = readJsonSafe(IDE_SYNC_PATH);
  const wsEnv = ideSync.workspace_environment || {};
  const hardMaxMs = getAgyRunMaxMs(hardTimeoutMs);

  const fallbackChain = matrix.fallback_chain || [
    'gemini-4-argon-high',
    'gemini-4-argon-medium',
    'gemini-4-argon-low',
    'gemini-3.8-flash-high',
    'gemini-3.8-flash-medium',
    'gemini-3.8-flash-low'
  ];

  // Gotcha #5: Check git worktree config before launching agy (report-only by default)
  checkAndFixGitWorktreeConfig(cwd, false);

  let { slug: currentModel, stepDownReason } = resolveModelSlug(requestedModel, matrix, ledger);
  const triedModels = [];

  // Build child environment with project PATH entries and env_overrides
  const childEnv = { ...process.env, ...(wsEnv.env_overrides || {}) };
  if (Array.isArray(wsEnv.extra_path_entries) && wsEnv.extra_path_entries.length > 0) {
    const pathKey = Object.keys(childEnv).find(k => k.toUpperCase() === 'PATH') || 'PATH';
    childEnv[pathKey] = [...wsEnv.extra_path_entries, childEnv[pathKey] || ''].join(path.delimiter);
  }

  while (true) {
    triedModels.push(currentModel);
    const runId = crypto.randomBytes(4).toString('hex');
    const logFilePath = path.join(TEMP_LOG_DIR, `agy-${Date.now()}-${runId}.log`);

    const args = [
      '-p',
      prompt,
      '--model',
      currentModel,
      '--output-format',
      'json',
      '--log-file',
      logFilePath
    ];

    // Pass any additional configured workspace directories (--add-dir)
    if (Array.isArray(wsEnv.add_dirs)) {
      for (const dir of wsEnv.add_dirs) {
        if (dir && fs.existsSync(dir)) {
          args.push('--add-dir', dir);
        }
      }
    }

    if (mode === 'dangerously-skip-permissions') {
      args.push('--dangerously-skip-permissions');
    } else if (mode === 'accept-edits') {
      args.push('--mode', 'accept-edits');
    } else {
      args.push('--mode', 'plan');
    }

    if (conversationId) {
      args.push('--conversation', conversationId);
    } else if (continueLatest) {
      args.push('-c');
    }

    logStderr(
      `Spawning agy: job=${jobId || 'adhoc'}, model=${currentModel}, mode=${mode}, cwd=${cwd}, watchdog=${hardMaxMs}ms`
    );

    const attemptResult = await new Promise(resolve => {
      let stdoutBuf = '';
      let stderrBuf = '';
      let abortedFor429 = null;
      let abortedForWatchdog = false;
      let finished = false;

      const isJsScript = /\.m?js$/i.test(agyBin);
      const spawnCmd = isJsScript ? process.execPath : agyBin;
      const spawnArgs = isJsScript ? [agyBin, ...args] : args;

      const child = spawn(spawnCmd, spawnArgs, {
        cwd,
        env: childEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });

      if (jobEntry) {
        jobEntry.child = child;
        jobEntry.jobRecord.pid = child.pid || null;
        jobEntry.jobRecord.log_file = logFilePath;
        jobEntry.jobRecord.model = currentModel;
        persistJobAndSessionState(jobEntry.jobRecord, 'running', jobEntry.provisionalSessionId);
      }

      const watchdogTimer = setTimeout(() => {
        if (finished) return;
        abortedForWatchdog = true;
        logStderr(
          `[WATCHDOG] agy job ${jobId || 'adhoc'} exceeded AGY_RUN_MAX_MS (${hardMaxMs}ms) on ${currentModel} (PID ${child.pid}). Terminating process tree...`
        );
        killProcessTree(child);
      }, hardMaxMs);

      const checkLogFor429 = () => {
        if (finished || abortedFor429 || abortedForWatchdog || jobEntry?.cancelled) return;
        let logContent = '';
        try {
          if (fs.existsSync(logFilePath)) {
            logContent = fs.readFileSync(logFilePath, 'utf8');
          }
        } catch (_) {}

        const combinedCheck = `${stderrBuf}\n${logContent}`;
        const detected = detectQuotaExhaustion(combinedCheck);
        if (detected) {
          abortedFor429 = detected;
          logStderr(
            `Detected 429/Quota Exhaustion on ${currentModel} (${detected.matched}). Terminating hung child PID ${child.pid}...`
          );
          killProcessTree(child);
        }
      };

      const pollTimer = setInterval(checkLogFor429, 500);

      child.stdout.on('data', chunk => {
        stdoutBuf += chunk.toString('utf8');
      });

      child.stderr.on('data', chunk => {
        stderrBuf += chunk.toString('utf8');
        checkLogFor429();
      });

      child.on('error', err => {
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(watchdogTimer);
        if (jobEntry) jobEntry.child = null;
        resolve({
          ok: false,
          exitCode: -1,
          stdout: stdoutBuf,
          stderr: `${stderrBuf}\n${err.message}`,
          abortedFor429,
          abortedForWatchdog,
          abortedForCancel: Boolean(jobEntry?.cancelled),
          logFilePath
        });
      });

      child.on('close', code => {
        finished = true;
        clearInterval(pollTimer);
        clearTimeout(watchdogTimer);
        if (jobEntry) jobEntry.child = null;
        if (!abortedFor429 && !abortedForWatchdog && !jobEntry?.cancelled) {
          let logContent = '';
          try {
            if (fs.existsSync(logFilePath)) {
              logContent = fs.readFileSync(logFilePath, 'utf8');
            }
          } catch (_) {}
          abortedFor429 = detectQuotaExhaustion(`${stderrBuf}\n${stdoutBuf}\n${logContent}`);
        }
        resolve({
          ok: code === 0 && !abortedFor429 && !abortedForWatchdog && !jobEntry?.cancelled,
          exitCode: code,
          stdout: stdoutBuf,
          stderr: stderrBuf,
          abortedFor429,
          abortedForWatchdog,
          abortedForCancel: Boolean(jobEntry?.cancelled),
          logFilePath
        });
      });
    });

    // Requirement #4: Caller cancelled job via agy_cancel
    if (attemptResult.abortedForCancel || jobEntry?.cancelled) {
      const cancelMsg =
        jobEntry?.cancelReason ||
        `Job ${jobId || 'adhoc'} was cancelled by caller via agy_cancel.`;
      return {
        ok: false,
        cancelled: true,
        timedOut: false,
        modelUsed: currentModel,
        stepDownReason,
        conversationId: conversationId || jobId || null,
        responseText: '',
        deniedActions: [],
        responseEmpty: true,
        governorAlerts: [],
        logFilePath: fs.existsSync(attemptResult.logFilePath) ? attemptResult.logFilePath : null,
        error: cancelMsg
      };
    }

    // Requirement #3: Hard watchdog backstop killed a hung agy child — preserve log file on disk!
    if (attemptResult.abortedForWatchdog) {
      try {
        if (!fs.existsSync(attemptResult.logFilePath)) {
          const diagnosticLog = [
            `[WATCHDOG TERMINATION] Job ${jobId || 'adhoc'} exceeded AGY_RUN_MAX_MS (${hardMaxMs}ms) on ${currentModel}.`,
            attemptResult.stderr ? `[STDERR]\n${attemptResult.stderr}` : '',
            attemptResult.stdout ? `[STDOUT]\n${attemptResult.stdout}` : ''
          ]
            .filter(Boolean)
            .join('\n\n');
          fs.writeFileSync(attemptResult.logFilePath, diagnosticLog, 'utf8');
        }
      } catch (_) {}

      const watchdogErr = `Hard watchdog timeout: job ${
        jobId || 'adhoc'
      } exceeded AGY_RUN_MAX_MS (${hardMaxMs}ms / ${Math.round(
        hardMaxMs / 1000
      )}s) on ${currentModel} and was killed. Log preserved at: ${attemptResult.logFilePath}`;
      return {
        ok: false,
        cancelled: false,
        timedOut: true,
        modelUsed: currentModel,
        stepDownReason,
        conversationId: conversationId || jobId || null,
        responseText: '',
        deniedActions: [],
        responseEmpty: true,
        governorAlerts: [],
        logFilePath: attemptResult.logFilePath,
        error: watchdogErr,
        rawStderr: attemptResult.stderr
      };
    }

    try {
      if (fs.existsSync(attemptResult.logFilePath)) {
        fs.unlinkSync(attemptResult.logFilePath);
      }
    } catch (_) {}

    if (attemptResult.abortedFor429) {
      const freshLedger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
      if (!freshLedger.model_quotas.per_model_locks[currentModel]) {
        freshLedger.model_quotas.per_model_locks[currentModel] = {
          locked_until_timestamp: null,
          last_429_at: null,
          last_reset_raw: null,
          total_requests: 0,
          total_tokens: 0
        };
      }
      freshLedger.model_quotas.per_model_locks[currentModel].locked_until_timestamp =
        attemptResult.abortedFor429.lockedUntilIso;
      freshLedger.model_quotas.per_model_locks[currentModel].last_429_at = new Date().toISOString();
      freshLedger.model_quotas.per_model_locks[currentModel].last_reset_raw =
        attemptResult.abortedFor429.matched;
      freshLedger.last_updated_at = new Date().toISOString();
      writeJsonSafe(STATE_LEDGER_PATH, freshLedger);

      const currentIdx = fallbackChain.indexOf(currentModel);
      if (allowFallbackRetry && currentIdx !== -1 && currentIdx + 1 < fallbackChain.length) {
        const nextModel = fallbackChain[currentIdx + 1];
        stepDownReason = `429 on ${currentModel} (locked until ${attemptResult.abortedFor429.lockedUntilIso}) -> stepped down to ${nextModel}`;
        currentModel = nextModel;
        continue;
      }

      return {
        ok: false,
        cancelled: false,
        timedOut: false,
        modelUsed: currentModel,
        stepDownReason,
        conversationId: conversationId || jobId || null,
        responseText: '',
        deniedActions: [],
        responseEmpty: true,
        governorAlerts: [],
        error: `Gemini quota exhausted on ${currentModel} (${attemptResult.abortedFor429.matched}). Locked until ${attemptResult.abortedFor429.lockedUntilIso}.`,
        rawStderr: attemptResult.stderr
      };
    }

    let parsedJson = null;
    const trimmedOut = (attemptResult.stdout || '').trim();
    if (trimmedOut) {
      try {
        parsedJson = JSON.parse(trimmedOut);
      } catch (_) {
        const lines = trimmedOut.split(/\r?\n/).reverse();
        for (const line of lines) {
          if (line.trim().startsWith('{') && line.trim().endsWith('}')) {
            try {
              parsedJson = JSON.parse(line.trim());
              break;
            } catch (_) {}
          }
        }
      }
    }

    const resolvedConvId =
      parsedJson?.conversation_id || conversationId || `session-${Date.now()}`;
    const responseText =
      typeof parsedJson?.response === 'string'
        ? parsedJson.response
        : trimmedOut || attemptResult.stderr || '(No output returned from agy)';

    // Headless denial detection (see permission-model note at top of file)
    const deniedActions = Array.isArray(parsedJson?.denied_actions) ? parsedJson.denied_actions : [];
    const responseEmpty =
      typeof parsedJson?.response === 'string' ? parsedJson.response.trim() === '' : !trimmedOut;
    const governorAlerts = buildGovernorAlerts(deniedActions, responseEmpty, attemptResult);
    if (deniedActions.length > 0) {
      logStderr(
        `agy auto-denied ${deniedActions.length} action(s) on ${currentModel}: ${deniedActions
          .map(describeDeniedAction)
          .join('; ')}`
      );
    }
    if (responseEmpty) {
      logStderr(`agy returned an empty response on ${currentModel} (exit code ${attemptResult.exitCode}).`);
    }

    const usageObj = parsedJson?.usage || null;
    const estimatedTokensTurn =
      usageObj?.total_tokens ||
      Math.ceil(((prompt?.length || 0) + (responseText?.length || 0)) / 4) + 2500;

    const updatedLedger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
    const modelMeta = matrix.models?.[currentModel] || {
      context_ceiling_tokens: 1000000,
      quota_burn_weight: 2
    };
    const maxContextTokens = modelMeta.context_ceiling_tokens || 1000000;
    const burnWeight = modelMeta.quota_burn_weight || 1;

    const existingSession = updatedLedger.sessions[resolvedConvId] || {
      conversation_id: resolvedConvId,
      cwd,
      model: currentModel,
      estimated_tokens_used: 0,
      max_context_tokens: maxContextTokens,
      turns: 0,
      created_at: jobEntry?.jobRecord?.queued_at || new Date().toISOString(),
      last_updated_at: null,
      compacted_from: null
    };

    existingSession.model = currentModel;
    existingSession.cwd = cwd;
    existingSession.max_context_tokens = maxContextTokens;
    existingSession.estimated_tokens_used = usageObj?.total_tokens
      ? usageObj.total_tokens
      : existingSession.estimated_tokens_used + estimatedTokensTurn;
    existingSession.turns = (existingSession.turns || 0) + 1;
    existingSession.last_updated_at = new Date().toISOString();
    if (jobEntry?.jobRecord) {
      existingSession.job_id = jobEntry.jobRecord.job_id;
      existingSession.state = attemptResult.ok && !responseEmpty ? 'done' : 'failed';
      existingSession.tier = jobEntry.jobRecord.tier;
      existingSession.mode = jobEntry.jobRecord.mode;
      existingSession.prompt_preview = jobEntry.jobRecord.prompt_preview;
      existingSession.started_at =
        jobEntry.jobRecord.started_at || jobEntry.jobRecord.queued_at;
      existingSession.finished_at = existingSession.last_updated_at;
      existingSession.elapsed_s = computeLiveElapsedSeconds(jobEntry.jobRecord);
    }

    updatedLedger.sessions[resolvedConvId] = existingSession;
    updatedLedger.active_session_id = resolvedConvId;

    const w5h = updatedLedger.model_quotas.shared_5h_window;
    w5h.estimated_requests_in_window = (w5h.estimated_requests_in_window || 0) + 1;
    w5h.weighted_burn_units_in_window = (w5h.weighted_burn_units_in_window || 0) + burnWeight;
    w5h.estimated_remaining_pct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          ((w5h.max_weighted_burn_units - w5h.weighted_burn_units_in_window) /
            w5h.max_weighted_burn_units) *
            100
        )
      )
    );

    const wWeekly = updatedLedger.model_quotas.shared_weekly_window;
    wWeekly.estimated_requests_in_window = (wWeekly.estimated_requests_in_window || 0) + 1;
    wWeekly.weighted_burn_units_in_window =
      (wWeekly.weighted_burn_units_in_window || 0) + burnWeight;
    wWeekly.estimated_remaining_pct = Math.max(
      0,
      Math.min(
        100,
        Math.round(
          ((wWeekly.max_weighted_burn_units - wWeekly.weighted_burn_units_in_window) /
            wWeekly.max_weighted_burn_units) *
            100
        )
      )
    );

    if (!updatedLedger.model_quotas.per_model_locks[currentModel]) {
      updatedLedger.model_quotas.per_model_locks[currentModel] = {
        locked_until_timestamp: null,
        last_429_at: null,
        last_reset_raw: null,
        total_requests: 0,
        total_tokens: 0
      };
    }
    updatedLedger.model_quotas.per_model_locks[currentModel].total_requests += 1;
    updatedLedger.model_quotas.per_model_locks[currentModel].total_tokens += estimatedTokensTurn;
    updatedLedger.last_updated_at = new Date().toISOString();

    writeJsonSafe(STATE_LEDGER_PATH, updatedLedger);

    triggerVisualHudFollowFiles(responseText, cwd);

    return {
      ok: attemptResult.ok && !responseEmpty,
      modelUsed: currentModel,
      stepDownReason,
      conversationId: resolvedConvId,
      responseText,
      deniedActions,
      responseEmpty,
      governorAlerts,
      usage: usageObj,
      session: existingSession,
      exitCode: attemptResult.exitCode
    };
  }
}

// Section 2C: Automatic Context Compaction when a session exceeds 80% of its context window
async function checkAndCompactSessionIfNeeded(conversationId, cwd = WORKSPACE_ROOT) {
  const ledger = readJsonSafe(STATE_LEDGER_PATH);
  const threshold = ledger.context_compaction_threshold || 0.8;
  const session = ledger.sessions?.[conversationId];
  if (!session) return { compacted: false, conversationId, handoffSummary: null };

  const ratio = (session.estimated_tokens_used || 0) / (session.max_context_tokens || 1000000);
  if (ratio < threshold) {
    return { compacted: false, conversationId, handoffSummary: null };
  }

  logStderr(
    `Session ${conversationId} reached ${Math.round(ratio * 100)}% of context ceiling (>= ${Math.round(
      threshold * 100
    )}%). Running automatic compaction handoff...`
  );

  const compactionPrompt =
    'CONTEXT COMPACTION HANDOFF: Summarize the current session state concisely so a fresh session can continue seamlessly. Include: (1) Key files and line ranges inspected/modified, (2) Architectural findings or decisions made, and (3) Remaining open tasks.';

  const res = await executeAgyWithGovernor({
    prompt: withShellRules(compactionPrompt),
    rawPrompt: compactionPrompt,
    requestedModel: 'gemini-3.8-flash-medium',
    mode: 'plan',
    conversationId,
    cwd
  });

  if (!res.ok || res.asyncPending) {
    logStderr(
      `Automatic context compaction for ${conversationId} did not finish synchronously (ok=${res.ok}, asyncPending=${Boolean(
        res.asyncPending
      )}). Continuing without compaction replacement.`
    );
    return { compacted: false, conversationId, handoffSummary: null };
  }

  const summary =
    res.responseText || 'Prior session compacted due to exceeding 80% context ceiling.';
  const updatedLedger = readJsonSafe(STATE_LEDGER_PATH);
  if (updatedLedger.sessions?.[conversationId]) {
    updatedLedger.sessions[conversationId].compacted_at = new Date().toISOString();
    updatedLedger.sessions[conversationId].handoff_summary = summary;
    writeJsonSafe(STATE_LEDGER_PATH, updatedLedger);
  }

  return {
    compacted: true,
    previousConversationId: conversationId,
    conversationId: null,
    handoffSummary: summary
  };
}

// Section 3: Antigravity IDE Visual HUD Synchronization (Safe against window hijacking)
function triggerVisualHudFollowFiles(responseText, cwd = WORKSPACE_ROOT, explicitFiles = []) {
  const ideSync = readJsonSafe(IDE_SYNC_PATH);
  // Only fire --reuse-window when IDE HUD is enabled AND attached to this workspace
  if (!ideSync.enabled || !ideSync.follow_files || !ideSync.ide_window_attached) return [];

  const ideBin = resolveIdeBinary(ideSync);
  const maxFollow = ideSync.max_auto_follow_files_per_turn || 3;
  const targets = [];

  for (const item of explicitFiles || []) {
    if (typeof item === 'string' && item.trim()) {
      targets.push(item.trim());
    }
  }

  if (responseText && targets.length < maxFollow) {
    const regex = /(?:^|[\s`'"])([a-zA-Z0-9_.\-/\\]+\.[a-zA-Z0-9]+):L?(\d+)(?:-L?\d+)?(?=$|[\s`'"),.;])/g;
    let match;
    while ((match = regex.exec(responseText)) !== null) {
      const relOrAbs = match[1];
      const lineNum = match[2];
      const fullPath = path.isAbsolute(relOrAbs) ? relOrAbs : path.resolve(cwd, relOrAbs);
      if (fs.existsSync(fullPath)) {
        const spec = `${fullPath}:${lineNum}`;
        if (!targets.includes(spec)) {
          targets.push(spec);
          if (targets.length >= maxFollow) break;
        }
      }
    }
  }

  for (const target of targets.slice(0, maxFollow)) {
    try {
      const child = spawn(ideBin, ['--reuse-window', '-g', target], {
        cwd,
        detached: true,
        windowsHide: true,
        stdio: 'ignore'
      });
      child.unref();
    } catch (err) {
      logStderr(`IDE follow_files jump failed for ${target}: ${err.message}`);
    }
  }

  return targets;
}

// Trigger Visual Diff Review in Antigravity IDE (--diff <before> <after>)
function triggerVisualDiffReview(beforePath, afterPath, cwd = WORKSPACE_ROOT) {
  const ideSync = readJsonSafe(IDE_SYNC_PATH);
  if (!ideSync.enabled || !ideSync.visual_review_gate || !ideSync.ide_window_attached) return false;

  const ideBin = resolveIdeBinary(ideSync);
  try {
    const child = spawn(ideBin, ['--reuse-window', '--diff', beforePath, afterPath], {
      cwd,
      detached: true,
      windowsHide: true,
      stdio: 'ignore'
    });
    child.unref();
    return true;
  } catch (err) {
    logStderr(`IDE visual diff failed: ${err.message}`);
    return false;
  }
}

// Section 2F: Mandatory Telemetry Footer Generator
function buildTelemetryFooter(activeModelSlug = null, sessionId = null) {
  const matrix = readJsonSafe(MODEL_MATRIX_PATH);
  const ledger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
  const ideSync = readJsonSafe(IDE_SYNC_PATH);

  const effectiveSessionId = sessionId || ledger.active_session_id || 'none';
  const sessionObj = ledger.sessions?.[effectiveSessionId] || null;
  const effectiveModel = activeModelSlug || sessionObj?.model || 'gemini-3.8-flash-medium';

  const maxTokens =
    sessionObj?.max_context_tokens ||
    matrix.models?.[effectiveModel]?.context_ceiling_tokens ||
    1000000;
  const usedTokens = sessionObj?.estimated_tokens_used || 0;
  const remainingTokens = Math.max(0, maxTokens - usedTokens);
  const remainingK = Math.round(remainingTokens / 1000);
  const maxK = Math.round(maxTokens / 1000);
  const remainingPct = Math.max(0, Math.min(100, Math.round((remainingTokens / maxTokens) * 100)));

  const w5h = ledger.model_quotas?.shared_5h_window || {};
  const quotaPct =
    typeof w5h.estimated_remaining_pct === 'number' ? w5h.estimated_remaining_pct : 100;
  let resetTimerStr = `${quotaPct}% est. remaining`;
  if (w5h.window_start_timestamp) {
    const elapsedMs = Date.now() - Date.parse(w5h.window_start_timestamp);
    const leftMs = Math.max(0, (w5h.window_duration_seconds || 18000) * 1000 - elapsedMs);
    const h = Math.floor(leftMs / 3600000);
    const m = Math.floor((leftMs % 3600000) / 60000);
    resetTimerStr = `${quotaPct}% (~${h}h${m}m in window)`;
  }

  const locks = ledger.model_quotas?.per_model_locks || {};
  const argonHighLock = locks['gemini-4-argon-high']?.locked_until_timestamp;
  const argonMedLock = locks['gemini-4-argon-medium']?.locked_until_timestamp;
  const argonLowLock = locks['gemini-4-argon-low']?.locked_until_timestamp;

  let argonStatus = 'Available';
  if (argonHighLock && argonMedLock && argonLowLock) {
    argonStatus = `Throttled (until ${argonLowLock})`;
  } else if (argonHighLock || quotaPct < 30) {
    argonStatus = 'Step-down Active (Argon-High Throttled)';
  }

  const discovered = matrix.discovered_models || [];
  const baselineCount = (matrix.baseline_models || []).length || 6;
  const watchdogStr =
    discovered.length > 0
      ? `NEW MODEL DETECTED: [${discovered.join(', ')}]`
      : `Up to date (${baselineCount} Gemini models)`;

  let hudStatus = 'Disabled';
  if (ideSync.enabled) {
    hudStatus = ideSync.ide_window_attached
      ? 'Active (IDE Window Attached)'
      : 'Active (Headless / IDE Unattached)';
  }

  const localTel = ledger.local_gpu_telemetry || {};
  const localSavedK = Math.round((localTel.estimated_cloud_tokens_saved || 0) / 1000);
  const localModelStr = localTel.last_active_model || 'Standby (Auto-Escalates to Flash)';

  return [
    '',
    '---',
    '[AGY GOVERNOR TELEMETRY]',
    `Active Engine: ${effectiveModel} | Session ID: ${effectiveSessionId}`,
    `Session Context Left: ~${remainingK}k / ${maxK}k tokens (${remainingPct}%)`,
    `Gemini Quota Status: 5h Window [${resetTimerStr}] | Argon Tier: ${argonStatus}`,
    `Local GPU Tier: ${localModelStr} | Saved: ~${localSavedK}k cloud tokens (${
      localTel.successful_local_requests || 0
    } local / ${localTel.fallback_to_cloud_count || 0} escalated)`,
    `Model Watchdog: ${watchdogStr}`,
    `IDE HUD Sync: ${hudStatus}`,
    `Disk-Truth Guard: Treat prior chat history as stale — verify with local_file_scout (<file>:<line>) before answering or editing.`
  ].join('\n');
}

// Validate disjoint path partitions for agy_spawn_swarm (Section 2E.2)
function validateDisjointSwarmPartitions(tasks) {
  const normalizedList = [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    const paths = Array.isArray(t.paths) ? t.paths : [];
    if (paths.length === 0) {
      return {
        valid: false,
        reason: `Swarm task #${i + 1} (${t.id || 'unnamed'}) is missing required 'paths' partition array (e.g. ["src/auth/**"]).`
      };
    }
    for (const rawPath of paths) {
      const clean = rawPath
        .replace(/\\/g, '/')
        .replace(/\/\*\*.*$/, '')
        .replace(/\/\*.*$/, '')
        .replace(/\/+$/, '')
        .toLowerCase();

      for (const prev of normalizedList) {
        if (
          clean === prev.clean ||
          clean.startsWith(prev.clean + '/') ||
          prev.clean.startsWith(clean + '/')
        ) {
          return {
            valid: false,
            reason: `Path collision detected between swarm task '${prev.taskId}' (${prev.raw}) and '${
              t.id || `task-${i + 1}`
            }' (${rawPath}). Subagents must operate on strictly disjoint directories.`
          };
        }
      }
      normalizedList.push({
        taskId: t.id || `task-${i + 1}`,
        raw: rawPath,
        clean
      });
    }
  }
  return { valid: true };
}

// MCP Tool Definitions (Section 2E + Workspace Provisioner + Async Job Controls)
const MCP_TOOLS = [
  {
    name: 'agy_delegate_research',
    description:
      'Delegate deep read-only codebase research, cross-module architectural analysis, bug root-cause tracing, or security verification to Google Antigravity CLI (agy) using verified Gemini 3.8 Flash or Gemini 4 Argon models in --mode=plan. SERIALIZATION & ASYNC BUDGET: Calls are serialized (one at a time, AGY_MAX_CONCURRENCY = 1); a prompt that needs more than ~8 minutes of agent time should be split into one bounded question per call, or launched expecting to fetch the result by job_id via `agy_job_result` (soft handoff at 540s, hard watchdog at AGY_RUN_MAX_MS, cancellable via `agy_cancel`). WHEN TO USE: Complex multi-file reasoning or architectural audits across 5–30+ files after initial scouting. DO NOT USE FOR: Simple signature, import, or line-number extraction on known files (use `local_file_scout` instead at 0x quota) or parallel disjoint directory scans (use `agy_spawn_swarm` instead). RETURNS: Markdown analysis with <file>:<line> citations (or an async `job_id` handle if still running at soft budget) and telemetry footer.',
    annotations: {
      title: 'Delegate Cloud Research (Gemini Flash/Argon)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          description:
            'Detailed research or analysis prompt for Antigravity. Name the specific files to inspect. Keep to one bounded question (<~8 min agent time) or use agy_job_result if handed a job_id.'
        },
        tier: {
          type: 'string',
          enum: [
            'flash-low',
            'flash-medium',
            'flash-high',
            'argon-low',
            'argon-medium',
            'argon-high'
          ],
          default: 'flash-medium',
          description:
            'Gemini routing tier: flash-low/flash-medium (1x triage), flash-high (2x module summary), argon-low/argon-medium (4x cross-module reasoning), argon-high (6x apex architecture/security).'
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path (defaults to workspace root).'
        },
        files_to_follow: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of <file>:<line> targets (e.g. ["src/index.ts:42"]) to jump to in the Antigravity IDE HUD.'
        },
        html_artifact_name: {
          type: 'string',
          description:
            'Optional filename (e.g. "arch-overview.html") to instruct agy to write a self-contained visual HTML report.'
        },
        soft_timeout_ms: {
          type: 'number',
          minimum: 100,
          maximum: 590000,
          description:
            'Optional soft budget in milliseconds before returning an async job_id handle (default 540000 = 540s, below the 600s client timeout).'
        }
      },
      required: ['prompt', 'tier']
    }
  },
  {
    name: 'agy_spawn_swarm',
    description:
      'Dispatch multiple read-only Antigravity subagents using gemini-3.8-flash-low or gemini-3.8-flash-medium across strictly disjoint directory partitions. SERIALIZATION & ASYNC BUDGET: Tasks run sequentially one after another (one at a time, AGY_MAX_CONCURRENCY = 1) and share the same ~8-minute soft budget ceiling; keep each task prompt bounded or fetch any in-flight task result by job_id via `agy_job_result`. WHEN TO USE: Exploring multiple independent subsystems or directories in a single turn. DO NOT USE FOR: Single-directory research (use `agy_delegate_research`), single-file signature extraction (use `local_file_scout`), or overlapping directory paths (rejected by partition validator). RETURNS: Aggregated markdown report per subagent task (or async `job_id` handles for tasks still running at soft budget) plus telemetry footer.',
    annotations: {
      title: 'Spawn Disjoint-Path Subagent Swarm',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        tasks: {
          type: 'array',
          minItems: 1,
          description: 'Array of subagent tasks with strictly non-overlapping directory globs (dispatched sequentially one after another).',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: {
                type: 'string',
                minLength: 1,
                description: 'Unique task identifier (e.g. "auth-worker").'
              },
              prompt: {
                type: 'string',
                minLength: 1,
                description: 'Read-only research instructions for this subagent partition.'
              },
              paths: {
                type: 'array',
                minItems: 1,
                items: { type: 'string' },
                description:
                  'Disjoint glob/directory prefixes assigned to this subagent (e.g. ["src/auth/**"]). Must not overlap with other tasks in the swarm.'
              },
              tier: {
                type: 'string',
                enum: ['flash-low', 'flash-medium'],
                default: 'flash-low',
                description: 'Swarm model tier (defaults to flash-low).'
              }
            },
            required: ['id', 'prompt', 'paths']
          }
        },
        cwd: {
          type: 'string',
          description: 'Optional workspace root directory path.'
        },
        soft_timeout_ms: {
          type: 'number',
          minimum: 100,
          maximum: 590000,
          description:
            'Optional soft budget in milliseconds before returning async job_id handles for any remaining tasks (default 540000 = 540s).'
        }
      },
      required: ['tasks']
    }
  },
  {
    name: 'agy_delegate_edit',
    description:
      'Delegate complex multi-file code modifications or cross-module refactoring to Antigravity (agy) in --mode=accept-edits. SERIALIZATION & ASYNC BUDGET: Calls are serialized (one at a time, AGY_MAX_CONCURRENCY = 1); split edits needing >~8 minutes into smaller scoped calls or fetch in-flight runs via `agy_job_result`. WHEN TO USE: Coordinated edits across multiple existing files requiring Gemini Argon/Flash reasoning. DO NOT USE FOR: Generating a single standalone boilerplate, DTO, schema, or unit test file (use `local_draft_leaf_code` instead at 0x quota), read-only analysis (use `agy_delegate_research`), or running test suites (use `local_exec_and_triage`). RETURNS: Edit summary, optional IDE visual diff confirmation, and telemetry footer.',
    annotations: {
      title: 'Delegate Multi-File Cloud Edit',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'Clear multi-file editing instructions and target file scope for Antigravity.'
        },
        tier: {
          type: 'string',
          enum: [
            'flash-low',
            'flash-medium',
            'flash-high',
            'argon-low',
            'argon-medium',
            'argon-high'
          ],
          default: 'argon-medium',
          description: 'Gemini model tier to execute the edit (defaults to argon-medium).'
        },
        allow_shell: {
          type: 'boolean',
          default: false,
          description:
            'If false (default), runs with --mode=accept-edits (file edits only). If true, requests --dangerously-skip-permissions (refused unless AGY_ALLOW_SKIP_PERMISSIONS=1 is configured).'
        },
        target_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of target file paths being edited so the Visual HUD can snapshot and open inline diffs (--diff) in Antigravity IDE.'
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path.'
        },
        soft_timeout_ms: {
          type: 'number',
          minimum: 100,
          maximum: 590000,
          description:
            'Optional soft budget in milliseconds before returning an async job_id handle (default 540000 = 540s).'
        }
      },
      required: ['prompt']
    }
  },
  {
    name: 'agy_session_followup',
    description:
      'Resume an existing Antigravity conversation ID (--conversation <id>) so previously loaded files remain in context cache, automatically compacting the session if context usage exceeds 80%. SERIALIZATION & ASYNC BUDGET: Calls are serialized (one at a time, AGY_MAX_CONCURRENCY = 1); keep follow-ups to one bounded question (<~8 minutes) or fetch in-flight runs by job_id via `agy_job_result`. WHEN TO USE: Multi-turn follow-up questions on an existing Session ID returned by a prior `agy_delegate_research` or `agy_delegate_edit` call. DO NOT USE FOR: Starting a brand-new research task without a prior session (use `agy_delegate_research` instead). RETURNS: Follow-up response, optional compaction notice, and updated session telemetry.',
    annotations: {
      title: 'Follow Up on Cached Cloud Session',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        conversation_id: {
          type: 'string',
          minLength: 1,
          description:
            'The agy conversation_id UUID from a previous tool call telemetry footer (or "latest" to resume the most recent session).'
        },
        prompt: {
          type: 'string',
          minLength: 1,
          description: 'Follow-up instructions or question for the cached session.'
        },
        mode: {
          type: 'string',
          enum: ['plan', 'accept-edits', 'dangerously-skip-permissions'],
          default: 'plan',
          description: 'Execution mode for the follow-up turn (defaults to plan).'
        },
        tier: {
          type: 'string',
          enum: [
            'flash-low',
            'flash-medium',
            'flash-high',
            'argon-low',
            'argon-medium',
            'argon-high'
          ],
          description: 'Optional model tier override (defaults to the session model).'
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path.'
        },
        soft_timeout_ms: {
          type: 'number',
          minimum: 100,
          maximum: 590000,
          description:
            'Optional soft budget in milliseconds before returning an async job_id handle (default 540000 = 540s).'
        }
      },
      required: ['conversation_id', 'prompt']
    }
  },
  {
    name: 'agy_job_result',
    description:
      'Fetch the stored output or live status of an Antigravity job by `job_id` (or `"latest"`). WHEN TO USE: Retrieving the result of a long-running `agy_delegate_research`, `agy_spawn_swarm`, `agy_delegate_edit`, or `agy_session_followup` call that returned `"still running, job <id>..."` after reaching the soft budget (default 540s). DO NOT USE FOR: Starting a new research or edit task. RETURNS: The full completed subagent response and session telemetry if finished (`done` / `failed` / `cancelled` / `timed_out`), or `"still running, job <id>, started <time>, elapsed <s>s; fetch with agy_job_result <id>"` if still in flight.',
    annotations: {
      title: 'Fetch Async Cloud Job Result',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: {
          type: 'string',
          minLength: 1,
          description:
            'The job_id returned when a run exceeded the soft timeout (or listed in agy_status.agy_process_queue), or "latest" for the most recent job.'
        },
        wait_ms: {
          type: 'number',
          minimum: 0,
          maximum: 540000,
          default: 0,
          description:
            'Optional milliseconds to wait for completion if the job is still running (default 0 for instant check; max 540000).'
        }
      },
      required: ['job_id']
    }
  },
  {
    name: 'agy_cancel',
    description:
      'Cancel a currently running or queued Antigravity job by `job_id` (or `"active"`), terminating any hung or unneeded child process tree (`taskkill /T /F`) and freeing the serialized `agy` queue immediately. WHEN TO USE: Aborting an in-flight or queued `agy` job shown in `agy_status` so subsequent calls are not blocked. DO NOT USE FOR: Read-only status checks (use `agy_status` or `agy_job_result`). RETURNS: JSON cancellation report `{ ok, job_id, previous_state, state, pid, elapsed_s, message }` plus telemetry footer.',
    annotations: {
      title: 'Cancel Running or Queued Cloud Job',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id: {
          type: 'string',
          minLength: 1,
          description:
            'The job_id to cancel (e.g. "job-1730250000000-a1b2c3"), or "active" / "current" to cancel the currently running job.'
        }
      },
      required: ['job_id']
    }
  },
  {
    name: 'agy_configure_workspace',
    description:
      'Update workspace environment configuration and Antigravity IDE Visual HUD settings. Auto-detects project toolchains (.venv, node_modules/.bin), registers monorepo directories (--add-dir), injects environment variables, optionally syncs .vscode/settings.json, and attaches or launches the Antigravity IDE window. WHEN TO USE: Only when configuring custom virtualenv/monorepo paths or toggling IDE Visual HUD attachment. DO NOT USE FOR: Read-only status or quota checks (use `agy_status` instead). RETURNS: JSON object `{ ide_window_attached, opened_ide_window, workspace_environment }` plus telemetry footer.',
    annotations: {
      title: 'Configure Workspace & IDE HUD',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        add_dirs: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional directories to include in the agy workspace via --add-dir (e.g. ["../shared-types"]).'
        },
        extra_path_entries: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Additional PATH directories (e.g. custom toolchain or virtualenv bin folders) injected into every subagent execution.'
        },
        env_overrides: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description:
            'Key-value string environment variables (e.g. {"NODE_ENV": "test"}) injected into every subagent run.'
        },
        python_interpreter: {
          type: 'string',
          description: 'Explicit Python interpreter path to sync into .vscode/settings.json.'
        },
        vscode_settings: {
          type: 'object',
          additionalProperties: {
            type: ['string', 'number', 'boolean']
          },
          description:
            'Optional key-value settings to merge non-destructively into .vscode/settings.json for Antigravity IDE.'
        },
        open_ide_window: {
          type: 'boolean',
          default: false,
          description:
            'If true, launches Antigravity IDE pointed specifically at this workspace folder and marks ide_window_attached=true.'
        },
        attach_ide: {
          type: 'boolean',
          default: false,
          description:
            'Set true if this workspace is already open in Antigravity IDE to enable follow_files / visual_review_gate; set false to prevent --reuse-window from touching another project window.'
        },
        follow_files: {
          type: 'boolean',
          default: true,
          description: 'Enable or disable active editor file:line jumping.'
        },
        visual_review_gate: {
          type: 'boolean',
          default: true,
          description: 'Enable or disable inline --diff tabs on delegated edits.'
        },
        cwd: {
          type: 'string',
          description: 'Optional workspace root directory path.'
        }
      },
      required: []
    }
  },
  {
    name: 'agy_status',
    description:
      'Inspect current system health, Gemini 5-hour/weekly quota windows, Local GPU VRAM availability (`/api/ps`), process queue state (`active_job`, `waiting_jobs`, `recent_jobs` with `job_id`, `state`, `started_at`, `elapsed_s`, `tier`, `prompt_preview`), active session context remaining, and Git worktree pre-flight status in read-only mode. WHEN TO USE: Checking whether the Local GPU worker or Gemini Argon/Flash tiers are online, inspecting in-flight/queued jobs, and checking token savings. DO NOT USE FOR: Modifying workspace settings or attaching the IDE (use `agy_configure_workspace` instead). RETURNS: JSON status report `{ agy_process_queue, local_gpu_queue, local_gpu_probe, local_gpu_telemetry, model_quotas, sessions }` plus telemetry footer.',
    annotations: {
      title: 'Get Hybrid Router & Quota Status',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        refresh_models: {
          type: 'boolean',
          default: false,
          description:
            'If true, runs `agy models` to probe for newly released Gemini models (defaults to false for instant response).'
        }
      },
      required: []
    }
  },
  {
    name: 'local_file_scout',
    description:
      'ZERO-TRUST MEMORY TOOL: Read repository files directly from disk on the server side and use the Local GPU LLM (0x cloud quota) as a strict forensic disk-evidence extractor. Outputs verbatim signatures, imports, and logic with exact 1-based `<file>:L<line>` citations (<300 tokens), or `"NOT_FOUND_ON_DISK: [symbol/query]"` if absent (automatically escalating to Gemini 3.8 Flash if the local GPU is offline). WHEN TO USE: Always call before raw `Read` on unfamiliar/large files (>150 lines) or whenever verifying disk state before answering or editing. DO NOT USE FOR: Multi-directory architectural synthesis across 10+ files (use `agy_delegate_research` after scouting). RETURNS: Concise markdown bullet digest with `<file>:L<line>` citations and telemetry footer.',
    annotations: {
      title: 'Scout Files on Local GPU (Forensic Line Extractor)',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        file_paths: {
          type: 'array',
          minItems: 1,
          items: { type: 'string' },
          description:
            'List of relative or absolute file paths to inspect on disk (skips binary files and `.env*` secrets).'
        },
        query: {
          type: 'string',
          minLength: 1,
          description:
            'Specific symbols, function signatures, imports, or behavior to extract from the numbered files.'
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path (defaults to workspace root).'
        }
      },
      required: ['file_paths', 'query']
    }
  },
  {
    name: 'local_exec_and_triage',
    description:
      'Execute allow-listed test, build, typecheck, or lint commands (pytest, npm test, npx tsc, cargo check, go test) in a managed subprocess with Windows process-tree kill protection (`taskkill /T /F`) and scrub verbose output on the Local GPU (0x cloud quota). WHEN TO USE: Running any test suite, compiler check, or linter that may produce >40 lines of noisy output. DO NOT USE FOR: Chained shell commands (`&&`, `;`, `|` are blocked) or file edits. RETURNS: Full output directly if <=40 lines; otherwise a Local GPU-scrubbed digest containing only exit code, failing test names, `<file>:<line>` locations, and isolated stack traces.',
    annotations: {
      title: 'Execute & Triage Test/Build Logs on Local GPU',
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          description:
            'Single allow-listed test/build/lint command line without chaining operators (e.g. "pytest", "npm test", "npx tsc --noEmit", "cargo check").'
        },
        working_dir: {
          type: 'string',
          minLength: 1,
          description: 'Working directory path for command execution.'
        },
        timeout_ms: {
          type: 'number',
          minimum: 500,
          maximum: 600000,
          default: 120000,
          description: 'Optional subprocess timeout in milliseconds (default 120000).'
        }
      },
      required: ['command', 'working_dir']
    }
  },
  {
    name: 'local_draft_leaf_code',
    description:
      'Draft standalone leaf-node boilerplate, unit test files, DTOs, or schemas on disk using the Local GPU LLM (0x cloud quota). Reads `reference_files` on the server side, validates that the drafted code is >=15 chars with closed markdown fences and no truncation placeholders before writing `target_file` (automatically aborting disk write and escalating to `agy_delegate_edit` `flash-high` if invalid or offline). WHEN TO USE: Creating or updating a single self-contained leaf file (unit tests, schemas, types, boilerplate). DO NOT USE FOR: Complex multi-file refactoring or cross-module architectural edits (use `agy_delegate_edit` instead). RETURNS: Write confirmation, byte/line counts, and `git diff --stat` summary.',
    annotations: {
      title: 'Draft Leaf Boilerplate/Tests on Local GPU',
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false
    },
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        target_file: {
          type: 'string',
          minLength: 1,
          description: 'Relative or absolute path to the single leaf file to create or update on disk.'
        },
        spec: {
          type: 'string',
          minLength: 1,
          description:
            'Detailed specification of the leaf code, boilerplate, schema, or unit test cases to generate.'
        },
        reference_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'List of existing file paths to read from disk on the server side as style, type, and import references.'
        },
        cwd: {
          type: 'string',
          description: 'Optional working directory path (defaults to workspace root).'
        }
      },
      required: ['target_file', 'spec', 'reference_files']
    }
  }
];

// Handle MCP Tool Calls
async function handleToolCall(name, args = {}) {
  const cwd = args.cwd ? path.resolve(WORKSPACE_ROOT, args.cwd) : WORKSPACE_ROOT;

  if (name === 'agy_configure_workspace') {
    const result = configureWorkspaceEnvironment(args, cwd);
    const text =
      `### Workspace Environment & IDE Configuration Updated\n\`\`\`json\n${JSON.stringify(
        result,
        null,
        2
      )}\n\`\`\`` + buildTelemetryFooter();
    return { content: [{ type: 'text', text }] };
  }

  if (name === 'agy_status') {
    let discoveryResult = null;
    if (args.refresh_models) {
      discoveryResult = await runModelDiscovery();
    }
    const matrix = readJsonSafe(MODEL_MATRIX_PATH);
    const ledger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
    reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: true });
    const ideSync = readJsonSafe(IDE_SYNC_PATH);
    const gitCheck = checkAndFixGitWorktreeConfig(cwd, false);
    const autoDetectedEnv = detectWorkspaceEnvironment(cwd);

    // Refresh live elapsed_s on any running/queued sessions in the status snapshot
    const liveSessions = {};
    for (const [sid, sess] of Object.entries(ledger.sessions || {})) {
      const copy = { ...sess };
      if (copy.state === 'running' || copy.state === 'queued') {
        copy.elapsed_s = computeLiveElapsedSeconds(copy);
      }
      liveSessions[sid] = copy;
    }

    const statusReport = {
      agy_binary: resolveAgyBinary(),
      ide_binary: resolveIdeBinary(ideSync),
      workspace_root: WORKSPACE_ROOT,
      agy_process_queue: getAgyQueueSnapshot(),
      local_gpu_queue: { ...localGpuQueueState },
      local_gpu_config: getLocalGpuConfig(matrix),
      local_gpu_probe: await probeAndResolveLocalGpu(getLocalGpuConfig(matrix)),
      local_gpu_telemetry: ledger.local_gpu_telemetry || {},
      agy_readonly_command_allowlist: AGY_READONLY_COMMAND_ALLOWLIST,
      agy_permission_files: {
        cli_settings: AGY_CLI_SETTINGS_PATH,
        default_project_grants: AGY_DEFAULT_PROJECT_GRANTS_PATH
      },
      auto_detected_environment: autoDetectedEnv,
      git_worktree_preflight: gitCheck,
      baseline_gemini_models: matrix.baseline_models,
      discovered_gemini_models: matrix.discovered_models,
      last_discovery_check: matrix.last_discovery_check,
      live_discovery_result: discoveryResult,
      active_session_id: ledger.active_session_id,
      active_sessions_count: Object.keys(liveSessions).length,
      sessions: liveSessions,
      model_quotas: ledger.model_quotas,
      ide_hud_sync: ideSync
    };

    const text =
      `### Antigravity Subagent Governor Status\n\`\`\`json\n${JSON.stringify(
        statusReport,
        null,
        2
      )}\n\`\`\`` + buildTelemetryFooter(null, ledger.active_session_id);

    return { content: [{ type: 'text', text }] };
  }

  if (name === 'agy_job_result') {
    const jobIdArg = String(args.job_id || '').trim();
    const waitMs =
      typeof args.wait_ms === 'number' && args.wait_ms > 0 ? args.wait_ms : 0;
    const jobRes = await getAgyJobResult(jobIdArg, waitMs);

    if (!jobRes.found) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: ${jobRes.message}${buildTelemetryFooter()}`
          }
        ]
      };
    }

    const jr = jobRes.jobRecord;
    if (jobRes.stillRunning) {
      const pendingText =
        formatAsyncPendingMessage(jr, null) +
        buildTelemetryFooter(jr.model, jr.conversation_id);
      return {
        isError: false,
        content: [{ type: 'text', text: pendingText }]
      };
    }

    const stored = jobRes.result || {};
    const header = [
      `### Async Job Result: \`${jr.job_id}\``,
      `- **State:** \`${jr.state}\` | **Tier / Model:** \`${jr.tier}\` (\`${
        stored.modelUsed || jr.model
      }\`) | **Elapsed:** \`${jr.elapsed_s}s\` | **Session:** \`${
        stored.conversationId || jr.conversation_id
      }\``,
      jr.log_file ? `- **Log File:** \`${jr.log_file}\`` : '',
      ''
    ]
      .filter(line => line !== '')
      .join('\n');

    const body = `${formatGovernorNotices(stored)}${stored.responseText || ''}`;
    const text =
      `${header}\n\n${body}` +
      buildTelemetryFooter(
        stored.modelUsed || jr.model,
        stored.conversationId || jr.conversation_id
      );

    return {
      isError: !stored.ok,
      content: [{ type: 'text', text }]
    };
  }

  if (name === 'agy_cancel') {
    const cancelRes = await cancelAgyJob(args.job_id);
    const text =
      `### Antigravity Job Cancellation\n\`\`\`json\n${JSON.stringify(
        cancelRes,
        null,
        2
      )}\n\`\`\`` + buildTelemetryFooter();
    return {
      isError: !cancelRes.ok,
      content: [{ type: 'text', text }]
    };
  }

  if (name === 'agy_delegate_research') {
    const ideSync = readJsonSafe(IDE_SYNC_PATH);
    let fullPrompt = `[READ-ONLY RESEARCH MODE: Do not modify, create, or delete workspace source files.]\n\n${withShellRules(
      args.prompt
    )}`;

    if (args.html_artifact_name && ideSync.enabled && ideSync.visual_review_gate) {
      const htmlDir = expandEnvVars(
        ideSync.paths?.html_artifacts_dir || '%USERPROFILE%\\.gemini\\antigravity\\html_artifacts'
      );
      if (!fs.existsSync(htmlDir)) {
        fs.mkdirSync(htmlDir, { recursive: true });
      }
      const artifactPath = path.join(htmlDir, path.basename(args.html_artifact_name));
      fullPrompt += `\n\nIf producing a visual architectural report, also save a self-contained HTML artifact to: ${artifactPath}`;
    }

    const res = await executeAgyWithGovernor({
      prompt: fullPrompt,
      rawPrompt: args.prompt,
      requestedModel: args.tier || 'flash-medium',
      mode: 'plan',
      cwd,
      softTimeoutMs: args.soft_timeout_ms,
      onComplete: () => {
        if (args.files_to_follow?.length) {
          triggerVisualHudFollowFiles('', cwd, args.files_to_follow);
        }
      }
    });

    const text =
      `${formatGovernorNotices(res)}${res.responseText || ''}` +
      buildTelemetryFooter(res.modelUsed, res.conversationId);

    return {
      isError: !res.ok,
      content: [{ type: 'text', text }]
    };
  }

  if (name === 'agy_spawn_swarm') {
    const tasks = Array.isArray(args.tasks) ? args.tasks : [];
    if (tasks.length === 0) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: 'tasks' array must contain at least one subagent task.${buildTelemetryFooter()}`
          }
        ]
      };
    }

    const partitionValidation = validateDisjointSwarmPartitions(tasks);
    if (!partitionValidation.valid) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Swarm Partition Violation: ${partitionValidation.reason}${buildTelemetryFooter()}`
          }
        ]
      };
    }

    const swarmPromises = tasks.map(async task => {
      const tier =
        task.tier === 'flash-medium' ? 'gemini-3.8-flash-medium' : 'gemini-3.8-flash-low';
      const partitionedPrompt = [
        `[SWARM SUBAGENT ID: ${task.id}]`,
        `[STRICT PATH PARTITION LOCK: You are ONLY permitted to inspect or analyze files matching: ${task.paths.join(
          ', '
        )}. Do NOT touch or read files outside your partition.]`,
        '',
        buildShellRulesHeader(),
        '',
        task.prompt
      ].join('\n');

      // executeAgyWithGovernor serializes these (AGY_MAX_CONCURRENCY = 1):
      // concurrent agy processes interfere, so the "swarm" is dispatched one at a time.
      const res = await executeAgyWithGovernor({
        prompt: partitionedPrompt,
        rawPrompt: task.prompt,
        requestedModel: tier,
        mode: 'plan',
        cwd,
        softTimeoutMs: args.soft_timeout_ms
      });

      return {
        taskId: task.id,
        jobId: res.jobId,
        paths: task.paths,
        modelUsed: res.modelUsed,
        conversationId: res.conversationId,
        ok: res.ok,
        asyncPending: Boolean(res.asyncPending),
        notices: formatGovernorNotices(res),
        response: res.responseText || '',
        tokens: res.usage?.total_tokens || res.session?.estimated_tokens_used || 0
      };
    });

    const results = await Promise.all(swarmPromises);
    const formatted = results
      .map(
        r =>
          `### Subagent \`${r.taskId}\` (Job: \`${r.jobId}\` | Paths: \`${r.paths.join(
            ', '
          )}\` | Model: \`${r.modelUsed}\` | Session: \`${r.conversationId}\` | ${
            r.asyncPending ? 'RUNNING_ASYNC' : r.ok ? 'OK' : 'FAILED'
          })\n${r.notices}${r.response}`
      )
      .join('\n\n---\n\n');

    const lastResult = results[results.length - 1];
    const failedCount = results.filter(r => !r.ok).length;
    const text =
      `## Swarm Execution Complete (${results.length} Subagents, dispatched sequentially; ${failedCount} failed)\n\n${formatted}` +
      buildTelemetryFooter(lastResult?.modelUsed, lastResult?.conversationId);

    return {
      isError: results.some(r => !r.ok),
      content: [{ type: 'text', text }]
    };
  }

  if (name === 'agy_delegate_edit') {
    const ideSync = readJsonSafe(IDE_SYNC_PATH);
    const targetFiles = Array.isArray(args.target_files) ? args.target_files : [];
    const snapshots = {};

    if (
      ideSync.enabled &&
      ideSync.visual_review_gate &&
      ideSync.ide_window_attached &&
      targetFiles.length > 0
    ) {
      for (const relPath of targetFiles) {
        const absPath = path.isAbsolute(relPath) ? relPath : path.resolve(cwd, relPath);
        if (fs.existsSync(absPath)) {
          const snapPath = path.join(TEMP_LOG_DIR, `before-${Date.now()}-${path.basename(absPath)}`);
          try {
            fs.copyFileSync(absPath, snapPath);
            snapshots[absPath] = snapPath;
          } catch (_) {}
        }
      }
    }

    const execMode = args.allow_shell ? 'dangerously-skip-permissions' : 'accept-edits';
    let diffBanner = '';
    const res = await executeAgyWithGovernor({
      prompt: args.prompt,
      rawPrompt: args.prompt,
      requestedModel: args.tier || 'argon-medium',
      mode: execMode,
      cwd,
      softTimeoutMs: args.soft_timeout_ms,
      onComplete: completedRes => {
        const diffsOpened = [];
        for (const [absPath, snapPath] of Object.entries(snapshots)) {
          try {
            if (fs.existsSync(absPath) && fs.existsSync(snapPath)) {
              const beforeContent = fs.readFileSync(snapPath, 'utf8');
              const afterContent = fs.readFileSync(absPath, 'utf8');
              if (beforeContent !== afterContent) {
                if (triggerVisualDiffReview(snapPath, absPath, cwd)) {
                  diffsOpened.push(path.relative(cwd, absPath));
                }
              }
            }
          } catch (_) {}
        }
        if (diffsOpened.length > 0) {
          diffBanner = `\n\n> [IDE Visual Review Gate: Opened inline diff review for: ${diffsOpened.join(', ')}]`;
          completedRes.responseText = `${completedRes.responseText || ''}${diffBanner}`;
        }
      }
    });

    const text =
      `${formatGovernorNotices(res)}${res.responseText || ''}` +
      buildTelemetryFooter(res.modelUsed, res.conversationId);

    return {
      isError: !res.ok,
      content: [{ type: 'text', text }]
    };
  }

  if (name === 'agy_session_followup') {
    const ledger = refreshQuotaState(readJsonSafe(STATE_LEDGER_PATH));
    reconcileOrphanedJobsAndSessions(ledger, { persistIfChanged: true });
    const isLatest = args.conversation_id === 'latest';
    let targetConvId = isLatest
      ? ledger.active_session_id
      : String(args.conversation_id || '').trim();

    if (targetConvId && targetConvId.startsWith('job-')) {
      const jobInfo = agyActiveJobs.get(targetConvId)?.jobRecord || ledger.jobs?.[targetConvId];
      if (jobInfo) {
        if (jobInfo.state === 'running' || jobInfo.state === 'queued') {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Error: Job '${targetConvId}' is still ${jobInfo.state} and has not produced a completed session conversation_id yet. Call \`agy_job_result\` with \`{"job_id": "${targetConvId}"}\` to check or wait for its output, or \`agy_cancel\` to abort it.${buildTelemetryFooter(
                  jobInfo.model,
                  targetConvId
                )}`
              }
            ]
          };
        }
        if (
          jobInfo.conversation_id &&
          !jobInfo.conversation_id.startsWith('job-') &&
          !jobInfo.conversation_id.startsWith('pending-')
        ) {
          targetConvId = jobInfo.conversation_id;
        } else {
          return {
            isError: true,
            content: [
              {
                type: 'text',
                text: `Error: Job '${targetConvId}' ended in state '${jobInfo.state}' without establishing a session conversation_id (${
                  jobInfo.error || 'no session created'
                }). Inspect with \`agy_job_result\` or launch a new call.${buildTelemetryFooter(
                  jobInfo.model,
                  targetConvId
                )}`
              }
            ]
          };
        }
      } else {
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: `Error: '${targetConvId}' looks like a job_id rather than a session conversation_id, and no matching job was found. Use \`agy_status\` to check active sessions and jobs.${buildTelemetryFooter()}`
            }
          ]
        };
      }
    }

    let effectiveConvId = targetConvId;
    let effectivePrompt = args.prompt;
    let compactionNotice = '';

    if (targetConvId && ledger.sessions?.[targetConvId]) {
      const compactRes = await checkAndCompactSessionIfNeeded(targetConvId, cwd);
      if (compactRes.compacted) {
        effectiveConvId = null;
        effectivePrompt = `[AUTOMATIC 80% CONTEXT COMPACTION HANDOFF FROM SESSION ${targetConvId}]\n${compactRes.handoffSummary}\n\n[FOLLOW-UP TASK]\n${args.prompt}`;
        compactionNotice = `> [Governor Note: Session ${targetConvId} exceeded 80% context window and was automatically compacted into a fresh session.]\n\n`;
      }
    }

    const prevSession = ledger.sessions?.[targetConvId];
    const requestedModel = args.tier || prevSession?.model || 'gemini-3.8-flash-medium';

    const res = await executeAgyWithGovernor({
      prompt: withShellRules(effectivePrompt),
      rawPrompt: args.prompt,
      requestedModel,
      mode: args.mode || 'plan',
      conversationId: effectiveConvId,
      continueLatest: isLatest && !effectiveConvId,
      cwd,
      softTimeoutMs: args.soft_timeout_ms
    });

    const text =
      `${formatGovernorNotices(res, [compactionNotice.trim()])}${res.responseText || ''}` +
      buildTelemetryFooter(res.modelUsed, res.conversationId);

    return {
      isError: !res.ok,
      content: [{ type: 'text', text }]
    };
  }

  // --------------------------------------------------------------------------
  // Tool 7: local_file_scout (Tier 3 Local GPU Offload)
  // --------------------------------------------------------------------------
  if (name === 'local_file_scout') {
    const filePaths = Array.isArray(args.file_paths) ? args.file_paths : [];
    const query = String(args.query || '').trim();
    if (filePaths.length === 0 || !query) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: 'file_paths' (non-empty array) and 'query' (non-empty string) are required.${buildTelemetryFooter()}`
          }
        ]
      };
    }

    const cfg = getLocalGpuConfig();
    const maxTotalChars = cfg.max_scout_input_chars || 80000;
    const perFileMaxChars = Math.max(8000, Math.floor(maxTotalChars / Math.max(1, filePaths.length)));

    const sections = [];
    const skippedNotes = [];
    const validRelPaths = [];
    let totalRawChars = 0;

    for (const rawPath of filePaths) {
      const absPath = path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd, rawPath);
      const relPath = path.relative(cwd, absPath).replace(/\\/g, '/');

      // Safeguard #4a: Block .env* and secret/private key files
      if (isSecretOrBlockedPath(absPath)) {
        skippedNotes.push(
          `[SKIPPED SECRET FILE: \`${relPath}\` — locked by Governor secret-file guardrail]`
        );
        continue;
      }

      if (!fs.existsSync(absPath)) {
        skippedNotes.push(`[MISSING FILE: \`${relPath}\` — does not exist on disk]`);
        continue;
      }

      const stat = fs.statSync(absPath);
      if (stat.isDirectory()) {
        skippedNotes.push(`[SKIPPED DIRECTORY: \`${relPath}\` — pass file paths, not directories]`);
        continue;
      }

      // Safeguard #4b: Skip binary files (check for null bytes \0 in first 4KB)
      if (isBinaryFileOnDisk(absPath)) {
        skippedNotes.push(
          `[SKIPPED BINARY FILE: \`${relPath}\` — null byte (\\0) detected in first 4KB]`
        );
        continue;
      }

      const rawContent = fs.readFileSync(absPath, 'utf8');
      totalRawChars += rawContent.length;
      validRelPaths.push(relPath);

      // Safeguard #4c: Prepend 1-based line numbers + 50-50 Head/Tail Slicing if needed
      const numbered = formatNumberedFileWithHeadTailSlice(rawContent, perFileMaxChars);
      sections.push(
        `=== FILE: ${relPath} (${numbered.totalLines} lines${
          numbered.sliced ? `, 50-50 Head/Tail Sliced` : ''
        }) ===\n${numbered.text}`
      );
    }

    if (sections.length === 0) {
      const onlySkipped = skippedNotes.join('\n') || 'No readable text files found.';
      return {
        isError: false,
        content: [
          {
            type: 'text',
            text: `### Local File Scout Result\n${onlySkipped}${buildTelemetryFooter('local-guardrail')}`
          }
        ]
      };
    }

    // Apply overall 50-50 Head/Tail Slicing if combined payload still exceeds maxTotalChars
    const combinedPayload = sliceHeadTail5050(sections.join('\n\n'), maxTotalChars);

    const systemPrompt = SCOUT_SYSTEM_PROMPT;

    const userPrompt = [
      `[QUERY]\n${query}`,
      skippedNotes.length > 0 ? `[SKIPPED FILES]\n${skippedNotes.join('\n')}` : '',
      `[NUMBERED SOURCE FILES]\n${combinedPayload.text}`,
      `[TARGET QUERY — EXTRACT ONLY FROM THE NUMBERED LINES ABOVE]\n${query}`
    ]
      .filter(Boolean)
      .join('\n\n');

    // Safeguard #4d: max_tokens set to 600 so multi-file signature digests never clip mid-sentence
    const localRes = await callLocalGpuChatCompletion({
      systemPrompt,
      userPrompt,
      maxTokens: cfg.scout_max_tokens || 600,
      temperature: 0.1,
      customConfig: cfg
    });

    if (localRes.ok) {
      recordLocalGpuTelemetry({
        localSuccess: true,
        charsOffloaded: totalRawChars,
        endpoint: localRes.baseUrl,
        model: localRes.model,
        status: `online (${localRes.provider})`
      });
      triggerVisualHudFollowFiles(localRes.content, cwd);
      const preamble =
        skippedNotes.length > 0 ? `${skippedNotes.map(n => `> ${n}`).join('\n')}\n\n` : '';
      const text =
        `${preamble}${localRes.content.trim()}` +
        buildTelemetryFooter(`local:${localRes.model}`);
      return { isError: false, content: [{ type: 'text', text }] };
    }

    // Automatic Cloud Escalation to Gemini 3.8 Flash if local GPU is offline or errored
    recordLocalGpuTelemetry({
      localSuccess: false,
      charsOffloaded: 0,
      status: `escalated (${localRes.reason})`
    });

    const fallbackTier = cfg.fallback_cloud_tier_scout || 'flash-low';
    const cloudPrompt = [
      '[READ-ONLY RESEARCH MODE: Do not modify, create, or delete workspace source files.]',
      withShellRules(
        `${SCOUT_SYSTEM_PROMPT}\n\n` +
          `Inspect ONLY these files using your file-reading tool: ${validRelPaths.join(', ')}.\n` +
          `Keep your response under 300 tokens.\n\n[QUERY]\n${query}`
      )
    ].join('\n\n');

    const cloudRes = await executeAgyWithGovernor({
      prompt: cloudPrompt,
      requestedModel: fallbackTier,
      mode: 'plan',
      cwd
    });

    const escalateNote = `> [Governor Note: Local GPU scout unavailable (${localRes.reason}) -> automatically escalated to ${cloudRes.modelUsed}]`;
    const allNotes = [escalateNote, ...skippedNotes.map(n => `> ${n}`)];
    const text =
      `${formatGovernorNotices(cloudRes, allNotes)}${cloudRes.responseText || ''}` +
      buildTelemetryFooter(cloudRes.modelUsed, cloudRes.conversationId);

    return {
      isError: !cloudRes.ok,
      content: [{ type: 'text', text }]
    };
  }

  // --------------------------------------------------------------------------
  // Tool 8: local_exec_and_triage (Tier 3 Local GPU Offload)
  // --------------------------------------------------------------------------
  if (name === 'local_exec_and_triage') {
    const command = String(args.command || '').trim();
    const workingDir = args.working_dir
      ? path.isAbsolute(args.working_dir)
        ? args.working_dir
        : path.resolve(cwd, args.working_dir)
      : cwd;
    const timeoutMs =
      typeof args.timeout_ms === 'number' && args.timeout_ms > 0 ? args.timeout_ms : 120000;

    if (!command) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: 'command' is required for local_exec_and_triage.${buildTelemetryFooter()}`
          }
        ]
      };
    }

    const cmdCheck = validateSafeTriageCommand(command);
    if (!cmdCheck.allowed) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: Refused by local_exec_and_triage safe command allow-list: ${cmdCheck.reason}${buildTelemetryFooter()}`
          }
        ]
      };
    }

    if (!fs.existsSync(workingDir)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: working_dir does not exist: ${workingDir}${buildTelemetryFooter()}`
          }
        ]
      };
    }

    // Inject workspace virtualenv / node_modules/.bin PATH and env_overrides
    const ideSync = readJsonSafe(IDE_SYNC_PATH);
    const wsEnv = ideSync.workspace_environment || {};
    const autoEnv = detectWorkspaceEnvironment(workingDir);
    const childEnv = { ...process.env, ...(wsEnv.env_overrides || {}) };
    const extraPaths = Array.from(
      new Set([...(autoEnv.extra_path_entries || []), ...(wsEnv.extra_path_entries || [])])
    );
    if (extraPaths.length > 0) {
      const pathKey = Object.keys(childEnv).find(k => k.toUpperCase() === 'PATH') || 'PATH';
      childEnv[pathKey] = [...extraPaths, childEnv[pathKey] || ''].join(path.delimiter);
    }

    // Safeguard #3: Run subprocess with Windows taskkill /PID /T /F tree-kill protection
    const execRes = await runSubprocessWithTreeKill({
      command,
      cwd: workingDir,
      env: childEnv,
      timeoutMs
    });

    const combinedRaw = [
      execRes.stdout ? `[STDOUT]\n${execRes.stdout.trimEnd()}` : '',
      execRes.stderr ? `[STDERR]\n${execRes.stderr.trimEnd()}` : ''
    ]
      .filter(Boolean)
      .join('\n\n');

    const rawLines = combinedRaw ? combinedRaw.split(/\r?\n/) : [];
    const lineCount = rawLines.length;
    const timeoutBanner = execRes.timedOut
      ? `> [Governor Alert: Command timed out after ${timeoutMs}ms and process tree (PID ${execRes.pid}) was terminated via taskkill /T /F]\n\n`
      : '';

    // Short-circuit: <= 40 lines returned directly without any LLM call
    if (lineCount <= 40) {
      const body = [
        `${timeoutBanner}### Command Execution Result (Direct — ${lineCount} lines <= 40-line threshold)`,
        `- **Command:** \`${command}\``,
        `- **Working Dir:** \`${workingDir}\``,
        `- **Exit Code:** \`${execRes.exitCode}\`${execRes.timedOut ? ' (TIMED OUT)' : ''}`,
        '',
        '```text',
        combinedRaw || '(no stdout/stderr output)',
        '```'
      ].join('\n');

      return {
        isError: false,
        content: [{ type: 'text', text: body + buildTelemetryFooter('direct-short-log') }]
      };
    }

    // Over 40 lines: scrub passing tests and boilerplate warnings via Local GPU
    const cfg = getLocalGpuConfig();
    const maxLogChars = cfg.max_triage_input_chars || 80000;
    const slicedLog = sliceHeadTail5050(combinedRaw, maxLogChars);

    const systemPrompt = [
      'You are a build and test log triage scrubber running on a local GPU.',
      'Strip all passing tests, progress bars, and routine warnings.',
      'Return ONLY: (1) Exit status summary, (2) Exact failing test names or compiler errors, (3) Exact <file>:<line> references, and (4) Isolated root-cause stack traces.',
      'Keep your response concise and actionable.'
    ].join(' ');

    const userPrompt = [
      `Command: ${command}`,
      `Working Directory: ${workingDir}`,
      `Exit Code: ${execRes.exitCode}${execRes.timedOut ? ' (TIMED OUT)' : ''}`,
      `Total Log Lines: ${lineCount} (${combinedRaw.length} chars${
        slicedLog.sliced ? ', 50-50 Head/Tail Sliced' : ''
      })`,
      '',
      slicedLog.text
    ].join('\n');

    const localRes = await callLocalGpuChatCompletion({
      systemPrompt,
      userPrompt,
      maxTokens: cfg.triage_max_tokens || 600,
      temperature: 0.0,
      customConfig: cfg
    });

    if (localRes.ok) {
      recordLocalGpuTelemetry({
        localSuccess: true,
        charsOffloaded: combinedRaw.length,
        endpoint: localRes.baseUrl,
        model: localRes.model,
        status: `online (${localRes.provider})`
      });
      triggerVisualHudFollowFiles(localRes.content, workingDir);
      const text =
        [
          `${timeoutBanner}### Triaged Command Output (Scrubbed ${lineCount} lines via Local GPU \`${localRes.model}\`)`,
          `- **Command:** \`${command}\` | **Exit Code:** \`${execRes.exitCode}\``,
          '',
          localRes.content.trim()
        ].join('\n') + buildTelemetryFooter(`local:${localRes.model}`);

      return { isError: false, content: [{ type: 'text', text }] };
    }

    // Fallback if Local GPU is offline: write raw log to temp file so agy (flash-low) can read it from disk
    recordLocalGpuTelemetry({
      localSuccess: false,
      charsOffloaded: 0,
      status: `escalated (${localRes.reason})`
    });

    const tempLogFile = path.join(TEMP_LOG_DIR, `triage-log-${Date.now()}.log`);
    fs.writeFileSync(tempLogFile, slicedLog.text, 'utf8');

    try {
      const fallbackTier = cfg.fallback_cloud_tier_triage || 'flash-low';
      const cloudRes = await executeAgyWithGovernor({
        prompt: withShellRules(
          `[READ-ONLY LOG TRIAGE]\nRead the log file at \`${tempLogFile}\` (generated by \`${command}\`, exit code ${execRes.exitCode}).\nStrip all passing tests and boilerplate warnings. Extract ONLY: (1) exact failing test names or build errors, (2) exact <file>:<line> locations, and (3) isolated stack traces.`
        ),
        requestedModel: fallbackTier,
        mode: 'plan',
        cwd: workingDir
      });

      const escalateNote = `> [Governor Note: Local GPU triage unavailable (${localRes.reason}) -> escalated log scrubbing (${lineCount} lines) to ${cloudRes.modelUsed}]`;
      const body =
        cloudRes.ok && cloudRes.responseText
          ? cloudRes.responseText
          : `\`\`\`text\n${rawLines.slice(0, 20).join('\n')}\n...\n${rawLines.slice(-20).join('\n')}\n\`\`\``;

      const text =
        `${timeoutBanner}${formatGovernorNotices(cloudRes, [escalateNote])}### Triaged Command Output (\`${command}\` | Exit Code: \`${execRes.exitCode}\`)\n\n${body}` +
        buildTelemetryFooter(cloudRes.modelUsed, cloudRes.conversationId);

      return { isError: false, content: [{ type: 'text', text }] };
    } finally {
      try {
        if (fs.existsSync(tempLogFile)) fs.unlinkSync(tempLogFile);
      } catch (_) {}
    }
  }

  // --------------------------------------------------------------------------
  // Tool 9: local_draft_leaf_code (Tier 3 Local GPU Offload)
  // --------------------------------------------------------------------------
  if (name === 'local_draft_leaf_code') {
    const targetFileRaw = String(args.target_file || '').trim();
    const spec = String(args.spec || '').trim();
    const refFilesRaw = Array.isArray(args.reference_files) ? args.reference_files : [];

    if (!targetFileRaw || !spec) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: 'target_file' and 'spec' are required for local_draft_leaf_code.${buildTelemetryFooter()}`
          }
        ]
      };
    }

    const absTarget = path.isAbsolute(targetFileRaw)
      ? targetFileRaw
      : path.resolve(cwd, targetFileRaw);
    const relTarget = path.relative(cwd, absTarget).replace(/\\/g, '/');

    if (isSecretOrBlockedPath(absTarget)) {
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: `Error: Refusing to write to protected secret/key file '${relTarget}'.${buildTelemetryFooter()}`
          }
        ]
      };
    }

    // Capture pre-write snapshot in memory and temp file (Safeguard #2)
    const targetExistedBefore = fs.existsSync(absTarget);
    const originalContent = targetExistedBefore ? fs.readFileSync(absTarget, 'utf8') : null;

    const cfg = getLocalGpuConfig();
    const maxDraftInputChars = cfg.max_draft_input_chars || 64000;

    const refBlocks = [];
    const validRefRelPaths = [];
    let totalInputChars = spec.length + (originalContent ? originalContent.length : 0);

    for (const refRaw of refFilesRaw) {
      const absRef = path.isAbsolute(refRaw) ? refRaw : path.resolve(cwd, refRaw);
      const relRef = path.relative(cwd, absRef).replace(/\\/g, '/');
      if (isSecretOrBlockedPath(absRef) || !fs.existsSync(absRef)) continue;
      const st = fs.statSync(absRef);
      if (st.isDirectory() || isBinaryFileOnDisk(absRef)) continue;
      const refContent = fs.readFileSync(absRef, 'utf8');
      totalInputChars += refContent.length;
      validRefRelPaths.push(relRef);
      refBlocks.push(`=== REFERENCE FILE: ${relRef} ===\n${refContent}`);
    }

    // Helper to escalate cleanly to agy_delegate_edit (flash-high) without corrupting target_file
    const escalateDraftToCloud = async reason => {
      // Safeguard #2: Guarantee target_file is restored/untouched before escalating
      try {
        if (targetExistedBefore && originalContent !== null) {
          fs.writeFileSync(absTarget, originalContent, 'utf8');
        } else if (!targetExistedBefore && fs.existsSync(absTarget)) {
          fs.unlinkSync(absTarget);
        }
      } catch (_) {}

      recordLocalGpuTelemetry({
        localSuccess: false,
        charsOffloaded: 0,
        status: `draft_escalated (${reason})`
      });

      const fallbackTier = cfg.fallback_cloud_tier_draft || 'flash-high';
      const editPrompt = [
        `Draft and write the file \`${relTarget}\` according to the specification below.`,
        validRefRelPaths.length > 0
          ? `Read these reference files first for style, types, and imports: ${validRefRelPaths.join(', ')}.`
          : '',
        `Specification:\n${spec}`,
        'Return only a concise confirmation and summary of what was written.'
      ]
        .filter(Boolean)
        .join('\n\n');

      const delegated = await handleToolCall('agy_delegate_edit', {
        prompt: editPrompt,
        tier: fallbackTier,
        allow_shell: false,
        target_files: [relTarget],
        cwd
      });

      const prevText = delegated.content?.[0]?.text || '';
      const notice = `> [Governor Note: Local GPU leaf draft skipped/aborted (${reason}); target_file left intact and escalated to \`agy_delegate_edit\` (${fallbackTier})]\n\n`;
      return {
        isError: delegated.isError,
        content: [{ type: 'text', text: `${notice}${prevText}` }]
      };
    };

    if (totalInputChars > maxDraftInputChars) {
      return escalateDraftToCloud(
        `input size ${totalInputChars} chars exceeds Local GPU draft limit of ${maxDraftInputChars} chars`
      );
    }

    const systemPrompt = [
      'You are an expert code generator running on a local GPU.',
      'Output ONLY the complete, valid file contents for the requested target file wrapped in a single markdown code block (```language ... ```).',
      'Do NOT include conversational filler, explanations, or lazy truncation comments like "// ... rest of code".'
    ].join(' ');

    const userPrompt = [
      `[TARGET FILE TO GENERATE]\n${relTarget}`,
      `[SPECIFICATION]\n${spec}`,
      targetExistedBefore ? `[EXISTING TARGET FILE CONTENT]\n${originalContent}` : '',
      refBlocks.length > 0 ? `[REFERENCE FILES]\n${refBlocks.join('\n\n')}` : ''
    ]
      .filter(Boolean)
      .join('\n\n');

    const localRes = await callLocalGpuChatCompletion({
      systemPrompt,
      userPrompt,
      maxTokens: cfg.draft_max_tokens || 2048,
      temperature: 0.1,
      customConfig: cfg
    });

    if (!localRes.ok) {
      return escalateDraftToCloud(localRes.reason || 'Local GPU endpoint offline');
    }

    // Safeguard #2: Validate extracted code before touching target_file on disk
    const validation = extractAndValidateDraftedCode(localRes.content, localRes.finishReason);
    if (!validation.valid) {
      return escalateDraftToCloud(`Safeguard #2 blocked overwrite: ${validation.reason}`);
    }

    // Write snapshot for IDE Visual Diff Gate if target existed
    let snapPath = null;
    if (targetExistedBefore && originalContent !== null) {
      snapPath = path.join(TEMP_LOG_DIR, `before-${Date.now()}-${path.basename(absTarget)}`);
      try {
        fs.writeFileSync(snapPath, originalContent, 'utf8');
      } catch (_) {
        snapPath = null;
      }
    }

    fs.mkdirSync(path.dirname(absTarget), { recursive: true });
    fs.writeFileSync(absTarget, validation.code, 'utf8');

    recordLocalGpuTelemetry({
      localSuccess: true,
      charsOffloaded: totalInputChars + validation.code.length,
      endpoint: localRes.baseUrl,
      model: localRes.model,
      status: `online (${localRes.provider})`
    });

    let diffOpened = false;
    if (snapPath && originalContent !== validation.code) {
      diffOpened = triggerVisualDiffReview(snapPath, absTarget, cwd);
    }

    // Run git diff --stat on the target file for compact review
    const gitStatRes = await runSubprocessWithTreeKill({
      command: `git diff --stat HEAD -- "${relTarget}"`,
      cwd,
      timeoutMs: 10000
    });
    const gitStatOut = (gitStatRes.stdout || '').trim();
    const linesWritten = validation.code.split(/\r?\n/).length - 1;

    const summaryLines = [
      `### Local Leaf Code Draft Complete (\`${relTarget}\`)`,
      `- **Engine:** Local GPU (\`${localRes.model}\` via \`${localRes.provider}\`)`,
      `- **Status:** ${targetExistedBefore ? 'Updated existing file' : 'Created new file'} (${linesWritten} lines, ${Buffer.byteLength(
        validation.code,
        'utf8'
      )} bytes)`,
      `- **git diff --stat:** \`${gitStatOut || '(untracked or identical to HEAD)'}\``,
      diffOpened ? `- **IDE Visual Review Gate:** Inline diff tab opened` : ''
    ].filter(Boolean);

    return {
      isError: false,
      content: [
        {
          type: 'text',
          text: summaryLines.join('\n') + buildTelemetryFooter(`local:${localRes.model}`)
        }
      ]
    };
  }

  return {
    isError: true,
    content: [{ type: 'text', text: `Unknown tool: ${name}${buildTelemetryFooter()}` }]
  };
}

// ============================================================================
// Non-Destructive Integration & MCP Protocol Instructions
// ============================================================================
const MARKER_START = '<!-- AGY-SUBAGENT-GOVERNOR:START -->';
const MARKER_END = '<!-- AGY-SUBAGENT-GOVERNOR:END -->';

// Read-only tools that are safe to pre-approve when --bootstrap is explicitly run.
// Write/shell tools (agy_delegate_edit, agy_cancel, agy_configure_workspace, local_exec_and_triage,
// local_draft_leaf_code) are never pre-approved unless --approve-all is explicitly passed.
const SAFE_READONLY_MCP_TOOLS = Object.freeze([
  'agy_status',
  'agy_delegate_research',
  'agy_spawn_swarm',
  'agy_job_result',
  'local_file_scout'
]);

// Forensic disk-evidence system prompt for `local_file_scout` (used on both the local GPU
// and the cloud Gemini Flash fallback so neither model can guess or hallucinate symbols).
const SCOUT_SYSTEM_PROMPT = [
  'You are a strict disk-evidence extractor.',
  '1. ONLY report symbols, signatures, imports, flags/config, and logic explicitly present in the numbered file text provided below.',
  '2. Every claim MUST include the exact file path and 1-based line number (e.g., src/auth.ts:L42-L58 or src/auth.ts:42) and a verbatim quote or signature from those lines.',
  '3. Keep your response concise (<300 tokens) using markdown bullet points.',
  '4. NEVER infer, guess, or rely on external knowledge. ONLY if the requested topic, symbol, or behavior is completely absent from the provided text, output EXACTLY: "NOT_FOUND_ON_DISK: [symbol/query]".'
].join('\n');

// Returned in the MCP `initialize` response (`result.instructions`) so Claude Code
// receives routing guidance natively without requiring root CLAUDE.md / AGENTS.md files.
const MCP_SERVER_INSTRUCTIONS = [
  'Tiered Offload & Disk-Truth Rules (`agy-subagent` + Tier 3 Local GPU Offload Layer):',
  '1. ZERO-TRUST MEMORY: Treat prior conversation history as stale. Never answer architectural questions or propose edits from memory—always call `local_file_scout` (0x quota) to verify current disk state and cite `<file>:<line>` evidence first.',
  '2. Tier 3 Local GPU Offload (0x cloud quota burn, server-side disk/log access):',
  '   - `local_file_scout(file_paths, query)`: Forensic disk-evidence extractor. Use before raw `Read` on large/unfamiliar files (>150 lines) to extract verbatim `<file>:L<line>` signatures and imports (<300 tokens), or `"NOT_FOUND_ON_DISK: [symbol/query]"` if absent. Automatically escalates to `gemini-3.8-flash-low` if the local GPU endpoint is offline.',
  '   - `local_exec_and_triage(command, working_dir)`: Use to run and scrub verbose test/build output (>40 lines) (`pytest`, `npm test`, `tsc`, `cargo check`). Returns logs <=40 lines directly; scrubs logs >40 lines via the Local GPU (or `flash-low` fallback).',
  '   - `local_draft_leaf_code(target_file, spec, reference_files)`: Use to draft boilerplate/tests to disk with an empty/truncation overwrite guard, then inspect `git diff`.',
  '3. Cloud Gemini Tiers (`agy_delegate_research`, `agy_spawn_swarm`, `agy_delegate_edit`, `agy_session_followup`, `agy_job_result`, `agy_cancel`):',
  '   - `flash-low` / `flash-medium` (1x burn): Wide repo triage, log scanning, disjoint-path swarms (`agy_spawn_swarm`).',
  '   - `flash-high` (2x burn): Multi-file module summaries, routine test generation, second-opinion verification.',
  '   - `argon-low` / `argon-medium` (4x burn): Cross-module tracing, subtle bug investigation, scoped multi-file edits.',
  '   - `argon-high` (6x burn): Deep architectural design, security/race-condition audits across 30+ files.',
  '4. Serialization, Async Job Mode & Watchdog (`AGY_MAX_CONCURRENCY = 1`):',
  '   - Calls to `agy` are serialized (one at a time, including `agy_spawn_swarm` tasks). A prompt needing more than ~8 minutes of agent time should be split into one bounded question per call, or launched expecting to fetch the result by `job_id` via `agy_job_result`.',
  '   - If a run exceeds the soft budget (`AGY_SOFT_TIMEOUT_MS`, default 540s, below the 600s client timeout), the tool returns `"still running, job <id>, started <time>, elapsed <s>s; fetch with agy_job_result <id>"` while the child keeps running in the background. Use `agy_job_result(job_id)` to fetch the completed answer or `agy_cancel(job_id)` to abort and free the queue. A hard watchdog (`AGY_RUN_MAX_MS`, default 1800s) kills genuinely hung processes and preserves the log path.',
  '5. Headless `agy` Shell Rules: Headless `agy -p` only permits exact allow-listed read-only git commands (one command per tool call, never chained). Name the files for `agy` to read rather than asking it to run `grep`/`find`.',
  '6. Optional Workspace Setup: `agy_configure_workspace` is optional and only needed if you want to attach the Antigravity IDE Visual HUD or configure custom `.venv`/monorepo paths.'
].join('\n');

const CLAUDE_MD_GOVERNOR_BLOCK = `${MARKER_START}
## Antigravity Subagent Delegation Rules

You are connected to the **Antigravity Subagent Governor** MCP server (\`agy-subagent\`), which wraps the local Google Antigravity CLI (\`agy\`), the **Tier 3 Local GPU Offload Layer**, and the **Antigravity IDE Visual HUD**.

### 0. Setup, CLI Fallback & Optional Workspace Configuration

Because \`agy-subagent\` is a \`stdio\` MCP server registered in \`.mcp.json\`, Claude Code spawns \`node .agy-subagent/server/index.js\` automatically on startup and receives routing instructions via the MCP \`initialize\` handshake without modifying repository files on startup.

* **Explicit Bootstrap (Ask the User First):** If \`.mcp.json\` or \`.claude/settings.local.json\` needs to be configured for a new workspace, ask the user before running:
  \`\`\`bash
  node .agy-subagent/server/index.js --bootstrap
  \`\`\`
  By default, \`--bootstrap\` merges \`agy-subagent\` into \`.mcp.json\`, enables only \`agy-subagent\` in \`.claude/settings.local.json\` (pre-approving only the 5 read-only tools: \`agy_status\`, \`agy_delegate_research\`, \`agy_spawn_swarm\`, \`agy_job_result\`, \`local_file_scout\`), and does **not** create or modify \`CLAUDE.md\` or \`AGENTS.md\` unless \`--write-docs\` is explicitly passed.
* **Immediate Direct CLI Execution (Zero Restart Required):** You can invoke any Governor tool directly via Bash:
  \`\`\`bash
  node .agy-subagent/server/index.js --cli agy_status "{\\"refresh_models\\":true}"
  node .agy-subagent/server/index.js --cli agy_delegate_research "{\\"tier\\":\\"flash-low\\",\\"prompt\\":\\"...\\"}"
  \`\`\`
* **Optional Workspace & IDE Setup (\`agy_configure_workspace\`):**
  When needed (e.g., to attach the Antigravity IDE Visual HUD or register custom Python \`.venv\` / monorepo \`add_dirs\`), you may call \`agy_configure_workspace\`. By default, \`ide_window_attached\` is \`false\` so \`--reuse-window\` never hijacks an unrelated Antigravity IDE window.

### 1. Verified Gemini Routing Matrix (Strictly Gemini Models Only)

| Tier Alias | Verified \`agy\` Model Slug | Context Ceiling | Quota Burn | When to Route Tasks Here |
| :--- | :--- | :--- | :--- | :--- |
| \`flash-low\` | \`gemini-3.8-flash-low\` | 1,000,000 | **1x** (Minimal) | Wide repo search, file discovery, log scanning, syntax checks, high-concurrency parallel subagent swarms (\`agy_spawn_swarm\`). |
| \`flash-medium\` | \`gemini-3.8-flash-medium\` | 1,000,000 | **1x** (Minimal) | Fast multi-directory triage, dependency mapping, and structured parallel exploration. |
| \`flash-high\` | \`gemini-3.8-flash-high\` | 1,000,000 | **2x** (Low-Mod) | Multi-file module summaries, routine test generation, and fast second-opinion verification before spending Argon quota. |
| \`argon-low\` | \`gemini-4-argon-low\` | 1M – 2M | **4x** (Mod-High) | Cross-module tracing, targeted refactoring plans across 10–20 files. |
| \`argon-medium\` | \`gemini-4-argon-medium\` | 1M – 2M | **4x** (Mod-High) | Complex bug investigation, subtle state tracing, and multi-file edits (\`agy_delegate_edit\`) across 15–30 files. |
| \`argon-high\` | \`gemini-4-argon-high\` | 1M – 2M | **6x** (High) | Deep architectural design, large-scale codebase ingestion (30+ files), security/race-condition audits, and root-cause analysis of hard bugs. |

* **Never** invoke \`claude-*\` or \`gpt-oss-*\` models inside \`agy\` subagents.
* **Deterministic Fallback Chain:** \`gemini-4-argon-high\` -> \`gemini-4-argon-medium\` -> \`gemini-4-argon-low\` -> \`gemini-3.8-flash-high\` -> \`gemini-3.8-flash-medium\` -> \`gemini-3.8-flash-low\`.

### 1A. Mandatory Tier 3 Local GPU First-Pass Offload (Local GPU — 0x Quota Burn)

Before calling Claude's raw \`Read\` on large/unfamiliar files, running noisy test/build suites via \`Bash\`, or spending Gemini cloud quota, **Opus/Fable and Argon MUST route context-heavy leaf tasks to the local GPU tools**:

| Local Tool | Replaces | Hard Rule for Opus / Fable / Argon |
| :--- | :--- | :--- |
| **\`local_file_scout\`** | Raw \`Read\` on files >150 lines or multi-file signature lookups | **Never** \`Read\` full source files just to find signatures, imports, or line numbers. Call \`local_file_scout(file_paths, query)\` first to get a \`<300 token\` \`<file>:<line>\` digest, then use targeted line-range \`Read\` only on the exact lines you need to edit. |
| **\`local_exec_and_triage\`** | Raw \`Bash\` for \`pytest\`, \`npm test\`, \`tsc\`, \`cargo check\`, \`docker build\` | **Never** run verbose test or build suites directly in \`Bash\` where passing test logs pollute context. Always run them via \`local_exec_and_triage(command, working_dir)\` so logs >40 lines are scrubbed locally on the Local GPU. |
| **\`local_draft_leaf_code\`** | Writing repetitive unit tests, DTOs, schemas, or boilerplate in Claude output tokens | **Never** spend Opus/Fable output tokens generating routine boilerplate or test files from scratch. Call \`local_draft_leaf_code(target_file, spec, reference_files)\` to write the draft on disk via the Local GPU, then review the resulting \`git diff\` and apply surgical fixes with \`Edit\`. |

* **Single-Model VRAM Constraint & Safeguards:** The local consumer GPU keeps **one** model loaded at a time (\`localhost:8080/v1\` or \`localhost:11434/v1\`, probing Ollama \`/api/ps\` first with \`keep_alive: "30m"\`) and serializes requests. Do not pass raw file contents in tool arguments—always pass **file paths** so the MCP server reads them directly from disk.
* **Automatic Cloud Escalation:** If the local GPU server is offline, if drafted code fails validation (<15 chars or truncated), or if inputs exceed the Local GPU context ceiling, the MCP server automatically escalates to \`gemini-3.8-flash-low\` / \`flash-high\` without failing the turn.

### 2. Available MCP Tools

1. **\`agy_configure_workspace\`**: Provision project toolchains (\`.venv\`, \`PATH\`, \`env_overrides\`, \`--add-dir\`), sync \`.vscode/settings.json\`, and attach/open the Antigravity IDE window safely.
2. **\`agy_status\`**: Inspect Gemini quota health, Local GPU status/telemetry, active session IDs, auto-detected workspace toolchains, and newly discovered Gemini models.
3. **\`agy_delegate_research\`**: Read-only analysis (\`--mode=plan\`). Pass \`tier\`, \`prompt\`, and optional \`files_to_follow\`.
4. **\`agy_spawn_swarm\`**: Dispatch \`gemini-3.8-flash-low\` / \`gemini-3.8-flash-medium\` subagents across **strictly disjoint directory partitions** (\`paths: ["src/auth/**"]\` vs \`paths: ["src/db/**"]\`). Partitions are validated, then tasks run **one at a time** (agy processes are serialized).
5. **\`agy_delegate_edit\`**: Delegate scoped file edits (\`allow_shell: false\` -> \`--mode=accept-edits\`). Note: \`allow_shell: true\` (\`--dangerously-skip-permissions\`) is disabled by default unless \`AGY_ALLOW_SKIP_PERMISSIONS=1\` is set.
6. **\`agy_session_followup\`**: Resume an existing \`conversation_id\` (or \`"latest"\`) so previously loaded files stay in \`agy\`'s context cache (auto-compacts at 80% context usage).
7. **\`agy_job_result\`**: Fetch the stored answer or live elapsed status of an async job by \`job_id\` (or \`"latest"\`) when a long run exceeds the 540s soft budget.
8. **\`agy_cancel\`**: Terminate an in-flight or queued \`agy\` job by \`job_id\` (or \`"active"\`) and free the serialized queue immediately.
9. **\`local_file_scout\`**: Server-side disk reader + Local GPU signature/line-number extractor (skips binary/secret files, 50-50 head/tail slices >80K chars, \`max_tokens: 600\`).
10. **\`local_exec_and_triage\`**: Server-side subprocess runner + Local GPU log scrubber for noisy test/build commands (>40 lines scrubbed, Windows \`taskkill /T /F\` tree-kill on timeout).
11. **\`local_draft_leaf_code\`**: Server-side leaf boilerplate/test generator writing directly to \`target_file\` with empty/truncation overwrite guard and \`git diff --stat\` output.

### 3. Headless Permission Behavior (Read Before Delegating)

* Headless \`agy -p\` (\`--mode plan\` or \`--mode accept-edits\`; \`auto\` is not available on every account) **auto-denies any shell command that is not on its allow-list**. It does not prompt or fail loudly: it returns \`response: ""\` and \`denied_actions: [{action: "command", display_name: "RunCommand"}]\`. The bridge surfaces this as a \`[Governor Alert: AGY DENIED ACTIONS]\` / \`[Governor Alert: AGY EMPTY RESPONSE]\` preamble and marks the tool result as an error instead of returning only the telemetry footer.
* Allow rules are read from \`~/.gemini/antigravity-cli/settings.json\` (\`permissions.allow\`) and \`~/.gemini/config/projects/default-cli-project.json\` (\`permissionGrants.permissionGrants.allow\`). They match the **exact full command line only**: \`command(git log -1 --oneline)\` works; a bare binary \`command(git)\`, a prefix \`command(git log)\`, wildcards \`command(git *)\` / \`command(git:*)\`, extra flags, and chained lines (\`git status; git diff\`) all fail. Commands run through PowerShell. \`--bootstrap\` (and every server start) merges the vocabulary below into both files without touching existing rules.
* Installed read-only vocabulary (one exported constant, \`AGY_READONLY_COMMAND_ALLOWLIST\` in \`.agy-subagent/server/index.js\`; extend it there and re-run \`--bootstrap\`): ${AGY_READONLY_COMMAND_VOCABULARY.map(
  c => `\`${c}\``
).join(', ')}.
* The bridge automatically prefixes every \`agy_delegate_research\`, \`agy_spawn_swarm\` and \`agy_session_followup\` prompt with a shell-rules header: file-reading tool plus the exact commands above, **one command per tool call, typed exactly as written**, never chained with \`;\` or \`&&\`, never with extra flags, never grep/rg/find or any other shell command. Your task text must still fit those rules: **name the files to read** rather than asking it to search, and keep inputs small (a 359KB diff handed to flash-high burned ~200k Gemini tokens and returned nothing).
* agy processes are **serialized** (\`AGY_MAX_CONCURRENCY = 1\`): two concurrent \`agy -p\` runs interfere (one exits 1 and the permission state can corrupt), so \`agy_spawn_swarm\` dispatches its tasks sequentially after the disjoint-path check.
* \`agy_delegate_edit\` with \`allow_shell: true\` is disabled by default unless \`AGY_ALLOW_SKIP_PERMISSIONS=1\` is set. Prefer research mode or \`local_exec_and_triage\`.
* Keep project-specific notes outside the \`AGY-SUBAGENT-GOVERNOR\` markers if using \`--bootstrap --write-docs\`.
${MARKER_END}`;

const AGENTS_MD_GOVERNOR_BLOCK = `${MARKER_START}
## Antigravity (\`agy\`) Subagent Worker Rules (Synchronized with \`CLAUDE.md\`)

1. **Respect Mode Boundaries:** When invoked in \`--mode plan\` (\`[READ-ONLY RESEARCH MODE]\`), never modify, create, or delete workspace files. Return structured findings with exact \`<file>:<line>\` references.
2. **Respect Swarm Path Partitions:** When invoked with a \`[STRICT PATH PARTITION LOCK]\` header during an \`agy_spawn_swarm\` run, strictly restrict all file inspection and analysis to the assigned directory globs.
3. **Preserve \`.agy-subagent/\` Integrity:** Never print debug output to \`stdout\` in \`.agy-subagent/server/index.js\`—all internal logging must go to \`stderr\`.
4. **Follow Existing Project Standards:** Always honor all project-specific architecture, testing, and style rules defined in \`CLAUDE.md\` and \`AGENTS.md\`.
5. **Respect the Headless Shell Allow-List:** In headless runs any shell command that is not an exact allow-listed line is auto-denied and the whole answer is discarded. Use the file-reading tool first. The only commands you may run are: ${AGY_READONLY_COMMAND_VOCABULARY.map(
  c => `\`${c}\``
).join(', ')}. One command per tool call, typed exactly as written, never chained with \`;\` or \`&&\`, never with extra flags, never grep/rg/find.
${MARKER_END}`;

function mergeMarkdownBlockNonDestructive(filePath, blockContent, defaultHeader = '') {
  if (!fs.existsSync(filePath)) {
    const content = defaultHeader ? `${defaultHeader}\n\n${blockContent}\n` : `${blockContent}\n`;
    fs.writeFileSync(filePath, content, 'utf8');
    return 'created';
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  if (existing.includes(MARKER_START) && existing.includes(MARKER_END)) {
    const startIdx = existing.indexOf(MARKER_START);
    const endIdx = existing.indexOf(MARKER_END) + MARKER_END.length;
    const updated = existing.slice(0, startIdx) + blockContent + existing.slice(endIdx);
    if (updated !== existing) {
      fs.writeFileSync(filePath, updated, 'utf8');
      return 'updated_block';
    }
    return 'already_up_to_date';
  }

  // If the file already has "## Antigravity Subagent Delegation Rules" without markers, wrap or skip
  if (existing.includes('## Antigravity Subagent Delegation Rules')) {
    return 'already_present_unmarked';
  }

  const sep = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  fs.writeFileSync(filePath, `${existing}${sep}${blockContent}\n`, 'utf8');
  return 'appended_preserving_existing';
}

// Append every missing allow rule to `arr` in vocabulary order; returns the count added.
function mergeAllowRules(arr, rules) {
  let added = 0;
  for (const rule of rules) {
    if (!arr.includes(rule)) {
      arr.push(rule);
      added += 1;
    }
  }
  return added;
}

// Non-destructively merge the exact-command read-only vocabulary into both agy
// permission files. Existing rules (allow, deny, anything else) are preserved;
// only missing allow rules are appended. Idempotent: a second run changes nothing.
function mergeAgyPermissionAllowlists(allowRules = AGY_READONLY_COMMAND_ALLOWLIST) {
  const report = {};

  // 1. ~/.gemini/antigravity-cli/settings.json -> permissions.allow
  try {
    const existed = fs.existsSync(AGY_CLI_SETTINGS_PATH);
    const settings = readJsonSafe(AGY_CLI_SETTINGS_PATH, {});
    if (!settings.permissions || typeof settings.permissions !== 'object') {
      settings.permissions = {};
    }
    if (!Array.isArray(settings.permissions.allow)) {
      settings.permissions.allow = [];
    }
    const added = mergeAllowRules(settings.permissions.allow, allowRules);
    if (!existed || added > 0) {
      fs.mkdirSync(path.dirname(AGY_CLI_SETTINGS_PATH), { recursive: true });
      writeJsonSafe(AGY_CLI_SETTINGS_PATH, settings);
    }
    report.cli_settings = {
      path: AGY_CLI_SETTINGS_PATH,
      status: !existed ? 'created' : added > 0 ? 'updated' : 'already_up_to_date',
      rules_added: added,
      rules_total: settings.permissions.allow.length
    };
  } catch (err) {
    report.cli_settings = { path: AGY_CLI_SETTINGS_PATH, status: 'error', error: err.message };
  }

  // 2. ~/.gemini/config/projects/default-cli-project.json -> permissionGrants.permissionGrants.allow
  try {
    const existed = fs.existsSync(AGY_DEFAULT_PROJECT_GRANTS_PATH);
    const project = readJsonSafe(AGY_DEFAULT_PROJECT_GRANTS_PATH, {});
    if (!project.id) project.id = 'default-cli-project';
    if (!project.name) project.name = 'CLI Project';
    if (!project.projectResources || typeof project.projectResources !== 'object') {
      project.projectResources = {};
    }
    if (!project.permissionGrants || typeof project.permissionGrants !== 'object') {
      project.permissionGrants = {};
    }
    if (
      !project.permissionGrants.permissionGrants ||
      typeof project.permissionGrants.permissionGrants !== 'object'
    ) {
      project.permissionGrants.permissionGrants = {};
    }
    const grants = project.permissionGrants.permissionGrants;
    if (!Array.isArray(grants.allow)) grants.allow = [];
    const added = mergeAllowRules(grants.allow, allowRules);
    if (!existed || added > 0) {
      fs.mkdirSync(path.dirname(AGY_DEFAULT_PROJECT_GRANTS_PATH), { recursive: true });
      writeJsonSafe(AGY_DEFAULT_PROJECT_GRANTS_PATH, project);
    }
    report.default_project_grants = {
      path: AGY_DEFAULT_PROJECT_GRANTS_PATH,
      status: !existed ? 'created' : added > 0 ? 'updated' : 'already_up_to_date',
      rules_added: added,
      rules_total: grants.allow.length
    };
  } catch (err) {
    report.default_project_grants = {
      path: AGY_DEFAULT_PROJECT_GRANTS_PATH,
      status: 'error',
      error: err.message
    };
  }

  return report;
}

function runSelfHealingBootstrap(cwd = WORKSPACE_ROOT, options = {}) {
  const writeDocs = Boolean(options.writeDocs);
  const approveAll = Boolean(options.approveAll);
  const fixGitWorktree = Boolean(options.fixGitWorktree);

  // 0. Teach headless agy the exact-command read-only vocabulary (user-level, idempotent)
  const agyPermissions = mergeAgyPermissionAllowlists();

  // 1. Non-destructively merge .mcp.json (preserves existing servers & custom env keys)
  const mcpJsonPath = path.join(cwd, '.mcp.json');
  const mcpConfig = readJsonSafe(mcpJsonPath, { mcpServers: {} });
  if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
  const existingServerCfg = mcpConfig.mcpServers['agy-subagent'] || {};
  mcpConfig.mcpServers['agy-subagent'] = {
    command: existingServerCfg.command || 'node',
    args: existingServerCfg.args || ['.agy-subagent/server/index.js'],
    timeout: existingServerCfg.timeout || 600000,
    env: {
      AGY_BIN_PATH: resolveAgyBinary(),
      ...(existingServerCfg.env || {})
    }
  };
  writeJsonSafe(mcpJsonPath, mcpConfig);

  // 2. Non-destructively merge .claude/settings.local.json:
  //    - Never sets `enableAllProjectMcpServers: true` (avoids blanket trust of future servers).
  //    - Enables only `agy-subagent` in `enabledMcpjsonServers`.
  //    - Pre-approves only the 4 read-only tools (`SAFE_READONLY_MCP_TOOLS`) unless `--approve-all` is passed.
  const claudeDir = path.join(cwd, '.claude');
  if (!fs.existsSync(claudeDir)) {
    fs.mkdirSync(claudeDir, { recursive: true });
  }
  const settingsPath = path.join(claudeDir, 'settings.local.json');
  const settings = readJsonSafe(settingsPath, {});
  const enabledList = new Set(settings.enabledMcpjsonServers || []);
  enabledList.add('agy-subagent');
  settings.enabledMcpjsonServers = Array.from(enabledList);

  if (!settings.permissions || typeof settings.permissions !== 'object') {
    settings.permissions = {};
  }
  const allowSet = new Set(settings.permissions.allow || []);
  const toolsToApprove = approveAll ? MCP_TOOLS.map(t => t.name) : SAFE_READONLY_MCP_TOOLS;
  for (const toolName of toolsToApprove) {
    allowSet.add(`mcp__agy-subagent__${toolName}`);
  }
  settings.permissions.allow = Array.from(allowSet);
  writeJsonSafe(settingsPath, settings);

  // 3. Only write root CLAUDE.md and AGENTS.md when explicitly opted in via `--write-docs`
  //    (Guidance is delivered natively via MCP `initialize.instructions` and tool descriptions).
  const claudeMdPath = path.join(cwd, 'CLAUDE.md');
  const agentsMdPath = path.join(cwd, 'AGENTS.md');
  let claudeMdStatus = 'skipped_by_default (use --write-docs to opt in)';
  let agentsMdStatus = 'skipped_by_default (use --write-docs to opt in)';

  if (writeDocs) {
    claudeMdStatus = mergeMarkdownBlockNonDestructive(
      claudeMdPath,
      CLAUDE_MD_GOVERNOR_BLOCK,
      '# Project Conventions & Orchestration Guide'
    );
    agentsMdStatus = mergeMarkdownBlockNonDestructive(
      agentsMdPath,
      AGENTS_MD_GOVERNOR_BLOCK,
      '# Shared Agent Standards (`AGENTS.md` & `CLAUDE.md` Sync)'
    );
  }

  // 4. Auto-detect workspace environment & git worktree pre-flight (report-only unless --fix-git-worktree)
  const wsResult = configureWorkspaceEnvironment({ sync_vscode_settings: false }, cwd);
  const gitCheck = checkAndFixGitWorktreeConfig(cwd, fixGitWorktree);

  return {
    bootstrapped: true,
    workspace_root: cwd,
    mcp_json: mcpJsonPath,
    claude_settings: settingsPath,
    preapproved_tools: toolsToApprove.map(t => `mcp__agy-subagent__${t}`),
    claude_md_status: claudeMdStatus,
    agents_md_status: agentsMdStatus,
    git_worktree_check: gitCheck,
    workspace_environment: wsResult.workspace_environment,
    agy_binary: resolveAgyBinary(),
    agy_permissions: agyPermissions,
    agy_readonly_command_allowlist: AGY_READONLY_COMMAND_ALLOWLIST
  };
}

// ============================================================================
// Stdio JSON-RPC 2.0 MCP Server Transport (Supports newline-delimited & Content-Length)
// ============================================================================
let clientUsesContentLength = false;

function sendRpcMessage(msgObj) {
  const payload = JSON.stringify(msgObj);
  if (clientUsesContentLength) {
    const byteLen = Buffer.byteLength(payload, 'utf8');
    process.stdout.write(`Content-Length: ${byteLen}\r\n\r\n${payload}`);
  } else {
    process.stdout.write(`${payload}\n`);
  }
}

async function handleRpcRequest(msg) {
  if (!msg || typeof msg !== 'object') return;

  const { id, method, params } = msg;

  if (id === undefined || id === null) {
    return;
  }

  try {
    if (method === 'initialize') {
      const clientProtocolVersion = params?.protocolVersion || '2024-11-05';
      sendRpcMessage({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: clientProtocolVersion,
          capabilities: {
            tools: { listChanged: false }
          },
          serverInfo: {
            name: 'agy-subagent-governor',
            version: '1.3.0'
          },
          instructions: MCP_SERVER_INSTRUCTIONS
        }
      });
      return;
    }

    if (method === 'ping') {
      sendRpcMessage({ jsonrpc: '2.0', id, result: {} });
      return;
    }

    if (method === 'tools/list') {
      sendRpcMessage({
        jsonrpc: '2.0',
        id,
        result: {
          tools: MCP_TOOLS
        }
      });
      return;
    }

    if (method === 'tools/call') {
      const toolName = params?.name;
      const toolArgs = params?.arguments || {};
      const toolResult = await handleToolCall(toolName, toolArgs);
      sendRpcMessage({
        jsonrpc: '2.0',
        id,
        result: toolResult
      });
      return;
    }

    if (method === 'resources/list') {
      sendRpcMessage({ jsonrpc: '2.0', id, result: { resources: [] } });
      return;
    }

    if (method === 'prompts/list') {
      sendRpcMessage({ jsonrpc: '2.0', id, result: { prompts: [] } });
      return;
    }

    sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    });
  } catch (err) {
    logStderr(`RPC Handler Error (${method}): ${err.stack || err.message}`);
    sendRpcMessage({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err.message || 'Internal MCP server error'
      }
    });
  }
}

let inputBuffer = Buffer.alloc(0);

function onStdinData(chunk) {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);

  while (inputBuffer.length > 0) {
    const strPreview = inputBuffer.toString('utf8', 0, Math.min(inputBuffer.length, 64));

    if (strPreview.startsWith('Content-Length:')) {
      clientUsesContentLength = true;
      const headerEnd = inputBuffer.indexOf('\r\n\r\n');
      if (headerEnd === -1) break;

      const headerStr = inputBuffer.toString('utf8', 0, headerEnd);
      const lenMatch = headerStr.match(/Content-Length:\s*(\d+)/i);
      const contentLen = lenMatch ? parseInt(lenMatch[1], 10) : 0;
      const totalFrameLen = headerEnd + 4 + contentLen;

      if (inputBuffer.length < totalFrameLen) break;

      const jsonBody = inputBuffer.toString('utf8', headerEnd + 4, totalFrameLen);
      inputBuffer = inputBuffer.slice(totalFrameLen);

      try {
        const parsed = JSON.parse(jsonBody);
        handleRpcRequest(parsed);
      } catch (err) {
        logStderr(`Failed to parse Content-Length JSON frame: ${err.message}`);
      }
    } else {
      const newlineIdx = inputBuffer.indexOf('\n');
      if (newlineIdx === -1) break;

      const line = inputBuffer.toString('utf8', 0, newlineIdx).trim();
      inputBuffer = inputBuffer.slice(newlineIdx + 1);

      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        handleRpcRequest(parsed);
      } catch (err) {
        logStderr(`Failed to parse JSON-RPC line: ${err.message}`);
      }
    }
  }
}

// Library surface (used by smoke-test.js and by projects that want to extend the allow-list).
// require()-ing this file has no side effects beyond creating the temp log directory.
module.exports = {
  AGY_READONLY_COMMAND_VOCABULARY,
  AGY_READONLY_COMMAND_ALLOWLIST,
  AGY_MAX_CONCURRENCY,
  DEFAULT_AGY_SOFT_TIMEOUT_MS,
  DEFAULT_AGY_RUN_MAX_MS,
  LOCAL_GPU_MAX_CONCURRENCY,
  SAFE_READONLY_MCP_TOOLS,
  SCOUT_SYSTEM_PROMPT,
  MCP_SERVER_INSTRUCTIONS,
  CLAUDE_MD_GOVERNOR_BLOCK,
  AGY_CLI_SETTINGS_PATH,
  AGY_DEFAULT_PROJECT_GRANTS_PATH,
  DENIED_ACTIONS_MARKER,
  EMPTY_RESPONSE_MARKER,
  buildShellRulesHeader,
  buildGovernorAlerts,
  mergeAgyPermissionAllowlists,
  runSelfHealingBootstrap,
  checkAndFixGitWorktreeConfig,
  executeAgyWithGovernor,
  getAgyQueueSnapshot,
  getAgyJobResult,
  cancelAgyJob,
  reconcileOrphanedJobsAndSessions,
  isPidAlive,
  extractPromptPreview,
  validateDisjointSwarmPartitions,
  getLocalGpuConfig,
  probeAndResolveLocalGpu,
  callLocalGpuChatCompletion,
  isSecretOrBlockedPath,
  isBinaryBuffer,
  isBinaryFileOnDisk,
  sliceHeadTail5050,
  formatNumberedFileWithHeadTailSlice,
  extractAndValidateDraftedCode,
  runSubprocessWithTreeKill,
  killProcessTree,
  ensureRuntimeStateFiles,
  validateSafeTriageCommand,
  STATE_LEDGER_PATH,
  IDE_SYNC_PATH,
  MODEL_MATRIX_PATH
};

// Entrypoint Mode Selection (--bootstrap, --cli, or stdio MCP Server)
if (require.main === module) {
  const cliArgs = process.argv.slice(2);
  if (cliArgs[0] === '--bootstrap') {
    const cwdFlagIdx = cliArgs.indexOf('--cwd');
    const targetCwd =
      cwdFlagIdx !== -1 && cliArgs[cwdFlagIdx + 1]
        ? path.resolve(cliArgs[cwdFlagIdx + 1])
        : WORKSPACE_ROOT;
    const bootstrapOptions = {
      writeDocs: cliArgs.includes('--write-docs'),
      approveAll: cliArgs.includes('--approve-all'),
      fixGitWorktree: cliArgs.includes('--fix-git-worktree')
    };
    const info = runSelfHealingBootstrap(targetCwd, bootstrapOptions);
    process.stdout.write(JSON.stringify(info, null, 2) + '\n');
    process.exit(0);
  } else if (cliArgs[0] === '--cli') {
    const toolName = cliArgs[1] || 'agy_status';
    let parsedArgs = {};
    if (cliArgs.length > 2) {
      const rawArg = cliArgs.slice(2).join(' ').trim();
      try {
        parsedArgs = JSON.parse(rawArg);
      } catch (_) {
        try {
          // Fallback for PowerShell quote/backslash stripping (e.g. "{\ attach_ide\:false}")
          const cleaned = rawArg.replace(/\\"/g, '"').replace(/\\/g, '');
          const normalized = cleaned
            .replace(/([{,]\s*)([a-zA-Z0-9_]+)\s*:/g, '$1"$2":')
            .replace(/:\s*([a-zA-Z0-9_.\-/]+)(?=\s*[,}])/g, (__, val) => {
              if (val === 'true' || val === 'false' || val === 'null' || !isNaN(Number(val))) {
                return `:${val}`;
              }
              return `:"${val}"`;
            });
          parsedArgs = JSON.parse(normalized);
        } catch (err) {
          logStderr(`Invalid JSON passed to --cli (${rawArg}): ${err.message}`);
          process.exit(1);
        }
      }
    }
    handleToolCall(toolName, parsedArgs)
      .then(res => {
        const outText = (res.content || []).map(c => c.text).join('\n');
        process.stdout.write(outText + '\n');
        process.exit(res.isError ? 1 : 0);
      })
      .catch(err => {
        logStderr(`CLI Tool execution error: ${err.message}`);
        process.exit(1);
      });
  } else {
    // On MCP server startup, never rewrite workspace files (.mcp.json, settings.local.json,
    // CLAUDE.md, AGENTS.md) unless AGY_AUTO_BOOTSTRAP_ON_START=1 is explicitly set and
    // AGY_NO_SELF_BOOTSTRAP is not '1'. Always keep user-level agy read-only git rules synced.
    try {
      mergeAgyPermissionAllowlists();
    } catch (err) {
      logStderr(`Startup agy allow-list sync warning: ${err.message}`);
    }

    if (
      process.env.AGY_AUTO_BOOTSTRAP_ON_START === '1' &&
      process.env.AGY_NO_SELF_BOOTSTRAP !== '1'
    ) {
      try {
        runSelfHealingBootstrap(WORKSPACE_ROOT);
      } catch (err) {
        logStderr(`Startup auto-bootstrap warning: ${err.message}`);
      }
    } else {
      logStderr(
        'Startup workspace file bootstrap skipped by default (no root CLAUDE.md/AGENTS.md or settings rewrite).'
      );
    }

    try {
      const startupLedger = readJsonSafe(STATE_LEDGER_PATH);
      reconcileOrphanedJobsAndSessions(startupLedger, {
        persistIfChanged: true,
        forceMarkNonLocal: true
      });
    } catch (err) {
      logStderr(`Startup ledger reconciliation warning: ${err.message}`);
    }

    runModelDiscovery().catch(err => logStderr(`Startup discovery error: ${err.message}`));
    const discoveryInterval = setInterval(() => {
      runModelDiscovery().catch(err => logStderr(`24h discovery error: ${err.message}`));
    }, 24 * 60 * 60 * 1000);
    discoveryInterval.unref();

    process.stdin.on('data', onStdinData);

    logStderr(
      `Antigravity Subagent Governor MCP Server v1.3.0 started and listening on stdio (agy concurrency ${AGY_MAX_CONCURRENCY}, ${AGY_READONLY_COMMAND_ALLOWLIST.length} allow-listed read-only commands).`
    );
  }
} // require.main === module
