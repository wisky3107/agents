'use strict';
// Director console app: shell, router, overlays and the eight views. All writes go through
// POST /api/action/<name>, which runs one allowlisted CLI; this file never touches state itself.
(() => {
  const { icon, levelMap, flowGraph, verdictColumns, tipOn, levelState } = window.G;

  // ---------------------------------------------------------------- plumbing
  const TOKEN = (() => {
    const q = new URLSearchParams(location.search).get('t');
    try {
      if (q) { sessionStorage.setItem('console-token', q); history.replaceState(null, '', location.pathname + location.hash); }
      return q || sessionStorage.getItem('console-token') || '';
    } catch { return q || ''; }
  })();
  async function api(url) {
    const r = await fetch(url, { headers: { 'x-console-token': TOKEN } });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  }
  async function post(name, body) {
    const r = await fetch(`/api/action/${name}`, { method: 'POST', headers: { 'x-console-token': TOKEN, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    return { ok: r.ok && j.ok, ...j };
  }

  function h(tag, attrs = {}, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return el;
  }
  const qtag = (ic, label) => h('span', { class: 'q-tag' }, icon(ic, 15), label);
  const chip = (text, tone = '', ic = null) => h('span', { class: `chip ${tone}` }, ic ? icon(ic, 13) : null, text);
  const empty = (text, ic = 'check', sub = null) => h('div', { class: 'empty' }, h('div', { class: 'em-ic' }, icon(ic, 24)), h('div', {}, text), sub ? h('div', { class: 'em-sub' }, sub) : null);
  const when = (iso) => (iso ? new Date(iso).toLocaleString('vi-VN', { hour12: false, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—');
  function ago(iso) {
    if (!iso) return '—';
    const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
    if (m < 1) return 'vừa xong';
    if (m < 60) return `${m} phút trước`;
    const hr = Math.round(m / 60);
    if (hr < 48) return `${hr} giờ trước`;
    return `${Math.round(hr / 24)} ngày trước`;
  }
  function panel(title, opts = {}, ...kids) {
    const head = h('div', { class: 'panel-h' }, opts.icon ? icon(opts.icon, 16) : null, h('h2', {}, title), h('span', { class: 'grow' }), opts.right ?? null);
    return h('section', { class: `panel ${opts.cls ?? ''}`, id: opts.id ?? null }, head, opts.sub ? h('p', { class: 'sub' }, opts.sub) : null, ...kids);
  }
  const btn = (label, onclick, { cls = '', ic = null, title = null, disabled = false } = {}) =>
    h('button', { class: `btn ${cls}`, onclick, title, disabled, type: 'button' }, ic ? icon(ic, 15) : null, label);
  const modeTone = (m) => (m === 'assist' ? 'good' : m === 'shadow' ? 'warn' : m === 'capture-only' ? 'accent' : 'outline');
  const VERDICTS = ['useful', 'redundant', 'irrelevant', 'misleading', 'stale'];
  const VLABEL = { useful: 'useful', redundant: 'redundant', irrelevant: 'irrelevant', misleading: 'misleading', stale: 'stale' };
  const VHELP = {
    useful: 'Có bằng chứng record làm thay đổi kết quả',
    redundant: 'Đúng nhưng agent đã biết từ PLAN/contract/code',
    irrelevant: 'Không liên quan tới slice',
    misleading: 'Làm theo sẽ đi sai',
    stale: 'Không còn đúng với code hiện tại',
  };

  // ---------------------------------------------------------------- overlays
  let openOverlay = null;
  function closeOverlay() {
    if (!openOverlay) return;
    openOverlay.forEach((el) => el.remove());
    openOverlay = null;
    G.hideTip();
  }
  function showOverlay(...els) {
    closeOverlay();
    const scrim = h('div', { class: 'scrim', onclick: closeOverlay });
    document.body.append(scrim, ...els);
    openOverlay = [scrim, ...els];
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && openOverlay) { e.preventDefault(); closeOverlay(); }
    if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !isTyping())) { e.preventDefault(); openPalette(); }
  });
  const isTyping = () => !!document.activeElement?.matches('input, textarea, select, [contenteditable]');

  function toast(text, bad = false) {
    document.querySelectorAll('.toast').forEach((t) => t.remove());
    const t = h('div', { class: `toast ${bad ? 'bad' : ''}`, role: 'status', onclick: () => t.remove() }, text);
    document.body.append(t);
    setTimeout(() => t.remove(), bad ? 20000 : 6000);
  }

  /** A confirm dialog with optional fields; resolves to the field values or null. */
  function confirmBox({ title, body = null, fields = [], ok = 'Xác nhận', danger = false }) {
    return new Promise((resolve) => {
      const inputs = fields.map((f) => {
        const el = f.multiline
          ? h('textarea', { class: 'input', placeholder: f.placeholder ?? '' })
          : h('input', { class: 'input', placeholder: f.placeholder ?? '' });
        if (f.value) el.value = f.value;
        return [f, el];
      });
      const err = h('div', { class: 'small', style: { color: 'var(--critical-ink)', minHeight: '18px' } });
      const done = (v) => { closeOverlay(); resolve(v); };
      const submit = () => {
        const out = {};
        for (const [f, el] of inputs) {
          if (f.required && !el.value.trim()) { err.textContent = `Cần điền: ${f.label}`; el.focus(); return; }
          out[f.name] = el.value.trim();
        }
        done(out);
      };
      const modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true' },
        h('h3', {}, title),
        body ? h('div', { class: 'ink2', style: { whiteSpace: 'pre-wrap', fontSize: '13px' } }, body) : null,
        inputs.map(([f, el]) => h('label', { style: { display: 'grid', gap: '4px', marginTop: '10px', fontSize: '12.5px' } }, h('span', { class: 'muted' }, f.label + (f.required ? ' *' : '')), el)),
        err,
        h('div', { class: 'actions' }, btn('Huỷ', () => done(null), { cls: 'ghost' }), btn(ok, submit, { cls: danger ? 'danger' : 'primary', ic: danger ? 'alert' : 'check' })));
      showOverlay(modal);
      modal.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); });
      (inputs[0]?.[1] ?? modal.querySelector('.btn.primary, .btn.danger'))?.focus();
    });
  }

  /** Run one allowlisted action after a confirm; fields are merged into the body. */
  async function act(name, body, dialog) {
    const extra = dialog ? await confirmBox(dialog) : {};
    if (extra === null) return null;
    const r = await post(name, { ...body, ...extra });
    const out = typeof r.out === 'string' ? r.out : JSON.stringify(r.out ?? r.error ?? '', null, 1);
    toast(`${r.ok ? '✓' : '✗'} ${name}\n${out}${r.err ? `\n${r.err}` : ''}`.slice(0, 1200), !r.ok);
    await refresh(true);
    return r;
  }

  function drawer(title, ...content) {
    const d = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': title },
      h('div', { class: 'drawer-h' }, h('h3', {}, title), btn('', closeOverlay, { cls: 'ghost sm', ic: 'x', title: 'Đóng (Esc)' })),
      ...content);
    showOverlay(d);
    return d;
  }

  // ---------------------------------------------------------------- store + router
  const store = { ov: null, mem: null, pb: null, pilot: {}, proj: {}, actions: null };
  const ui = {
    questType: 'all', questProject: '', questQ: '', worldSlice: {}, recQ: '', recProject: '', recKind: '', recLife: '',
    pbQ: '', pbTags: new Set(), pbSource: '', pilotProject: null,
  };
  const ROUTES = [
    ['map', 'Bản đồ', 'map'], ['quests', 'Nhiệm vụ', 'flag'], ['worlds', 'Dự án', 'globe'], ['memory', 'Memory', 'chip'],
    ['pilot', 'Pilot', 'flask'], ['playbook', 'Playbook', 'book'], ['scorecard', 'Scorecard', 'chart'], ['log', 'Nhật ký', 'list'],
  ];
  let route = { view: 'map', arg: null };
  function readHash() {
    const [v, ...rest] = (location.hash || '#map').slice(1).split('/');
    route = { view: ROUTES.some(([id]) => id === v) ? v : 'map', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
  }
  const go = (hash) => { if (location.hash === `#${hash}`) render(); else location.hash = hash; };

  // ---------------------------------------------------------------- shell
  const shell = {};
  function buildShell() {
    const tabs = ROUTES.map(([id, label, ic]) => {
      const badge = h('span', { class: 'badge', hidden: true });
      const b = h('button', { class: 'tab', onclick: () => go(id), type: 'button', title: label }, icon(ic, 17), h('span', { class: 'lbl' }, label), badge);
      b.dataset.id = id;
      return [id, b, badge];
    });
    shell.nav = tabs;
    shell.themeBtn = h('button', { class: 'btn icon-only', type: 'button', onclick: cycleTheme }, icon('moon', 18));
    const searchBtn = h('button', { class: 'btn', type: 'button', onclick: () => openPalette(), title: 'Tìm nhanh (⌘K hoặc /)' }, icon('search', 17), h('span', { class: 'search-lbl' }, 'Tìm'), h('span', { class: 'kbd search-lbl' }, '⌘K'));
    const top = h('header', { class: 'topbar' }, h('div', { class: 'inner' },
      h('button', { class: 'brand-sticker', type: 'button', onclick: () => go('map') }, 'Director ✦'),
      h('nav', { class: 'tabs', 'aria-label': 'Điều hướng' }, tabs.map(([, b]) => b)),
      h('div', { class: 'top-right' }, searchBtn, shell.themeBtn)));
    shell.crumb = h('div', { class: 'crumb' });
    shell.title = h('h1', {});
    shell.tags = h('div', { class: 'tags' });
    shell.actions = h('div', { class: 'actions' },
      h('button', { class: 'btn icon-only', type: 'button', title: 'Tải lại dữ liệu', onclick: () => refresh(true) }, icon('refresh', 18)));
    shell.content = h('div', { id: 'content' });
    const bottomIds = ['map', 'quests', 'worlds', 'memory'];
    shell.bottom = bottomIds.map((id) => {
      const r = ROUTES.find(([x]) => x === id);
      const badge = h('span', { class: 'badge', hidden: true });
      const b = h('button', { type: 'button', onclick: () => go(id) }, icon(r[2], 20), r[1], badge);
      b.dataset.id = id;
      return [id, b, badge];
    });
    const more = h('button', { type: 'button', onclick: () => openPalette() }, icon('search', 20), 'Thêm');
    const bottom = h('nav', { class: 'bottom-nav', 'aria-label': 'Điều hướng nhanh' }, shell.bottom.map(([, b]) => b), more);
    document.body.replaceChildren(top,
      h('main', { class: 'main' }, h('div', { class: 'page-head' }, h('div', {}, shell.crumb, shell.title, shell.tags), shell.actions), shell.content),
      bottom);
    applyTheme();
  }

  function cycleTheme() {
    const cur = document.documentElement.dataset.theme || 'auto';
    const next = { auto: 'dark', dark: 'light', light: 'auto' }[cur];
    try { localStorage.setItem('console-theme', next); } catch {}
    applyTheme();
  }
  function applyTheme() {
    let t = 'auto';
    try { t = localStorage.getItem('console-theme') || 'auto'; } catch {}
    if (t === 'auto') delete document.documentElement.dataset.theme; else document.documentElement.dataset.theme = t;
    const label = { auto: 'Giao diện: theo máy (bấm để đổi)', dark: 'Giao diện: tối (bấm để đổi)', light: 'Giao diện: sáng (bấm để đổi)' }[t];
    if (shell.themeBtn) { shell.themeBtn.title = label; shell.themeBtn.setAttribute('aria-label', label); }
  }

  // quest counts by kind, from the overview
  function questCounts(ov) {
    const p = ov.pending;
    const system = (p.refresh && (!p.refresh.ok || p.refresh.stale) ? 1 : 0) + p.unregistered.length;
    return { runner: p.questions.length, draft: p.drafts.length, triage: p.triage.length, system, manual: p.manual_deferred.reduce((n, d) => n + d.items.length, 0) };
  }

  const CRUMB = { map: 'TỔNG QUAN', quests: 'VIỆC CẦN QUYẾT', worlds: 'DỰ ÁN', memory: 'ORCA-MEMORY', pilot: 'PILOT M08', playbook: 'COCOS-PLAYBOOK', scorecard: 'WORKFLOW', log: 'THAO TÁC' };
  function updateChrome() {
    const ov = store.ov;
    const r = ROUTES.find(([id]) => id === route.view);
    shell.crumb.textContent = `DIRECTOR / ${CRUMB[route.view]}${route.arg ? ` / ${route.arg.toUpperCase()}` : ''}`;
    shell.title.textContent = route.arg && ['worlds', 'pilot'].includes(route.view) ? route.arg : r[1];
    document.title = `${r[1]} · Director`;
    for (const list of [shell.nav, shell.bottom]) for (const [id, b] of list) b.classList.toggle('on', id === route.view);
    if (!ov) return;
    const c = questCounts(ov);
    const decisions = c.runner + c.draft + c.triage + c.system;
    for (const list of [shell.nav, shell.bottom]) for (const [id, , badge] of list) {
      if (id !== 'quests') continue;
      badge.hidden = !decisions;
      badge.textContent = decisions;
    }
    const live = ov.projects.filter((p) => p.runner?.alive).length;
    const rf = ov.pending.refresh;
    const rfOk = rf && rf.ok && !rf.stale;
    shell.tags.replaceChildren(...[
      h('span', { class: 'tag' }, icon('clock', 13), `cập nhật ${ago(ov.at)}`),
      h('span', { class: `tag ${live ? 'warn' : ''}` }, h('span', { class: `pip ${live ? 'live' : ''}` }), `${live} runner chạy`),
      c.runner ? h('span', { class: 'tag bad' }, icon('alert', 13), `${c.runner} câu hỏi chặn runner`) : null,
      rf ? h('span', { class: `tag ${rfOk ? 'good' : 'bad'}` }, icon(rfOk ? 'check' : 'alert', 13), `kho refresh ${ago(rf.at)}`) : h('span', { class: 'tag bad' }, icon('alert', 13), 'kho chưa refresh'),
    ].filter(Boolean));
  }

  // ---------------------------------------------------------------- render loop
  let rendering = false;
  async function render() {
    readHash();
    updateChrome();
    if (!store.ov) return;
    rendering = true;
    try {
      const view = await VIEWS[route.view](route.arg);
      shell.content.replaceChildren(...[view].flat(Infinity).filter(Boolean));
    } catch (e) {
      console.error('render', route.view, e.stack);
      shell.content.replaceChildren(panel('Không tải được', { icon: 'alert' }, h('pre', { class: 'code' }, String(e.message)),
        e.message === 'token' ? h('p', {}, 'Mở lại đúng URL server in ra (có ?t=…).') : null));
    } finally {
      rendering = false;
    }
  }
  async function refresh(force = false) {
    try {
      store.ov = await api('/api/overview');
    } catch (e) {
      shell.content.replaceChildren(panel('Không kết nối được', { icon: 'alert' }, h('pre', { class: 'code' }, String(e.message)),
        e.message === 'token' ? h('p', {}, 'Mở lại đúng URL có ?t=… (dòng đầu của ~/.agents/logs/director-console.log).') : null));
      return;
    }
    store.proj = {};
    if (force || (!openOverlay && !isTyping() && !rendering && ['map', 'quests', 'worlds'].includes(route.view))) await render();
    else updateChrome();
  }

  // ---------------------------------------------------------------- views
  const VIEWS = {};

  // ======== map: HUD stats, the workflow graph, worlds, top quests
  VIEWS.map = async () => {
    const ov = store.ov;
    const c = questCounts(ov);
    const live = ov.projects.filter((p) => p.runner?.alive);
    const withLevels = ov.projects.filter((p) => p.levels.length);
    const assist = ov.projects.filter((p) => p.mode === 'assist').length;
    const rf = ov.pending.refresh;
    const decisions = c.runner + c.draft + c.triage + c.system;
    const stat = (label, value, foot, tone, ic, onclick) =>
      h('div', { class: `stat s-${tone} ${onclick ? 'link' : ''}`, onclick, role: onclick ? 'button' : null, tabindex: onclick ? 0 : null },
        h('div', { class: 'label' }, icon(ic, 14), label), h('div', { class: `value ${typeof value === 'string' ? 'text' : ''}` }, value), h('div', { class: 'foot' }, foot));
    const stats = h('div', { class: 'stats' },
      stat('Việc chờ bạn', decisions, c.runner ? `${c.runner} câu hỏi đang chặn runner` : `${c.draft} bảng nháp · ${c.triage} triage`, c.runner ? 'coral' : decisions ? 'yellow' : 'green', 'flag', () => go('quests')),
      stat('Runner đang chạy', live.length, live.map((p) => `${p.id} ${p.runner.slice ?? ''}`).join(', ') || 'không có', 'pink', 'bolt', () => go('worlds')),
      stat('Dự án', ov.projects.length, `${assist} assist · ${ov.projects.filter((p) => p.mode === 'shadow').length} shadow`, 'blue', 'globe', () => go('worlds')),
      stat('Kho bài học', ov.memory.records, `${ov.memory.active} đang dùng`, 'lilac', 'archive', () => go('memory')),
      stat('Refresh kho', rf ? ago(rf.at) : 'chưa', rf ? (rf.ok ? (rf.stale ? 'cũ hơn 48 giờ' : 'ổn') : `lỗi ở ${rf.failed_step}`) : 'chưa chạy lần nào', rf?.ok && !rf.stale ? 'green' : 'coral', 'refresh', () => go('memory')));

    // the workflow + memory loop as a node graph with live numbers
    const lvAll = ov.projects.flatMap((p) => p.levels.map((l) => ({ ...l, project: p.id })));
    const inProgress = lvAll.filter((l) => levelState(l.status)[0] === 'live');
    const merged = lvAll.filter((l) => levelState(l.status)[0] === 'good').length;
    const shadow = ov.projects.filter((p) => p.mode === 'shadow').length;
    const nodes = [
      { id: 'director', x: 16, y: 36, title: 'Director', sub: `${c.runner} hỏi · ${c.draft} nháp · ${c.triage} triage`, icon: 'user', count: decisions || null, countTone: c.runner ? 'bad' : 'warn', state: c.runner ? 'bad' : decisions ? 'warn' : 'good', onPick: () => go('quests'), tip: 'Việc chờ bạn quyết: câu hỏi runner, bảng nháp verdict, triage' },
      { id: 'runner', x: 262, y: 36, title: 'Runner', sub: `${live.length} đang chạy`, icon: 'bolt', state: live.length ? 'live' : 'idle', onPick: () => go('worlds'), tip: live.map((p) => `${p.id}: ${p.runner.slice} · ${p.runner.step}`).join('\n') || 'Không runner nào chạy' },
      { id: 'lane', x: 508, y: 36, title: 'Lane', sub: inProgress.map((l) => `${l.slice} ${l.project.replace(/^cc-/, '')}`).slice(0, 2).join(' · ') || 'không slice nào', icon: 'layers', count: inProgress.length || null, state: inProgress.length ? 'live' : 'idle', onPick: () => go(inProgress[0] ? `worlds/${inProgress[0].project}` : 'worlds'), tip: 'Slice đang làm (fleet hoặc single lane)' },
      { id: 'merge', x: 754, y: 36, title: 'Merge', sub: `${merged} slice đã merge`, icon: 'merge', state: 'good', onPick: () => go('worlds'), tip: 'Merge journal: memory_review → harvest → merge → verify → record' },
      { id: 'refresh', x: 754, y: 236, title: 'Refresh', sub: rf ? ago(rf.at) : 'chưa chạy', icon: 'refresh', count: c.triage || null, countTone: 'warn', state: rf?.ok && !rf.stale ? 'good' : 'bad', onPick: () => go('memory'), tip: '09:03 hằng ngày: backup → normalize → verify → rebuild-index' },
      { id: 'archive', x: 508, y: 236, title: 'Kho', sub: `${ov.memory.records} record`, icon: 'archive', state: 'good', onPick: () => go('memory'), tip: `${ov.memory.active} record đang được dùng trong pack` },
      { id: 'pack', x: 262, y: 236, title: 'Pack', sub: `${assist} assist · ${shadow} shadow`, icon: 'pack', state: assist ? 'live' : shadow ? 'good' : 'idle', onPick: () => go('memory'), tip: 'Hook plan/review tạo pack cho slice; assist thì agent đọc được' },
      { id: 'verdict', x: 16, y: 236, title: 'Verdict', sub: `${c.draft} bảng nháp chờ`, icon: 'flask', count: c.draft || null, countTone: 'warn', state: c.draft ? 'warn' : 'good', onPick: () => go('pilot'), tip: 'Drafter 09:41 soạn verdict cho slice đã merge; bạn xác nhận' },
    ];
    const edges = [
      { from: 'director', to: 'runner', state: c.runner ? 'on' : '', label: 'trả lời' },
      { from: 'runner', to: 'lane', state: live.length ? 'on' : '' },
      { from: 'lane', to: 'merge', state: inProgress.length ? 'on' : '' },
      { from: 'merge', to: 'refresh', state: 'done', label: 'harvest' },
      { from: 'refresh', to: 'archive', state: 'done' },
      { from: 'archive', to: 'pack', state: 'done' },
      { from: 'pack', to: 'runner', state: assist ? 'on' : '', label: 'pack cho slice sau' },
      { from: 'pack', to: 'verdict', state: '', label: 'judge' },
      { from: 'verdict', to: 'director', state: c.draft ? 'on' : '' },
    ];
    const flow = panel('Luồng workflow · memory', { icon: 'map', sub: 'Nhấn vào một node để đi tới chỗ xử lý. Đường hồng chạy = đang có việc.' },
      h('div', { class: 'graph-wrap' }, flowGraph(nodes, edges, { width: 946, height: 316 })));

    // worlds: each project as a compact level strip
    const worlds = panel('Dự án', { icon: 'globe', right: btn('Xem tất cả', () => go('worlds'), { cls: 'ghost sm', ic: 'chev' }) },
      withLevels.length ? h('div', { class: 'grid cols-3' }, withLevels.map(worldCard)) : empty('Chưa có dự án nào dùng producer.'));

    const qs = allQuests().filter((q) => q.type !== 'manual').slice(0, 4);
    const quests = panel('Việc chờ bạn', { icon: 'flag', right: btn('Mở danh sách', () => go('quests'), { cls: 'ghost sm', ic: 'chev' }) },
      qs.length ? qs.map((q) => questMini(q)) : empty('Không có gì chờ bạn quyết. 🎯'));
    return [stats, h('div', { style: { height: '16px' } }), flow, h('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, quests, worlds)];
  };

  function worldCard(p) {
    const done = p.levels.filter((l) => levelState(l.status)[0] === 'good').length;
    const cur = p.levels.find((l) => levelState(l.status)[0] === 'live');
    const pct = p.levels.length ? Math.round((done / p.levels.length) * 100) : 0;
    const status = p.runner ? (p.runner.alive ? h('span', { class: 'chip accent' }, h('span', { class: 'pip live' }), `chạy ${p.runner.slice ?? ''}`) : chip(p.runner.step === 'done' ? 'nghỉ' : `dừng · ${p.runner.step ?? '—'}`, 'outline')) : chip('không runner', 'outline');
    return h('button', { class: `world ${route.arg === p.id ? 'on' : ''}`, type: 'button', onclick: () => go(`worlds/${p.id}`) },
      h('div', { class: 'world-h' }, h('b', { class: 'grow' }, p.id), p.mode ? chip(p.mode, modeTone(p.mode)) : chip('chưa đăng ký', 'bad'), p.runner?.open_questions ? h('span', { class: 'badge' }, p.runner.open_questions) : null),
      h('div', { class: 'row small ink2' }, status, h('span', { class: 'grow' }), `${done}/${p.levels.length} slice`, cur ? ` · đang ${cur.slice}` : ''),
      h('div', { class: 'xp', title: `${pct}% slice đã xong` }, h('i', { style: { width: `${pct}%` } })),
      h('div', { class: 'graph-wrap' }, levelMap(p.levels, { size: 's' })));
  }

  // ======== quests
  function allQuests() {
    const p = store.ov.pending;
    const out = [];
    for (const q of p.questions) out.push({ type: 'runner', project: q.project, at: q.asked_at, text: `${q.kind} ${q.slice ?? ''} ${q.text}`, data: q });
    for (const d of p.drafts) out.push({ type: 'draft', project: d.project, at: d.created_at, text: `${d.slice} ${d.rows.map((r) => r.record).join(' ')}`, data: d });
    for (const t of p.triage) out.push({ type: 'triage', project: t.source.split(':')[0], at: null, text: `${t.source} ${t.reason}`, data: t });
    if (p.refresh && (!p.refresh.ok || p.refresh.stale)) out.push({ type: 'system', project: '', at: p.refresh.at, text: 'refresh', data: { kind: 'refresh', ...p.refresh } });
    for (const u of p.unregistered) out.push({ type: 'system', project: u.path.split('/').pop(), at: u.last_task_at, text: u.path, data: { kind: 'unregistered', ...u } });
    for (const d of p.manual_deferred) out.push({ type: 'manual', project: d.project, at: null, text: `${d.slice} ${d.items.join(' ')}`, data: d });
    return out;
  }
  const QTYPES = [['all', 'Tất cả', 'flag'], ['runner', 'Runner hỏi', 'alert'], ['draft', 'Verdict', 'flask'], ['triage', 'Triage', 'archive'], ['system', 'Hệ thống', 'refresh'], ['manual', 'Kiểm tra tay', 'hand']];

  VIEWS.quests = async () => {
    const qs = allQuests();
    const count = (t) => (t === 'all' ? qs.filter((q) => q.type !== 'manual').length : qs.filter((q) => q.type === t).length);
    const seg = h('div', { class: 'seg', role: 'tablist' }, QTYPES.map(([t, label, ic]) =>
      h('button', { class: ui.questType === t ? 'on' : '', type: 'button', onclick: () => { ui.questType = t; render(); } }, icon(ic, 14), label, h('span', { class: 'badge soft' }, count(t)))));
    const projects = [...new Set(qs.map((q) => q.project).filter(Boolean))].sort();
    const projSel = h('select', { class: 'input', style: { width: 'auto' }, onchange: (e) => { ui.questProject = e.target.value; render(); } },
      h('option', { value: '' }, 'Mọi dự án'), projects.map((p) => h('option', { value: p, selected: ui.questProject === p }, p)));
    const search = h('input', { class: 'input', placeholder: 'Lọc theo chữ…', value: ui.questQ });
    search.addEventListener('input', () => { ui.questQ = search.value; drawList(); });
    const listEl = h('div', { style: { marginTop: '20px' } });
    const drawList = () => {
      const needle = ui.questQ.toLowerCase();
      const shown = qs.filter((q) => (ui.questType === 'all' ? q.type !== 'manual' : q.type === ui.questType)
        && (!ui.questProject || q.project === ui.questProject) && (!needle || q.text.toLowerCase().includes(needle) || q.project.toLowerCase().includes(needle)));
      const order = { runner: 0, system: 1, draft: 2, triage: 3, manual: 4 };
      shown.sort((a, b) => order[a.type] - order[b.type]);
      listEl.replaceChildren(...(shown.length ? shown.map(questCard) : [empty(ui.questType === 'manual' ? 'Không có check thủ công nào khớp.' : 'Không có việc nào khớp bộ lọc.')]));
    };
    drawList();
    const filters = h('div', { class: 'panel' }, h('div', { class: 'row' }, seg), h('div', { class: 'row', style: { marginTop: '10px' } },
      h('div', { class: 'search grow' }, icon('search', 15), search), projSel));
    return [filters, listEl];
  };

  function questMini(q) {
    const META = {
      runner: () => ['alert', 'Runner hỏi', 'q-runner', `${q.data.kind} · ${q.data.slice ?? ''}`],
      draft: () => ['flask', 'Bảng nháp verdict', 'q-draft', `${q.data.slice} · ${q.data.rows.length} dòng`],
      triage: () => ['archive', 'Triage', 'q-triage', q.data.reason],
      system: () => ['refresh', 'Hệ thống', 'q-system', q.data.kind === 'refresh' ? 'refresh kho lỗi hoặc cũ' : `chưa đăng ký memory: ${q.data.path.split('/').pop()}`],
    };
    const meta = META[q.type]();
    return h('div', { class: `quest mini ${meta[2]}`, role: 'button', tabindex: 0, style: { cursor: 'pointer' }, onclick: () => { ui.questType = q.type; go('quests'); } },
      h('div', { class: 'quest-h' }, qtag(meta[0], meta[1]), q.project ? chip(q.project, 'outline') : null, h('span', { class: 'grow' }), q.at ? h('span', { class: 'small muted' }, ago(q.at)) : null),
      h('div', { class: 'small ink2', style: { marginTop: '4px' } }, meta[3]));
  }

  function questCard(q) {
    if (q.type === 'runner') return runnerCard(q.data);
    if (q.type === 'draft') return draftCard(q.data);
    if (q.type === 'triage') return triageCard(q.data);
    if (q.type === 'manual') return manualCard(q.data);
    return systemCard(q.data);
  }

  function longText(text, limit = 700) {
    const box = h('div', { class: 'quest-body' });
    if (text.length <= limit) { box.textContent = text; return box; }
    let open = false;
    const more = h('button', { class: 'btn ghost sm', type: 'button' }, 'Xem thêm');
    const draw = () => { box.textContent = open ? text : `${text.slice(0, limit)}…`; more.textContent = open ? 'Thu gọn' : 'Xem thêm'; };
    more.addEventListener('click', () => { open = !open; draw(); });
    draw();
    return h('div', {}, box, more);
  }

  function runnerCard(q) {
    const note = h('textarea', { class: 'input', placeholder: 'Ghi chú / câu trả lời cho lane (bắt buộc với lựa chọn có dấu *)' });
    const opts = q.options.map((o) => btn(o.choice + (o.note === 'required' ? ' *' : ''), () => {
      if (o.note === 'required' && !note.value.trim()) { toast('Lựa chọn này cần ghi chú.', true); note.focus(); return; }
      act('runner.answer', { project: q.project, id: q.id, choice: o.choice, text: note.value }, {
        title: `Trả lời ${q.project} ${q.id}`, body: `Lựa chọn: ${o.choice}${note.value.trim() ? `\nGhi chú: ${note.value.trim()}` : ''}`, ok: 'Gửi cho runner',
        danger: /^stop/i.test(o.choice),
      });
    }, { cls: /^stop/i.test(o.choice) ? 'danger' : '', title: o.note === 'required' ? 'Cần ghi chú' : null }));
    return h('div', { class: 'quest q-runner' },
      h('div', { class: 'quest-h' }, qtag('alert', 'Runner hỏi'), chip(q.project, 'outline'), q.slice ? chip(q.slice, 'accent') : null, chip(q.kind, 'warn'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${q.id} · ${ago(q.asked_at)}`)),
      longText(q.text),
      q.detail && q.detail !== q.text ? h('details', { style: { marginTop: '6px' } }, h('summary', {}, 'Chi tiết'), h('pre', { class: 'code' }, q.detail)) : null,
      h('div', { style: { marginTop: '10px' } }, note),
      h('div', { class: 'quest-actions' }, opts));
  }

  function draftCard(d) {
    const picks = d.rows.map((r) => ({ r, verdict: r.verdict, ok: !!r.confirmed }));
    const rowsEl = h('div');
    const counter = h('span', { class: 'small muted' });
    const applyBtn = btn('Ghi vào ledger', null, { cls: 'primary', ic: 'check' });
    const drawRows = () => {
      rowsEl.replaceChildren(...picks.map((p) => {
        const pills = h('div', { class: 'row', style: { gap: '5px' } }, VERDICTS.map((v) =>
          h('button', { class: `vpill ${p.verdict === v ? 'on' : ''}`, type: 'button', title: VHELP[v], style: { '--vc': `var(--v-${v})` },
            onclick: () => { p.verdict = v; p.ok = true; drawRows(); } }, h('span', { class: 'swatch', style: { background: `var(--v-${v})` } }), VLABEL[v])));
        const cb = h('input', { type: 'checkbox', checked: p.ok && !!p.verdict, disabled: !p.verdict });
        cb.addEventListener('change', () => { p.ok = cb.checked; drawCount(); });
        const rec = h('button', { class: 'btn ghost sm mono', type: 'button', style: { justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', height: 'auto', padding: '2px 6px' }, onclick: () => openRecord(p.r.record) }, p.r.record);
        return h('div', { class: 'verdict-row' },
          h('div', {}, rec, h('div', { class: 'row', style: { marginTop: '3px' } }, chip(p.r.stage, 'outline'), p.r.confidence ? chip(`tin cậy ${p.r.confidence}`, p.r.confidence === 'low' ? 'warn' : 'good') : null)),
          pills,
          h('div', { class: 'small ink2' }, p.r.evidence ?? ''),
          h('label', { class: 'check' }, cb, 'xác nhận'));
      }));
      drawCount();
    };
    const drawCount = () => {
      const n = picks.filter((p) => p.ok && p.verdict).length;
      counter.textContent = `${n}/${picks.length} dòng sẽ được ghi`;
      applyBtn.disabled = !n;
    };
    applyBtn.addEventListener('click', () => {
      const rows = picks.map((p) => ({ stage: p.r.stage, record: p.r.record, verdict: p.verdict || null, confirmed: p.ok && !!p.verdict }));
      const n = rows.filter((r) => r.confirmed).length;
      const useful = rows.filter((r) => r.confirmed && r.verdict === 'useful').length;
      act('draft.apply', { file: d.file, rows }, { title: `Ghi ${n} verdict · ${d.project} ${d.slice}`, body: `${useful} useful. Verdict là số liệu của pilot M08; ghi xong không sửa được qua console.`, ok: 'Ghi vào ledger' });
    });
    drawRows();
    const bulk = h('div', { class: 'row' },
      btn('Xác nhận các dòng tin cậy cao', () => { picks.forEach((p) => { if (p.verdict && p.r.confidence === 'high') p.ok = true; }); drawRows(); }, { cls: 'sm', ic: 'check' }),
      btn('Xác nhận tất cả có verdict', () => { picks.forEach((p) => { if (p.verdict) p.ok = true; }); drawRows(); }, { cls: 'sm' }),
      btn('Bỏ chọn', () => { picks.forEach((p) => { p.ok = false; }); drawRows(); }, { cls: 'ghost sm' }));
    return h('div', { class: 'quest q-draft' },
      h('div', { class: 'quest-h' }, qtag('flask', 'Bảng nháp verdict'), chip(d.project, 'outline'), chip(d.slice, 'accent'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${d.model} · ${ago(d.created_at)}`)),
      h('p', { class: 'small muted', style: { margin: '6px 0' } }, 'Drafter đọc record theo nghĩa đen; các dòng useful hoặc tin cậy thấp cần bạn xem kỹ.'),
      h('div', { class: 'legend' }, VERDICTS.map((v) => h('span', { title: VHELP[v] }, h('span', { class: 'swatch', style: { background: `var(--v-${v})` } }), `${VLABEL[v]}: ${VHELP[v]}`))),
      bulk, rowsEl, h('div', { class: 'quest-actions', style: { alignItems: 'center' } }, applyBtn, counter));
  }

  function triageCard(t) {
    return h('div', { class: 'quest q-triage' },
      h('div', { class: 'quest-h' }, qtag('archive', 'Triage'), chip(t.source.split(':')[0], 'outline')),
      h('div', { class: 'mono small', style: { marginTop: '6px' } }, t.source), h('div', { class: 'quest-body' }, t.reason),
      h('div', { class: 'quest-actions' }, btn('Bỏ qua dòng này', () => act('triage.dismiss', { source: t.source }, {
        title: 'Bỏ qua dòng triage', body: `${t.source}\nÁp dụng ở lần refresh tiếp theo.`, fields: [{ name: 'note', label: 'Lý do', required: true }], ok: 'Bỏ qua',
      }), { ic: 'x' })));
  }

  function systemCard(s) {
    if (s.kind === 'refresh') {
      return h('div', { class: 'quest q-system' },
        h('div', { class: 'quest-h' }, qtag('refresh', 'Hệ thống'), h('b', {}, s.ok ? 'Kho lâu chưa refresh' : `Refresh lỗi ở ${s.failed_step}`), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, ago(s.at))),
        h('div', { class: 'quest-actions' }, btn('Chạy refresh ngay', () => act('memory.refresh', {}, { title: 'Chạy refresh kho', body: 'backup → normalize → verify → rebuild-index', ok: 'Chạy' }), { cls: 'primary', ic: 'refresh' })));
    }
    const cmd = `orca-memory register --path ${s.path} --domain cocos --data-owner <owner>`;
    return h('div', { class: 'quest q-system' },
      h('div', { class: 'quest-h' }, qtag('alert', 'Hệ thống'), h('b', {}, 'Dự án chưa đăng ký memory'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${s.tasks} task · ${ago(s.last_task_at)}`)),
      h('div', { class: 'mono small', style: { marginTop: '6px' } }, s.path),
      h('pre', { class: 'code' }, cmd),
      h('div', { class: 'quest-actions' }, btn('Chép lệnh', () => navigator.clipboard?.writeText(cmd).then(() => toast('Đã chép lệnh.')), { cls: 'sm', ic: 'doc' })));
  }

  function manualCard(d) {
    return h('div', { class: 'quest q-manual' },
      h('div', { class: 'quest-h' }, qtag('hand', 'Kiểm tra tay'), chip(d.project, 'outline'), chip(d.slice, 'accent'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${d.items.length} việc`)),
      h('ul', { style: { margin: '8px 0 0', paddingLeft: '18px' } }, d.items.map((i) => h('li', { class: 'small', style: { margin: '3px 0' } }, i))));
  }

  // ======== worlds
  VIEWS.worlds = async (id) => {
    const ov = store.ov;
    const list = h('div', { class: 'world-list' }, ov.projects.map(worldCard));
    if (!id) {
      const pick = ov.projects.find((p) => p.runner?.alive) ?? ov.projects.find((p) => p.levels.length);
      return h('div', { class: 'layout-worlds' }, list, panel('Chọn một dự án', { icon: 'globe' }, empty('Chọn một dự án bên trái để xem bản đồ slice, điều khiển runner và terminal.', 'globe'),
        pick ? h('div', { class: 'row', style: { justifyContent: 'center' } }, btn(`Mở ${pick.id}`, () => go(`worlds/${pick.id}`), { cls: 'primary', ic: 'chev' })) : null));
    }
    const d = store.proj[id] ?? (store.proj[id] = await api(`/api/project?id=${encodeURIComponent(id)}`));
    return h('div', { class: 'layout-worlds' }, list, h('div', {}, projectDetail(d)));
  };

  function projectDetail(d) {
    const meta = Object.fromEntries(d.slices.map((s) => [s.slice, { phase: s.memory?.phase, cited: s.memory?.cited?.length || 0, rounds: s.fix_rounds != null ? `fix ${s.fix_rounds} · review ${s.review_rounds ?? '—'}` : null }]));
    const levels = (store.ov.projects.find((p) => p.id === d.id)?.levels ?? []).length ? store.ov.projects.find((p) => p.id === d.id).levels : d.slices.map((s) => ({ slice: s.slice, status: s.status ?? 'planned', file: s.file }));
    const live = levels.find((l) => levelState(l.status)[0] === 'live');
    const sel = ui.worldSlice[d.id] ?? live?.slice ?? levels.at(-1)?.slice;
    const r = d.runner;

    const header = panel(d.id, {
      icon: 'globe', right: h('div', { class: 'row' }, d.mode ? chip(`memory ${d.mode}`, modeTone(d.mode)) : chip('chưa đăng ký memory', 'bad'),
        r ? (r.alive ? h('span', { class: 'chip accent' }, h('span', { class: 'pip live' }), `runner chạy · ${r.slice} ${r.step}`) : chip(`runner dừng · ${r.slice ?? '—'} ${r.step ?? ''}`, 'outline')) : chip('không runner', 'outline')),
    },
    h('div', { class: 'mono small muted' }, d.path),
    d.release ? h('div', { class: 'small ink2', style: { marginTop: '2px' } }, `release.goal ${d.release.goal ?? '—'} · current_slice ${d.release.current_slice || '—'}`) : null,
    r ? controlDeck(d) : null);

    const map = panel('Bản đồ slice', { icon: 'map', sub: 'Mỗi lục giác là một slice: xanh lá = đã merge/ship, vàng nhún nhảy = đang làm, trắng = chưa làm, cam = bị chặn. Số hồng = record memory được trích dẫn.' },
      h('div', { class: 'graph-wrap', id: 'lvl-wrap' }, levelMap(levels, { meta, selected: sel, onPick: (lv) => { ui.worldSlice[d.id] = lv.slice; render(); } })));
    setTimeout(() => { // keep the selected level in view
      const wrap = document.getElementById('lvl-wrap');
      const node = wrap?.querySelector('.lvl.sel');
      if (wrap && node) wrap.scrollLeft = Math.max(0, node.getBBox().x - wrap.clientWidth / 2);
    }, 0);

    const s = d.slices.find((x) => x.slice === sel);
    const detail = s ? sliceDetail(d, s) : panel('Slice', {}, empty('Chọn một slice trên bản đồ.'));
    const terms = panel(`Terminal Orca · ${d.terminals.length}`, { icon: 'terminal' },
      d.terminals.length ? d.terminals.map((t) => h('div', { class: 'quest mini' },
        h('div', { class: 'quest-h' }, icon('terminal', 15), h('b', {}, t.title ?? t.handle), t.agent ? chip(t.agent, 'outline') : null, h('span', { class: `pip ${t.connected ? 'good' : 'bad'}` }), h('span', { class: 'grow' }), h('span', { class: 'mono small muted' }, t.handle.slice(0, 18))),
        h('details', { style: { marginTop: '4px' } }, h('summary', { class: 'small' }, `output cuối · ${t.last_output_at ? ago(new Date(t.last_output_at).toISOString()) : '—'}`), h('pre', { class: 'code' }, t.preview || '(trống)'))))
        : empty('Không có terminal Orca nào của dự án này.', 'terminal'));
    return [header, map, detail, terms];
  }

  function controlDeck(d) {
    const ctl = (cmd, label, ic, cls, body) => btn(label, () => act('runner.control', { project: d.id, cmd }, { title: `${label} runner · ${d.id}`, body, ok: label, danger: cmd === 'stop' }), { cls: `sm ${cls}`, ic });
    const after = h('input', { class: 'input', placeholder: 'S09', style: { width: '74px', height: '28px', padding: '2px 8px' } });
    const r = d.runner;
    return h('div', { class: 'deck', style: { marginTop: '12px' } },
      h('span', { class: 'small muted hud' }, 'ĐIỀU KHIỂN'),
      ctl('pause', 'Tạm dừng', 'pause', '', 'Runner dừng ở bước an toàn tiếp theo; resume để chạy tiếp.'),
      ctl('stop', 'Dừng', 'stop', 'danger', 'Runner dừng hẳn sau bước hiện tại.'),
      ctl('clear', 'Xoá lệnh điều khiển', 'x', 'ghost', 'Bỏ pause/stop/stop-after đang đặt.'),
      h('span', { class: 'grow' }),
      after, btn('Dừng sau slice', () => {
        const sl = after.value.trim().toUpperCase();
        if (!/^S\d{2}[A-Z]?$/i.test(sl)) { toast('Nhập slice dạng S09.', true); return; }
        act('runner.control', { project: d.id, cmd: 'stop-after', slice: sl }, { title: `Dừng ${d.id} sau ${sl}`, ok: 'Đặt' });
      }, { cls: 'sm', ic: 'flag' }),
      h('span', { class: 'small muted' }, r.control ? `đang đặt: ${r.control.cmd}${r.control.arg ? ` ${r.control.arg}` : ''}` : r.lock ? `lock pid ${r.lock.pid}` : 'không lock'));
  }

  function sliceDetail(d, s) {
    const [state, , label] = levelState(s.status ?? 'planned');
    const tone = { good: 'good', live: 'accent', bad: 'bad' }[state] ?? 'outline';
    const mem = s.memory;
    const steps = s.merge ? Object.entries(s.merge) : [];
    const timeline = steps.length ? h('div', { class: 'timeline' }, steps.map(([k, v]) => {
      const bad = /fail|error|lỗi|kept/i.test(String(v)) && !/no orca-memory launcher/.test(String(v));
      const warn = /^off:|not merged|skipped|nothing/i.test(String(v));
      return h('div', { class: 'tl' }, h('span', { class: `dot ${bad ? 'bad' : warn ? 'warn' : ''}` }), h('div', {}, h('b', { class: 'small hud' }, k), h('div', { class: 'small ink2' }, String(v))));
    })) : h('div', { class: 'small muted' }, 'Chưa có merge journal (slice chưa merge hoặc không dùng runner).');
    const memBox = mem ? h('div', {},
      h('div', { class: 'row' }, chip(`memory ${mem.phase ?? '—'}`, modeTone(mem.phase)), chip(`${mem.packs} pack`, 'outline'), chip(`${mem.injected_tokens} token đưa vào`, 'outline'), chip(`${mem.cited.length} trích dẫn`, mem.cited.length ? 'good' : 'outline', 'star'),
        mem.unjudged ? chip(`${mem.unjudged} chưa judge`, 'warn') : null),
      h('div', { class: 'small ink2', style: { marginTop: '6px' } }, `verdict u/r/i/m/s: ${VERDICTS.map((v) => mem.verdicts[v]).join('/')}`),
      mem.cited.length ? h('div', { style: { marginTop: '6px' } }, mem.cited.map((c) => h('button', { class: 'btn ghost sm mono', type: 'button', onclick: () => openRecord(c), style: { height: 'auto', padding: '2px 6px', whiteSpace: 'normal', textAlign: 'left' } }, c))) : null)
      : h('div', { class: 'small muted' }, 'Slice này không nằm trong pilot memory.');
    return panel(`Slice ${s.slice}`, { icon: 'doc', right: chip(label, tone) },
      h('div', { class: 'grid cols-2' },
        h('div', {},
          s.file ? h('div', { class: 'mono small muted' }, s.file) : null,
          s.handoff ? h('div', { class: 'small', style: { marginTop: '4px' } }, `HANDOFF: ${s.handoff.role ?? ''} ${s.handoff.status ?? ''}`) : null,
          h('div', { class: 'row', style: { marginTop: '8px' } }, chip(`fix ${s.fix_rounds ?? '—'}`, 'outline'), chip(`review ${s.review_rounds ?? '—'}`, 'outline'), s.manual_deferred.length ? chip(`${s.manual_deferred.length} kiểm tra tay`, 'warn', 'hand') : null),
          h('h4', { class: 'hud small muted', style: { margin: '14px 0 6px' } }, 'MEMORY'), memBox,
          s.manual_deferred.length ? h('details', { style: { marginTop: '10px' } }, h('summary', { class: 'small' }, `Kiểm tra tay (${s.manual_deferred.length})`), h('ul', { class: 'small' }, s.manual_deferred.map((i) => h('li', {}, i)))) : null),
        h('div', {}, h('h4', { class: 'hud small muted', style: { margin: '0 0 6px' } }, 'MERGE JOURNAL'), timeline)));
  }

  // ======== memory
  VIEWS.memory = async () => {
    const m = store.mem = await api('/api/memory');
    const modes = panel('Mode memory của từng dự án', { icon: 'chip', sub: 'off: không pack · shadow: tạo pack để đo, agent không thấy · assist: agent đọc pack. Đổi mode cần lý do và được ghi lịch sử.' },
      m.modes.map((p) => h('div', { class: 'row', style: { padding: '8px 0', borderTop: '1px solid var(--line)' } },
        h('div', { class: 'grow' }, h('b', {}, p.id), h('div', { class: 'small muted' }, p.notes ?? '')),
        h('div', { class: 'seg' }, ['off', 'capture-only', 'shadow', 'assist'].map((mode) => h('button', {
          class: p.mode === mode ? 'on' : '', type: 'button',
          onclick: () => {
            if (p.mode === mode) return;
            act('memory.mode', { project: p.id, mode }, {
              title: `${p.id}: ${p.mode} → ${mode}`, body: mode === 'assist' ? 'Pack sẽ đi thẳng vào agent ở slice tiếp theo.' : null,
              fields: [{ name: 'note', label: 'Lý do', required: true, placeholder: 'vd. thử assist từ S09' }], ok: 'Đổi mode',
            });
          },
        }, mode))))));

    const a = m.archive;
    const bars = (obj) => {
      const rows = Object.entries(obj).sort((x, y) => y[1] - x[1]);
      const max = Math.max(...rows.map(([, v]) => v), 1);
      return h('div', { class: 'barlist' }, rows.map(([k, v]) => {
        const row = h('div', { class: 'br' }, h('span', { class: 'ink2', style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } }, k), h('div', { class: 'track' }, h('div', { class: 'fill', style: { width: `${(v / max) * 100}%` } })), h('span', { class: 'val' }, v));
        tipOn(row, `${k}: ${v} record`);
        return row;
      }));
    };
    const lifecycle = h('div', { class: 'stats' }, Object.entries(a.by_lifecycle).map(([k, v]) => h('div', { class: `stat ${k === 'active' ? 's-green' : 's-blue'}` }, h('div', { class: 'label' }, k), h('div', { class: 'value' }, v))));
    const archive = panel(`Kho bài học · ${a.records} record`, { icon: 'archive' }, lifecycle,
      h('div', { class: 'grid cols-2', style: { marginTop: '14px' } },
        h('div', {}, h('div', { class: 'small muted hud', style: { marginBottom: '8px' } }, 'THEO DỰ ÁN'), bars(a.by_project)),
        h('div', {}, h('div', { class: 'small muted hud', style: { marginBottom: '8px' } }, 'THEO LOẠI'), bars(a.by_kind))));

    const rf = m.refresh;
    const refresh = panel('Refresh kho', {
      icon: 'refresh', right: btn('Chạy ngay', () => act('memory.refresh', {}, { title: 'Chạy refresh kho', body: 'backup → normalize → verify → rebuild-index (có thể mất vài chục giây).', ok: 'Chạy' }), { cls: 'sm', ic: 'refresh' }),
      sub: 'Tự chạy 09:03 hằng ngày. Bài học của slice merge sau giờ đó vào kho hôm sau.',
    },
    rf ? h('div', { class: 'row' }, chip(rf.ok ? 'ổn' : `lỗi ở ${rf.failed_step}`, rf.ok ? 'good' : 'bad', rf.ok ? 'check' : 'alert'), h('span', { class: 'small ink2' }, `${when(rf.at)} · ${ago(rf.at)}`), chip(`${rf.triage_open.length} triage`, rf.triage_open.length ? 'warn' : 'outline')) : empty('Chưa refresh lần nào.'),
    m.refresh_log.length ? h('div', { class: 'scroll-x', style: { marginTop: '10px' } }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Lúc', 'Kết quả', 'Record', 'Mới', 'Triage'].map((x, i) => h('th', { class: i > 1 ? 'num' : '' }, x)))),
      h('tbody', {}, m.refresh_log.map((r) => h('tr', {}, h('td', {}, when(r.at)), h('td', {}, r.ok ? chip('ok', 'good', 'check') : chip(`lỗi ${r.failed_step}`, 'bad', 'alert')), h('td', { class: 'num' }, r.records ?? '—'), h('td', { class: 'num' }, r.created ?? '—'), h('td', { class: 'num' }, r.triage_open)))))) : null);

    const feed = h('div', { class: 'grid cols-2' },
      panel('Hook gần đây', { icon: 'bolt' }, h('div', { class: 'scroll-x' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ['Lúc', 'Dự án · task', 'Stage', 'Mode', 'Kết quả'].map((x) => h('th', {}, x)))),
        h('tbody', {}, m.hook_log.slice(0, 25).map((r) => h('tr', {}, h('td', { class: 'small' }, ago(r.at)), h('td', { class: 'small' }, `${(r.project ?? '—').replace(/^cc-/, '')} · ${r.task ?? '—'}`), h('td', {}, r.stage), h('td', {}, r.mode ? chip(r.mode, modeTone(r.mode)) : '—'),
          h('td', {}, chip(`${r.status}${r.items != null ? ` · ${r.items}` : ''}`, r.status === 'ok' || r.status === 'harvested' ? 'good' : r.status === 'unregistered' || r.status === 'error' ? 'bad' : 'outline')))))))),
      panel('Lịch sử đổi mode', { icon: 'clock' }, m.mode_log.length ? h('div', { class: 'timeline' }, m.mode_log.map((r) => h('div', { class: 'tl' }, h('span', { class: 'dot' }),
        h('div', {}, h('div', { class: 'row' }, h('b', {}, r.project), chip(`${r.from} → ${r.to}`, modeTone(r.to)), h('span', { class: 'small muted' }, when(r.at))), h('div', { class: 'small ink2' }, r.note))))) : empty('Chưa đổi mode lần nào.', 'clock')));

    return [modes, h('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, archive, refresh), recordExplorer(m), h('div', { style: { height: '16px' } }), feed];
  };

  function recordExplorer(m) {
    const q = h('input', { class: 'input', placeholder: 'Tìm theo id, nội dung, topic… (Enter)', value: ui.recQ });
    const proj = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'Mọi dự án'), Object.keys(m.archive.by_project).sort().map((p) => h('option', { value: p, selected: ui.recProject === p }, p)));
    const kindSeg = h('div', { class: 'seg' }, ['', ...Object.keys(m.archive.by_kind)].map((k) => h('button', { type: 'button', class: ui.recKind === k ? 'on' : '', onclick: () => { ui.recKind = k; run(); } }, k || 'mọi loại')));
    const lifeSeg = h('div', { class: 'seg' }, ['', ...Object.keys(m.archive.by_lifecycle)].map((k) => h('button', { type: 'button', class: ui.recLife === k ? 'on' : '', onclick: () => { ui.recLife = k; run(); } }, k || 'mọi trạng thái')));
    const out = h('div', { style: { marginTop: '12px' } });
    async function run() {
      ui.recQ = q.value; ui.recProject = proj.value;
      kindSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.textContent === 'mọi loại' ? '' : b.textContent) === ui.recKind));
      lifeSeg.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b.textContent === 'mọi trạng thái' ? '' : b.textContent) === ui.recLife));
      const rs = (await api(`/api/records?q=${encodeURIComponent(ui.recQ)}&project=${encodeURIComponent(ui.recProject)}`))
        .filter((r) => (!ui.recKind || r.kind === ui.recKind) && (!ui.recLife || r.lifecycle === ui.recLife));
      out.replaceChildren(rs.length ? h('div', { class: 'small muted', style: { marginBottom: '6px' } }, `${rs.length} record${rs.length === 100 ? ' (tối đa 100, lọc hẹp hơn để xem thêm)' : ''}`) : null,
        ...(rs.length ? rs.map((r) => h('div', { class: 'quest mini q-record', role: 'button', tabindex: 0, style: { cursor: 'pointer' }, onclick: () => openRecord(r.record_id) },
          h('div', { class: 'quest-h' }, h('span', { class: 'mono small' }, r.record_id), h('span', { class: 'grow' }), chip(r.kind, 'outline'), chip(r.topic, 'outline'), r.lifecycle !== 'active' ? chip(r.lifecycle, 'warn') : null),
          h('div', { class: 'small ink2', style: { marginTop: '4px' } }, r.claim))) : [empty('Không có record nào khớp.', 'search')]));
    }
    q.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    proj.addEventListener('change', run);
    const p = panel('Tìm record', { icon: 'search', sub: 'Nhấn vào record để xem nguồn, promote (bài học đã vào contract) hoặc retract (bài học sai).' },
      h('div', { class: 'row' }, h('div', { class: 'search grow' }, icon('search', 15), q), proj, btn('Tìm', run, { cls: 'primary sm', ic: 'search' })),
      h('div', { class: 'row', style: { marginTop: '8px' } }, kindSeg, lifeSeg), out);
    if (ui.recQ || ui.recProject || ui.recKind || ui.recLife) run();
    return p;
  }

  async function openRecord(id) {
    let r;
    try { r = await api(`/api/record?id=${encodeURIComponent(id)}`); } catch (e) { toast(`Không mở được ${id}: ${e.message}`, true); return; }
    const kv = (k, v) => (v == null || (Array.isArray(v) && !v.length) ? null : h('div', { class: 'small', style: { margin: '4px 0' } }, h('span', { class: 'muted' }, `${k}: `), Array.isArray(v) ? v.join(' · ') : String(v)));
    const actions = r.lifecycle === 'active' ? h('div', { class: 'row', style: { marginTop: '14px' } },
      btn('Promote', () => act('memory.promote', { record: r.record_id }, {
        title: `Promote ${r.record_id}`, body: 'Bài học đã nằm trong contract/template/skill/code; record rời khỏi pack sau lần refresh tiếp theo.',
        fields: [{ name: 'to', label: 'Nơi bài học đang nằm (file:dòng)', required: true }, { name: 'note', label: 'Lý do', required: true }], ok: 'Promote',
      }), { cls: 'primary', ic: 'star' }),
      btn('Retract', () => act('memory.retract', { record: r.record_id }, {
        title: `Retract ${r.record_id}`, body: 'Chỉ dùng khi bài học SAI. Record rời khỏi pack sau lần refresh tiếp theo.',
        fields: [{ name: 'note', label: 'Vì sao sai', required: true }], ok: 'Retract', danger: true,
      }), { cls: 'danger', ic: 'x' })) : h('div', { class: 'small muted', style: { marginTop: '12px' } }, `Record đang ở trạng thái ${r.lifecycle}.`);
    drawer(r.record_id,
      h('div', { class: 'row' }, chip(`r${r.revision}`, 'outline'), chip(r.lifecycle, r.lifecycle === 'active' ? 'good' : 'warn'), chip(r.kind, 'accent'), chip(r.topic, 'outline'), chip(r.sharing, 'outline')),
      h('div', { class: 'quest-body', style: { margin: '14px 0', fontSize: '14px' } }, r.claim),
      kv('Điều kiện', r.conditions), kv('Giới hạn', r.limitations), kv('Promote tới', r.promoted_to), kv('Fixed in', r.resolved_by), kv('Quan sát lúc', r.observed_at && when(r.observed_at)),
      kv('Nguồn', (r.source_refs ?? []).map((x) => x.uri)), actions,
      h('details', { style: { marginTop: '16px' } }, h('summary', { class: 'small' }, 'Toàn bộ record (JSON)'), h('pre', { class: 'code' }, JSON.stringify(r, null, 2))));
  }

  // ======== pilot
  VIEWS.pilot = async (arg) => {
    const reg = store.ov.projects.filter((p) => p.registered);
    ui.pilotProject = arg ?? ui.pilotProject ?? reg.find((p) => p.mode === 'assist')?.id ?? reg[0]?.id;
    const pick = h('div', { class: 'seg' }, reg.map((p) => h('button', { type: 'button', class: p.id === ui.pilotProject ? 'on' : '', onclick: () => go(`pilot/${p.id}`) }, p.id.replace(/^cc-/, ''))));
    const head = panel('Pilot memory M08', { icon: 'flask', sub: 'So sánh slice baseline (không memory), shadow (pack chỉ để đo) và assist (agent đọc pack).' }, pick);
    if (!ui.pilotProject) return [head, empty('Chưa có dự án nào đăng ký memory.')];
    const r = store.pilot[ui.pilotProject] = await api(`/api/pilot?project=${encodeURIComponent(ui.pilotProject)}`);
    if (!r.slices.length) return [head, panel('Chưa có số liệu', {}, empty('Dự án này chưa có slice nào được mark trong ledger.'))];
    const sum = (k) => r.slices.reduce((n, s) => n + (s.verdicts[k] ?? 0), 0);
    const cited = r.slices.reduce((n, s) => n + s.cited_ids.length, 0);
    const unjudged = r.slices.reduce((n, s) => n + (s.unjudged_items ?? 0), 0);
    const phases = ['baseline', 'shadow', 'assist'].map((ph) => [ph, r.slices.filter((s) => s.phase === ph).length]).filter(([, n]) => n);
    const tiles = h('div', { class: 'stats' },
      phases.map(([ph, n]) => h('div', { class: `stat ${ph === 'assist' ? 's-yellow' : ph === 'shadow' ? 's-pink' : 's-blue'}` }, h('div', { class: 'label' }, `slice ${ph}`), h('div', { class: 'value' }, n))),
      h('div', { class: 'stat s-green' }, h('div', { class: 'label' }, icon('check', 14), 'useful'), h('div', { class: 'value' }, sum('useful')), h('div', { class: 'foot' }, `${sum('redundant')} redundant · ${sum('irrelevant')} irrelevant`)),
      h('div', { class: 'stat s-lilac' }, h('div', { class: 'label' }, icon('star', 14), 'trích dẫn'), h('div', { class: 'value' }, cited), h('div', { class: 'foot' }, 'record agent khai báo đã dùng')),
      h('div', { class: `stat ${unjudged ? 's-coral' : 's-green'}` }, h('div', { class: 'label' }, 'chưa judge'), h('div', { class: 'value' }, unjudged), h('div', { class: 'foot' }, unjudged ? 'drafter sẽ soạn nháp' : 'đã judge hết')));
    const rows = r.slices.filter((s) => s.phase !== 'baseline').map((s) => ({ slice: s.slice, phase: s.phase, verdicts: s.verdicts, unjudged: s.unjudged_items }));
    const legend = h('div', { class: 'legend' }, VERDICTS.map((v) => h('span', { title: VHELP[v] }, h('span', { class: 'swatch', style: { background: `var(--v-${v})` } }), VLABEL[v])));
    const chart = panel('Verdict theo slice', { icon: 'chart', sub: 'Mỗi cột là một slice, chồng theo verdict. Số trên cột = tổng verdict; "8?" = 8 item chưa judge. Bảng bên dưới có đủ số liệu.' },
      rows.length ? [legend, h('div', { class: 'graph-wrap' }, verdictColumns(rows, { order: VERDICTS, label: VLABEL }))] : empty('Chỉ có slice baseline: chưa có pack nào để chấm.'));
    const table = panel('Bảng số liệu', { icon: 'list' }, h('div', { class: 'scroll-x' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Slice', 'Phase', 'Fix', 'Review', 'Lặp lại', 'Hook', 'Token vào', 'u/r/i/m/s', 'Trích dẫn', 'Deviation'].map((x, i) => h('th', { class: i >= 2 && i <= 6 ? 'num' : '' }, x)))),
      h('tbody', {}, r.slices.map((s) => h('tr', {},
        h('td', {}, h('b', { class: 'hud' }, s.slice)), h('td', {}, chip(s.phase, modeTone(s.phase === 'baseline' ? 'off' : s.phase))),
        h('td', { class: 'num' }, s.fix_rounds ?? '—'), h('td', { class: 'num' }, s.review_rounds ?? '—'), h('td', { class: 'num' }, s.recurring.length),
        h('td', { class: 'num' }, s.memory.hook_calls), h('td', { class: 'num' }, s.memory.injected_tokens),
        h('td', {}, VERDICTS.map((v) => s.verdicts[v]).join('/'), s.unjudged_items ? h('div', { class: 'small muted' }, `${s.unjudged_items} chưa judge`) : null),
        h('td', {}, s.cited_ids.length ? h('details', {}, h('summary', {}, s.cited_ids.length), s.cited_ids.map((c) => h('button', { class: 'btn ghost sm mono', type: 'button', onclick: () => openRecord(c), style: { height: 'auto', padding: '2px 4px', whiteSpace: 'normal', textAlign: 'left' } }, c))) : '0'),
        h('td', {}, s.deviations.length ? h('details', {}, h('summary', {}, s.deviations.length), s.deviations.map((x) => h('div', { class: 'small', style: { margin: '6px 0', maxWidth: '520px' } }, x))) : '')))))));
    const missing = r.missing_accounting?.length ? panel(`Thiếu số liệu · ${r.missing_accounting.length}`, { icon: 'alert' }, h('details', {}, h('summary', { class: 'small' }, 'Xem danh sách'), h('ul', { class: 'small' }, r.missing_accounting.map((x) => h('li', {}, x))))) : null;
    return [head, tiles, h('div', { style: { height: '16px' } }), chart, table, missing];
  };

  // ======== playbook
  VIEWS.playbook = async () => {
    const pb = store.pb ?? (store.pb = await api('/api/playbook'));
    const tagCount = {};
    for (const r of pb.recipes) for (const t of r.tags ?? []) tagCount[t] = (tagCount[t] ?? 0) + 1;
    const topTags = Object.entries(tagCount).sort((a, b) => b[1] - a[1]).slice(0, 18).map(([t]) => t);
    const sources = [...new Set(pb.recipes.map((r) => r.source_project).filter(Boolean))].sort();
    const q = h('input', { class: 'input', placeholder: 'Tìm recipe theo id, tóm tắt, tag…', value: ui.pbQ });
    const src = h('select', { class: 'input', style: { width: 'auto' } }, h('option', { value: '' }, 'Mọi dự án nguồn'), sources.map((s) => h('option', { value: s, selected: ui.pbSource === s }, s)));
    const tags = h('div', { class: 'row', style: { marginTop: '10px', gap: '6px' } });
    const grid = h('div', { class: 'grid cols-3', style: { marginTop: '14px' } });
    const count = h('span', { class: 'small muted' });
    const draw = () => {
      tags.replaceChildren(...topTags.map((t) => h('button', { type: 'button', class: `chip btn ${ui.pbTags.has(t) ? 'on' : ''}`, onclick: () => { if (ui.pbTags.has(t)) ui.pbTags.delete(t); else ui.pbTags.add(t); draw(); } }, `${t} · ${tagCount[t]}`)));
      const n = ui.pbQ.toLowerCase();
      const shown = pb.recipes.filter((r) => (!n || [r.id, r.summary, ...(r.tags ?? []), r.source_project].join(' ').toLowerCase().includes(n))
        && (!ui.pbSource || r.source_project === ui.pbSource) && [...ui.pbTags].every((t) => (r.tags ?? []).includes(t)));
      count.textContent = `${shown.length}/${pb.recipes.length} recipe`;
      grid.replaceChildren(...(shown.length ? shown.map((r) => h('button', { class: 'world', type: 'button', onclick: () => openRecipe(r) },
        h('div', { class: 'world-h' }, icon('book', 15), h('b', { class: 'grow mono', style: { fontFamily: 'var(--font-mono)', fontSize: '12.5px' } }, r.id), chip(r.status, r.status === 'stable' ? 'good' : 'outline')),
        h('div', { class: 'small', style: { color: 'var(--ink)' } }, r.summary),
        h('div', { class: 'row', style: { gap: '5px' } }, (r.tags ?? []).slice(0, 4).map((t) => chip(t, 'outline')), h('span', { class: 'grow' }), (r.reuses ?? []).length ? chip(`dùng lại ${(r.reuses ?? []).length}`, 'good') : null),
        h('div', { class: 'small muted' }, r.source_project ?? ''))) : [empty('Không có recipe nào khớp.', 'search')]));
    };
    q.addEventListener('input', () => { ui.pbQ = q.value; draw(); });
    src.addEventListener('change', () => { ui.pbSource = src.value; draw(); });
    draw();
    const kits = pb.kits ? panel('Kits', { icon: 'pack' }, kitList(pb.kits)) : null;
    return [panel(`Playbook · ${pb.recipes.length} recipe`, { icon: 'book', right: count },
      h('div', { class: 'row' }, h('div', { class: 'search grow' }, icon('search', 15), q), src, ui.pbTags.size ? btn('Bỏ lọc tag', () => { ui.pbTags.clear(); draw(); }, { cls: 'ghost sm' }) : null), tags, grid), kits];
  };

  function kitList(kits) {
    const list = Array.isArray(kits) ? kits : Array.isArray(kits.kits) ? kits.kits : Object.entries(kits).map(([id, v]) => ({ id, ...(typeof v === 'object' ? v : { value: v }) }));
    return h('div', { class: 'grid cols-3' }, list.map((k) => h('div', { class: 'quest', style: { margin: 0 } },
      h('div', { class: 'quest-h' }, icon('pack', 15), h('b', {}, k.id ?? k.name ?? 'kit'), k.version ? chip(`v${k.version}`, 'outline') : null),
      h('div', { class: 'small ink2', style: { marginTop: '4px' } }, k.summary ?? k.description ?? ''),
      h('details', { style: { marginTop: '6px' } }, h('summary', { class: 'small' }, 'Chi tiết'), h('pre', { class: 'code' }, JSON.stringify(k, null, 2))))));
  }

  async function openRecipe(r) {
    let text = '';
    try { text = (await api(`/api/recipe?path=${encodeURIComponent(r.path)}`)).text; } catch (e) { text = `Không đọc được: ${e.message}`; }
    drawer(r.id,
      h('div', { class: 'row' }, chip(r.status, r.status === 'stable' ? 'good' : 'outline'), chip(`r${r.revision}`, 'outline'), (r.engine_versions ?? []).map((v) => chip(v, 'outline')), (r.modes ?? []).map((v) => chip(v, 'outline'))),
      h('p', { class: 'ink2' }, r.summary), h('div', { class: 'mono small muted' }, r.path),
      h('div', { class: 'md', style: { marginTop: '10px' } }, md(text)));
  }

  /** Minimal markdown → DOM (headings, lists, code fences, inline code and bold), all as text nodes. */
  function md(text) {
    const out = [];
    const lines = text.split('\n');
    const inline = (s) => s.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean).map((part) =>
      part.startsWith('`') ? h('code', {}, part.slice(1, -1)) : part.startsWith('**') ? h('b', {}, part.slice(2, -2)) : part);
    let i = 0;
    while (i < lines.length) {
      const l = lines[i];
      if (l.startsWith('```')) {
        const buf = [];
        i++;
        while (i < lines.length && !lines[i].startsWith('```')) buf.push(lines[i++]);
        out.push(h('pre', { class: 'code' }, buf.join('\n')));
        i++;
        continue;
      }
      const hd = l.match(/^(#{1,3})\s+(.*)$/);
      if (hd) { out.push(h(`h${hd[1].length}`, {}, inline(hd[2]))); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ordered = /^\s*\d+\./.test(l);
        const items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(h('li', {}, inline(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''))));
        out.push(h(ordered ? 'ol' : 'ul', {}, items));
        continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(#{1,3}\s|```|\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++]);
      out.push(h('p', {}, inline(para.join(' '))));
    }
    return out;
  }

  // ======== scorecard + log
  VIEWS.scorecard = async () => [panel('Workflow scorecard', { icon: 'chart', sub: 'Dashboard mới nhất do job scorecard 09:17 tạo.' },
    h('iframe', { class: 'score', src: `/scorecard?t=${encodeURIComponent(TOKEN)}`, sandbox: 'allow-scripts', title: 'Scorecard' }))];

  VIEWS.log = async () => {
    const a = store.actions = await api('/api/actions');
    return [panel('Nhật ký thao tác', { icon: 'list', sub: `Mọi thao tác ghi từ console chạy đúng CLI của hệ thống. Được phép: ${a.actions.join(', ')}.` },
      a.log.length ? h('div', { class: 'timeline' }, a.log.map((r) => h('div', { class: 'tl' }, h('span', { class: `dot ${r.code === 0 ? '' : 'bad'}` }),
        h('div', {}, h('div', { class: 'row' }, h('b', { class: 'mono small' }, r.action), chip(r.code === 0 ? 'ok' : `exit ${r.code}`, r.code === 0 ? 'good' : 'bad'), h('span', { class: 'small muted' }, `${when(r.at)} · ${ago(r.at)}`)),
          h('div', { class: 'small ink2' }, Object.entries(r.body ?? {}).map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`).join(' · ').slice(0, 260)),
          h('details', {}, h('summary', { class: 'small' }, 'Chi tiết'), h('pre', { class: 'code' }, JSON.stringify(r, null, 2))))))) : empty('Chưa có thao tác nào.', 'list'))];
  };

  // ---------------------------------------------------------------- command palette
  async function openPalette() {
    if (openOverlay) closeOverlay();
    const items = [
      ...ROUTES.map(([id, label, ic]) => ({ label, kind: 'trang', ic, go: id })),
      ...store.ov.projects.map((p) => ({ label: p.id, kind: `dự án · ${p.mode ?? 'chưa đăng ký'}`, ic: 'globe', go: `worlds/${p.id}` })),
      ...store.ov.projects.flatMap((p) => p.levels.map((l) => ({ label: `${p.id} ${l.slice}`, kind: `slice · ${levelState(l.status)[2]}`, ic: 'doc', pick: () => { ui.worldSlice[p.id] = l.slice; go(`worlds/${p.id}`); } }))),
      ...store.ov.projects.filter((p) => p.registered).map((p) => ({ label: `pilot ${p.id}`, kind: 'pilot', ic: 'flask', go: `pilot/${p.id}` })),
    ];
    if (!store.pb) api('/api/playbook').then((pb) => { store.pb = pb; }).catch(() => {});
    else items.push(...store.pb.recipes.map((r) => ({ label: r.id, kind: 'recipe', ic: 'book', pick: () => openRecipe(r) })));
    const input = h('input', { class: 'input', placeholder: 'Gõ để tìm trang, dự án, slice, recipe…' });
    const list = h('div', { class: 'list', role: 'listbox' });
    let shown = [], idx = 0;
    const choose = (it) => { closeOverlay(); if (it.go) go(it.go); else it.pick(); };
    const draw = () => {
      const n = input.value.toLowerCase().trim();
      shown = items.filter((it) => !n || n.split(/\s+/).every((w) => `${it.label} ${it.kind}`.toLowerCase().includes(w))).slice(0, 60);
      idx = Math.min(idx, Math.max(0, shown.length - 1));
      list.replaceChildren(...shown.map((it, i) => h('div', { class: `item ${i === idx ? 'on' : ''}`, role: 'option', onclick: () => choose(it) }, icon(it.ic, 16), it.label, h('span', { class: 'kind' }, it.kind))));
      list.querySelector('.item.on')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { idx = 0; draw(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { idx = Math.min(idx + 1, shown.length - 1); draw(); e.preventDefault(); }
      if (e.key === 'ArrowUp') { idx = Math.max(idx - 1, 0); draw(); e.preventDefault(); }
      if (e.key === 'Enter' && shown[idx]) choose(shown[idx]);
    });
    showOverlay(h('div', { class: 'modal palette', role: 'dialog', 'aria-label': 'Tìm nhanh' }, h('div', { class: 'search' }, icon('search', 15), input), list));
    draw();
    input.focus();
  }

  // ---------------------------------------------------------------- boot
  buildShell();
  readHash();
  window.addEventListener('hashchange', () => { closeOverlay(); render(); window.scrollTo(0, 0); });
  refresh(true);
  setInterval(() => { if (!document.hidden) refresh(false); }, 20000);
})();
