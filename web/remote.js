const keyFile = document.querySelector('#key');
const unlock = document.querySelector('#unlock');
const dashboard = document.querySelector('#dashboard');
const actions = document.querySelector('#actions');
const refresh = document.querySelector('#refresh');
const lock = document.querySelector('#lock');
const status = document.querySelector('#status');
const profiles = document.querySelector('#profiles');
const sessions = document.querySelector('#session-list');
const navigation = document.querySelectorAll('.remote-nav');
const links = document.querySelectorAll('.remote-nav a');
const cli = navigator.platform.startsWith('Win') ? '.\\mc.cmd' : 'mc';
const modes = { subscription: 'Claude subscription', api: 'Anthropic API key', mock: 'Offline mock' };
let key = '';

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function commandButton(label, command) {
  const button = element('button', 'btn btn-small', label);
  button.type = 'button';
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(command);
      status.textContent = 'Command copied.';
    } catch {
      status.textContent = command;
    }
  });
  return button;
}

function renderAccount({ name, mode, sessions: ids }) {
  const card = element('article', 'acct remote-account');
  const identity = element('div', 'remote-identity');
  identity.append(
    element('h2', 'acct-name', name),
    element('span', 'acct-who', modes[mode]),
  );
  const count = element('span', 'chip', ids.length === 1 ? '1 running session' : `${ids.length} running sessions`);
  card.append(identity, count, commandButton('Copy start command', `${cli} remote start ${name}`));
  return card;
}

function renderSession(name, id) {
  const row = element('div', 'row sess-row remote-session');
  const identity = element('div', 'grow');
  identity.append(element('div', 'sess-title', name), element('code', 'row-sub', id));
  const controls = element('div', 'sess-actions');
  controls.append(commandButton('Copy attach command', `${cli} remote attach ${name} ${id}`));
  row.append(identity, controls);
  return row;
}

function showPage() {
  const page = location.hash === '#sessions' ? 'sessions' : 'accounts';
  for (const view of dashboard.querySelectorAll('.page')) view.hidden = view.id !== 'remote-' + page;
  for (const link of links) {
    if (link.hash === '#' + page) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  }
}

function setUnlocked(open) {
  unlock.hidden = open;
  dashboard.hidden = actions.hidden = !open;
  for (const nav of navigation) nav.hidden = !open;
}

async function loadSessions() {
  keyFile.disabled = refresh.disabled = lock.disabled = true;
  status.textContent = 'Loading remote profiles…';
  try {
    const response = await fetch('/v1/dashboard', {
      headers: { Authorization: 'Bearer ' + key },
      credentials: 'omit',
      redirect: 'error',
      signal: AbortSignal.timeout(8000),
    });
    if (response.status === 401) {
      key = '';
      profiles.replaceChildren();
      sessions.replaceChildren();
      setUnlocked(false);
      status.textContent = 'Access denied. Choose a valid access key file.';
      return;
    }
    if (!response.ok) throw new Error();
    const data = await response.json();
    profiles.replaceChildren(...(data.length ? data.map(renderAccount) :
      [element('p', 'card empty', 'This key has no profiles.')]));
    const rows = data.flatMap(({ name, sessions: ids }) => ids.map(id => renderSession(name, id)));
    sessions.replaceChildren(...(rows.length ? rows :
      [element('p', 'empty', 'No running sessions. Use Accounts to copy a start command.')]));
    setUnlocked(true);
    showPage();
    status.textContent = '';
  } catch {
    profiles.replaceChildren();
    sessions.replaceChildren();
    setUnlocked(Boolean(key));
    status.textContent = 'Could not load remote profiles. Try refreshing.';
  } finally {
    keyFile.disabled = refresh.disabled = lock.disabled = false;
  }
}

keyFile.addEventListener('change', async () => {
  const file = keyFile.files[0];
  if (!file) return;
  keyFile.disabled = true;
  try {
    key = file.size <= 128 ? (await file.text()).trim() : '';
  } catch {
    key = '';
  } finally {
    keyFile.value = '';
  }
  if (/^[\w-]{43}$/.test(key)) {
    await loadSessions();
    if (key) dashboard.querySelector('.page:not([hidden]) h1').focus();
    return;
  }
  key = '';
  keyFile.disabled = false;
  status.textContent = 'Choose a valid multiclaude access key file.';
});

window.addEventListener('hashchange', showPage);
refresh.addEventListener('click', loadSessions);
lock.addEventListener('click', () => {
  key = '';
  profiles.replaceChildren();
  sessions.replaceChildren();
  setUnlocked(false);
  status.textContent = '';
  keyFile.focus();
});
