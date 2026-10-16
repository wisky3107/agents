import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { directorFindings, RULED_REVIEW, RULED_FIX } from '../scripts/lib/lanes.mjs';
import { project, fakes, runner, evRel, ev, sliceState, approvedEvidence, commitStep, lastCommit } from './harness.mjs';

// Pilot 24 S38/S39: findings only the director can settle (`## director decisions`, fix_routing rows routed to the
// director) went back to the writer as fix rounds that changed nothing; the runner asks the director instead.
process.env.PRODUCER_RUNNER_CURSOR = 'on';
const H = evRel('S01', 'HANDOFF.json');
const W = (status) => ({ [H]: { role: 'writer', status, detail: 'd', sha: null } });
const preview = { [evRel('S01', 'preview-startup.json')]: { projectPath: '/p', previewUrl: 'http://127.0.0.1:7461/', status: 'ready' } };
const REVIEW = (extraRow = '') => `# Review round 2

## Findings
F1 (major, owner director/scene) two islands keep a cut-off; needs a ruling (D-3).
F2 (major, owner code/human) no V2-V4 captures; or the director accepts the state proof (D-1).

## Director decisions open
- D-3: accept the R4 cut-offs on 006_Crystal_Jungle and 008_JungleCity6, or allow a repaint of those two plots.
- D-1: accept the state-level proof, or run the manual V1-V4 pass.

## fix_routing
| # | route | action |
|---|---|---|
| F1 | scene (director ruling) | D-3: accept the recorded D3 or authorise a repaint |
| F2 | code (evidence) / human | live captures, or the director accepts the state-level proof (D-1) |
${extraRow}
## escaped
none

CHANGES_REQUESTED
`;
const CR = (extraRow) => ({ [H]: { role: 'reviewer', status: 'changes_requested' }, ...approvedEvidence('S01', 'x'), [evRel('S01', 'review.md')]: REVIEW(extraRow) });

test('directorFindings: decisions, rows routed to the director or citing a listed D-n, and writer rows', () => {
  const only = directorFindings(REVIEW());
  assert.deepEqual(only.decisions.map((d) => d.slice(0, 4)), ['D-3:', 'D-1:']);
  assert.deepEqual(only.directorRows.map((c) => c[0]), ['F1', 'F2'], 'F1 by its route, F2 by the D-1 it cites');
  assert.deepEqual(only.writerRows, []);
  const mixed = directorFindings(REVIEW('| F3 | code | rename the helper |\n'));
  assert.deepEqual(mixed.writerRows.map((c) => c[0]), ['F3']);
  assert.deepEqual(directorFindings('# Review\n\n## fix_routing\n| # | route | action |\n|---|---|---|\n| F1 | code | fix it |\n\nCHANGES_REQUESTED\n'), { decisions: [], directorRows: [], writerRows: [['F1', 'code', 'fix it']] });
});

test('a review left on director decisions asks the director; the ruling alone gets a fresh reviewer, no fix round', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'director findings', write: CR() }]);
  const out = runner(p.root, f, 'start', '--once').out;
  const q = out.at(-1);
  assert.equal(q.kind, 'review_director', JSON.stringify(out.slice(-2)));
  assert.deepEqual(q.options, [RULED_REVIEW, RULED_FIX, 'mark blocked', 'stop'], 'only director rows: re-review is offered first');
  assert.equal(f.sends().filter((s) => /^Fix round/.test(s.text)).length, 0, 'no fix round sent');
  // the ruling is the note: without one the answer is refused
  assert.notEqual(runner(p.root, f, 'answer', '--id', q.waiting, '--choice', RULED_REVIEW).status, 0);
  runner(p.root, f, 'answer', '--id', q.waiting, '--choice', RULED_REVIEW, '--text', 'D-3 accepted as recorded; D-1 the state proof stands');
  f.queue([{ name: 'approved with the ruling', write: { [H]: { role: 'reviewer', status: 'approved' }, ...approvedEvidence('S01', 'APPROVED') } }, commitStep('S01')]);
  const again = runner(p.root, f, 'start', '--once').out;
  assert.equal(again.find((o) => o.merged)?.commit, lastCommit(f), JSON.stringify(again.slice(-2)));
  const rulings = fs.readFileSync(ev(p.root, 'S01', 'evidence', 'director-rulings.md'), 'utf8');
  assert.match(rulings, /Ruling: D-3 accepted as recorded; D-1 the state proof stands/);
  assert.match(rulings, /Asked: review\.md needs the director on: D-3: accept/);
  const reviewers = f.spawns().filter((s) => /^review-/.test(s.title));
  assert.equal(reviewers.length, 2, 'a fresh reviewer after the ruling');
  assert.match(reviewers[1].prompt, /director-rulings\.md when it exists \(GIVEN/);
  assert.equal(sliceState(p.root, 'S01').fix_rounds || 0, 0, 'the ruling is not a fix round');
});

test('director decisions beside writer rows: the ruling goes with the fix round', () => {
  const p = project({ slices: { S01: { needs: false } } });
  const f = fakes();
  f.queue([{ name: 'ready', write: { ...W('ready_for_review'), ...preview } }, { name: 'mixed findings', write: CR('| F3 | code | rename the helper |\n') }]);
  const q = runner(p.root, f, 'start', '--once').out.at(-1);
  assert.equal(q.kind, 'review_director');
  assert.deepEqual(q.options, [RULED_FIX, 'mark blocked', 'stop'], 'a writer row is left: no re-review without a fix');
  runner(p.root, f, 'answer', '--id', q.waiting, '--choice', RULED_FIX, '--text', 'D-3 repaint not allowed, accept; D-1 accepted');
  f.queue([{ name: 'fixed', write: W('ready_for_review') }, { name: 'approved', write: { [H]: { role: 'reviewer', status: 'approved' }, ...approvedEvidence('S01', 'APPROVED') } }, commitStep('S01')]);
  const again = runner(p.root, f, 'start', '--once').out;
  assert.ok(again.find((o) => o.merged), JSON.stringify(again.slice(-2)));
  const fix = f.sends().find((s) => /^Fix round 1/.test(s.text));
  assert.match(fix.text, /as the director's rulings in .*director-rulings\.md settle them \(GIVEN\)/);
  assert.equal(sliceState(p.root, 'S01').fix_rounds, 1);
});
