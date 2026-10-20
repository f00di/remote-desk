// Remote Desk phone app. Plain JS, no libraries. File names come from the
// laptop and are always set as text, never as HTML.
'use strict';
(() => {
  const app = document.getElementById('app');
  const enc = new TextEncoder();
  const LOGIN_PREFIX = 'remote-desk-login:';
  const SHARE_LIMIT = 300 * 1024 * 1024;
  const state = { laptop: 'your laptop', dev: false, roots: [], browsing: false, sort: loadPref('sort', 'name') };

  // ---------- DOM helpers ----------
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
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const ICONS = {
    folder: 'M3 7.5A1.5 1.5 0 0 1 4.5 6H9l2 2h8.5A1.5 1.5 0 0 1 21 9.5v8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 17.5z',
    file: 'M6.5 3H14l4.5 4.5V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M14 3v4.5h4.5',
    text: 'M6.5 3H14l4.5 4.5V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M14 3v4.5h4.5|M8.5 12.5h7|M8.5 16h5',
    pdf: 'M6.5 3H14l4.5 4.5V20a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1z|M14 3v4.5h4.5|M8.5 13h7|M8.5 16.5h7',
    image: 'M4.5 5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1z|M3.5 16l4.5-4.5 4 4 2.5-2.5 6 6|M15.5 9.5h.01',
    video: 'M4.5 6.5h10a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1z|M15.5 10.5l5-3v9l-5-3',
    audio: 'M9 17.5V6l10-2v11.5|M9 17.5a2.5 2.5 0 1 1-2.5-2.5A2.5 2.5 0 0 1 9 17.5z|M19 15.5a2.5 2.5 0 1 1-2.5-2.5 2.5 2.5 0 0 1 2.5 2.5z',
    back: 'M15 5l-7 7 7 7',
    chevron: 'M9.5 6l6 6-6 6',
    search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13z|M20 20l-4.8-4.8',
    close: 'M6 6l12 12|M18 6L6 18',
    lock: 'M6.5 11h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1z|M8.5 11V8a3.5 3.5 0 0 1 7 0v3',
    share: 'M12 3.5v11|M8 7.5l4-4 4 4|M7 10.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8.5a1 1 0 0 0-1-1h-1',
    download: 'M12 4v11|M7 10.5l5 5 5-5|M5 20h14',
    plus: 'M5.5 5h13a.5.5 0 0 1 .5.5v13a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-13a.5.5 0 0 1 .5-.5z|M12 8.5v7|M8.5 12h7',
    alert: 'M12 4.5l8.5 15h-17z|M12 10v4|M12 17v.01',
    laptop: 'M5.5 6h13a1 1 0 0 1 1 1v8h-15V7a1 1 0 0 1 1-1z|M3 18h18',
    check: 'M5 12.5l4.5 4.5L19 7.5',
  };

  function icon(name, cls) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('aria-hidden', 'true');
    s.setAttribute('class', 'icon' + (cls ? ' ' + cls : ''));
    for (const d of ICONS[name].split('|')) {
      const p = document.createElementNS(ns, 'path');
      p.setAttribute('d', d);
      s.append(p);
    }
    return s;
  }

  function show(...nodes) {
    app.replaceChildren(...nodes.filter(Boolean));
    window.scrollTo(0, 0);
  }

  function brand() {
    return h('header', { class: 'brand' },
      h('span', { class: 'brand-mark' }, icon('folder')),
      h('span', { class: 'brand-name', text: 'Remote Desk' }),
      state.dev ? h('span', { class: 'badge warn', text: 'Dev mode' }) : null);
  }

  function message({ ic, title, lines = [], actions = [], tone = '' }) {
    return h('section', { class: 'center ' + tone },
      h('span', { class: 'hero-icon' }, icon(ic)),
      h('h1', { text: title }),
      lines.map((l) => (l instanceof Node ? l : h('p', { class: 'muted', text: l }))),
      actions.length ? h('div', { class: 'actions' }, actions) : null);
  }

  function button(label, onclick, cls = 'primary', ic) {
    return h('button', { class: 'btn ' + cls, type: 'button', onclick }, ic ? icon(ic) : null, h('span', { text: label }));
  }

  // ---------- API ----------
  class ApiError extends Error {
    constructor(status, data) {
      super((data && data.error) || (status ? 'Error ' + status : 'offline'));
      this.status = status;
      this.data = data || {};
    }
  }

  async function api(method, url, body) {
    let res;
    try {
      res = await fetch(url, {
        method,
        credentials: 'same-origin',
        cache: 'no-store',
        headers: body ? { 'Content-Type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(0, null);
    }
    let data = null;
    try { data = await res.json(); } catch { /* not JSON */ }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  function b64(buf) {
    let s = '';
    for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
    return btoa(s);
  }

  // ---------- this phone's key (IndexedDB, never readable by page code) ----------
  function db() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open('remote-desk', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('keys');
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  async function getKey() {
    try {
      const d = await db();
      return await new Promise((resolve, reject) => {
        const q = d.transaction('keys').objectStore('keys').get('device');
        q.onsuccess = () => resolve(q.result || null);
        q.onerror = () => reject(q.error);
      });
    } catch {
      return null;
    }
  }

  async function saveKey(v) {
    const d = await db();
    await new Promise((resolve, reject) => {
      const tx = d.transaction('keys', 'readwrite');
      tx.objectStore('keys').put(v, 'device');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
  }

  function loadPref(k, d) {
    try { return localStorage.getItem('rd.' + k) || d; } catch { return d; }
  }
  function savePref(k, v) {
    try { localStorage.setItem('rd.' + k, v); } catch { /* private mode */ }
  }

  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isStandalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

  // ---------- start ----------
  async function boot() {
    show(h('section', { class: 'center' }, h('p', { class: 'muted', text: 'Connecting to your laptop…' })));
    let hello;
    try {
      hello = await api('GET', '/api/hello');
    } catch (e) {
      return offlineView(e);
    }
    state.laptop = hello.laptop || state.laptop;
    state.dev = !!hello.dev;
    if (hello.paired && !hello.thisDevice) return otherPhoneView();
    if (!hello.paired) {
      if (isIOS && !isStandalone && !state.dev) return addToHomeView();
      return pairView();
    }
    if (!(await getKey())) return keyMissingView();
    if (hello.locked) return lockedView();
    try {
      await api('GET', '/api/session');
      return startBrowsing();
    } catch (e) {
      if (e.status === 0) return offlineView(e);
      return unlockView();
    }
  }

  function offlineView() {
    show(brand(), message({
      ic: 'laptop',
      title: "Can't reach your laptop",
      lines: [
        h('ul', { class: 'checks' },
          h('li', { text: 'Tailscale is switched on on this phone' }),
          h('li', { text: 'The laptop is on, awake and online' }),
          h('li', { text: 'Remote Desk is running on the laptop' })),
      ],
      actions: [button('Try again', boot)],
    }));
  }

  function otherPhoneView() {
    show(brand(), message({
      ic: 'lock',
      title: 'Paired with another phone',
      lines: [`${state.laptop} only works with the phone it was paired with. To use this phone instead, unpair the old one on the laptop first.`],
      actions: [button('Check again', boot, 'quiet')],
    }));
  }

  function keyMissingView() {
    show(brand(), message({
      ic: 'alert',
      title: "This phone's key is gone",
      lines: [
        'The website data for Remote Desk was cleared on this phone, so it can no longer prove it is the paired phone.',
        `On ${state.laptop}, open Remote Desk, click Unpair, then pair this phone again.`,
      ],
      actions: [button('Check again', boot, 'quiet')],
    }));
  }

  function lockedView() {
    show(brand(), message({
      ic: 'lock',
      title: 'Locked',
      lines: [`Too many wrong tries. On ${state.laptop}, open Remote Desk and click Unlock.`],
      actions: [button('Check again', boot, 'quiet')],
    }));
  }

  function addToHomeView() {
    show(brand(), h('section', { class: 'center' },
      h('span', { class: 'hero-icon' }, icon('plus')),
      h('h1', { text: 'Add Remote Desk to your Home Screen' }),
      h('p', { class: 'muted', text: 'Pairing happens in the Home Screen app, so this phone keeps its key.' }),
      h('ol', { class: 'steps' },
        h('li', null, 'Tap ', h('span', { class: 'inline-icon' }, icon('share')), ' Share in Safari’s toolbar.'),
        h('li', null, 'Choose ', h('strong', { text: 'Add to Home Screen' }), ', then ', h('strong', { text: 'Add' }), '.'),
        h('li', null, 'Open ', h('strong', { text: 'Remote Desk' }), ' from your Home Screen.'))));
  }

  // ---------- pairing ----------
  function field(label, input, hint) {
    const id = 'f-' + Math.random().toString(36).slice(2);
    input.id = id;
    return h('div', { class: 'field' }, h('label', { for: id, text: label }), input, hint ? h('p', { class: 'hint', text: hint }) : null);
  }

  function pinInput(attrs = {}) {
    const i = h('input', { type: 'password', inputmode: 'numeric', pattern: '[0-9]*', maxlength: '6', autocomplete: 'off', class: 'pin', ...attrs });
    i.addEventListener('input', () => { i.value = i.value.replace(/\D/g, '').slice(0, 6); });
    return i;
  }

  function pairView(note) {
    const code = h('input', { type: 'text', autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', maxlength: '9', placeholder: 'ABCD-EFGH', class: 'code' });
    const label = h('input', { type: 'text', maxlength: '40', value: isIOS ? 'iPhone' : 'This phone', autocomplete: 'off' });
    const pin = pinInput();
    const pin2 = pinInput();
    const err = h('p', { class: 'form-error', role: 'alert', text: note || '' });
    const submit = h('button', { class: 'btn primary wide', type: 'submit' }, h('span', { text: 'Pair this phone' }));
    const form = h('form', { class: 'card', novalidate: true },
      field('Pairing code', code, `On ${state.laptop}, open Remote Desk and click “Show pairing code”.`),
      field('Name for this phone', label),
      field('Choose a 6-digit PIN', pin, 'You’ll type it each time you open Remote Desk.'),
      field('Type the PIN again', pin2),
      err, submit);
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      const c = code.value.toUpperCase().replace(/[\s-]/g, '');
      if (c.length !== 8) return (err.textContent = 'The pairing code has 8 letters and numbers.');
      if (pin.value.length !== 6) return (err.textContent = 'The PIN must be 6 digits.');
      if (pin.value !== pin2.value) return (err.textContent = 'The two PINs don’t match.');
      submit.disabled = true;
      submit.firstChild.textContent = 'Pairing…';
      try {
        const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
        const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
        const { id } = await api('POST', '/api/pair', { code: c, label: label.value, pin: pin.value, publicKey: b64(spki) });
        await saveKey({ privateKey: kp.privateKey, publicKey: b64(spki), created: Date.now() });
        waitView(id, pin.value, label.value);
      } catch (ex) {
        err.textContent = ex.status === 0 ? "Can't reach your laptop." : ex.message;
        submit.disabled = false;
        submit.firstChild.textContent = 'Pair this phone';
      }
    });
    show(brand(), h('section', { class: 'page' },
      h('h1', { text: 'Pair this phone' }),
      h('p', { class: 'muted', text: `Connect it to ${state.laptop}. Only one phone can be paired.` }),
      form));
  }

  function waitView(id, pin, label) {
    show(brand(), message({
      ic: 'laptop',
      title: 'Approve on your laptop',
      lines: [`On ${state.laptop}, Remote Desk shows a request from “${label}”. Click Approve.`],
    }));
    const started = Date.now();
    const poll = async () => {
      if (Date.now() - started > 6 * 60 * 1000) return pairView('The request ran out of time. Show a new code on the laptop.');
      try {
        const { status } = await api('GET', '/api/pair/status?id=' + encodeURIComponent(id));
        if (status === 'approved') {
          await doLogin(pin);
          return startBrowsing();
        }
        if (status === 'denied') return pairView('The laptop declined this phone.');
        if (status === 'expired') return pairView('The request ran out of time. Show a new code on the laptop.');
      } catch (e) {
        if (e.status === 404) return pairView('The request ran out of time. Show a new code on the laptop.');
      }
      setTimeout(poll, 1500);
    };
    setTimeout(poll, 1500);
  }

  // ---------- unlock ----------
  async function doLogin(pin) {
    const key = await getKey();
    if (!key) throw new ApiError(403, { error: 'key missing' });
    const { nonce } = await api('POST', '/api/challenge');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(LOGIN_PREFIX + nonce));
    await api('POST', '/api/login', { nonce, signature: b64(sig), pin });
  }

  function unlockView(note) {
    state.browsing = false;
    const pin = pinInput({ 'aria-label': 'PIN' });
    const err = h('p', { class: 'form-error', role: 'alert', text: note || '' });
    const submit = h('button', { class: 'btn primary wide', type: 'submit' }, h('span', { text: 'Unlock' }));
    const form = h('form', { class: 'unlock', novalidate: true }, pin, err, submit);
    let busy = false;
    const go = async () => {
      if (busy || pin.value.length !== 6) return;
      busy = true;
      submit.disabled = true;
      err.textContent = '';
      try {
        await doLogin(pin.value);
        return startBrowsing();
      } catch (e) {
        if (e.status === 423 || e.data.locked) return lockedView();
        if (e.status === 403) return boot();
        if (e.status === 0) return offlineView();
        const left = e.data.triesLeft;
        err.textContent = e.status === 401 ? `Wrong PIN.${left ? ` ${left} ${left === 1 ? 'try' : 'tries'} left.` : ''}` : e.message;
        pin.value = '';
        pin.focus();
      } finally {
        busy = false;
        submit.disabled = false;
      }
    };
    pin.addEventListener('input', () => { if (pin.value.length === 6) go(); });
    form.addEventListener('submit', (e) => { e.preventDefault(); go(); });
    show(brand(), h('section', { class: 'center' },
      h('span', { class: 'hero-icon' }, icon('lock')),
      h('h1', { text: 'Enter your PIN' }),
      h('p', { class: 'muted', text: `Files on ${state.laptop}` }),
      form));
    setTimeout(() => pin.focus(), 60);
  }

  // ---------- browsing ----------
  async function startBrowsing() {
    let data;
    try {
      data = await api('GET', '/api/roots');
    } catch (e) {
      return handleErr(e);
    }
    state.laptop = data.laptop || state.laptop;
    state.roots = data.roots.filter((r) => r.available);
    state.browsing = true;
    const loc = state.roots.length === 1 ? { root: state.roots[0].id, path: [] } : { root: null, path: [] };
    history.replaceState(loc, '');
    render(loc);
  }

  function handleErr(e) {
    if (e.status === 401) { unlockView('Locked after 15 minutes without use.'); return true; }
    if (e.status === 0) { offlineView(); return true; }
    if (e.status === 423) { lockedView(); return true; }
    return false;
  }

  function go(loc) {
    history.pushState(loc, '');
    render(loc);
  }

  window.addEventListener('popstate', (e) => {
    if (state.browsing && e.state) render(e.state);
  });

  function lock() {
    api('POST', '/api/logout').catch(() => {});
    unlockView();
  }

  function rootName(id) {
    const r = state.roots.find((x) => x.id === id);
    return r ? r.name : '';
  }

  function topBar(title, back) {
    return h('header', { class: 'bar' },
      back ? h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Back', onclick: back }, icon('back', 'dir-icon')) : h('span', { class: 'bar-spacer' }),
      h('div', { class: 'bar-title' }, h('p', { class: 'eyebrow', text: state.laptop }), h('h1', { text: title })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Lock', onclick: lock }, icon('lock')));
  }

  function crumbs(loc) {
    if (loc.root == null || loc.path.length === 0) return null; // the title already names it
    const parts = [h('button', { class: 'crumb', type: 'button', onclick: () => go({ root: loc.root, path: [] }), text: rootName(loc.root) })];
    loc.path.forEach((p, i) => {
      parts.push(h('span', { class: 'crumb-sep', 'aria-hidden': 'true', text: '/' }));
      const target = loc.path.slice(0, i + 1);
      parts.push(i === loc.path.length - 1
        ? h('span', { class: 'crumb current', 'aria-current': 'page', text: p })
        : h('button', { class: 'crumb', type: 'button', onclick: () => go({ root: loc.root, path: target }), text: p }));
    });
    return h('nav', { class: 'crumbs', 'aria-label': 'Folder path' }, parts);
  }

  function render(loc) {
    const atTop = loc.root == null || (loc.path.length === 0 && state.roots.length === 1);
    const title = loc.root == null ? 'Your files' : loc.path.length ? loc.path[loc.path.length - 1] : rootName(loc.root);
    const back = atTop ? null : () => go(loc.path.length ? { root: loc.root, path: loc.path.slice(0, -1) } : { root: null, path: [] });
    const list = h('ul', { class: 'list', 'aria-busy': 'true' });
    const status = h('p', { class: 'list-status muted', role: 'status' });
    let entries = null;

    const search = h('input', { type: 'search', placeholder: 'Search files', enterkeyhint: 'search', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', 'aria-label': 'Search by file name' });
    const sortBtns = ['name', 'newest'].map((s) => h('button', {
      class: 'seg' + (state.sort === s ? ' on' : ''), type: 'button', 'aria-pressed': String(state.sort === s),
      text: s === 'name' ? 'A–Z' : 'Newest',
      onclick: () => {
        state.sort = s;
        savePref('sort', s);
        sortBtns.forEach((b) => { const on = b.textContent === (s === 'name' ? 'A–Z' : 'Newest'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); });
        if (entries && !search.value.trim()) fill(entries);
      },
    }));

    const fill = (items) => {
      list.removeAttribute('aria-busy');
      if (loc.root == null) {
        list.replaceChildren(...state.roots.map((r) => row({ name: r.name, dir: true, kind: 'folder' }, () => go({ root: r.id, path: [] }), 'Shared folder')));
        status.textContent = '';
        return;
      }
      const sorted = [...items].sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        if (state.sort === 'newest') return b.mtime - a.mtime;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      list.replaceChildren(...sorted.map((e) => row(e, () => (e.dir ? go({ root: loc.root, path: [...loc.path, e.name] }) : openViewer(loc.root, [...loc.path, e.name].join('/'), e)))));
      status.textContent = sorted.length ? '' : 'This folder is empty.';
    };

    let timer = 0;
    let seq = 0;
    search.addEventListener('input', () => {
      clearTimeout(timer);
      const q = search.value.trim();
      if (q.length < 2) {
        seq++;
        if (entries || loc.root == null) fill(entries || []);
        return;
      }
      timer = setTimeout(async () => {
        const my = ++seq;
        status.textContent = 'Searching…';
        try {
          const { results } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
          if (my !== seq) return;
          list.replaceChildren(...results.map((r) => {
            const parent = r.path.split('/').slice(0, -1);
            const where = [r.rootName, ...parent].join('/');
            return row(r, () => (r.dir ? go({ root: r.root, path: r.path.split('/') }) : openViewer(r.root, r.path, r)), `in ${where} · ${meta(r)}`);
          }));
          status.textContent = results.length ? (results.length >= 100 ? 'Showing the first 100 matches.' : '') : 'Nothing matches that name.';
        } catch (e) {
          if (!handleErr(e)) status.textContent = e.message;
        }
      }, 350);
    });

    show(topBar(title, back), crumbs(loc),
      h('div', { class: 'tools' },
        h('label', { class: 'search' }, icon('search'), search),
        loc.root == null ? null : h('div', { class: 'segs', role: 'group', 'aria-label': 'Sort' }, sortBtns)),
      list, status);

    if (loc.root == null) return fill([]);
    status.textContent = 'Loading…';
    api('GET', `/api/list?root=${loc.root}&path=${encodeURIComponent(loc.path.join('/'))}`)
      .then((d) => {
        entries = d.entries;
        if (!search.value.trim()) fill(entries);
        if (d.truncated) status.textContent = 'Showing the first 5,000 items. Use search to find the rest.';
      })
      .catch((e) => {
        if (!handleErr(e)) {
          list.removeAttribute('aria-busy');
          status.textContent = e.message;
        }
      });
  }

  const KIND_ICON = { folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'pdf', text: 'text' };

  function row(e, onclick, sub) {
    return h('li', null, h('button', { class: 'row', type: 'button', onclick },
      h('span', { class: 'row-icon kind-' + (e.kind || 'other') }, icon(KIND_ICON[e.kind] || 'file')),
      h('span', { class: 'row-main' },
        h('span', { class: 'row-name', text: e.name }),
        h('span', { class: 'row-meta', text: sub || meta(e) })),
      e.dir ? icon('chevron', 'row-chev dir-icon') : null));
  }

  function meta(e) {
    const parts = [];
    if (!e.dir && e.size != null) parts.push(size(e.size));
    if (e.mtime) parts.push(when(e.mtime));
    return parts.join(' · ');
  }

  function size(n) {
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }

  function when(ms) {
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return 'Today ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }

  // ---------- viewer ----------
  const MIME = {
    jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
    mp4: 'video/mp4', mov: 'video/quicktime', m4v: 'video/x-m4v', mp3: 'audio/mpeg', m4a: 'audio/mp4', wav: 'audio/wav',
    pdf: 'application/pdf', txt: 'text/plain', csv: 'text/csv', md: 'text/markdown', json: 'application/json',
    doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ppt: 'application/vnd.ms-powerpoint', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    pages: 'application/vnd.apple.pages', numbers: 'application/vnd.apple.numbers', key: 'application/vnd.apple.keynote',
    zip: 'application/zip',
  };
  const mimeFor = (name) => MIME[(name.split('.').pop() || '').toLowerCase()] || 'application/octet-stream';

  function fileURL(root, rel) {
    return `/api/file?root=${root}&path=${encodeURIComponent(rel)}`;
  }

  // In the Home Screen app iOS has no back button, so a plain download link
  // takes over the whole app with no way back. There, files go through the
  // share sheet only (Save to Files, Open in Preview, AirDrop…).
  const standaloneIOS = isIOS && isStandalone;
  // Files up to this size are fetched when the viewer opens, so one tap on
  // "Share or save" opens the share sheet straight away.
  const PREFETCH_LIMIT = 25 * 1024 * 1024;
  const canShareFiles = !!(navigator.share && navigator.canShare);

  function openViewer(root, rel, e) {
    const url = fileURL(root, rel);
    const dl = url + '&dl=1';
    const dlg = h('dialog', { class: 'viewer', 'aria-labelledby': 'viewer-title' });
    const where = [rootName(root), ...rel.split('/').slice(0, -1)].join('/');
    const note = h('p', { class: 'viewer-note muted', role: 'status' });
    const ctl = new AbortController();
    const objectURLs = [];
    const locked = () => {
      dlg.close();
      unlockView('Locked after 15 minutes without use.');
    };

    // One fetch feeds both the share sheet and (for images, video, audio)
    // the preview. PDFs and text keep their own preview request.
    const eager = canShareFiles && e.size <= PREFETCH_LIMIT && e.size <= SHARE_LIMIT;
    const inlineKinds = ['image', 'video', 'audio'];
    const load = loader(inlineKinds.includes(e.kind) ? url : dl, e, ctl.signal);

    const head = h('header', { class: 'viewer-head' },
      h('div', { class: 'viewer-title' },
        h('h2', { id: 'viewer-title', text: e.name }),
        h('p', { class: 'muted', text: `${meta(e)} · in ${where}` })),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, icon('close')));

    const share = shareButton(e, note, load, eager, locked);
    const download = standaloneIOS ? null : h('a', { class: 'btn quiet', href: dl, download: e.name }, icon('download'), h('span', { text: 'Download' }));
    if (!share && !download) note.textContent = e.size > SHARE_LIMIT
      ? 'This file is over 300 MB, too big to save from the phone app.'
      : 'This phone can’t save files from the Home Screen app. Open Remote Desk in Safari instead.';

    const useBlob = eager && inlineKinds.includes(e.kind);
    const setSrc = (el) => {
      if (!useBlob) { el.src = url; return; }
      load.start().then((f) => {
        const u = URL.createObjectURL(f);
        objectURLs.push(u);
        el.src = u;
      }).catch((err) => { if (err.name !== 'AbortError' && !err.locked) el.src = url; });
    };

    dlg.append(head, h('div', { class: 'viewer-body' }, preview(e, url, setSrc)), note,
      h('footer', { class: 'viewer-actions' }, share, download));
    dlg.addEventListener('close', () => {
      ctl.abort();
      objectURLs.forEach((u) => URL.revokeObjectURL(u));
      dlg.remove();
    });
    dlg.addEventListener('click', (ev) => { if (ev.target === dlg) dlg.close(); });
    document.body.append(dlg);
    dlg.showModal();
  }

  function preview(e, url, setSrc) {
    switch (e.kind) {
      case 'image': {
        const img = h('img', { alt: e.name, decoding: 'async' });
        setSrc(img);
        return img;
      }
      case 'video': {
        const v = h('video', { controls: true, playsinline: true, preload: 'metadata' });
        setSrc(v);
        return v;
      }
      case 'audio': {
        const a = h('audio', { controls: true, preload: 'metadata' });
        setSrc(a);
        return a;
      }
      case 'pdf':
        return h('iframe', { src: url, title: e.name });
      case 'text': {
        const pre = h('pre', { class: 'text-preview', text: 'Loading…' });
        fetch(url, { credentials: 'same-origin', headers: { Range: 'bytes=0-262143' } })
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error('Error ' + r.status))))
          .then((t) => { pre.textContent = t + (e.size > 262144 ? '\n\n… (first 256 KB shown)' : ''); })
          .catch(() => { pre.textContent = "Couldn't load a preview."; });
        return pre;
      }
      default:
        return h('div', { class: 'no-preview' },
          h('span', { class: 'hero-icon' }, icon('file')),
          h('p', { class: 'muted', text: 'No preview for this type. Use “Share or save” to keep it or open it in another app.' }));
    }
  }

  // loader fetches a whole file once (shared by the preview and the share
  // sheet) and reports progress. A failed fetch can be retried.
  function loader(src, e, signal) {
    let p = null;
    let progress = () => {};
    const start = () => (p ||= (async () => {
      const res = await fetch(src, { credentials: 'same-origin', signal });
      if (res.status === 401) throw Object.assign(new Error('locked'), { locked: true });
      if (!res.ok || !res.body) throw new Error('Error ' + res.status);
      const total = Number(res.headers.get('Content-Length')) || e.size || 0;
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        if (total) progress(Math.min(99, Math.floor((got / total) * 100)));
      }
      return new File(chunks, e.name, { type: mimeFor(e.name) });
    })().catch((err) => { p = null; throw err; }));
    return { start, onProgress: (fn) => { progress = fn; } };
  }

  // Share sheet: Save to Files, Open in Preview, AirDrop, WhatsApp, Mail…
  function shareButton(e, note, load, eager, locked) {
    if (!canShareFiles || e.size > SHARE_LIMIT) return null;
    const label = h('span', { text: eager ? 'Preparing…' : 'Share or save' });
    const btn = h('button', { class: 'btn primary', type: 'button', disabled: eager }, icon('share'), label);
    let file = null;
    load.onProgress((pct) => { label.textContent = `${eager ? 'Preparing' : 'Getting file'}… ${pct}%`; });
    const ready = (f) => {
      file = f;
      label.textContent = 'Share or save';
      btn.disabled = false;
      if (!navigator.canShare({ files: [f] })) {
        btn.disabled = true;
        note.textContent = 'This phone can’t share this type of file.';
      }
    };
    const fail = (err) => {
      if (err.name === 'AbortError') return;
      if (err.locked) return locked();
      label.textContent = 'Share or save';
      btn.disabled = false;
      note.textContent = 'Couldn’t get the file. Check the connection and try again.';
    };
    const share = async () => {
      try {
        await navigator.share({ files: [file] });
        note.textContent = '';
      } catch (err) {
        if (err.name === 'NotAllowedError') note.textContent = 'Ready. Tap “Share or save” again.';
        else if (err.name !== 'AbortError') note.textContent = 'Sharing didn’t work. Try again.';
      }
    };
    if (eager) load.start().then(ready, fail);
    btn.addEventListener('click', async () => {
      if (file) return share();
      btn.disabled = true;
      note.textContent = '';
      try {
        ready(await load.start());
        await share(); // after a long fetch iOS may want a second tap
      } catch (err) {
        fail(err);
      }
    });
    return btn;
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  boot();
})();
