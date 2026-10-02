/**
 * A short picture of where the run stands, shown with every question the director answers (terminal
 * menu, dialog, notification): project, the question's slice and its lane state, release progress,
 * the runner's last event. Read-only and best effort: anything unreadable is left out.
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadProject, sliceStatuses, sliceFront } from './project.mjs';
import * as st from './state.mjs';

/** Local "21:48", or "10-02 21:48" when not today. */
const when = (iso) => {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  const today = new Date().toDateString() === d.toDateString();
  return `${today ? '' : `${p(d.getMonth() + 1)}-${p(d.getDate())} `}${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** "model-select" from slices/S02-model-select.md, or the front matter's title. */
function sliceTitle(project, id) {
  try {
    const { file, data } = sliceFront(project, id);
    return String(data.title || path.basename(file, '.md').replace(/^S\d{2}[a-z]?-/, '')).trim();
  } catch {
    return '';
  }
}

/** The newest runner log line of any slice that is not a question being asked or answered. */
function lastEvent(root) {
  const base = path.join(root, '.cursor', 'evidence', 'tasks');
  let best = null;
  for (const d of fs.existsSync(base) ? fs.readdirSync(base) : []) {
    let lines = [];
    try {
      lines = fs.readFileSync(path.join(base, d, 'producer-log.md'), 'utf8').trim().split('\n');
    } catch {
      continue;
    }
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/^(\S+) runner: (.*)$/);
      if (!m || /^(?:blocked |answer |judge on )/.test(m[2])) continue;
      if (!best || m[1] > best.at) best = { at: m[1], slice: d.replace(/^T-/, ''), text: m[2] };
      break;
    }
  }
  return best;
}

/** → lines (may be just the project name) */
export function questionContext(root, q) {
  const name = path.basename(root);
  try {
    const project = loadProject(root);
    const statuses = sliceStatuses(project);
    const ids = project.milestones.slices;
    const merged = ids.filter((id) => ['merged', 'shipped'].includes(statuses[id]?.status));
    const lines = [];
    if (q.slice) {
      const s = st.readSliceState(root, q.slice);
      const where = s.phase ? `${s.lane || '?'} lane, ${s.phase}` : statuses[q.slice]?.status || 'not started';
      lines.push(`${name} · ${q.slice} ${sliceTitle(project, q.slice)} (${where})`.replace(/\s+\(/, ' ('));
    } else lines.push(name);
    const busy = ids.filter((id) => statuses[id]?.status === 'in_progress' && id !== q.slice);
    lines.push(`release: ${merged.length}/${ids.length} merged${merged.length ? ` (${merged.join(', ')})` : ''}${busy.length ? ` · in progress: ${busy.join(', ')}` : ''}`);
    const last = lastEvent(root);
    if (last) lines.push(`last: ${when(last.at)} ${last.slice} ${last.text.replace(/\s+/g, ' ').slice(0, 110)}`);
    return lines;
  } catch {
    return [name];
  }
}
