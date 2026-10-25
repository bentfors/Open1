import { get, put } from '../api.js';
import { h, setKids, toast, dataTable, fmtSek, fmtSekExact, fmtMonth, parseKr, localToday } from '../dom.js';

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

const thisMonth = () => localToday().slice(0, 7);
const shiftMonth = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
};

export async function renderBudget(root) {
  let month = shiftMonth(thisMonth(), 0);
  const mount = h('div');
  setKids(root, h('h1', {}, 'Budget'), mount);

  async function show() {
    const [budget, status] = await Promise.all([get('/api/budget'), get(`/api/budget/status?month=${month}`)]);
    if (!budget.items.length) return empty();
    const pct = (a, b) => (b > 0 ? Math.min(1, a / b) : a > 0 ? 1 : 0);
    const overExpense = status.actual.expense > status.budget.expense;
    setKids(
      mount,
      h('div', { class: 'row between' },
        h('div', { class: 'row' },
          h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Föregående månad', onclick: () => ((month = shiftMonth(month, -1)), show()) }, '←'),
          h('strong', {}, fmtMonth(month)),
          h('button', { class: 'btn sm', type: 'button', 'aria-label': 'Nästa månad', onclick: () => ((month = shiftMonth(month, 1)), show()) }, '→')),
        h('button', { class: 'btn', type: 'button', onclick: () => edit(budget.items) }, 'Ändra budget')),
      h('div', { class: 'kpis mt-m' },
        kpi('Budgeterade utgifter', fmtSek(status.budget.expense), `utfall ${fmtSek(status.actual.expense)}`, overExpense ? 'neg' : ''),
        kpi('Kvar att spendera', fmtSek(status.budget.expense - status.actual.expense), status.elapsed > 0 && status.elapsed < 1 ? `${Math.round(status.elapsed * 100)} % av månaden har gått` : '', status.budget.expense - status.actual.expense < 0 ? 'neg' : 'pos'),
        kpi('Budgeterat överskott', fmtSek(budget.surplus), `inkomst ${fmtSek(budget.income)} − utgifter ${fmtSek(budget.expense)}`),
        kpi('Faktiskt resultat', fmtSek(status.actual.income - status.actual.expense), 'hittills i månaden', status.actual.income - status.actual.expense < 0 ? 'neg' : 'pos')),
      h('div', { class: 'card flush' }, dataTable({
        rows: status.items,
        columns: [
          { label: 'Kategori', render: (r) => h('span', {}, r.category, r.budget === 0 ? h('span', { class: 'chip warn ml-s' }, 'ej budgeterad') : null) },
          { label: 'Typ', render: (r) => (r.kind === 'income' ? 'Inkomst' : 'Utgift') },
          { label: 'Budget', num: true, render: (r) => fmtSekExact(r.budget) },
          { label: 'Utfall', num: true, render: (r) => fmtSekExact(r.actual) },
          { label: 'Avvikelse', num: true, render: (r) => h('span', { class: r.diff < 0 ? 'neg' : 'pos' }, fmtSekExact(r.diff)) },
          { label: '', render: (r) => h('div', { class: `bar-track ${r.kind === 'expense' && r.actual > r.budget ? 'over' : r.kind === 'income' && r.actual >= r.budget ? 'ok' : ''}`, role: 'img', 'aria-label': `${Math.round(pct(r.actual, r.budget) * 100)} % av budget` }, h('span')) },
        ],
      })),
      h('p', { class: 'muted small' }, 'Utfallet kommer från dina importerade kontoutdrag. Okategoriserade transaktioner syns inte här förrän de har en kategori. Överföringar ingår aldrig.'),
    );
    // Fyll stapellängden via DOM-egenskap (inline style via attribut stoppas av CSP, men CSSOM tillåts)
    mount.querySelectorAll('.bar-track').forEach((el, i) => {
      const r = status.items[i];
      el.firstChild.style.width = `${Math.round(pct(r.actual, r.budget) * 100)}%`;
    });
  }

  function empty() {
    setKids(
      mount,
      h('div', { class: 'card' },
        h('p', {}, 'Du har ingen budget än. Det snabbaste sättet är att utgå från hur du faktiskt har levt de senaste månaderna, och sedan justera.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn primary', type: 'button', onclick: () => edit([], true) }, 'Föreslå budget utifrån mina utgifter'),
          h('button', { class: 'btn', type: 'button', onclick: () => edit([], false) }, 'Börja från noll'))),
    );
  }

  // Redigeraren sparar inget förrän du trycker Spara. Förslaget laddas in som utkast.
  async function edit(current, suggest = false) {
    const cats = (await get('/api/categories')).items.filter((c) => c.kind !== 'transfer');
    const values = new Map(current.map((l) => [l.category_id, l.amount]));
    let note = null;
    if (suggest) {
      const s = await get('/api/budget/suggest');
      if (!s.lines.length) note = h('div', { class: 'alert warn' }, 'Det finns inga avslutade månader med kategoriserade transaktioner att utgå från än. Importera kontoutdrag och kategorisera dem, eller skriv in en budget för hand.');
      else {
        for (const l of s.lines) values.set(l.category_id, l.amount);
        note = h('div', { class: 'alert' }, `Förslag baserat på ${s.months.length} ${s.months.length === 1 ? 'månad' : 'månader'} (${s.method === 'median' ? 'typvärde per månad, så en enstaka stor kostnad slår inte igenom' : 'medelvärde, eftersom det finns färre än tre månader'}). Utgifter är avrundade uppåt till närmaste hundralapp. Justera fritt, inget är sparat än.`);
      }
    }
    const inputs = new Map();
    const total = h('div', { class: 'kpis' });
    const recalc = () => {
      let inc = 0;
      let exp = 0;
      for (const c of cats) {
        const v = parseKr(inputs.get(c.id).value);
        if (v && !Number.isNaN(v)) (c.kind === 'income' ? (inc += v) : (exp += v));
      }
      setKids(total, kpi('Inkomster', fmtSek(inc)), kpi('Utgifter', fmtSek(exp)), kpi('Överskott', fmtSek(inc - exp), '', inc - exp < 0 ? 'neg' : 'pos'));
    };
    const section = (kind, title) =>
      h('div', { class: 'card' }, h('h3', {}, title),
        h('div', { class: 'form-grid' }, cats.filter((c) => c.kind === kind).map((c) => {
          const input = h('input', { id: `b-${c.id}`, type: 'text', inputmode: 'decimal', value: values.has(c.id) ? String(values.get(c.id) / 100).replace('.', ',') : '', placeholder: '0', oninput: recalc });
          inputs.set(c.id, input);
          return h('div', { class: 'field' }, h('label', { for: `b-${c.id}` }, `${c.name} (kr/mån)`), input);
        })));
    const error = h('div', { class: 'alert error hidden' });
    setKids(
      mount,
      note,
      error,
      section('income', 'Inkomster per månad (efter skatt)'),
      section('expense', 'Utgifter per månad'),
      total,
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', type: 'button', onclick: async () => {
          const lines = [];
          for (const c of cats) {
            const v = parseKr(inputs.get(c.id).value);
            if (Number.isNaN(v)) {
              error.textContent = `${c.name}: ange ett belopp i kronor, till exempel 2 500 eller 2500,50.`;
              error.classList.remove('hidden');
              return;
            }
            if (v) lines.push({ category_id: c.id, amount: v });
          }
          try {
            await put('/api/budget', { lines });
            toast('Budgeten är sparad.', 'ok');
            show();
          } catch (e) {
            error.textContent = e.message;
            error.classList.remove('hidden');
          }
        } }, 'Spara budget'),
        h('button', { class: 'btn', type: 'button', onclick: () => show() }, 'Avbryt'),
        !suggest ? h('button', { class: 'btn', type: 'button', onclick: () => edit(current, true) }, 'Ladda förslag från utfall') : null),
    );
    recalc();
  }

  await show();
}
