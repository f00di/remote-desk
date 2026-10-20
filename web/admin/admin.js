// Remote Desk admin page (this computer only). Polls /api/status and
// re-renders the dynamic parts. Device and file names are set as text.
'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  let last = null;
  let stopped = false;
  let folders = [];

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

  // replaceChildren would print "null" for empty slots.
  const put = (box, ...nodes) => box.replaceChildren(...nodes.filter(Boolean));
  const btn = (label, onclick, cls = 'primary') => h('button', { class: 'btn ' + cls, type: 'button', onclick, text: label });
  const ago = (t) => {
    if (!t) return 'never';
    const s = (Date.now() - new Date(t).getTime()) / 1000;
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + ' min ago';
    if (s < 86400) return Math.floor(s / 3600) + ' h ago';
    return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  };

  async function act(fn) {
    try {
      await fn();
    } catch (e) {
      alert(e.message);
    }
    refresh();
  }

  // ---------- Tailscale ----------
  function renderConn(s) {
    const t = s.tailscale;
    const box = $('conn');
    if (s.dev) {
      put(box, h('p', { class: 'ok', text: 'Skipped in dev mode.' }));
      return;
    }
    if (t.state === 'NeedsLogin' || t.state === 'NoState') {
      put(box, 
        h('p', { text: 'Sign this computer in to your Tailscale account. Use the same account you sign in with on your iPhone.' }),
        t.authURL
          ? h('a', { class: 'btn primary', href: t.authURL, target: '_blank', rel: 'noopener', text: 'Sign in to Tailscale' })
          : h('p', { class: 'muted', text: 'Getting a sign-in link…' }),
        h('p', { class: 'muted small', text: 'No account yet? The link lets you create one for free with Apple, Google, Microsoft or GitHub.' }));
      return;
    }
    if (t.state === 'NeedsMachineAuth') {
      put(box, h('p', { text: 'Approve this device in the Tailscale admin console (Machines).' }),
        h('a', { class: 'btn quiet', href: 'https://login.tailscale.com/admin/machines', target: '_blank', rel: 'noopener', text: 'Open Machines' }));
      return;
    }
    if (t.state !== 'Running') {
      put(box, h('p', { class: 'muted', text: `Starting Tailscale… (${t.state})` }));
      return;
    }
    if (!t.magicDNS || !t.https) {
      put(box, 
        h('p', { text: 'One setting left in Tailscale, so the phone gets a secure (HTTPS) address:' }),
        h('ol', { class: 'steps' },
          h('li', null, 'Open the DNS page of the Tailscale admin console.'),
          !t.magicDNS ? h('li', null, 'Turn on ', h('strong', { text: 'MagicDNS' }), '.') : null,
          h('li', null, 'Under HTTPS Certificates, click ', h('strong', { text: 'Enable HTTPS' }), '.')),
        h('a', { class: 'btn primary', href: 'https://login.tailscale.com/admin/dns', target: '_blank', rel: 'noopener', text: 'Open Tailscale DNS settings' }),
        h('p', { class: 'muted small', text: 'This page updates by itself once it is on. Note: HTTPS puts this computer’s Tailscale name (' + (t.dnsName || 'rd-…') + ') in public certificate logs; it’s a random name on purpose.' }));
      return;
    }
    if (!t.serving) {
      put(box, h('p', { class: 'muted', text: 'Getting the HTTPS certificate… ' + (t.error || '') }));
      return;
    }
    put(box, 
      h('p', { class: 'ok', text: 'Connected as ' + (t.user || 'your account') + '.' }),
      h('p', { class: 'muted small' }, 'Phone address: ', h('code', { text: s.siteURL })),
      h('p', { class: 'muted small', text: 'Tip: in the Tailscale admin console (Machines), choose “Disable key expiry” for ' + t.dnsName.split('.')[0] + ', or it signs out after 180 days.' }));
  }

  // ---------- phone ----------
  function renderPhone(s) {
    const box = $('phone');
    const d = s.auth.device;
    if (d) {
      put(box, 
        h('div', { class: 'device' },
          h('div', null,
            h('p', { class: 'device-name', text: d.label }),
            h('p', { class: 'muted small', text: `Tailscale device ${d.nodeName}${d.os ? ' (' + d.os + ')' : ''} · paired ${ago(d.pairedAt)} · last used ${ago(d.lastSeen)}` })),
          d.locked ? h('span', { class: 'pill warn', text: 'Locked' }) : h('span', { class: 'pill ok', text: 'Paired' })),
        d.locked ? h('p', { text: 'Locked after 5 wrong tries on the phone.' }) : null,
        h('div', { class: 'row-actions' },
          d.locked ? btn('Unlock', () => act(() => api('POST', '/api/unlock'))) : null,
          btn('Unpair', () => {
            if (confirm(`Unpair “${d.label}”? It will stop working until you pair it again.`)) act(() => api('POST', '/api/unpair'));
          }, 'danger')),
        h('p', { class: 'muted small', text: 'Lost the phone? Unpair it here, and remove it from your Tailscale account too.' }));
      return;
    }

    const ready = s.siteURL && (s.dev || (s.tailscale.serving));
    if (!ready) {
      put(box, h('p', { class: 'muted', text: 'Finish step 1 first.' }));
      return;
    }
    const p = s.auth.pairing;
    const reqs = (p && p.requests) || [];
    const parts = [];
    if (reqs.length) {
      for (const r of reqs) {
        parts.push(h('div', { class: 'request' },
          h('p', { class: 'device-name', text: `Pairing request: “${r.label}”` }),
          h('p', { class: 'muted small', text: `Tailscale device ${r.nodeName}${r.os ? ' (' + r.os + ')' : ''}${r.user ? ' · ' + r.user : ''}` }),
          h('p', { class: 'small', text: 'Only approve if this is your phone and you just asked to pair it.' }),
          h('div', { class: 'row-actions' },
            btn('Approve', () => act(() => api('POST', '/api/pair/approve', { id: r.id }))),
            btn('Deny', () => act(() => api('POST', '/api/pair/deny', { id: r.id })), 'quiet'))));
      }
      put(box, ...parts);
      return;
    }

    const steps = h('ol', { class: 'steps' },
      s.dev ? null : h('li', null, 'On your iPhone, install the free ', h('strong', { text: 'Tailscale' }), ' app, sign in with the same account and switch it on.'),
      h('li', null, 'Scan this code with the iPhone camera. In Safari, tap Share → ', h('strong', { text: 'Add to Home Screen' }), '.'),
      h('li', null, 'Open Remote Desk from the Home Screen, then show the pairing code below and type it there.'));
    const qr = s.siteQR ? h('figure', { class: 'qr' }, h('img', { src: s.siteQR, alt: 'QR code for ' + s.siteURL, width: '220', height: '220' }), h('figcaption', null, h('code', { text: s.siteURL }))) : null;
    const codeBox = h('div', { class: 'code-box' });
    if (p && p.code) {
      const left = Math.max(0, Math.round((new Date(p.expires).getTime() - Date.now()) / 1000));
      codeBox.append(
        h('p', { class: 'muted small', text: 'Pairing code' }),
        h('p', { class: 'code', text: p.code }),
        h('p', { class: 'muted small', 'data-expires': p.expires, text: `Works once · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` }),
        btn('Cancel', () => act(() => api('POST', '/api/pair/cancel')), 'quiet'));
    } else {
      codeBox.append(btn('Show pairing code', () => act(() => api('POST', '/api/pair/start'))));
    }
    put(box, h('div', { class: 'pair-grid' }, h('div', null, steps, codeBox), qr));
  }

  // ---------- folders ----------
  function renderFolders(s) {
    folders = s.roots || [];
    $('folders').replaceChildren(...folders.map((f, i) => h('li', null,
      h('div', { class: 'folder-main' },
        h('p', { class: 'device-name', text: f.name }),
        h('p', { class: 'muted small mono', text: f.path })),
      f.available ? null : h('span', { class: 'pill warn', text: 'Not found' }),
      btn('Remove', () => {
        if (!confirm(`Stop sharing “${f.name}”?`)) return;
        act(() => api('POST', '/api/roots', { roots: folders.filter((_, j) => j !== i).map(({ name, path }) => ({ name, path })) }));
      }, 'quiet small'))));
    if (!folders.length) $('folders').append(h('li', { class: 'muted', text: 'Nothing is shared.' }));
  }

  $('add-folder').addEventListener('submit', async (e) => {
    e.preventDefault();
    const path = $('f-path').value.trim();
    const name = $('f-name').value.trim();
    $('folder-error').textContent = '';
    if (!path) return ($('folder-error').textContent = 'Type the full path of a folder on this computer.');
    try {
      await api('POST', '/api/roots', { roots: [...folders.map(({ name, path }) => ({ name, path })), { name, path }] });
      $('f-path').value = '';
      $('f-name').value = '';
    } catch (err) {
      $('folder-error').textContent = err.message;
    }
    refresh();
  });

  $('quit').addEventListener('click', async () => {
    if (!confirm('Quit Remote Desk? Your phone won’t reach this computer until you open it again.')) return;
    try {
      await api('POST', '/api/quit');
    } catch (e) {
      return alert(e.message);
    }
    stopped = true;
    document.body.replaceChildren(h('main', { id: 'main' }, h('section', { class: 'card' },
      h('h2', { text: 'Remote Desk has quit' }),
      h('p', { class: 'muted', text: 'Open Remote Desk from your Applications folder to start it again.' }))));
  });

  $('keep-awake').addEventListener('change', (e) => act(() => api('POST', '/api/keepawake', { enabled: e.target.checked })));

  function renderActivity(s) {
    const items = s.activity || [];
    $('activity').replaceChildren(...(items.length ? items.map((a) => h('li', null,
      h('time', { datetime: a.time, text: new Date(a.time).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) }),
      h('span', { class: 'act-event', text: a.event }),
      a.detail ? h('span', { class: 'muted act-detail', text: a.detail }) : null)) : [h('li', { class: 'muted', text: 'Nothing yet.' })]));
  }

  function renderOverall(s) {
    const pill = $('overall');
    const t = s.tailscale;
    let text = 'Setting up';
    let cls = 'pill warn';
    if (s.auth.device && (s.dev || t.serving)) { text = s.auth.device.locked ? 'Locked' : 'Ready'; cls = s.auth.device.locked ? 'pill warn' : 'pill ok'; }
    else if (s.dev || t.serving) text = 'Pair your phone';
    else if (t.state === 'NeedsLogin') text = 'Sign in needed';
    pill.className = cls;
    pill.textContent = text;
  }

  function render(s) {
    $('laptop').textContent = s.laptop;
    $('dev-banner').hidden = !s.dev;
    if (s.dev) {
      $('dev-link').textContent = s.siteURL;
      $('dev-link').href = s.siteURL;
    }
    renderOverall(s);
    renderConn(s);
    renderPhone(s);
    // Don't redraw the folder list while someone is typing a new folder.
    if (!document.activeElement || !$('add-folder').contains(document.activeElement)) renderFolders(s);
    $('keep-awake').checked = s.keepAwake.enabled;
    $('keep-awake').disabled = !s.keepAwake.supported || s.dev;
    renderActivity(s);
    $('quit-card').hidden = !s.canQuit;
  }

  async function refresh() {
    if (stopped) return;
    try {
      const s = await api('GET', '/api/status');
      const key = JSON.stringify({ ...s, activity: s.activity.length && s.activity[0].time });
      if (key !== last) {
        last = key;
        render(s);
      }
    } catch (e) {
      $('overall').className = 'pill warn';
      $('overall').textContent = 'Not running';
    }
  }

  // Countdown text between polls.
  setInterval(() => {
    const el = document.querySelector('[data-expires]');
    if (!el) return;
    const left = Math.max(0, Math.round((new Date(el.dataset.expires).getTime() - Date.now()) / 1000));
    el.textContent = left ? `Works once · ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left` : 'Expired';
  }, 1000);

  refresh();
  setInterval(refresh, 2000);
})();
