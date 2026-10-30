// multiclaude dashboard. Plain ES modules, no build step.
import { attachLiquidGlass } from './liquid-lens.js';

const TOKEN = document.querySelector('meta[name="mc-token"]').content;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)');
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ html helpers

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
class Raw { constructor(s) { this.s = s; } }
const raw = (s) => new Raw(s);
/** Tagged template that escapes every value unless it is raw() or an array of html. */
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    if (v instanceof Raw) out += v.s;
    else if (Array.isArray(v)) out += v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('');
    else if (v === false || v === null || v === undefined) out += '';
    else out += esc(v);
    out += strings[i + 1];
  });
  return raw(out);
}

// ------------------------------------------------------------------ api

async function get(path) {
  const r = await fetch(path, { cache: 'no-store' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`);
  return r.json();
}
async function post(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mc-token': TOKEN }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

// ------------------------------------------------------------------ formatting

const SERIES = 6;
const colorVar = (slot) => `var(--s${((slot ?? 0) % SERIES + SERIES) % SERIES})`;
const pct = (n) => (n == null ? '—' : `${Math.round(n)}%`);
const money = (n) => (n >= 1000 ? `$${(n / 1000).toFixed(1)}k` : n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
function tokens(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}
function untilText(ms) {
  if (!ms) return '';
  const m = Math.max(0, Math.round((ms - Date.now()) / 60000));
  if (m < 1) return 'resets now';
  if (m < 60) return `resets in ${m}m`;
  if (m < 60 * 24) return `resets in ${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  return `resets ${new Date(ms).toLocaleDateString([], { weekday: 'short' })} ${new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
}
function ago(iso) {
  const t = typeof iso === 'number' ? iso : Date.parse(iso);
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 2) return 'yesterday';
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}
const tildePath = (p) => (p || '').replace(/^\/Users\/[^/]+/, '~');
const modelName = (m) => {
  const x = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-|$)/.exec(m || '');
  return x ? `${x[1][0].toUpperCase()}${x[1].slice(1)} ${x[2]}${x[3] ? `.${x[3]}` : ''}` : m;
};

// ------------------------------------------------------------------ motion helpers

/** Count a number from its old value to its new one: numbers roll instead of jumping. */
function roll(el, to, fmt, from) {
  const start = from ?? Number(el.dataset.v ?? to);
  el.dataset.v = String(to);
  if (REDUCED.matches || start === to || !Number.isFinite(start)) return void (el.textContent = fmt(to));
  const t0 = performance.now();
  const dur = 520;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - (1 - k) ** 3;
    el.textContent = fmt(start + (to - start) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** FLIP: let elements travel to their new places instead of jumping. */
function flip(container, mutate) {
  const items = [...container.children];
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect().top]));
  mutate();
  if (REDUCED.matches) return;
  for (const el of container.children) {
    const prev = before.get(el);
    if (prev === undefined || el.classList.contains('dragging')) continue;
    const dy = prev - el.getBoundingClientRect().top;
    if (!dy) continue;
    el.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(0.2, 0, 0, 1)' });
  }
}

/** Inline confirmation by the control that changed: a check that draws itself, then fades. */
function saved(anchor, text = 'Saved') {
  if (!anchor) return;
  anchor.querySelector('.saved')?.remove();
  const s = document.createElement('span');
  s.className = 'saved';
  s.innerHTML = `<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>${esc(text)}`;
  s.setAttribute('role', 'status');
  anchor.appendChild(s);
  setTimeout(() => s.classList.add('out'), 1600);
  setTimeout(() => s.remove(), 1900);
}

function toast(text, kind = '') {
  const wrap = $('#toasts');
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = text;
  wrap.appendChild(t);
  while (wrap.children.length > 3) wrap.firstElementChild.remove();
  setTimeout(() => t.classList.add('out'), kind === 'err' ? 6000 : 3600);
  setTimeout(() => t.remove(), kind === 'err' ? 6200 : 3800);
}

/** Run an async action on a button: spinner while it runs, a short check when it worked. */
async function busy(btn, fn) {
  if (btn.disabled) return;
  const w = btn.offsetWidth;
  const label = btn.innerHTML;
  btn.style.minWidth = `${w}px`;
  btn.disabled = true;
  btn.innerHTML = '<span class="spinner" aria-hidden="true"></span><span class="sr-only">Working</span>';
  try {
    const r = await fn();
    btn.innerHTML = '<svg class="ok-check" viewBox="0 0 16 16" width="15" height="15" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg>';
    setTimeout(() => { btn.innerHTML = label; btn.disabled = false; btn.style.minWidth = ''; }, 900);
    return r;
  } catch (e) {
    btn.innerHTML = label;
    btn.disabled = false;
    btn.style.minWidth = '';
    toast(e.message, 'err');
    throw e;
  }
}

// ------------------------------------------------------------------ segmented control

/** A soft track with one thumb that slides to the selected option. */
function segHtml(name, options, value, extraClass = '') {
  return html`<div class="seg seg-inline ${extraClass}" role="radiogroup" data-seg="${name}">
    <span class="seg-thumb" aria-hidden="true"></span>
    ${options.map(([v, label]) => html`<button type="button" role="radio" data-value="${v}" aria-checked="${String(v) === String(value)}" aria-pressed="${String(v) === String(value)}">${label}</button>`)}
  </div>`;
}
function placeThumb(seg, animate = true) {
  const thumb = seg.querySelector('.seg-thumb');
  const on = seg.querySelector('[aria-pressed="true"], [aria-selected="true"], [aria-current="page"]');
  if (!thumb || !on) return;
  if (!animate) thumb.style.transition = 'none';
  thumb.style.left = `${on.offsetLeft}px`;
  thumb.style.width = `${on.offsetWidth}px`;
  if (!animate) requestAnimationFrame(() => (thumb.style.transition = ''));
}
function placeAllThumbs(root = document, animate = false) {
  $$('.seg, .tabbar', root).forEach((s) => placeThumb(s, animate));
}
function selectSeg(seg, value) {
  $$('[data-value]', seg).forEach((b) => {
    const on = b.dataset.value === String(value);
    b.setAttribute('aria-pressed', String(on));
    b.setAttribute('aria-checked', String(on));
  });
  placeThumb(seg);
}

// ------------------------------------------------------------------ select (no native dropdown)

/** A button that opens a small list in the same popover as the account menus. Looks the same on every OS. */
function selectHtml(name, options, value, label) {
  const current = options.find(([v]) => String(v) === String(value)) ?? options[0];
  return html`<button type="button" class="select-btn" data-select="${name}" data-value="${current?.[0] ?? ''}" aria-haspopup="listbox" aria-expanded="false" aria-label="${label}">
    <span class="select-label">${current?.[1] ?? ''}</span>
    <svg viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><path d="M3 4.5l3-3 3 3M3 7.5l3 3 3-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>`;
}
const selectOptions = new Map();

function openSelect(btn) {
  closeMenus();
  const name = btn.dataset.select;
  const options = selectOptions.get(name) ?? [];
  const menu = document.createElement('div');
  menu.className = 'menu select-menu';
  menu.setAttribute('role', 'listbox');
  menu.setAttribute('aria-label', btn.getAttribute('aria-label'));
  menu.style.minWidth = `${Math.max(160, btn.offsetWidth)}px`;
  menu.innerHTML = options.map(([v, l]) => html`<button role="option" type="button" data-opt="${v}" aria-selected="${String(v) === btn.dataset.value}">
    <svg class="tick" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true"><path d="M3.5 8.5l3 3 6-7"/></svg><span>${l}</span></button>`.s).join('');
  document.body.appendChild(menu);
  menu.anchor = btn;
  placeMenu(menu);
  btn.setAttribute('aria-expanded', 'true');
  (menu.querySelector('[aria-selected="true"]') ?? menu.querySelector('button'))?.focus();
  menu.addEventListener('click', (e) => {
    const o = e.target.closest('[data-opt]');
    if (!o) return;
    const v = o.dataset.opt;
    closeMenus();
    btn.focus();
    if (v === btn.dataset.value) return;
    btn.dataset.value = v;
    btn.querySelector('.select-label').textContent = o.textContent.trim();
    if (name === 'defaultProfile') patchConfig({ defaultProfile: v }, slotNear(btn));
  });
  menu.addEventListener('keydown', (e) => {
    const items = [...menu.querySelectorAll('[data-opt]')];
    const i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    if (e.key === 'Tab') closeMenus();
  });
}

// ------------------------------------------------------------------ app state

let state = null;
let prevProfiles = new Map();
let page = 'accounts';
const visited = new Set();
let dragging = false;

async function loadState() {
  try {
    const s = await get('/api/state');
    setState(s);
  } catch (e) {
    renderOffline(e);
  }
}

function setState(s) {
  const old = state;
  state = s;
  if (old) prevProfiles = new Map(old.profiles.map((p) => [p.name, p]));
  if (page === 'accounts' && !dragging) renderAccounts();
  if (page === 'settings' && !document.activeElement?.closest('#page-settings')) renderSettings();
  $('#start-auto').textContent = s.pick.name ? `Start on ${s.pick.name}` : 'Start session';
}

function renderOffline(e) {
  const el = $('#page-accounts');
  if (state) return toast(`Lost touch with the multiclaude service: ${e.message}`, 'err');
  el.innerHTML = html`<div class="card empty"><b>The multiclaude service isn't answering</b>Run <code>mc start</code> in a terminal, then reload this page.</div>`.s;
}

// ------------------------------------------------------------------ accounts

function statusOf(p) {
  if (!p.info.loggedIn) return ['bad', 'Signed out'];
  if (p.paused) return ['', 'Paused'];
  if (p.fallback.active) return ['pay', 'On API key'];
  if (p.usage.limited) return ['bad', 'Limit reached'];
  if (p.peak !== undefined && p.peak >= p.switchAt) return ['bad', 'Full'];
  if (state.pick.name === p.name) return ['pick', 'Next pick'];
  if (p.peak !== undefined && p.peak >= p.switchAt - 15) return ['warn', 'Getting full'];
  return ['ok', 'Ready'];
}

function meterHtml(label, w, switchAt, key) {
  if (!w) return html`<div class="meter-block"><div class="meter-top"><span>${label}</span><span class="faint">no reading yet</span></div><div class="meter"><i style="width:0"></i></div></div>`;
  const tone = w.pct >= switchAt ? 'bad' : w.pct >= switchAt - 15 ? 'warn' : 'ok';
  return html`<div class="meter-block"><div class="meter-top"><span>${label} <b class="tnum" data-roll="${key}" data-to="${w.pct}">${pct(w.pct)}</b></span><span class="faint">${untilText(w.resetsAt)}</span></div>
    <div class="meter ${tone}" role="meter" aria-label="${label} used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(w.pct)}"><i data-w="${Math.min(100, w.pct)}" data-key="${key}"></i><em style="left:${switchAt}%" title="Switch at ${switchAt}%"></em></div></div>`;
}

function acctHtml(p) {
  const [tone, word] = statusOf(p);
  const prev = prevProfiles.get(p.name);
  const reset = prev && prev.peak !== undefined && prev.peak >= prev.switchAt && (p.peak ?? 0) < p.switchAt && !p.paused;
  const who = p.info.loggedIn ? [p.info.email, p.info.plan].filter(Boolean).join(' · ') : 'Not signed in yet';
  const models = Object.entries(p.usage.models ?? {}).filter(([, w]) => w && w.pct > 0);
  return html`
    <button class="handle" type="button" data-drag="${p.name}" aria-label="Move ${p.name}, position ${p.position} of ${state.profiles.length}. Use the up and down arrow keys." title="Drag to reorder">
      <span class="pos tnum">${p.position}</span>
      <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><g fill="currentColor"><circle cx="2.5" cy="3" r="1.4"/><circle cx="7.5" cy="3" r="1.4"/><circle cx="2.5" cy="8" r="1.4"/><circle cx="7.5" cy="8" r="1.4"/><circle cx="2.5" cy="13" r="1.4"/><circle cx="7.5" cy="13" r="1.4"/></g></svg>
    </button>
    <div class="acct-id">
      <div class="acct-name"><span class="swatch" style="--c:${raw(colorVar(p.color))}"></span><span class="n">${p.name}</span>${p.label ? html`<span class="chip">${p.label}</span>` : ''}</div>
      <div class="acct-who">${who}</div>
      <div class="acct-tags"><span class="status ${tone}">${reset ? 'Ready again' : word}</span>${p.switchAt !== state.switchAt ? html`<span class="chip">switch at ${p.switchAt}%</span>` : ''}</div>
    </div>
    <div class="meters">
      ${p.info.loggedIn ? html`${meterHtml('5-hour', p.usage.fiveHour, p.switchAt, `${p.name}-5h`)}${meterHtml('Weekly', p.usage.sevenDay, p.switchAt, `${p.name}-wk`)}
        ${models.length ? html`<div class="meter-models">${models.map(([k, w]) => html`<span>${k[0].toUpperCase() + k.slice(1)} week ${pct(w.pct)}</span>`)}</div>` : ''}`
      : html`<div class="empty-meter">Sign in to see usage. It opens a browser window from a new Terminal.</div>`}
    </div>
    <div class="acct-actions">
      ${p.info.loggedIn
        ? html`<button class="btn btn-small" type="button" data-act="start" data-name="${p.name}" aria-label="Start a session on ${p.name}"><svg class="nudge" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M5 3l6 5-6 5z" fill="currentColor"/></svg><span class="btn-start-label">Start</span></button>`
        : html`<button class="btn btn-small btn-primary" type="button" data-act="login" data-name="${p.name}">Sign in</button>`}
      <div class="menu-wrap">
        <button class="icon-btn" type="button" data-act="menu" data-name="${p.name}" aria-haspopup="menu" aria-expanded="false" aria-label="More for ${p.name}">
          <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><g fill="currentColor"><circle cx="6" cy="12" r="1.7"/><circle cx="12" cy="12" r="1.7"/><circle cx="18" cy="12" r="1.7"/></g></svg>
        </button>
      </div>
    </div>`;
}

function briefingHtml() {
  const s = state;
  const pick = s.profiles.find((p) => p.name === s.pick.name);
  const withRoom = s.pick.ranked.filter((r) => r.room).length;
  const total = s.profiles.filter((p) => !p.paused).length;
  let title;
  let sub;
  if (pick) {
    const w = (pick.usage.fiveHour?.pct ?? 0) >= (pick.usage.sevenDay?.pct ?? 0) ? pick.usage.fiveHour : pick.usage.sevenDay;
    title = html`${pick.name}${pick.peak !== undefined ? html` <span class="muted">· ${pct(pick.peak)} used${w?.resetsAt ? ` · ${untilText(w.resetsAt)}` : ''}</span>` : ''}`;
    sub = `${withRoom} of ${total} account${total === 1 ? '' : 's'} ${withRoom === 1 ? 'has' : 'have'} room · ${s.pick.reason}`;
  } else {
    title = html`No account has room right now`;
    const soonest = s.profiles.map((p) => [p.usage.fiveHour?.resetsAt, p.name]).filter(([t]) => t).sort((a, b) => a[0] - b[0])[0];
    sub = soonest ? `${soonest[1]} ${untilText(soonest[0])}.${s.fallback.enabled ? ' Open sessions continue on your API key.' : ''}` : s.pick.reason;
  }
  const fb = s.fallback;
  const fbChip = fb.enabled
    ? html`<a class="chip" href="#settings"><span class="status pay"></span>API key ${fb.hasKey ? `${money(fb.spentToday)} of $${fb.dailyCapUsd} today` : 'missing'}</a>`
    : html`<a class="chip" href="#settings">API fallback off</a>`;
  return html`<div class="card hero rise">
    <div class="grow">
      <div class="hero-kicker">Next session goes to</div>
      <div class="hero-title">${title}</div>
      <div class="hero-sub">${sub}</div>
    </div>
    <button class="btn btn-primary btn-lg" type="button" data-act="start-auto" ${pick ? '' : raw('disabled')}>${pick ? `Start on ${pick.name}` : 'Nothing has room'}</button>
    <div class="hero-controls">
      <span class="ctl-label">Pick</span>
      ${segHtml('pick', [['priority', 'First with room'], ['most-room', 'Most room left']], s.pickMode)}
      <span class="ctl-label">Switch at</span>
      <div class="stepper" data-stepper="switchAt"><button type="button" aria-label="Lower the switch-at level">−</button><output class="tnum">${s.switchAt}%</output><button type="button" aria-label="Raise the switch-at level">+</button></div>
      <span class="saved-slot" data-saved="hero"></span>
      <span class="grow"></span>
      ${fbChip}
    </div>
  </div>`;
}

function renderAccounts() {
  const root = $('#page-accounts');
  const s = state;
  const first = !root.querySelector('.accounts');
  if (first) {
    root.innerHTML = html`
      <div class="page-head"><div class="grow"><h1 id="h-accounts">Accounts</h1><p>In priority order. Drag to change who goes first.</p></div><span class="saved-slot" data-saved="order"></span></div>
      <div id="briefing"></div>
      <div class="section-title">Your accounts</div>
      <div class="accounts scroll-room" id="acct-list"></div>
      <div class="acct-api" id="api-row"></div>
      <div class="section-title">Add an account</div>
      <form class="card add-card" id="add-form" autocomplete="off">
        <input class="field" name="name" placeholder="Name, e.g. work or max2" pattern="[a-z0-9][a-z0-9_-]{0,31}" required aria-label="Account name" style="width:220px">
        <input class="field" name="label" placeholder="Note (optional)" aria-label="Note" style="width:220px">
        <button class="btn" type="submit">Add and sign in</button>
        <span class="muted add-hint">Opens Terminal to sign in. It joins the end of your order.</span>
      </form>`.s;
  }
  $('#briefing').innerHTML = briefingHtml().s;
  placeAllThumbs($('#briefing'));

  const list = $('#acct-list');
  const oldWidths = new Map($$('.meter > i', list).map((i) => [i.dataset.key, i.style.width]));
  const oldNums = new Map($$('[data-roll]', list).map((b) => [b.dataset.roll, Number(b.dataset.v ?? b.dataset.to)]));
  const byName = new Map($$('.acct', list).map((el) => [el.dataset.name, el]));

  flip(list, () => {
    for (const p of s.profiles) {
      let el = byName.get(p.name);
      if (!el) {
        el = document.createElement('article');
        el.className = 'acct';
        el.dataset.name = p.name;
      }
      byName.delete(p.name);
      el.classList.toggle('paused', p.paused);
      const prev = prevProfiles.get(p.name);
      const reset = prev && prev.peak !== undefined && prev.peak >= prev.switchAt && (p.peak ?? 0) < p.switchAt;
      el.innerHTML = acctHtml(p).s;
      if (reset && !REDUCED.matches) {
        el.classList.remove('shine');
        void el.offsetWidth;
        el.classList.add('shine');
      }
      list.appendChild(el);
    }
    for (const el of byName.values()) el.remove();
  });

  // Bars glide from where they were; numbers roll.
  for (const i of $$('.meter > i', list)) {
    const from = oldWidths.get(i.dataset.key) ?? '0%';
    i.style.width = from;
    requestAnimationFrame(() => requestAnimationFrame(() => (i.style.width = `${i.dataset.w}%`)));
  }
  for (const b of $$('[data-roll]', list)) roll(b, Number(b.dataset.to), (n) => `${Math.round(n)}%`, oldNums.get(b.dataset.roll) ?? 0);

  const fb = s.fallback;
  $('#api-row').innerHTML = html`
    <span class="pos-api" aria-hidden="true"><svg viewBox="0 0 24 24" width="18" height="18"><path d="M14.5 4.5a5 5 0 0 0-4.6 6.9L4 17.3V20h2.7l.8-.8V17.5h1.8v-1.8h1.8l1.3-1.3a5 5 0 1 0 2.1-9.9z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/><circle cx="15.5" cy="8.5" r="1.3" fill="currentColor"/></svg></span>
    <div>
      <div class="row-title">API key <span class="muted">· pay as you go</span></div>
      <div class="row-sub">${fb.enabled ? (fb.hasKey ? `Takes over a session only when its plan runs out. ${money(fb.spentToday)} of $${fb.dailyCapUsd} used today.` : 'Fallback is on but no key is saved yet.') : 'Off. Turn it on to keep a session going when its plan runs out.'}</div>
    </div>
    <div class="acct-actions">
      <span class="status ${fb.enabled && fb.hasKey ? 'pay' : ''}">${fb.enabled ? (fb.hasKey ? 'On' : 'Needs a key') : 'Off'}</span>
      <a class="btn btn-small" href="#settings">Set up</a>
    </div>`.s;
}

function openMenu(btn, name) {
  closeMenus();
  const p = state.profiles.find((x) => x.name === name);
  const i = state.profiles.indexOf(p);
  const menu = document.createElement('div');
  menu.className = 'menu';
  menu.setAttribute('role', 'menu');
  menu.innerHTML = html`
    <button role="menuitem" data-m="start">Start a session</button>
    <button role="menuitem" data-m="login">Sign in again</button>
    <hr>
    <button role="menuitem" data-m="up" ${i === 0 ? raw('disabled') : ''}>Move up</button>
    <button role="menuitem" data-m="down" ${i === state.profiles.length - 1 ? raw('disabled') : ''}>Move down</button>
    <button role="menuitem" data-m="pause">${p.paused ? 'Use when picking' : 'Pause (skip when picking)'}</button>
    <div class="menu-row"><span>Switch at</span><div class="stepper small"><button type="button" data-m="sw-">−</button><output class="tnum">${p.switchAt}%</output><button type="button" data-m="sw+">+</button></div></div>
    <button role="menuitem" data-m="label">${p.label ? 'Change note' : 'Add a note'}</button>
    ${name !== 'main' ? html`<hr><button role="menuitem" class="danger" data-m="remove">Remove ${name}…</button>` : ''}`.s;
  // On the page itself, not inside the card, so no card or scroll box can clip it.
  document.body.appendChild(menu);
  menu.anchor = btn;
  placeMenu(menu);
  btn.setAttribute('aria-expanded', 'true');
  menu.querySelector('button:not([disabled])')?.focus();
  menu.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    const m = b.dataset.m;
    try {
      if (m === 'start') { closeMenus(); return launch({ profile: name }); }
      if (m === 'login') { closeMenus(); return launch({ profile: name, mode: 'login' }, `Opened Terminal to sign in to ${name}`); }
      if (m === 'up' || m === 'down') { closeMenus(); return moveBy(name, m === 'up' ? -1 : 1); }
      if (m === 'pause') { closeMenus(); setState(await post(`/api/profiles/${name}`, { paused: !p.paused })); return saved($('[data-saved="order"]'), p.paused ? `${name} is back in the order` : `${name} paused`); }
      if (m === 'sw-' || m === 'sw+') {
        const out = b.parentElement.querySelector('output');
        const n = Math.max(10, Math.min(100, parseInt(out.textContent, 10) + (m === 'sw+' ? 5 : -5)));
        out.textContent = `${n}%`;
        debounce(`sw-${name}`, async () => { setState(await post(`/api/profiles/${name}`, { switchAt: n })); saved($('[data-saved="order"]'), `${name} switches at ${n}%`); }, 400);
        return;
      }
      if (m === 'label') return editLabel(menu, name, p.label);
      if (m === 'remove') return confirmRemove(menu, name);
    } catch (err) { toast(err.message, 'err'); }
  });
}

/** Put a menu under its button, right-aligned; flip above when there's no room below. */
function placeMenu(menu) {
  const r = menu.anchor.getBoundingClientRect();
  const h = menu.offsetHeight;
  const w = menu.offsetWidth;
  const below = innerHeight - r.bottom - 12;
  const top = below >= h || r.top < h + 12 ? Math.min(r.bottom + 6, innerHeight - h - 12) : r.top - h - 6;
  menu.style.top = `${Math.max(12, top)}px`;
  menu.style.left = `${Math.max(12, Math.min(r.right - w, innerWidth - w - 12))}px`;
  menu.style.transformOrigin = top < r.top ? 'bottom right' : 'top right';
}

function editLabel(menu, name, current) {
  requestAnimationFrame(() => placeMenu(menu));
  menu.innerHTML = html`<form class="menu-form"><label class="muted" for="lbl">Note for ${name}</label><input id="lbl" class="field" maxlength="40" value="${current ?? ''}" placeholder="e.g. Team Max"><div class="menu-actions"><button type="button" class="btn btn-small" data-cancel>Cancel</button><button class="btn btn-small btn-primary">Save</button></div></form>`.s;
  const f = menu.querySelector('form');
  f.querySelector('input').focus();
  f.querySelector('[data-cancel]').onclick = closeMenus;
  f.onsubmit = async (e) => {
    e.preventDefault();
    try { setState(await post(`/api/profiles/${name}`, { label: f.querySelector('input').value.trim() })); closeMenus(); saved($('[data-saved="order"]')); } catch (err) { toast(err.message, 'err'); }
  };
}

function confirmRemove(menu, name) {
  // Safe option first: keeping the account is the default.
  requestAnimationFrame(() => placeMenu(menu));
  menu.innerHTML = html`<div class="menu-form"><b>Remove ${name}?</b><span class="muted">Its login is deleted from the Keychain. Shared history and settings stay.</span><div class="menu-actions"><button type="button" class="btn btn-small" data-keep>Keep</button><button type="button" class="btn btn-small btn-danger-fill" data-go>Remove</button></div></div>`.s;
  menu.querySelector('[data-keep]').focus();
  menu.querySelector('[data-keep]').onclick = closeMenus;
  menu.querySelector('[data-go]').onclick = async (e) => {
    try { await busy(e.currentTarget, () => post(`/api/profiles/${name}/remove`).then(setState)); closeMenus(); toast(`Removed ${name}`); } catch { /* toast shown */ }
  };
}

function closeMenus() {
  $$('.menu').forEach((m) => m.remove());
  $$('[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}

const timers = new Map();
function debounce(key, fn, ms) {
  clearTimeout(timers.get(key));
  timers.set(key, setTimeout(() => fn().catch((e) => toast(e.message, 'err')), ms));
}

async function saveOrder(order) {
  const s = await post('/api/profiles/order', { order });
  setState(s);
  saved($('[data-saved="order"]'), 'Order saved');
}

function moveBy(name, delta) {
  const order = state.profiles.map((p) => p.name);
  const i = order.indexOf(name);
  const j = i + delta;
  if (j < 0 || j >= order.length) return;
  [order[i], order[j]] = [order[j], order[i]];
  // Move the card now so it travels; the server confirms after.
  const list = $('#acct-list');
  const el = list.querySelector(`[data-name="${CSS.escape(name)}"]`);
  const other = list.querySelector(`[data-name="${CSS.escape(order[i])}"]`);
  if (el && other) flip(list, () => (delta < 0 ? list.insertBefore(el, other) : list.insertBefore(other, el)));
  return saveOrder(order).then(() => list.querySelector(`[data-name="${CSS.escape(name)}"] .handle`)?.focus());
}

/** Drag a card by its handle; the others slide out of the way. Works with mouse, pen and touch. */
function startDrag(e, handle) {
  const list = $('#acct-list');
  const card = handle.closest('.acct');
  const startY = e.clientY;
  let moved = false;
  handle.setPointerCapture(e.pointerId);
  const onMove = (ev) => {
    const dy = ev.clientY - startY;
    if (!moved && Math.abs(dy) < 4) return;
    if (!moved) { moved = true; dragging = true; card.classList.add('dragging'); }
    const cards = [...list.children].filter((c) => c !== card);
    const y = ev.clientY;
    let before = null;
    for (const c of cards) {
      const r = c.getBoundingClientRect();
      if (y < r.top + r.height / 2) { before = c; break; }
    }
    // The card takes its new slot as you drag; the others slide out of its way.
    if (card.nextElementSibling !== before) flip(list, () => list.insertBefore(card, before));
  };
  const onUp = () => {
    handle.removeEventListener('pointermove', onMove);
    handle.removeEventListener('pointerup', onUp);
    handle.removeEventListener('pointercancel', onUp);
    if (!moved) return;
    card.classList.remove('dragging');
    dragging = false;
    const order = [...list.children].map((c) => c.dataset.name);
    if (order.join() !== state.profiles.map((p) => p.name).join()) saveOrder(order).catch((err) => toast(err.message, 'err'));
  };
  handle.addEventListener('pointermove', onMove);
  handle.addEventListener('pointerup', onUp);
  handle.addEventListener('pointercancel', onUp);
}

async function launch(body, msg) {
  try {
    const r = await post('/api/launch', body);
    toast(msg || `Opened Terminal on ${body.profile === 'auto' ? state.pick.name : body.profile}`);
    return r;
  } catch (e) {
    toast(e.message, 'err');
  }
}

// ------------------------------------------------------------------ sessions

let sessions = [];
let sessFilter = 'all';
let sessQuery = '';
let openSession = null;
let sessShown = 30;

async function renderSessions() {
  const root = $('#page-sessions');
  if (!root.querySelector('#sess-list')) {
    root.innerHTML = html`
      <div class="page-head"><div class="grow"><h1 id="h-sessions">Sessions</h1><p>Recent conversations on every account. Open one to continue it somewhere else.</p></div></div>
      <div class="toolbar">
        <label class="search"><svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M11 11l3 3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg><input class="field" type="search" placeholder="Search titles and folders" aria-label="Search sessions" id="sess-q"></label>
        <div id="sess-seg"></div>
      </div>
      <div class="group" id="sess-list"><div class="skeleton" style="height:260px"></div></div>`.s;
    $('#sess-q').addEventListener('input', (e) => { sessQuery = e.target.value.toLowerCase(); drawSessions(); });
  }
  const accounts = state ? state.profiles.map((p) => [p.name, p.name]) : [];
  $('#sess-seg').innerHTML = segHtml('sess', [['all', 'All'], ...accounts], sessFilter).s;
  placeAllThumbs($('#sess-seg'));
  try {
    sessions = await get('/api/sessions?limit=60');
    drawSessions();
  } catch (e) {
    $('#sess-list').innerHTML = html`<div class="empty"><b>Couldn't read sessions</b>${e.message}</div>`.s;
  }
}

function drawSessions() {
  const list = $('#sess-list');
  const shown = sessions.filter((s) => (sessFilter === 'all' || s.profile === sessFilter) && (!sessQuery || `${s.title} ${s.cwd ?? ''}`.toLowerCase().includes(sessQuery)));
  if (!sessions.length) return void (list.innerHTML = html`<div class="empty"><b>No sessions yet</b>Start one with <code>mc</code> and it shows up here.</div>`.s);
  if (!shown.length) return void (list.innerHTML = html`<div class="empty"><b>Nothing matches</b>Try another search or account.</div>`.s);
  const color = (name) => colorVar(state?.profiles.find((p) => p.name === name)?.color);
  const more = shown.length > sessShown;
  list.innerHTML = shown.slice(0, sessShown).map((s) => html`
    <div class="sess" data-id="${s.id}">
      <button class="row sess-row" type="button" data-open="${s.id}" aria-expanded="${openSession === s.id}">
        <div class="grow">
          <div class="sess-title">${s.title}</div>
          <div class="sess-meta"><span class="path">${tildePath(s.cwd) || s.project}${s.branch && s.branch !== 'HEAD' ? ` · ${s.branch}` : ''}</span></div>
        </div>
        <span class="acct-chip"><span class="swatch" style="--c:${raw(color(s.profile))}"></span>${s.profile}</span>
        <span class="faint tnum when">${ago(s.updatedAt)}</span>
        <svg class="chev" viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <div class="sess-panel" ${openSession === s.id ? '' : raw('hidden')}></div>
    </div>`.s).join('') + (more ? html`<div class="more-row"><button class="btn btn-plain btn-small" type="button" data-more>Show ${Math.min(30, shown.length - sessShown)} more</button></div>`.s : '');
  if (openSession) {
    const el = list.querySelector(`[data-id="${CSS.escape(openSession)}"] .sess-panel`);
    if (el) fillPanel(el, shown.find((x) => x.id === openSession));
  }
}

async function fillPanel(panel, s) {
  const others = state.profiles.filter((p) => p.info.loggedIn);
  const suggested = state.pick.ranked.find((r) => r.room && r.name !== s.profile)?.name ?? others.find((p) => p.name !== s.profile)?.name ?? s.profile;
  panel.innerHTML = html`<div class="panel-inner"><div class="skeleton" style="height:18px;width:60%"></div></div>`.s;
  let info = null;
  try { info = await get(`/api/handover/${s.id}?from=${encodeURIComponent(s.profile)}&to=${encodeURIComponent(suggested)}`); } catch { /* summary is optional */ }
  const h = info?.handover;
  const facts = h ? [`${h.recent.length + (h.goal ? 1 : 0)} requests`, `${h.files.length} files changed`, h.todos.length ? `${h.todos.filter((t) => t.status !== 'completed').length} open todos` : null].filter(Boolean).join(' · ') : '';
  panel.innerHTML = html`<div class="panel-inner">
    ${h?.goal ? html`<p class="goal">${h.goal.slice(0, 260)}${h.goal.length > 260 ? '…' : ''}</p>` : ''}
    ${facts ? html`<div class="muted small">${facts} · last run on ${s.profile}</div>` : ''}
    <div class="panel-row"><span class="ctl-label">Continue on</span>${segHtml('to', others.map((p) => [p.name, p.name]), suggested)}</div>
    <div class="panel-row" role="radiogroup" aria-label="How to continue">
      <label class="radio"><input type="radio" name="how-${s.id}" value="resume" checked><span class="dot" aria-hidden="true"></span><span><b>Same chat</b> <span class="muted">the whole conversation carries over</span></span></label>
      <label class="radio"><input type="radio" name="how-${s.id}" value="handover"><span class="dot" aria-hidden="true"></span><span><b>Fresh, with a note</b> <span class="muted">a short summary instead of the full context</span></span></label>
    </div>
    <div class="panel-actions">
      <button class="btn btn-plain" type="button" data-preview>Preview note</button>
      <span class="grow"></span>
      <span class="muted small">Close the old window first if it's still open.</span>
      <button class="btn btn-primary" type="button" data-continue>Continue on ${suggested}</button>
    </div>
    <pre class="note-preview" hidden></pre>
  </div>`.s;
  placeAllThumbs(panel);
  const seg = panel.querySelector('[data-seg="to"]');
  const go = panel.querySelector('[data-continue]');
  let to = suggested;
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('[data-value]');
    if (!b) return;
    to = b.dataset.value;
    selectSeg(seg, to);
    go.textContent = `Continue on ${to}`;
  });
  panel.querySelector('[data-preview]').onclick = async (e) => {
    const pre = panel.querySelector('.note-preview');
    if (!pre.hidden) { pre.hidden = true; e.currentTarget.textContent = 'Preview note'; return; }
    const r = await get(`/api/handover/${s.id}?from=${encodeURIComponent(s.profile)}&to=${encodeURIComponent(to)}`).catch((err) => ({ markdown: err.message }));
    pre.textContent = r.markdown;
    pre.hidden = false;
    e.currentTarget.textContent = 'Hide note';
  };
  go.onclick = (e) => {
    const how = panel.querySelector(`input[name="how-${s.id}"]:checked`).value;
    busy(e.currentTarget, () => post('/api/launch', { profile: to, sessionId: s.id, cwd: s.cwd, mode: how })).then(() => toast(how === 'resume' ? `Opened "${s.title.slice(0, 40)}" on ${to}` : `Started fresh on ${to} with a handover note`)).catch(() => {});
  };
}

// ------------------------------------------------------------------ stats

let statsDays = 30;

async function renderStats() {
  const root = $('#page-stats');
  if (!root.querySelector('#stats-body')) {
    root.innerHTML = html`
      <div class="page-head"><div class="grow"><h1 id="h-stats">Stats</h1><p>From Claude Code's session files on this Mac. "API value" is what the same tokens would cost on the API; your plans aren't billed per token.</p></div><div id="range-seg"></div></div>
      <div id="stats-body"><div class="tiles">${[1, 2, 3, 4].map(() => raw('<div class="tile skeleton" style="height:92px"></div>'))}</div><div class="card skeleton" style="height:280px"></div></div>`.s;
  }
  $('#range-seg').innerHTML = segHtml('range', [['7', '7 days'], ['30', '30 days'], ['90', '90 days']], String(statsDays)).s;
  placeAllThumbs($('#range-seg'));
  let r;
  try {
    r = await get(`/api/stats?days=${statsDays}`);
  } catch (e) {
    $('#stats-body').innerHTML = html`<div class="card empty"><b>Couldn't build stats</b>${e.message}</div>`.s;
    return;
  }
  drawStats(r);
}

function drawStats(r) {
  const body = $('#stats-body');
  const profiles = state?.profiles ?? [];
  const slot = (name) => profiles.find((p) => p.name === name)?.color ?? profiles.length;
  const names = [...new Set([...profiles.map((p) => p.name), ...r.byProfile.map((x) => x.key)])].filter((n) => r.byProfile.some((x) => x.key === n));
  const spend = Object.entries(r.spend?.days ?? {}).filter(([d]) => d >= r.days[0]?.day).reduce((a, [, v]) => a + v.total, 0);
  if (!r.totals.msgs) {
    body.innerHTML = html`<div class="card empty"><b>No usage in the last ${r.rangeDays} days</b>Stats fill in as you use Claude Code.</div>`.s;
    return;
  }
  body.innerHTML = html`
    <div class="tiles">
      <div class="tile"><div class="k">API value</div><div class="v" data-n="${r.totals.cost}" data-f="money">$0</div><div class="d">${spend > 0 ? `${money(spend)} actually billed to your API key` : 'nothing billed to your API key'}</div></div>
      <div class="tile"><div class="k">Tokens</div><div class="v" data-n="${r.totals.tokens}" data-f="tokens">0</div><div class="d">input, output and cache</div></div>
      <div class="tile"><div class="k">Replies</div><div class="v" data-n="${r.totals.msgs}" data-f="int">0</div><div class="d">from Claude</div></div>
      <div class="tile"><div class="k">Sessions</div><div class="v" data-n="${r.totals.sessions}" data-f="int">0</div><div class="d">with activity</div></div>
    </div>
    <div class="card chart-card">
      <div class="chart-head"><h2>API value per day</h2>
        <div class="legend">${names.map((n) => html`<span><span class="swatch" style="--c:${raw(colorVar(slot(n)))}"></span>${n}</span>`)}</div></div>
      <div id="chart"></div>
      <button class="btn btn-plain btn-small table-toggle" type="button" data-table>Show as a table</button>
      <div class="table-scroll" hidden id="chart-table"></div>
    </div>
    <div class="splits">
      ${splitHtml('By account', r.byProfile, (k) => colorVar(slot(k)), (k) => k)}
      ${splitHtml('By model', r.byModel, () => 'rgb(255 255 255 / 0.8)', modelName)}
      ${splitHtml('By project', r.byProject, () => 'rgb(255 255 255 / 0.8)', (k) => k)}
    </div>`.s;
  const fmts = { money, tokens, int: (n) => Math.round(n).toLocaleString() };
  for (const v of $$('.tile .v', body)) roll(v, Number(v.dataset.n), fmts[v.dataset.f], 0);
  for (const i of $$('.share .bar i', body)) {
    const w = i.dataset.w;
    i.style.width = '0';
    requestAnimationFrame(() => requestAnimationFrame(() => (i.style.width = `${w}%`)));
  }
  drawChart($('#chart'), r, names, slot);
  body.querySelector('[data-table]').onclick = (e) => {
    const t = $('#chart-table');
    t.hidden = !t.hidden;
    e.currentTarget.textContent = t.hidden ? 'Show as a table' : 'Hide the table';
    if (!t.hidden) t.innerHTML = html`<table class="data-table"><thead><tr><th>Day</th>${names.map((n) => html`<th>${n}</th>`)}<th>Total</th></tr></thead><tbody>${r.days.slice().reverse().map((d) => html`<tr><td>${d.day}</td>${names.map((n) => html`<td>${money(d.byProfile[n] ?? 0)}</td>`)}<td>${money(d.cost)}</td></tr>`)}</tbody></table>`.s;
  };
}

function splitHtml(title, rows, colorOf, labelOf) {
  const total = rows.reduce((a, r) => a + r.cost, 0) || 1;
  return html`<div class="card split"><h3>${title}</h3>${rows.slice(0, 6).map((r) => html`
    <div class="share"><span class="lbl"><span>${labelOf(r.key)}</span></span><span class="val">${money(r.cost)} · ${Math.round((r.cost / total) * 100)}%</span>
    <span class="bar"><i data-w="${(r.cost / total) * 100}" style="--c:${raw(colorOf(r.key))}"></i></span></div>`)}</div>`;
}

/** Stacked daily bars: one column per day, one segment per account, 2px gaps, rounded data end. */
function drawChart(host, r, names, slot) {
  const W = Math.max(320, host.clientWidth || 900);
  const H = 220;
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const days = r.days;
  const max = Math.max(...days.map((d) => d.cost), 0.01);
  const nice = niceMax(max);
  const cw = (W - pad.l - pad.r) / days.length;
  const bw = Math.max(3, Math.min(22, cw - Math.max(2, cw * 0.28)));
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / nice);
  const ticks = [0, nice / 2, nice];
  const labelEvery = Math.ceil(days.length / 8);
  let cols = '';
  days.forEach((d, i) => {
    const x = pad.l + i * cw + (cw - bw) / 2;
    let acc = 0;
    let segs = '';
    const parts = names.map((n) => [n, d.byProfile[n] ?? 0]).filter(([, v]) => v > 0);
    parts.forEach(([n, v], k) => {
      const y0 = y(acc);
      const y1 = y(acc + v);
      acc += v;
      const h = Math.max(0, y0 - y1 - (k < parts.length - 1 ? 2 : 0));
      const top = k === parts.length - 1;
      segs += top
        ? `<path class="seg-fill" fill="${colorVar(slot(n))}" d="${roundTop(x, y1, bw, Math.max(h, 1), Math.min(4, bw / 2))}"/>`
        : `<rect class="seg-fill" fill="${colorVar(slot(n))}" x="${x}" y="${y1 + 2}" width="${bw}" height="${h}"/>`;
    });
    cols += `<g class="col" data-i="${i}"><rect class="hit" x="${pad.l + i * cw}" y="${pad.t}" width="${cw}" height="${H - pad.t - pad.b}"/><g class="bars" style="--d:${Math.min(i, 30) * 12}ms">${segs}</g></g>`;
  });
  const grid = ticks.map((t) => `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(t)}" y2="${y(t)}"/>`).join('');
  const yLabels = ticks.map((t) => `<text x="${pad.l - 8}" y="${y(t) + 3.5}" text-anchor="end">${t === 0 ? '$0' : money(t)}</text>`).join('');
  // Label every Nth day, and the last one only when it won't collide with the one before it.
  const showLabel = (i) => i % labelEvery === 0 || (i === days.length - 1 && i % labelEvery >= labelEvery / 2);
  const xLabels = days.map((d, i) => (showLabel(i) ? `<text x="${pad.l + i * cw + cw / 2}" y="${H - 6}" text-anchor="middle">${esc(shortDay(d.day))}</text>` : '')).join('');
  const first = !visited.has('chart-drawn');
  host.innerHTML = `<svg class="chart ${first && !REDUCED.matches ? 'draw' : ''}" viewBox="0 0 ${W} ${H}" role="img" aria-label="API value per day, stacked by account"><g class="grid">${grid}</g><g class="axis">${yLabels}${xLabels}</g>${cols}</svg>`;
  visited.add('chart-drawn');
  const tip = $('#tooltip');
  host.querySelector('svg').addEventListener('pointermove', (e) => {
    const g = e.target.closest('.col');
    $$('.col.hover', host).forEach((c) => c !== g && c.classList.remove('hover'));
    if (!g) return void (tip.hidden = true);
    g.classList.add('hover');
    const d = days[Number(g.dataset.i)];
    tip.innerHTML = html`<div class="t">${new Date(`${d.day}T12:00`).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })}</div>${names.filter((n) => d.byProfile[n]).map((n) => html`<div class="r"><span><span class="swatch" style="--c:${raw(colorVar(slot(n)))}"></span>${n}</span><span class="tnum">${money(d.byProfile[n])}</span></div>`)}<div class="r"><span>Total</span><span class="tnum">${money(d.cost)}</span></div>`.s;
    tip.hidden = false;
    const tx = Math.min(innerWidth - tip.offsetWidth - 12, e.clientX + 14);
    tip.style.left = `${tx}px`;
    tip.style.top = `${e.clientY - tip.offsetHeight - 12}px`;
  });
  host.querySelector('svg').addEventListener('pointerleave', () => {
    tip.hidden = true;
    $$('.col.hover', host).forEach((c) => c.classList.remove('hover'));
  });
}

function roundTop(x, y, w, h, r) {
  r = Math.min(r, h);
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  for (const m of [1, 2, 2.5, 5, 10]) if (m * p >= v) return m * p;
  return 10 * p;
}
const shortDay = (d) => new Date(`${d}T12:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });

// ------------------------------------------------------------------ activity

let actFilter = 'all';
const ACT_KIND = {
  switch: ['Switches', 'var(--blue)', '<path d="M4 8h13l-3-3M20 16H7l3 3"/>'],
  launch: ['Switches', 'var(--label-2)', '<path d="M8 5l10 7-10 7z"/>'],
  handover: ['Switches', 'var(--blue)', '<path d="M5 12h14M13 6l6 6-6 6"/>'],
  alert: ['Alerts', 'var(--orange)', '<path d="M12 4l9 16H3zM12 10v4M12 17v.5"/>'],
  reset: ['Alerts', 'var(--green)', '<path d="M5 12a7 7 0 1 0 2-5M5 4v4h4"/>'],
  'limit-wait': ['Alerts', 'var(--orange)', '<circle cx="12" cy="12" r="8"/><path d="M10 9v6M14 9v6"/>'],
  resume: ['Switches', 'var(--green)', '<path d="M8 5l10 7-10 7z"/>'],
  'fallback-on': ['API key', 'var(--purple)', '<circle cx="9" cy="12" r="4"/><path d="M13 12h8M18 12v3"/>'],
  'fallback-off': ['API key', 'var(--green)', '<path d="M5 12l4 4 10-10"/>'],
  'fallback-cap': ['API key', 'var(--red)', '<circle cx="12" cy="12" r="8"/><path d="M7 7l10 10"/>'],
  'profile-added': ['Accounts', 'var(--green)', '<path d="M12 5v14M5 12h14"/>'],
  'profile-removed': ['Accounts', 'var(--red)', '<path d="M5 12h14"/>'],
  settings: ['Settings', 'var(--label-2)', '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>'],
  heal: ['Settings', 'var(--label-2)', '<path d="M8 12h8M12 8v8"/>'],
  import: ['Settings', 'var(--label-2)', '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'],
  error: ['Alerts', 'var(--red)', '<circle cx="12" cy="12" r="8"/><path d="M12 8v5M12 16v.5"/>'],
};

async function renderActivity() {
  const root = $('#page-activity');
  if (!root.querySelector('#act-list')) {
    root.innerHTML = html`<div class="page-head"><div class="grow"><h1 id="h-activity">Activity</h1><p>Every switch, alert, reset and API-key fallback, newest first.</p></div><div id="act-seg"></div></div><div id="act-list"><div class="skeleton" style="height:300px"></div></div>`.s;
  }
  $('#act-seg').innerHTML = segHtml('act', [['all', 'All'], ['Switches', 'Switches'], ['Alerts', 'Alerts'], ['API key', 'API key']], actFilter).s;
  placeAllThumbs($('#act-seg'));
  let items;
  try { items = await get('/api/activity?limit=400'); } catch (e) { return void ($('#act-list').innerHTML = html`<div class="card empty"><b>Couldn't read activity</b>${e.message}</div>`.s); }
  const shown = items.filter((a) => actFilter === 'all' || (ACT_KIND[a.kind]?.[0] ?? 'Settings') === actFilter);
  if (!shown.length) return void ($('#act-list').innerHTML = html`<div class="card empty"><b>${items.length ? 'Nothing of this kind yet' : 'No activity yet'}</b>Switches, alerts and fallbacks show up here as they happen.</div>`.s);
  const byDay = new Map();
  for (const a of shown) {
    const d = new Date(a.at);
    const key = d.toDateString() === new Date().toDateString() ? 'Today' : d.toDateString() === new Date(Date.now() - 86400000).toDateString() ? 'Yesterday' : d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
    if (!byDay.has(key)) byDay.set(key, []);
    byDay.get(key).push(a);
  }
  $('#act-list').innerHTML = [...byDay.entries()].map(([day, list]) => html`<div class="day-head">${day}</div><div class="group">${list.map((a) => {
    const k = ACT_KIND[a.kind] ?? ACT_KIND.settings;
    return html`<div class="row act-row"><span class="act-time">${new Date(a.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</span><span class="act-dot" style="--k:${raw(k[1])}"><svg viewBox="0 0 24 24" aria-hidden="true">${raw(k[2])}</svg></span><div class="grow"><div>${a.text}</div>${a.profile ? html`<div class="row-sub">${a.profile}</div>` : ''}</div></div>`;
  })}</div>`.s).join('');
}

// ------------------------------------------------------------------ settings

function sw(name, on, label) {
  return html`<label class="switch"><input type="checkbox" data-sw="${name}" ${on ? raw('checked') : ''} aria-label="${label}"><span></span></label>`;
}

function renderSettings() {
  if (!state) return;
  const s = state;
  const f = s.fallback;
  const active = s.profiles.filter((p) => p.fallback.active);
  selectOptions.set('defaultProfile', s.profiles.map((p) => [p.name, p.name]));
  $('#page-settings').innerHTML = html`
    <div class="page-head"><div class="grow"><h1 id="h-settings">Settings</h1><p>Saved as you change them.</p></div></div>
    <div class="settings-grid">
      <div>
        <div class="section-title">Picking an account</div>
        <div class="group">
          <div class="row set-row"><div class="grow"><div class="row-title">How "Start" picks</div><div class="row-sub">Also used by <code>mc auto</code> and <code>mc next</code>.</div></div><div class="ctl">${segHtml('pick', [['priority', 'First with room'], ['most-room', 'Most room']], s.pickMode)}<span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Switch at</div><div class="row-sub">An account counts as full past this share of its 5-hour or weekly limit. Each account can override it.</div></div><div class="ctl"><div class="stepper" data-stepper="switchAt"><button type="button" aria-label="Lower">−</button><output class="tnum">${s.switchAt}%</output><button type="button" aria-label="Raise">+</button></div><span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">When nothing has room</div><div class="row-sub">Start on this account anyway.</div></div><div class="ctl">${selectHtml('defaultProfile', s.profiles.map((p) => [p.name, p.name]), s.defaultProfile, 'Account to use when nothing has room')}<span class="saved-slot"></span></div></div>
          ${s.platform === 'darwin' ? html`<div class="row set-row"><div class="grow"><div class="row-title">Open sessions in</div></div><div class="ctl">${segHtml('terminalApp', [['Terminal', 'Terminal'], ['iTerm', 'iTerm']], s.terminalApp)}<span class="saved-slot"></span></div></div>` : ''}
        </div>

        <div class="section-title">Usage alerts</div>
        <div class="group">
          <div class="row set-row"><div class="grow"><div class="row-title">Notify me</div><div class="row-sub">A desktop notification when an account crosses a level, naming the next account with room.</div></div><div class="ctl">${sw('alerts.enabled', s.alerts.enabled, 'Usage alerts')}<span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Levels</div></div><div class="ctl chips-edit" id="levels">${s.alerts.thresholds.map((t) => html`<span class="chip">${t}%<button type="button" data-rm-level="${t}" aria-label="Remove ${t}%">×</button></span>`)}<input class="field inline-input" id="add-level" inputmode="numeric" placeholder="+ %" aria-label="Add a level"><span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Tell me when a limit resets</div></div><div class="ctl">${sw('alerts.notifyReset', s.alerts.notifyReset, 'Reset notifications')}<span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Continue stopped sessions by themselves</div><div class="row-sub">When a session stops at its account's limit, it waits for that account to reset and then carries on. It never moves to another account; the notification names one with room if you'd rather run <code>mc next</code>.</div></div><div class="ctl">${sw('autoResume.enabled', s.autoResume?.enabled ?? true, 'Auto-resume')}<span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Check usage every</div><div class="row-sub">For accounts with no open session. Open sessions report on their own.</div></div><div class="ctl"><div class="stepper" data-stepper="pollMinutes"><button type="button" aria-label="Less often">−</button><output class="tnum">${s.pollMinutes} min</output><button type="button" aria-label="More often">+</button></div><span class="saved-slot"></span></div></div>
        </div>
      </div>

      <div>
        <div class="section-title">API key fallback</div>
        <div class="group">
          <div class="row set-row"><div class="grow"><div class="row-title">Keep sessions going on my API key</div><div class="row-sub">Only when Anthropic says a plan's limit is reached, until it resets. Pay as you go.</div></div><div class="ctl">${sw('fallback.enabled', f.enabled, 'API key fallback')}<span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">API key</div><div class="row-sub">${f.hasKey ? 'Saved on this computer only.' : 'Paste a key from console.anthropic.com. It is stored only on this computer.'}</div></div>
            <div class="ctl">${f.hasKey ? html`<span class="status ok">Saved</span><button class="btn btn-small" type="button" data-act="key-remove">Remove</button>` : html`<input class="field" type="password" id="api-key" placeholder="sk-ant-…" aria-label="API key" style="width:180px"><button class="btn btn-small" type="button" data-act="key-save">Save</button>`}</div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Daily spending cap</div><div class="row-sub">${money(f.spentToday)} used today. Past the cap, requests go back to the plan's normal limit message.</div></div><div class="ctl"><span class="muted">$</span><input class="field inline-input" data-num="fallback.dailyCapUsd" inputmode="decimal" value="${f.dailyCapUsd}" aria-label="Daily cap in dollars"><span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Accounts that may use it</div><div class="row-sub">None ticked means all of them.</div></div><div class="ctl chips-edit">${s.profiles.map((p) => html`<label class="check"><input type="checkbox" data-fb-profile="${p.name}" ${f.profiles.includes(p.name) ? raw('checked') : ''}><span class="box" aria-hidden="true"></span>${p.name}</label>`)}<span class="saved-slot"></span></div></div>
          <div class="row set-row"><div class="grow"><div class="row-title">Keep every Claude Code feature on</div><div class="row-sub">Tells Claude Code the relay is Anthropic's API (it forwards there unchanged), so features that need a direct connection stay on. Uses an internal Claude Code setting that may change.</div></div><div class="ctl">${sw('fallback.assumeFirstParty', f.assumeFirstParty, 'Keep features on')}<span class="saved-slot"></span></div></div>
          ${active.length ? html`<div class="row"><div class="grow"><div class="row-title">On the API key now</div><div class="row-sub">${active.map((p) => `${p.name} until ${new Date(p.fallback.until).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`).join(' · ')}</div></div>${active.map((p) => html`<button class="btn btn-small" type="button" data-act="fb-clear" data-name="${p.name}">Back to plan: ${p.name}</button>`)}</div>` : ''}
        </div>
        <div class="row-foot">Changes apply to sessions started after them. Already open sessions keep the route they started with.</div>


        <div class="section-title">About</div>
        <div class="group">
          <div class="row"><div class="grow"><div class="row-title">multiclaude ${s.version}</div><div class="row-sub">Running on 127.0.0.1:${s.port}. Nothing leaves this computer except Claude Code's own requests to Anthropic.</div></div></div>
          <div class="row"><div class="grow"><div class="row-sub"><code>mc</code> picker · <code>mc auto</code> · <code>mc next</code> · <code>mc list</code> · <code>mc doctor</code></div></div></div>
        </div>
      </div>
    </div>`.s;
  placeAllThumbs($('#page-settings'));
}

async function patchConfig(body, anchor) {
  try {
    setState(await post('/api/config', body));
    saved(anchor);
  } catch (e) {
    toast(e.message, 'err');
    renderSettings();
  }
}
const slotNear = (el) => el.closest('.ctl, .hero-controls')?.querySelector('.saved-slot');

// ------------------------------------------------------------------ router and events

function show(next) {
  if (!['accounts', 'sessions', 'stats', 'activity', 'settings'].includes(next)) next = 'accounts';
  page = next;
  for (const sec of $$('.page')) {
    const on = sec.dataset.page === next;
    sec.hidden = !on;
    // Sections rise in once per visit to a page.
    sec.classList.toggle('first-visit', on && !visited.has(next));
  }
  visited.add(next);
  for (const a of $$('#nav [data-page]')) a.setAttribute('aria-selected', String(a.dataset.page === next));
  $$('#tabbar [data-page]').forEach((a) => (a.dataset.page === next ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  placeThumb($('#nav'));
  placeThumb($('#tabbar'));
  // One primary action per screen: the briefing has it on Accounts.
  $('#start-auto').hidden = next === 'accounts';
  if (next === 'accounts' && state) renderAccounts();
  if (next === 'sessions') renderSessions();
  if (next === 'stats') renderStats();
  if (next === 'activity') renderActivity();
  if (next === 'settings') renderSettings();
  window.scrollTo({ top: 0 });
}

document.addEventListener('click', async (e) => {
  const t = e.target;
  if (!t.closest('.menu') && !t.closest('[data-act="menu"]') && !t.closest('[data-select]')) closeMenus();
  const sel = t.closest('[data-select]');
  if (sel) return sel.getAttribute('aria-expanded') === 'true' ? closeMenus() : openSelect(sel);

  const act = t.closest('[data-act]');
  if (act) {
    const a = act.dataset.act;
    if (a === 'menu') return act.getAttribute('aria-expanded') === 'true' ? closeMenus() : openMenu(act, act.dataset.name);
    if (a === 'start') return busy(act, () => post('/api/launch', { profile: act.dataset.name })).then(() => toast(`Opened Terminal on ${act.dataset.name}`)).catch(() => {});
    if (a === 'login') return launch({ profile: act.dataset.name, mode: 'login' }, `Opened Terminal to sign in to ${act.dataset.name}`);
    if (a === 'start-auto') return busy(act, () => post('/api/launch', { profile: 'auto' })).then(() => toast(`Opened Terminal on ${state.pick.name}`)).catch(() => {});
    if (a === 'key-save') {
      const key = $('#api-key').value.trim();
      return busy(act, () => post('/api/apikey', { key })).then((s) => { setState(s); renderSettings(); toast('API key saved'); }).catch(() => {});
    }
    if (a === 'key-remove') return busy(act, () => post('/api/apikey', { remove: true })).then((s) => { setState(s); renderSettings(); }).catch(() => {});
    if (a === 'fb-clear') return busy(act, () => post('/api/fallback/clear', { profile: act.dataset.name })).then((s) => { setState(s); renderSettings(); }).catch(() => {});
  }

  // Segmented controls
  const segBtn = t.closest('.seg-inline [data-value]');
  if (segBtn) {
    const seg = segBtn.closest('[data-seg]');
    const v = segBtn.dataset.value;
    if (segBtn.getAttribute('aria-pressed') === 'true') return;
    selectSeg(seg, v);
    const name = seg.dataset.seg;
    if (name === 'pick') return patchConfig({ pick: v }, slotNear(seg));
    if (name === 'terminalApp') return patchConfig({ terminalApp: v }, slotNear(seg));
    if (name === 'sess') { sessFilter = v; return drawSessions(); }
    if (name === 'range') { statsDays = Number(v); visited.delete('chart-drawn'); return renderStats(); }
    if (name === 'act') { actFilter = v; return renderActivity(); }
    return;
  }

  // Steppers
  const step = t.closest('[data-stepper] button');
  if (step) {
    const box = step.closest('[data-stepper]');
    const key = box.dataset.stepper;
    const out = box.querySelector('output');
    const up = step === box.lastElementChild;
    const cur = parseInt(out.textContent, 10);
    const n = key === 'pollMinutes' ? Math.max(1, Math.min(60, cur + (up ? 1 : -1))) : Math.max(10, Math.min(100, cur + (up ? 5 : -5)));
    out.textContent = key === 'pollMinutes' ? `${n} min` : `${n}%`;
    return debounce(key, () => patchConfig({ [key]: n }, slotNear(box)), 450);
  }

  if (t.closest('[data-more]')) { sessShown += 30; return drawSessions(); }

  const rmLevel = t.closest('[data-rm-level]');
  if (rmLevel) return patchConfig({ alerts: { thresholds: state.alerts.thresholds.filter((x) => x !== Number(rmLevel.dataset.rmLevel)) } }, $('#levels .saved-slot'));

  const openBtn = t.closest('[data-open]');
  if (openBtn) {
    const id = openBtn.dataset.open;
    const wrap = openBtn.closest('.sess');
    const panel = wrap.querySelector('.sess-panel');
    const closing = openSession === id;
    $$('.sess-panel').forEach((p) => { if (p !== panel) p.hidden = true; });
    $$('[data-open]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
    openSession = closing ? null : id;
    if (closing) return void (panel.hidden = true);
    openBtn.setAttribute('aria-expanded', 'true');
    panel.hidden = false;
    panel.classList.remove('glide');
    void panel.offsetWidth;
    panel.classList.add('glide');
    return fillPanel(panel, sessions.find((s) => s.id === id));
  }
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.dataset.sw) {
    const [group, key] = t.dataset.sw.split('.');
    return patchConfig({ [group]: { [key]: t.checked } }, slotNear(t));
  }
  if (t.dataset.num === 'fallback.dailyCapUsd') {
    const n = Number(t.value);
    if (!(n >= 0)) return toast('Enter a dollar amount, like 5', 'err');
    return patchConfig({ fallback: { dailyCapUsd: n } }, slotNear(t));
  }
  if (t.dataset.fbProfile !== undefined) {
    const picked = $$('[data-fb-profile]').filter((c) => c.checked).map((c) => c.dataset.fbProfile);
    return patchConfig({ fallback: { profiles: picked } }, slotNear(t));
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenus();
  const handle = e.target.closest?.('.handle');
  if (handle && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveBy(handle.dataset.drag, e.key === 'ArrowUp' ? -1 : 1);
  }
  if (e.target.id === 'add-level' && e.key === 'Enter') {
    const n = Number(e.target.value);
    if (!(n > 0 && n <= 100)) return toast('Enter a level from 1 to 100', 'err');
    patchConfig({ alerts: { thresholds: [...state.alerts.thresholds, n] } }, $('#levels .saved-slot'));
  }
  // ⌘R / Ctrl+R stays the browser's; R alone refreshes usage when not typing.
  if (e.key === 'r' && !e.metaKey && !e.ctrlKey && !/input|select|textarea/i.test(e.target.tagName)) $('#refresh').click();
});

document.addEventListener('pointerdown', (e) => {
  const h = e.target.closest('.handle');
  if (h && e.button === 0) startDrag(e, h);
});

document.addEventListener('submit', async (e) => {
  if (e.target.id !== 'add-form') return;
  e.preventDefault();
  const f = e.target;
  const name = f.name.value.trim().toLowerCase();
  const btn = f.querySelector('button');
  try {
    await busy(btn, () => post('/api/profiles/add', { name, label: f.label.value.trim() }));
    toast(`Opened Terminal to sign in to ${name}. It shows up here when done.`);
    f.reset();
    setTimeout(loadState, 4000);
  } catch { /* toast shown */ }
});

$('#refresh').addEventListener('click', async (e) => {
  const b = e.currentTarget;
  if (b.classList.contains('spin')) return;
  b.classList.add('spin');
  try {
    setState(await post('/api/refresh'));
    toast('Usage refreshed');
  } catch (err) {
    toast(err.message, 'err');
  } finally {
    b.classList.remove('spin');
  }
});
$('#start-auto').addEventListener('click', (e) => busy(e.currentTarget, () => post('/api/launch', { profile: 'auto' })).then(() => toast(`Opened Terminal on ${state?.pick.name}`)).catch(() => {}));

// ------------------------------------------------------------------ glass

// The navigation is solid; only the selected-tab lens is glass. On Chromium the lens
// also bends what's under its rim (liquid-lens.js); elsewhere it's the lit rim alone.
let detach = [];
function applyGlass() {
  detach.forEach((d) => d());
  detach = [];
  for (const el of $$('#nav .seg-thumb, #tabbar .seg-thumb')) if (el.offsetWidth) detach.push(attachLiquidGlass(el, { variant: 'clear', frost: 1 }));
}
// Tabs swell the lens while pressed.
document.addEventListener('pointerdown', (e) => {
  const host = e.target.closest('.seg, .tabbar');
  if (!host || !e.target.closest('a, button')) return;
  host.classList.add('pressing');
  const up = () => { host.classList.remove('pressing'); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  addEventListener('pointerup', up);
  addEventListener('pointercancel', up);
});
matchMedia('(max-width: 720px)').addEventListener('change', () => { applyGlass(); placeAllThumbs(document); });
addEventListener('resize', () => { placeAllThumbs(document, false); closeMenus(); });
addEventListener('scroll', () => closeMenus(), { passive: true });

// ------------------------------------------------------------------ start

addEventListener('hashchange', () => show(location.hash.slice(1)));
await loadState();
show(location.hash.slice(1) || 'accounts');
requestAnimationFrame(() => placeAllThumbs(document, false));
applyGlass();
setInterval(() => { if (!document.hidden) loadState(); }, 10_000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) loadState(); });
