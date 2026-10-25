import { get, post, onApiEvent } from './api.js';
import { h, clear, toast, add, setKids } from './dom.js';
import { state, refreshApprovalCount, isAdmin } from './state.js';
import { renderLogin, renderForcedPasswordChange } from './views/login.js';
import { renderTime } from './views/time.js';
import { renderApprovals } from './views/approvals.js';
import { renderExpenses } from './views/expenses.js';
import { renderMileage } from './views/mileage.js';
import { renderReports } from './views/reports.js';
import { renderAdmin } from './views/admin.js';
import { renderAccount } from './views/account.js';
import { renderBilling } from './views/billing.js';
import { renderStats } from './views/stats.js';

const app = document.getElementById('app');

const ROUTES = {
  tid: { label: 'Tid', view: renderTime },
  utlagg: { label: 'Utlägg', view: renderExpenses },
  korjournal: { label: 'Körjournal', view: renderMileage },
  attest: { label: 'Attest', view: renderApprovals, badge: true },
  statistik: { label: 'Statistik', view: renderStats, stats: true },
  rapporter: { label: 'Rapporter', view: renderReports },
  fakturering: { label: 'Fakturering', view: renderBilling, admin: true },
  admin: { label: 'Admin', view: renderAdmin, admin: true },
  konto: { label: 'Mitt konto', view: renderAccount, hidden: true },
};

let shell = null;
let pollTimer = null;

function currentRoute() {
  const [, name, ...rest] = location.hash.replace(/^#/, '').split('/');
  return { name: Object.hasOwn(ROUTES, name) ? name : 'tid', params: rest.map(decodeURIComponent) };
}

function buildNav(active) {
  const nav = h('nav', { class: 'nav', 'aria-label': 'Huvudmeny' });
  for (const [name, r] of Object.entries(ROUTES)) {
    if (r.hidden || (r.admin && !isAdmin()) || (r.stats && !isAdmin() && !state.user.has_stats)) continue;
    const link = h('a', { href: `#/${name}`, 'aria-current': name === active ? 'page' : null }, r.label);
    if (r.badge) {
      const badge = h('span', { class: `badge ${state.approvalCount ? '' : 'hidden'}` }, String(state.approvalCount));
      badge.dataset.role = 'approval-badge';
      add(link, badge);
    }
    add(nav, link);
  }
  return nav;
}

function renderShell() {
  clear(app);
  const mount = h('main', { id: 'main' });
  const nav = h('div', { class: 'nav-slot' });
  const header = h(
    'header',
    { class: 'topbar' },
    h(
      'div',
      { class: 'topbar-inner' },
      h('a', { class: 'brand', href: '#/tid', 'aria-label': 'x-time, startsidan' }, 'x-time'),
      nav,
      h(
        'div',
        { class: 'userbox' },
        h('a', { class: 'who muted', href: '#/konto' }, state.user.name),
        h('button', { class: 'btn sm', type: 'button', onclick: logout }, 'Logga ut'),
      ),
    ),
  );
  add(app, header, mount);
  shell = { mount, nav };
}

function route() {
  if (!state.user) return;
  const { name, params } = currentRoute();
  shell.nav.replaceWith((shell.nav = buildNav(name)));
  document.title = `${ROUTES[name].label} · x-time`;
  const mount = h('div');
  shell.mount.replaceChildren(mount);
  Promise.resolve(ROUTES[name].view(mount, params)).catch((err) => {
    setKids(mount, h('div', { class: 'alert error' }, err.message));
  });
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
  clearInterval(pollTimer);
  state.user = null;
  location.hash = '';
  renderLogin(app, async () => {
    await loadSession();
  });
}

async function loadSession() {
  const me = await get('/api/auth/me');
  state.user = me.user;
  state.settings = me.settings;
  if (state.user.must_change_password) return showForcedChange();
  start();
}

function showForcedChange() {
  renderForcedPasswordChange(app, state.user, async () => {
    await loadSession();
  });
}

function start() {
  renderShell();
  if (!location.hash) location.hash = '#/tid';
  route();
  refreshApprovalCount();
  clearInterval(pollTimer);
  pollTimer = setInterval(refreshApprovalCount, 120000);
}

window.addEventListener('hashchange', route);
document.addEventListener('approvals-changed', () => {
  document.querySelectorAll('[data-role="approval-badge"]').forEach((b) => {
    b.textContent = String(state.approvalCount);
    b.classList.toggle('hidden', !state.approvalCount);
  });
});

onApiEvent({
  unauthenticated: () => {
    if (!state.user) return;
    toast('Du har blivit utloggad. Logga in igen.', 'error');
    showLogin();
  },
  passwordChange: () => showForcedChange(),
});

get('/api/auth/me')
  .then((me) => {
    state.user = me.user;
    state.settings = me.settings;
    if (state.user.must_change_password) showForcedChange();
    else start();
  })
  .catch(() => showLogin());
