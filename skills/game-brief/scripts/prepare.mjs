// One-command launch preparation: dependencies, docs copies, source index, progress run and the
// filled author prompt. Fails closed on any unfilled <PLACEHOLDER> so a literal never reaches the author.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const SKILL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
if (!fs.existsSync(path.join(SKILL, 'node_modules/yaml/package.json'))) {
  execFileSync('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: SKILL, stdio: 'ignore' });
}
const { args, project, local, exists, read, json, notes, run } = await import('./lib.mjs');
const { indexSource } = await import('./index-source.mjs');
const { scaffold } = await import('./scaffold-contracts.mjs');
const { update } = await import('./brief-progress.mjs');
const { analysisPathFor, validateRipPort } = await import('../../rip-port-analysis/scripts/validate-rip-port.mjs');

// main = first ```text fence; `<X_BLOCK>` headings and `### store|media|idea` name the other fences.
export function promptBlocks(text) {
  const blocks = {};
  let heading = '', fence = null;
  for (const line of text.split('\n')) {
    if (fence) {
      if (line.startsWith('```')) { blocks[fence.key] ??= fence.lines.join('\n'); fence = null; }
      else fence.lines.push(line);
    } else if (/^#{2,3} /.test(line)) heading = line;
    else if (line.startsWith('```text')) {
      const named = heading.match(/<([A-Z_]+_BLOCK)>/)?.[1];
      const mode = heading.match(/^### (store|media|idea)\b/)?.[1];
      fence = { key: !Object.keys(blocks).length ? 'main' : mode ? `SOURCE_BLOCK:${mode}` : named || heading, lines: [] };
    }
  }
  return blocks;
}

export function fill(template, blocks, values) {
  const lines = [];
  for (const line of template.split('\n')) {
    const block = line.trim().match(/^<([A-Z_]+_BLOCK)>$/)?.[1];
    if (!block) lines.push(line);
    else if (blocks[block] != null) lines.push(blocks[block]);   // absent block → drop its line
  }
  const text = lines.join('\n').replace(/<([A-Z][A-Z_]+)>/g, (m, k) => values[k] ?? m);
  const left = [...new Set(text.match(/<[A-Z][A-Z_]+>/g) || [])];
  if (left.length) throw Error(`Unfilled prompt placeholders: ${left.join(', ')}`);
  return text;
}

function engineLine(b = {}) {
  if (b.engine_version) return `COCOS 4 CLI ${b.engine_version}`;
  if (b.creator_version) return `Creator ${b.creator_version}`;
  throw Error('AGENT_NOTES bootstrap: needs creator_version (3.8) or engine_version (cc4)');
}

export function prepare(p, a = {}) {
  const n = notes(p), brief = n.brief || {}, dry = !!a['dry-run'], warnings = [];
  const ref = (brief.reference_path || n.store_clone?.reference_path || '').replace(/\/$/, '');
  const slug = a.slug || n.store_clone?.slug || path.basename(ref || p).replace(/^cc4?-/, '');
  const index = indexSource(p, { ...a, slug }).index;   // also enforces the rip-port gate
  const existing = exists(local(p, 'MILESTONES.md'));
  if (existing) warnings.push('existing_contracts: amendment flow (gameplay-notes.md late notes) overrides the initial full-authoring task; scaffold skipped');

  const port = analysisPathFor(p, n);
  const portCheck = port !== null ? validateRipPort(p, port, { expectedSources: n.rip_port?.sources }) : null;
  const copies = [
    ['reference/slice-schema.md', 'docs/slice-schema.md'],
    ['reference/bounded-authoring.md', 'docs/brief-workflow.md'],
    ...(index.gameplayNotesPath ? [['reference/gameplay-notes.md', 'docs/gameplay-notes-contract.md']] : []),
    ...(port !== null ? [['../rip-port-analysis/references/port-contract.md', 'docs/rip-port-contract.md']] : []),
  ];
  if (!dry) for (const [from, to] of copies) {
    fs.mkdirSync(path.dirname(local(p, to)), { recursive: true });
    fs.copyFileSync(path.join(SKILL, from), local(p, to));
  }
  const scaffolded = a.scaffold && !existing && !dry ? scaffold(p, a) : null;

  let runId = 'DRY_RUN', resumed = false;
  if (!dry) {
    const marker = local(p, 'docs/brief-progress.json');
    const current = exists(marker) ? json(marker) : null;
    if (current && current.phase !== 'done') { runId = current.runId; resumed = true; }
    else runId = update(p, { init: true }).progress.runId;
    if (!resumed || current.phase === 'intake') update(p, { 'run-id': runId, phase: 'indexed' });
  }

  const [, orientation = 'portrait', res = '720x1280'] = String(index.orientation).match(/(portrait|landscape)\s+(\d+\s*[x×]\s*\d+)/i) || [];
  const manifest = ref && exists(local(p, `${ref}/manifest.json`)) ? json(local(p, `${ref}/manifest.json`)) : {};
  const rip = index.ripPath;
  const all = promptBlocks(read(path.join(SKILL, 'reference/brief-prompt.md')));
  const blocks = {
    SOURCE_BLOCK: all[`SOURCE_BLOCK:${index.source}`],
    RIP_BLOCK: rip && exists(local(p, `${rip}/RIP_PACK.json`)) ? all.RIP_BLOCK : null,
    RIP_PORT_BLOCK: portCheck ? all.RIP_PORT_BLOCK : null,
    GAMEPLAY_NOTES_BLOCK: index.gameplayNotesPath ? all.GAMEPLAY_NOTES_BLOCK : null,
  };
  const values = {
    PROJECT: p, SLUG: slug, ORIENTATION: orientation.toLowerCase(), DESIGN_RES: res.replace(/\s/g, '').replace('×', 'x'),
    ENGINE_LINE: engineLine(n.bootstrap), RELEASE_GOAL: index.releaseGoal, CONTRACT_DEPTH: index.contractDepth,
    BRIEF_TOOLS: path.join(SKILL, 'scripts'), BRIEF_RUN_ID: runId,
    PROGRESS: `node ${path.join(SKILL, 'scripts/brief-progress.mjs')} --project ${p} --run-id ${runId}`,
    STORE_URL: n.store_clone?.store_url || manifest.store_url || manifest.url,
    RIP_PORT_PATH: port?.replace(/\/$/, ''), RIP_PORT_HASH: portCheck?.manifestHash,
    GAMEPLAY_NOTES_PATH: index.gameplayNotesPath,
  };
  const prompt = fill(all.main, blocks, values);
  const promptPath = 'docs/brief-author-prompt.md';
  if (!dry) fs.writeFileSync(local(p, promptPath), prompt + '\n');
  const agent = a.agent || brief.brief_agent?.replace(/\s+#.*$/, '') || 'claude --model claude-fable-5-1';
  return {
    ok: true, dryRun: dry, runId, resumed, source: index.source, contractDepth: index.contractDepth, slug,
    copied: dry ? [] : copies.map(c => c[1]), scaffolded, promptPath: dry ? null : promptPath, warnings: [...warnings, ...index.warnings],
    prompt: dry ? prompt : undefined,
    launch: `node ~/.agents/skills/new-cocos-game/scripts/bootstrap.mjs agent-session --path '${p}' --agent '${agent}' --title 'brief-${slug}' --prompt "$(cat '${p}/${promptPath}')"`,
    next: 'Validate the agent with bootstrap.mjs agent-cmd, run `launch`, record the terminal handle, then monitor with brief-progress.mjs --watch.',
  };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) run(() => { const a = args(); return prepare(project(a), a); });
