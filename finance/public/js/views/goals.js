import { get, post, put, del } from '../api.js';
import { h, setKids, toast, editDialog, confirmDialog, fmtSek, fmtSekExact, fmtDate, fmtPct, parseKr, buildForm, openDialog } from '../dom.js';

const STATUS = {
  reached: ['Uppnått', 'approved'],
  on_track: ['På rätt väg', 'approved'],
  behind: ['Efter plan', 'warn'],
  overdue: ['Datumet har passerat', 'rejected'],
};

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

const fmtMonths = (n) => (n === null ? 'aldrig med nuvarande sparande' : n === 0 ? 'nu' : n >= 12 ? `om ${Math.floor(n / 12)} år${n % 12 ? ` ${n % 12} mån` : ''}` : `om ${n} mån`);

export async function renderGoals(root) {
  const mount = h('div');
  setKids(root, h('div', { class: 'row between' }, h('h1', {}, 'Mål'), h('button', { class: 'btn primary', type: 'button', onclick: () => goalDialog(null) }, 'Nytt mål')), mount);
  let accounts = [];

  async function load() {
    const [data, acc] = await Promise.all([get('/api/goals'), get('/api/accounts')]);
    accounts = acc.items.filter((a) => !['loan', 'credit'].includes(a.kind));
    const s = data.summary;
    const gap = s.surplus - s.required_monthly;
    setKids(
      mount,
      data.items.length
        ? h('div', { class: 'kpis' },
            kpi('Krävs per månad', fmtSek(s.required_monthly), 'för att nå alla mål i tid'),
            kpi('Planerat sparande', fmtSek(s.planned_monthly), 'summan av dina egna månadsbelopp'),
            kpi('Månadsöverskott', fmtSek(s.surplus), s.expenses_source === 'budget' ? 'enligt din budget' : s.expenses_source === 'history' ? 'enligt senaste månaderna' : 'okänt'),
            kpi('Marginal', fmtSek(gap), gap < 0 ? 'målen kräver mer än du har över' : 'kvar efter målen', gap < 0 ? 'neg' : 'pos'))
        : null,
      data.items.length && gap < 0 ? h('div', { class: 'alert warn' }, `Målen kräver ${fmtSek(s.required_monthly)} i månaden men överskottet är ${fmtSek(s.surplus)}. Något måste ge sig: datum, belopp eller utgifterna. Prova olika vägar under Scenarier.`) : null,
      data.items.length ? data.items.map(card) : h('div', { class: 'card' }, 'Inga mål än. Lägg till något du sparar till: kontantinsats, buffert, resa, pension.'),
      h('p', { class: 'muted small' }, 'Beräkningen räknar månadsvis ränta på ränta med avkastningen du anger per mål (annars hushållets ränta på kontanter). Inget är garanterat: avkastning på placeringar varierar och kan vara negativ.'),
    );
  }

  function card(g) {
    const [label, cls] = STATUS[g.status];
    const bar = h('div', { class: `bar-track ${g.status === 'reached' || g.status === 'on_track' ? 'ok' : g.status === 'overdue' ? 'over' : ''}`, role: 'img', 'aria-label': `${Math.round(g.progress * 100)} % av målet` }, h('span'));
    bar.firstChild.style.width = `${Math.round(g.progress * 100)}%`;
    return h('div', { class: 'card' },
      h('div', { class: 'row between' }, h('h2', {}, g.name), h('span', { class: `chip ${cls}` }, label)),
      h('p', { class: 'muted' }, `${fmtSek(g.current)} av ${fmtSek(g.target_amount)} (${fmtPct(g.progress)}), mål ${fmtDate(g.target_date)}`),
      bar,
      h('div', { class: 'kpis mt-m' },
        kpi('Krävs per månad', g.status === 'reached' ? '–' : fmtSek(g.needed_monthly), g.status === 'reached' ? '' : `${g.months_left} månader kvar`),
        kpi('Du sparar', fmtSek(g.monthly_contribution), `avkastning ${fmtPct(g.effective_return / 100, 1)} per år`),
        kpi('Förväntat vid måldatum', fmtSek(g.projected), g.shortfall ? `saknas ${fmtSek(g.shortfall)}` : 'målet nås', g.shortfall ? 'neg' : 'pos'),
        kpi('Målet nås', g.status === 'reached' ? 'redan' : fmtMonths(g.reached_in_months))),
      g.hidden_accounts ? h('p', { class: 'muted small' }, `${g.hidden_accounts} länkat konto är privat och räknas inte i din vy.`) : null,
      h('div', { class: 'row' },
        h('button', { class: 'btn sm', type: 'button', onclick: () => goalDialog(g) }, 'Ändra'),
        h('button', { class: 'btn sm danger', type: 'button', onclick: async () => { if (await confirmDialog(`Ta bort målet ${g.name}?`, { danger: true, confirmLabel: 'Ta bort' })) { await del(`/api/goals/${g.id}`); load(); } } }, 'Ta bort')),
    );
  }

  function goalDialog(g) {
    const checks = new Map();
    const list = h('div', { class: 'checklist' }, accounts.map((a) => {
      const box = h('input', { id: `ga-${a.id}`, type: 'checkbox', checked: !!g?.account_ids.includes(a.id) });
      checks.set(a.id, box);
      return h('label', { for: `ga-${a.id}` }, box, ` ${a.name} (${fmtSek(a.balance)})`);
    }));
    editDialog({
      title: g ? 'Ändra mål' : 'Nytt mål',
      wide: true,
      extra: h('div', { class: 'field' }, h('label', {}, 'Räkna in saldo och innehav på dessa konton'), list, h('div', { class: 'hint' }, 'Saldot på kontona (och värdepapper som ligger på dem) räknas som sparat. Lägg annars in ett belopp själv ovan.')),
      fields: [
        { name: 'name', label: 'Namn', required: true, maxlength: 80, full: true },
        { name: 'target_amount', label: 'Målbelopp (kr)', required: true },
        { name: 'target_date', label: 'Måldatum', type: 'date', required: true },
        { name: 'manual_amount', label: 'Redan sparat utöver kontona (kr)' },
        { name: 'monthly_contribution', label: 'Du sparar per månad (kr)' },
        { name: 'annual_return', label: 'Förväntad avkastning (% per år)', type: 'number', step: 'any', hint: 'Tomt = hushållets ränta på kontanter. Aktier och fonder är riskfyllda: välj ett försiktigt tal.' },
      ],
      values: g ? { ...g, target_amount: g.target_amount / 100, manual_amount: g.manual_amount / 100, monthly_contribution: g.monthly_contribution / 100, annual_return: g.annual_return ?? '' } : { monthly_contribution: '0', manual_amount: '0' },
      onSave: async (v) => {
        const money = (x, label, required = false) => {
          const n = parseKr(x);
          if (Number.isNaN(n) || (required && n === null)) throw new Error(`${label}: ange ett belopp i kronor.`);
          return n ?? 0;
        };
        const body = {
          name: v.name,
          target_amount: money(v.target_amount, 'Målbelopp', true),
          target_date: v.target_date,
          manual_amount: money(v.manual_amount, 'Redan sparat'),
          monthly_contribution: money(v.monthly_contribution, 'Sparande per månad'),
          annual_return: v.annual_return === '' ? null : v.annual_return,
          account_ids: [...checks].filter(([, box]) => box.checked).map(([id]) => id),
        };
        if (g) await put(`/api/goals/${g.id}`, body);
        else await post('/api/goals', body);
        toast('Sparat.', 'ok');
        load();
      },
    });
  }

  await load();
}
