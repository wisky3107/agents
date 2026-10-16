/**
 * The fleet lane's Task DAG as a pure state machine (plan 2026-10-16-fleet-script-coordinator D2, D3,
 * D4, D6): `step(cfg, state, event) → { state, actions }`, no IO. The fleet driver turns actions into
 * orca calls and feeds back what happened as events; the cocos-orca-fleet SKILL is the rulebook.
 *
 * Tasks are created lazily: art tasks once art-manifest's manifest.json is read, so every spec is
 * filled from real rows. A task runs on a fresh terminal of its agent, or reuses another task's
 * terminal (integrate, code/scene fixes and commit all run on the implement terminal, one at a time,
 * ordered by deps). Every decision that is not mechanical becomes an `ask` (a runner question).
 *
 * cfg:   { lite, agents: { scan, artManifest, artImport, concept, mesh, art2d, writer, reviewer }, art2dBackend }
 * state: { tasks: { [name]: task }, phase, fixRound, reviewRound, asked: { [ref]: kind }, decisions: [] }
 * task:  { name, role, stem?, deps[], agent?, reuse?, status: planned|started|done|failed, opts?, fix?, note? }
 *
 * events: start · done {task, outcome, body} · manifest {rows} · review {task, result} (review-check output)
 *         question {task, msgId, text, options} · escalation {task, msgId, text} · answer {ref, kind, choice, text}
 *         infra_resolved {reviewer?} · commit
 * actions: start {task} · release {task} · read_manifest · check_review {task} · infra {task} · reply {msgId, text}
 *          ask {kind, ref, text, options} · handoff {status, detail, sha?} · close_chain
 */

export const MAX_FIX_ROUNDS = 2;
// Terminal-holding chain: these reuse the implement terminal and are never released one by one.
const CHAIN = 'implement';
const ART_OWNERS = ['asset', 'concept', 'mesh', 'anim'];

export function initial() {
  return { tasks: {}, phase: 'running', fixRound: 0, reviewRound: 0, asked: {}, decisions: [] };
}

const clone = (s) => JSON.parse(JSON.stringify(s));

/** One event → the next state and the actions to run, in order. */
export function step(cfg, state, event) {
  const s = clone(state);
  const actions = [];
  const add = (t) => { s.tasks[t.name] = { deps: [], status: 'planned', ...t }; };
  const ask = (kind, ref, text, options) => { s.asked[ref] = kind; actions.push({ do: 'ask', kind, ref, text, options }); };

  switch (event.type) {
    case 'start': {
      if (Object.keys(s.tasks).length) break; // a replayed start after a kill
      if (cfg.lite) planBuild(cfg, s, []);
      else add({ name: 'scan', role: 'scan', agent: cfg.agents.scan });
      break;
    }
    case 'done': {
      const t = s.tasks[event.task];
      if (!t || t.status !== 'started') break; // stale or duplicate worker_done
      if (event.outcome !== 'succeeded' && t.role !== 'review' && t.role !== 'commit') {
        t.status = 'failed';
        ask('worker_failed', `failed:${t.name}:${t.attempt ?? 1}`, `${t.name} reported failed: ${firstLine(event.body)}`,
          ['retry the task', 'continue as done', 'stop']);
        break;
      }
      finish(cfg, s, t, event, actions, ask);
      break;
    }
    case 'manifest': {
      if (s.tasks.integrate) break;
      const art = [];
      for (const r of event.rows || []) {
        if (r.source === 'import') art.push(addTask(s, { name: `art-import-${r.stem}`, role: `art-import-${r.stem}`, stem: r.stem, agent: cfg.agents.artImport, deps: ['art-manifest'] }));
        else if (r.kind === '3d') {
          addTask(s, { name: `art-concept-${r.stem}`, role: `art-concept-${r.stem}`, stem: r.stem, agent: cfg.agents.concept, deps: ['art-manifest'], opts: { animated: !!r.animated } });
          art.push(addTask(s, { name: `art-mesh-${r.stem}`, role: `art-mesh-${r.stem}`, stem: r.stem, agent: cfg.agents.mesh, deps: [`art-concept-${r.stem}`], opts: { animated: !!r.animated } }));
          if (r.animated) art.push(addTask(s, { name: `art-anim-${r.stem}`, role: `art-anim-${r.stem}`, stem: r.stem, agent: cfg.agents.mesh, deps: [`art-mesh-${r.stem}`] }));
        }
      }
      if ((event.rows || []).some((r) => r.source !== 'import' && r.kind !== '3d')) art.push(addTask(s, { name: 'art-2d', role: 'art-2d', agent: cfg.agents.art2d, deps: ['art-manifest'], opts: { backend: cfg.art2dBackend } }));
      // integrate waits on the last art task of every row (mesh, or anim when animated)
      const last = art.filter((n) => !art.includes(`art-anim-${s.tasks[n].stem}`) || n.startsWith('art-anim-'));
      planBuild(cfg, s, last, true);
      break;
    }
    case 'review': {
      const t = s.tasks[event.task];
      if (!t || t.status !== 'done' || t.reviewed) break;
      t.reviewed = true;
      routeReview(cfg, s, t, event.result, actions, ask);
      break;
    }
    case 'question':
    case 'escalation': {
      const ref = `msg:${event.msgId}`;
      if (s.asked[ref]) break;
      ask(event.type === 'question' ? 'worker_question' : 'worker_escalation', ref, `${event.task}: ${event.text}`,
        event.options?.length ? event.options : null);
      break;
    }
    case 'answer': {
      const kind = s.asked[event.ref];
      if (!kind) break;
      delete s.asked[event.ref];
      onAnswer(cfg, s, kind, event, actions, ask);
      break;
    }
    case 'infra_resolved': {
      if (s.phase !== 'infra') break;
      s.phase = 'running';
      if (event.reviewer) s.reviewer = event.reviewer; // a swapped reviewer holds for the rest of the lane
      newReview(cfg, s, []);
      break;
    }
    case 'commit': {
      if (s.phase !== 'offer_commit') break;
      s.phase = 'committing';
      add({ name: 'commit', role: 'commit', reuse: CHAIN, deps: [] });
      break;
    }
    default:
      break;
  }
  schedule(s, actions);
  return { state: s, actions };
}

function addTask(s, t) {
  if (!s.tasks[t.name]) s.tasks[t.name] = { deps: [], status: 'planned', ...t };
  return t.name;
}

/** implement (lite: now; full: already planned after scan), integrate and the first review. */
function planBuild(cfg, s, artDeps, haveImplement = false) {
  if (!haveImplement) addTask(s, { name: 'implement', role: 'implement', agent: cfg.agents.writer, deps: [] });
  addTask(s, { name: 'integrate', role: 'integrate', reuse: CHAIN, deps: ['implement', ...artDeps] });
  newReview(cfg, s, ['integrate']);
}

function newReview(cfg, s, deps, agent = null) {
  s.reviewRound += 1;
  const name = s.reviewRound === 1 ? 'review' : `review-r${s.reviewRound}`;
  addTask(s, { name, role: 'review', agent: agent || s.reviewer || cfg.agents.reviewer, deps });
  return name;
}

function finish(cfg, s, t, event, actions, ask) {
  t.status = 'done';
  t.body = firstLine(event.body);
  if (!t.reuse && t.name !== CHAIN) actions.push({ do: 'release', task: t.name });
  onDone(cfg, s, t, event, actions, ask);
}

function onDone(cfg, s, t, event, actions, ask) {
  if (t.name === 'scan') {
    addTask(s, { name: 'art-manifest', role: 'art-manifest', agent: cfg.agents.artManifest, deps: ['scan'] });
    addTask(s, { name: 'implement', role: 'implement', agent: cfg.agents.writer, deps: ['scan'] });
  } else if (t.name === 'art-manifest') actions.push({ do: 'read_manifest' });
  else if (t.role === 'review') actions.push({ do: 'check_review', task: t.name });
  else if (t.role === 'commit') {
    const sha = (String(event.body || '').match(/\b[0-9a-f]{7,40}\b/) || [])[0];
    if (event.outcome !== 'succeeded' || !sha) {
      t.status = 'failed';
      ask('commit_failed', `commit:${t.attempt ?? 1}`, `commit task reported ${event.outcome}${sha ? '' : ' without a sha'}: ${firstLine(event.body)}`, ['retry the commit', 'stop']);
      return;
    }
    s.phase = 'committed';
    actions.push({ do: 'handoff', status: 'committed', detail: `fix_rounds=${s.fixRound}`, sha }, { do: 'close_chain' });
  }
}

function routeReview(cfg, s, t, r, actions, ask) {
  if (r.verdict === 'APPROVED' && r.ok) {
    s.phase = 'offer_commit';
    actions.push({ do: 'handoff', status: 'offer_commit', detail: `APPROVED fix_rounds=${s.fixRound} review_rounds=${s.reviewRound}` });
    return;
  }
  if (r.verdict === 'INFRA_BLOCKED' || (r.verdict === 'CHANGES_REQUESTED' && r.infra_only)) {
    s.phase = 'infra';
    actions.push({ do: 'infra', task: t.name });
    return;
  }
  if (!r.ok) {
    ask('review_contract', `contract:${t.name}`, `${t.name}: review.md fails review-check: ${(r.errors || []).map((e) => e.message).join('; ')}`,
      ['new review with the errors attached', 'stop']);
    s.pendingReview = { task: t.name, errors: r.errors };
    return;
  }
  s.pendingReview = { task: t.name, result: r };
  continueFixes(cfg, s, actions, ask);
}

/** Director rows → ask; unclear rows → ask; round cap → ask; else one fix task per owner group. */
function continueFixes(cfg, s, actions, ask) {
  const { task, result: r } = s.pendingReview;
  if (r.director?.length && !s.pendingReview.directorDone) {
    ask('review_director', `director:${task}`, `${task}: the reviewer needs a director decision:\n${rowsText(r.director)}`, null);
    return;
  }
  if (r.unclear?.length && !s.pendingReview.unclearDone) {
    ask('fix_routing_unclear', `unclear:${task}`, `${task}: fix rows outside the slice paths:\n${rowsText(r.unclear)}`,
      ['allow the paths and fix as code', 'move them to FOLLOWUPS', 'stop']);
    return;
  }
  const groups = { ...(r.fix_groups || {}) };
  if (s.pendingReview.unclearAsCode) groups.code = [...(groups.code || []), ...r.unclear];
  if (!Object.keys(groups).length) { // only director/followup rows: a fresh review on the decisions
    delete s.pendingReview;
    newReview(cfg, s, []);
    return;
  }
  if (s.fixRound >= MAX_FIX_ROUNDS && !s.pendingReview.extraRound) {
    ask('changes_after_rounds', `rounds:${task}`, `${task}: CHANGES_REQUESTED after ${s.fixRound} fix rounds`, ['one more fix round', 'stop']);
    return;
  }
  s.fixRound += 1;
  const n = s.fixRound, note = s.decisions.length ? `Director decisions: ${s.decisions.join(' | ')}` : null;
  const made = [];
  const fix = (owner, rows, extra) => made.push(addTask(s, { name: `fix${n}-${owner}${extra.stem ? `-${extra.stem}` : ''}`, fix: { owner, rows }, note, ...extra }));
  if (groups.code) fix('code', groups.code, { role: 'fix', reuse: CHAIN, deps: [] });
  if (groups.asset) fix('asset', groups.asset, { role: 'fix', agent: cfg.agents.art2d, deps: [] });
  const artDone = [];
  for (const owner of ['concept', 'mesh', 'anim']) {
    const byStem = {};
    for (const row of groups[owner] || []) (byStem[row.reason || '?'] ??= []).push(row);
    for (const [stem, rows] of Object.entries(byStem)) {
      const animated = !!s.tasks[`art-anim-${stem}`];
      const agent = owner === 'concept' ? cfg.agents.concept : cfg.agents.mesh;
      const name = `fix${n}-${owner}-${stem}`;
      if (s.tasks[name]) { s.tasks[name].fix.rows.push(...rows); continue; }
      fix(owner, rows, { role: 'fix', agent, stem, deps: [], opts: { animated, art: true } });
      let tail = name;
      if (owner === 'concept') tail = addTask(s, { name: `fix${n}-remesh-${stem}`, role: `art-mesh-${stem}`, stem, agent: cfg.agents.mesh, deps: [name], opts: { animated } });
      if (owner !== 'anim' && animated) tail = addTask(s, { name: `fix${n}-reanim-${stem}`, role: `art-anim-${stem}`, stem, agent: cfg.agents.mesh, deps: [tail] });
      artDone.push(tail);
    }
  }
  if (groups.asset) artDone.push(`fix${n}-asset`);
  // the scene step runs after code and art; art without a scene row still needs an integrate pass
  if (groups.scene || artDone.length) {
    const deps = [...(groups.code ? [`fix${n}-code`] : []), ...artDone];
    if (groups.scene) fix('scene', groups.scene, { role: 'fix', reuse: CHAIN, deps });
    else made.push(addTask(s, { name: `fix${n}-integrate`, role: 'integrate', reuse: CHAIN, deps }));
  }
  const all = Object.keys(s.tasks).filter((k) => k.startsWith(`fix${n}-`));
  delete s.pendingReview;
  newReview(cfg, s, all);
  return made;
}

function onAnswer(cfg, s, kind, event, actions, ask) {
  const choice = String(event.choice || '');
  const stop = () => { s.phase = 'stopped'; actions.push({ do: 'handoff', status: 'blocked', detail: `stopped at ${kind}` }); };
  if (/^stop$/i.test(choice)) return stop();
  switch (kind) {
    case 'worker_question':
    case 'worker_escalation':
      actions.push({ do: 'reply', msgId: event.ref.slice(4), text: event.text || choice });
      break;
    case 'worker_failed': {
      const name = event.ref.split(':')[1], t = s.tasks[name];
      if (/^retry/.test(choice)) { t.status = 'planned'; t.attempt = (t.attempt ?? 1) + 1; t.retry = true; }
      else if (/^continue/.test(choice)) finish(cfg, s, t, { outcome: 'succeeded', body: 'accepted as done by the director' }, actions, ask);
      break;
    }
    case 'commit_failed': {
      const t = s.tasks.commit;
      t.status = 'planned'; t.attempt = (t.attempt ?? 1) + 1; t.retry = true;
      break;
    }
    case 'review_contract': {
      const errors = s.pendingReview?.errors || [];
      delete s.pendingReview;
      const name = newReview(cfg, s, []);
      s.tasks[name].note = `The previous review.md failed review-check: ${errors.map((e) => e.message).join('; ')}`;
      break;
    }
    case 'review_director':
      s.decisions.push(event.text || choice);
      s.pendingReview.directorDone = true;
      continueFixes(cfg, s, actions, ask);
      break;
    case 'fix_routing_unclear':
      s.pendingReview.unclearDone = true;
      if (/^allow/.test(choice)) { s.pendingReview.unclearAsCode = true; s.decisions.push(`paths allowed: ${rowsText(s.pendingReview.result.unclear)}`); }
      continueFixes(cfg, s, actions, ask);
      break;
    case 'changes_after_rounds':
      s.pendingReview.extraRound = true;
      continueFixes(cfg, s, actions, ask);
      break;
    default:
      break;
  }
}

/**
 * Start every planned task whose deps are done. Two tasks never share a terminal at once: a task that
 * reuses the chain waits while another chain task is started.
 */
function schedule(s, actions) {
  if (s.phase === 'stopped') return;
  const busyChain = () => Object.values(s.tasks).some((t) => t.status === 'started' && (t.reuse === CHAIN || t.name === CHAIN));
  for (const t of Object.values(s.tasks)) {
    if (t.status !== 'planned' || !t.deps.every((d) => s.tasks[d]?.status === 'done')) continue;
    if ((t.reuse === CHAIN || t.name === CHAIN) && busyChain()) continue;
    t.status = 'started';
    actions.push({ do: 'start', task: t.name });
  }
}

const firstLine = (b) => String(b ?? '').trim().split('\n')[0].slice(0, 300);
const rowsText = (rows) => rows.map((r) => `${r.ids.join(',')} ${r.owner_raw}: ${r.change}`).join('\n');
