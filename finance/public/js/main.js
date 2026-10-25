import { get, post, onApiEvent } from './api.js';
import { h, clear, toast, add, setKids } from './dom.js';
import { state } from './state.js';
import { renderAuth } from './views/login.js';
import { renderOverview } from './views/overview.js';
import { renderAccounts } from './views/accounts.js';
import { renderTransactions } from './views/transactions.js';
import { renderHoldings } from './views/holdings.js';
import { renderIncome, renderBalance } from './views/reports.js';
import { renderSettings } from './views/settings.js';

const app = document.getElementById('app');

const ROUTES = {
  oversikt: { label: 'Översikt', view: renderOverview },
  transaktioner: { label: 'Transaktioner', view: renderTransactions },
  konton: { label: 'Konton', view: renderAccounts },
  innehav: { label: 'Innehav', view: renderHoldings },
  resultat: { label: 'Resultat', view: renderIncome },
  balans: { label: 'Balans', view: renderBalance },
  installningar: { label: 'Inställningar', view: renderSettings, hidden: true },
};

let shell = null;

function currentRoute() {
  const [name, query = ''] = location.hash.replace(/^#\//, '').split('?');
  return { name: Object.hasOwn(ROUTES, name) ? name : 'oversikt', query: Object.fromEntries(new URLSearchParams(query)) };
}

function buildNav(active) {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Huvudmeny' });
  for (const [name, r] of Object.entries(ROUTES)) {
    if (r.hidden) continue;
    add(nav, h('a', { href: `#/${name}`, 'aria-current': name === active ? 'page' : null }, r.label));
  }
  return nav;
}

function renderShell() {
  clear(app);
  const mount = h('main', { id: 'main' });
  const nav = h('div', { class: 'nav-slot' });
  add(
    app,
    h(
      'header',
      { class: 'topbar' },
      h(
        'div',
        { class: 'topbar-inner' },
        h('a', { class: 'brand', href: '#/oversikt', 'aria-label': 'Min ekonomi, startsidan' }, 'Min ekonomi'),
        nav,
        h('div', { class: 'userbox' }, h('a', { class: 'who muted', href: '#/installningar' }, state.user.name), h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Logga ut')),
      ),
    ),
    mount,
  );
  shell = { mount, nav };
}

function route() {
  if (!state.user) return;
  const { name, query } = currentRoute();
  shell.nav.replaceWith((shell.nav = buildNav(name)));
  document.title = `${ROUTES[name].label} · Min ekonomi`;
  const mount = h('div');
  shell.mount.replaceChildren(mount);
  Promise.resolve(ROUTES[name].view(mount, query)).catch((err) => setKids(mount, h('div', { class: 'alert error' }, err.message)));
  window.scrollTo(0, 0);
}

async function logout() {
  try {
    await post('/api/auth/logout');
  } catch {
    /* utloggad ändå */
  }
  showLogin();
}

function showLogin() {
  state.user = null;
  location.hash = '';
  renderAuth(app, async () => {
    state.user = (await get('/api/auth/me')).user;
    start();
  });
}

function start() {
  renderShell();
  if (!location.hash) location.hash = '#/oversikt';
  route();
}

window.addEventListener('hashchange', route);

onApiEvent({
  unauthenticated: () => {
    if (!state.user) return;
    toast('Du har blivit utloggad. Logga in igen.', 'error');
    showLogin();
  },
});

get('/api/auth/me')
  .then((me) => {
    state.user = me.user;
    start();
  })
  .catch(() => showLogin());
