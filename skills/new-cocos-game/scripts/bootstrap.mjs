#!/usr/bin/env node
/**
 * bootstrap.mjs — mechanical steps for /new-cocos-game
 *
 *   node bootstrap.mjs resolve --name <slug> [--template game|playable|cc4|<cc-*-template>|<abs>]
 *   node bootstrap.mjs create  --name <slug> [--template ...] [--open] [--no-orca] [--no-wait-mcp]
 *   node bootstrap.mjs orca-add --name <slug> | --path <abs>
 *   node bootstrap.mjs trust        --name <slug> | --path <abs>   (linked git worktree: also turns Claude auto-memory off)
 *   node bootstrap.mjs claude-trust --name <slug> | --path <abs>   (alias of trust)
 *   node bootstrap.mjs mcp-config --path <abs> [--port N]   pin a Funplay port for this checkout + write project-local MCP client configs
 *   node bootstrap.mjs wait-mcp --path <abs> [--timeout-ms 180000] [--port N]
 *   node bootstrap.mjs agent-session --path <abs> [--agent cursor|claude|claude-agent-teams|codex|gemini|opencode|antigravity|"<spec>"] [--model m] [--effort e] [--title name] [--prompt "..."] [--json] [--boot|--no-boot]
 *       --json: stdout = exactly one JSON object (progress → stderr). Boot turn is auto: skipped for
 *       cursor/codex and for claude when the project has CLAUDE.md; --boot/--no-boot override.
 *   node bootstrap.mjs agent-cmd [--agent ...] [--model m] [--effort e]   dry preview of the launch command
 *
 * Port model: every checkout (main project or Orca worktree) owns ONE editor MCP
 * port, pinned locally:
 *   - 3.8 Funplay → funplay-cocos-mcp.config.json (8765..)
 *   - cc4 COCOS CLI → cocos-cli-mcp.config.json (MCP 9527..9559, preview 7456..7489)
 * Agents in that checkout reach the editor through project-local MCP client configs
 * (.cursor/mcp.json, .mcp.json, .codex/config.toml) that point at that port —
 * never through a global 8765/9527 assumption. `wait-mcp` only reports ok when
 * the gate for THIS checkout passes (Funplay /health.projectName, or cocos-cli
 * initialize on the pinned port).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import os from 'node:os';

const GAMES_ROOT = '/Users/wikz/Works/games/CocosCreator';
const TEMPLATES_DIR = '/Users/wikz/Works/games/template';
const DEFAULT_TEMPLATE = 'cc-game-template';
const CC4_TEMPLATE = 'cc4-game-template';
const COCOS_CLI_MCP_PORT = 9527; // default / first in range; real pin is per-checkout
const COCOS_CLI_CONFIG_FILE = 'cocos-cli-mcp.config.json';
const TEMPLATE_ALIASES = {
  game: 'cc-game-template',
  playable: 'cc-playable-template',
  project: 'cc-project-template',
  cc4: CC4_TEMPLATE,
  'cc4-game': CC4_TEMPLATE,
};
// Resolved from --template in main(); every later reference reads this.
let TEMPLATE_ROOT = path.join(TEMPLATES_DIR, DEFAULT_TEMPLATE);

/**
 * --template accepts: a shorthand ("game" | "playable" | "project" | "cc4" →
 * folder under TEMPLATES_DIR), a full folder name ("cc-playable-template" /
 * "cc4-game-template"), or an absolute path to a template checkout.
 */
function resolveTemplateRoot(spec) {
  if (!spec) return TEMPLATE_ROOT;
  if (path.isAbsolute(spec)) return spec;
  if (TEMPLATE_ALIASES[spec]) {
    return path.join(TEMPLATES_DIR, TEMPLATE_ALIASES[spec]);
  }
  const asFolder = path.join(TEMPLATES_DIR, spec);
  if (fs.existsSync(asFolder)) return asFolder;
  // "cc-*" / "cc4-*" full names, else shorthand → cc-<spec>-template
  const name =
    spec.startsWith('cc-') || spec.startsWith('cc4-') ? spec : `cc-${spec}-template`;
  return path.join(TEMPLATES_DIR, name);
}

function templateFolderName(root = TEMPLATE_ROOT) {
  return path.basename(root);
}

/** COCOS 4 CLI template (no Funplay / no Creator 3.8 GUI --nologin). */
function isCc4Template(root = TEMPLATE_ROOT) {
  if (templateFolderName(root) === CC4_TEMPLATE) return true;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    return String(pkg.creator?.version || '').startsWith('4.');
  } catch {
    return false;
  }
}

function isCc4Project(projectPath) {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(projectPath, 'package.json'), 'utf8'),
    );
    if (String(pkg.creator?.version || '').startsWith('4.')) return true;
  } catch {
    /* fall through */
  }
  return (
    fs.existsSync(path.join(projectPath, 'scripts', 'open-mcp.sh')) &&
    !fs.existsSync(path.join(projectPath, 'extensions'))
  );
}

function readCocosCliVersion() {
  try {
    return execFileSync('cocos', ['--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}
const CREATOR_SEARCH_ROOTS = [
  '/Applications/Cocos/Creator',
  path.join(process.env.HOME || '', 'CocosCreator/Creator'),
];
const DEFAULT_AGENT = 'cursor';
const DEFAULT_MCP_PORT = 8765;
const MCP_PORT_RANGE_END = 8799;
const FUNPLAY_CONFIG_FILE = 'funplay-cocos-mcp.config.json';
const MCP_SERVER_KEY = 'funplay_cocos';
/** Copied from main → worktree; port is always re-pinned per checkout. */
const FUNPLAY_INHERIT_KEYS = [
  'toolProfile',
  'enabledTools',
  'disabledTools',
  'enabledToolCategories',
  'disabledToolCategories',
  'enableSessions',
  'executeJavascriptSafetyChecks',
  'maxInteractionLogEntries',
  'language',
  'savedToolProfiles',
  'activeToolProfileName',
  'lastClientTargetId',
];
const NON_CURSOR_BOOT_PROMPT = `Before performing any task in this session:
1. Find and read every AGENTS.md and .cursor/rules files that applies to the current workspace.
2. Run git status once.
3. Do not edit files, run side-effect commands, commit, or push during startup.
When startup is complete, respond with only: AGENTS.md loaded — workspace rules understood, existing changes preserved, ready for the next task.
Then stop and wait for my next task.`;
const CLAUDE_JSON = path.join(os.homedir(), '.claude.json');
const CODEX_TOML = path.join(os.homedir(), '.codex', 'config.toml');

/**
 * Machine-local / regenerable dirs to skip.
 * Keep `library/` — copying it from the template cuts first Creator open time.
 * Keep `build/` scripts (`build.sh`, `deploy.sh`, `build-configs/`) — only skip
 * generated output under it.
 * Never copy `.git` — the new project always gets a fresh `git init`.
 */
const RSYNC_EXCLUDES = [
  'temp/',
  'local/',
  'profiles/',
  'build/web-mobile/',
  'build/.vercel/',
  'node_modules/',
  '.DS_Store',
  '.git',
  '.git/',
  // per-checkout port pins + MCP client configs — regenerated by mcp-config
  '/funplay-cocos-mcp.config.json',
  '/cocos-cli-mcp.config.json',
  '/.cursor/mcp.json',
  '/.mcp.json',
  '/.codex/config.toml',
];

function die(msg, code = 1) {
  console.error(`new-cocos-game: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const flags = new Set();
  const values = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (
      a === '--name' ||
      a === '--path' ||
      a === '--agent' ||
      a === '--model' ||
      a === '--effort' ||
      a === '--title' ||
      a === '--prompt' ||
      a === '--timeout-ms' ||
      a === '--port' ||
      a === '--template'
    ) {
      values[a.slice(2)] = argv[++i];
    } else if (a.startsWith('--')) {
      flags.add(a.slice(2));
    } else {
      positional.push(a);
    }
  }
  return { cmd: positional[0], values, flags };
}

function listInstalledCreators() {
  const found = [];
  for (const root of CREATOR_SEARCH_ROOTS) {
    if (!root || !fs.existsSync(root)) continue;
    for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const binary = path.join(
        root,
        ent.name,
        'CocosCreator.app/Contents/MacOS/CocosCreator',
      );
      if (fs.existsSync(binary)) {
        found.push({ version: ent.name, binary, root: path.join(root, ent.name) });
      }
    }
  }
  found.sort((a, b) => compareVersions(b.version, a.version));
  return found;
}

function compareVersions(a, b) {
  const pa = String(a).split(/[^0-9]+/).filter(Boolean).map(Number);
  const pb = String(b).split(/[^0-9]+/).filter(Boolean).map(Number);
  const n = Math.max(pa.length, pb.length);
  for (let i = 0; i < n; i++) {
    const da = pa[i] || 0;
    const db = pb[i] || 0;
    if (da !== db) return da - db;
  }
  return String(a).localeCompare(String(b));
}

function readTemplateCreatorVersion() {
  const pkgPath = path.join(TEMPLATE_ROOT, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    return pkg.creator?.version || null;
  } catch {
    return null;
  }
}

function resolveCreator(wanted) {
  const installed = listInstalledCreators();
  if (!installed.length) {
    die(
      'no Cocos Creator install found under /Applications/Cocos/Creator or ~/CocosCreator/Creator',
    );
  }
  if (!wanted) return installed[0];
  const hit = installed.find((c) => c.version === wanted);
  if (!hit) {
    // Same-minor fallback (e.g. template pins 3.8.7, machine has 3.8.8):
    // Creator migrates patch-level differences on open. Anything further → die.
    const minor = wanted.split('.').slice(0, 2).join('.');
    const near = installed.find((c) => c.version.startsWith(minor + '.'));
    if (near) {
      console.warn(
        `→ warning: Creator ${wanted} not installed; using ${near.version} (same minor, project will migrate)`,
      );
      return { ...near, versionFallbackFrom: wanted };
    }
    die(
      `Creator ${wanted} not installed. Available: ${installed.map((c) => c.version).join(', ')}`,
    );
  }
  return hit;
}

function normalizeSlug(name) {
  if (!name) die('missing --name <slug>');
  const slug = String(name).trim();
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slug)) {
    die(`invalid project name "${slug}" — use letters, numbers, hyphens`);
  }
  return slug;
}

function resolveProjectPath(values) {
  if (values.path) {
    const p = path.resolve(values.path);
    if (!fs.existsSync(p)) die(`path does not exist: ${p}`);
    return p;
  }
  const slug = normalizeSlug(values.name);
  return path.join(GAMES_ROOT, slug);
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout.trim();
}

function resolveOrcaBin() {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  const selected = process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' ? 'orca-ide' : 'orca';
  const bin = which(selected);
  if (!bin) die(`Orca CLI ${selected} not found on PATH`);
  return bin;
}

function orcaJson(orcaBin, args) {
  const r = spawnSync(orcaBin, [...args, '--json'], {
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const stdout = (r.stdout || '').trim();
  const stderr = (r.stderr || '').trim();
  let parsed = null;
  if (stdout) {
    try {
      parsed = JSON.parse(stdout);
    } catch {
      parsed = null;
    }
  }
  return { status: r.status ?? 1, stdout, stderr, parsed, error: r.error };
}

function ensureOrcaReady(orcaBin) {
  let st = orcaJson(orcaBin, ['status']);
  const ready =
    st.parsed?.ok === true &&
    (st.parsed?.result?.runtime?.reachable === true ||
      st.parsed?.result?.runtime?.state === 'ready');
  if (ready) return st.parsed;
  console.log('→ orca open …');
  const opened = orcaJson(orcaBin, ['open']);
  if (opened.status !== 0 || opened.parsed?.ok === false) {
    die(
      `orca open failed: ${opened.stderr || opened.stdout || opened.error?.message || 'unknown'}`,
    );
  }
  st = orcaJson(orcaBin, ['status']);
  const ready2 =
    st.parsed?.ok === true &&
    (st.parsed?.result?.runtime?.reachable === true ||
      st.parsed?.result?.runtime?.state === 'ready');
  if (!ready2) {
    die(`orca runtime not ready after open: ${st.stderr || st.stdout}`);
  }
  return st.parsed;
}

function addToOrca(projectPath) {
  const orcaBin = resolveOrcaBin();
  ensureOrcaReady(orcaBin);
  console.log(`→ orca repo add --path ${projectPath}`);
  const added = orcaJson(orcaBin, ['repo', 'add', '--path', projectPath]);
  if (added.status !== 0 || added.parsed?.ok === false) {
    die(
      `orca repo add failed: ${added.stderr || added.stdout || JSON.stringify(added.parsed)}`,
    );
  }
  return added.parsed?.result ?? added.parsed;
}

function setPackageName(projectPath, slug) {
  const pkgPath = path.join(projectPath, 'package.json');
  if (!fs.existsSync(pkgPath)) return;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.name = slug;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
}

function openEditor(binary, projectPath) {
  const child = spawnSync(binary, ['--project', projectPath, '--nologin'], {
    detached: true,
    stdio: 'ignore',
  });
  if (child.error) die(`failed to launch Creator: ${child.error.message}`);
  child.unref?.();
  return true;
}

function cursorProjectSlug(absPath) {
  return absPath.replace(/^[\\/]+/, '').replace(/[\\/]/g, '-');
}

function cursorWorkspaceTrustedPath(absPath) {
  return path.join(
    os.homedir(),
    '.cursor',
    'projects',
    cursorProjectSlug(absPath),
    '.workspace-trusted',
  );
}

function ensureCursorWorkspaceTrusted(projectPath) {
  const abs = path.resolve(projectPath);
  const dest = cursorWorkspaceTrustedPath(abs);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    return { path: abs, alreadyTrusted: true, cursorTrust: dest };
  }
  const payload = {
    trustedAt: new Date().toISOString(),
    workspacePath: abs,
  };
  fs.writeFileSync(dest, JSON.stringify(payload, null, 2) + '\n');
  return { path: abs, alreadyTrusted: false, cursorTrust: dest };
}

function ensureClaudeWorkspaceTrusted(projectPath) {
  const abs = path.resolve(projectPath);
  let data = {};
  if (fs.existsSync(CLAUDE_JSON)) {
    try {
      data = JSON.parse(fs.readFileSync(CLAUDE_JSON, 'utf8'));
    } catch (e) {
      die(`cannot parse ${CLAUDE_JSON}: ${e.message}`);
    }
  }
  if (!data.projects || typeof data.projects !== 'object') data.projects = {};
  const prev = data.projects[abs] || {};
  const enabledMcp = new Set(prev.enabledMcpjsonServers || []);
  if (prev.hasTrustDialogAccepted === true && enabledMcp.has(MCP_SERVER_KEY)) {
    return { path: abs, alreadyTrusted: true, claudeJson: CLAUDE_JSON };
  }
  enabledMcp.add(MCP_SERVER_KEY);
  data.projects[abs] = {
    allowedTools: [],
    mcpContextUris: [],
    mcpServers: {},
    disabledMcpjsonServers: [],
    hasTrustDialogAccepted: true,
    hasClaudeMdExternalIncludesApproved: false,
    hasClaudeMdExternalIncludesWarningShown: false,
    ...prev,
    // project-scope .mcp.json server must be pre-approved or Claude prompts
    enabledMcpjsonServers: [...enabledMcp],
    hasTrustDialogAccepted: true,
  };
  fs.writeFileSync(CLAUDE_JSON, JSON.stringify(data, null, 2) + '\n');
  return { path: abs, alreadyTrusted: false, claudeJson: CLAUDE_JSON };
}

function ensureCodexWorkspaceTrusted(projectPath) {
  const abs = path.resolve(projectPath);
  const header = `[projects."${abs}"]`;
  fs.mkdirSync(path.dirname(CODEX_TOML), { recursive: true });
  let text = fs.existsSync(CODEX_TOML) ? fs.readFileSync(CODEX_TOML, 'utf8') : '';
  if (text.includes(header)) {
    const already =
      text.includes(`${header}\ntrust_level = "trusted"`) ||
      new RegExp(
        `${header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\ntrust_level\\s*=\\s*"trusted"`,
      ).test(text);
    if (already) {
      return { path: abs, alreadyTrusted: true, codexToml: CODEX_TOML };
    }
    text = text.replace(header, `${header}\ntrust_level = "trusted"`);
  } else {
    if (text.length && !text.endsWith('\n')) text += '\n';
    text += `\n${header}\ntrust_level = "trusted"\n`;
  }
  fs.writeFileSync(CODEX_TOML, text);
  return { path: abs, alreadyTrusted: false, codexToml: CODEX_TOML };
}

/**
 * Seed Antigravity trust so `agy --dangerously-skip-permissions` does not stall
 * on the trust-folder / trustedWorkspaces gate (same failure mode as Cursor/Claude/Codex).
 */
function ensureAntigravityWorkspaceTrusted(projectPath) {
  const abs = path.resolve(projectPath);
  const home = path.join(os.homedir(), '.gemini');
  const foldersPath = path.join(home, 'trustedFolders.json');
  let folders = {};
  if (fs.existsSync(foldersPath)) {
    try {
      folders = JSON.parse(fs.readFileSync(foldersPath, 'utf8') || '{}');
    } catch {
      folders = {};
    }
  }
  const variants = new Set([abs]);
  if (abs.startsWith('/Users/')) {
    variants.add(`/users/${abs.slice('/Users/'.length)}`);
  }
  let foldersChanged = false;
  let alreadyFolders = true;
  for (const v of variants) {
    if (folders[v] !== 'TRUST_FOLDER') {
      folders[v] = 'TRUST_FOLDER';
      foldersChanged = true;
      alreadyFolders = false;
    }
  }
  if (foldersChanged) {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(foldersPath, JSON.stringify(folders, null, 2) + '\n');
  }

  const cliSettingsPath = path.join(home, 'antigravity-cli', 'settings.json');
  let alreadyCli = true;
  if (fs.existsSync(cliSettingsPath)) {
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(cliSettingsPath, 'utf8') || '{}');
    } catch {
      data = {};
    }
    if (!Array.isArray(data.trustedWorkspaces)) data.trustedWorkspaces = [];
    if (!data.trustedWorkspaces.includes(abs)) {
      data.trustedWorkspaces.push(abs);
      alreadyCli = false;
      fs.writeFileSync(cliSettingsPath, JSON.stringify(data, null, 2) + '\n');
    }
  }

  return {
    path: abs,
    alreadyTrusted: alreadyFolders && alreadyCli,
    trustedFolders: foldersPath,
    cliSettings: fs.existsSync(cliSettingsPath) ? cliSettingsPath : null,
  };
}

/**
 * Fleet worktrees only: Claude auto-memory is keyed by cwd, so writer and reviewer in the same
 * worktree would share one memory dir — a side channel past the reviewer's "no writer pack"
 * rule, outside the curated orca-memory packs. Main checkouts keep their memory.
 * `.claude/settings.local.json` is git-ignored globally; merge, never clobber.
 */
function ensureClaudeWorktreeMemoryOff(projectPath) {
  const abs = path.resolve(projectPath);
  const r = spawnSync('git', ['-C', abs, 'rev-parse', '--absolute-git-dir', '--git-common-dir'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return { path: abs, linkedWorktree: false };
  const [gitDir, commonDir] = r.stdout.trim().split('\n');
  const real = (p) => fs.realpathSync(path.resolve(abs, p));
  if (real(commonDir) === real(gitDir)) return { path: abs, linkedWorktree: false };
  const dest = path.join(abs, '.claude', 'settings.local.json');
  const data = fs.existsSync(dest) ? readJsonSafe(dest) : {};
  if (!data) {
    console.error(`new-cocos-game: warning: cannot parse ${dest}; auto-memory left as is`);
    return { path: abs, linkedWorktree: true, autoMemory: 'unchanged', settings: dest };
  }
  if (data.autoMemoryEnabled === false) return { path: abs, linkedWorktree: true, autoMemory: 'off', settings: dest };
  data.autoMemoryEnabled = false;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, JSON.stringify(data, null, 2) + '\n');
  return { path: abs, linkedWorktree: true, autoMemory: 'off', settings: dest };
}

function ensureAgentWorkspacesTrusted(projectPath) {
  return {
    cursor: ensureCursorWorkspaceTrusted(projectPath),
    claude: ensureClaudeWorkspaceTrusted(projectPath),
    claudeMemory: ensureClaudeWorktreeMemoryOff(projectPath),
    codex: ensureCodexWorkspaceTrusted(projectPath),
    antigravity: ensureAntigravityWorkspaceTrusted(projectPath),
  };
}

/**
 * Parse `--agent` into { id, model, effort }. Accepts a bare id ("claude") or a
 * launch spec as written in AGENT_NOTES.md `fleet.orchestrator_agent`
 * ("claude --model opus --effort high", "cursor --model auto"). Explicit
 * `--model` / `--effort` CLI flags win over values embedded in the spec.
 */
function parseAgentSpec(agent, model, effort) {
  const tokens = String(agent || DEFAULT_AGENT)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const id = tokens[0] || DEFAULT_AGENT;
  let specModel = null;
  let specEffort = null;
  for (let i = 1; i < tokens.length; i++) {
    if (tokens[i] === '--model' && tokens[i + 1]) specModel = tokens[++i];
    else if (tokens[i] === '--effort' && tokens[i + 1]) specEffort = tokens[++i];
    else die(`Unsupported launch-spec option: ${tokens[i]}; use provider id plus --model/--effort`);
  }
  let m = (model || specModel || '').trim() || null;
  let e = (effort || specEffort || '').trim() || null;
  for (const value of [id, m, e]) {
    if (value && !/^[a-zA-Z0-9_./:+-]+$/.test(value)) die(`Invalid launch token: ${value}`);
  }
  // Normalize to what the launch command will actually honor, so the canonical
  // spec written to AGENT_NOTES.md never claims a model/effort that was dropped.
  if (id === 'antigravity' || id === 'agy') {
    m = null;
    e = null;
  } else if ((id === 'cursor' || id === 'cursor-agent' || id === 'agent') && (!m || m === 'auto')) {
    e = null; // `auto` has no effort level
  }
  return { id, model: m, effort: e };
}

/** Canonical spec string for AGENT_NOTES.md (`claude --model opus --effort high`). */
function agentSpecString({ id, model, effort }) {
  const canonical =
    id === 'cursor-agent' || id === 'agent'
      ? 'cursor'
      : id === 'agy'
        ? 'antigravity'
        : id;
  let s = canonical;
  if (model) s += ` --model ${model}`;
  if (effort) s += ` --effort ${effort}`;
  return s;
}

function resolveAgentLaunchCommand(agent, model, effort) {
  const spec = parseAgentSpec(agent, model, effort);
  const { id } = spec;
  if (id === 'claude' || id === 'claude-agent-teams') {
    let cmd = id === 'claude-agent-teams' ? `${resolveOrcaBin()} claude-teams` : 'claude';
    if (spec.model) cmd += ` --model ${spec.model}`;
    if (spec.effort) cmd += ` --effort ${spec.effort}`;
    return `${cmd} --dangerously-skip-permissions`;
  }
  // `cursor` on PATH is the IDE. The TUI agent is `cursor-agent` (alias: `agent`).
  if (id === 'cursor' || id === 'cursor-agent' || id === 'agent') {
    if (!which('cursor-agent') && !which('agent')) {
      die(
        'Cursor Agent CLI not found (`cursor-agent` / `agent`). `cursor` is the IDE and will not be used.',
      );
    }
    const bin = which('cursor-agent') ? 'cursor-agent' : 'agent';
    // Default model auto: orchestrator / implementer default when the user did
    // not name a model. `auto` has no effort level, so --effort is dropped there.
    const m = spec.model || 'auto';
    let cmd = `${bin} --yolo --model ${m}`;
    if (spec.effort && m !== 'auto') cmd += ` --effort ${spec.effort}`;
    return cmd;
  }
  if (id === 'codex') {
    if (!which('codex')) die('`codex` CLI not found on PATH');
    let cmd = 'codex --dangerously-bypass-approvals-and-sandbox';
    if (spec.model) cmd += ` --model ${spec.model}`;
    if (spec.effort) cmd += ` -c model_reasoning_effort="${spec.effort}"`;
    return cmd;
  }
  if (id === 'antigravity' || id === 'agy') {
    if (!which('agy')) die('Antigravity CLI (`agy`) not found on PATH');
    if (model || effort || /--(model|effort)\b/.test(String(agent))) {
      console.error('new-cocos-game: note: antigravity ignores --model/--effort');
    }
    return 'agy --dangerously-skip-permissions';
  }
  if (id === 'gemini' || id === 'opencode') {
    if (spec.model || spec.effort) die(`${id}: model/effort mapping is not supported by this launcher; do not silently drop options`);
    if (!which(id)) die(`${id} CLI not found on PATH`);
    return id === 'gemini' ? 'gemini --yolo' : 'opencode';
  }
  die(`Unsupported agent id: ${id}; add an explicit launch mapping matching Orca settings before launching`);
}

function isCursorAgent(agentId) {
  const { id } = parseAgentSpec(agentId);
  return id === 'cursor' || id === 'cursor-agent' || id === 'agent';
}

/**
 * Does this agent load AGENTS.md by itself at launch (so the boot turn is redundant)?
 * cursor: reads AGENTS.md natively. codex: reads AGENTS.md natively.
 * claude: only via CLAUDE.md (the template ships one that imports AGENTS.md).
 * Everything else (antigravity, unknown): no → keep the boot turn.
 */
function agentLoadsRulesNatively(agentId, projectPath) {
  const { id } = parseAgentSpec(agentId);
  if (isCursorAgent(agentId) || id === 'codex') return true;
  if (id === 'claude' || id === 'claude-agent-teams') return fs.existsSync(path.join(projectPath, 'CLAUDE.md'));
  return false;
}

/** stdout is reserved for the final JSON when --json is set; every progress line goes to stderr. */
let JSON_MODE = false;
let FORCE_BOOT = null; // null = auto, true = --boot, false = --no-boot
function emitResult(obj) {
  const text = JSON.stringify(obj, null, 2);
  if (JSON_MODE) process.stdout.write(text + '\n');
  else console.log(text);
}

function waitForTuiIdle(orcaBin, handle, timeoutMs = 90000) {
  console.log(`→ orca terminal wait --for tui-idle (${timeoutMs}ms)`);
  return orcaJson(orcaBin, [
    'terminal',
    'wait',
    '--terminal',
    handle,
    '--for',
    'tui-idle',
    '--timeout-ms',
    String(timeoutMs),
  ]);
}

// Claude Code strips these on Enter and then waits for a second Enter, so a prompt carrying
// one is pasted but never submitted. Same set as orca-agent-fleet/scripts/clean_spec.py.
const INVISIBLE_CHARS = /[\u00ad\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;

function sendTerminalText(orcaBin, handle, text) {
  const clean = text.replace(INVISIBLE_CHARS, '');
  if (clean.length !== text.length) {
    console.error(
      `new-cocos-game: warning: stripped ${text.length - clean.length} invisible char(s) from the prompt`,
    );
  }
  console.log(`→ orca terminal send --terminal ${handle}`);
  return orcaJson(orcaBin, [
    'terminal',
    'send',
    '--terminal',
    handle,
    '--text',
    clean,
    '--enter',
  ]);
}

async function httpProbe(url, timeoutMs = 2000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const text = await res.text();
    return { ok: res.ok || res.status < 500, status: res.status, text };
  } catch (e) {
    return { ok: false, error: e.name === 'AbortError' ? 'timeout' : String(e.message || e) };
  } finally {
    clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Funplay MCP: per-checkout port pin + project-local MCP client configs
// ---------------------------------------------------------------------------

/** Funplay's own projectName = basename(Editor.Project.path). Same rule here. */
function funplayProjectName(projectPath) {
  return path.basename(path.resolve(projectPath));
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function readPinnedFunplayPort(projectPath) {
  const cfg = readJsonSafe(path.join(projectPath, FUNPLAY_CONFIG_FILE));
  const p = Number(cfg?.port);
  return Number.isInteger(p) && p > 0 ? p : null;
}

/** GET /health → { ok, name, projectName, projectIdentity } or null when nothing answers. */
async function probeFunplayHealth(port, timeoutMs = 1500) {
  const res = await httpProbe(`http://127.0.0.1:${port}/health`, timeoutMs);
  if (!res.text) return null;
  const parsed = readJsonSafeText(res.text);
  if (!parsed || parsed.ok !== true || typeof parsed.projectName !== 'string') {
    return null;
  }
  return {
    port: Number(port),
    name: parsed.name || '',
    version: parsed.version || '',
    projectName: parsed.projectName,
    projectIdentity: parsed.projectIdentity || '',
  };
}

function readJsonSafeText(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function scanFunplayServers(start = DEFAULT_MCP_PORT, end = MCP_PORT_RANGE_END) {
  const ports = [];
  for (let p = start; p <= end; p++) ports.push(p);
  const results = await Promise.all(ports.map((p) => probeFunplayHealth(p, 800)));
  return results.filter(Boolean);
}

/**
 * Ports already pinned by OTHER checkouts on this machine: sibling projects
 * under the games root plus every git worktree of this repo (main + children).
 */
function realpathSafe(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return path.resolve(p);
  }
}

function collectPinnedPortsElsewhere(projectPath) {
  const self = realpathSafe(projectPath);
  const dirs = new Set();
  if (fs.existsSync(GAMES_ROOT)) {
    for (const ent of fs.readdirSync(GAMES_ROOT, { withFileTypes: true })) {
      if (ent.isDirectory()) dirs.add(path.join(GAMES_ROOT, ent.name));
    }
  }
  const wt = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: self,
    encoding: 'utf8',
  });
  if (wt.status === 0) {
    for (const line of wt.stdout.split('\n')) {
      if (line.startsWith('worktree ')) dirs.add(path.resolve(line.slice(9).trim()));
    }
  }
  const pinned = new Map();
  for (const d of dirs) {
    if (realpathSafe(d) === self) continue;
    const p = readPinnedFunplayPort(d);
    if (p) pinned.set(p, d);
  }
  return pinned;
}

/**
 * Pick the port this checkout should own. Keeps an existing pin when it does not
 * collide with another checkout's pin or a live server of a different project.
 */
async function allocateFunplayPort(projectPath, preferred) {
  const name = funplayProjectName(projectPath);
  const pinnedElsewhere = collectPinnedPortsElsewhere(projectPath);
  const live = await scanFunplayServers();
  const liveByPort = new Map(live.map((s) => [s.port, s]));

  const isFree = (p) => {
    if (pinnedElsewhere.has(p)) return false;
    const srv = liveByPort.get(p);
    return !srv || srv.projectName === name;
  };

  // 1) a live server already serving THIS project wins (Creator already open)
  const mine = live.find((s) => s.projectName === name);
  if (mine) return { port: mine.port, reason: 'live-server-for-this-project' };

  // 2) explicit --port
  if (preferred) {
    const p = Number(preferred);
    if (!isFree(p)) {
      die(
        `port ${p} is taken by ${pinnedElsewhere.get(p) || liveByPort.get(p)?.projectName}`,
      );
    }
    return { port: p, reason: 'explicit' };
  }

  // 3) existing pin if still free
  const current = readPinnedFunplayPort(projectPath);
  if (current && isFree(current)) return { port: current, reason: 'existing-pin' };

  // 4) first free port in range
  for (let p = DEFAULT_MCP_PORT; p <= MCP_PORT_RANGE_END; p++) {
    if (isFree(p)) return { port: p, reason: 'first-free' };
  }
  die(`no free Funplay port in ${DEFAULT_MCP_PORT}..${MCP_PORT_RANGE_END}`);
}

function pickFunplayInheritable(cfg) {
  if (!cfg || typeof cfg !== 'object') return {};
  const out = {};
  for (const key of FUNPLAY_INHERIT_KEYS) {
    if (cfg[key] !== undefined) out[key] = cfg[key];
  }
  return out;
}

/** Main checkout to copy Funplay exposure settings from (never its port). */
function resolveFunplaySeedPath(projectPath) {
  const fromEnv = process.env.ORCA_ROOT_PATH;
  if (fromEnv) {
    const abs = path.resolve(fromEnv);
    if (fs.existsSync(path.join(abs, FUNPLAY_CONFIG_FILE))) return abs;
  }
  const wt = spawnSync('git', ['worktree', 'list', '--porcelain'], {
    cwd: projectPath,
    encoding: 'utf8',
  });
  if (wt.status === 0) {
    for (const line of wt.stdout.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      const main = path.resolve(line.slice(9).trim());
      if (fs.existsSync(path.join(main, FUNPLAY_CONFIG_FILE))) return main;
      break;
    }
  }
  return null;
}

function writeFunplayProjectConfig(projectPath, port) {
  const file = path.join(projectPath, FUNPLAY_CONFIG_FILE);
  const prev = readJsonSafe(file) || {};
  const seedPath = resolveFunplaySeedPath(projectPath);
  const seed = seedPath ? readJsonSafe(path.join(seedPath, FUNPLAY_CONFIG_FILE)) || {} : {};
  const inherited = pickFunplayInheritable(seed);
  const kept = pickFunplayInheritable(prev);
  const next = {
    ...inherited,
    ...kept,
    host: prev.host || inherited.host || seed.host || '127.0.0.1',
    port,
    autostart: prev.autostart !== false,
    toolProfile: prev.toolProfile || kept.toolProfile || inherited.toolProfile || 'full',
  };
  fs.writeFileSync(file, JSON.stringify(next, null, 2) + '\n');
  return file;
}

function writeCursorMcpJson(projectPath, url) {
  const dir = path.join(projectPath, '.cursor');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'mcp.json');
  const prev = readJsonSafe(file) || {};
  const servers = { ...(prev.mcpServers || {}) };
  servers[MCP_SERVER_KEY] = { ...(servers[MCP_SERVER_KEY] || {}), url };
  fs.writeFileSync(file, JSON.stringify({ ...prev, mcpServers: servers }, null, 2) + '\n');
  return file;
}

function writeClaudeMcpJson(projectPath, url) {
  const file = path.join(projectPath, '.mcp.json');
  const prev = readJsonSafe(file) || {};
  const servers = { ...(prev.mcpServers || {}) };
  servers[MCP_SERVER_KEY] = { ...(servers[MCP_SERVER_KEY] || {}), type: 'http', url };
  fs.writeFileSync(file, JSON.stringify({ ...prev, mcpServers: servers }, null, 2) + '\n');
  return file;
}

function writeCodexProjectToml(projectPath, url) {
  const dir = path.join(projectPath, '.codex');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'config.toml');
  const header = `[mcp_servers.${MCP_SERVER_KEY}]`;
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const idx = text.indexOf(header);
  if (idx === -1) {
    if (text.length && !text.endsWith('\n')) text += '\n';
    text += `${text.length ? '\n' : ''}${header}\nurl = "${url}"\n`;
  } else {
    // replace the url line inside this table (up to the next table header)
    const tableStart = idx + header.length;
    const rest = text.slice(tableStart);
    const nextTable = rest.search(/\n\[/);
    const tableBody = nextTable === -1 ? rest : rest.slice(0, nextTable);
    const urlLine = /^[ \t]*url[ \t]*=.*$/m;
    const newBody = urlLine.test(tableBody)
      ? tableBody.replace(urlLine, `url = "${url}"`)
      : `\nurl = "${url}"` + tableBody;
    text = text.slice(0, tableStart) + newBody + (nextTable === -1 ? '' : rest.slice(nextTable));
  }
  fs.writeFileSync(file, text);
  return file;
}

/** Pin the port and point every agent's project-scope MCP client at it. */
async function configureFunplayMcp(projectPath, preferredPort) {
  const abs = path.resolve(projectPath);
  const { port, reason } = await allocateFunplayPort(abs, preferredPort);
  const url = `http://127.0.0.1:${port}/`;
  const files = {
    funplay: writeFunplayProjectConfig(abs, port),
    cursor: writeCursorMcpJson(abs, url),
    claude: writeClaudeMcpJson(abs, url),
    codex: writeCodexProjectToml(abs, url),
  };
  const seedPath = resolveFunplaySeedPath(abs);
  console.log(`→ Funplay port for ${funplayProjectName(abs)}: ${port} (${reason})`);
  if (seedPath) {
    console.log(`   inherited Funplay settings from ${seedPath}`);
  }
  return {
    projectPath: abs,
    projectName: funplayProjectName(abs),
    port,
    url,
    reason,
    seedPath,
    files,
  };
}

/**
 * Gate: ok only when /health on this checkout's port reports THIS projectName.
 * A different project answering on the port (another Creator got there first
 * and Funplay fell back to port+1) is a mismatch, not a success. If the right
 * project is found on another port, the client configs are re-pointed to it.
 * settings/mcp-server.json port 3000 is a different/legacy panel — never the gate.
 */
async function waitForFunplayMcp({
  projectPath,
  port,
  timeoutMs = 180000,
  intervalMs = 3000,
}) {
  const abs = path.resolve(projectPath);
  const expected = funplayProjectName(abs);
  let expectedPort = Number(port || readPinnedFunplayPort(abs) || DEFAULT_MCP_PORT);
  const started = Date.now();
  let attempt = 0;
  let lastError = null;
  let seenOther = null;

  console.log(
    `→ waiting for Funplay MCP "${expected}" on http://127.0.0.1:${expectedPort}/ (timeout ${timeoutMs}ms)`,
  );
  console.log('   If it stays down: in Cocos Creator open Funplay → MCP Server → Start');

  const finish = async (srv, repointed) => {
    const tools = await httpProbe(`http://127.0.0.1:${srv.port}/tools`);
    const toolCount = readJsonSafeText(tools.text || '')?.count ?? null;
    return {
      ok: true,
      url: `http://127.0.0.1:${srv.port}`,
      port: srv.port,
      expectedPort,
      repointed,
      projectName: srv.projectName,
      projectIdentity: srv.projectIdentity,
      version: srv.version,
      attempts: attempt,
      elapsedMs: Date.now() - started,
      toolCount,
    };
  };

  while (Date.now() - started < timeoutMs) {
    attempt += 1;
    const h = await probeFunplayHealth(expectedPort);
    if (h && h.projectName === expected) return finish(h, false);

    if (h) {
      seenOther = h;
      // wrong project on our port → look for ours elsewhere and re-point configs
      const live = await scanFunplayServers();
      const mine = live.find((s) => s.projectName === expected);
      if (mine) {
        console.log(
          `   port ${expectedPort} is serving "${h.projectName}"; "${expected}" found on ${mine.port} — re-pointing MCP configs`,
        );
        await configureFunplayMcp(abs, mine.port);
        expectedPort = mine.port;
        return finish(mine, true);
      }
      lastError = `port ${expectedPort} serves "${h.projectName}", not "${expected}"`;
    } else {
      lastError = 'no Funplay /health answer';
    }
    if (attempt === 1 || attempt % 5 === 0) {
      console.log(`   … still waiting (attempt ${attempt}, last: ${lastError})`);
    }
    spawnSync('sleep', [String(intervalMs / 1000)], { stdio: 'ignore' });
  }

  return {
    ok: false,
    url: `http://127.0.0.1:${expectedPort}`,
    port: expectedPort,
    projectName: expected,
    attempts: attempt,
    elapsedMs: Date.now() - started,
    error: lastError || 'timeout',
    otherProjectOnPort: seenOther,
    hint: seenOther
      ? `Port ${expectedPort} belongs to "${seenOther.projectName}". Close that Creator or re-run mcp-config to pin a different port, then wait-mcp.`
      : 'Open Cocos Creator → Funplay → MCP Server → Start, then re-run wait-mcp',
  };
}

function copyTemplate(destPath) {
  if (!fs.existsSync(TEMPLATE_ROOT)) {
    die(`template missing: ${TEMPLATE_ROOT}`);
  }
  if (!which('rsync')) die('`rsync` not found on PATH');
  const cc4 = isCc4Template();
  const looksTemplate =
    fs.existsSync(path.join(TEMPLATE_ROOT, 'assets')) &&
    fs.existsSync(path.join(TEMPLATE_ROOT, 'package.json')) &&
    (cc4 || fs.existsSync(path.join(TEMPLATE_ROOT, 'extensions')));
  if (!looksTemplate) {
    die(`template does not look like a Cocos project: ${TEMPLATE_ROOT}`);
  }

  fs.mkdirSync(path.dirname(destPath), { recursive: true });
  const args = ['-a', '--delete'];
  for (const ex of RSYNC_EXCLUDES) {
    args.push('--exclude', ex);
  }
  // trailing slash: copy contents into dest
  args.push(TEMPLATE_ROOT + '/', destPath + '/');
  console.log(`→ rsync template → ${destPath}`);
  const r = spawnSync('rsync', args, { encoding: 'utf8', stdio: 'inherit' });
  if (r.status !== 0) die(`rsync failed (exit ${r.status})`);

  // Safety: never inherit template history even if exclude missed.
  const leakedGit = path.join(destPath, '.git');
  if (fs.existsSync(leakedGit)) {
    console.log('→ removing copied .git (fresh repo required)');
    fs.rmSync(leakedGit, { recursive: true, force: true });
  }
}

function readPinnedCocosCliPorts(projectPath) {
  const cfg = readJsonSafe(path.join(projectPath, COCOS_CLI_CONFIG_FILE));
  if (!cfg) return null;
  const mcp = Number(cfg.mcp_port ?? cfg.port);
  const preview = Number(cfg.preview_port);
  return {
    mcp_port: Number.isInteger(mcp) && mcp > 0 ? mcp : null,
    preview_port: Number.isInteger(preview) && preview > 0 ? preview : null,
  };
}

/**
 * Pin MCP + preview ports for a cc4 checkout via the project's resolve-ports.mjs
 * (same multi-project model as Funplay: no shared 9527/7456).
 */
function writeCocosCliMcpConfig(projectPath, preferredMcpPort) {
  const abs = path.resolve(projectPath);
  const resolveScript = path.join(abs, 'scripts', 'resolve-ports.mjs');
  if (!fs.existsSync(resolveScript)) {
    // Legacy checkout without resolve-ports: fall back to fixed 9527 configs.
    const url = `http://127.0.0.1:${COCOS_CLI_MCP_PORT}/mcp`;
    const cursorDir = path.join(abs, '.cursor');
    fs.mkdirSync(cursorDir, { recursive: true });
    const cursorMcp = path.join(cursorDir, 'mcp.json');
    fs.writeFileSync(
      cursorMcp,
      JSON.stringify({ mcpServers: { 'cocos-cli': { url } } }, null, 2) + '\n',
    );
    const rootMcp = path.join(abs, '.mcp.json');
    fs.writeFileSync(
      rootMcp,
      JSON.stringify({ mcpServers: { 'cocos-cli': { url } } }, null, 2) + '\n',
    );
    return {
      engine: 'cocos-cli',
      port: COCOS_CLI_MCP_PORT,
      mcp_port: COCOS_CLI_MCP_PORT,
      preview_port: 7456,
      url,
      files: { cursorMcp, rootMcp },
      legacy: true,
    };
  }
  const args = [resolveScript, '--path', abs];
  if (preferredMcpPort) {
    args.push('--mcp-port', String(preferredMcpPort));
  }
  const r = spawnSync(process.execPath, args, {
    cwd: abs,
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    die(`resolve-ports failed: ${r.stderr || r.stdout || `exit ${r.status}`}`);
  }
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout || '{}');
  } catch {
    die(`resolve-ports returned non-JSON: ${(r.stdout || '').slice(0, 200)}`);
  }
  if (!parsed?.ok) {
    die(`resolve-ports failed: ${parsed?.error || r.stdout}`);
  }
  console.log(
    `→ COCOS CLI ports for ${parsed.projectName}: MCP ${parsed.mcp_port}, preview ${parsed.preview_port} (${parsed.reason?.mcp || 'ok'})`,
  );
  return {
    engine: 'cocos-cli',
    port: parsed.mcp_port,
    mcp_port: parsed.mcp_port,
    preview_port: parsed.preview_port,
    url: parsed.url,
    reason: parsed.reason,
    files: parsed.files,
  };
}

function openCocosCliMcp(projectPath) {
  const script = path.join(projectPath, 'scripts', 'open-mcp.sh');
  if (!fs.existsSync(script)) {
    die(`cc4 open-mcp missing: ${script}`);
  }
  if (!which('cocos')) {
    die("`cocos` CLI not on PATH (need cocos-creator COCOS 4 CLI)");
  }
  const pinned = readPinnedCocosCliPorts(projectPath);
  const port = pinned?.mcp_port || COCOS_CLI_MCP_PORT;
  console.log(`→ start COCOS CLI MCP via scripts/open-mcp.sh (port ${port})`);
  fs.chmodSync(script, 0o755);
  // Do not force COCOS_MCP_PORT — let open-mcp.sh read/allocate the pin so
  // collisions re-pin instead of failing against a hard-coded 9527.
  const r = spawnSync('bash', [script], {
    cwd: projectPath,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env },
  });
  if (r.status !== 0) {
    die(`open-mcp.sh failed (exit ${r.status})`);
  }
  const after = readPinnedCocosCliPorts(projectPath);
  return { opened: true, port: after?.mcp_port || port };
}

async function waitForCocosCliMcp({
  projectPath,
  port,
  timeoutMs = 180000,
}) {
  const pinned = readPinnedCocosCliPorts(projectPath);
  const mcpPort = Number(port || pinned?.mcp_port || COCOS_CLI_MCP_PORT);
  const url = `http://127.0.0.1:${mcpPort}/mcp`;
  const started = Date.now();
  let attempt = 0;
  let lastError = null;
  console.log(`→ waiting for COCOS CLI MCP at ${url}`);
  console.log('   If it stays down: from project root run ./scripts/open-mcp.sh');

  while (Date.now() - started < timeoutMs) {
    attempt++;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2024-11-05',
            capabilities: {},
            clientInfo: { name: 'new-cocos-game', version: '1.0.0' },
          },
        }),
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        return {
          ok: true,
          engine: 'cocos-cli',
          url,
          port: mcpPort,
          projectPath: path.resolve(projectPath),
          projectName: path.basename(projectPath),
          attempts: attempt,
          elapsedMs: Date.now() - started,
          status: res.status,
          sessionId: res.headers.get('mcp-session-id') || res.headers.get('Mcp-Session-Id'),
        };
      }
      lastError = `HTTP ${res.status}`;
    } catch (e) {
      lastError = String((e && e.message) || e);
    }
    await new Promise((r) => setTimeout(r, 1500));
  }

  return {
    ok: false,
    engine: 'cocos-cli',
    url,
    port: mcpPort,
    projectName: path.basename(projectPath),
    attempts: attempt,
    elapsedMs: Date.now() - started,
    error: lastError || 'timeout',
    hint: 'From project root: ./scripts/open-mcp.sh then re-run wait-mcp',
  };
}

/**
 * Always bind the agent to the new project worktree.
 * Required for implement=yes and especially mode=fleet (cocos-orca-fleet
 * orchestrator must live in the new project — never the bootstrap chat).
 */
async function createAgentSession({ projectPath, agent, model, effort, title, prompt }) {
  const orcaBin = resolveOrcaBin();
  ensureOrcaReady(orcaBin);
  const worktree = `path:${projectPath}`;
  const agentId = agent || DEFAULT_AGENT;
  const agentSpec = parseAgentSpec(agentId, model, effort);
  const agentCmd = resolveAgentLaunchCommand(agentId, model, effort);
  const tabTitle = title || `implement-${path.basename(projectPath)}`;

  console.log('→ pre-trust Cursor + Claude + Codex workspace (skip trust dialog)');
  const agentTrust = ensureAgentWorkspacesTrusted(projectPath);

  // Agents must find the editor through project-local MCP configs.
  let mcpConfig = null;
  if (isCc4Project(projectPath)) {
    // Always (re)pin so worktrees get a free port even when mcp.json already exists.
    mcpConfig = writeCocosCliMcpConfig(projectPath);
  } else if (!readPinnedFunplayPort(projectPath)) {
    mcpConfig = await configureFunplayMcp(projectPath);
  }

  console.log(`→ orca terminal create --worktree ${worktree} --command ${agentCmd}`);
  const created = orcaJson(orcaBin, [
    'terminal',
    'create',
    '--worktree',
    worktree,
    '--title',
    tabTitle,
    '--command',
    agentCmd,
    '--focus',
  ]);
  if (created.status !== 0 || created.parsed?.ok === false) {
    die(
      `orca terminal create failed: ${created.stderr || created.stdout || JSON.stringify(created.parsed)}`,
    );
  }

  const handle =
    created.parsed?.result?.handle ||
    created.parsed?.result?.terminal?.handle ||
    created.parsed?.result?.agentTerminalHandle ||
    created.parsed?.result?.startupTerminal?.handle ||
    null;

  let sendResult = null;
  let bootSend = null;
  let waited = null;
  let bootWaited = null;
  // Boot turn only for agents that cannot load AGENTS.md themselves (claude without CLAUDE.md,
  // antigravity). --no-boot forces it off; --boot forces it on.
  const needsBoot = FORCE_BOOT === true
    ? true
    : FORCE_BOOT === false
      ? false
      : !agentLoadsRulesNatively(agentId, projectPath);
  const toSend = [];
  if (needsBoot) toSend.push({ kind: 'boot', text: NON_CURSOR_BOOT_PROMPT });
  if (prompt) toSend.push({ kind: 'task', text: prompt });

  {
    if (!handle) {
      console.error(
        'new-cocos-game: warning: no terminal handle; prompt not sent. Paste it manually.',
      );
    } else {
      waited = waitForTuiIdle(orcaBin, handle, 90000);
      if (waited.status !== 0 || waited.parsed?.ok === false) {
        console.error(
          'new-cocos-game: warning: tui-idle wait failed — NOT sending prompt (possible shell/trust dialog).',
        );
        console.error(waited.stderr || waited.stdout || JSON.stringify(waited.parsed));
      } else {
        for (const item of toSend) {
          if (item.kind === 'boot') {
            console.log('→ boot non-cursor implement agent (AGENTS.md startup prompt)');
          }
          const sent = sendTerminalText(orcaBin, handle, item.text);
          if (sent.status !== 0 || sent.parsed?.ok === false) {
            console.error(
              `new-cocos-game: warning: terminal send (${item.kind}) failed: ${sent.stderr || sent.stdout}`,
            );
            break;
          }
          if (item.kind === 'boot') {
            bootSend = sent.parsed?.result ?? sent.parsed;
            if (toSend.some((x) => x.kind === 'task')) {
              bootWaited = waitForTuiIdle(orcaBin, handle, 90000);
              if (bootWaited.status !== 0 || bootWaited.parsed?.ok === false) {
                console.error(
                  'new-cocos-game: warning: boot tui-idle wait failed — NOT sending task prompt.',
                );
                console.error(
                  bootWaited.stderr ||
                    bootWaited.stdout ||
                    JSON.stringify(bootWaited.parsed),
                );
                break;
              }
            }
          } else {
            sendResult = sent.parsed?.result ?? sent.parsed;
          }
        }
      }
    }
  }

  return {
    ready: Boolean(handle && waited?.status === 0 && waited.parsed?.ok === true && (!needsBoot || bootSend)),
    worktree,
    agent: agentSpec.id,
    model: agentSpec.model,
    effort: agentSpec.effort,
    // Canonical launch spec — write this into AGENT_NOTES.md fleet.orchestrator_agent.
    agentSpec: agentSpecString(agentSpec),
    command: agentCmd,
    title: tabTitle,
    handle,
    mcpPort: isCc4Project(projectPath)
      ? readPinnedCocosCliPorts(projectPath)?.mcp_port || COCOS_CLI_MCP_PORT
      : readPinnedFunplayPort(projectPath),
    mcpConfig,
    claudeTrust: agentTrust.claude,
    cursorTrust: agentTrust.cursor,
    codexTrust: agentTrust.codex,
    create: created.parsed?.result ?? created.parsed,
    wait: waited?.parsed?.result ?? waited?.parsed ?? null,
    bootWait: bootWaited?.parsed?.result ?? bootWaited?.parsed ?? null,
    boot: bootSend,
    send: sendResult,
    bootPromptSent: Boolean(needsBoot && handle && bootSend),
    promptSent: Boolean(prompt && handle && sendResult),
  };
}

function cmdResolve(values) {
  const slug = normalizeSlug(values.name);
  const projectPath = path.join(GAMES_ROOT, slug);
  const templateVersion = readTemplateCreatorVersion();
  const cc4 = isCc4Template();
  const out = {
    slug,
    projectPath,
    exists: fs.existsSync(projectPath),
    templateRoot: TEMPLATE_ROOT,
    templateFolder: templateFolderName(),
    templateCreatorVersion: templateVersion,
    engine: cc4 ? 'cocos-cli' : 'funplay',
    gamesRoot: GAMES_ROOT,
    defaultAgent: DEFAULT_AGENT,
    mcpPort: cc4 ? COCOS_CLI_MCP_PORT : DEFAULT_MCP_PORT,
    mcpPortRange: cc4 ? '9527-9559' : `${DEFAULT_MCP_PORT}-${MCP_PORT_RANGE_END}`,
    previewPortRange: cc4 ? '7456-7489' : undefined,
  };
  if (cc4) {
    out.cliVersion = readCocosCliVersion();
    out.version = templateVersion;
    out.creatorBinary = null;
  } else {
    const creator = resolveCreator(templateVersion);
    out.version = creator.version;
    out.creatorBinary = creator.binary;
  }
  emitResult(out);
  if (out.exists) process.exit(2);
}

async function cmdCreate(values, flags) {
  const slug = normalizeSlug(values.name);
  const projectPath = path.join(GAMES_ROOT, slug);
  const templateVersion = readTemplateCreatorVersion();
  const cc4 = isCc4Template();
  const skipOrca = flags.has('no-orca');
  const skipWaitMcp = flags.has('no-wait-mcp');
  const open = flags.has('open') || !flags.has('no-open');
  const creator = cc4 ? null : resolveCreator(templateVersion);
  const cliVersion = cc4 ? readCocosCliVersion() : null;

  if (fs.existsSync(projectPath)) {
    die(`target already exists: ${projectPath}`, 2);
  }
  if (!fs.existsSync(GAMES_ROOT)) {
    die(`games root missing: ${GAMES_ROOT}`);
  }
  if (cc4 && !which('cocos')) {
    die("`cocos` CLI not on PATH (need cocos-creator COCOS 4 CLI)");
  }

  console.log(`→ creating ${projectPath} from template`);
  console.log(`→ template ${TEMPLATE_ROOT}`);
  if (cc4) {
    console.log(`→ engine COCOS 4 CLI (${cliVersion || 'version unknown'}, project ${templateVersion})`);
  } else {
    console.log(`→ Creator ${creator.version} (${creator.binary})`);
  }

  copyTemplate(projectPath);
  setPackageName(projectPath, slug);
  console.log(`→ package.json name = ${slug}`);

  const looksCocos =
    fs.existsSync(path.join(projectPath, 'assets')) &&
    (fs.existsSync(path.join(projectPath, 'package.json')) ||
      fs.existsSync(path.join(projectPath, 'settings')));
  if (!looksCocos) {
    die('copy finished but project does not look like a Cocos project');
  }

  console.log('→ git init');
  execFileSync('git', ['init'], { cwd: projectPath, stdio: 'inherit' });
  try {
    execFileSync('git', ['branch', '-M', 'main'], {
      cwd: projectPath,
      stdio: 'pipe',
    });
  } catch {
    /* ignore */
  }

  console.log('→ pre-trust Cursor + Claude + Codex workspace');
  const agentTrust = ensureAgentWorkspacesTrusted(projectPath);

  let mcpConfig = null;
  if (cc4) {
    mcpConfig = writeCocosCliMcpConfig(projectPath, values.port);
    console.log(`→ COCOS CLI MCP configs → ${mcpConfig.url}`);
  } else {
    // Pin Funplay port BEFORE Creator opens so the plugin binds it
    // directly (no fallback), and agents get project-local MCP client configs.
    mcpConfig = await configureFunplayMcp(projectPath, values.port);
  }

  let orcaRepo = null;
  if (!skipOrca) {
    orcaRepo = addToOrca(projectPath);
  } else {
    console.log('→ skip Orca registration (--no-orca)');
  }

  let opened = false;
  if (open) {
    if (cc4) {
      openCocosCliMcp(projectPath);
      opened = true;
    } else {
      console.log('→ open Cocos Creator (--nologin)');
      openEditor(creator.binary, projectPath);
      opened = true;
    }
  }

  let mcp = null;
  if (opened && !skipWaitMcp) {
    if (cc4) {
      mcp = await waitForCocosCliMcp({
        projectPath,
        port: mcpConfig.mcp_port || mcpConfig.port,
        timeoutMs: Number(values['timeout-ms'] || 180000),
      });
      if (!mcp.ok) {
        console.error(JSON.stringify({ ok: false, projectPath, mcp }, null, 2));
        die(
          `COCOS CLI MCP not reachable on port ${mcp.port}. ${mcp.hint} Then: node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs wait-mcp --path ${projectPath}`,
          3,
        );
      }
      console.log(
        `→ COCOS CLI MCP ready (${mcp.url}, project=${mcp.projectName}, status=${mcp.status})`,
      );
    } else {
      mcp = await waitForFunplayMcp({
        projectPath,
        port: mcpConfig.port,
        timeoutMs: Number(values['timeout-ms'] || 180000),
      });
      if (!mcp.ok) {
        console.error(JSON.stringify({ ok: false, projectPath, mcp }, null, 2));
        die(
          `Funplay MCP for "${mcp.projectName}" not reachable on port ${mcp.port}. ${mcp.hint} Then: node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs wait-mcp --path ${projectPath}`,
          3,
        );
      }
      console.log(
        `→ Funplay MCP ready (${mcp.url}, project=${mcp.projectName}, tools=${mcp.toolCount ?? '?'})`,
      );
    }
  }

  const result = {
    ok: true,
    slug,
    projectPath,
    templateRoot: TEMPLATE_ROOT,
    templateFolder: templateFolderName(),
    engine: cc4 ? 'cocos-cli' : 'funplay',
    version: cc4 ? templateVersion : creator.version,
    cliVersion: cc4 ? cliVersion : undefined,
    creatorBinary: cc4 ? null : creator.binary,
    opened,
    orcaRegistered: !skipOrca,
    orcaRepo,
    claudeTrust: agentTrust.claude,
    cursorTrust: agentTrust.cursor,
    codexTrust: agentTrust.codex,
    mcpConfig,
    mcp,
    next: [
      'git add -A && git commit (initial bootstrap)',
      'if brief_author=fable → ~/.agents/skills/game-brief (idea|media) writes root contracts first',
      'run /setup-project with the brief (auto defaults unless special asks)',
      'if implement=yes → agent-session --path <project> (producer-<slug> | single | fleet-<slug>)',
      'if mode=producer (default with fable) → game-producer runs MILESTONES.md slices per AGENT_NOTES release.goal (end_to_end | playable)',
      'if mode=fleet → orchestrator prompt uses cocos-orca-fleet; worktree MUST be this project',
    ],
  };
  emitResult(result);
}

function cmdOrcaAdd(values) {
  const projectPath = resolveProjectPath(values);
  const orcaRepo = addToOrca(projectPath);
  emitResult({ ok: true, projectPath, orcaRepo });
}

function cmdTrust(values) {
  const projectPath = resolveProjectPath(values);
  const trust = ensureAgentWorkspacesTrusted(projectPath);
  emitResult({ ok: true, projectPath, trust });
}

/** Print the Creator binary for a checkout (package.json creator.version, else newest). Used by scripts/*.sh. */
function cmdCreator(values) {
  const projectPath = values.path ? path.resolve(values.path) : null;
  let wanted = null;
  if (projectPath) {
    const pkg = readJsonSafe(path.join(projectPath, 'package.json'));
    wanted = pkg?.creator?.version || null;
  }
  const installed = listInstalledCreators();
  const hit = (wanted && installed.find((c) => c.version === wanted)) || installed[0];
  if (!hit) die('no Cocos Creator install found');
  if (wanted && hit.version !== wanted) {
    console.error(`new-cocos-game: warning: Creator ${wanted} not installed, using ${hit.version}`);
  }
  console.log(hit.binary);
}

async function cmdMcpConfig(values) {
  const projectPath = resolveProjectPath(values);
  if (isCc4Project(projectPath)) {
    const result = writeCocosCliMcpConfig(projectPath, values.port);
    emitResult({ ok: true, ...result, projectPath });
    return;
  }
  const result = await configureFunplayMcp(projectPath, values.port);
  emitResult({ ok: true, ...result });
}

async function cmdWaitMcp(values) {
  const projectPath = resolveProjectPath(values);
  if (isCc4Project(projectPath)) {
    if (!readPinnedCocosCliPorts(projectPath)?.mcp_port && !values.port) {
      writeCocosCliMcpConfig(projectPath);
    }
    const mcp = await waitForCocosCliMcp({
      projectPath,
      port: values.port ? Number(values.port) : undefined,
      timeoutMs: Number(values['timeout-ms'] || 180000),
    });
    emitResult({ ok: mcp.ok, projectPath, mcp });
    if (!mcp.ok) process.exit(3);
    return;
  }
  if (!readPinnedFunplayPort(projectPath) && !values.port) {
    // legacy checkout without a pin: pin now so the gate has a real target
    await configureFunplayMcp(projectPath);
  }
  const mcp = await waitForFunplayMcp({
    projectPath,
    port: values.port ? Number(values.port) : undefined,
    timeoutMs: Number(values['timeout-ms'] || 180000),
  });
  emitResult({ ok: mcp.ok, projectPath, mcp });
  if (!mcp.ok) process.exit(3);
}

async function cmdAgentSession(values) {
  const projectPath = resolveProjectPath(values);
  const agentId = values.agent || DEFAULT_AGENT;
  if (!values.prompt && isCursorAgent(agentId)) {
    die('agent-session requires --prompt "..." (optional only for non-cursor boot)');
  }
  const session = await createAgentSession({
    projectPath,
    agent: agentId,
    model: values.model,
    effort: values.effort,
    title: values.title,
    prompt: values.prompt,
  });
  const ok = Boolean(session.ready && (!values.prompt || session.promptSent));
  emitResult({ ok, projectPath, session });
  if (!ok) process.exitCode = 1;
}

/** Dry preview: what `agent-session` would launch for --agent/--model/--effort. */
function cmdAgentCmd(values) {
  const agentId = values.agent || DEFAULT_AGENT;
  const spec = parseAgentSpec(agentId, values.model, values.effort);
  const projectPath = values.path ? path.resolve(values.path) : process.cwd();
  emitResult({
    ok: true,
    agent: spec.id,
    model: spec.model,
    effort: spec.effort,
    agentSpec: agentSpecString(spec),
    command: resolveAgentLaunchCommand(agentId, values.model, values.effort),
    needsBoot:
      FORCE_BOOT === null ? !agentLoadsRulesNatively(agentId, projectPath) : FORCE_BOOT,
  });
}

const { cmd, values, flags } = parseArgs(process.argv.slice(2));
TEMPLATE_ROOT = resolveTemplateRoot(values.template);

async function main() {
  if (flags.has('json')) {
    // Reserve stdout for the final JSON object; route every progress line to stderr so
    // `bootstrap.mjs agent-session --json > out.json` is always parseable.
    JSON_MODE = true;
    console.log = (...args) => console.error(...args);
  }
  if (flags.has('boot')) FORCE_BOOT = true;
  if (flags.has('no-boot')) FORCE_BOOT = false;
  if (cmd === 'resolve') cmdResolve(values);
  else if (cmd === 'create') await cmdCreate(values, flags);
  else if (cmd === 'orca-add') cmdOrcaAdd(values);
  else if (cmd === 'trust' || cmd === 'claude-trust') cmdTrust(values);
  else if (cmd === 'creator') cmdCreator(values);
  else if (cmd === 'mcp-config') await cmdMcpConfig(values);
  else if (cmd === 'wait-mcp') await cmdWaitMcp(values);
  else if (cmd === 'agent-session') await cmdAgentSession(values);
  else if (cmd === 'agent-cmd') cmdAgentCmd(values);
  else {
    die(
      'usage: bootstrap.mjs <resolve|create|orca-add|trust|creator|mcp-config|wait-mcp|agent-session|agent-cmd> [options]\n' +
        '  creator: [--path <abs>] → print Creator binary matching package.json creator.version\n' +
        '  create: --name <slug> [--template game|playable|cc4|<cc-*-template>|<abs>] [--open|--no-open] [--no-orca] [--no-wait-mcp] [--port N] [--timeout-ms N]\n' +
        '    --template default: cc-game-template; "playable" → cc-playable-template; "cc4" → cc4-game-template\n' +
        '  orca-add / trust / claude-trust / mcp-config / wait-mcp: --name <slug> | --path <abs>\n' +
        '  mcp-config: Funplay pin (3.8) or cocos-cli pin+mcp.json (cc4; MCP 9527..9559, preview 7456..7489)\n' +
        '  wait-mcp: Funplay /health projectName gate (3.8) or cocos-cli initialize on pinned port (cc4)\n' +
        '  agent-session: --path <abs> [--prompt "..."] [--agent cursor|claude|claude-agent-teams|codex|gemini|opencode|antigravity|"<spec>"] [--model m] [--effort e] [--title name]\n' +
        '    --agent also accepts an AGENT_NOTES.md launch spec ("claude --model opus --effort high"); explicit --model/--effort win\n' +
        '    cursor → cursor-agent --yolo --model <m|auto> [--effort e] (default when user names no agent; requires --prompt)\n' +
        '    boot only when rules are not loaded natively; --boot/--no-boot override\n' +
        '    claude → claude [--model m] [--effort e] --dangerously-skip-permissions\n' +
        '    codex → codex --dangerously-bypass-approvals-and-sandbox [--model m] [-c model_reasoning_effort=e]\n' +
        '    antigravity → agy --dangerously-skip-permissions (model/effort ignored)\n' +
        '  agent-cmd: [--agent ...] [--model m] [--effort e] → print the launch command + canonical agentSpec, no side effects',
    );
  }
}

main().catch((e) => {
  die(e?.stack || String(e));
});
