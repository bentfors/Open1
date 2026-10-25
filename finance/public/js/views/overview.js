import { get } from '../api.js';
import { h, setKids, fmtSek, fmtPct, monthRange } from '../dom.js';
import { monthChart, historyChart } from './reports.js';

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

export async function renderOverview(root) {
  const range = { from: monthRange(-5).from, to: monthRange(0).to };
  const [accounts, balance, income] = await Promise.all([get('/api/accounts'), get('/api/reports/balance'), get(`/api/reports/income?from=${range.from}&to=${range.to}`)]);

  if (!accounts.items.length) {
    return setKids(
      root,
      h('h1', {}, 'Välkommen'),
      h(
        'div',
        { class: 'card' },
        h('p', {}, 'Så här kommer du igång:'),
        h('ol', { class: 'warn-list' }, h('li', {}, h('a', { href: '#/konton' }, 'Lägg upp dina konton'), ' (lönekonto, sparkonto, ISK, lån) med dagens saldo.'), h('li', {}, 'Klistra in ett kontoutdrag per konto. Transaktionerna kategoriseras automatiskt så långt det går.'), h('li', {}, h('a', { href: '#/innehav' }, 'Lägg in dina innehav'), ' så värderas de till aktuell kurs.'), h('li', {}, 'Titta på ', h('a', { href: '#/resultat' }, 'resultat'), ' och ', h('a', { href: '#/balans' }, 'balans'), '.')),
      ),
    );
  }

  const thisMonth = income.months.at(-1);
  const last6 = income.months.slice(0, -1);
  const avgNet = last6.length ? last6.reduce((n, m) => n + m.net, 0) / last6.length : null;
  setKids(
    root,
    h('h1', {}, 'Översikt'),
    income.uncategorized.count ? h('div', { class: 'alert warn' }, `${income.uncategorized.count} transaktioner de senaste sex månaderna saknar kategori. `, h('a', { href: '#/transaktioner?uncategorized=1' }, 'Kategorisera'), '.') : null,
    balance.unpriced.length ? h('div', { class: 'alert warn' }, `${balance.unpriced.length} innehav saknar kurs och är inte med i förmögenheten. `, h('a', { href: '#/innehav' }, 'Åtgärda'), '.') : null,
    h('div', { class: 'kpis' }, kpi('Eget kapital', fmtSek(balance.equity), `tillgångar ${fmtSek(balance.total_assets)}, skulder ${fmtSek(balance.total_liabilities)}`, balance.equity < 0 ? 'neg' : ''), kpi('Resultat denna månad', fmtSek(thisMonth.net), `inkomst ${fmtSek(thisMonth.income)}, utgift ${fmtSek(thisMonth.expense)}`, thisMonth.net < 0 ? 'neg' : 'pos'), kpi('Sparkvot, 6 månader', fmtPct(income.savings_rate), 'resultat / inkomster'), kpi('Snittresultat per månad', avgNet === null ? '–' : fmtSek(Math.round(avgNet)), 'föregående månader')),
    h('h2', {}, 'Inkomster och utgifter'),
    h('div', { class: 'card flush' }, monthChart(income.months)),
    balance.history.length > 1 ? [h('h2', { class: 'mt-l' }, 'Eget kapital över tid'), h('div', { class: 'card flush' }, historyChart(balance.history))] : null,
  );
}
