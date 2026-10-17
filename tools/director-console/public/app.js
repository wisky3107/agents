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
      else if (k === 'style' && typeof v === 'object') {
        // Object.assign drops custom properties (--c, --vc): those need setProperty
        for (const [sk, sv] of Object.entries(v)) if (sk.startsWith('--')) el.style.setProperty(sk, sv); else el.style[sk] = sv;
      }
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
  // The five verdicts are the orca-memory pilot's own vocabulary (src/pilot.ts); the ledger keeps the English key.
  const VLABEL = { useful: 'Hữu ích', redundant: 'Thừa', irrelevant: 'Không liên quan', misleading: 'Gây hiểu sai', stale: 'Lỗi thời' };
  const VINFO = {
    useful: {
      what: 'Bài học đúng, liên quan và agent thực sự dùng nó: có bằng chứng nó làm đổi cách làm hoặc kết quả (bắt được một lỗi, tránh được việc làm lại).',
      pick: 'Ghi chú hoặc review của slice trích dẫn bài học, hoặc một lỗi cụ thể được bắt nhờ nó.',
      effect: 'Số liệu chính của pilot: càng nhiều "Hữu ích" thì càng đáng bật assist cho dự án.',
    },
    redundant: {
      what: 'Bài học đúng và liên quan, nhưng agent đã biết sẵn từ PLAN, contract hoặc code của slice, nên không thêm giá trị.',
      pick: 'Ghi chú nói "đã đọc nhưng không cần", hoặc nội dung đã nằm trong PLAN/HOW_TO/code.',
      effect: 'Không hại, nhưng tốn token của pack. Nhiều "Thừa" nghĩa là nên promote bài học vào contract/template rồi bỏ khỏi memory.',
    },
    irrelevant: {
      what: 'Bài học không liên quan tới slice này (khác công nghệ, khác tính năng, hoặc điều kiện áp dụng không xảy ra).',
      pick: 'Điều kiện của bài học không khớp slice, hoặc slice không đụng tới phần đó.',
      effect: 'Pack bị nhiễu và tốn token vô ích: dấu hiệu bộ lọc truy xuất (retrieval) chọn chưa chuẩn.',
    },
    misleading: {
      what: 'Làm theo bài học này sẽ đi sai hướng hoặc gây lỗi.',
      pick: 'Có bằng chứng agent làm theo rồi phải sửa lại, hoặc nội dung mâu thuẫn với thực tế.',
      effect: 'Nghiêm trọng nhất. Nên Retract record (mở record → Retract) để nó không bao giờ vào pack nữa.',
    },
    stale: {
      what: 'Bài học từng đúng nhưng không còn đúng với code, engine hoặc workflow hiện tại.',
      pick: 'Code/template đã đổi, hoặc bài học đã được sửa tận gốc (fix đã merge).',
      effect: 'Nên Retract hoặc Promote record để nó rời pack ở lần refresh tới.',
    },
  };
  const VHELP = Object.fromEntries(Object.entries(VINFO).map(([k, v]) => [k, v.what]));
  const STAGE_VI = {
    plan: ['Lập kế hoạch', 'Pack đưa cho agent lúc viết PLAN của slice'],
    worker: ['Worker làm', 'Pack đưa cho worker (implement/art/integrate…) lúc làm việc'],
    review: ['Review', 'Pack đưa cho reviewer lúc kiểm tra slice'],
    check: ['Kiểm tra', 'Pack ở bước check trước review'],
    recover: ['Phục hồi', 'Pack khi lane bị kẹt và phải phục hồi'],
    retro: ['Tổng kết', 'Pack ở bước retro sau khi merge'],
    harvest: ['Thu hoạch', 'Bước thu bài học mới từ slice'],
  };
  const LIFE_VI = { promoted: 'đã promote vào contract/template', retracted: 'đã retract (sai)', superseded: 'đã bị thay thế' };
  const stageVi = (st) => STAGE_VI[String(st).split('-')[0]] ?? [st, ''];
  const CONF_VI = { high: ['cao', 'Drafter thấy bằng chứng rõ trong ghi chú/evidence của slice'], medium: ['vừa', 'Bằng chứng gián tiếp'], low: ['thấp', 'Drafter đoán hoặc bằng chứng yếu: bạn nên xem kỹ dòng này'] };
  /** Per-verdict counts as coloured swatch + number; zeros are dimmed. */
  const vcounts = (v) => h('span', { class: 'vcounts' }, VERDICTS.map((k) => h('span', { class: `vc ${v[k] ? '' : 'zero'}`, title: `${VLABEL[k]}: ${v[k] ?? 0}` }, h('span', { class: 'swatch', style: { background: `var(--v-${k})` } }), v[k] ?? 0)));
  /** The five verdicts, what each means, when to pick it and what it changes. */
  function verdictGuide(open = false) {
    return h('details', { class: 'vguide', open }, h('summary', {}, 'Cách chấm verdict: ý nghĩa từng loại'),
      h('p', { class: 'small muted', style: { margin: '8px 0' } }, 'Mỗi verdict chấm một bài học (record) memory đã đưa cho agent ở một slice: bài học đó có giúp gì không. Chấm theo bằng chứng trong ghi chú và review của slice, không chấm theo cảm giác.'),
      h('div', { class: 'vguide-grid' }, VERDICTS.map((k) => h('div', { class: 'vg-card', style: { '--vc': `var(--v-${k})` } },
        h('div', { class: 'vg-h' }, h('span', { class: 'swatch', style: { background: `var(--v-${k})` } }), h('b', {}, VLABEL[k]), h('span', { class: 'mono small muted' }, k)),
        h('div', { class: 'small' }, VINFO[k].what),
        h('div', { class: 'small' }, h('b', {}, 'Chọn khi: '), VINFO[k].pick),
        h('div', { class: 'small muted' }, h('b', {}, 'Tác động: '), VINFO[k].effect)))));
  }

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
    notes: {}, // runner answer notes being typed, kept across the 20 s re-render
    agentPick: {}, // agent question id → { [question n]: [labels] }, kept across re-renders
    boot: { source: 'idea', text: '', link: '', slug: '', template: 'default', brief: 'deep', goal: 'e2e', deploy: 'preview', implAgent: '', agent: 'claude', memory: true, images: [] },
  };
  // an evidence or question image, through the server's token-checked /img (an <img> sends no header)
  const imgUrl = (p) => `/img?p=${encodeURIComponent(p)}&t=${encodeURIComponent(TOKEN)}`;
  function openImage(src, caption) {
    showOverlay(h('div', { class: 'lightbox', role: 'dialog', onclick: closeOverlay }, h('img', { src, alt: caption ?? '' }), caption ? h('div', { class: 'lb-cap mono small' }, caption) : null));
  }
  /** Thumbnails of image files ({path, name?, at?}); a click opens the full image. */
  function thumbs(images) {
    return h('div', { class: 'thumbs' }, images.map((im) => {
      const p = typeof im === 'string' ? im : im.path;
      const name = (typeof im === 'string' ? null : im.name) ?? p.split('/').pop();
      return h('button', { class: 'thumb', type: 'button', title: p, onclick: () => openImage(imgUrl(p), p) },
        h('img', { src: imgUrl(p), alt: name, loading: 'lazy' }),
        h('span', { class: 'thumb-cap' }, name, im.at ? h('span', { class: 'muted' }, ` · ${ago(im.at)}`) : null));
    }));
  }
  const ROUTES = [
    ['map', 'Bản đồ', 'map'], ['quests', 'Nhiệm vụ', 'flag'], ['worlds', 'Dự án', 'globe'], ['boot', 'Game mới', 'play'], ['preview', 'Preview', 'phone'], ['memory', 'Memory', 'chip'],
    ['pilot', 'Pilot', 'flask'], ['playbook', 'Playbook', 'book'], ['scorecard', 'Scorecard', 'chart'], ['resources', 'Tài nguyên', 'bolt'], ['log', 'Nhật ký', 'list'],
  ];
  let route = { view: 'map', arg: null };
  function readHash() {
    const [v, ...rest] = (location.hash || '#map').slice(1).split('/');
    route = { view: ROUTES.some(([id]) => id === v) ? v : 'map', arg: rest.length ? decodeURIComponent(rest.join('/')) : null };
  }
  const go = (hash) => { if (location.hash === `#${hash}`) render(); else location.hash = hash; };

  // ---------------------------------------------------------------- notifications
  // Every attention row from the server (lib.attention) has a stable key. A key this browser has not
  // seen becomes a card in the page and an unread entry under the bell; on macOS and Windows, once
  // the director allows it, also an OS notification while the tab is hidden or unfocused. A key that
  // goes away marks its entry resolved and closes its OS notification. State is per browser.
  const NOTE_KEY = 'console-notify';
  const LEVEL_ICON = { critical: 'alert', warning: 'flag', info: 'bell' };
  const LEVEL_ORDER = { critical: 0, warning: 1, info: 2 };
  const DESKTOP_OS = (() => {
    const p = (navigator.userAgentData?.platform || navigator.platform || '').toLowerCase();
    const ua = navigator.userAgent || '';
    if (p.startsWith('win') || /Windows NT/.test(ua)) return 'Windows';
    // iPadOS also says Macintosh; it has touch points
    if ((p.startsWith('mac') || /Macintosh/.test(ua)) && !(navigator.maxTouchPoints > 1)) return 'macOS';
    return null;
  })();
  const osNotes = new Map(); // key → Notification still on screen
  const osSupported = () => !!DESKTOP_OS && 'Notification' in window && window.isSecureContext;
  const osReady = () => osSupported() && Notification.permission === 'granted' && loadNotes().osOn;

  function loadNotes() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(NOTE_KEY) || 'null'); } catch {}
    return s && typeof s === 'object' && Array.isArray(s.feed) ? s : { known: null, feed: [], osOn: true, snooze: 0 };
  }
  function saveNotes(s) { try { localStorage.setItem(NOTE_KEY, JSON.stringify(s)); } catch {} }
  const unreadCount = (s = loadNotes()) => s.feed.filter((f) => !f.read && !f.resolved).length;
  function editNotes(fn) { const s = loadNotes(); fn(s); saveNotes(s); drawBell(); }

  /** Diff the live rows against what this browser knows; returns the rows to announce. */
  async function ingestAttention(items) {
    const diff = () => {
      const s = loadNotes();
      const now = new Date().toISOString();
      const live = new Set(items.map((it) => it.key));
      // the first look in a new browser takes what is already waiting as read, with no alerts
      const first = s.known === null;
      const known = s.known ?? {};
      const fresh = items.filter((it) => !(it.key in known));
      for (const it of fresh) known[it.key] = now;
      for (const k of Object.keys(known)) {
        if (live.has(k)) continue;
        delete known[k];
        for (const f of s.feed) if (f.key === k && !f.resolved) f.resolved = now;
        osNotes.get(k)?.close();
      }
      s.feed.unshift(...fresh.map((it) => ({ ...it, at: now, read: first, resolved: null })));
      const weekAgo = Date.now() - 7 * 864e5;
      s.feed = s.feed.filter((f, i) => i < 80 && !(f.resolved && Date.parse(f.resolved) < weekAgo));
      s.known = known;
      saveNotes(s);
      return first ? [] : fresh;
    };
    // two open tabs must not both announce the same key
    const fresh = navigator.locks ? await navigator.locks.request(NOTE_KEY, diff) : diff();
    if (fresh.length) announce(fresh);
    drawBell();
  }

  function announce(fresh) {
    const rows = [...fresh].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
    const batch = rows.length > 3 ? {
      key: null, level: rows[0].level, href: '#quests', quest: 'all',
      title: `${rows.length} việc mới đang chờ bạn`, body: rows.slice(0, 4).map((r) => `• ${r.title}`).join('\n'),
    } : null;
    (batch ? [batch] : rows).forEach(noteCard);
    // the OS only hears about it when the director is not looking at this tab
    if (!osReady() || (!document.hidden && document.hasFocus())) return;
    (batch ? [batch] : rows).forEach(osNotify);
  }

  function osNotify(it) {
    try {
      const n = new Notification(it.title, { body: it.body || '', tag: it.key ? `director:${it.key}` : undefined, requireInteraction: it.level === 'critical', silent: it.level === 'info' });
      n.onclick = () => { window.focus(); n.close(); openNote(it); };
      if (it.key) {
        osNotes.set(it.key, n);
        n.onclose = () => { if (osNotes.get(it.key) === n) osNotes.delete(it.key); };
      }
    } catch (e) { console.warn('notification', e); }
  }

  function openNote(it) {
    if (it.key) editNotes((s) => s.feed.forEach((f) => { if (f.key === it.key) f.read = true; }));
    if (it.quest) ui.questType = it.quest;
    closeOverlay();
    go((it.href || '#quests').replace(/^#/, ''));
  }

  function noteCard(it) {
    const stack = document.querySelector('.note-stack') ?? document.body.appendChild(h('div', { class: 'note-stack', 'aria-live': 'polite' }));
    const card = h('div', { class: `note-card l-${it.level}`, role: 'status', onclick: () => { card.remove(); openNote(it); } },
      h('div', { class: 'note-ic' }, icon(LEVEL_ICON[it.level] ?? 'bell', 16)),
      h('div', { class: 'note-txt' }, h('b', {}, it.title), it.body ? h('div', {}, it.body) : null),
      h('button', { class: 'btn ghost sm icon-only', type: 'button', title: 'Đóng', onclick: (e) => { e.stopPropagation(); card.remove(); } }, icon('x', 14)));
    stack.prepend(card);
    while (stack.children.length > 4) stack.lastChild.remove();
    // a runner question or a failed refresh stays until it is dealt with or closed
    if (it.level !== 'critical') setTimeout(() => card.remove(), 12000);
  }

  function drawBell() {
    if (!shell.bellBadge) return;
    const n = unreadCount();
    shell.bellBadge.hidden = !n;
    shell.bellBadge.textContent = n > 99 ? '99+' : n;
    const label = n ? `Thông báo: ${n} chưa đọc` : 'Thông báo';
    shell.bellBtn.title = label;
    shell.bellBtn.setAttribute('aria-label', label);
    if (shell.baseTitle) document.title = `${n ? `(${n}) ` : ''}${shell.baseTitle}`;
    drawPermBanner();
  }

  function drawPermBanner() {
    const old = document.querySelector('.perm-banner');
    const want = osSupported() && Notification.permission === 'default' && Date.now() > (loadNotes().snooze || 0);
    if (!want) { old?.remove(); return; }
    if (old) return;
    const b = h('div', { class: 'perm-banner', role: 'region', 'aria-label': 'Thông báo hệ điều hành' },
      h('div', { class: 'note-ic' }, icon('bell', 18)),
      h('div', { class: 'grow' }, h('b', {}, `Bật thông báo ${DESKTOP_OS}?`),
        h('div', { class: 'small' }, 'Để biết ngay khi runner hỏi bạn, có bản nháp chờ duyệt hay kho memory lỗi, kể cả khi tab đang ẩn.')),
      h('div', { class: 'perm-actions' },
        btn('Để sau', () => { editNotes((s) => { s.snooze = Date.now() + 3 * 864e5; }); }, { cls: 'ghost sm' }),
        btn('Bật', askOsPermission, { cls: 'primary sm', ic: 'bell' })));
    document.body.append(b);
  }

  /** Must run from a click: Safari and Firefox ignore a permission request without one. */
  async function askOsPermission() {
    let p = 'default';
    try { p = await Notification.requestPermission(); } catch {}
    editNotes((s) => { s.osOn = p === 'granted'; });
    if (p === 'granted') osNotify({ key: null, level: 'info', href: '#quests', title: 'Director: đã bật thông báo', body: `Thông báo hiện trên ${DESKTOP_OS} khi có việc cần bạn và tab console không được xem.` });
    else if (p === 'denied') toast('Trình duyệt đã chặn thông báo. Mở cài đặt trang (biểu tượng cạnh thanh địa chỉ) › Notifications › Allow, rồi tải lại.', true);
    if (document.querySelector('.drawer.notes')) openNotes();
  }

  function osPanel() {
    const box = (...kids) => h('div', { class: 'os-panel' }, h('div', { class: 'note-ic' }, icon('bell', 16)), h('div', { class: 'grow' }, ...kids));
    if (!DESKTOP_OS) return box(h('b', {}, 'Thông báo trong trang'), h('div', { class: 'small' }, 'Thông báo hệ điều hành chỉ bật trên macOS và Windows.'));
    if (!('Notification' in window)) return box(h('b', {}, 'Trình duyệt này không có thông báo'), h('div', { class: 'small' }, 'Ví dụ trình duyệt nhúng của Orca. Mở console bằng Chrome, Safari hoặc Edge để bật.'));
    if (!window.isSecureContext) return box(h('b', {}, 'Cần https hoặc 127.0.0.1'), h('div', { class: 'small' }, 'Trình duyệt chỉ cho thông báo trên kết nối an toàn.'));
    const perm = Notification.permission;
    if (perm === 'default') return box(h('b', {}, `Thông báo ${DESKTOP_OS}: chưa bật`), h('div', { class: 'small' }, 'Trình duyệt sẽ hỏi quyền một lần.'), h('div', { class: 'row' }, btn('Bật thông báo', askOsPermission, { cls: 'primary sm', ic: 'bell' })));
    if (perm === 'denied') return box(h('b', {}, `Thông báo ${DESKTOP_OS}: bị chặn`), h('div', { class: 'small' }, 'Mở cài đặt trang (biểu tượng cạnh thanh địa chỉ) › Notifications › Allow, rồi tải lại trang.'));
    const on = loadNotes().osOn;
    const where = DESKTOP_OS === 'macOS' ? 'System Settings › Notifications › tên trình duyệt' : 'Settings › System › Notifications › tên trình duyệt';
    return box(h('b', {}, `Thông báo ${DESKTOP_OS}: ${on ? 'đang bật' : 'đang tắt'}`),
      h('div', { class: 'small' }, `Chỉ hiện khi tab console bị ẩn hoặc không được chọn. Không thấy gì? Xem ${where}, và chế độ Focus / Do Not Disturb.`),
      h('div', { class: 'row' },
        btn(on ? 'Tắt' : 'Bật lại', () => { editNotes((s) => { s.osOn = !on; }); openNotes(); }, { cls: 'sm' }),
        on ? btn('Gửi thử', () => osNotify({ key: null, level: 'info', href: '#quests', title: 'Director: thông báo thử', body: 'Bấm vào đây để mở console.' }), { cls: 'sm ghost', ic: 'bell' }) : null));
  }

  function openNotes() {
    const s = loadNotes();
    const rows = s.feed.map((f) => h('button', { class: `note-row l-${f.level} ${f.read ? '' : 'unread'} ${f.resolved ? 'resolved' : ''}`, type: 'button', onclick: () => openNote(f) },
      h('div', { class: 'note-ic' }, icon(LEVEL_ICON[f.level] ?? 'bell', 15)),
      h('div', { class: 'note-txt' }, h('b', {}, f.title), f.body ? h('div', { class: 'small' }, f.body) : null,
        h('div', { class: 'note-meta' }, f.project ? h('span', {}, f.project) : null, f.tag ? h('span', {}, f.tag) : null, h('span', {}, ago(f.at)), f.resolved ? chip('đã xử lý', 'good', 'check') : null))));
    const d = drawer('Thông báo',
      osPanel(),
      h('div', { class: 'row', style: { marginTop: '14px' } }, h('span', { class: 'muted small grow' }, `${unreadCount(s)} chưa đọc · ${s.feed.length} gần đây`),
        btn('Đọc hết', () => { editNotes((x) => x.feed.forEach((f) => { f.read = true; })); openNotes(); }, { cls: 'sm ghost', ic: 'check', disabled: !unreadCount(s) })),
      h('div', { class: 'note-list' }, rows.length ? rows : empty('Chưa có thông báo nào.', 'bell', 'Việc mới cần bạn sẽ hiện ở đây.')));
    d.classList.add('notes');
  }

  async function pollAttention() {
    try { await ingestAttention((await api('/api/attention')).items ?? []); } catch {}
  }
  window.addEventListener('storage', (e) => { if (e.key === NOTE_KEY) drawBell(); });

  // ---------------------------------------------------------------- shell
  const shell = {};
  // every tab with its label does not fit the bar: then only the open tab keeps its label (the others
  // keep the icon and a title), so no tab is pushed out of sight
  function fitTabs() {
    const nav = shell.nav?.[0]?.[1]?.parentElement;
    if (!nav) return;
    nav.classList.remove('compact');
    nav.classList.toggle('compact', nav.scrollWidth > nav.clientWidth + 1);
  }
  window.addEventListener('resize', () => fitTabs());
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
    shell.bellBadge = h('span', { class: 'badge', hidden: true });
    shell.bellBtn = h('button', { class: 'btn icon-only bell', type: 'button', onclick: openNotes, title: 'Thông báo' }, icon('bell', 18), shell.bellBadge);
    const top = h('header', { class: 'topbar' }, h('div', { class: 'inner' },
      h('button', { class: 'brand-sticker', type: 'button', onclick: () => go('map') }, 'Director ✦'),
      h('nav', { class: 'tabs', 'aria-label': 'Điều hướng' }, tabs.map(([, b]) => b)),
      h('div', { class: 'top-right' }, searchBtn, shell.bellBtn, shell.themeBtn)));
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
    return { runner: p.questions.length, agent: (p.agent_questions ?? []).length, draft: p.drafts.length, triage: p.triage.length, system, manual: p.manual_deferred.reduce((n, d) => n + d.items.length, 0) };
  }

  const CRUMB = { map: 'TỔNG QUAN', quests: 'VIỆC CẦN QUYẾT', worlds: 'DỰ ÁN', boot: 'BOOT GAME MỚI', preview: 'EDITOR PREVIEW', memory: 'ORCA-MEMORY', pilot: 'PILOT M08', playbook: 'COCOS-PLAYBOOK', scorecard: 'WORKFLOW', resources: 'RES-GUARD', log: 'THAO TÁC' };
  function updateChrome() {
    const ov = store.ov;
    const r = ROUTES.find(([id]) => id === route.view);
    shell.crumb.textContent = `DIRECTOR / ${CRUMB[route.view]}${route.arg ? ` / ${route.arg.toUpperCase()}` : ''}`;
    shell.title.textContent = route.arg && ['worlds', 'pilot'].includes(route.view) ? route.arg : r[1];
    shell.baseTitle = `${r[1]} · Director`;
    drawBell();
    for (const list of [shell.nav, shell.bottom]) for (const [id, b] of list) b.classList.toggle('on', id === route.view);
    fitTabs();
    if (!ov) return;
    const c = questCounts(ov);
    const decisions = c.runner + c.agent + c.draft + c.triage + c.system;
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
      c.agent ? h('span', { class: 'tag bad' }, icon('user', 13), `${c.agent} agent đang hỏi`) : null,
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
    await ingestAttention(store.ov.attention ?? []);
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
    const decisions = c.runner + c.agent + c.draft + c.triage + c.system;
    // quick action to the Game mới tab: the last boot in its foot
    const lastBoot = (await api('/api/boots').then((r) => r.boots).catch(() => []))[0];
    const bootFoot = lastBoot ? `gần nhất: ${lastBoot.title ?? lastBoot.source} · ${ago(lastBoot.at)}` : 'ý tưởng · App Store · Figma';
    const stat = (label, value, foot, tone, ic, onclick) =>
      h('div', { class: `stat s-${tone} ${onclick ? 'link' : ''}`, onclick, role: onclick ? 'button' : null, tabindex: onclick ? 0 : null },
        h('div', { class: 'label' }, icon(ic, 14), label), h('div', { class: `value ${typeof value === 'string' ? 'text' : ''}` }, value), h('div', { class: 'foot' }, foot));
    const stats = h('div', { class: 'stats' },
      stat('Việc chờ bạn', decisions, c.runner || c.agent ? [c.runner ? `${c.runner} runner hỏi` : null, c.agent ? `${c.agent} agent hỏi` : null].filter(Boolean).join(' · ') : `${c.draft} bảng nháp · ${c.triage} triage`, c.runner || c.agent ? 'coral' : decisions ? 'yellow' : 'green', 'flag', () => go('quests')),
      stat('Runner đang chạy', live.length, live.map((p) => `${p.id} ${p.runner.slice ?? ''}`).join(', ') || 'không có', 'pink', 'bolt', () => go('worlds')),
      stat('Dự án', ov.projects.length, `${assist} assist · ${ov.projects.filter((p) => p.mode === 'shadow').length} shadow`, 'blue', 'globe', () => go('worlds')),
      stat('Kho bài học', ov.memory.records, `${ov.memory.active} đang dùng`, 'lilac', 'archive', () => go('memory')),
      stat('Boot game mới', 'Mở', bootFoot, 'green', 'play', () => go('boot')),
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
      { from: 'pack', to: 'verdict', state: '', label: 'chấm' },
      { from: 'verdict', to: 'director', state: c.draft ? 'on' : '' },
    ];
    const flow = panel('Luồng workflow · memory', { icon: 'map', sub: 'Nhấn vào một node để đi tới chỗ xử lý. Đường hồng chạy = đang có việc.' },
      h('div', { class: 'graph-wrap' }, flowGraph(nodes, edges, { width: 946, height: 316 })));

    // worlds: each project as a compact level strip
    const worlds = panel('Dự án', { icon: 'globe', right: h('div', { class: 'row' }, h('span', { class: 'small muted', title: SORT_NOTE }, 'cần quyết → đang chạy → mới nhất'), btn('Xem tất cả', () => go('worlds'), { cls: 'ghost sm', ic: 'chev' })) },
      withLevels.length ? h('div', { class: 'grid cols-3' }, withLevels.map(worldCard)) : empty('Chưa có dự án nào dùng producer.'));

    const qs = allQuests().filter((q) => q.type !== 'manual').slice(0, 4);
    const quests = panel('Việc chờ bạn', { icon: 'flag', right: btn('Mở danh sách', () => go('quests'), { cls: 'ghost sm', ic: 'chev' }) },
      qs.length ? qs.map((q) => questMini(q)) : empty('Không có gì chờ bạn quyết. 🎯'));
    return [stats, h('div', { style: { height: '16px' } }), flow, h('div', { class: 'grid cols-2', style: { marginTop: '16px' } }, quests, worlds)];
  };

  // ======== boot: a new game from an idea, an App Store link or a Figma link, the way the director
  // starts one in orca-global (one Claude session given /new-cocos-game, /store-game-clone or
  // /figma-game-clone). tools/boot-idea builds the same prompt the preview shows here.
  const BOOT_SOURCES = [['idea', 'Ý tưởng', 'star'], ['store', 'App Store', 'globe'], ['figma', 'Figma', 'layers']];
  const BOOT_OPTS = {
    template: [['default', 'Cocos 3.8 (mặc định)'], ['playable', 'Playable ad'], ['cc4', 'Cocos 4']],
    brief: [['deep', 'Brief sâu (Fable)'], ['inline', 'Brief inline (nhanh)']],
    goal: [['e2e', 'End to end'], ['playable', 'Playable first']],
    deploy: [['preview', 'Deploy preview'], ['prod', 'Lên prod'], ['none', 'Không deploy']],
    agent: [['claude', 'claude'], ['claude --model opus', 'claude --model opus'], ['claude --model sonnet', 'claude --model sonnet']],
  };
  const oneLine = (t) => String(t ?? '').replace(/\s*\n\s*/g, ' · ').replace(/\s+/g, ' ').trim();
  const slugOf = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  /** Mirrors boot-idea.mjs bootPrompt (the toast after a boot shows the prompt the server really sent). */
  function bootPromptPreview(b) {
    const slug = b.slug ? (slugOf(b.slug).startsWith('cc-') ? slugOf(b.slug) : `cc-${slugOf(b.slug)}`) : null;
    const words = [
      { playable: 'template playable', cc4: 'cc4 (Cocos 4)' }[b.template], { inline: 'brief inline', deep: 'brief sâu bằng fable' }[b.brief],
      { e2e: 'end to end', playable: 'playable first' }[b.goal], { preview: 'deploy preview', prod: 'lên prod', none: 'không deploy' }[b.deploy],
      b.implAgent.trim() ? `agent ${oneLine(b.implAgent)}` : null, b.memory ? 'có hỗ trợ từ orca memory và playbook' : null,
    ].filter(Boolean);
    const text = oneLine(b.text);
    const parts = b.source === 'idea'
      ? [`/new-cocos-game ${slug ? `${slug}: ` : ''}${text}`, b.link.trim() ? `media/tham chiếu: ${oneLine(b.link)}` : null]
      : [`${b.source === 'store' ? '/store-game-clone' : '/figma-game-clone'} ${oneLine(b.link) || '<link>'}`, slug ? `tên project ${slug}` : null, text ? `ghi chú gameplay của director: ${text}` : null];
    parts.push(words.length ? `tuỳ chọn: ${words.join(', ')}` : null, b.images.length ? `ảnh tham chiếu của director: ~/orca-global/misc/boot-inbox/<giờ>-${slug ?? 'idea'}/ (${b.images.length} ảnh)` : null);
    return oneLine(parts.filter(Boolean).join(' — '));
  }

  VIEWS.boot = async () => bootPanel();

  async function bootPanel() {
    const b = ui.boot;
    const recent = await api('/api/boots').then((r) => r.boots).catch(() => []);
    const preview = h('div', { class: 'boot-prompt mono small' });
    const drawPreview = () => { preview.textContent = bootPromptPreview(b); };
    const field = (label, el, hint) => h('label', { class: 'boot-field' }, h('span', { class: 'muted small' }, label), el, hint ? h('span', { class: 'small muted' }, hint) : null);
    const input = (key, attrs = {}) => {
      const el = h(attrs.multiline ? 'textarea' : 'input', { class: 'input', placeholder: attrs.placeholder ?? '', rows: attrs.multiline ? 4 : null });
      el.value = b[key];
      el.addEventListener('input', () => { b[key] = el.value; drawPreview(); });
      return el;
    };
    const select = (key) => {
      const el = h('select', { class: 'input' }, BOOT_OPTS[key].map(([v, label]) => h('option', { value: v, selected: b[key] === v }, label)));
      el.addEventListener('change', () => { b[key] = el.value; drawPreview(); });
      return el;
    };
    const text = input('text', { multiline: true, placeholder: b.source === 'idea' ? 'Ý tưởng game: thể loại, gameplay chính, đối tượng, phong cách hình ảnh, 2D/3D, dọc/ngang… (dán ảnh vào đây được)' : 'Ghi chú gameplay của bạn cho bản clone (tuỳ chọn; dán ảnh vào đây được)' });
    const link = input('link', { placeholder: { idea: 'Link video gameplay / folder tham chiếu (tuỳ chọn)', store: 'https://apps.apple.com/…/id123456789', figma: 'https://www.figma.com/design/…' }[b.source] });

    // reference images: picked or pasted, kept as data URLs (the CSP allows data:, not blob:)
    const imgs = h('div', { class: 'thumbs' });
    const drawImgs = () => {
      imgs.replaceChildren(...b.images.map((im, i) => h('div', { class: 'thumb' }, h('img', { src: im.data, alt: im.name }),
        h('span', { class: 'thumb-cap' }, im.name), h('button', { class: 'btn ghost sm icon-only thumb-x', type: 'button', title: 'Bỏ ảnh', onclick: () => { b.images.splice(i, 1); drawImgs(); drawPreview(); } }, icon('x', 13)))));
    };
    const addFiles = (files) => {
      for (const f of [...files].filter((x) => /^image\/(png|jpe?g|gif|webp)$/.test(x.type))) {
        if (b.images.length >= 10) { toast('Tối đa 10 ảnh.', true); break; }
        if (f.size > 12 * 1024 * 1024) { toast(`${f.name} lớn hơn 12 MB.`, true); continue; }
        const rd = new FileReader();
        rd.onload = () => {
          const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[f.type];
          const name = /\.(png|jpe?g|gif|webp)$/i.test(f.name) ? f.name : `paste-${b.images.length + 1}.${ext}`;
          b.images.push({ name, data: rd.result });
          drawImgs(); drawPreview();
        };
        rd.readAsDataURL(f);
      }
    };
    const fileIn = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: true, hidden: true });
    fileIn.addEventListener('change', () => { addFiles(fileIn.files); fileIn.value = ''; });
    text.addEventListener('paste', (e) => { const fs = e.clipboardData?.files; if (fs?.length) { e.preventDefault(); addFiles(fs); } });
    drawImgs();

    const memory = h('input', { type: 'checkbox', checked: b.memory });
    memory.addEventListener('change', () => { b.memory = memory.checked; drawPreview(); });
    const seg = h('div', { class: 'seg', role: 'tablist' }, BOOT_SOURCES.map(([v, label, ic]) =>
      h('button', { class: b.source === v ? 'on' : '', type: 'button', onclick: () => { b.source = v; render(); } }, icon(ic, 14), label)));

    const boot = async () => {
      const t = oneLine(b.text);
      if (b.source === 'idea' && t.length < 10) { toast('Viết ý tưởng game (ít nhất một câu).', true); text.focus(); return; }
      if (b.source === 'store' && !/^https:\/\/apps\.apple\.com\//.test(b.link.trim())) { toast('Cần link apps.apple.com.', true); link.focus(); return; }
      if (b.source === 'figma' && !/^https:\/\/(www\.)?figma\.com\/(design|file|proto)\//.test(b.link.trim())) { toast('Cần link figma.com/design.', true); link.focus(); return; }
      const ok = await confirmBox({ title: 'Boot game mới ở orca-global', ok: 'Boot', body: `Mở một session ${b.agent} trong ~/orca-global và gửi:\n\n${bootPromptPreview(b)}` });
      if (!ok) return;
      toast('Đang mở session ở orca-global và chờ agent sẵn sàng (tối đa ~90 giây)…');
      const r = await post('boot.idea', { source: b.source, text: b.text, link: b.link.trim() || null, slug: b.slug.trim() || null, template: b.template, brief: b.brief, goal: b.goal, deploy: b.deploy,
        memory: b.memory ? 'on' : 'off', impl_agent: b.implAgent.trim() || null, agent: b.agent, images: b.images.map((im) => ({ name: im.name, data: im.data })) });
      const out = r.out?.prompt ? `${r.out.title} · ${r.out.handle}\n${r.out.prompt}` : (r.out?.error ?? r.error ?? JSON.stringify(r.out ?? ''));
      toast(`${r.ok ? '✓ Đã boot' : '✗ Boot lỗi'}\n${out}${r.err ? `\n${r.err}` : ''}`.slice(0, 1400), !r.ok);
      if (r.ok) ui.boot = { ...b, text: '', link: '', slug: '', images: [] };
      render();
    };
    drawPreview();
    const recentList = recent.length ? h('div', { class: 'boot-recent' }, recent.slice(0, 5).map((x) => h('div', { class: 'boot-row small' },
      chip(x.ok ? 'đã gửi' : 'lỗi', x.ok ? 'good' : 'bad'), h('b', {}, x.title ?? x.source), h('span', { class: 'muted' }, ago(x.at)),
      h('span', { class: 'grow ink2 boot-row-p', title: x.prompt ?? x.error ?? '' }, x.ok ? x.prompt : (x.error ?? ''))))) : null;
    return panel('Boot game mới', { icon: 'play', cls: 'boot', sub: 'Như một session ở orca-global: agent chạy /new-cocos-game (ý tưởng), /store-game-clone (App Store) hoặc /figma-game-clone (Figma). Câu hỏi của session đó hiện ở tab Nhiệm vụ.', right: seg },
      h('div', { class: 'boot-grid' },
        h('div', { class: 'boot-main' }, field(b.source === 'idea' ? 'Ý tưởng *' : 'Ghi chú gameplay', text),
          field(b.source === 'idea' ? 'Media tham chiếu' : 'Link *', link),
          h('div', { class: 'row' }, btn('Thêm ảnh tham chiếu', () => fileIn.click(), { cls: 'sm', ic: 'eye' }), h('span', { class: 'small muted' }, 'hoặc dán ảnh vào ô ý tưởng · tối đa 10 ảnh, mỗi ảnh ≤ 12 MB'), fileIn),
          imgs),
        h('div', { class: 'boot-side' }, field('Tên project (tuỳ chọn)', input('slug', { placeholder: 'cc-space-dash' })),
          h('div', { class: 'boot-2' }, field('Template', select('template')), field('Brief', select('brief')), field('Mục tiêu', select('goal')), field('Deploy', select('deploy'))),
          field('Agent implement (tuỳ chọn)', input('implAgent', { placeholder: 'claude --model opus · codex · cursor --model auto' })),
          h('div', { class: 'boot-2' }, field('Agent chạy session boot', select('agent')), h('label', { class: 'boot-check small' }, memory, 'orca-memory + playbook')))),
      h('div', { class: 'q-sec' }, h('div', { class: 'q-sec-h' }, 'Prompt sẽ gửi'), preview),
      h('div', { class: 'quest-actions' }, btn('Boot', boot, { cls: 'primary', ic: 'play' }), h('span', { class: 'grow' })),
      recentList ? h('div', { class: 'q-sec' }, h('div', { class: 'q-sec-h' }, 'Boot gần đây'), recentList) : null);
  }

  // the server's order (lib.mjs projectOrder)
  const SORT_NOTE = 'Thứ tự: câu hỏi runner đang mở (nhiều trước) → runner đang chạy → hoạt động gần nhất (runner hoặc commit) → tên.';
  function worldCard(p) {
    const done = p.levels.filter((l) => levelState(l.status)[0] === 'good').length;
    const cur = p.levels.find((l) => levelState(l.status)[0] === 'live');
    const pct = p.levels.length ? Math.round((done / p.levels.length) * 100) : 0;
    const status = p.runner ? (p.runner.alive ? h('span', { class: 'chip accent' }, h('span', { class: 'pip live' }), `chạy ${p.runner.slice ?? ''}`) : chip(p.runner.step === 'done' ? 'nghỉ' : `dừng · ${p.runner.step ?? '—'}`, 'outline')) : chip('không runner', 'outline');
    return h('button', { class: `world ${route.arg === p.id ? 'on' : ''}`, type: 'button', onclick: () => go(`worlds/${p.id}`) },
      h('div', { class: 'world-h' }, h('b', { class: 'grow' }, p.id), p.mode ? chip(p.mode, modeTone(p.mode)) : chip('chưa đăng ký', 'bad'), p.runner?.open_questions ? h('span', { class: 'badge' }, p.runner.open_questions) : null),
      h('div', { class: 'row small ink2' }, status, h('span', { class: 'grow' }), `${done}/${p.levels.length} slice`, cur ? ` · đang ${cur.slice}` : ''),
      h('div', { class: 'small muted', title: p.active_at ? when(p.active_at) : 'chưa thấy hoạt động' }, `hoạt động ${ago(p.active_at)}`),
      h('div', { class: 'xp', title: `${pct}% slice đã xong` }, h('i', { style: { width: `${pct}%` } })),
      h('div', { class: 'graph-wrap' }, levelMap(p.levels, { size: 's' })));
  }

  // ======== quests
  function allQuests() {
    const p = store.ov.pending;
    const out = [];
    for (const q of p.questions) out.push({ type: 'runner', project: q.project, at: q.asked_at, text: `${q.kind} ${q.slice ?? ''} ${q.text}`, data: q });
    for (const q of p.agent_questions ?? []) out.push({ type: 'agent', project: q.project, at: q.asked_at, text: `${q.terminal?.title ?? ''} ${q.kind === 'ask' ? q.questions.map((x) => `${x.question} ${x.options.map((o) => o.label).join(' ')}`).join(' ') : q.text}`, data: q });
    for (const d of p.drafts) out.push({ type: 'draft', project: d.project, at: d.created_at, text: `${d.slice} ${d.rows.map((r) => r.record).join(' ')}`, data: d });
    for (const t of p.triage) out.push({ type: 'triage', project: t.source.split(':')[0], at: null, text: `${t.source} ${t.reason}`, data: t });
    if (p.refresh && (!p.refresh.ok || p.refresh.stale)) out.push({ type: 'system', project: '', at: p.refresh.at, text: 'refresh', data: { kind: 'refresh', ...p.refresh } });
    for (const u of p.unregistered) out.push({ type: 'system', project: u.path.split('/').pop(), at: u.last_task_at, text: u.path, data: { kind: 'unregistered', ...u } });
    for (const d of p.manual_deferred) out.push({ type: 'manual', project: d.project, at: null, text: `${d.slice} ${d.items.join(' ')}`, data: d });
    return out;
  }
  const QTYPES = [['all', 'Tất cả', 'flag'], ['runner', 'Runner hỏi', 'alert'], ['agent', 'Agent hỏi', 'user'], ['draft', 'Verdict', 'flask'], ['triage', 'Triage', 'archive'], ['system', 'Hệ thống', 'refresh'], ['manual', 'Kiểm tra tay', 'hand']];

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
      const order = { runner: 0, agent: 0, system: 1, draft: 2, triage: 3, manual: 4 };
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
      agent: () => ['user', 'Agent hỏi', 'q-agent', `${q.data.terminal?.title ?? q.data.handle} · ${(q.data.kind === 'ask' ? q.data.questions[0]?.question : String(q.data.text).trim().split(/\n\s*\n/).at(-1)) ?? ''}`.slice(0, 180)],
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
    if (q.type === 'agent') return agentCard(q.data);
    if (q.type === 'draft') return draftCard(q.data);
    if (q.type === 'triage') return triageCard(q.data);
    if (q.type === 'manual') return manualCard(q.data);
    return systemCard(q.data);
  }

  // the runner's question kinds, in the director's words; the raw kind stays on the chip
  const KIND_VI = {
    fleet_gate: 'Cổng quyết định của fleet', lane_blocked: 'Lane bị chặn', director_gate: 'Cổng giám đốc duyệt',
    approval_evidence: 'Bằng chứng duyệt chưa đủ', verdict_override: 'Verdict review cần xác nhận', verdict_mismatch: 'Verdict lệch nhau',
    verify_failed: 'Bước verify lỗi', verify_manual: 'Cần kiểm tra tay', coordinator_missing: 'Không thấy coordinator',
    unknown_status: 'Trạng thái lane không rõ', commit_stalled: 'Commit chưa xong', commit_sha_stale: 'SHA commit đã cũ',
    prompt_not_sent: 'Prompt chưa gửi tới terminal', manual_required: 'Cần thao tác tay',
  };
  const NOTE_VI = { required: 'cần ghi chú', optional: 'ghi chú tuỳ chọn' };
  const section = (label, ...kids) => h('div', { class: 'q-sec' }, h('div', { class: 'q-sec-h' }, label), ...kids);
  let translateRetry = null;
  let suggestRetry = null;

  function runnerCard(q) {
    const noteKey = `${q.project}#${q.id}`;
    const note = h('textarea', { class: 'input', placeholder: 'Ghi chú / câu trả lời cho lane (bắt buộc với lựa chọn có dấu *)' });
    note.value = ui.notes[noteKey] ?? '';
    note.addEventListener('input', () => { ui.notes[noteKey] = note.value; });
    const vi = q.vi;
    const answer = (o, i) => {
      if (o.note === 'required' && !note.value.trim()) { toast('Lựa chọn này cần ghi chú.', true); note.focus(); return; }
      const label = o.vi_label ? `${i + 1}. ${o.vi_label}` : `${i + 1}. ${o.choice}`;
      act('runner.answer', { project: q.project, id: q.id, choice: o.choice, text: note.value }, {
        title: o.pilot ? `Giao ${q.project} ${q.id} cho pilot agent` : `Trả lời ${q.project} ${q.id}`, ok: o.pilot ? 'Giao cho pilot' : 'Gửi cho runner', danger: /^stop/i.test(o.choice),
        body: o.pilot
          ? `Lựa chọn: ${label}\nCâu hỏi vẫn mở; pilot agent được đánh thức và trả lời thay bạn. Bạn vẫn có thể tự trả lời trước.${note.value.trim() ? `\nGhi chú cho pilot: ${note.value.trim()}` : ''}`
          : `Lựa chọn: ${label}\nRunner nhận nguyên văn: "${o.choice}"${note.value.trim() ? `\nGhi chú: ${note.value.trim()}` : ''}`,
      }).then((r) => { if (r?.ok) delete ui.notes[noteKey]; });
    };
    const opts = h('div', { class: 'opt-list' }, q.options.map((o, i) => h('button', {
      class: `opt-row ${/^stop/i.test(o.choice) ? 'danger' : ''} ${o.pilot ? 'pilot' : ''}`, type: 'button', onclick: () => answer(o, i), title: o.pilot ? 'Giao câu hỏi cho pilot agent' : `Runner nhận: ${o.choice}`,
    },
    h('span', { class: 'opt-num' }, i + 1),
    h('span', { class: 'opt-txt' },
      h('b', {}, (o.vi_label ?? o.choice) + (o.note === 'required' ? ' *' : '')),
      o.vi_text && o.vi_text !== o.vi_label ? h('span', { class: 'small' }, o.vi_text) : null,
      h('span', { class: 'opt-en' }, o.choice, o.note ? ` · ${NOTE_VI[o.note] ?? o.note}` : '')))));

    const trState = {
      translating: () => chip('đang dịch sang tiếng Việt…', 'warn', 'clock'),
      failed: () => chip(`dịch lỗi, thử lại sau 10 phút: ${q.vi_error ?? ''}`.slice(0, 160), 'bad', 'alert'),
      off: () => chip('chưa có bản tiếng Việt', 'outline'),
    }[q.vi_state]?.() ?? null;
    if (q.vi_state === 'translating' && !translateRetry) translateRetry = setTimeout(() => { translateRetry = null; refresh(false); }, 9000);

    const why = vi?.why ?? q.judge?.defer ?? null;
    const english = h('details', { class: 'q-more' }, h('summary', {}, vi ? 'Nguyên văn tiếng Anh (runner)' : 'Chi tiết gốc của runner'),
      h('pre', { class: 'code' }, [
        q.text, q.detail && q.detail !== q.text ? `\n\nChi tiết:\n${q.detail}` : '',
        q.judge?.defer ? `\n\nJudge (${when(q.judge.at)}): ${q.judge.defer}` : '',
        q.judge?.choice ? `\n\nJudge chọn: ${q.judge.choice} — ${q.judge.reason ?? ''}` : '',
        `\n\nOptions:\n${q.options.map((o, i) => `${i + 1}. ${o.choice}`).join('\n')}`,
      ].join('')));
    const tech = h('details', { class: 'q-more' }, h('summary', {}, 'Mã kỹ thuật'),
      h('div', { class: 'kv' }, [
        ['id', q.id], ['loại', q.kind], ['key', q.key], ['gate / ref', q.ref], ['obs', q.obs],
        ['cùng chờ (also)', q.also?.length ? q.also.join(', ') : null], ['hỏi lúc', when(q.asked_at)], ['đã báo', q.notified ? when(q.notified) : null],
        ['bản dịch', vi?.at ? `sonnet · ${when(vi.at)}` : q.vi_state],
      ].filter(([, v]) => v).map(([k, v]) => [h('span', { class: 'muted' }, k), h('span', { class: 'mono' }, v)])));

    return h('div', { class: 'quest q-runner' },
      h('div', { class: 'quest-h' }, qtag('alert', 'Runner hỏi'), chip(q.project, 'outline'), q.slice ? chip(q.slice, 'accent') : null,
        chip(KIND_VI[q.kind] ? `${KIND_VI[q.kind]} · ${q.kind}` : q.kind, 'warn'),
        q.pilot_handoff ? chip(`${q.pilot_handoff.via === 'auto' ? 'pilot agent tự nhận' : 'đã giao pilot agent'} · ${ago(q.pilot_handoff.at)}`, 'accent', 'clock') : null,
        q.pilot_returned ? chip('pilot agent trả lại cho bạn', 'warn', 'alert') : null, h('span', { class: 'grow' }),
        h('span', { class: 'small muted' }, `${q.id} · ${when(q.asked_at)} · ${ago(q.asked_at)}`)),
      q.context?.length ? h('div', { class: 'q-context' }, q.context.map((l) => h('div', {}, l))) : null,
      q.pilot_returned ? h('div', { class: 'q-context' }, h('div', {}, `Pilot agent trả lại: ${q.pilot_returned.note}`)) : null,
      section(vi ? 'Câu hỏi' : 'Câu hỏi (nguyên văn tiếng Anh)', trState, h('div', { class: 'quest-body' }, vi?.summary ?? q.text)),
      why ? section(vi?.why ? 'Vì sao judge để bạn quyết' : 'Vì sao judge để bạn quyết (tiếng Anh)', h('div', { class: 'q-why' }, why)) : null,
      section('Các lựa chọn', opts),
      h('div', { style: { marginTop: '10px' } }, note),
      english, tech);
  }

  // ======== a question an agent asked in its own Orca terminal (tools/agent-questions)
  function agentCard(q) {
    const noteKey = `agent#${q.id}`;
    const picks = ui.agentPick[q.id] ?? (ui.agentPick[q.id] = {});
    const note = h('textarea', { class: 'input', placeholder: q.kind === 'ask' ? 'Ghi chú thêm, hoặc câu trả lời khác ngoài các lựa chọn (tuỳ chọn)' : 'Câu trả lời của bạn cho agent' });
    note.value = ui.notes[noteKey] ?? '';
    note.addEventListener('input', () => { ui.notes[noteKey] = note.value; });
    const title = (q.terminal?.title ?? '').replace(/^[^\p{L}\p{N}(]+/u, '') || q.handle;

    const qBlocks = q.kind === 'ask' ? q.questions.map((x, i) => {
      const n = i + 1;
      const rows = x.options.map((o) => {
        const row = h('button', { class: `opt-row ${(picks[n] ?? []).includes(o.label) ? 'on' : ''}`, type: 'button', 'aria-pressed': String((picks[n] ?? []).includes(o.label)) },
          h('span', { class: 'opt-num' }, x.multiSelect ? '☐' : '○'),
          h('span', { class: 'opt-txt' }, h('b', {}, o.label), o.description ? h('span', { class: 'small' }, o.description) : null,
            o.preview ? h('details', { class: 'q-more', onclick: (e) => e.stopPropagation() }, h('summary', {}, 'Xem preview'), h('pre', { class: 'code' }, o.preview)) : null));
        row.addEventListener('click', () => {
          const cur = picks[n] ?? [];
          picks[n] = x.multiSelect ? (cur.includes(o.label) ? cur.filter((l) => l !== o.label) : [...cur, o.label]) : (cur[0] === o.label ? [] : [o.label]);
          for (const r of row.parentElement.children) {
            const on = picks[n].includes(r.querySelector('b').textContent);
            r.classList.toggle('on', on);
            r.setAttribute('aria-pressed', String(on));
          }
        });
        return row;
      });
      return section(`Câu ${n}${x.header ? ` · ${x.header}` : ''}${x.multiSelect ? ' · chọn được nhiều' : ''}`, h('div', { class: 'quest-body' }, x.question), h('div', { class: 'opt-list' }, rows));
    }) : [section('Agent hỏi', h('div', { class: 'quest-body md agent-text' }, md(q.text)))];

    const send = () => {
      const chosen = Object.entries(picks).flatMap(([n, labels]) => labels.map((label) => ({ n: Number(n), label })));
      const text = note.value.trim();
      if (q.kind === 'ask' && !chosen.length && !text) { toast('Chọn một lựa chọn hoặc ghi câu trả lời.', true); return; }
      if (q.kind === 'stop' && !text) { toast('Ghi câu trả lời cho agent.', true); note.focus(); return; }
      const lines = q.kind === 'ask'
        ? [...q.questions.map((x, i) => `${i + 1}. ${x.header || x.question}: ${chosen.filter((c) => c.n === i + 1).map((c) => c.label).join(', ') || '(không chọn)'}`), text ? `Ghi chú: ${text}` : null]
        : [text];
      act('agent.answer', { id: q.id, picks: chosen, text }, {
        title: `Trả lời agent · ${q.project}`, ok: 'Gửi cho agent',
        body: `${lines.filter(Boolean).join('\n')}\n\n${q.kind === 'ask' ? 'Hộp chọn của agent được đóng rồi câu trả lời được gõ vào chat của agent như một tin nhắn.' : 'Câu trả lời được gõ vào chat của agent.'}\nTerminal: ${title}`,
      }).then((r) => { if (r?.ok) { delete ui.notes[noteKey]; delete ui.agentPick[q.id]; } });
    };
    // quick replies: a plain question's suggestions (rules at once, a model's when ready); a dialog's
    // recommended options, or each option of a lone single-choice question. A click opens the reply to edit or send.
    const quickSend = (label, body) => act('agent.answer', { id: q.id, ...body }, {
      title: `Trả lời nhanh · ${q.project}`, ok: 'Gửi cho agent',
      body: body.picks ? `${body.picks.map((p) => `${p.n}. ${q.questions[p.n - 1].header || q.questions[p.n - 1].question}: ${p.label}`).join('\n')}\n\nHộp chọn của agent được đóng rồi câu trả lời được gõ vào chat.` : `Terminal: ${title}`,
      fields: body.picks ? [] : [{ name: 'text', label: 'Câu gửi cho agent (sửa được)', value: label, multiline: true, required: true }],
    }).then((r) => { if (r?.ok) { delete ui.notes[noteKey]; delete ui.agentPick[q.id]; } });
    let quick = [];
    let quickNote = null;
    if (q.kind === 'stop') {
      quick = (q.quick?.replies ?? []).map((r) => ({ label: r.label, title: r.text, go: () => quickSend(r.text, { text: r.text }) }));
      quickNote = q.quick?.state === 'pending' ? chip('đang gợi ý thêm…', 'warn', 'clock') : q.quick?.source === 'llm' ? chip('gợi ý theo ngữ cảnh', 'outline', 'star') : null;
      if (q.quick?.state === 'pending' && !suggestRetry) suggestRetry = setTimeout(() => { suggestRetry = null; refresh(false); }, 9000);
    } else {
      const REC = /recommended|đề xuất|khuyên dùng|khuyến nghị/i;
      const rec = q.questions.map((x, i) => ({ n: i + 1, label: x.options.find((o) => REC.test(o.label))?.label })).filter((p) => p.label);
      if (rec.length === q.questions.length) quick.push({ label: `Gửi lựa chọn đề xuất${rec.length > 1 ? ` (${rec.length} câu)` : `: ${rec[0].label}`}`, title: rec.map((p) => p.label).join(' · '), go: () => quickSend(null, { picks: rec }) });
      if (q.questions.length === 1 && !q.questions[0].multiSelect && q.questions[0].options.length <= 4) {
        for (const o of q.questions[0].options) if (!REC.test(o.label) || rec.length !== 1) quick.push({ label: o.label, title: o.description ?? o.label, go: () => quickSend(null, { picks: [{ n: 1, label: o.label }] }) });
      }
    }
    const quickBox = quick.length ? section('Trả lời nhanh', quickNote, h('div', { class: 'quick-row' }, quick.map((x) => h('button', { class: 'btn sm quick', type: 'button', title: x.title, onclick: x.go }, icon('bolt', 14), x.label)))) : null;

    const tech = h('details', { class: 'q-more' }, h('summary', {}, 'Mã kỹ thuật'),
      h('div', { class: 'kv' }, [['id', q.id], ['loại', q.kind === 'ask' ? 'AskUserQuestion (hộp chọn)' : 'câu hỏi cuối lượt'], ['terminal', q.handle], ['vai trò', q.role], ['cwd', q.cwd], ['session', q.session_id], ['transcript', q.transcript_path], ['hỏi lúc', when(q.asked_at)], ['lỗi gửi lần trước', q.last_error]]
        .filter(([, v]) => v).map(([k, v]) => [h('span', { class: 'muted' }, k), h('span', { class: 'mono' }, v)])));
    return h('div', { class: 'quest q-agent' },
      h('div', { class: 'quest-h' }, qtag('user', 'Agent hỏi'), chip(q.project, 'outline'), q.slice ? chip(q.slice, 'accent') : null, q.role ? chip(q.role, 'outline') : null,
        chip(q.kind === 'ask' ? 'hộp chọn' : 'hỏi trong chat', 'warn'), chip(title, 'outline', 'terminal'), h('span', { class: 'grow' }),
        h('span', { class: 'small muted' }, `${when(q.asked_at)} · ${ago(q.asked_at)}`)),
      q.kind === 'ask' && q.context ? h('details', { class: 'q-more', open: q.context.length < 900 }, h('summary', {}, 'Agent đang nói gì trước khi hỏi'), h('div', { class: 'md agent-text small' }, md(q.context))) : null,
      qBlocks,
      q.images?.length ? section(`Hình agent nhắc tới · ${q.images.length}`, thumbs(q.images)) : null,
      quickBox,
      h('div', { style: { marginTop: '10px' } }, note),
      h('div', { class: 'quest-actions' }, btn('Gửi cho agent', send, { cls: 'primary', ic: 'check' }),
        btn('Mở terminal', () => act('agent.focus', { id: q.id }), { ic: 'terminal', title: 'Hiện terminal của agent trong Orca để trả lời trong chat' }),
        btn('Bỏ qua', () => act('agent.dismiss', { id: q.id }, { title: 'Bỏ qua câu hỏi này', body: 'Thẻ đóng lại; agent không được báo gì.', fields: [{ name: 'note', label: 'Lý do', required: true }], ok: 'Bỏ qua' }), { cls: 'ghost', ic: 'x' })),
      h('div', { class: 'small muted', style: { marginTop: '8px' } }, 'Trả lời ở đây hoặc ngay trong chat của agent: bên nào trả lời trước thì thẻ tự đóng.'),
      tech);
  }

  function draftCard(d) {
    const picks = d.rows.map((r) => ({ r, verdict: r.verdict, ok: !!r.confirmed }));
    const draftVerdict = new Map(d.rows.map((r) => [`${r.stage}|${r.record}`, r.verdict]));
    let info = null; // /api/draft-info: the lesson text, citations, phase, Vietnamese evidence
    let poll = null;
    const rowsEl = h('div');
    const infoEl = h('div');
    const counter = h('span', { class: 'small muted' });
    const applyBtn = btn('Ghi vào ledger', null, { cls: 'primary', ic: 'check' });
    const infoOf = (p) => info?.rows?.find((x) => x.stage === p.r.stage && x.record === p.r.record) ?? null;

    const drawRows = () => {
      rowsEl.replaceChildren(...picks.map((p) => {
        const x = infoOf(p);
        const pills = h('div', { class: 'row', style: { gap: '5px' } }, VERDICTS.map((v) =>
          h('button', { class: `vpill ${p.verdict === v ? 'on' : ''}`, type: 'button', title: `${VINFO[v].what}\nChọn khi: ${VINFO[v].pick}`, style: { '--vc': `var(--v-${v})` },
            onclick: () => { p.verdict = v; p.ok = true; drawRows(); } }, h('span', { class: 'swatch', style: { background: `var(--v-${v})` } }), VLABEL[v])));
        const cb = h('input', { type: 'checkbox', checked: p.ok && !!p.verdict, disabled: !p.verdict });
        cb.addEventListener('change', () => { p.ok = cb.checked; drawCount(); });
        const [stName, stHelp] = stageVi(p.r.stage);
        const [cfName, cfHelp] = CONF_VI[p.r.confidence] ?? [p.r.confidence, ''];
        const claim = x?.vi?.claim || x?.claim;
        const evidence = x?.vi?.evidence || p.r.evidence;
        const enNote = x?.vi ? '' : info?.vi_state === 'translating' ? 'đang dịch…' : info?.vi_state === 'failed' ? 'dịch lỗi, đang hiện tiếng Anh' : 'tiếng Anh';
        const recMeta = x ? [
          x.conditions ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Điều kiện áp dụng: '), [].concat(x.conditions).join(' · ')) : null,
          x.limitations ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Giới hạn: '), [].concat(x.limitations).join(' · ')) : null,
          x.observed_at ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Ghi nhận lúc: '), when(x.observed_at)) : null,
          x.sources?.length ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Nguồn: '), h('span', { class: 'mono' }, x.sources.join(' · '))) : null,
          x.vi && x.claim ? h('div', { class: 'small' }, h('span', { class: 'muted' }, 'Nguyên văn tiếng Anh: '), x.claim) : null,
          !x.found ? h('div', { class: 'small' }, 'Record không còn trong archive (đã retract hoặc promote).') : null,
        ].filter(Boolean) : [];
        const suggested = draftVerdict.get(`${p.r.stage}|${p.r.record}`);
        return h('div', { class: 'vrow2' },
          h('div', { class: 'row', style: { gap: '6px' } },
            h('span', { title: stHelp }, chip(stName, 'outline')),
            p.r.confidence ? h('span', { title: cfHelp }, chip(`drafter tin cậy ${cfName}`, p.r.confidence === 'low' ? 'warn' : p.r.confidence === 'high' ? 'good' : 'outline')) : null,
            x?.kind ? chip(x.kind, 'outline') : null,
            x?.cited ? h('span', { title: 'Ghi chú/review của slice nhắc tới record này: bằng chứng agent đã đọc nó' }, chip('slice có trích dẫn', 'good', 'star')) : null,
            x && x.found === false ? chip('record đã rời archive', 'bad') : null,
            x?.lifecycle && x.lifecycle !== 'active' ? h('span', { title: 'Record đã rời pack: bài học đã nằm trong contract/template (promoted) hoặc bị gỡ vì sai (retracted)' }, chip(LIFE_VI[x.lifecycle] ?? x.lifecycle, 'outline')) : null,
            suggested ? h('span', { class: 'small muted' }, `drafter gợi ý: ${VLABEL[suggested] ?? suggested}`) : null),
          h('div', { class: 'vclaim' }, claim ?? (info ? '(không có nội dung record)' : 'Đang tải nội dung bài học…')),
          recMeta.length ? h('details', { class: 'small' }, h('summary', {}, 'Chi tiết bài học'), recMeta) : null,
          h('div', { class: 'row', style: { gap: '6px' } }, h('span', { class: 'small muted' }, 'Record:'),
            h('button', { class: 'btn ghost sm mono', type: 'button', style: { justifyContent: 'flex-start', whiteSpace: 'normal', textAlign: 'left', height: 'auto', padding: '2px 6px' }, onclick: () => openRecord(p.r.record) }, p.r.record)),
          h('div', { class: 'vevid' }, h('b', {}, 'Bằng chứng drafter tìm thấy'), enNote ? h('span', { class: 'small muted' }, ` (${enNote})`) : null, h('div', { class: 'small ink2' }, evidence || '(không có)')),
          h('div', { class: 'row', style: { justifyContent: 'space-between' } }, pills, h('label', { class: 'check' }, cb, 'xác nhận')));
      }));
      drawCount();
    };
    const drawCount = () => {
      const n = picks.filter((p) => p.ok && p.verdict).length;
      counter.textContent = `${n}/${picks.length} dòng sẽ được ghi`;
      applyBtn.disabled = !n;
    };
    const drawInfo = () => {
      const sum = {};
      for (const p of picks) if (p.verdict) sum[p.verdict] = (sum[p.verdict] ?? 0) + 1;
      const low = picks.filter((p) => p.r.confidence === 'low').length;
      const shadow = info?.phase === 'shadow';
      infoEl.replaceChildren(...[
        h('div', { class: 'row', style: { gap: '8px', margin: '6px 0' } }, h('span', { class: 'small muted' }, 'Drafter gợi ý:'), vcounts(sum), low ? chip(`${low} dòng tin cậy thấp: xem kỹ`, 'warn', 'alert') : null,
          info?.phase ? chip(`slice chạy ${info.phase}`, info.phase === 'assist' ? 'good' : 'warn') : null,
          info?.injected_tokens != null ? chip(`${info.injected_tokens} token pack`, 'outline') : null),
        shadow ? h('div', { class: 'q-context' }, h('div', {}, 'Slice này chạy chế độ shadow: pack chỉ để đo, agent KHÔNG nhìn thấy các bài học này. Hãy chấm theo câu hỏi "nếu agent được đưa bài học này, nó có giúp không?", không phải "agent đã dùng nó chưa".')) : null,
        info?.vi_state === 'translating' ? chip('đang dịch bằng chứng sang tiếng Việt…', 'warn', 'clock') : null,
        info?.vi_state === 'failed' ? chip(`dịch lỗi, thử lại sau 10 phút: ${info.vi_error ?? ''}`.slice(0, 160), 'bad', 'alert') : null].filter(Boolean));
    };
    const loadInfo = async () => {
      try { info = await api(`/api/draft-info?project=${encodeURIComponent(d.project)}&slice=${encodeURIComponent(d.slice)}`); } catch (e) { info = null; infoEl.replaceChildren(chip(`không tải được nội dung bài học: ${e.message}`.slice(0, 160), 'bad', 'alert')); return; }
      drawInfo(); drawRows();
      if (info.vi_state === 'translating') poll = setTimeout(() => { if (root.isConnected) loadInfo(); }, 8000);
    };
    applyBtn.addEventListener('click', () => {
      const rows = picks.map((p) => ({ stage: p.r.stage, record: p.r.record, verdict: p.verdict || null, confirmed: p.ok && !!p.verdict }));
      const n = rows.filter((r) => r.confirmed).length;
      const by = (v) => rows.filter((r) => r.confirmed && r.verdict === v).length;
      const bad = by('misleading') + by('stale');
      act('draft.apply', { file: d.file, rows }, {
        title: `Ghi ${n} verdict · ${d.project} ${d.slice}`,
        body: `${VERDICTS.map((v) => `${VLABEL[v]} ${by(v)}`).join(' · ')}.${bad ? `\n${bad} dòng "Gây hiểu sai/Lỗi thời": nên vào Memory để Retract hoặc Promote record sau khi ghi.` : ''}\nVerdict là số liệu của pilot M08; ghi xong không sửa được qua console.`,
        ok: 'Ghi vào ledger',
      });
    });
    drawRows();
    const bulk = h('div', { class: 'row' },
      btn('Xác nhận các dòng tin cậy cao', () => { picks.forEach((p) => { if (p.verdict && p.r.confidence === 'high') p.ok = true; }); drawRows(); }, { cls: 'sm', ic: 'check' }),
      btn('Xác nhận tất cả có verdict', () => { picks.forEach((p) => { if (p.verdict) p.ok = true; }); drawRows(); }, { cls: 'sm' }),
      btn('Bỏ chọn', () => { picks.forEach((p) => { p.ok = false; }); drawRows(); }, { cls: 'ghost sm' }));
    const root = h('div', { class: 'quest q-draft' },
      h('div', { class: 'quest-h' }, qtag('flask', 'Bảng nháp verdict'), chip(d.project, 'outline'), chip(d.slice, 'accent'), h('span', { class: 'grow' }), h('span', { class: 'small muted' }, `${d.model} · ${ago(d.created_at)}`)),
      h('p', { class: 'small', style: { margin: '8px 0' } },
        `Sau khi ${d.slice} merge, drafter (AI) đọc ghi chú và review của slice rồi gợi ý: từng bài học memory đưa cho agent có giúp gì không. Bạn xem lại, sửa nếu cần rồi xác nhận để ghi vào số liệu pilot. Dòng "Hữu ích" hoặc tin cậy thấp cần xem kỹ nhất.`),
      verdictGuide(), infoEl, bulk, rowsEl, h('div', { class: 'quest-actions', style: { alignItems: 'center' } }, applyBtn, counter));
    drawInfo();
    loadInfo();
    return root;
  }

  // one card per source file: its rows (what the agent wrote, with the fields it used), then the way out —
  // fix the file to the schema and refresh, or dismiss the whole file (dismiss works per source)
  function triageCard(t) {
    const n = t.count ?? 1, items = t.items ?? [];
    const what = n > 1 ? `${n} dòng` : 'dòng này';
    return h('div', { class: 'quest q-triage' },
      h('div', { class: 'quest-h' }, qtag('archive', 'Triage'), chip(t.source.split(':')[0], 'outline'), n > 1 ? chip(`${n} dòng`, 'warn') : null),
      h('div', { class: 'mono small', style: { marginTop: '6px' } }, t.source), h('div', { class: 'quest-body' }, t.reason),
      items.length ? h('ol', { class: 'triage-items' }, items.map((it) => h('li', {},
        it.keys.length ? h('span', { class: 'mono small ink2' }, `{${it.keys.join(', ')}} `) : null, it.text ?? '(không có nội dung)'))) : null,
      h('div', { class: 'small ink2', style: { marginTop: '6px' } }, 'Sửa file theo schema rồi refresh để giữ bài học; bỏ qua thì các dòng này không vào memory.'),
      h('div', { class: 'quest-actions' }, btn(n > 1 ? `Bỏ qua cả ${n} dòng` : 'Bỏ qua dòng này', () => act('triage.dismiss', { source: t.source }, {
        title: 'Bỏ qua dòng triage', body: `${t.source}\nBỏ qua ${what} của file này. Áp dụng ở lần refresh tiếp theo.`, fields: [{ name: 'note', label: 'Lý do', required: true }], ok: 'Bỏ qua',
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
      h('ul', { style: { margin: '8px 0 0', paddingLeft: '18px' } }, d.items.map((i) => h('li', { class: 'small', style: { margin: '3px 0' } }, i))),
      h('div', { class: 'quest-actions' },
        btn('Đã kiểm', () => signOff(d, 'done'), { cls: 'primary sm', ic: 'check', title: 'Bạn đã tự kiểm các việc này' }),
        btn('Bỏ qua', () => signOff(d, 'waived'), { cls: 'sm', title: 'Không kiểm, chấp nhận rủi ro cho lần ship này' })));
  }

  /** Sign off one slice's deferred manual checks through the runner (`sign-off`); the card then goes away. */
  function signOff(d, how) {
    const done = how === 'done';
    return act('manual.signoff', { project: d.project, slice: d.slice, how }, {
      title: `${done ? 'Đã kiểm' : 'Bỏ qua'} ${d.items.length} việc · ${d.project} ${d.slice}`,
      body: `Runner ghi signed_off vào manual-deferred.json của ${d.slice} (note "${how}: …"); status và Step 3 không hỏi lại slice này. Không gỡ được qua console.`,
      fields: [{ name: 'note', label: done ? 'Kiểm thế nào (máy, kết quả)' : 'Vì sao bỏ qua', required: true, placeholder: done ? 'iPhone 13, chạm và tai thỏ ổn' : 'không có máy thật cho bản này' }],
      ok: done ? 'Ghi đã kiểm' : 'Ghi bỏ qua',
    });
  }

  // ======== worlds
  VIEWS.worlds = async (id) => {
    const ov = store.ov;
    const list = h('div', { class: 'world-list' }, h('div', { class: 'small muted' }, SORT_NOTE), ov.projects.map(worldCard));
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
    h('div', { class: 'row' }, h('span', { class: 'mono small muted grow' }, d.path), btn('Preview', () => go(`preview/${d.id}`), { cls: 'sm', ic: 'phone', title: 'Xem preview đang chạy của dự án (cần editor đang mở)' })),
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
    return [header, nowPanel(d), map, detail, terms];
  }

  /** Where the running slice stands, with the newest evidence images (review screenshots, previews). */
  function nowPanel(d) {
    if (!d.now?.length) return null;
    const live = d.now.some((x) => x.live);
    const verdictTone = (v) => (/APPROVED/.test(v ?? '') ? 'good' : v ? 'warn' : 'outline');
    // a lane terminal still open shows its title; a closed one only that it is closed (its handle is noise)
    const term = (role, t) => (!t ? null : t.live ? chip(`${role}: ${(t.title ?? '').replace(/^[^\p{L}\p{N}(]+/u, '').slice(0, 36) || 'đang mở'}`, 'accent', 'terminal') : chip(`${role} đã đóng`, 'outline', 'terminal'));
    const card = (x) => h('div', { class: 'now-card' },
      h('div', { class: 'row' }, h('b', { class: 'now-slice' }, x.slice), x.live ? h('span', { class: 'chip accent' }, h('span', { class: 'pip live' }), `đang chạy · ${x.phase ?? '—'}`) : chip(`phase ${x.phase ?? '—'}`, x.phase === 'done' ? 'good' : 'outline'),
        chip(x.in_main ? 'lane main' : 'lane worktree', 'outline', 'layers'), x.handoff ? chip(`HANDOFF ${x.handoff.role ?? ''} ${x.handoff.status ?? ''}`.trim(), 'outline', 'doc') : null,
        x.review ? chip(`review ${x.review.verdict ?? 'chưa rõ verdict'} · ${ago(x.review.at)}`, verdictTone(x.review.verdict), 'eye') : null,
        x.static_result ? chip(`static ${x.static_result}`, x.static_result === 'PASS' ? 'good' : 'warn') : null,
        x.fix_rounds != null || x.review_rounds != null ? chip(`fix ${x.fix_rounds ?? '—'} · review ${x.review_rounds ?? '—'}`, 'outline') : null,
        x.wait ? chip(`chờ: ${x.wait}`, 'warn', 'clock') : null),
      h('div', { class: 'row small ink2', style: { marginTop: '6px' } }, term('writer', x.writer), term('reviewer', x.reviewer),
        h('span', { class: 'grow' }), h('span', { class: 'muted' }, `bắt đầu ${ago(x.selected_at)} · cập nhật ${ago(x.updated)}`)),
      x.in_main ? null : h('div', { class: 'mono small muted', style: { marginTop: '4px' } }, x.checkout),
      h('div', { class: 'grid cols-2', style: { marginTop: '10px' } },
        h('div', {}, h('h4', { class: 'hud small muted', style: { margin: '0 0 6px' } }, 'LOG RUNNER GẦN NHẤT'), x.log.length ? h('pre', { class: 'code now-log' }, x.log.join('\n')) : h('div', { class: 'small muted' }, 'Chưa có log.')),
        h('div', {}, h('h4', { class: 'hud small muted', style: { margin: '0 0 6px' } }, `HÌNH MỚI NHẤT TRONG EVIDENCE${x.images.length ? ` · ${x.images.length}` : ''}`),
          x.images.length ? thumbs(x.images) : h('div', { class: 'small muted' }, 'Slice chưa có hình review/preview nào.'))));
    return panel(live ? 'Slice đang chạy' : 'Slice gần nhất', { icon: 'bolt', sub: live ? 'Tình hình lúc này của slice runner đang làm; hình là ảnh mới nhất trong evidence (ảnh review, preview, contact sheet).' : 'Runner không có slice nào đang chạy; đây là slice nó làm gần nhất.' },
      d.now.map(card));
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
        mem.unjudged ? chip(`${mem.unjudged} chưa chấm`, 'warn') : null),
      h('div', { class: 'small ink2', style: { marginTop: '6px' } }, h('span', { class: 'muted' }, 'Verdict: '), vcounts(mem.verdicts)),
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
      h('div', { class: 'stat s-green' }, h('div', { class: 'label' }, icon('check', 14), 'hữu ích'), h('div', { class: 'value' }, sum('useful')), h('div', { class: 'foot' }, `${sum('redundant')} thừa · ${sum('irrelevant')} không liên quan · ${sum('misleading') + sum('stale')} sai/lỗi thời`)),
      h('div', { class: 'stat s-lilac' }, h('div', { class: 'label' }, icon('star', 14), 'trích dẫn'), h('div', { class: 'value' }, cited), h('div', { class: 'foot' }, 'record agent khai báo đã dùng')),
      h('div', { class: `stat ${unjudged ? 's-coral' : 's-green'}` }, h('div', { class: 'label' }, 'chưa chấm'), h('div', { class: 'value' }, unjudged), h('div', { class: 'foot' }, unjudged ? 'bài học chưa có verdict: drafter sẽ soạn nháp' : 'đã chấm hết')));
    const rows = r.slices.filter((s) => s.phase !== 'baseline').map((s) => ({ slice: s.slice, phase: s.phase, verdicts: s.verdicts, unjudged: s.unjudged_items }));
    const legend = h('div', { class: 'legend' }, VERDICTS.map((v) => h('span', { title: VHELP[v] }, h('span', { class: 'swatch', style: { background: `var(--v-${v})` } }), VLABEL[v])));
    const guide = verdictGuide();
    const chart = panel('Verdict theo slice', { icon: 'chart', sub: 'Mỗi cột là một slice (chỉ slice shadow/assist), chồng theo verdict. Số trên cột = tổng bài học đã chấm; "8?" = 8 bài học chưa chấm. Rê chuột lên đoạn màu để xem số lượng.' },
      rows.length ? [legend, guide, h('div', { class: 'graph-wrap' }, verdictColumns(rows, { order: VERDICTS, label: VLABEL }))] : empty('Chỉ có slice baseline: chưa có pack nào để chấm.'));
    const table = panel('Bảng số liệu', { icon: 'list' }, h('div', { class: 'scroll-x' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, [['Slice', 'Mã slice'], ['Phase', 'baseline: không memory · shadow: pack chỉ để đo, agent không thấy · assist: agent đọc pack'], ['Fix', 'Số vòng sửa lỗi sau review'], ['Review', 'Số vòng review'], ['Lặp lại', 'Số lỗi tái diễn đã đánh dấu'], ['Hook', 'Số lần gọi hook memory'], ['Token vào', 'Token pack memory đưa cho agent'], ['Verdict (đã chấm)', 'Số bài học theo từng verdict: màu xem chú giải phía trên'], ['Trích dẫn', 'Record mà ghi chú của slice nhắc tới'], ['Lệch kế hoạch', 'Điểm slice làm khác kế hoạch']].map(([x, tip], i) => h('th', { class: i >= 2 && i <= 6 ? 'num' : '', title: tip }, x)))),
      h('tbody', {}, r.slices.map((s) => h('tr', {},
        h('td', {}, h('b', { class: 'hud' }, s.slice)), h('td', {}, chip(s.phase, modeTone(s.phase === 'baseline' ? 'off' : s.phase))),
        h('td', { class: 'num' }, s.fix_rounds ?? '—'), h('td', { class: 'num' }, s.review_rounds ?? '—'), h('td', { class: 'num' }, s.recurring.length),
        h('td', { class: 'num' }, s.memory.hook_calls), h('td', { class: 'num' }, s.memory.injected_tokens),
        h('td', {}, vcounts(s.verdicts), s.unjudged_items ? h('div', { class: 'small muted' }, `${s.unjudged_items} chưa chấm`) : null),
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

  // ======== preview: each open Creator editor's live preview in a phone frame
  // The frame loads http://127.0.0.1:<port>/ from this browser, so it works on the Mac that runs the
  // editors. One way only: a preview lives while its editor runs and never keeps one open (res-guard
  // counts a browser as a viewer, not a client). Once the editor closes (its worktree is done, the
  // director or res-guard closed it) the next poll drops the frame. A hidden tab unloads it too.
  const PHONE = { w: 390, h: 844 }; // CSS px of a 6.1" phone
  const BEZEL = 12;
  const POLL_MS = 5000;
  const pv = { sel: null, orient: {}, paused: null, gone: null, list: [], poll: null };
  const onMac = ['127.0.0.1', 'localhost'].includes(location.hostname);
  const pvKey = (e) => e.path;

  VIEWS.preview = async (arg) => {
    pv.list = await api('/api/previews');
    const live = pv.list.filter((e) => e.alive);
    // #preview/<project> picks that project's editor (main first); otherwise keep the pick, else the first live one
    const want = arg ? live.filter((e) => e.project === arg).sort((a, b) => (a.checkout === 'main' ? -1 : 0) - (b.checkout === 'main' ? -1 : 0))[0] : null;
    if (want) pv.sel = pvKey(want);
    if (!live.some((e) => pvKey(e) === pv.sel)) pv.sel = live[0] ? pvKey(live[0]) : null;
    pv.paused = null;
    pv.gone = null;
    const listEl = h('div', { class: 'world-list' });
    const stage = h('div');
    const drawList = () => listEl.replaceChildren(...(pv.list.length ? pv.list.map(previewCard) : [empty('Không có Cocos editor nào đang mở.', 'phone', 'Preview chỉ có khi editor của dự án đang mở và preview server trả lời.')]));
    function previewCard(e) {
      const on = pvKey(e) === pv.sel;
      return h('button', { class: `world ${on ? 'on' : ''}`, type: 'button', disabled: !e.alive, style: e.alive ? null : { opacity: 0.6, cursor: 'default' },
        onclick: () => { if (!e.alive || on) return; pv.sel = pvKey(e); pv.paused = null; pv.gone = null; drawList(); drawStage(); } },
        h('div', { class: 'world-h' }, h('b', { class: 'grow' }, e.project), e.alive ? h('span', { class: 'chip good' }, h('span', { class: 'pip live' }), 'sống') : chip('preview không trả lời', 'bad')),
        h('div', { class: 'row small ink2' }, chip(e.checkout === 'main' ? 'main' : `worktree ${e.checkout}`, 'outline'), e.port ? h('span', { class: 'mono' }, `:${e.port}`) : null, h('span', { class: 'grow' }), chip(e.orientation.value === 'landscape' ? 'ngang' : 'dọc', 'outline', e.orientation.value === 'landscape' ? 'phoneh' : 'phone')),
        h('div', { class: 'small muted' }, [e.branch && e.branch !== e.checkout ? `nhánh ${e.branch}` : null, e.runner ? `runner ${e.runner.alive ? 'chạy' : 'nghỉ'} · ${e.runner.slice ?? '—'} ${e.runner.step ?? ''}` : null, `editor mở ${e.up_min} phút`].filter(Boolean).join(' · ')));
    }
    function drawStage() {
      const e = pv.list.find((x) => pvKey(x) === pv.sel && x.alive);
      if (!e && pv.gone) return stage.replaceChildren(panel(`${pv.gone.project} · ${pv.gone.checkout}`, { icon: 'phone' },
        empty(pv.gone.closed ? 'Editor đã đóng: preview đã gỡ.' : 'Preview ngừng trả lời: đã gỡ.', 'stop',
          pv.gone.closed ? 'Worktree xong, director hoặc res-guard đã đóng editor. Preview chỉ sống cùng editor; mở lại editor để xem tiếp.' : 'Editor vẫn chạy nhưng preview server không trả lời (đang build lại hoặc lỗi).')));
      if (!e) return stage.replaceChildren(panel('Preview', { icon: 'phone' }, empty('Chưa có preview nào sống.', 'phone', 'Mở editor của dự án (hoặc để runner mở), rồi bấm làm mới.')));
      const orient = pv.orient[pvKey(e)] ?? e.orientation.value;
      const [fw, fh] = orient === 'landscape' ? [PHONE.h, PHONE.w] : [PHONE.w, PHONE.h];
      const seg = h('div', { class: 'seg' }, [['portrait', 'Dọc', 'phone'], ['landscape', 'Ngang', 'phoneh']].map(([v, label, ic]) =>
        h('button', { type: 'button', class: orient === v ? 'on' : '', title: v === e.orientation.value ? `Mặc định của dự án (${e.orientation.source})` : null,
          onclick: () => { pv.orient[pvKey(e)] = v; drawStage(); } }, icon(ic, 15), label, v === e.orientation.value ? h('span', { class: 'small', style: { opacity: 0.7 } }, '(mặc định)') : null)));
      const screen = h('div', { class: 'phone-screen', style: { width: `${fw}px`, height: `${fh}px` } });
      const phone = h('div', { class: `phone ${orient}`, style: { width: `${fw + BEZEL * 2}px`, height: `${fh + BEZEL * 2}px` } }, screen);
      const sizer = h('div', { class: 'phone-sizer' }, phone);
      const load = () => {
        screen.replaceChildren(h('iframe', { src: e.url, title: `Preview ${e.project}`, referrerpolicy: 'no-referrer', allow: 'autoplay; fullscreen', style: { width: `${fw}px`, height: `${fh}px` } }));
      };
      const pauseNote = (why) => screen.replaceChildren(h('div', { class: 'phone-note' }, icon('pause', 28), h('b', {}, why),
        h('div', { class: 'small' }, 'Preview đã gỡ khỏi trang trong lúc tab ẩn.'), btn('Tiếp tục', () => { pv.paused = null; load(); }, { cls: 'primary sm', ic: 'play' })));
      if (!onMac) screen.replaceChildren(h('div', { class: 'phone-note' }, icon('lock', 28), h('b', {}, 'Chỉ xem được trên máy Mac chạy editor'),
        h('div', { class: 'small' }, `Preview ở ${e.url} trên máy đó; mở console bằng http://127.0.0.1:7792 để xem.`)));
      else if (pv.paused) pauseNote(pv.paused);
      else load();
      const fit = () => {
        const aw = Math.max(200, sizer.clientWidth);
        const ah = Math.max(360, window.innerHeight - sizer.getBoundingClientRect().top - 28);
        const k = Math.min(1, aw / (fw + BEZEL * 2), ah / (fh + BEZEL * 2));
        phone.style.transform = `scale(${k})`;
        sizer.style.height = `${Math.ceil((fh + BEZEL * 2) * k)}px`;
      };
      new ResizeObserver(fit).observe(sizer);
      const right = h('div', { class: 'row', style: { flexWrap: 'wrap' } }, seg,
        btn('Tải lại', () => { pv.paused = null; if (onMac) load(); }, { cls: 'sm', ic: 'refresh' }),
        h('a', { class: 'btn sm', href: e.url, target: '_blank', rel: 'noopener noreferrer', title: 'Mở preview đầy đủ (có thanh công cụ Cocos) trong tab mới' }, icon('external', 15), 'Tab mới'));
      stage.replaceChildren(panel(`${e.project} · ${e.checkout}`, { icon: 'phone', sub: `Khung ${fw}×${fh} (điện thoại 6.1"). Orientation mặc định: ${e.orientation.value === 'landscape' ? 'ngang' : 'dọc'} theo ${e.orientation.source}. Preview chạy scene đang mở trong editor.` },
        h('div', { style: { marginBottom: '14px' } }, right), sizer));
      requestAnimationFrame(fit);
    }
    // keep the list fresh while this tab is open; a preview whose editor closed or that stops answering is unloaded
    clearInterval(pv.poll);
    pv.poll = setInterval(async () => {
      if (route.view !== 'preview') { clearInterval(pv.poll); return; }
      if (document.hidden) return;
      const fresh = await api('/api/previews').catch(() => null);
      if (!fresh) return;
      const was = pv.list.find((x) => pvKey(x) === pv.sel && x.alive);
      pv.list = fresh;
      const now = fresh.find((x) => pvKey(x) === pv.sel);
      drawList();
      if (was && !now?.alive) {
        // the editor went away (or its preview stopped): drop the frame and say why; never pick another by itself
        pv.gone = { project: was.project, checkout: was.checkout, closed: !now };
        drawStage();
      } else if (pv.gone && now?.alive) {
        pv.gone = null; // the same checkout's editor is back
        drawStage();
      } else if (!pv.sel && fresh.some((x) => x.alive)) {
        pv.sel = pvKey(fresh.find((x) => x.alive));
        drawStage();
      }
    }, POLL_MS);
    drawList();
    drawStage();
    return h('div', { class: 'layout-worlds' }, h('div', { style: { display: 'grid', gap: '12px', alignContent: 'start' } },
      h('div', { class: 'row' }, h('b', { class: 'grow' }, `${pv.list.filter((e) => e.alive).length}/${pv.list.length} preview sống`), btn('', () => render(), { cls: 'ghost sm', ic: 'refresh', title: 'Dò lại editor' })), listEl), stage);
  };
  // a hidden tab drops the frame (no editor client in the background); coming back reloads it
  document.addEventListener('visibilitychange', () => {
    if (route.view !== 'preview' || !pv.sel) return;
    if (document.hidden && !pv.paused) { pv.paused = 'Tab đã ẩn'; document.querySelector('.phone-screen')?.replaceChildren(); }
    else if (!document.hidden && pv.paused === 'Tab đã ẩn') { pv.paused = null; render(); }
  });

  // ======== scorecard + log
  VIEWS.scorecard = async () => [panel('Workflow scorecard', { icon: 'chart', sub: 'Dashboard mới nhất do job scorecard 09:17 tạo.' },
    h('iframe', { class: 'score', src: `/scorecard?t=${encodeURIComponent(TOKEN)}`, sandbox: 'allow-scripts', title: 'Scorecard' }))];

  // ======== resources: res-guard's last sample, the editors and their verdicts, a 24 h trend, events
  const gb = (mb) => `${(mb / 1024).toFixed(1)} GB`;
  /** One 24 h line chart: points [{at, v}] scaled into 0..max, with the latest value as a label. */
  function trendLine(points, { max, color, label, unit }) {
    const NS = 'http://www.w3.org/2000/svg';
    const W = 600, H = 90;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('class', 'trend');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.style.width = '100%';
    svg.style.height = '90px';
    if (points.length > 1) {
      const t0 = Date.parse(points[0].at), t1 = Date.parse(points.at(-1).at) || t0 + 1;
      const xy = points.map((p) => `${(((Date.parse(p.at) - t0) / Math.max(1, t1 - t0)) * W).toFixed(1)},${(H - 4 - (Math.min(p.v, max) / max) * (H - 8)).toFixed(1)}`);
      const line = document.createElementNS(NS, 'polyline');
      line.setAttribute('points', xy.join(' '));
      line.setAttribute('fill', 'none');
      line.setAttribute('stroke', color);
      line.setAttribute('stroke-width', '2.5');
      line.setAttribute('vector-effect', 'non-scaling-stroke');
      svg.append(line);
    }
    const last = points.at(-1);
    return h('div', {}, h('div', { class: 'row' }, h('b', { class: 'small' }, label), h('span', { class: 'grow' }),
      h('span', { class: 'mono small' }, last ? `${last.v}${unit}` : '—')), svg);
  }
  const VERDICT_TONE = { keep: 'good', close: 'warn', gone: 'bad' };

  // ======== quota: the OmniRoute accounts. Claude per account; Codex (weekly) and agy image as one
  // share bar each: every account is 1/N of the bar, filled by what it has left, the empty part is
  // used. An account keeps its colour (--q-<order in OmniRoute>) whatever is left out.
  const LOW_PCT = 15;
  const shortWho = (who) => String(who ?? '?').split('@')[0];
  const pctOf = (w) => (w ? `${Math.round(w.remaining)}%` : '—');
  const resetIn = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms)) return '';
    if (ms <= 0) return 'reset rồi';
    const m = Math.round(ms / 60000), hh = Math.floor(m / 60), d = Math.floor(hh / 24);
    return `reset sau ${d >= 1 ? `${d} ngày ${hh % 24} giờ` : hh >= 1 ? `${hh} giờ ${m % 60} phút` : `${m} phút`}`;
  };
  const qColor = (i) => `var(--q-${(i % 7) + 1})`;
  const sourceChip = (a) => (a.source === 'live' ? null : a.source === 'snapshot'
    ? chip(`số cũ · ${ago(a.as_of)}`, 'warn', 'clock') : chip('không lấy được', 'bad', 'alert'));

  const QOPEN_KEY = 'console-quota-open';
  const qOpen = () => { try { return JSON.parse(localStorage.getItem(QOPEN_KEY) || '{}') || {}; } catch { return {}; } };
  /**
   * The account list of one provider; the summary says what matters. Claude's list opens on every
   * load; the others start folded and keep the open state per browser.
   */
  const Q_ALWAYS_OPEN = new Set(['claude']);
  function accList(key, summary, ...body) {
    const d = h('details', { class: 'qacc', open: Q_ALWAYS_OPEN.has(key) || !!qOpen()[key] },
      h('summary', {}, h('span', { class: 'chev' }, icon('chev', 14)), ...summary), h('div', { class: 'qacc-body' }, ...body));
    d.addEventListener('toggle', () => { try { localStorage.setItem(QOPEN_KEY, JSON.stringify({ ...qOpen(), [key]: d.open })); } catch {} });
    return d;
  }

  /** One share bar: rows [{ i, who, w }] where w is the window; tip names the account and its numbers. */
  function shareBar(rows, { thin = false, tip }) {
    const n = rows.length || 1;
    const bar = h('div', { class: `qbar ${thin ? 'thin' : ''}`, role: 'img' });
    for (const r of rows) {
      const left = r.w?.remaining ?? 0;
      if (!left) continue;
      const seg = h('i', { style: { width: `${left / n}%`, '--c': qColor(r.i) } });
      tipOn(seg, () => tip(r));
      bar.append(seg);
    }
    const total = rows.reduce((t, r) => t + (r.w?.remaining ?? 0), 0) / n;
    bar.setAttribute('aria-label', `còn ${Math.round(total)}% tổng`);
    return { bar, total };
  }

  function quotaPanel() {
    const body = h('div', { class: 'qgrid' }, h('div', { class: 'small muted' }, 'Đang hỏi OmniRoute… (agy mất vài giây mỗi account)'));
    const when = h('span', { class: 'small muted' });
    const draw = async (force) => {
      let q;
      try { q = await api(`/api/quota${force ? '?force=1' : ''}`); } catch (e) { body.replaceChildren(empty(`Không lấy được quota: ${e.message}`, 'alert')); return; }
      when.textContent = `cập nhật ${ago(q.at)}`;
      if (q.error) { body.replaceChildren(empty(q.error, 'alert')); return; }
      body.replaceChildren(claudeBlock(q.claude), codexBlock(q.codex), agyBlock(q.agy));
    };
    draw(false);
    return panel('Quota', { icon: 'chart', right: h('div', { class: 'row' }, when, btn('Làm mới', () => draw(true), { cls: 'sm', ic: 'refresh', title: 'Hỏi lại OmniRoute ngay (tối đa một lần mỗi phút)' })),
      sub: 'Account trong OmniRoute, số trực tiếp từ /api/usage (Claude/Codex cache 2 phút, agy 10 phút). Khi OmniRoute không trả lời: snapshot cuối của nó, ghi "số cũ".' }, body);
  }

  function claudeBlock(list) {
    const meter = (label, w) => h('div', { class: 'qrow' }, h('span', { class: 'small ink2' }, label),
      h('div', { class: 'qmeter' }, w?.remaining ? h('i', { style: { width: `${w.remaining}%` } }) : null),
      h('b', { class: 'mono' }, pctOf(w)), h('span', { class: 'small muted reset' }, w?.resetAt ? resetIn(w.resetAt) : ''));
    const on = list.filter((a) => a.active);
    const windows = on.flatMap((a) => [['5 giờ', a.session, a], ['7 ngày', a.weekly, a]]).filter(([, w]) => w);
    const lowest = windows.sort((x, y) => x[1].remaining - y[1].remaining)[0];
    const lowCount = on.filter((a) => [a.session, a.weekly].some((w) => w && w.remaining < LOW_PCT)).length;
    return h('div', {}, h('h3', { style: { margin: '0 0 8px' } }, `Claude · ${on.length}/${list.length} account đang bật`),
      list.length ? accList('claude', [h('span', {}, `${list.length} account`), lowest ? h('span', { class: 'small muted' }, `· thấp nhất ${pctOf(lowest[1])} (${shortWho(lowest[2].who)}, ${lowest[0]})`) : null,
        h('span', { class: 'grow' }), lowCount ? chip(`${lowCount} sắp cạn`, 'bad', 'alert') : null],
      ...list.map((a) => {
        const low = a.active && [a.session, a.weekly].some((w) => w && w.remaining < LOW_PCT);
        return h('div', { style: a.active ? null : { opacity: 0.55 } },
          h('div', { class: 'row', style: { marginBottom: '4px' } }, h('b', { title: a.who }, shortWho(a.who)), a.plan ? chip(a.plan.replace(/^default_/, ''), 'outline') : null,
            a.active ? null : chip('tắt trong OmniRoute', 'outline'), low ? chip('sắp cạn', 'bad', 'alert') : null, sourceChip(a),
            a.error && a.source !== 'live' ? h('span', { class: 'small muted' }, a.error) : null),
          meter('5 giờ', a.session), meter('7 ngày', a.weekly));
      })) : empty('Không có account Claude nào trong OmniRoute.', 'user'));
  }

  function legend(rows, cols) {
    return h('div', { class: 'qlegend' }, rows.flatMap((r) => {
      const cls = r.off ? 'off' : '';
      return [h('span', { class: `sw ${cls}`, style: { background: qColor(r.i) } }), h('span', { class: cls, title: r.who }, shortWho(r.who), r.off ? h('span', { class: 'small muted' }, ` · ${r.off}`) : null),
        h('b', { class: `mono ${cls}` }, cols.main(r)), h('span', { class: `small muted rest ${cls}` }, cols.rest(r))];
    }));
  }

  function codexBlock(list) {
    const rows = list.map((a, i) => ({ ...a, i, w: a.weekly, off: a.active ? null : 'tắt trong OmniRoute' }));
    const on = rows.filter((r) => !r.off);
    const tip = (r) => `${r.who}: tuần ${pctOf(r.weekly)} · 5 giờ ${pctOf(r.session)}${r.weekly?.resetAt ? ` · tuần ${resetIn(r.weekly.resetAt)}` : ''}`;
    const weekly = shareBar(on, { tip });
    const session = shareBar(on.map((r) => ({ ...r, w: r.session })), { thin: true, tip });
    return h('div', {}, h('div', { class: 'row', style: { marginBottom: '6px' } }, h('h3', { style: { margin: 0 } }, `Codex · ${on.length}/${list.length} account đang bật`), h('span', { class: 'grow' }),
      h('b', {}, `còn ${Math.round(weekly.total)}% tuần`), h('span', { class: 'small muted' }, `· 5 giờ ${Math.round(session.total)}%`)),
      list.length ? [weekly.bar, h('div', { class: 'row small muted', style: { margin: '4px 0 2px' } }, '5 giờ'), session.bar,
        accList('codex', [h('span', {}, `${list.length} account`), h('span', { class: 'small muted' }, `· thấp nhất ${pctOf([...on].sort((x, y) => (x.weekly?.remaining ?? 0) - (y.weekly?.remaining ?? 0))[0]?.weekly)} tuần`)], legend(rows, { main: (r) => pctOf(r.weekly), rest: (r) => [`5 giờ ${pctOf(r.session)}`, r.weekly?.resetAt ? `tuần ${resetIn(r.weekly.resetAt)}` : null, r.source !== 'live' ? (r.source === 'snapshot' ? `số cũ ${ago(r.as_of)}` : 'không lấy được') : null].filter(Boolean).join(' · ') }))]
        : empty('Không có account Codex nào đang bật.', 'user'));
  }

  function agyBlock(list) {
    const all = list.map((a, i) => ({ ...a, i, w: a.image, off: a.valid ? null : a.why }));
    const valid = all.filter((r) => !r.off);
    const tip = (r) => `${r.who}: ảnh dùng được ${pctOf(r.image)} (model ${pctOf(r.image?.model)} · Gemini tuần ${pctOf(r.image?.weekly)})${r.image?.resetAt ? ` · ${resetIn(r.image.resetAt)}` : ''}`;
    const bar = shareBar(valid, { tip });
    return h('div', {}, h('div', { class: 'row', style: { marginBottom: '6px' } }, h('h3', { style: { margin: 0 } }, `agy · gen ảnh · ${valid.length}/${list.length} account valid`), h('span', { class: 'grow' }),
      h('b', {}, `còn ${Math.round(bar.total)}%`)),
      valid.length ? bar.bar : empty('Không có account agy nào valid cho gen ảnh.', 'alert'),
      h('div', { class: 'small muted', style: { margin: '4px 0 8px' } }, 'Mỗi account = min(quota model gemini-3.1-flash-image, quota tuần Gemini): OmniRoute từ chối khi một trong hai cạn.'),
      accList('agy', [h('span', {}, `${list.length} account`), h('span', { class: 'small muted' }, `· ${valid.length} valid${all.length - valid.length ? `, ${all.length - valid.length} bị loại` : ''}`)], legend(all, { main: (r) => (r.off ? '—' : pctOf(r.image)), rest: (r) => [r.image ? `model ${pctOf(r.image.model)} · tuần ${pctOf(r.image.weekly)}` : null, r.image?.resetAt ? resetIn(r.image.resetAt) : null, r.source !== 'live' ? (r.source === 'snapshot' ? `số cũ ${ago(r.as_of)}` : 'không lấy được') : null].filter(Boolean).join(' · ') })));
  }

  VIEWS.resources = async () => {
    const r = await api('/api/resources');
    const s = r.last;
    if (!s) return [panel('Tài nguyên máy', { icon: 'bolt' }, empty('res-guard chưa đo lần nào.', 'alert', 'Cài watcher: node ~/.agents/tools/res-guard/res-guard.mjs install-launchd')), quotaPanel()];
    const tile = (label, value, foot, tone, ic) => h('div', { class: `stat s-${tone}` },
      h('div', { class: 'label' }, icon(ic, 14), label), h('div', { class: 'value text' }, value), h('div', { class: 'foot' }, foot));
    const pressTone = s.pressure === 'critical' ? 'coral' : s.pressure === 'warn' ? 'yellow' : 'green';
    const stats = h('div', { class: 'stats' },
      tile('RAM còn trống', `${s.availPct}%`, `áp lực ${s.pressure} · nén ${gb(s.compressorMB)}`, pressTone, 'chip'),
      tile('Swap', gb(s.swapUsedMB), s.swapUsedMB > 4096 ? 'quá 4 GB: máy sẽ chậm' : 'trong ngưỡng', s.swapUsedMB > 4096 ? 'coral' : 'green', 'layers'),
      tile('Đĩa trống', `${s.diskFreeGB} GB`, s.diskFreeGB < 20 ? 'dưới 20 GB: swap thiếu chỗ' : 'đủ cho swap', s.diskFreeGB < 20 ? 'coral' : 'blue', 'archive'),
      tile('Cocos editor', `${s.editors.length}`, s.editors.map((e) => gb(e.footMB)).join(' · ') || 'không mở', s.editors.length > 2 ? 'coral' : 'pink', 'globe'),
      tile('Claude', `${s.claude.n}`, `${gb(s.claude.footMB)} tổng`, 'lilac', 'terminal'),
      tile('OmniRoute', s.omniroute?.pid ? gb(s.omniroute.footMB) : 'tắt', r.omniroute?.lastRestart ? `restart ${ago(r.omniroute.lastRestart)}` : 'tự restart khi > 1.5 GB lúc rảnh', 'yellow', 'refresh'));
    const head = h('div', { class: 'row' },
      chip(r.stale ? 'watcher ngừng' : `đo ${ago(r.lastTick)}`, r.stale ? 'bad' : 'good', r.stale ? 'alert' : 'clock'),
      r.installed ? null : chip('chưa cài launchd', 'bad', 'alert'),
      ...r.alerts.map((a) => chip(a.title, a.level === 'critical' ? 'bad' : 'warn', 'alert')));
    const trend = panel('24 giờ qua', { icon: 'chart', sub: 'Mỗi phút một mẫu (rút gọn còn ≤ 288 điểm).' }, h('div', { class: 'grid cols-2' },
      trendLine(r.trend.map((p) => ({ at: p.at, v: p.availPct })), { max: 100, color: 'var(--v-useful)', label: 'RAM còn trống', unit: '%' }),
      trendLine(r.trend.map((p) => ({ at: p.at, v: p.swapGB })), { max: Math.max(4, ...r.trend.map((p) => p.swapGB)), color: 'var(--v-stale)', label: 'Swap', unit: ' GB' })));
    const editors = panel('Cocos editor', { icon: 'globe', sub: 'Giữ editor đang hoặc sắp được dùng; editor chỉ đang chờ (primary khi fleet chạy trong worktree, hoặc rảnh 20 phút) sẽ tự đóng.' },
      r.editors.length ? h('div', { class: 'scroll-x' }, h('table', { class: 't' },
        h('thead', {}, h('tr', {}, ['Checkout', 'RAM', 'Quyết định', 'Lý do', ''].map((x, i) => h('th', { class: i === 1 ? 'num' : '' }, x)))),
        h('tbody', {}, r.editors.map((e) => h('tr', {},
          h('td', { class: 'mono small' }, e.project), h('td', { class: 'num' }, gb(e.footMB)),
          h('td', {}, chip(e.verdict, VERDICT_TONE[e.verdict] ?? 'outline')), h('td', { class: 'small ink2' }, e.why),
          h('td', {}, btn('Đóng', () => act('editor.close', { project: e.project }, { title: `Đóng editor · ${e.project.split('/').slice(-2).join('/')}`, body: `${e.why}\n\nEditor đang mở sẽ bị đóng (close-editor.sh). Runner mở lại main khi single lane cần.`, ok: 'Đóng', danger: true }), { cls: 'sm ghost', ic: 'x' }))))))) : empty('Không editor nào đang mở.'));
    const top = panel('Tốn RAM nhất', { icon: 'list' }, h('div', { class: 'scroll-x' }, h('table', { class: 't' },
      h('thead', {}, h('tr', {}, ['Tiến trình', 'PID', 'RAM'].map((x, i) => h('th', { class: i ? 'num' : '' }, x)))),
      h('tbody', {}, s.top.map((t) => h('tr', {}, h('td', {}, t.name), h('td', { class: 'num mono' }, t.pid), h('td', { class: 'num' }, gb(t.footMB))))))));
    const events = panel('Sự kiện res-guard', { icon: 'bell' }, r.events.length ? h('div', { class: 'timeline' }, r.events.map((e) => h('div', { class: 'tl' },
      h('span', { class: `dot ${/reap|down|critical/.test(e.kind + (e.level ?? '')) ? 'bad' : ''}` }),
      h('div', {}, h('div', { class: 'row' }, h('b', { class: 'mono small' }, e.kind), h('span', { class: 'small muted' }, `${when(e.at)} · ${ago(e.at)}`)),
        h('div', { class: 'small ink2' }, [e.title, e.why, e.project, e.gate, (e.reasons ?? []).join('; '), e.result].filter(Boolean).join(' · ').slice(0, 260)))))) : empty('Chưa có sự kiện.', 'bell'));
    return [panel('Tài nguyên máy', { icon: 'bolt', right: head }, stats), quotaPanel(), trend, editors, h('div', { class: 'grid cols-2' }, top, events)];
  };

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
  // a hidden tab keeps polling the light attention list (browsers slow it to about once a minute)
  setInterval(() => { if (!document.hidden) refresh(false); else pollAttention(); }, 20000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(false); });
})();
