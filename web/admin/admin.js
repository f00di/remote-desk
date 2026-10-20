// Remote Desk admin page (this computer only). Polls /api/status and
// redraws. Device, folder and file names are always set as text.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const icon = (name, size = 16, cls) => window.RD.icon(name, size, cls);
  const themes = window.RD.themes;

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  // ---------- keys ----------
  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
  const KEY = mac
    ? { mod: '⌘', alt: '⌥', enter: '↵', bksp: '⌫', sep: '' }
    : { mod: 'Ctrl', alt: 'Alt', enter: 'Enter', bksp: 'Bksp', sep: '+' };
  const keycaps = (...ks) => ks.map((k) => KEY[k] || k);
  const combo = (...ks) => keycaps(...ks).join(KEY.sep);

  // ---------- state ----------
  const SECTIONS = {
    status: { label: 'Status', icon: 'broadcast' },
    phone: { label: 'Your phone', icon: 'phone' },
    folders: { label: 'Shared folders', icon: 'folder' },
    activity: { label: 'Activity', icon: 'pulse' },
    settings: { label: 'Settings', icon: 'settings' },
  };
  const ORDER = ['status', 'phone', 'folders', 'activity', 'settings'];
  const ui = {
    section: loadPref('section', 'status'), filter: 'all', unpairAsk: false, adding: false, settingsQ: '', overlay: null,
  };
  if (!SECTIONS[ui.section]) ui.section = 'status';
  let S = null; // the last /api/status answer
  let lastKey = '';
  let lastOK = 0;
  let down = false;
  let stopped = false;

  function loadPref(k, d) {
    try { return localStorage.getItem('rd.' + k) || d; } catch { return d; }
  }
  function savePref(k, v) {
    try { localStorage.setItem('rd.' + k, v); } catch { /* private mode */ }
  }

  async function api(method, url, body) {
    const res = await fetch(url, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new Error((data && data.error) || 'Error ' + res.status);
    return data;
  }

  const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  // tilde shortens a path in the home folder to ~/… for display.
  const tilde = (p) => p.replace(/^\/Users\/[^/]+(?=\/|$)/, '~').replace(/^[A-Za-z]:\\Users\\[^\\]+(?=\\|$)/, '~');

  // act runs an API call, shows what went wrong, and refreshes.
  async function act(fn, done) {
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toast(sentence(e.message), { tone: 'danger' });
    }
    await refresh(true);
  }

  // In the desktop window, links open in the default browser.
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[target="_blank"]');
    if (a && window.runtime && window.runtime.BrowserOpenURL) {
      e.preventDefault();
      window.runtime.BrowserOpenURL(a.href);
    }
  });

  // ---------- time ----------
  const two = (n) => String(n).padStart(2, '0');
  const mmss = (s) => two(Math.floor(s / 60)) + ':' + two(s % 60);
  const secsLeft = (iso) => Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 1000));
  const today = (d) => d.toDateString() === new Date().toDateString();
  const hm = (d) => two(d.getHours()) + ':' + two(d.getMinutes());
  const dayMonth = (d) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  function ago(t) {
    if (!t) return 'never';
    const s = Math.max(0, Math.round((Date.now() - new Date(t).getTime()) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return dayMonth(new Date(t));
  }
  const stamp = (t) => {
    const d = new Date(t);
    return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })} · ${hm(d)}`;
  };
  function logTime(t) {
    const d = new Date(t);
    if (today(d)) return `${hm(d)}:${two(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
    return `${dayMonth(d)} ${hm(d)}`;
  }

  // ---------- what the status means ----------
  const ready = (s) => !!s.siteURL && (s.dev || s.tailscale.serving);
  const pending = (s) => (s.auth.pairing && s.auth.pairing.requests) || [];
  const recent = (t) => t && Date.now() - new Date(t).getTime() < 2 * 60 * 1000;

  function tsInfo(s) {
    const t = s.tailscale;
    if (s.dev) return { tone: 'warning', short: 'dev mode', meta: 'dev mode' };
    if (t.serving) return { tone: 'ok', short: t.dnsName, meta: 'connected' };
    if (t.state === 'NeedsLogin' || t.state === 'NoState') return { tone: 'danger', short: 'Tailscale: sign in', meta: 'offline' };
    return { tone: 'warning', short: 'Tailscale: setting up', meta: 'setting up' };
  }

  function phoneInfo(s) {
    const d = s.auth.device;
    if (d && d.locked) return { tone: 'danger', meta: 'locked', long: `${d.label} · locked`, bar: d.label };
    if (d) return recent(d.lastSeen)
      ? { tone: 'ok', meta: 'online', long: `${d.label} · online`, bar: d.label }
      : { tone: 'muted', meta: 'paired', long: `${d.label} · paired`, bar: d.label };
    if (pending(s).length) return { tone: 'warning', meta: 'request', long: 'Pairing request waiting', bar: 'Pairing request' };
    return { tone: 'muted', meta: 'not paired', long: 'Not paired', bar: 'No phone' };
  }

  function awakeInfo(s) {
    if (!s.keepAwake.supported || s.dev) return { short: 'Awake: n/a', long: 'Not available here', meta: 'n/a' };
    return s.keepAwake.enabled
      ? { short: 'Awake: on', long: 'On while plugged in', meta: 'on' }
      : { short: 'Awake: off', long: 'Off', meta: 'off' };
  }

  // Activity entries are sentences ("Phone paired"); the log shows a short
  // kind, a colour and a filter group for each.
  const EVENTS = [
    [/^Viewed$/, 'open', 'muted', 'browse'],
    [/^Downloaded$/, 'download', 'match', 'dl'],
    [/^Pairing requested/, 'pair', 'warning', 'pair'],
    [/^Phone paired/, 'pair', 'ok', 'pair'],
    [/^Pairing attempt refused/, 'pair', 'danger', 'pair'],
    [/^Pairing denied/, 'pair', 'muted', 'pair'],
    [/^Phone unpaired/, 'pair', 'warning', 'pair'],
    [/^Wrong PIN/, 'auth', 'warning', 'sec'],
    [/^Phone unlocked/, 'auth', 'ok', 'sec'],
    [/^Protected folders/, 'auth', 'muted', 'sec'],
    [/^Shared folders/, 'folders', 'muted', 'other'],
    [/quit/i, 'app', 'muted', 'other'],
  ];
  function logEntry(a) {
    const m = EVENTS.find(([re]) => re.test(a.event)) || [null, 'event', 'muted', 'other'];
    const file = m[3] === 'browse' || m[3] === 'dl';
    const text = file ? a.detail : [a.event[0].toLowerCase() + a.event.slice(1), a.detail].filter(Boolean).join(' · ');
    return { t: logTime(a.time), kind: m[1], tone: m[2], cat: m[3], text, time: a.time };
  }
  const FILTERS = [['all', 'All'], ['browse', 'Browsing'], ['dl', 'Downloads'], ['pair', 'Pairing'], ['sec', 'PIN and locks']];
  const inFilter = (f, e) => f === 'all' || e.cat === f;

  function logRows(entries) {
    return entries.map((e) => h('div', { class: 'log-row' },
      h('span', { class: 't', text: e.t }), h('span', { class: 'tone-' + e.tone, text: e.kind }), h('span', { class: 'p', text: e.text })));
  }

  // ---------- small pieces ----------
  function btn(label, onclick, cls = '', ic, keys) {
    return h('button', { class: 'btn' + (cls ? ' ' + cls : '') + (keys ? ' kbd-btn' : ''), type: 'button', onclick },
      ic ? icon(ic, 14) : null, label, keys ? h('span', { class: 'k', text: keys }) : null);
  }
  const link = (label, href, cls = '') => h('a', { class: 'btn' + (cls ? ' ' + cls : ''), href, target: '_blank', rel: 'noopener' }, label, icon('external', 14));
  const dot = (tone, extra = '') => h('span', { class: `dot ${tone}${extra ? ' ' + extra : ''}`, 'aria-hidden': 'true' });
  const kv = (key, val) => h('div', { class: 'kv' }, h('span', { class: 'key', text: key }), h('span', { class: 'val', text: val }));

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const t = h('textarea', { 'aria-hidden': 'true' });
      t.value = text;
      document.body.append(t);
      t.select();
      document.execCommand('copy');
      t.remove();
    }
    toast('Copied ' + text);
  }
  const copyBtn = (text, label) => h('button', { class: 'copy', type: 'button', 'aria-label': label, title: label, onclick: () => copy(text) }, icon('copy', 14));

  // countdown fills in an element's "mm:ss" (and a bar's width) until iso.
  function countdown(iso, total, bar) {
    const el = h('span', { 'data-until': iso, 'data-total': total, text: mmss(secsLeft(iso)) });
    if (bar) {
      bar.dataset.until = iso;
      bar.dataset.total = total;
    }
    return el;
  }

  let toastTimer = 0;
  function toast(text, { tone = '', undo = null } = {}) {
    document.querySelector('.toast')?.remove();
    clearTimeout(toastTimer);
    const t = h('div', { class: 'toast' + (tone ? ' ' + tone : ''), role: 'status' },
      icon(tone === 'danger' ? 'warning' : 'info', 16),
      h('span', { class: 'toast-text', text }),
      undo ? h('button', { class: 'toast-undo', type: 'button', text: 'Undo', onclick: () => { close(); undo(); } }) : null,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Dismiss', onclick: () => close() }, icon('close', 14)));
    const close = () => {
      clearTimeout(toastTimer);
      t.classList.add('closing');
      setTimeout(() => t.remove(), 130);
    };
    document.body.append(t);
    toastTimer = setTimeout(close, 5000);
  }

  // ---------- frame: title bar, activity bar, sidebar, tab, status bar ----------
  function go(section) {
    ui.section = section;
    ui.unpairAsk = false;
    savePref('section', section);
    render(true);
    $('editor').scrollTop = 0;
  }

  function renderFrame(s) {
    document.body.classList.toggle('mac-window', !!s.desktop && mac);
    $('tb-right').textContent = s.desktop ? 'this laptop only' : `${location.host} · this laptop only`;

    const ts = tsInfo(s);
    const ph = phoneInfo(s);
    const badge = {
      status: ts.tone === 'danger' ? 'danger' : '',
      phone: ph.tone === 'warning' || ph.tone === 'danger' ? ph.tone : '',
      folders: s.fullDiskAccess === false ? 'warning' : '',
    };
    $('activity').replaceChildren(
      ...ORDER.slice(0, 4).map((id, i) => actButton(id, `${SECTIONS[id].label} (${combo('alt')}${i + 1})`, badge[id])),
      h('span', { class: 'fill' }),
      actButton('settings', `Settings (${combo('alt')}5)`));

    const sec = SECTIONS[ui.section];
    $('tab').replaceChildren(icon(sec.icon, 16), h('span', { text: sec.label }));
    $('crumbs').replaceChildren(h('span', { text: 'Remote Desk' }), icon('chevron-right', 12), h('span', { class: 'cur', text: sec.label }));
    $('sidebar').replaceChildren(...sidebar(s));
    renderStatus(s);
    const panel = ui.section !== 'activity' && ui.section !== 'settings';
    $('panel').hidden = !panel;
    if (panel) {
      const tail = entries(s).slice(-7);
      $('panel-log').replaceChildren(...(tail.length ? logRows(tail) : [h('div', { class: 'log-empty', text: 'nothing yet · the phone’s activity shows up here' })]));
    }
  }

  function actButton(id, title, badge) {
    return h('button', {
      class: 'act' + (ui.section === id ? ' on' : ''), type: 'button', title, 'aria-label': title,
      'aria-current': ui.section === id ? 'page' : null, onclick: () => go(id),
    }, icon(SECTIONS[id].icon, 24), badge ? h('span', { class: 'act-badge ' + badge }) : null);
  }

  const entries = (s) => (s.activity || []).slice().reverse().map(logEntry);

  function renderStatus(s) {
    const ts = tsInfo(s);
    const ph = phoneInfo(s);
    const cur = themes.saved();
    const theme = cur === 'system' ? 'System · ' + themes.resolve('system').name : themes.resolve(cur).name;
    $('status').replaceChildren(
      h('button', { class: 'sb', type: 'button', title: 'Tailscale', onclick: () => go('status') },
        h('span', { class: 'dot' + (down ? ' danger' : ts.tone === 'ok' ? '' : ' ' + ts.tone) }),
        h('span', { class: 'mono', text: down ? 'Remote Desk not responding' : ts.short })),
      h('button', { class: 'sb', type: 'button', title: 'Your phone', onclick: () => go('phone') },
        icon('phone', 14), h('span', { text: ph.bar }), ph.tone === 'warning' || ph.tone === 'danger' ? h('span', { class: 'dot sm ' + ph.tone }) : null),
      h('button', { class: 'sb wide', type: 'button', title: 'Keep this laptop awake', onclick: toggleAwake }, icon('eye', 14), h('span', { text: awakeInfo(s).short })),
      h('span', { class: 'fill' }),
      h('button', { class: 'sb wide', type: 'button', title: 'Color theme', onclick: () => openPalette('theme') }, icon('theme', 14), h('span', { text: theme })),
      h('button', { class: 'sb', type: 'button', title: 'Commands', onclick: () => openPalette('cmd') }, h('span', { class: 'kb', text: combo('mod', 'K') }), h('span', { text: 'Commands' })),
      s.canQuit ? h('button', { class: 'sb quit', type: 'button', onclick: askQuit }, icon('power', 14), h('span', { text: 'Quit' })) : null);
  }

  function sidebar(s) {
    const title = h('div', { class: 'side-title' }, h('span', { text: SECTIONS[ui.section].label }),
      ui.section === 'folders' ? h('button', { class: 'icon-btn', type: 'button', title: `Add folder (${combo('mod', 'O')})`, 'aria-label': 'Add folder', onclick: startAdd }, icon('plus', 16)) : null);
    const group = (text) => h('div', { class: 'side-group' }, icon('chevron-down', 14), h('span', { text }));
    const meta = (text, tone) => h('span', { class: 'side-meta' + (tone ? ' tone-' + tone : ''), text });
    const out = [title];
    switch (ui.section) {
      case 'status': {
        out.push(...overview(s).map((o) => h('button', { class: 'side-row', type: 'button', onclick: () => go(o.to) },
          icon(o.icon, 16), h('span', { class: 'label', text: o.label }), meta(o.meta, o.tone))));
        break;
      }
      case 'phone': {
        const d = s.auth.device;
        const ph = phoneInfo(s);
        out.push(group('Paired device'));
        if (d) out.push(h('div', { class: 'side-row in on' }, icon('phone', 16), h('span', { class: 'label', text: d.label }), meta(ph.meta, ph.tone)));
        else {
          out.push(h('div', { class: 'side-row in' }, h('span', { class: 'label muted', text: 'None · one phone allowed' })));
          out.push(group('Pairing'));
          for (const r of pending(s)) {
            out.push(h('div', { class: 'side-row in on' }, h('span', { class: 'side-dot' }, dot('warning', 'pulse')), h('span', { class: 'label', text: r.label }), meta('request', 'warning')));
          }
          const p = s.auth.pairing;
          out.push(h('div', { class: 'side-row in' }, icon('qr', 16), h('span', { class: 'label', text: 'One-time code' }),
            p && p.code ? h('span', { class: 'side-meta' }, countdown(p.expires, 300)) : meta(pending(s).length ? 'used' : 'none')));
        }
        break;
      }
      case 'folders': {
        for (const f of s.roots || []) {
          out.push(h('div', { class: 'side-row tree hover' }, icon('chevron-right', 14), icon('folder', 16, 'k-folder'),
            h('span', { class: 'label', text: f.name }),
            !f.available ? meta('missing', 'warning') : f.protected ? meta('PIN') : null));
        }
        if (!(s.roots || []).length) out.push(h('div', { class: 'side-row' }, h('span', { class: 'label muted', text: 'Nothing shared' })));
        break;
      }
      case 'activity': {
        const all = entries(s);
        out.push(group('Show'));
        for (const [id, label] of FILTERS) {
          out.push(h('button', { class: 'side-row in' + (ui.filter === id ? ' on' : ''), type: 'button', onclick: () => { ui.filter = id; render(true); } },
            h('span', { class: 'label', text: label }), meta(String(all.filter((e) => inFilter(id, e)).length))));
        }
        out.push(group('Phone'));
        const d = s.auth.device;
        out.push(h('div', { class: 'side-row in' }, icon('phone', 16), h('span', { class: 'label', text: d ? d.label : 'No phone' }),
          d ? h('span', { class: 'side-meta', 'data-since': d.lastSeen || '', text: d.lastSeen ? ago(d.lastSeen) : 'not used yet' }) : null));
        break;
      }
      case 'settings': {
        out.push(h('button', { class: 'side-row on', type: 'button', onclick: () => scrollToId('set-appearance') }, h('span', { class: 'label', text: 'Appearance' })));
        out.push(h('button', { class: 'side-row', type: 'button', onclick: () => scrollToId('set-reachable') }, h('span', { class: 'label', text: 'Stay reachable' })));
        break;
      }
    }
    return out;
  }

  function scrollToId(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }

  function overview(s) {
    const ts = tsInfo(s);
    const ph = phoneInfo(s);
    const aw = awakeInfo(s);
    const roots = s.roots || [];
    const todayCount = (s.activity || []).filter((a) => today(new Date(a.time))).length;
    return [
      { label: 'Tailscale', icon: 'broadcast', meta: ts.meta, tone: ts.tone === 'muted' ? '' : ts.tone, to: 'status' },
      { label: 'Your phone', icon: 'phone', meta: ph.meta, tone: ph.tone === 'muted' ? '' : ph.tone, long: ph.long, to: 'phone' },
      { label: 'Shared folders', icon: 'folder', meta: String(roots.length), long: `${roots.length} ${roots.length === 1 ? 'folder' : 'folders'}`, to: 'folders' },
      s.fullDiskAccess == null ? null : s.fullDiskAccess
        ? { label: 'Full Disk Access', icon: 'key', meta: 'on', long: 'On', to: 'folders' }
        : { label: 'Full Disk Access', icon: 'key', meta: 'off', tone: 'warning', long: 'Off · Desktop, Documents and Downloads are blocked', to: 'folders' },
      { label: 'Keep awake', icon: 'eye', meta: aw.meta, long: aw.long, to: 'settings' },
      { label: 'Activity', icon: 'pulse', meta: String(todayCount), long: `${todayCount} ${todayCount === 1 ? 'event' : 'events'} today`, to: 'activity' },
    ].filter(Boolean);
  }

  // ---------- editor: one view per section ----------
  let shown = '';
  function renderEditor(s, force) {
    const box = $('editor');
    // Polls don't redraw under someone who is typing.
    const typing = box.contains(document.activeElement) && document.activeElement.matches('input[type="text"]');
    if (typing && !force && shown === ui.section) return;
    const fresh = shown !== ui.section;
    shown = ui.section;
    let view;
    switch (ui.section) {
      case 'status': view = statusView(s); break;
      case 'phone': view = phoneView(s); break;
      case 'folders': view = foldersView(s); break;
      case 'activity': view = activityView(s); break;
      default: view = settingsView(s);
    }
    if (!fresh) view.classList.add('still'); // fade in on a section change only
    box.replaceChildren(view);
  }

  function statusView(s) {
    const t = s.tailscale;
    const page = h('div', { class: 'page' }, h('h1', { class: 'h1', text: 'Tailscale' }));
    const state = (tone, label, meta) => h('div', { class: 'state' }, dot(tone), h('b', { text: label }), meta ? h('span', { class: 'meta' }, meta) : null);
    const checked = h('span', { 'data-checked': '1', text: 'checked just now' });
    if (s.dev) {
      page.append(
        state('warning', 'Dev mode', 'no Tailscale'),
        h('p', { class: 'para', text: 'No Tailscale, a fake phone identity and separate test data. Open the phone site in a desktop browser:' }),
        h('div', { class: 'actions' }, link('Open phone site', s.siteURL, 'primary'), btn('Copy address', () => copy(s.siteURL), '', 'copy')),
        h('p', { class: 'footnote', text: s.siteURL }));
    } else if (t.state === 'NeedsLogin' || t.state === 'NoState') {
      page.append(
        state('danger', 'Not connected', checked),
        h('p', { class: 'para', text: 'Your phone reaches this laptop only through your tailnet. Sign in to Tailscale on this laptop with the same account as your iPhone, then open Remote Desk on your phone.' }),
        h('div', { class: 'actions' },
          t.authURL ? link('Sign in to Tailscale', t.authURL, 'primary') : h('button', { class: 'btn primary', type: 'button', disabled: true, text: 'Getting a sign-in link…' }),
          btn('Check again', () => refresh(true), '', 'refresh')),
        h('p', { class: 'footnote', text: 'opens login.tailscale.com in your browser · no account yet? it can make one for free' }));
    } else if (t.state === 'NeedsMachineAuth') {
      page.append(
        state('warning', 'Waiting for approval', checked),
        h('p', { class: 'para', text: 'Approve this laptop in the Tailscale admin console, under Machines.' }),
        h('div', { class: 'actions' }, link('Open Machines', 'https://login.tailscale.com/admin/machines', 'primary'), btn('Check again', () => refresh(true), '', 'refresh')));
    } else if (t.state !== 'Running') {
      page.append(state('warning', 'Starting Tailscale…', t.state), t.error ? h('p', { class: 'footnote', text: t.error }) : null);
    } else if (!t.magicDNS || !t.https) {
      page.append(
        state('warning', 'One setting left', 'so the phone gets an HTTPS address'),
        h('ol', { class: 'steps-list' },
          h('li', null, h('span', { class: 'n', text: '1' }), h('span', { text: 'Open the DNS page of the Tailscale admin console.' })),
          !t.magicDNS ? h('li', null, h('span', { class: 'n', text: '2' }), h('span', null, 'Turn on ', h('b', { text: 'MagicDNS' }), '.')) : null,
          h('li', null, h('span', { class: 'n', text: t.magicDNS ? '2' : '3' }), h('span', null, 'Under HTTPS Certificates, click ', h('b', { text: 'Enable HTTPS' }), '.'))),
        h('div', { class: 'actions' }, link('Open Tailscale DNS settings', 'https://login.tailscale.com/admin/dns', 'primary')),
        h('p', { class: 'footnote', text: `this page updates by itself · HTTPS puts this laptop's Tailscale name (${t.dnsName || 'rd-…'}) in public certificate logs; it's a random name on purpose` }));
    } else if (!t.serving) {
      page.append(state('warning', 'Getting the HTTPS certificate…', checked), t.error ? h('p', { class: 'footnote', text: t.error }) : null);
    } else {
      page.append(
        state('ok', 'Connected', 'your phone can reach this laptop'),
        h('div', { class: 'table' },
          h('div', { class: 'trow' }, h('span', { class: 'key', text: 'Hostname' }), h('span', { class: 'val mono', text: t.dnsName }), copyBtn(t.dnsName, 'Copy hostname')),
          h('div', { class: 'trow' }, h('span', { class: 'key', text: 'Phone address' }), h('span', { class: 'val mono', text: s.siteURL }), copyBtn(s.siteURL, 'Copy address')),
          h('div', { class: 'trow plain' }, h('span', { class: 'key', text: 'Account' }), h('span', { class: 'val mono', text: t.user || '—' })),
          h('div', { class: 'trow plain' }, h('span', { class: 'key', text: 'HTTPS certificate' }), h('span', { class: 'val mono', text: 'issued by Tailscale · served' }))),
        h('p', { class: 'footnote', text: `tip: in Tailscale › Machines, choose Disable key expiry for ${t.dnsName.split('.')[0]}, or it signs out after 180 days` }));
    }
    page.append(
      h('div', { class: 'sec-label', text: 'This laptop' }),
      h('div', { class: 'table' },
        ...overview(s).slice(1).map((o) => h('button', { class: 'trow link', type: 'button', onclick: () => go(o.to) },
          h('span', { class: 'key', text: o.label }), h('span', { class: 'val', text: o.long }), icon('chevron-right', 14))),
        h('div', { class: 'trow plain' }, h('span', { class: 'key', text: 'This page' }),
          h('span', { class: 'val mono', text: (s.desktop ? 'desktop window' : location.host) + ' · not reachable from the phone' }))));
    return page;
  }

  function phoneView(s) {
    const d = s.auth.device;
    const page = h('div', { class: 'page w780' });
    if (d) {
      const locked = d.locked;
      const online = recent(d.lastSeen);
      const stateLine = locked
        ? [dot('danger', 'sm'), `locked · ${d.failures || 5} wrong PINs`]
        : online
          ? [dot('ok', 'sm'), 'online · last request ', h('span', { 'data-since': d.lastSeen, text: ago(d.lastSeen) })]
          : [dot('muted', 'sm'), d.lastSeen ? ['last seen ', h('span', { 'data-since': d.lastSeen, text: ago(d.lastSeen) })] : 'paired · not used yet'];
      const actions = ui.unpairAsk
        ? h('div', { class: 'card-actions confirm' },
          h('span', { text: `Unpair ${d.label}? It’s signed out and its key is deleted here.` }),
          btn('Cancel', () => { ui.unpairAsk = false; render(true); }),
          btn('Unpair', () => { ui.unpairAsk = false; act(() => api('POST', '/api/unpair'), `Unpaired ${d.label} · its key was deleted`); }, 'fill-danger'))
        : h('div', { class: 'card-actions' },
          locked ? btn('Unlock', () => act(() => api('POST', '/api/unlock'), `${d.label} can try its PIN again`), 'primary', 'key') : null,
          btn('Unpair', () => { ui.unpairAsk = true; render(true); }, 'text-danger', 'unlink'));
      page.append(
        h('h1', { class: 'h1', text: 'Your phone' }),
        h('p', { class: 'sub', text: 'One phone can be paired. Unpairing happens only here.' }),
        h('div', { class: 'card' + (locked ? ' locked' : '') },
          h('div', { class: 'device-head' },
            h('span', { class: 'device-tile' }, icon('phone', 22)),
            h('div', null, h('p', { class: 'device-name', text: d.label }), h('p', { class: 'device-state' }, stateLine))),
          kv('Paired', stamp(d.pairedAt)),
          kv('Tailscale device', [d.nodeName, d.os].filter(Boolean).join(' · ')),
          kv('Wrong PINs', locked ? `${d.failures || 5} · locked until you unlock it` : String(d.failures || 0)),
          actions),
        h('p', { class: 'footnote', text: 'lost the phone? unpair it here, and remove it from your Tailscale account too' }));
      return page;
    }

    page.append(h('h1', { class: 'h1', text: 'Pair your phone' }));
    if (!ready(s)) {
      page.append(h('p', { class: 'sub', text: 'Finish the Tailscale setup first, so your phone has an address to open.' }),
        h('div', { class: 'actions' }, btn('Show status', () => go('status'), 'primary', 'broadcast')));
      return page;
    }
    const reqs = pending(s);
    if (reqs.length) {
      page.append(h('p', { class: 'sub', text: 'A phone entered your code. Approve it only if it’s in your hand.' }));
      for (const r of reqs) {
        const expires = new Date(new Date(r.created).getTime() + 5 * 60 * 1000).toISOString();
        page.append(h('div', { class: 'card req' },
          h('div', { class: 'card-head' }, dot('warning', 'pulse'), h('b', { text: `${r.label} wants to pair` }), h('span', { class: 'fill' }),
            h('span', { class: 'meta' }, 'expires in ', countdown(expires, 300))),
          kv('Device', [r.nodeName, r.os].filter(Boolean).join(' · ')),
          kv('Account', r.user ? `${r.user} · on your tailnet` : 'on your tailnet'),
          kv('Requested', `${hm(new Date(r.created))}:${two(new Date(r.created).getSeconds())}`),
          h('div', { class: 'card-actions' },
            btn('Approve', () => approve(r), 'primary', null, combo('mod', 'enter')),
            btn('Deny', () => deny(r), '', null, combo('mod', 'bksp')))));
      }
      page.append(h('p', { class: 'footnote', text: 'the code is used up · after Deny, make a new code to try again' }));
      return page;
    }
    const p = s.auth.pairing;
    const right = h('div');
    if (p && p.code) {
      const bar = h('div', { class: 'bar accent code-bar' }, h('span'));
      right.append(
        h('div', { class: 'code-label', text: 'One-time code' }),
        h('div', { class: 'code-big', text: p.code }),
        h('div', { class: 'expiry' }, icon('clock', 14), 'expires in ', countdown(p.expires, 300, bar)),
        bar,
        h('div', { class: 'actions' }, btn('New code', newCode, '', 'refresh'), btn('Copy code', () => copy(p.code), '', 'copy')));
    } else {
      right.append(
        h('div', { class: 'code-label', text: 'One-time code' }),
        h('p', { class: 'para', text: 'Show a code when your phone is ready. It works once, for 5 minutes.' }),
        h('div', { class: 'actions' }, btn('Show pairing code', newCode, 'primary', 'key')));
    }
    right.append(h('ol', { class: 'steps-list' },
      h('li', null, h('span', { class: 'n', text: '1' }), h('span', null,
        s.dev ? 'Open ' : 'On your iPhone, turn on Tailscale (same account), then open ',
        h('code', { text: s.siteURL.replace(/^https?:\/\//, '') }), s.dev ? ' in a browser.' : ' in Safari, or scan the code.')),
      h('li', null, h('span', { class: 'n', text: '2' }), h('span', { text: s.dev ? 'Skip Add to Home Screen in dev mode.' : 'Add it to the Home Screen and open it from there.' })),
      h('li', null, h('span', { class: 'n', text: '3' }), h('span', { text: 'Enter the code, choose a PIN, then approve the request here.' }))));
    page.append(
      h('p', { class: 'sub', text: 'One phone at a time. Each code works once.' }),
      h('div', { class: 'pair-grid' },
        h('div', null,
          s.siteQR ? h('div', { class: 'qr' }, h('img', { src: s.siteQR, width: '162', height: '162', alt: 'QR code for ' + s.siteURL })) : null,
          h('p', { class: 'qr-note', text: 'encodes the phone address only' })),
        right));
    return page;
  }

  function foldersView(s) {
    const roots = s.roots || [];
    const rows = roots.map((f, i) => {
      const forced = f.protected && !f.asked; // iCloud Drive always asks
      const access = forced
        ? h('span', { class: 'faccess on', title: 'iCloud Drive always asks for the PIN', text: 'PIN · iCloud' })
        : h('button', {
          class: 'faccess' + (f.asked ? ' on' : ''), type: 'button',
          title: f.asked ? 'The phone asks for the PIN each time it opens this. Click to stop asking.' : 'Click to ask for the PIN each time the phone opens this',
          text: f.asked ? 'PIN every time' : 'open',
          onclick: () => act(() => api('POST', '/api/roots', { roots: saved(roots.map((g, j) => (j === i ? { ...g, asked: !g.asked } : g))) })),
        });
      return h('div', { class: 'frow' },
        h('span', { class: 'fname' }, icon('folder', 16), h('span', { text: f.name })),
        h('span', { class: 'fpath', title: f.path, text: f.available ? tilde(f.path) : `${tilde(f.path)} · not found` }),
        access,
        h('button', { class: 'fremove', type: 'button', onclick: () => removeFolder(roots, i) }, icon('remove', 14), 'Remove'));
    });
    const table = h('div', { class: 'table ftable' },
      h('div', { class: 'fhead' }, h('span', { text: 'Name' }), h('span', { text: 'Path' }), h('span', { text: 'Access' }), h('span')),
      ui.adding ? addRow(roots) : null,
      rows.length ? rows : (ui.adding ? null : h('div', { class: 'fempty', text: 'No folders shared. Your phone sees nothing until you add one.' })));
    return h('div', { class: 'page w860' },
      h('div', { class: 'page-head' },
        h('div', null, h('h1', { class: 'h1', text: 'Shared folders' }), h('p', { class: 'sub', text: 'Your phone can browse and download from these. It can’t change anything.' })),
        btn('Add folder', startAdd, 'primary', 'plus', combo('mod', 'O'))),
      s.fullDiskAccess === false ? h('div', { class: 'notice' }, icon('warning', 16),
        h('div', null,
          h('p', { class: 'notice-title', text: 'macOS is blocking your Desktop, Documents and Downloads' }),
          h('p', { class: 'para', text: 'The phone gets an error in those folders. In System Settings › Privacy & Security › Full Disk Access, add Remote Desk (in ~/Applications) and switch it on, then quit and reopen Remote Desk.' }),
          h('div', { class: 'actions' }, link('Open Full Disk Access settings', FDA_SETTINGS, 'primary')))) : null,
      table,
      s.fullDiskAccess === true ? h('p', { class: 'footnote', text: 'full disk access is on · macOS lets Remote Desk read Desktop, Documents and Downloads' }) : null,
      h('p', { class: 'footnote', text: 'removing stops sharing · files on this laptop are not touched' }),
      h('p', { class: 'footnote', text: 'always hidden: dotfiles (.ssh, .env), Library / AppData, keychains, browser profiles, password-manager data and Remote Desk’s own data' }),
      h('p', { class: 'footnote', text: 'iCloud Drive is shared only if you add it (~/Library/Mobile Documents/com~apple~CloudDocs), and then the phone asks for the PIN every time' }));
  }

  const FDA_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';

  // What the server saves for each folder: name, path and the owner's
  // "ask for the PIN" choice (iCloud Drive asks whatever this says).
  const saved = (list) => list.map(({ name, path, asked }) => ({ name, path, protected: !!asked }));

  function startAdd() {
    if (ui.section !== 'folders') go('folders');
    ui.adding = true;
    render(true);
    setTimeout(() => $('f-path')?.focus(), 0);
  }

  function addRow(roots) {
    const path = h('input', { class: 'input mono', id: 'f-path', type: 'text', placeholder: mac ? '/Users/you/Projects' : 'C:\\Users\\you\\Projects', autocomplete: 'off', spellcheck: 'false', 'aria-label': 'Folder path' });
    const name = h('input', { class: 'input', type: 'text', placeholder: 'Name on the phone', autocomplete: 'off', 'aria-label': 'Name on the phone' });
    const pin = h('input', { class: 'cb', type: 'checkbox', 'aria-label': 'Ask for the PIN every time' });
    const err = h('p', { class: 'fadd-error', role: 'alert' });
    const cancel = () => { ui.adding = false; render(true); };
    const add = async () => {
      err.textContent = '';
      if (!path.value.trim()) {
        err.textContent = 'type the full path of a folder on this computer';
        return path.focus();
      }
      try {
        await api('POST', '/api/roots', { roots: [...saved(roots), { name: name.value.trim(), path: path.value.trim(), protected: pin.checked }] });
      } catch (e) {
        err.textContent = e.message;
        return path.focus();
      }
      ui.adding = false;
      document.activeElement?.blur();
      toast('Sharing ' + tilde(path.value.trim()));
      refresh(true);
    };
    const keys = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); add(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel(); }
    };
    path.addEventListener('keydown', keys);
    name.addEventListener('keydown', keys);
    return h('div', { class: 'fadd' }, path, name,
      h('label', { class: 'check' }, pin, h('span', { class: 'muted', text: 'Ask for PIN' })),
      btn('Add', add, 'primary'), btn('Cancel', cancel), err);
  }

  function removeFolder(roots, i) {
    const f = roots[i];
    const rest = roots.filter((_, j) => j !== i);
    act(() => api('POST', '/api/roots', { roots: saved(rest) })).then(() => {
      toast('Stopped sharing ' + tilde(f.path), {
        undo: () => {
          const back = [...rest.slice(0, i), f, ...rest.slice(i)];
          act(() => api('POST', '/api/roots', { roots: saved(back) }), 'Sharing ' + tilde(f.path) + ' again');
        },
      });
    });
  }

  function activityView(s) {
    const list = entries(s).filter((e) => inFilter(ui.filter, e));
    const log = h('div', { class: 'log' },
      list.length ? logRows(list) : h('div', { class: 'log-empty', text: 'nothing yet' }),
      h('div', { class: 'log-row end' }, h('span'), h('span', null, h('span', { class: 'cursor' }))));
    requestAnimationFrame(() => { $('editor').scrollTop = $('editor').scrollHeight; });
    return log;
  }

  function settingsView(s) {
    const q = ui.settingsQ.trim().toLowerCase();
    const match = (...texts) => !q || texts.join(' ').toLowerCase().includes(q);
    const search = h('input', { type: 'text', placeholder: 'Search settings', 'aria-label': 'Search settings', value: ui.settingsQ });
    search.addEventListener('input', () => {
      ui.settingsQ = search.value;
      const pos = search.selectionStart;
      $('editor').replaceChildren(settingsView(S));
      const again = $('editor').querySelector('.set-search input');
      again.focus();
      again.setSelectionRange(pos, pos);
    });
    const cur = themes.saved();
    const cards = themes.list.map((t) => {
      const on = cur === t.id;
      const [editor, sidebar, activity, status, border, fg, accent] = t.sw;
      const lines = [h('span'), h('span'), h('span')];
      const me = h('span', { class: 'me' }, lines);
      lines[0].style.background = accent;
      lines[1].style.background = fg;
      lines[2].style.background = fg;
      const part = (cls, bg) => {
        const el = h('span', { class: cls });
        el.style.background = bg;
        return el;
      };
      const ms = part('ms', sidebar);
      ms.style.borderRight = `1px solid ${border}`;
      const mst = part('mst', status);
      mst.style.borderTop = `1px solid ${border}`;
      const mini = h('span', { class: 'mini' }, part('ma', activity), ms, me, mst);
      mini.style.background = editor;
      return h('button', { class: 'tcard' + (on ? ' on' : ''), type: 'button', 'aria-pressed': String(on), onclick: () => { themes.set(t.id); render(true); } },
        mini, h('span', { class: 'tcard-name' }, h('span', { text: t.name }), on ? icon('check', 14) : null));
    });
    const items = [];
    if (match('appearance color colour theme dark light')) {
      items.push(h('div', { class: 'set-item' },
        h('div', null, h('span', { class: 'cat', text: 'Appearance: ' }), h('span', { class: 'name', text: 'Color Theme' })),
        h('p', { class: 'set-desc' }, 'Themes come from the code editor you know. ', h('span', { class: 'cur', text: 'Dark Modern' }), ' is the default. Preview any theme from the palette with ',
          h('span', { class: 'kbd', text: `${combo('mod', 'K')} ${combo('mod', 'T')}` }), '.'),
        h('div', { class: 'theme-grid' }, cards)));
    }
    if (match('appearance follow system dark light')) {
      const cb = h('input', { class: 'cb', type: 'checkbox', checked: cur === 'system' });
      cb.addEventListener('change', () => { themes.set(cb.checked ? 'system' : 'dark-modern'); render(true); });
      items.push(h('label', { class: 'set-item' },
        h('div', null, h('span', { class: 'cat', text: 'Appearance: ' }), h('span', { class: 'name', text: 'Follow System' })),
        h('div', { class: 'set-row' }, cb, h('span', { text: 'Switch between Dark Modern and Light Modern with the system appearance.' }))));
    }
    const appearance = items.length ? [h('h2', { class: 'set-h', id: 'set-appearance', text: 'Appearance' }), items] : [];
    const awake = [];
    if (match('stay reachable keep awake sleep plugged power')) {
      const aw = awakeInfo(s);
      const usable = s.keepAwake.supported && !s.dev;
      const cb = h('input', { class: 'cb', type: 'checkbox', checked: s.keepAwake.enabled, disabled: !usable });
      cb.addEventListener('change', () => act(() => api('POST', '/api/keepawake', { enabled: cb.checked })));
      awake.push(h('h2', { class: 'set-h', id: 'set-reachable', text: 'Stay reachable' }),
        h('label', { class: 'set-item' },
          h('div', null, h('span', { class: 'cat', text: 'Stay Reachable: ' }), h('span', { class: 'name', text: 'Keep Awake' })),
          h('div', { class: 'set-row' }, cb, h('span', { text: 'Keep this laptop awake while it’s plugged in, so your phone can reach it. The display can still sleep.' })),
          h('div', { class: 'set-line' }, icon('plug', 14), usable ? (s.keepAwake.enabled ? 'on · while plugged in' : 'off · this laptop sleeps as usual') : aw.long.toLowerCase())),
        h('p', { class: 'footnote', text: 'a MacBook still sleeps when you close the lid · on Windows, set “When I close the lid” to “Do nothing” for when it’s plugged in' }));
    }
    return h('div', { class: 'settings' },
      h('div', { class: 'set-search' }, icon('search', 14), search),
      appearance, awake,
      !appearance.length && !awake.length ? h('p', { class: 'set-none', text: 'No settings match.' }) : null);
  }

  // ---------- actions ----------
  const newCode = () => act(() => api('POST', '/api/pair/start'));
  const approve = (r) => act(() => api('POST', '/api/pair/approve', { id: r.id }), `Paired with ${r.label}`);
  const deny = (r) => act(() => api('POST', '/api/pair/deny', { id: r.id }), 'Request denied · make a new code to try again');

  function toggleAwake() {
    if (!S || !S.keepAwake.supported || S.dev) return toast('Keep awake isn’t available here.', { tone: 'danger' });
    const on = !S.keepAwake.enabled;
    act(() => api('POST', '/api/keepawake', { enabled: on }), on ? 'Keep awake is on while plugged in' : 'Keep awake is off · normal sleep rules apply');
  }

  // ---------- command palette + theme picker ----------
  function commands(s) {
    const reqs = pending(s);
    const d = s.auth.device;
    return [
      { label: 'Pairing: Approve request', keys: keycaps('mod', 'enter'), when: reqs.length, run: () => approve(reqs[0]) },
      { label: 'Pairing: Deny request', keys: keycaps('mod', 'bksp'), when: reqs.length, run: () => deny(reqs[0]) },
      { label: 'Pairing: New pairing code', when: !d && ready(s), run: () => { go('phone'); newCode(); } },
      { label: `Phone: Unlock ${d ? d.label : ''}`, when: d && d.locked, run: () => act(() => api('POST', '/api/unlock'), `${d.label} can try its PIN again`) },
      { label: `Phone: Unpair ${d ? d.label : ''}`, when: d, run: () => { go('phone'); ui.unpairAsk = true; render(true); } },
      { label: 'Folders: Add folder…', keys: keycaps('mod', 'O'), run: startAdd },
      { label: 'Folders: Remove folder…', when: (s.roots || []).length, run: () => go('folders') },
      { label: 'Stay Reachable: Toggle keep awake', keys: keycaps('alt', 'mod', 'A'), when: s.keepAwake.supported && !s.dev, run: toggleAwake },
      { label: 'View: Show status', keys: keycaps('alt', '1'), run: () => go('status') },
      { label: 'View: Show your phone', keys: keycaps('alt', '2'), run: () => go('phone') },
      { label: 'View: Show shared folders', keys: keycaps('alt', '3'), run: () => go('folders') },
      { label: 'View: Open activity', keys: keycaps('mod', 'J'), run: () => go('activity') },
      { label: 'View: Open settings', keys: keycaps('alt', '5'), run: () => go('settings') },
      { label: 'Preferences: Color theme', keys: [combo('mod', 'K'), combo('mod', 'T')], run: () => openPalette('theme') },
      { label: 'Tailscale: Copy phone address', when: s.siteURL, run: () => copy(s.siteURL) },
      { label: 'Remote Desk: Quit', keys: keycaps('mod', 'Q'), when: s.canQuit, run: askQuit },
    ].filter((c) => c.when === undefined || c.when);
  }

  // match finds q in label as a substring, else as a subsequence; null if
  // it isn't there. marks are the matched character positions.
  function match(label, q) {
    q = q.trim().toLowerCase();
    if (!q) return { marks: [], score: 0 };
    const l = label.toLowerCase();
    const at = l.indexOf(q);
    if (at >= 0) return { marks: [...q].map((_, i) => at + i), score: at };
    const marks = [];
    for (let x = 0, j = 0; x < l.length && j < q.length; x++) if (l[x] === q[j]) { marks.push(x); j++; }
    if (marks.length < q.length) return null;
    return { marks, score: 100 + marks[marks.length - 1] - marks[0] };
  }
  function runs(label, marks) {
    const set = new Set(marks);
    const out = [];
    let start = 0;
    for (let i = 1; i <= label.length; i++) {
      if (i < label.length && set.has(i) === set.has(start)) continue;
      const t = label.slice(start, i);
      out.push(set.has(start) ? h('mark', { text: t }) : t);
      start = i;
    }
    return out;
  }

  function openPalette(mode) {
    closeOverlay(true);
    if (!S) return;
    const theme = mode === 'theme';
    const before = themes.saved();
    let sel = 0;
    let items = [];
    const input = h('input', { class: 'pal-input', type: 'text', 'aria-label': theme ? 'Color theme' : 'Command', autocomplete: 'off', spellcheck: 'false',
      placeholder: theme ? 'Select color theme (↑↓ to preview)' : 'Type a command' });
    const list = h('div', { class: 'pal-list', role: 'listbox' });
    const shield = h('div', { class: 'shield' });
    const box = h('div', { class: 'palette', role: 'dialog', 'aria-label': theme ? 'Color theme' : 'Command palette' },
      h('div', { class: 'pal-input-row' }, theme ? null : h('span', { class: 'pal-prefix', text: '>' }), input), list);

    const build = () => {
      const q = input.value;
      if (theme) {
        const groups = [['dark', 'dark themes'], ['light', 'light themes'], ['hc', 'high contrast themes']];
        items = [];
        for (const [g, label] of groups) {
          let first = true;
          for (const t of themes.list) {
            const hc = t.id.startsWith('hc-');
            if (g === 'hc' ? !hc : hc || t.type !== g) continue;
            const m = match(t.name, q);
            if (!m) continue;
            items.push({ label: t.name, marks: m.marks, tag: first ? label : t.base ? 'default' : '', group: first && items.length > 0, theme: t, run: () => themes.set(t.id) });
            first = false;
          }
        }
      } else {
        items = commands(S).map((c) => ({ ...c, m: match(c.label, q) })).filter((c) => c.m)
          .sort((a, b) => a.m.score - b.m.score).map((c) => ({ ...c, marks: c.m.marks }));
      }
      sel = Math.min(sel, Math.max(0, items.length - 1));
      draw();
    };
    const draw = () => {
      list.replaceChildren(...(items.length ? items.map((it, i) => {
        let sw = null;
        if (it.theme) {
          const [editor, , , , border, , accent] = it.theme.sw;
          sw = h('span', { class: 'pal-sw' });
          sw.style.background = editor;
          sw.style.boxShadow = `inset 0 0 0 1px ${border}, inset -5px 0 0 ${accent}`;
        }
        const row = h('div', { class: 'pal-row' + (i === sel ? ' sel' : '') + (it.group ? ' group' : ''), role: 'option', 'aria-selected': String(i === sel) },
          sw, h('span', { class: 'pal-label' }, runs(it.label, it.marks)),
          it.tag ? h('span', { class: 'pal-tag', text: it.tag }) : null,
          it.keys ? h('span', { class: 'keys' }, it.keys.map((k) => h('span', { class: 'keycap', text: k }))) : null);
        row.addEventListener('mouseenter', () => { if (sel !== i) { sel = i; draw(); } });
        row.addEventListener('mousedown', (e) => e.preventDefault());
        row.addEventListener('click', () => choose(i));
        return row;
      }) : [h('div', { class: 'pal-none', text: theme ? 'No matching themes' : 'No matching commands' })]));
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const choose = (i) => {
      const it = items[i];
      if (!it) return;
      close(true);
      it.run();
      if (theme) render(true);
    };
    const close = (keepTheme) => {
      if (theme && !keepTheme) themes.apply(before);
      ui.overlay = null;
      shield.remove();
      box.remove();
    };
    ui.overlay = { close };
    shield.addEventListener('click', () => close());
    input.addEventListener('input', () => { sel = 0; build(); });
    input.addEventListener('keydown', (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!items.length) return;
        sel = (sel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        if (theme) themes.apply(items[sel].theme.id);
        draw();
      } else if (e.key === 'Enter') { e.preventDefault(); choose(sel); }
      else if (!theme && mod && e.key.toLowerCase() === 't') { e.preventDefault(); openPalette('theme'); }
    });
    if (theme) {
      const at = themes.resolve(before).id;
      build();
      sel = Math.max(0, items.findIndex((it) => it.theme.id === at));
      draw();
    } else build();
    document.body.append(shield, box);
    input.focus();
  }

  function closeOverlay(instant) {
    if (ui.overlay) ui.overlay.close(instant);
  }

  // ---------- quit ----------
  function askQuit() {
    if (!S || !S.canQuit) return;
    closeOverlay(true);
    const d = S.auth.device;
    const scrim = h('div', { class: 'scrim' });
    const quit = btn('Quit', doQuit, 'fill-danger', null, '↵');
    const box = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'quit-title' },
      h('div', { class: 'dialog-body' }, icon('power', 22),
        h('div', null,
          h('p', { class: 'dialog-title', id: 'quit-title', text: 'Quit Remote Desk?' }),
          h('p', { class: 'dialog-text', text: (d
            ? `${d.label} loses access until you open Remote Desk again. Pairing, PIN and shared folders are kept.`
            : 'Your phone can’t reach this laptop until you open Remote Desk again. Shared folders are kept.')
            + (S.desktop ? ' Closing the window instead keeps it running.' : '') }))),
      h('div', { class: 'dialog-actions' }, btn('Cancel', () => close(), '', null, 'Esc'), quit));
    const close = () => {
      ui.overlay = null;
      document.removeEventListener('keydown', keys, true);
      scrim.remove();
      box.remove();
    };
    const keys = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
      if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); doQuit(); }
    };
    async function doQuit() {
      close();
      try {
        await api('POST', '/api/quit');
      } catch (e) {
        return toast(sentence(e.message), { tone: 'danger' });
      }
      stopped = true;
      document.body.append(h('div', { class: 'stopped' }, h('div', null,
        h('div', { class: 'state' }, dot('muted'), h('b', { text: 'Remote Desk has stopped' })),
        h('p', { class: 'para', text: 'Your phone can’t connect until you open Remote Desk again. You can close this window.' }))));
    }
    ui.overlay = { close };
    scrim.addEventListener('click', close);
    document.addEventListener('keydown', keys, true);
    document.body.append(scrim, box);
    quit.focus();
  }

  // ---------- keyboard ----------
  document.addEventListener('keydown', (e) => {
    if (stopped || !S) return;
    const mod = e.metaKey || e.ctrlKey;
    const k = (e.key || '').toLowerCase();
    if (ui.overlay) return; // the palette and dialog handle their own keys
    if (mod && (k === 'k' || k === 'p')) { e.preventDefault(); return openPalette('cmd'); }
    if (mod && k === 'q' && S.canQuit) { e.preventDefault(); return askQuit(); }
    if (mod && k === 'j') { e.preventDefault(); return go('activity'); }
    if (mod && k === 'o') { e.preventDefault(); return startAdd(); }
    if (mod && e.altKey && e.code === 'KeyA') { e.preventDefault(); return toggleAwake(); }
    const reqs = pending(S);
    if (mod && e.key === 'Enter' && reqs.length) { e.preventDefault(); return approve(reqs[0]); }
    if (mod && e.key === 'Backspace' && reqs.length && !e.target.matches('input')) { e.preventDefault(); return deny(reqs[0]); }
    if (e.altKey && !mod && /^Digit[1-5]$/.test(e.code)) { e.preventDefault(); return go(ORDER[Number(e.code.slice(5)) - 1]); }
    if (e.key === 'Escape') document.querySelector('.toast .icon-btn')?.click();
  });

  // ---------- refresh ----------
  function render(force) {
    if (!S) return;
    renderFrame(S);
    renderEditor(S, force);
    tick();
  }

  async function refresh(force) {
    if (stopped) return;
    try {
      const s = await api('GET', '/api/status');
      S = s;
      lastOK = Date.now();
      // The phone's last-request time changes all the time; redraw only
      // when it starts or stops counting as online, and update the
      // "Ns ago" texts in place.
      const d = s.auth.device;
      const key = JSON.stringify({ ...s, auth: { ...s.auth, device: d && { ...d, lastSeen: recent(d.lastSeen) } } });
      if (d && d.lastSeen) for (const el of document.querySelectorAll('[data-since]')) el.dataset.since = d.lastSeen;
      const wasDown = down;
      down = false;
      if (force || wasDown || key !== lastKey) {
        lastKey = key;
        render(!!force);
      }
    } catch {
      if (!down) {
        down = true;
        if (S) renderStatus(S);
      }
    }
    tick();
  }

  // Countdowns, "Ns ago" and expiry bars between polls.
  function tick() {
    for (const el of document.querySelectorAll('[data-until]')) {
      const left = secsLeft(el.dataset.until);
      if (el.classList.contains('bar')) el.firstChild.style.width = (left / Number(el.dataset.total)) * 100 + '%';
      else el.textContent = left ? mmss(left) : 'expired';
    }
    for (const el of document.querySelectorAll('[data-since]')) if (el.dataset.since) el.textContent = ago(el.dataset.since);
    for (const el of document.querySelectorAll('[data-checked]')) {
      const s = Math.round((Date.now() - lastOK) / 1000);
      el.textContent = s < 2 ? 'checked just now' : `checked ${s}s ago`;
    }
  }

  // Static parts of the frame.
  $('tb-brand').prepend(icon('mark', 16));
  $('cmd-icon').replaceWith(icon('search', 14));
  $('cmd-kbd').textContent = combo('mod', 'K');
  $('cmd-box').addEventListener('click', () => openPalette('cmd'));
  $('panel-open').append(icon('chevron-up', 16));
  $('panel-open').addEventListener('click', () => go('activity'));
  matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => render());

  refresh(true);
  setInterval(refresh, 2000);
  setInterval(tick, 1000);
})();
