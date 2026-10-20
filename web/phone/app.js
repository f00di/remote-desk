// Remote Desk phone app. Plain JS, no libraries. File names come from the
// laptop and are always set as text, never as HTML.
'use strict';
(() => {
  const app = document.getElementById('app');
  const enc = new TextEncoder();
  const LOGIN_PREFIX = 'remote-desk-login:';
  const SHARE_LIMIT = 300 * 1024 * 1024;
  // Files up to this size are fetched when the preview opens, so one tap on
  // Download opens the share sheet straight away.
  const PREFETCH_LIMIT = 25 * 1024 * 1024;
  const REQUEST_TTL = 5 * 60; // seconds a pairing request waits on the laptop
  const TEXT_LIMIT = 256 * 1024;
  const host = /^[\d.:]+$/.test(location.hostname) ? location.hostname : location.hostname.split('.')[0];
  const state = {
    laptop: loadPref('laptop', 'Your laptop'), dev: false, roots: [], browsing: false,
    sort: loadPref('sort', 'name'), loc: null, protectedOpen: false,
  };

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
    for (const c of children.flat(Infinity)) {
      if (c == null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  const icon = (name, size = 20, cls) => window.RD.icon(name, size, cls);

  // Timers and listeners of the current screen, dropped when it changes.
  let leaving = [];
  const onLeave = (fn) => leaving.push(fn);

  function show(...nodes) {
    closeOverlays();
    leaving.splice(0).forEach((fn) => fn());
    app.replaceChildren(...nodes.flat().filter(Boolean));
  }

  function authHead() {
    return h('header', { class: 'auth-head' }, h('div', { class: 'auth-head-row' },
      icon('mark', 20),
      h('span', { class: 'brand', text: 'Remote Desk' }),
      h('span', { class: 'host', text: state.dev ? 'dev mode' : host })));
  }

  function screen(...children) {
    return h('section', { class: 'screen' }, children);
  }

  function statusBar({ dot = '', pulse = false, label = state.laptop, mono = false, info = '', badge = false, tools = false } = {}) {
    return h('footer', { class: 'sbar' }, h('div', { class: 'sbar-row' },
      h('span', { class: ['dot', dot, pulse && 'pulse'].filter(Boolean).join(' '), 'aria-hidden': 'true' }),
      h('span', { class: 'sbar-label' + (mono ? ' mono' : ''), text: label }),
      h('span', { class: 'sbar-fill' }),
      info || state.dev ? h('span', { class: 'sbar-info', text: info || 'dev mode' }) : null,
      badge ? h('span', { class: 'badge', text: 'READ-ONLY' }) : null,
      tools ? h('button', { class: 'sbar-btn', type: 'button', 'aria-label': 'Color theme', onclick: openThemeSheet }, icon('theme', 18)) : null,
      tools ? h('button', { class: 'sbar-btn lock', type: 'button', 'aria-label': 'Lock', onclick: lock }, icon('lock', 18)) : null));
  }

  function button(label, onclick, cls = 'primary', ic) {
    return h('button', { class: 'btn ' + cls, type: 'button', onclick }, ic ? icon(ic, 18) : null, label);
  }

  const title = (text) => h('h1', { class: 'title', text });
  const lead = (...parts) => h('p', { class: 'lead' }, parts);
  const em = (text) => h('em', { text });
  const strong = (text) => h('strong', { text });
  const errLine = (msg) => h('div', { class: 'err-line', role: 'alert' }, icon('warning', 16), h('div', null, msg));
  const stepRow = (n, ...parts) => h('div', { class: 'card-row' }, h('span', { class: 'step-no', text: n }), h('span', null, parts));

  // trail draws a menu path like "Remote Desk › Your phone › Unpair".
  function trail(parts) {
    return h('div', { class: 'path' }, parts.map((p, i) => {
      const [text, cls] = Array.isArray(p) ? p : [p];
      return [i ? h('span', { class: 'sep', text: '›' }) : null, h('span', { class: cls, text })];
    }));
  }

  const sentence = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  // ---------- overlays (search, theme sheet, preview) ----------
  const overlays = new Set();

  function overlay(nodes, onClose) {
    let done = false;
    const close = (instant) => {
      if (done) return;
      done = true;
      overlays.delete(close);
      if (onClose) onClose();
      if (instant === true) return nodes.forEach((n) => n.remove());
      nodes.forEach((n) => n.classList.add('closing'));
      setTimeout(() => nodes.forEach((n) => n.remove()), 130);
    };
    overlays.add(close);
    return close;
  }
  function closeOverlays() { [...overlays].forEach((close) => close(true)); }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && overlays.size) [...overlays].pop()();
  });

  let toastTimer = 0;
  function toast(msg, tone = '') {
    document.querySelector('.toast')?.remove();
    clearTimeout(toastTimer);
    const t = h('div', { class: 'toast' + (tone ? ' ' + tone : ''), role: 'status' },
      icon(tone === 'danger' ? 'warning' : 'info', 16), h('span', { text: msg }));
    document.body.append(t);
    toastTimer = setTimeout(() => {
      t.classList.add('closing');
      setTimeout(() => t.remove(), 130);
    }, 5000);
  }

  // The status bar hides while the system keyboard is up.
  if (window.visualViewport) {
    const vv = window.visualViewport;
    const fit = () => {
      document.documentElement.style.setProperty('--vvh', vv.height + 'px');
      document.body.classList.toggle('kb-open', window.innerHeight - vv.height > 120);
    };
    vv.addEventListener('resize', fit);
    fit();
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
  const phoneWord = isIOS ? 'iPhone' : 'phone';

  // ---------- start ----------
  async function boot() {
    state.browsing = false;
    show(authHead(), screen(h('p', { class: 'note', text: `connecting to ${host}…` })),
      statusBar({ dot: 'warning', pulse: true, label: 'Connecting' }));
    let hello;
    try {
      hello = await api('GET', '/api/hello');
    } catch {
      return offlineView();
    }
    savePref('reached', String(Date.now()));
    state.laptop = hello.laptop || state.laptop;
    savePref('laptop', state.laptop);
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
      if (e.status === 0) return offlineView();
      return unlockView();
    }
  }

  function offlineView() {
    const reached = Number(loadPref('reached', 0));
    const auto = h('span', { class: 'note' });
    let left = 10;
    const tick = () => { auto.textContent = `auto-retry in ${left}s`; };
    tick();
    show(authHead(), screen(
      icon('offline', 24, 'hero tone-danger'),
      title('Can’t reach your laptop'),
      lead(`${state.laptop} didn’t answer over Tailscale. Check:`),
      h('div', { class: 'card' },
        stepRow(1, `Tailscale is on, on this ${phoneWord}`),
        stepRow(2, 'The laptop is awake and Remote Desk is running'),
        stepRow(3, 'Both are signed in to the same tailnet')),
      h('p', { class: 'note', text: (reached ? `last reached ${clock(reached)} · ` : '') + location.hostname }),
      h('div', { class: 'btn-row' }, button('Retry now', boot, 'primary', 'refresh'), auto)),
    statusBar({ dot: 'danger', label: 'Offline', info: 'retrying' }));
    const t = setInterval(() => {
      left -= 1;
      if (left <= 0) boot();
      else tick();
    }, 1000);
    onLeave(() => clearInterval(t));
  }

  function otherPhoneView() {
    show(authHead(), screen(
      icon('phone', 24, 'hero tone-warning'),
      title('Paired with another phone'),
      lead(`${state.laptop} already has a paired phone. Remote Desk allows one.`),
      h('div', { class: 'card pad' },
        h('p', { text: `To use this ${phoneWord} instead, unpair the other one on your laptop:` }),
        trail(['Remote Desk', 'Your phone', ['Unpair', 'danger']]),
        h('p', { class: 'path-gap', text: 'Then pair this phone with a new code.' })),
      button('Check again', boot, 'secondary wide')),
    statusBar({ dot: 'warning', label: 'Not paired', info: host }));
  }

  function keyMissingView() {
    show(authHead(), screen(
      icon('key', 24, 'hero tone-warning'),
      title('This phone’s key is gone'),
      lead(`Website data for Remote Desk was cleared on this ${phoneWord}, so your laptop can’t recognise it.`),
      h('div', { class: 'card' },
        h('div', { class: 'card-row lg' }, h('span', { class: 'step-no', text: '1' }),
          h('span', null, 'On the laptop: ', h('span', { class: 'num', text: 'Your phone › Unpair' }))),
        h('div', { class: 'card-row lg' }, h('span', { class: 'step-no', text: '2' }), h('span', { text: 'Here: pair again with a new code' }))),
      button('Pair again', boot, 'primary wide')),
    statusBar({ dot: 'warning', label: 'Key missing', info: host }));
  }

  // The laptop keeps a locked phone locked until its owner clicks Unlock
  // there, so there's no timer here.
  function lockedView() {
    show(authHead(), screen(
      h('div', { class: 'title-icon' }, icon('lock', 22, 'tone-danger'), title('Too many tries')),
      lead('PIN entry is locked on this phone after 5 wrong PINs.'),
      h('div', { class: 'card' },
        h('div', { class: 'lock-card-top' }, h('span', { class: 'big-num', text: '5/5' }), h('span', { class: 'note', text: 'wrong PINs' })),
        h('div', { class: 'bar danger' }, h('span'))),
      h('p', { class: 'body-sm', text: 'Unlock it on your laptop:' }),
      trail(['Remote Desk', 'Your phone', ['Unlock', 'accent']]),
      h('p', { class: 'body-sm', text: 'Forgot the PIN? Unpair this phone there instead, then pair again.' }),
      button('Check again', boot, 'secondary wide')),
    keypad(null, true),
    statusBar({ info: 'PIN locked' }));
  }

  function addToHomeView() {
    show(authHead(), screen(
      title('Add to Home Screen'),
      lead('Remote Desk runs from your Home Screen, so this phone can keep its pairing key.'),
      h('div', { class: 'card' },
        h('div', { class: 'card-row tall' }, h('span', { class: 'step-no', text: '1' }), icon('share', 20, 'accent'), h('span', null, 'Tap ', strong('Share'), ' in Safari’s toolbar')),
        h('div', { class: 'card-row tall' }, h('span', { class: 'step-no', text: '2' }), icon('add-square', 20, 'accent'), h('span', null, 'Choose ', strong('Add to Home Screen'))),
        h('div', { class: 'card-row tall' }, h('span', { class: 'step-no', text: '3' }), icon('mark', 20, 'accent'), h('span', { text: 'Open Remote Desk from there' }))),
      h('div', { class: 'app-tile' },
        h('img', { src: '/icon-180.png', alt: '', width: '60', height: '60' }),
        h('div', { class: 'stack' }, h('span', { class: 'name', text: 'Remote Desk' }), h('span', { class: 'sub', text: location.hostname })))));
  }

  // ---------- pairing ----------
  function pairView(note, keep = '') {
    let code = keep;
    const input = h('input', {
      class: 'code-input', type: 'text', autocapitalize: 'characters', autocomplete: 'off', autocorrect: 'off',
      spellcheck: 'false', enterkeyhint: 'go', maxlength: '9', 'aria-label': 'Pairing code', 'aria-describedby': 'code-help',
    });
    const cells = Array.from({ length: 8 }, () => h('span', { class: 'cell', 'aria-hidden': 'true' }));
    const submit = h('button', { class: 'btn primary wide', type: 'button', disabled: true, text: 'Pair' });
    const draw = () => {
      const focused = document.activeElement === input;
      cells.forEach((c, i) => {
        c.textContent = code[i] || '';
        c.classList.toggle('active', focused && i === code.length);
      });
      submit.disabled = code.length !== 8;
    };
    const next = () => { if (code.length === 8) pinSetView(code); };
    input.value = code;
    input.addEventListener('input', () => {
      code = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
      input.value = code;
      draw();
    });
    input.addEventListener('focus', draw);
    input.addEventListener('blur', draw);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); next(); } });
    submit.addEventListener('click', next);
    show(authHead(), screen(
      title('Pair this phone'),
      lead('Enter the one-time code shown in Remote Desk on your laptop, under ', em('Your phone'), '.'),
      h('div', { class: 'code-entry' },
        h('div', { class: 'code-group' }, cells.slice(0, 4)),
        h('span', { class: 'code-dash', 'aria-hidden': 'true', text: '-' }),
        h('div', { class: 'code-group' }, cells.slice(4)),
        input),
      h('p', { class: 'code-help', id: 'code-help', text: 'ABCD-EFGH · letters and digits · not case-sensitive' }),
      note ? errLine(note) : null,
      submit));
    draw();
    setTimeout(() => input.focus(), 60);
  }

  // The PIN travels with the pairing request, so it's chosen before the
  // laptop approves.
  function pinSetView(code) {
    let first = '';
    const body = 'Six digits. You’ll enter it each time Remote Desk opens.';
    pinPad({
      title: 'Set a PIN', step: '1 / 2', body,
      extra: h('button', { class: 'btn link', type: 'button', text: 'Change the code', onclick: () => pairView('', code) }),
      onDone: async (pin, pad) => {
        if (!first) {
          first = pin;
          pad.update({ title: 'Confirm PIN', step: '2 / 2', body: 'Enter the same six digits again.' });
          return pad.clear();
        }
        if (pin !== first) {
          first = '';
          pad.update({ title: 'Set a PIN', step: '1 / 2', body });
          return pad.fail('The two PINs didn’t match · choose one again');
        }
        await submitPair(code, pin);
      },
    });
  }

  async function submitPair(code, pin) {
    const label = isIOS ? 'iPhone' : 'This phone';
    try {
      const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
      const spki = await crypto.subtle.exportKey('spki', kp.publicKey);
      const { id } = await api('POST', '/api/pair', { code, label, pin, publicKey: b64(spki) });
      await saveKey({ privateKey: kp.privateKey, publicKey: b64(spki), created: Date.now() });
      approveView(id, pin, label);
    } catch (ex) {
      if (ex.status === 0) return offlineView();
      if (/already paired/.test(ex.message)) return otherPhoneView();
      pairView(sentence(ex.message));
    }
  }

  function approveView(id, pin, label) {
    const started = Date.now();
    const left = h('span', { class: 'num muted' });
    const fill = h('span');
    const tick = () => {
      const s = Math.max(0, REQUEST_TTL - Math.floor((Date.now() - started) / 1000));
      left.textContent = mmss(s).replace(/^0/, '');
      fill.style.width = (s / REQUEST_TTL) * 100 + '%';
    };
    tick();
    let poller = 0;
    let stopped = false;
    const expired = () => pairView('The request ran out of time. Show a new code on the laptop.');
    const poll = async () => {
      if (stopped) return;
      if (Date.now() - started > (REQUEST_TTL + 60) * 1000) return expired();
      try {
        const { status } = await api('GET', '/api/pair/status?id=' + encodeURIComponent(id));
        if (stopped) return;
        if (status === 'approved') {
          try {
            await doLogin(pin);
          } catch {
            return unlockView();
          }
          return startBrowsing();
        }
        if (status === 'denied') return pairView('The laptop declined this phone.');
        if (status === 'expired') return expired();
      } catch (e) {
        if (e.status === 404) return expired();
      }
      poller = setTimeout(poll, 1500);
    };
    show(authHead(), screen(
      title('Approve on your laptop'),
      lead(`Remote Desk on ${state.laptop} is showing a request from this ${phoneWord}. Click `, em('Approve'), ' there.'),
      h('div', { class: 'card' },
        h('div', { class: 'laptop-row' }, icon('laptop', 20),
          h('div', { class: 'stack' }, h('span', { class: 'name', text: state.laptop }), h('span', { class: 'sub', text: location.hostname }))),
        h('div', { class: 'card-row' }, h('span', { class: 'dot warning pulse', 'aria-hidden': 'true' }), h('span', { class: 'grow', text: 'Waiting for approval' }), left),
        h('div', { class: 'bar warning' }, fill),
        h('div', { class: 'card-row' }, icon('phone', 20), h('span', { class: 'grow muted', text: 'Shown as' }), h('span', { class: 'num', text: label }))),
      button('Cancel request', () => pairView(), 'secondary wide')),
    statusBar({ dot: 'warning', pulse: true, label: 'Waiting for approval', info: host }));
    const t = setInterval(tick, 1000);
    poller = setTimeout(poll, 1500);
    onLeave(() => { stopped = true; clearInterval(t); clearTimeout(poller); });
  }

  // ---------- PIN pad ----------
  // pinPad shows six PIN cells and the keypad. onDone(pin, pad) runs when
  // six digits are in; pad.fail(message) shakes the cells and starts over.
  function pinPad(o) {
    let pin = '';
    let busy = false;
    const cells = Array.from({ length: 6 }, () => h('span', { class: 'pin-cell' }));
    const row = h('div', { class: 'pin-cells', role: 'img' }, cells);
    const titleEl = h('h1', { class: 'title' });
    const stepEl = h('span', { class: 'step' });
    const bodyEl = h('p', { class: 'lead' });
    const errBox = h('div');
    const draw = () => {
      const err = row.classList.contains('err');
      cells.forEach((c, i) => {
        c.classList.toggle('filled', i < pin.length);
        c.classList.toggle('active', !err && i === pin.length);
      });
      row.setAttribute('aria-label', `PIN, ${pin.length} of 6 digits entered`);
    };
    const pad = {
      update(t) {
        if (t.title != null) titleEl.textContent = t.title;
        if (t.step != null) stepEl.textContent = t.step;
        if (t.body != null) bodyEl.replaceChildren(...[t.body].flat());
      },
      clear() { pin = ''; draw(); },
      fail(msg) {
        pin = '';
        row.classList.add('err');
        row.classList.remove('shake');
        void row.offsetWidth; // restart the shake
        row.classList.add('shake');
        errBox.replaceChildren(errLine(msg));
        draw();
      },
    };
    const press = (d) => {
      if (busy) return;
      if (row.classList.contains('err')) {
        row.classList.remove('err');
        errBox.replaceChildren();
      }
      if (d === 'back') pin = pin.slice(0, -1);
      else if (pin.length < 6) pin += d;
      draw();
      if (pin.length === 6) {
        busy = true;
        Promise.resolve(o.onDone(pin, pad)).finally(() => { busy = false; });
      }
    };
    const onKey = (e) => {
      if (/^[0-9]$/.test(e.key)) press(e.key);
      else if (e.key === 'Backspace') press('back');
    };
    pad.update({ title: o.title, step: o.step || '', body: o.body });
    show(authHead(), screen(
      h('div', { class: 'title-row' }, titleEl, stepEl),
      bodyEl, row, errBox,
      o.note ? h('p', { class: 'note', text: o.note }) : null,
      o.extra || null),
    keypad(press),
    statusBar(o.status));
    draw();
    document.addEventListener('keydown', onKey);
    onLeave(() => document.removeEventListener('keydown', onKey));
  }

  function keypad(press, off) {
    const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', 'back'];
    return h('div', { class: 'keypad' + (off ? ' off' : ''), 'aria-hidden': off ? 'true' : null }, keys.map((k) => {
      if (!k) return h('span');
      if (k === 'back') return h('button', { class: 'key back', type: 'button', 'aria-label': 'Delete', onclick: () => press && press(k) }, icon('backspace', 26));
      return h('button', { class: 'key', type: 'button', text: k, onclick: () => press && press(k) });
    }));
  }

  const wrongPIN = (left) => ['Wrong PIN', left ? [' · ', h('span', { class: 'num', text: left }), left === 1 ? ' try left' : ' tries left'] : null];

  // ---------- unlock ----------
  // signedPIN gets a one-time challenge, signs it with this phone's key and
  // sends it with the PIN to url (login, or opening protected folders).
  async function signedPIN(url, pin) {
    const key = await getKey();
    if (!key) throw new ApiError(403, { error: 'key missing' });
    const { nonce } = await api('POST', '/api/challenge');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, enc.encode(LOGIN_PREFIX + nonce));
    await api('POST', url, { nonce, signature: b64(sig), pin });
  }
  const doLogin = (pin) => signedPIN('/api/login', pin);

  function unlockView(note) {
    state.browsing = false;
    pinPad({
      title: 'Enter PIN',
      body: note || `Unlock ${state.laptop}.`,
      note: '5 wrong tries lock entry until you unlock it on the laptop',
      onDone: async (pin, pad) => {
        try {
          await doLogin(pin);
          return startBrowsing();
        } catch (e) {
          if (e.status === 423 || e.data?.locked) return lockedView();
          if (e.status === 403) return boot();
          if (e.status === 0) return offlineView();
          pad.fail(e.status === 401 ? wrongPIN(e.data.triesLeft) : sentence(e.message));
        }
      },
    });
  }

  // pinGate asks for the PIN again before a protected folder (iCloud Drive)
  // opens. It closes again when you leave it or after 2 minutes unused.
  function pinGate(loc) {
    state.loc = loc;
    const name = rootName(loc.root);
    pinPad({
      title: 'Enter PIN',
      body: [em(name), ' asks for your PIN every time you open it.'],
      note: 'it closes again when you leave it or after 2 minutes unused',
      extra: state.roots.length > 1 ? h('button', { class: 'btn link', type: 'button', text: 'Back to shared folders', onclick: () => go({ root: null, path: [] }) }) : null,
      status: { badge: true, tools: true },
      onDone: async (pin, pad) => {
        try {
          await signedPIN('/api/protected/open', pin);
          state.protectedOpen = true;
          render(loc, 'push');
        } catch (e) {
          if (e.status === 423 || e.data?.locked) return lockedView();
          if (e.status === 0) return offlineView();
          if (e.status === 403) return unlockView();
          pad.fail(e.status === 401 ? wrongPIN(e.data.triesLeft) : sentence(e.message));
        }
      },
    });
  }

  // ---------- browsing ----------
  async function startBrowsing() {
    let data;
    try {
      data = await api('GET', '/api/roots');
    } catch (e) {
      if (!handleErr(e)) offlineView();
      return;
    }
    state.laptop = data.laptop || state.laptop;
    savePref('laptop', state.laptop);
    state.roots = data.roots.filter((r) => r.available);
    state.browsing = true;
    const loc = state.roots.length === 1 ? { root: state.roots[0].id, path: [] } : { root: null, path: [] };
    history.replaceState(loc, '');
    render(loc, 'fade');
  }

  function handleErr(e) {
    if (e.status === 403 && e.data.needPIN && state.loc) { state.protectedOpen = false; pinGate(state.loc); return true; }
    if (e.status === 401) { unlockView('Locked after 15 minutes without use.'); return true; }
    if (e.status === 0) { offlineView(); return true; }
    if (e.status === 423) { lockedView(); return true; }
    return false;
  }

  const depth = (loc) => (loc.root == null ? 0 : 1 + loc.path.length);

  function go(loc, dir) {
    history.pushState(loc, '');
    render(loc, dir || (state.loc && depth(loc) < depth(state.loc) ? 'back' : 'push'));
  }

  window.addEventListener('popstate', (e) => {
    if (!state.browsing || !e.state) return;
    render(e.state, state.loc && depth(e.state) < depth(state.loc) ? 'back' : 'push');
  });

  function lock() {
    state.protectedOpen = false;
    api('POST', '/api/logout').catch(() => {});
    unlockView();
  }

  const isProtected = (id) => !!(state.roots.find((r) => r.id === id) || {}).protected;

  function closeProtected() {
    state.protectedOpen = false;
    api('POST', '/api/protected/close').catch(() => {});
  }

  function rootName(id) {
    const r = state.roots.find((x) => x.id === id);
    return r ? r.name : '';
  }

  function topBar(loc) {
    const segs = [{ icon: true, label: loc.root == null ? state.laptop : '', to: { root: null, path: [] } }];
    if (loc.root != null) {
      segs.push({ label: rootName(loc.root), to: { root: loc.root, path: [] } });
      loc.path.forEach((p, i) => segs.push({ label: p, to: { root: loc.root, path: loc.path.slice(0, i + 1) } }));
    }
    const crumbs = h('nav', { class: 'crumbs', 'aria-label': 'Folder path' });
    segs.forEach((s, i) => {
      const last = i === segs.length - 1;
      if (i) crumbs.append(icon('chevron-right', 14, 'crumb-sep'));
      crumbs.append(h('button', {
        class: 'crumb' + (last ? ' last fresh' : ''), type: 'button',
        'aria-label': s.icon && !s.label ? state.laptop : null, 'aria-current': last ? 'page' : null,
        onclick: () => { if (!last) go(s.to); },
      }, s.icon ? icon('laptop', 20) : null, s.label ? h('span', { text: s.label }) : null));
    });
    requestAnimationFrame(() => { crumbs.scrollLeft = crumbs.scrollWidth; });
    return h('header', { class: 'topbar' }, h('div', { class: 'topbar-row' }, crumbs,
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Search files', onclick: openSearch }, icon('search', 20))));
  }

  function render(loc, dir = 'push') {
    const prot = loc.root != null && isProtected(loc.root);
    if (!prot && state.protectedOpen) closeProtected();
    if (prot && !state.protectedOpen) return pinGate(loc);
    state.loc = loc;
    const atRoots = loc.root == null;
    const name = atRoots ? 'Shared folders' : loc.path.length ? loc.path[loc.path.length - 1] : rootName(loc.root);
    const list = h('div', { class: 'list' });
    const count = h('span');
    let entries = null;
    let animated = false;
    const put = (...nodes) => {
      list.replaceChildren(...nodes.flat());
      if (!animated && dir !== 'fade') list.classList.add(dir);
      animated = true;
    };
    const sortBtn = atRoots ? null : h('button', {
      class: 'sort-btn', type: 'button', 'aria-label': 'Sort order',
      text: state.sort === 'newest' ? 'newest' : 'A–Z',
      onclick: () => {
        state.sort = state.sort === 'newest' ? 'name' : 'newest';
        savePref('sort', state.sort);
        sortBtn.textContent = state.sort === 'newest' ? 'newest' : 'A–Z';
        if (entries) fill(entries);
      },
    });
    const fill = (items) => {
      const sorted = [...items].sort((a, b) => {
        if (a.dir !== b.dir) return a.dir ? -1 : 1;
        if (state.sort === 'newest') return b.mtime - a.mtime;
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
      });
      count.textContent = `${sorted.length} ${sorted.length === 1 ? 'item' : 'items'}`;
      if (!sorted.length) return put(emptyBlock('This folder is empty', [rootName(loc.root), ...loc.path].join('/')));
      put(sorted.map((e) => entryRow(e, () => (e.dir
        ? go({ root: loc.root, path: [...loc.path, e.name] }, 'push')
        : openViewer(loc.root, [...loc.path, e.name].join('/'), e)))));
    };

    show(topBar(loc),
      h('div', { class: 'xhead' }, h('span', { class: 'xhead-title', text: name }), h('span', { class: 'xhead-meta' }, count, sortBtn)),
      list,
      statusBar({ badge: true, tools: true }));

    if (atRoots) {
      count.textContent = String(state.roots.length);
      if (!state.roots.length) return put(emptyBlock('Nothing is shared yet', 'add folders in Remote Desk on your laptop'));
      return put(state.roots.map((r) => h('button', { class: 'row', type: 'button', onclick: () => go({ root: r.id, path: [] }, 'push') },
        icon('folder', 20, 'k-folder'),
        h('span', { class: 'row-name', text: r.name }),
        r.protected ? h('span', { class: 'row-meta' }, icon('lock', 13), 'PIN') : null,
        h('span', { class: 'row-end' }, icon('chevron-right', 14)))));
    }

    count.textContent = '…';
    const skel = setTimeout(() => put(skeleton()), 150);
    onLeave(() => clearTimeout(skel));
    api('GET', `/api/list?root=${loc.root}&path=${encodeURIComponent(loc.path.join('/'))}`)
      .then((d) => {
        clearTimeout(skel);
        if (state.loc !== loc) return;
        entries = d.entries;
        fill(entries);
        if (d.truncated) list.append(h('p', { class: 'list-note', text: 'showing the first 5,000 items · use search for the rest' }));
      })
      .catch((e) => {
        clearTimeout(skel);
        if (state.loc !== loc || handleErr(e)) return;
        count.textContent = '';
        put(emptyBlock(sentence(e.message), [rootName(loc.root), ...loc.path].join('/'), true));
      });
  }

  function skeleton() {
    return h('div', { class: 'skel', 'aria-hidden': 'true' }, Array.from({ length: 8 }, () =>
      h('div', { class: 'skel-row' }, h('span', { class: 'si' }), h('span', { class: 'sn' }), h('span', { class: 'sm' }))));
  }

  function emptyBlock(text, path, bad) {
    return h('div', { class: 'empty' },
      h('div', { class: 'empty-row' + (bad ? ' danger' : '') }, icon(bad ? 'warning' : 'folder-open', 20), h('span', { text })),
      path ? h('p', { class: 'empty-path', text: path }) : null);
  }

  const KIND_ICON = { folder: 'folder', image: 'image', video: 'video', audio: 'audio', pdf: 'file-pdf', text: 'file-text', code: 'file-code', archive: 'archive', other: 'file' };
  const CODE_EXT = new Set('js mjs ts tsx jsx go py rb rs java kt swift c h cc cpp hpp cs php sh zsh bash ps1 css scss html htm xml yaml yml toml json sql lua r m mm vue svelte'.split(' '));
  const ARCHIVE_EXT = new Set('zip rar 7z tar gz tgz bz2 xz dmg iso'.split(' '));
  const ext = (name) => (name.includes('.') ? name.split('.').pop().toLowerCase() : '');

  // kindOf picks the icon and its colour; the preview goes by e.kind.
  function kindOf(e) {
    if (e.dir) return 'folder';
    const x = ext(e.name);
    if (['image', 'video', 'audio', 'pdf'].includes(e.kind)) return e.kind;
    if (CODE_EXT.has(x)) return 'code';
    if (e.kind === 'text') return 'text';
    if (ARCHIVE_EXT.has(x)) return 'archive';
    return 'other';
  }
  const tint = (k) => 'k-' + (k === 'archive' ? 'other' : k);

  function entryRow(e, onclick) {
    const k = kindOf(e);
    return h('button', { class: 'row', type: 'button', onclick },
      icon(KIND_ICON[k], 20, tint(k)),
      h('span', { class: 'row-name', text: e.name }),
      e.dir ? null : h('span', { class: 'row-meta', text: size(e.size) }),
      h('span', { class: 'row-end' }, e.dir ? icon('chevron-right', 14) : h('span', { text: shortDate(e.mtime) })));
  }

  function size(n) {
    if (n == null) return '';
    if (n < 1024) return n + ' B';
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return (n >= 10 ? Math.round(n) : n.toFixed(1)) + ' ' + u[i];
  }

  function shortDate(ms) {
    if (!ms) return '';
    const d = new Date(ms);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    return String(d.getFullYear());
  }

  function clock(ms) {
    const d = new Date(ms);
    const t = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    return d.toDateString() === new Date().toDateString() ? t : `${shortDate(ms)} ${t}`;
  }

  const mmss = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  function duration(sec) {
    if (!isFinite(sec)) return '--:--';
    sec = Math.max(0, Math.floor(sec));
    const hrs = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = String(sec % 60).padStart(2, '0');
    return hrs ? `${hrs}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
  }

  // ---------- search (palette sheet) ----------
  function openSearch() {
    if (document.querySelector('.search')) return;
    const scrim = h('div', { class: 'scrim' });
    const input = h('input', {
      class: 'search-input', type: 'search', placeholder: 'Search file names', enterkeyhint: 'search',
      autocomplete: 'off', autocorrect: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Search file names',
    });
    const meta = h('span', { text: 'type 2 or more letters' });
    const results = h('div', { class: 'search-results', role: 'listbox', 'aria-label': 'Results' });
    const sheet = h('div', { class: 'search', role: 'dialog', 'aria-label': 'Search' },
      h('div', { class: 'search-input-row' }, icon('search', 18), input,
        h('button', { class: 'search-cancel', type: 'button', text: 'Cancel', onclick: () => close() })),
      h('div', { class: 'search-meta' }, meta, h('span', { text: 'all shared folders' })),
      results);
    let timer = 0;
    let seq = 0;
    const close = overlay([scrim, sheet], () => { clearTimeout(timer); seq++; });
    scrim.addEventListener('click', () => close());

    const pick = (r) => {
      close(true);
      if (r.dir) go({ root: r.root, path: r.path.split('/') }, 'push');
      else openViewer(r.root, r.path, r);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      results.querySelector('.result')?.click();
    });
    input.addEventListener('input', () => {
      clearTimeout(timer);
      const q = input.value.trim();
      const my = ++seq;
      if (q.length < 2) {
        meta.textContent = 'type 2 or more letters';
        results.replaceChildren();
        return;
      }
      timer = setTimeout(async () => {
        meta.textContent = 'searching…';
        try {
          const { results: found } = await api('GET', '/api/search?q=' + encodeURIComponent(q));
          if (my !== seq) return;
          meta.textContent = found.length >= 100 ? 'first 100 results' : `${found.length} ${found.length === 1 ? 'result' : 'results'}`;
          if (!found.length) return results.replaceChildren(h('div', { class: 'search-none', text: 'No file names match' }));
          results.replaceChildren(...found.map((r, i) => {
            const k = kindOf(r);
            const where = [r.rootName, ...r.path.split('/').slice(0, -1)].join('/');
            return h('button', { class: 'result' + (i === 0 ? ' sel' : ''), type: 'button', role: 'option', onclick: () => pick(r) },
              icon(KIND_ICON[k], 20, tint(k)),
              h('span', { class: 'result-text' }, h('span', { class: 'result-name' }, highlight(r.name, q)), h('span', { class: 'result-dir', text: where })));
          }));
        } catch (e) {
          if (my !== seq) return;
          if (!handleErr(e)) meta.textContent = sentence(e.message);
        }
      }, 250);
    });
    document.body.append(scrim, sheet);
    input.focus();
  }

  // highlight marks every place a word of the query appears in name.
  function highlight(name, q) {
    const lower = name.toLowerCase();
    const marks = new Array(name.length).fill(false);
    for (const w of q.toLowerCase().split(/\s+/).filter(Boolean)) {
      for (let i = lower.indexOf(w); i >= 0; i = lower.indexOf(w, i + 1)) marks.fill(true, i, i + w.length);
    }
    const out = [];
    let start = 0;
    for (let i = 1; i <= name.length; i++) {
      if (i < name.length && marks[i] === marks[start]) continue;
      const t = name.slice(start, i);
      out.push(marks[start] ? h('mark', { text: t }) : t);
      start = i;
    }
    return out;
  }

  // ---------- colour theme ----------
  function swatch(t) {
    const [editor, sidebar, , , border, , accent] = t.sw;
    const side = h('span', { class: 'side' });
    const acc = h('span', { class: 'acc' });
    const s = h('span', { class: 'swatch', 'aria-hidden': 'true' }, side, acc);
    s.style.background = editor;
    s.style.boxShadow = `inset 0 0 0 1px ${border}`;
    side.style.background = sidebar;
    side.style.borderRight = `1px solid ${border}`;
    acc.style.background = accent;
    return s;
  }

  function openThemeSheet() {
    const themes = window.RD.themes;
    const scrim = h('div', { class: 'scrim top' });
    const body = h('div', { class: 'sheet-body' });
    const sheet = h('div', { class: 'sheet', role: 'dialog', 'aria-label': 'Color theme' },
      h('div', { class: 'sheet-head' }, h('h2', { class: 'sheet-title', text: 'Color theme' }),
        h('button', { class: 'sheet-done', type: 'button', text: 'Done', onclick: () => close() })),
      body);
    const close = overlay([scrim, sheet]);
    scrim.addEventListener('click', () => close());
    const draw = () => {
      const cur = themes.saved();
      const check = (on) => h('span', { class: 'check' }, on ? icon('check', 18) : null);
      const pick = (id) => () => { themes.set(id); draw(); };
      const row = (t) => h('button', { class: 'th-row', type: 'button', 'aria-pressed': String(cur === t.id), onclick: pick(t.id) },
        swatch(t), h('span', { class: 'grow', text: t.name }), t.base ? h('span', { class: 'tag', text: 'default' }) : null, check(cur === t.id));
      body.replaceChildren(
        h('button', { class: 'th-row sys', type: 'button', 'aria-pressed': String(cur === 'system'), onclick: pick('system') },
          icon('theme', 20),
          h('span', { class: 'grow stack' }, h('span', { text: 'Follow system' }), h('span', { class: 'sub', text: 'Dark Modern · Light Modern' })),
          check(cur === 'system')),
        h('div', { class: 'th-group', text: 'DARK' }), ...themes.list.filter((t) => t.type === 'dark').map(row),
        h('div', { class: 'th-group', text: 'LIGHT' }), ...themes.list.filter((t) => t.type === 'light').map(row));
    };
    draw();
    document.body.append(scrim, sheet);
  }

  // ---------- preview (editor tab) ----------
  const TYPE = {
    md: 'Markdown', txt: 'Plain text', csv: 'CSV', json: 'JSON', log: 'Log', jpg: 'JPEG', jpeg: 'JPEG', png: 'PNG', gif: 'GIF',
    webp: 'WebP', heic: 'HEIC', mp4: 'MP4', mov: 'QuickTime', m4v: 'M4V', mp3: 'MP3', m4a: 'M4A', wav: 'WAV', pdf: 'PDF',
  };
  const LONG = {
    zip: 'ZIP archive', docx: 'Word document', doc: 'Word document', xlsx: 'Excel workbook', xls: 'Excel workbook',
    pptx: 'PowerPoint deck', ppt: 'PowerPoint deck', pages: 'Pages document', numbers: 'Numbers sheet', key: 'Keynote deck', dmg: 'Disk image',
  };
  const typeName = (name) => TYPE[ext(name)] || (ext(name) ? ext(name).toUpperCase() : 'File');
  const fileInfo = (e) => `${typeName(e.name)} · ${size(e.size)}`;

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
  const mimeFor = (name) => MIME[ext(name)] || 'application/octet-stream';

  function fileURL(root, rel) {
    return `/api/file?root=${root}&path=${encodeURIComponent(rel)}`;
  }

  // In the Home Screen app iOS has no back button, so a plain download link
  // takes over the whole app with no way back. There, files go through the
  // share sheet only (Save to Files, Open in Preview, AirDrop…).
  const standaloneIOS = isIOS && isStandalone;
  const canShareFiles = !!(navigator.share && navigator.canShare);

  function openViewer(root, rel, e) {
    const url = fileURL(root, rel);
    const dl = url + '&dl=1';
    const k = kindOf(e);
    const dirs = [rootName(root), ...rel.split('/').slice(0, -1)];
    const ctl = new AbortController();
    const objectURLs = [];

    const sbar = statusBar({ mono: true, label: fileInfo(e), tools: true });
    const sbLabel = sbar.querySelector('.sbar-label');
    let info = fileInfo(e);
    const setInfo = (t) => { info = t; sbLabel.textContent = t; };
    const prog = h('div', { class: 'progress', 'aria-hidden': 'true' }, h('span'));
    const ui = {
      progress: (pct) => { prog.firstChild.style.width = pct == null ? '0' : pct + '%'; },
      status: (t) => { sbLabel.textContent = t == null ? info : t; },
      toast,
      locked: (err) => locked(err),
    };
    const pv = h('div', { class: 'preview', role: 'dialog', 'aria-label': e.name });
    const close = overlay([pv], () => {
      ctl.abort();
      objectURLs.forEach((u) => URL.revokeObjectURL(u));
    });
    const locked = (err) => {
      close(true);
      if (err && err.needPIN && state.loc) {
        state.protectedOpen = false;
        return pinGate(state.loc);
      }
      unlockView('Locked after 15 minutes without use.');
    };

    // One fetch feeds both the share sheet and (for images, video, audio)
    // the preview. PDFs and text keep their own preview request.
    const inlineKinds = ['image', 'video', 'audio'];
    const eager = standaloneIOS && canShareFiles && e.size <= PREFETCH_LIMIT;
    const load = loader(inlineKinds.includes(e.kind) ? url : dl, e, ctl.signal);
    const save = saver(e, dl, load, eager, ui);

    const useBlob = eager && inlineKinds.includes(e.kind);
    const setSrc = (el) => {
      if (!useBlob) { el.src = url; return; }
      load.start().then((f) => {
        const u = URL.createObjectURL(f);
        objectURLs.push(u);
        el.src = u;
      }).catch((err) => {
        if (err.needPIN || err.locked) return locked(err);
        if (err.name !== 'AbortError') el.src = url;
      });
    };

    let body;
    switch (e.kind) {
      case 'text': body = textPreview(url, e, setInfo, ctl.signal, locked); break;
      case 'image': body = imagePreview(e, setSrc); break;
      case 'video': body = mediaPreview('video', e, setSrc, setInfo); break;
      case 'audio': body = mediaPreview('audio', e, setSrc, setInfo); break;
      case 'pdf': body = h('div', { class: 'pv-pdf' }, h('iframe', { src: url, title: e.name })); break;
      default: body = otherPreview(e, k, save);
    }

    pv.append(
      h('div', { class: 'tabs' }, h('div', { class: 'tabs-row' },
        h('div', { class: 'tab' },
          icon(KIND_ICON[k], 16, tint(k)),
          h('span', { class: 'tab-name', text: e.name }),
          h('button', { class: 'tab-close', type: 'button', 'aria-label': 'Close preview', onclick: () => close() }, icon('close', 14))),
        h('button', { class: 'tab-dl', type: 'button', 'aria-label': save.label, onclick: save.run }, icon('download', 20)))),
      h('div', { class: 'pathline' },
        h('span', { class: 'pathline-text' }, h('span', { class: 'pathline-dir', text: dirs.join(' › ') + ' › ' }), h('span', { text: e.name })),
        h('span', { class: 'badge', text: 'READ-ONLY' })),
      prog,
      h('div', { class: 'pv-body' }, body),
      sbar);
    document.body.append(pv);
  }

  function textPreview(url, e, setInfo, signal, locked) {
    const wrap = h('div', { class: 'pv-text' }, h('p', { class: 'pv-loading', text: 'loading…' }));
    fetch(url, { credentials: 'same-origin', headers: { Range: `bytes=0-${TEXT_LIMIT - 1}` }, signal })
      .then((r) => {
        if (r.status === 401) throw Object.assign(new Error('locked'), { locked: true });
        if (r.status === 403) throw Object.assign(new Error('pin'), { needPIN: true });
        if (!r.ok) throw new Error('Error ' + r.status);
        return r.text();
      })
      .then((t) => {
        const more = e.size > TEXT_LIMIT;
        const lines = t.split('\n');
        if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
        const gutter = h('pre', { class: 'gutter', 'aria-hidden': 'true', text: lines.map((_, i) => i + 1).join('\n') });
        gutter.style.width = `calc(${String(lines.length).length}ch + 14px)`;
        const cur = h('div', { class: 'curline' });
        const code = h('div', { class: 'code' }, cur, gutter, h('pre', { class: 'lines', text: lines.join('\n') }));
        code.addEventListener('click', (ev) => {
          const n = Math.floor((ev.clientY - code.getBoundingClientRect().top) / 20);
          cur.style.top = Math.max(0, Math.min(lines.length - 1, n)) * 20 + 'px';
        });
        wrap.replaceChildren(code);
        setInfo(`${typeName(e.name)} · ${lines.length}${more ? '+' : ''} lines · ${more ? 'first 256 KB' : size(e.size)}`);
      })
      .catch((err) => {
        if (err.name === 'AbortError') return;
        if (err.locked || err.needPIN) return locked(err);
        wrap.replaceChildren(h('p', { class: 'pv-loading', text: 'couldn’t load a preview · use Download' }));
      });
    return wrap;
  }

  function imagePreview(e, setSrc) {
    const img = h('img', { alt: e.name, decoding: 'async' });
    const chip = h('span', { class: 'chip br', text: 'fit' });
    const wrap = h('div', { class: 'pv-media' }, img, chip);
    img.addEventListener('load', () => {
      if (img.naturalWidth) chip.textContent = `fit · ${Math.max(1, Math.round((img.clientWidth / img.naturalWidth) * 100))}%`;
    });
    img.addEventListener('error', () => {
      if (img.getAttribute('src')) wrap.replaceChildren(h('p', { class: 'pv-loading', text: 'couldn’t show this image · use Download' }));
    });
    setSrc(img);
    return wrap;
  }

  // mediaPreview is the video and audio player: one scrubber, play/pause,
  // speed, and full screen for video.
  function mediaPreview(kind, e, setSrc, setInfo) {
    const video = kind === 'video';
    const media = h(kind, { preload: 'metadata', playsinline: true, 'webkit-playsinline': true });
    const scrub = h('input', { class: 'scrub', type: 'range', min: '0', max: '1000', step: '1', value: '0', 'aria-label': 'Position' });
    const cur = h('span', { text: '0:00' });
    const end = h('span', { text: '--:--' });
    const playBtns = [];
    const playBtn = (cls, size) => {
      const b = h('button', { class: cls, type: 'button', 'aria-label': 'Play', onclick: toggle }, icon('play', size));
      playBtns.push([b, size]);
      return b;
    };
    const speeds = [1, 1.5, 2, 0.5];
    let si = 0;
    const speedLabel = (s) => (video ? s + '×' : s.toFixed(1) + '×');
    const speedBtn = h('button', { class: 'ctl text' + (video ? '' : ' ghost'), type: 'button', 'aria-label': 'Playback speed', text: speedLabel(1) });
    speedBtn.addEventListener('click', () => {
      si = (si + 1) % speeds.length;
      media.playbackRate = speeds[si];
      speedBtn.textContent = speedLabel(speeds[si]);
    });
    let wrap;
    function toggle() {
      if (media.paused) media.play().catch(() => {});
      else media.pause();
    }
    const sync = () => {
      const d = media.duration;
      const t = media.currentTime;
      const p = isFinite(d) && d > 0 ? t / d : 0;
      if (!scrub.matches(':active')) scrub.value = String(Math.round(p * 1000));
      scrub.style.setProperty('--p', p * 100 + '%');
      cur.textContent = duration(t);
      end.textContent = isFinite(d) ? (video ? duration(d) : '-' + duration(d - t)) : '--:--';
    };
    const playing = () => {
      wrap.classList.toggle('playing', !media.paused);
      for (const [b, size] of playBtns) {
        b.replaceChildren(icon(media.paused ? 'play' : 'pause', size));
        b.setAttribute('aria-label', media.paused ? 'Play' : 'Pause');
      }
    };
    scrub.addEventListener('input', () => {
      const d = media.duration;
      if (isFinite(d)) media.currentTime = (Number(scrub.value) / 1000) * d;
      scrub.style.setProperty('--p', Number(scrub.value) / 10 + '%');
    });
    media.addEventListener('timeupdate', sync);
    media.addEventListener('play', playing);
    media.addEventListener('pause', playing);
    media.addEventListener('ended', playing);
    media.addEventListener('error', () => { if (media.getAttribute('src')) toast('This phone can’t play this file. Use Download instead.', 'danger'); });
    const chip = video ? h('span', { class: 'chip', text: 'video' }) : null;
    media.addEventListener('loadedmetadata', () => {
      sync();
      setInfo(`${typeName(e.name)} · ${duration(media.duration)} · ${size(e.size)}`);
      if (chip && media.videoWidth) chip.textContent = `video · ${media.videoWidth} × ${media.videoHeight}`;
    });
    const times = h('div', { class: 'times' }, cur, end);
    if (video) {
      media.addEventListener('click', toggle);
      const full = h('button', { class: 'ctl', type: 'button', 'aria-label': 'Full screen' }, icon('maximize', 20));
      full.addEventListener('click', () => {
        if (media.webkitEnterFullscreen) media.webkitEnterFullscreen();
        else media.requestFullscreen?.();
      });
      wrap = h('div', { class: 'pv-video' },
        h('div', { class: 'vframe' }, media, chip, playBtn('bigplay', 24)),
        h('div', { class: 'controls' }, scrub, times,
          h('div', { class: 'ctl-row' }, playBtn('ctl', 20), speedBtn, h('span', { class: 'grow' }), full)));
    } else {
      wrap = h('div', { class: 'pv-audio' },
        h('div', { class: 'audio-tile' }, icon('audio', 40)),
        h('p', { class: 'audio-name', text: e.name }),
        h('p', { class: 'audio-sub', text: [typeName(e.name), size(e.size), shortDate(e.mtime)].filter(Boolean).join(' · ') }),
        scrub, times,
        h('div', { class: 'ctl-row' }, playBtn('ctl play', 24), speedBtn),
        media);
    }
    setSrc(media);
    return wrap;
  }

  function otherPreview(e, k, save) {
    const x = ext(e.name);
    const kind = LONG[x] || (x ? `${x.toUpperCase()} file` : 'File');
    return h('div', { class: 'pv-other' }, h('div', { class: 'dl-card' },
      h('div', { class: 'dl-head' },
        h('span', { class: 'dl-tile' }, icon(KIND_ICON[k], 24)),
        h('div', { class: 'stack' }, h('span', { class: 'dl-name', text: e.name }), h('span', { class: 'sub', text: [kind, size(e.size), shortDate(e.mtime)].filter(Boolean).join(' · ') }))),
      h('p', { class: 'dl-note', text: 'No preview for this file type.' }),
      button('Download', save.run, 'primary', 'download'),
      h('p', { class: 'dl-sub', text: save.sub })));
  }

  // loader fetches a whole file once (shared by the preview and the share
  // sheet) and reports progress. A failed fetch can be retried.
  function loader(src, e, signal) {
    let p = null;
    let progress = () => {};
    const start = () => (p ||= (async () => {
      const res = await fetch(src, { credentials: 'same-origin', signal });
      if (res.status === 401) throw Object.assign(new Error('locked'), { locked: true });
      if (res.status === 403) throw Object.assign(new Error('pin'), { needPIN: true });
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

  // saver is what Download does: a normal download in Safari, the share
  // sheet (Save to Files, AirDrop, other apps) in the Home Screen app.
  function saver(e, dl, load, eager, ui) {
    if (!standaloneIOS) {
      return {
        label: 'Download',
        sub: isIOS ? 'saves to Files › Downloads' : 'saves to your Downloads folder',
        run: () => {
          const a = h('a', { href: dl, download: e.name });
          document.body.append(a);
          a.click();
          a.remove();
        },
      };
    }
    const sub = 'opens the share sheet · Save to Files';
    if (!canShareFiles || e.size > SHARE_LIMIT) {
      const why = e.size > SHARE_LIMIT
        ? 'This file is over 300 MB, too big to save from the Home Screen app. Open Remote Desk in Safari instead.'
        : 'This phone can’t save files from the Home Screen app. Open Remote Desk in Safari instead.';
      return { label: 'Download', sub, run: () => ui.toast(why, 'danger') };
    }
    let file = null;
    let busy = false;
    let unsupported = false;
    load.onProgress((pct) => {
      ui.progress(pct);
      ui.status(`getting file… ${pct}%`);
    });
    const ready = (f) => {
      ui.progress(null);
      ui.status(null);
      if (navigator.canShare({ files: [f] })) file = f;
      else unsupported = true;
    };
    const fail = (err) => {
      if (err.name === 'AbortError') return;
      if (err.locked || err.needPIN) return ui.locked(err);
      ui.progress(null);
      ui.status(null);
      ui.toast('Couldn’t get the file. Check the connection and try again.', 'danger');
    };
    const share = async () => {
      try {
        await navigator.share({ files: [file] });
      } catch (err) {
        if (err.name === 'NotAllowedError') ui.toast('Ready. Tap Download again.');
        else if (err.name !== 'AbortError') ui.toast('Sharing didn’t work. Try again.', 'danger');
      }
    };
    if (eager) load.start().then(ready, fail);
    return {
      label: 'Download',
      sub,
      run: async () => {
        if (unsupported) return ui.toast('This phone can’t share this type of file.', 'danger');
        if (file) return share();
        if (busy) return;
        busy = true;
        try {
          ready(await load.start());
          if (file) await share(); // after a long fetch iOS may want a second tap
          else ui.toast('This phone can’t share this type of file.', 'danger');
        } catch (err) {
          fail(err);
        } finally {
          busy = false;
        }
      },
    };
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  boot();
})();
