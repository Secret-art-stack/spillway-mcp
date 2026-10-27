#!/usr/bin/env node
/**
 * End-to-End Sandboxed Smoke Test for `spillway-mcp`
 * Simulates Claude Code's MCP stdio client without consuming any Claude tokens.
 *
 * Runs all config/state mutations inside disposable `os.tmpdir()` directories
 * so the repository tree remains 100% clean and ready for `git init`.
 *
 * Exits non-zero on any failed assertion or stdout framing error.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

// Create an isolated temp config directory copied from `config/` so runtime
// state files (state-ledger.json, ide-sync.json) are tested in a sandbox
// without leaving machine-specific paths inside the git repository.
const REPO_ROOT = path.resolve(__dirname, '..');
const REPO_CONFIG_DIR = path.join(REPO_ROOT, 'config');
const SANDBOX_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-smoke-cfg-'));
for (const entry of fs.readdirSync(REPO_CONFIG_DIR)) {
  fs.copyFileSync(path.join(REPO_CONFIG_DIR, entry), path.join(SANDBOX_CONFIG_DIR, entry));
}
process.env.AGY_CONFIG_DIR = SANDBOX_CONFIG_DIR;

const SERVER_SCRIPT = path.join(__dirname, 'index.js');
const governor = require(SERVER_SCRIPT);

const failures = [];
function assert(condition, message) {
  if (condition) {
    console.log(`   [PASS] ${message}`);
  } else {
    console.log(`   [FAIL] ${message}`);
    failures.push(message);
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function responseBody(toolText) {
  const idx = toolText.indexOf('\n---\n[AGY GOVERNOR TELEMETRY]');
  return (idx === -1 ? toolText : toolText.slice(0, idx)).trim();
}

function runBootstrap(targetCwd, extraFlags = []) {
  const res = spawnSync(
    process.execPath,
    [SERVER_SCRIPT, '--bootstrap', '--cwd', targetCwd, ...extraFlags],
    {
      cwd: targetCwd,
      env: { ...process.env, AGY_CONFIG_DIR: SANDBOX_CONFIG_DIR },
      encoding: 'utf8'
    }
  );
  if (res.status !== 0) {
    throw new Error(`--bootstrap exited ${res.status}: ${res.stderr}`);
  }
  return JSON.parse(res.stdout);
}

async function runOfflineChecks() {
  console.log('0. Offline checks in sandboxed temp workspace (real repo untouched)...');

  // 0a. Auto-initialization of state-ledger.json & ide-sync.json from *.example.json
  assert(
    !fs.existsSync(path.join(REPO_CONFIG_DIR, 'state-ledger.json')) &&
      !fs.existsSync(path.join(REPO_CONFIG_DIR, 'ide-sync.json')),
    'Repo config/ directory contains only *.example.json templates (no live state files)'
  );
  const initFiles = governor.ensureRuntimeStateFiles();
  assert(
    initFiles.length === 2 &&
      fs.existsSync(governor.STATE_LEDGER_PATH) &&
      fs.existsSync(governor.IDE_SYNC_PATH),
    'ensureRuntimeStateFiles() auto-initializes state-ledger.json and ide-sync.json from *.example.json'
  );

  // 0b. Hardware VRAM profiles in config/model-matrix.json
  const cfg8 = governor.getLocalGpuConfig(null, '8gb_vram');
  const cfg12 = governor.getLocalGpuConfig(null, '12gb_vram');
  const cfg24 = governor.getLocalGpuConfig(null, '24gb_vram_or_mac_unified');
  assert(
    cfg8.max_scout_input_chars === 48000 &&
      cfg12.max_scout_input_chars === 80000 &&
      cfg24.max_scout_input_chars === 140000,
    'Hardware VRAM presets (8gb_vram=48k, 12gb_vram=80k, 24gb_vram_or_mac_unified=140k) resolve cleanly'
  );

  // 0c. Safe Command Allow-list in local_exec_and_triage
  assert(
    governor.validateSafeTriageCommand('pytest -q').allowed === true &&
      governor.validateSafeTriageCommand('npm test').allowed === true &&
      governor.validateSafeTriageCommand('npx tsc --noEmit').allowed === true &&
      governor.validateSafeTriageCommand('cargo check').allowed === true,
    'validateSafeTriageCommand allows safe test/typecheck/lint runners'
  );
  assert(
    governor.validateSafeTriageCommand('pytest && echo pwned').allowed === false &&
      governor.validateSafeTriageCommand('npm test ; rm -rf /').allowed === false &&
      governor.validateSafeTriageCommand('pytest | cat').allowed === false &&
      governor.validateSafeTriageCommand('powershell -enc deadbeef').allowed === false,
    'validateSafeTriageCommand blocks command chaining (&&, ;, |) and non-allowlisted binaries'
  );

  // 0d. Allow-list & SAFE_READONLY_MCP_TOOLS constant shapes
  const allow = governor.AGY_READONLY_COMMAND_ALLOWLIST;
  assert(Array.isArray(allow) && allow.length >= 12, `AGY_READONLY_COMMAND_ALLOWLIST exported with ${allow.length} rules`);
  assert(allow.includes('command(git log -1 --oneline)'), 'allow-list contains command(git log -1 --oneline)');
  assert(allow.every(r => /^command\([^()]+\)$/.test(r)), 'every rule has the exact-match command(<line>) form');
  assert(governor.AGY_MAX_CONCURRENCY === 1, 'agy process concurrency is fixed at 1');
  assert(
    Array.isArray(governor.SAFE_READONLY_MCP_TOOLS) &&
      governor.SAFE_READONLY_MCP_TOOLS.length === 4 &&
      !governor.SAFE_READONLY_MCP_TOOLS.includes('agy_delegate_edit'),
    'SAFE_READONLY_MCP_TOOLS contains only the 4 read-only tools and never agy_delegate_edit'
  );
  assert(
    typeof governor.SCOUT_SYSTEM_PROMPT === 'string' &&
      governor.SCOUT_SYSTEM_PROMPT.includes('NOT_FOUND_ON_DISK:') &&
      governor.MCP_SERVER_INSTRUCTIONS.includes('ZERO-TRUST MEMORY'),
    'SCOUT_SYSTEM_PROMPT enforces NOT_FOUND_ON_DISK and MCP_SERVER_INSTRUCTIONS enforces ZERO-TRUST MEMORY'
  );

  // 0e. Sandboxed --bootstrap in os.tmpdir()
  const tempWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-smoke-ws-'));
  try {
    const claudeDir = path.join(tempWs, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'settings.local.json'),
      JSON.stringify(
        {
          hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo check' }] }] },
          permissions: {
            allow: ['Bash(git status:*)'],
            deny: ['Read(.env)']
          }
        },
        null,
        2
      ),
      'utf8'
    );

    const gitDir = path.join(tempWs, '.git');
    fs.mkdirSync(gitDir, { recursive: true });
    fs.writeFileSync(
      path.join(gitDir, 'config'),
      '[core]\n\trepositoryformatversion = 0\n\tworktreeConfig = true\n',
      'utf8'
    );

    const first = runBootstrap(tempWs);
    const okStatuses = ['created', 'updated', 'already_up_to_date'];
    assert(
      okStatuses.includes(first.agy_permissions?.cli_settings?.status),
      `first --bootstrap handled antigravity-cli/settings.json (${first.agy_permissions?.cli_settings?.status})`
    );
    assert(
      okStatuses.includes(first.agy_permissions?.default_project_grants?.status),
      `first --bootstrap handled default-cli-project.json (${first.agy_permissions?.default_project_grants?.status})`
    );

    const second = runBootstrap(tempWs);
    assert(
      second.agy_permissions?.cli_settings?.status === 'already_up_to_date' &&
        second.agy_permissions?.cli_settings?.rules_added === 0,
      'second --bootstrap leaves antigravity-cli/settings.json untouched (idempotent)'
    );

    assert(
      !fs.existsSync(path.join(tempWs, 'CLAUDE.md')) && !fs.existsSync(path.join(tempWs, 'AGENTS.md')),
      'Fix 1a: default --bootstrap does NOT write root CLAUDE.md or AGENTS.md unless --write-docs is passed'
    );

    const tempClaudeSettings = readJson(path.join(claudeDir, 'settings.local.json'));
    assert(
      tempClaudeSettings.enableAllProjectMcpServers === undefined,
      'Fix 2a: .claude/settings.local.json does NOT set enableAllProjectMcpServers: true'
    );
    assert(
      Array.isArray(tempClaudeSettings.enabledMcpjsonServers) &&
        tempClaudeSettings.enabledMcpjsonServers.includes('agy-subagent'),
      'Fix 2b: .claude/settings.local.json enables only agy-subagent in enabledMcpjsonServers'
    );
    assert(
      Array.isArray(tempClaudeSettings.hooks?.PreToolUse) &&
        Array.isArray(tempClaudeSettings.permissions?.deny) &&
        tempClaudeSettings.permissions.deny.includes('Read(.env)'),
      'Fix 2c: .claude/settings.local.json preserves existing hooks and permissions.deny intact'
    );
    assert(
      tempClaudeSettings.permissions.allow.includes('mcp__agy-subagent__agy_status') &&
        tempClaudeSettings.permissions.allow.includes('mcp__agy-subagent__agy_delegate_research') &&
        tempClaudeSettings.permissions.allow.includes('mcp__agy-subagent__local_file_scout') &&
        !tempClaudeSettings.permissions.allow.includes('mcp__agy-subagent__agy_delegate_edit') &&
        !tempClaudeSettings.permissions.allow.includes('mcp__agy-subagent__local_exec_and_triage') &&
        !tempClaudeSettings.permissions.allow.includes('mcp__agy-subagent__local_draft_leaf_code'),
      'Fix 2d: .claude/settings.local.json pre-approves only read-only tools and never auto-approves edit/shell tools'
    );

    const gitConfigAfterDefault = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    assert(
      first.git_worktree_check?.action === 'warning_worktree_config_present' &&
        /worktreeConfig\s*=\s*true/.test(gitConfigAfterDefault),
      'Fix 3: checkAndFixGitWorktreeConfig is report-only by default and does not mutate .git/config without opt-in'
    );

    runBootstrap(tempWs, ['--write-docs']);
    const claudeMd = fs.readFileSync(path.join(tempWs, 'CLAUDE.md'), 'utf8');
    assert(/Headless Permission Behavior/.test(claudeMd), 'opt-in --write-docs writes CLAUDE.md with the headless permission section');
    assert(
      claudeMd.includes('local_file_scout') &&
        claudeMd.includes('local_exec_and_triage') &&
        claudeMd.includes('local_draft_leaf_code'),
      'opt-in --write-docs CLAUDE.md includes the 3 Tier 3 Local GPU tools'
    );
  } finally {
    fs.rmSync(tempWs, { recursive: true, force: true });
  }

  const skipPermRes = await governor.executeAgyWithGovernor({
    prompt: 'test skip permissions guard',
    mode: 'dangerously-skip-permissions'
  });
  assert(
    skipPermRes.ok === false && /refused/i.test(skipPermRes.error || ''),
    'Fix 4: executeAgyWithGovernor refuses --dangerously-skip-permissions by default unless AGY_ALLOW_SKIP_PERMISSIONS=1'
  );
  console.log('');
}

async function runSafeguardChecks() {
  console.log('0f. Testing the 4 Local GPU Safeguards (Offline / Deterministic)...');

  // Safeguard #1: Ollama /v1/models vs /api/ps Trap + keep_alive: "30m"
  {
    const calledUrls = [];
    let capturedBody = null;
    const mockOllamaFetch = async (url, opts = {}) => {
      calledUrls.push(url);
      if (url.endsWith('/api/ps')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: 'gemma4:12b-q4_K_M', model: 'gemma4:12b-q4_K_M' }]
          })
        };
      }
      if (url.endsWith('/v1/models')) {
        throw new Error('Should NEVER call /v1/models on Ollama port 11434 when probing!');
      }
      if (url.endsWith('/v1/chat/completions')) {
        capturedBody = JSON.parse(opts.body);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            choices: [{ message: { content: '- `foo()` at line 10' }, finish_reason: 'stop' }]
          })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };

    const probeHot = await governor.probeAndResolveLocalGpu(
      { endpoints: ['http://127.0.0.1:11434/v1'], preferred_model: 'auto', keep_alive: '30m' },
      mockOllamaFetch
    );
    assert(
      probeHot.online && probeHot.provider === 'ollama' && probeHot.model === 'gemma4:12b-q4_K_M' && probeHot.hotInVram === true,
      'Safeguard #1a: Ollama probe queries GET /api/ps first and selects the hot VRAM model without touching /v1/models'
    );
    assert(
      !calledUrls.some(u => u.endsWith('/v1/models')),
      'Safeguard #1b: /v1/models was never called on Ollama port 11434'
    );

    const chatRes = await governor.callLocalGpuChatCompletion({
      systemPrompt: 'sys',
      userPrompt: 'usr',
      maxTokens: 600,
      customConfig: { endpoints: ['http://127.0.0.1:11434/v1'], preferred_model: 'auto', keep_alive: '30m' },
      fetchImpl: mockOllamaFetch
    });
    assert(
      chatRes.ok && capturedBody?.keep_alive === '30m' && capturedBody?.max_tokens === 600,
      'Safeguard #1c: Ollama chat completion passes keep_alive: "30m" and max_tokens: 600 in request body'
    );

    const mockColdOllamaFetch = async url => {
      if (url.endsWith('/api/ps')) {
        return { ok: true, status: 200, json: async () => ({ models: [] }) };
      }
      if (url.endsWith('/api/tags')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            models: [{ name: 'huge-70b:latest' }, { name: 'qwen2.5-coder:14b' }]
          })
        };
      }
      throw new Error(`Unexpected URL: ${url}`);
    };
    const probeCold = await governor.probeAndResolveLocalGpu(
      {
        endpoints: ['http://127.0.0.1:11434/v1'],
        preferred_model: 'auto',
        default_ollama_model: 'qwen2.5-coder:14b',
        allow_cold_ollama_load: true
      },
      mockColdOllamaFetch
    );
    assert(
      probeCold.online && probeCold.model === 'qwen2.5-coder:14b' && probeCold.hotInVram === false,
      'Safeguard #1d: When /api/ps is empty, Ollama probe ignores data[0] (huge-70b) and picks verified default_ollama_model'
    );
  }

  // Safeguard #2: Empty-Output & Destructive Overwrite Guard in `local_draft_leaf_code`
  {
    assert(!governor.extractAndValidateDraftedCode('').valid, 'Safeguard #2a: Rejects empty output');
    assert(!governor.extractAndValidateDraftedCode('```js\nconst x=1;\n```').valid, 'Safeguard #2b: Rejects extracted code < 15 characters');
    const unclosedFenceCheck = governor.extractAndValidateDraftedCode(
      '```javascript\nexport function calculateTotal(items) {\n  return items.reduce((a, b) => a + b, 0);'
    );
    assert(!unclosedFenceCheck.valid && /unclosed/i.test(unclosedFenceCheck.reason), 'Safeguard #2c: Rejects unclosed markdown code fence');
    const finishLenCheck = governor.extractAndValidateDraftedCode(
      '```javascript\nexport const validLookingCode = () => { return 42; };\n```',
      'length'
    );
    assert(!finishLenCheck.valid && /finish_reason=length/i.test(finishLenCheck.reason), 'Safeguard #2d: Rejects truncated output when finish_reason === "length"');
    const validCheck = governor.extractAndValidateDraftedCode(
      'Here is your drafted module:\n```javascript\nexport function sumArray(values) {\n  return values.reduce((acc, v) => acc + v, 0);\n}\n```\nHope this helps!'
    );
    assert(
      validCheck.valid && validCheck.code.includes('export function sumArray') && !validCheck.code.includes('```'),
      'Safeguard #2e: Extracts clean code from valid fenced block and strips conversational wrapper'
    );
  }

  // Safeguard #3: Windows Subprocess Tree Kill on Timeout in `local_exec_and_triage`
  {
    const startMs = Date.now();
    const timedOutRes = await governor.runSubprocessWithTreeKill({
      command: process.platform === 'win32' ? 'ping -n 15 127.0.0.1' : 'sleep 10',
      cwd: os.tmpdir(),
      timeoutMs: 800
    });
    const elapsedMs = Date.now() - startMs;
    assert(
      timedOutRes.timedOut === true && elapsedMs < 5000,
      `Safeguard #3: Timed-out subprocess tree killed promptly via taskkill /T /F (${elapsedMs}ms)`
    );
  }

  // Safeguard #4: 50-50 Head/Tail Slicing + Line-Number & Binary/Secret Safety in `local_file_scout`
  {
    assert(governor.isSecretOrBlockedPath('.env') === true, 'Safeguard #4a: Blocks .env');
    assert(governor.isSecretOrBlockedPath('.env.production') === true, 'Safeguard #4b: Blocks .env.production');
    assert(governor.isSecretOrBlockedPath('id_rsa') === true, 'Safeguard #4c: Blocks id_rsa private key');
    assert(governor.isSecretOrBlockedPath('.env.example') === false, 'Safeguard #4d: Allows .env.example template');

    const binBuf = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a]);
    const txtBuf = Buffer.from('function hello() { return "world"; }\n', 'utf8');
    assert(governor.isBinaryBuffer(binBuf) === true, 'Safeguard #4e: Detects null byte \\0 in binary buffer');
    assert(governor.isBinaryBuffer(txtBuf) === false, 'Safeguard #4f: Passes normal UTF-8 text buffer');

    const bigLines = Array.from({ length: 200 }, (_, i) => `const lineVar_${i + 1} = ${i + 1};`).join('\n');
    const sliced = governor.formatNumberedFileWithHeadTailSlice(bigLines, 600);
    assert(
      sliced.sliced === true &&
        sliced.text.startsWith('1: const lineVar_1 = 1;') &&
        sliced.text.includes('50-50 HEAD/TAIL SLICE') &&
        sliced.text.endsWith('200: const lineVar_200 = 200;'),
      'Safeguard #4g: 50-50 Head/Tail Slicing preserves exact 1-based line numbers on both head (line 1) and tail (line 200)'
    );

    const cfg = governor.getLocalGpuConfig();
    assert(cfg.scout_max_tokens === 600, `Safeguard #4h: local_file_scout max_tokens is set to 600 (got ${cfg.scout_max_tokens})`);
  }
  console.log('');
}

async function runSmokeTest() {
  console.log('=== Starting spillway-mcp Sandboxed Smoke Test ===\n');

  const tempRuntimeWs = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-smoke-runtime-'));
  try {
    await runOfflineChecks();
    await runSafeguardChecks();

    const child = spawn(process.execPath, [SERVER_SCRIPT], {
      cwd: tempRuntimeWs,
      env: {
        ...process.env,
        AGY_CONFIG_DIR: SANDBOX_CONFIG_DIR,
        AGY_WORKSPACE_ROOT: tempRuntimeWs
      },
      stdio: ['pipe', 'pipe', 'pipe']
    });

    const pending = new Map();
    let stdoutBuffer = '';
    let framingErrors = 0;

    child.stderr.on('data', chunk => {
      process.stderr.write(`  [server-stderr] ${chunk.toString('utf8')}`);
    });

    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk.toString('utf8');
      let idx;
      while ((idx = stdoutBuffer.indexOf('\n')) !== -1) {
        const line = stdoutBuffer.slice(0, idx).trim();
        stdoutBuffer = stdoutBuffer.slice(idx + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id !== undefined && pending.has(msg.id)) {
            const { resolve } = pending.get(msg.id);
            pending.delete(msg.id);
            resolve(msg);
          }
        } catch (err) {
          framingErrors++;
          console.error(`  [FRAMING ERROR] Invalid JSON on stdout: ${line}`);
        }
      }
    });

    let nextId = 1;
    const sendRpc = (method, params = {}, timeoutMs = 120000) => {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`Timeout waiting for RPC ${method} (id=${id})`));
        }, timeoutMs);
        pending.set(id, {
          resolve: res => {
            clearTimeout(timer);
            resolve(res);
          }
        });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };

    try {
      // 1. Initialize
      console.log('1. Testing MCP `initialize` handshake & `result.instructions`...');
      const initRes = await sendRpc('initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'smoke-test-client', version: '1.0.0' }
      });
      assert(initRes.result?.serverInfo?.name === 'agy-subagent-governor', 'initialize returns server info');
      assert(
        typeof initRes.result?.instructions === 'string' &&
          initRes.result.instructions.includes('ZERO-TRUST MEMORY') &&
          initRes.result.instructions.includes('local_file_scout'),
        'Fix 1b: initialize returns MCP server instructions with ZERO-TRUST MEMORY and Tier 3 Local GPU rules'
      );

      // 2. List Tools
      console.log('\n2. Testing `tools/list`...');
      const listRes = await sendRpc('tools/list');
      const toolNames = listRes.result.tools.map(t => t.name);
      assert(toolNames.length === 9, `9 MCP tools exposed (got ${toolNames.length})`);
      assert(
        toolNames.includes('local_file_scout') &&
          toolNames.includes('local_exec_and_triage') &&
          toolNames.includes('local_draft_leaf_code'),
        'tools/list exposes local_file_scout, local_exec_and_triage, and local_draft_leaf_code'
      );

      // 2b. Test local_exec_and_triage short-circuit, command-chaining block, and local_file_scout guardrails
      console.log('\n2b. Testing `local_exec_and_triage` allow-list & `local_file_scout` guardrails...');
      const shortExecRes = await sendRpc('tools/call', {
        name: 'local_exec_and_triage',
        arguments: {
          command: 'git status --short',
          working_dir: tempRuntimeWs
        }
      });
      const shortExecText = shortExecRes.result.content[0].text;
      assert(
        !shortExecRes.result.isError && shortExecText.includes('<= 40-line threshold'),
        'local_exec_and_triage returns <=40 line output directly with zero LLM overhead'
      );

      const chainedExecRes = await sendRpc('tools/call', {
        name: 'local_exec_and_triage',
        arguments: {
          command: 'pytest && echo chained',
          working_dir: tempRuntimeWs
        }
      });
      assert(
        Boolean(chainedExecRes.result.isError) &&
          /Refused by local_exec_and_triage safe command allow-list/i.test(chainedExecRes.result.content[0].text),
        'local_exec_and_triage blocks chained shell commands over MCP stdio'
      );

      const tmpBinaryPath = path.join(tempRuntimeWs, 'test.bin');
      fs.writeFileSync(tmpBinaryPath, Buffer.from([0x00, 0x01, 0x02, 0x03]));
      const guardRes = await sendRpc('tools/call', {
        name: 'local_file_scout',
        arguments: {
          file_paths: ['.env', tmpBinaryPath],
          query: 'Extract secrets or binary content'
        }
      });
      const guardText = guardRes.result.content[0].text;
      assert(
        guardText.includes('SKIPPED SECRET FILE') && guardText.includes('SKIPPED BINARY FILE'),
        'local_file_scout blocks .env secret files and skips binary files with null bytes in first 4KB'
      );

      // 3. Test agy_status
      console.log('\n3. Testing `agy_status`...');
      const statusRes = await sendRpc('tools/call', {
        name: 'agy_status',
        arguments: { refresh_models: false }
      });
      const statusText = statusRes.result.content[0].text;
      assert(statusText.includes('"agy_process_queue"'), 'agy_status reports the agy process queue');
      assert(statusText.includes('Disk-Truth Guard:'), 'telemetry footer includes the Disk-Truth Guard recency anchor');

      // 4. Test agy_spawn_swarm path-partition collision protection
      console.log('\n4. Testing `agy_spawn_swarm` overlapping path guard...');
      const collisionRes = await sendRpc('tools/call', {
        name: 'agy_spawn_swarm',
        arguments: {
          tasks: [
            { id: 'worker-a', prompt: 'Check auth', paths: ['src/auth/**'] },
            { id: 'worker-b', prompt: 'Check jwt', paths: ['src/auth/jwt/**'] }
          ]
        }
      });
      assert(Boolean(collisionRes.result.isError), 'collision check blocks overlapping swarm paths');

      console.log(`\n=== Smoke Test Complete. Zero stdout framing errors: ${framingErrors === 0} ===`);
      assert(framingErrors === 0, 'zero stdout framing errors');
    } finally {
      child.kill();
      await new Promise(resolve => child.once('exit', resolve));
    }
  } finally {
    try {
      fs.rmSync(tempRuntimeWs, { recursive: true, force: true });
    } catch (_) {}
    try {
      fs.rmSync(SANDBOX_CONFIG_DIR, { recursive: true, force: true });
    } catch (_) {}
  }

  if (failures.length > 0) {
    console.log(`\n${failures.length} assertion(s) FAILED:`);
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  } else {
    console.log('\nAll assertions passed.');
  }
}

runSmokeTest().catch(err => {
  console.error('Smoke test failed:', err);
  process.exit(1);
});
