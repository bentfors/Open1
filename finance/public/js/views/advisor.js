import { get, post, del, qs } from '../api.js';
import { h, setKids, toast, dataTable, confirmDialog, fmtSek, fmtSekExact, fmtDate, fmtNum } from '../dom.js';
import { state } from '../state.js';
import { reportBody, insightList, lastCompleteMonth } from './monthly.js';
import { monthChart } from './reports.js';
import { lineChart } from './charts.js';

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

const STATE = {
  active: ['Aktivt', 'approved'],
  awaiting_approval: ['Väntar på godkännande från kunden', 'warn'],
  expired: ['Har gått ut', 'rejected'],
  invitation: ['Ej inlöst', 'warn'],
};

const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
};

export async function renderAdvisor(root, query) {
  if (query.client) return renderClient(root, Number(query.client), query.month);
  const mount = h('div');
  const code = h('input', { id: 'adv-code', type: 'text', autocomplete: 'off', placeholder: 'Kod från kunden' });
  setKids(
    root,
    h('h1', {}, 'Rådgivare'),
    h('p', { class: 'muted' }, 'Kunder som gett dig läsrätt till sin ekonomi. Allt du öppnar loggas och syns för kunden. Privata konton ingår aldrig.'),
    mount,
    h('div', { class: 'card mt-l' },
      h('h3', {}, 'Lös in kod från en kund'),
      h('form', { class: 'row', onsubmit: async (e) => {
        e.preventDefault();
        try {
          const r = await post('/api/advisor/redeem', { code: code.value.trim() });
          toast(r.state === 'active' ? 'Samtycket är aktivt.' : 'Koden är inlöst. Samtycket aktiveras när alla i kundens hushåll godkänt det.', 'ok');
          code.value = '';
          if (!state.advisorEnabled) location.reload();
          else load();
        } catch (err) {
          toast(err.message, 'error');
        }
      } }, code, h('button', { class: 'btn primary', type: 'submit' }, 'Lös in'))),
  );

  async function load() {
    const { items } = await get('/api/advisor/clients');
    setKids(
      mount,
      h('div', { class: 'card flush' }, dataTable({
        empty: 'Du har inga kunder än. Be en kund ge dig samtycke under Inställningar > Rådgivare och lös in koden nedan.',
        rows: items,
        columns: [
          { label: 'Kund', render: (c) => (c.members.length ? c.members.join(' och ') : h('span', { class: 'muted' }, 'visas när samtycket är aktivt')) },
          { label: 'Nivå', render: (c) => (c.level === 'detail' ? 'Detaljer' : 'Sammanfattning') },
          { label: 'Status', render: (c) => h('span', { class: `chip ${STATE[c.state]?.[1] || ''}` }, STATE[c.state]?.[0] || c.state) },
          { label: 'Gäller till', render: (c) => fmtDate(c.expires_at.slice(0, 10)) },
          { label: '', class: 'actions', render: (c) => (c.state === 'active' ? h('a', { class: 'btn sm primary', href: `#/radgivare?client=${c.grant_id}` }, 'Öppna') : h('a', { class: 'btn sm', href: `#/radgivare?client=${c.grant_id}&notes=1` }, 'Anteckningar')) },
        ],
      })),
    );
  }
  await load();
}

async function renderClient(root, id, month) {
  month ||= lastCompleteMonth();
  let d;
  try {
    d = await get(`/api/advisor/clients/${id}/overview${qs({ month })}`);
  } catch (e) {
    return setKids(root, h('p', {}, h('a', { href: '#/radgivare' }, '← Kunder')), h('div', { class: 'alert error' }, e.message), notesSection(id));
  }
  const r = d.report;
  const detail = d.client.level === 'detail';
  const sections = [
    ['sammanfattning', 'Sammanfattning'], ['rapport', 'Månadsrapport'], ['balans', 'Balans'], ['resultat', 'Resultat 12 mån'], ['budget', 'Budget'], ['mal', 'Mål'], ['scenarier', 'Scenarier'], ...(detail ? [['transaktioner', 'Transaktioner']] : []), ['anteckningar', 'Anteckningar'],
  ];
  const go = (m) => (location.hash = `#/radgivare?client=${id}&month=${m}`);

  const adv = r.insights.filter((i) => i.audience === 'advisor');
  const cli = r.insights.filter((i) => i.audience === 'client');
  const scenarioOut = h('div');

  setKids(
    root,
    h('p', { class: 'no-print' }, h('a', { href: '#/radgivare' }, '← Kunder')),
    h('div', { class: 'row between' },
      h('h1', {}, d.client.members.join(' och ')),
      h('button', { class: 'btn no-print', type: 'button', onclick: () => window.print() }, 'Skriv ut')),
    h('p', { class: 'muted' }, `Samtycke: ${detail ? 'detaljer' : 'sammanfattning'}, gäller till ${fmtDate(d.client.expires_at.slice(0, 10))}. ${d.notice} Allt du öppnar loggas och syns för kunden.`),
    h('div', { class: 'subnav no-print' }, sections.map(([key, label]) => h('a', { href: `#adv-${key}`, onclick: (e) => { e.preventDefault(); document.getElementById(`adv-${key}`)?.scrollIntoView({ behavior: 'smooth' }); } }, label))),

    h('div', { class: 'row no-print' },
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Föregående månad', onclick: () => go(shiftMonth(month, -1)) }, '←'),
      h('strong', {}, month),
      h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Nästa månad', disabled: month >= lastCompleteMonth(), onclick: () => go(shiftMonth(month, 1)) }, '→')),

    h('h2', { id: 'adv-sammanfattning', class: 'mt-l' }, 'Samtalspunkter'),
    h('p', { class: 'muted small' }, 'Regelbaserade iakttagelser ur kundens siffror. De är underlag för samtal, inte rekommendationer, och kan bero på att uppgifter saknas i appen.'),
    insightList([...adv, ...cli], { empty: 'Inga särskilda punkter.' }),

    h('h2', { id: 'adv-rapport', class: 'mt-l' }, 'Månadsrapport'),
    reportBody(r, { forAdvisor: true, withInsights: false }),

    h('h2', { id: 'adv-balans', class: 'mt-l' }, 'Balans'),
    h('div', { class: 'kpis' }, kpi('Tillgångar', fmtSek(d.balance.total_assets)), kpi('Skulder', fmtSek(d.balance.total_liabilities)), kpi('Eget kapital', fmtSek(d.balance.equity), '', d.balance.equity < 0 ? 'neg' : '')),
    h('div', { class: 'two-col' },
      h('div', { class: 'card flush' }, dataTable({ empty: 'Inga tillgångar.', rows: d.balance.assets, columns: [{ label: 'Tillgångar', render: (l) => h('div', {}, l.name, h('div', { class: 'small muted' }, l.kind_label)) }, { label: 'Belopp', num: true, render: (l) => fmtSekExact(l.amount) }] })),
      h('div', { class: 'card flush' }, dataTable({ empty: 'Inga skulder.', rows: d.balance.liabilities, columns: [{ label: 'Skulder', render: (l) => h('div', {}, l.name, h('div', { class: 'small muted' }, l.kind_label)) }, { label: 'Belopp', num: true, render: (l) => fmtSekExact(l.amount) }] }))),
    d.balance.unpriced.length ? h('div', { class: 'alert warn mt-m' }, `${d.balance.unpriced.length} innehav saknar kurs: ${d.balance.unpriced.map((u) => u.name).join(', ')}.`) : null,

    h('h2', { id: 'adv-resultat', class: 'mt-l' }, 'Resultat de senaste 12 månaderna'),
    h('div', { class: 'kpis' }, kpi('Inkomster', fmtSek(d.income_12m.income), '', 'pos'), kpi('Utgifter', fmtSek(d.income_12m.expense)), kpi('Resultat', fmtSek(d.income_12m.net), '', d.income_12m.net < 0 ? 'neg' : 'pos'), kpi('Sparkvot', d.income_12m.savings_rate === null ? '–' : `${fmtNum(d.income_12m.savings_rate * 100, 0)} %`)),
    d.income_12m.months.length > 1 ? h('div', { class: 'card flush' }, monthChart(d.income_12m.months)) : null,

    h('h2', { id: 'adv-budget', class: 'mt-l' }, 'Budget'),
    h('div', { class: 'card flush' }, dataTable({ empty: 'Kunden har ingen budget.', rows: d.budget, columns: [{ label: 'Kategori', render: (b) => b.category }, { label: 'Typ', render: (b) => (b.kind === 'income' ? 'Inkomst' : 'Utgift') }, { label: 'Per månad', num: true, render: (b) => fmtSekExact(b.amount) }] })),

    h('h2', { id: 'adv-mal', class: 'mt-l' }, 'Mål'),
    h('div', { class: 'card flush' }, dataTable({
      empty: 'Inga mål.',
      rows: d.goals.items,
      columns: [
        { label: 'Mål', render: (g) => g.name },
        { label: 'Sparat', num: true, render: (g) => `${fmtSek(g.current)} av ${fmtSek(g.target_amount)}` },
        { label: 'Datum', render: (g) => fmtDate(g.target_date) },
        { label: 'Sparar / krävs per månad', num: true, render: (g) => `${fmtSek(g.monthly_contribution)} / ${g.status === 'reached' ? '–' : fmtSek(g.needed_monthly)}` },
        { label: 'Avkastning', num: true, render: (g) => `${fmtNum(g.effective_return, 1)} %` },
      ],
    })),
    h('p', { class: 'muted small' }, `Kundens antaganden för prognoser: avkastning ${d.assumptions.return_rate} %, ränta på kontanter ${d.assumptions.cash_rate} %, inflation ${d.assumptions.inflation} %. Månadsöverskott enligt ${d.goals.summary.expenses_source === 'budget' ? 'budgeten' : 'senaste månaderna'}: ${fmtSek(d.goals.summary.surplus)}.`),

    h('h2', { id: 'adv-scenarier', class: 'mt-l' }, 'Scenarier'),
    d.scenarios.length
      ? h('div', { class: 'row' }, d.scenarios.map((s) => h('button', { class: 'btn', type: 'button', onclick: async () => {
          setKids(scenarioOut, h('p', { class: 'muted' }, 'Räknar …'));
          try {
            const x = await get(`/api/advisor/clients/${id}/scenarios/${s.id}/run`);
            const months = x.scenario.points.map((p) => p.month);
            setKids(scenarioOut,
              h('h3', {}, `${x.name}, ${x.years} år`),
              x.scenario.first_shortfall ? h('div', { class: 'alert error' }, `Pengarna räcker inte från ${x.scenario.first_shortfall}.`) : null,
              h('div', { class: 'kpis' }, kpi('Eget kapital vid slutet', fmtSek(x.scenario.end.net_worth), `utan förändring ${fmtSek(x.base.end.net_worth)}`), kpi('Skillnad', fmtSek(x.delta_end), '', x.delta_end < 0 ? 'neg' : 'pos'), kpi('Räntekostnad totalt', fmtSek(x.scenario.total_interest))),
              h('div', { class: 'card flush' }, lineChart({ months, label: 'Eget kapital', series: [{ key: 'b', label: 'Utan förändring', className: 'l-base', values: x.base.points.map((p) => p.net_worth) }, { key: 's', label: x.name, className: 'l-scn', values: x.scenario.points.map((p) => p.net_worth) }] })),
            );
          } catch (e) {
            setKids(scenarioOut, h('div', { class: 'alert error' }, e.message));
          }
        } }, `${s.name} (${s.events} händelser)`)))
      : h('p', { class: 'muted' }, 'Kunden har inga sparade scenarier.'),
    scenarioOut,

    detail ? transactionsSection(id) : null,
    notesSection(id),
  );
}

function transactionsSection(id) {
  const out = h('div');
  const q = h('input', { id: 'adv-q', type: 'text', placeholder: 'Sök i texten' });
  let offset = 0;
  async function load(append) {
    const r = await get(`/api/advisor/clients/${id}/transactions${qs({ q: q.value, limit: 100, offset })}`);
    const rows = h('div', { class: 'card flush' }, dataTable({
      empty: 'Inga transaktioner.',
      rows: r.items,
      columns: [
        { label: 'Datum', class: 'nowrap', render: (t) => fmtDate(t.date) },
        { label: 'Text', render: (t) => t.description },
        { label: 'Konto', render: (t) => t.account },
        { label: 'Kategori', render: (t) => t.category || h('span', { class: 'muted' }, 'okategoriserad') },
        { label: 'Belopp', num: true, render: (t) => h('span', { class: t.amount < 0 ? 'neg' : 'pos' }, fmtSekExact(t.amount)) },
      ],
    }));
    const more = offset + r.items.length < r.total ? h('button', { class: 'btn mt-s', type: 'button', onclick: () => ((offset += 100), load(true)) }, 'Visa fler') : null;
    if (append) out.querySelector('.card')?.remove();
    setKids(out, h('p', { class: 'muted' }, `${r.total} transaktioner`), rows, more);
  }
  let timer;
  q.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => ((offset = 0), load(false)), 250);
  });
  load(false);
  return h('div', {}, h('h2', { id: 'adv-transaktioner', class: 'mt-l' }, 'Transaktioner'), q, out);
}

function notesSection(id) {
  const list = h('div');
  const input = h('textarea', { id: 'adv-note', rows: 3, maxlength: 4000, placeholder: 'Anteckning. Kunden ser den inte.' });
  async function load() {
    const { items } = await get(`/api/advisor/clients/${id}/notes`);
    setKids(list, items.length ? items.map((n) => h('div', { class: 'card' }, h('div', { class: 'small muted' }, n.created_at), h('p', { class: 'pre' }, n.body), h('button', { class: 'btn sm danger no-print', type: 'button', onclick: async () => { if (await confirmDialog('Ta bort anteckningen?', { danger: true, confirmLabel: 'Ta bort' })) { await del(`/api/advisor/clients/${id}/notes/${n.id}`); load(); } } }, 'Ta bort'))) : h('p', { class: 'muted' }, 'Inga anteckningar.'));
  }
  load().catch(() => {});
  return h('div', { class: 'no-print' },
    h('h2', { id: 'adv-anteckningar', class: 'mt-l' }, 'Anteckningar'),
    h('p', { class: 'muted small' }, 'Dina egna anteckningar. De stannar hos dig även när samtycket upphör, men kan då inte kompletteras. Du ansvarar själv för dokumentation och gallring enligt dina skyldigheter.'),
    input,
    h('div', { class: 'row mt-s' }, h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      if (!input.value.trim()) return;
      try {
        await post(`/api/advisor/clients/${id}/notes`, { body: input.value });
        input.value = '';
        load();
      } catch (e) {
        toast(e.message, 'error');
      }
    } }, 'Spara anteckning')),
    list,
  );
}
