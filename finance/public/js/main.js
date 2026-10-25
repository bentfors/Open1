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
import { renderBudget } from './views/budget.js';
import { renderGoals } from './views/goals.js';
import { renderScenarios } from './views/scenarios.js';

const app = document.getElementById('app');

const ROUTES = {
  oversikt: { label: 'Översikt', view: renderOverview },
  transaktioner: { label: 'Transaktioner', view: renderTransactions },
  konton: { label: 'Konton', view: renderAccounts },
  innehav: { label: 'Innehav', view: renderHoldings },
  budget: { label: 'Budget', view: renderBudget },
  resultat: { label: 'Resultat', view: renderIncome },
  balans: { label: 'Balans', view: renderBalance },
  mal: { label: 'Mål', view: renderGoals },
  scenarier: { label: 'Scenarier', view: renderScenarios },
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

// Syns bara när hushållet har fler än en medlem.
function scopeToggle() {
  if (state.householdSize < 2) return null;
  const sel = h('select', { 'aria-label': 'Vy', onchange: () => ((state.scope = sel.value), route()) }, h('option', { value: 'household', selected: state.scope === 'household' }, 'Hushållet'), h('option', { value: 'me', selected: state.scope === 'me' }, 'Bara mina'));
  return sel;
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
        h('div', { class: 'userbox' }, scopeToggle(), h('a', { class: 'who muted', href: '#/installningar' }, state.user.name), h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Logga ut')),
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
    await loadMe();
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

async function loadMe() {
  const me = await get('/api/auth/me');
  state.user = me.user;
  state.householdSize = me.household_size;
  if (me.household_size < 2) state.scope = 'household';
}

loadMe()
  .then(start)
  .catch(() => showLogin());
