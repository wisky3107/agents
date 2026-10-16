#!/usr/bin/env node
/**
 * Worker spec templates, read straight from the role cards a coordinator copies by hand:
 * reference/worker-prompts.md (shared header, plan, scan, implement, integrate, review, fix) and
 * ../cocos-asset-gen/reference/worker-prompts-art.md (art-*). One source for the LLM coordinator
 * and the fleet driver (plan 2026-10-16-fleet-script-coordinator D5): nothing is copied out.
 *
 * A role key is its heading up to the first " (" — `art-concept-<stem>`, `art-2d / antigravity`.
 * Fences after a "**Animated addendum**" paragraph are addenda; the rest are the role's body.
 * `<UPPER_CASE>` placeholders are the coordinator's to fill; ALIASES name the few lower-case ones
 * the cards use for the same thing. Every other `<…>` is the worker's to fill and stays.
 *
 *   node spec-templates.mjs list [--json]
 *   node spec-templates.mjs render --role implement --values values.json [--animated] [--backend antigravity] [--ui-kit]
 */
import fs from 'node:fs';

const WP = new URL('../reference/worker-prompts.md', import.meta.url).pathname;
const WPA = new URL('../../cocos-asset-gen/reference/worker-prompts-art.md', import.meta.url).pathname;

// Lower-case placeholders in the cards that the coordinator fills (not the worker).
export const ALIASES = {
  '<feature>': 'FEATURE',
  '<role>': 'ROLE',
  '<row expect_dims>': 'ROW_EXPECT_DIMS',
  '<x,y,z from the row, glTF order>': 'ROW_EXPECT_DIMS',
  '<x,y,z>': 'ROW_EXPECT_DIMS',
  '<row forward>': 'ROW_FORWARD',
  '<tri_budget>': 'TRI_BUDGET',
  '<project-slug>': 'PROJECT_SLUG',
  '<paste the fix_routing rows for this owner verbatim: ids · scope paths · change · acceptance>': 'FIX_ROWS',
};
const UPPER = /<([A-Z][A-Z0-9_]*)>/g;
// Upper-case placeholders that are the worker's to fill (a timestamp, a rig report value).
const WORKER_FILL = new Set(['ISO', 'A']);

/** Sections of one card file: [{ key, heading, level, fences: [{ text, addendum }] }]; the fences before the first heading go under key ''. */
export function parseCards(text) {
  const out = [{ key: '', heading: '', level: 1, fences: [] }];
  const lines = text.split('\n');
  let fence = null, addendum = false;
  for (const line of lines) {
    if (fence) {
      if (/^```\s*$/.test(line)) { out.at(-1).fences.push({ text: fence.join('\n'), addendum }); fence = null; addendum = false; }
      else fence.push(line);
      continue;
    }
    const h = line.match(/^(#{2,3}) (.+)$/);
    if (h) { out.push({ key: h[2].split(' (')[0].trim(), heading: h[2], level: h[1].length, fences: [] }); addendum = false; continue; }
    if (/^```text\s*$/.test(line)) { fence = []; continue; }
    if (/^\*\*Animated addendum\*\*/.test(line)) addendum = true;
  }
  return out;
}

export function loadCards({ wp = WP, wpa = WPA } = {}) {
  const sections = [...parseCards(fs.readFileSync(wp, 'utf8')), ...parseCards(fs.readFileSync(wpa, 'utf8')).filter(s => s.key)];
  const byKey = new Map();
  for (const s of sections) if (!byKey.has(s.key)) byKey.set(s.key, s);
  return { header: sections[0].fences[0]?.text ?? '', byKey };
}

/** Placeholders the coordinator must fill in a text (aliases resolved to their key). */
export function placeholders(text) {
  const keys = new Set([...text.matchAll(UPPER)].map(m => m[1]).filter(k => !WORKER_FILL.has(k)));
  for (const [alias, key] of Object.entries(ALIASES)) if (text.includes(alias)) keys.add(key);
  return [...keys].sort();
}

/** Fill `<KEY>` and the aliases; throws when a coordinator placeholder has no value. */
export function fill(text, values) {
  let out = text;
  for (const [alias, key] of Object.entries(ALIASES)) if (out.includes(alias) && key in values) out = out.split(alias).join(String(values[key]));
  out = out.replace(UPPER, (m, k) => (k in values && !WORKER_FILL.has(k) ? String(values[k]) : m));
  const left = placeholders(out);
  if (left.length) throw new Error(`unfilled placeholders: ${left.join(', ')}`);
  return out;
}

// Exactly the set orca-agent-fleet/scripts/clean_spec.py strips (zero-width, bidi, BOM, soft hyphen).
const INVISIBLE = /[­᠎​-‏‪-‮⁠-⁤⁦-⁩﻿]/g;
export const clean = text => text.replace(INVISIBLE, '');

/** Template parts for a role: the shared header, the role body fences, and the addenda / backend block the options ask for. */
export function parts(cards, role, { animated = false, backend = null, uiKit = false } = {}) {
  const key = role.replace(/-[a-z0-9_]+$/i, m => (cards.byKey.has(role) ? m : '-<stem>'));
  const s = cards.byKey.get(cards.byKey.has(role) ? role : key) ?? cards.byKey.get(role === 'art-2d' ? 'art / art-2d' : role);
  if (!s) throw new Error(`no role card for ${role}`);
  if (!s.fences.length) throw new Error(`role card ${s.key} has no spec block`);
  // implement: the first fence is the boot prompt, not the spec.
  const body = s.key === 'implement' ? s.fences.slice(1) : s.fences;
  const out = [cards.header, ...body.filter(f => !f.addendum).map(f => f.text)];
  if (animated) out.push(...body.filter(f => f.addendum).map(f => f.text));
  if (s.key === 'art / art-2d') {
    if (uiKit) out.push(...(cards.byKey.get('art-2d / ui-kit route')?.fences.map(f => f.text) ?? []));
    if (backend) {
      const b = cards.byKey.get(`art-2d / ${backend}`);
      if (!b) throw new Error(`no art-2d block for backend ${backend}`);
      out.push(...b.fences.map(f => f.text));
    }
  }
  return out;
}

/** The finished spec text for one role. */
export function render(role, values, opts = {}, cards = loadCards()) {
  return clean(fill(parts(cards, role, opts).join('\n\n'), values)) + '\n';
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const flag = n => { const i = rest.indexOf(`--${n}`); return i >= 0 ? rest[i + 1] : undefined; };
  const cards = loadCards();
  if (cmd === 'list') {
    const rows = [['header', placeholders(cards.header)], ...[...cards.byKey.values()].filter(s => s.key && s.fences.length)
      .map(s => [s.key, placeholders(s.fences.map(f => f.text).join('\n'))])];
    if (rest.includes('--json')) console.log(JSON.stringify(Object.fromEntries(rows), null, 2));
    else for (const [k, p] of rows) console.log(`${k}: ${p.join(' ') || '-'}`);
    return 0;
  }
  if (cmd === 'render') {
    const role = flag('role'), file = flag('values');
    if (!role || !file) { console.error('usage: render --role <role> --values <values.json> [--animated] [--backend <b>] [--ui-kit]'); return 2; }
    const values = JSON.parse(fs.readFileSync(file, 'utf8'));
    process.stdout.write(render(role, values, { animated: rest.includes('--animated'), backend: flag('backend') ?? null, uiKit: rest.includes('--ui-kit') }, cards));
    return 0;
  }
  console.error('usage: spec-templates.mjs list [--json] | render --role <role> --values <file> [...]');
  return 2;
}

if (process.argv[1] === new URL(import.meta.url).pathname) {
  try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 1; }
}
