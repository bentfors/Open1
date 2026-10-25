import { get, post, put, del } from '../api.js';
import { h, setKids, toast, confirmDialog, fmtSek, fmtSekExact, fmtDate, fmtPct, fmtNum, parseKr, dataTable } from '../dom.js';
import { lineChart } from './charts.js';

const kpi = (label, value, note, cls = '') => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: `value ${cls}` }, value), note ? h('div', { class: 'small muted' }, note) : null);

const MONTH = new Intl.DateTimeFormat('sv-SE', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const fmtYm = (ym) => MONTH.format(new Date(`${ym}-01T00:00:00Z`));
const nextYear = () => `${new Date().getFullYear() + 1}-01`;

// Förifyllda gissningar som användaren ska byta mot sina egna siffror.
const TEMPLATES = {
  house: { type: 'purchase', name: 'Nytt hus', kind: 'home', date: nextYear(), sell_date: '', price: '', down_payment: '', loan_rate: '4', amortization_years: '50', monthly_costs: '4000', one_off_costs: '0', asset_growth: '2' },
  boat: { type: 'purchase', name: 'Båt', kind: 'other', date: nextYear(), sell_date: '', price: '', down_payment: '', loan_rate: '6', amortization_years: '10', monthly_costs: '2000', one_off_costs: '0', asset_growth: '-8' },
  one_off: { type: 'one_off', name: 'Engångsbelopp', date: nextYear(), amount: '' },
  monthly: { type: 'monthly', name: 'Ändrad månadsinkomst', from: nextYear(), to: '', amount: '' },
};

const num = (v, label) => {
  const n = Number(String(v).trim().replace(/\s/g, '').replace(',', '.'));
  if (String(v).trim() === '' || !Number.isFinite(n)) throw new Error(`${label}: ange ett tal.`);
  return n;
};
const money = (v, label, { optional = false } = {}) => {
  const n = parseKr(v);
  if (n === null && optional) return 0;
  if (n === null || Number.isNaN(n)) throw new Error(`${label}: ange ett belopp i kronor.`);
  return n;
};
const ym = (v, label) => {
  if (!/^\d{4}-\d{2}$/.test(v || '')) throw new Error(`${label}: välj månad och år.`);
  return v;
};

function toApi(e, n) {
  const at = `${e.name || `Händelse ${n}`}`;
  if (e.type === 'purchase') {
    return { type: 'purchase', name: e.name, kind: e.kind, date: ym(e.date, `${at}, köpmånad`), sell_date: e.sell_date ? ym(e.sell_date, `${at}, försäljning`) : null, price: money(e.price, `${at}, pris`), down_payment: money(e.down_payment, `${at}, kontantinsats`), loan_rate: num(e.loan_rate || 0, `${at}, ränta`), amortization_years: num(e.amortization_years || 0, `${at}, amorteringstid`), monthly_costs: money(e.monthly_costs, `${at}, månadskostnad`, { optional: true }), one_off_costs: money(e.one_off_costs, `${at}, engångskostnader`, { optional: true }), asset_growth: num(e.asset_growth || 0, `${at}, värdeutveckling`) };
  }
  if (e.type === 'one_off') return { type: 'one_off', name: e.name, date: ym(e.date, `${at}, månad`), amount: money(e.amount, `${at}, belopp`) };
  return { type: 'monthly', name: e.name, from: ym(e.from, `${at}, från`), to: e.to ? ym(e.to, `${at}, till`) : null, amount: money(e.amount, `${at}, belopp`) };
}

const fromApi = (e) => {
  const kr = (o) => String(o / 100).replace('.', ',');
  if (e.type === 'purchase') return { ...e, sell_date: e.sell_date || '', price: kr(e.price), down_payment: kr(e.down_payment), monthly_costs: kr(e.monthly_costs), one_off_costs: kr(e.one_off_costs), loan_rate: String(e.loan_rate), amortization_years: String(e.amortization_years), asset_growth: String(e.asset_growth) };
  if (e.type === 'one_off') return { ...e, amount: kr(e.amount) };
  return { ...e, to: e.to || '', amount: kr(e.amount) };
};

export async function renderScenarios(root) {
  let saved = (await get('/api/scenarios')).items;
  let draft = { id: null, name: 'Nytt scenario', years: 20, events: [], overrides: { income: '', expenses: '', return_rate: '' } };
  const nav = h('div', { class: 'list-nav' });
  const editor = h('div');
  const results = h('div');
  setKids(root, h('h1', {}, 'Scenarier'), h('p', { class: 'muted' }, 'Lägg till det du funderar på och se vad det gör med din ekonomi jämfört med att inte göra något. Allt räknas från din ekonomi idag, din budget och antagandena under Inställningar.'), h('div', { class: 'split' }, nav, h('div', {}, editor, results)));

  function drawNav() {
    setKids(
      nav,
      h('button', { class: 'btn', type: 'button', 'aria-current': String(draft.id === null), onclick: () => select(null) }, '+ Nytt scenario'),
      saved.map((s) => h('button', { class: 'btn', type: 'button', 'aria-current': String(draft.id === s.id), onclick: () => select(s) }, s.name)),
    );
  }

  function select(s) {
    draft = s
      ? { id: s.id, name: s.name, years: s.horizon_years, events: s.events.map(fromApi), overrides: { income: '', expenses: '', return_rate: '' } }
      : { id: null, name: 'Nytt scenario', years: 20, events: [], overrides: { income: '', expenses: '', return_rate: '' } };
    setKids(results);
    drawNav();
    drawEditor();
    if (s) run();
  }

  function field(label, obj, key, { type = 'text', hint, placeholder, id } = {}) {
    const fid = id || `sc-${Math.random().toString(36).slice(2, 8)}`;
    const input = h('input', { id: fid, type, value: obj[key] ?? '', placeholder, oninput: () => (obj[key] = input.value), autocomplete: 'off' });
    return h('div', { class: 'field' }, h('label', { for: fid }, label), input, hint ? h('div', { class: 'hint' }, hint) : null);
  }

  function eventCard(e, i) {
    const remove = h('button', { class: 'btn sm danger', type: 'button', onclick: () => { draft.events.splice(i, 1); drawEditor(); } }, 'Ta bort');
    let body;
    if (e.type === 'purchase') {
      const kind = h('select', { id: `k-${i}`, onchange: () => (e.kind = kind.value) }, h('option', { value: 'home', selected: e.kind === 'home' }, 'Bostad'), h('option', { value: 'other', selected: e.kind !== 'home' }, 'Annat (båt, bil, …)'));
      body = h('div', { class: 'form-grid' },
        field('Namn', e, 'name'),
        h('div', { class: 'field' }, h('label', { for: `k-${i}` }, 'Typ'), kind),
        field('Köpmånad', e, 'date', { type: 'month' }),
        field('Pris (kr)', e, 'price', { hint: 'Totalt, inklusive det du lånar' }),
        field('Kontantinsats (kr)', e, 'down_payment', { hint: 'Tas från kontanter, sedan från placeringar' }),
        field('Låneränta (% per år)', e, 'loan_rate'),
        field('Amorteringstid (år)', e, 'amortization_years', { hint: '0 = ingen amortering' }),
        field('Löpande kostnad (kr/mån)', e, 'monthly_costs', { hint: 'Drift, försäkring, plats, skatt' }),
        field('Engångskostnader vid köp (kr)', e, 'one_off_costs', { hint: 'Lagfart, pantbrev, utrustning' }),
        field('Värdeutveckling (% per år)', e, 'asset_growth', { hint: 'Negativ för det som tappar i värde' }),
        field('Säljs (valfritt)', e, 'sell_date', { type: 'month', hint: 'Lånet betalas av försäljningen' }),
      );
    } else if (e.type === 'one_off') {
      body = h('div', { class: 'form-grid' }, field('Namn', e, 'name'), field('Månad', e, 'date', { type: 'month' }), field('Belopp (kr)', e, 'amount', { hint: 'Minus för utgift, till exempel −250 000' }));
    } else {
      body = h('div', { class: 'form-grid' }, field('Namn', e, 'name'), field('Från', e, 'from', { type: 'month' }), field('Till (valfritt)', e, 'to', { type: 'month' }), field('Belopp (kr per månad)', e, 'amount', { hint: 'Minus för minskad inkomst eller ökad utgift' }));
    }
    const title = { purchase: 'Köp', one_off: 'Engångsbelopp', monthly: 'Löpande förändring' }[e.type];
    return h('div', { class: 'event-card' }, h('div', { class: 'row between' }, h('h3', {}, `${i + 1}. ${title}`), remove), body);
  }

  function drawEditor() {
    const add = (key) => () => {
      draft.events.push({ ...TEMPLATES[key] });
      drawEditor();
    };
    setKids(
      editor,
      h('div', { class: 'card' },
        h('div', { class: 'form-grid' }, field('Namn på scenariot', draft, 'name', { id: 'sc-name' }), field('Räkna framåt (år)', draft, 'years', { type: 'number', id: 'sc-years' })),
        draft.events.length ? draft.events.map(eventCard) : h('p', { class: 'muted' }, 'Inga händelser än. Utan händelser visas bara hur det ser ut om inget förändras.'),
        h('div', { class: 'row' },
          h('span', { class: 'muted small' }, 'Lägg till:'),
          h('button', { class: 'btn sm', type: 'button', onclick: add('house') }, 'Hus'),
          h('button', { class: 'btn sm', type: 'button', onclick: add('boat') }, 'Båt eller annat köp'),
          h('button', { class: 'btn sm', type: 'button', onclick: add('one_off') }, 'Engångsbelopp'),
          h('button', { class: 'btn sm', type: 'button', onclick: add('monthly') }, 'Ändrad månadsinkomst/-utgift')),
        draft.events.some((e) => e.type === 'purchase') ? h('p', { class: 'muted small' }, 'Räntor, amorteringstid, löpande kostnader och värdeutveckling är förifyllda gissningar. Byt mot dina egna siffror.') : null,
        h('details', { class: 'mt-m' },
          h('summary', {}, 'Räkna med andra grundvärden än din ekonomi idag'),
          h('div', { class: 'form-grid mt-s' }, field('Inkomst per månad efter skatt (kr)', draft.overrides, 'income', { placeholder: 'din budget eller historik' }), field('Utgifter per månad (kr)', draft.overrides, 'expenses', { placeholder: 'din budget eller historik' }), field('Avkastning på placeringar (% per år)', draft.overrides, 'return_rate', { placeholder: 'hushållets antagande' }))),
        h('div', { class: 'row mt-m' },
          h('button', { class: 'btn primary', type: 'button', onclick: run }, 'Räkna'),
          h('button', { class: 'btn', type: 'button', onclick: save }, draft.id ? 'Spara ändringar' : 'Spara scenario'),
          draft.id ? h('button', { class: 'btn danger', type: 'button', onclick: remove }, 'Ta bort') : null)),
    );
  }

  function request() {
    const years = Number(draft.years);
    if (!Number.isInteger(years) || years < 1 || years > 40) throw new Error('Räkna framåt 1–40 hela år.');
    const events = draft.events.map((e, i) => toApi(e, i + 1));
    const o = draft.overrides;
    const overrides = {};
    if (String(o.income).trim() !== '') overrides.income = money(o.income, 'Inkomst');
    if (String(o.expenses).trim() !== '') overrides.expenses = money(o.expenses, 'Utgifter');
    if (String(o.return_rate).trim() !== '') overrides.return_rate = num(o.return_rate, 'Avkastning');
    return { years, events, overrides, name: draft.name };
  }

  async function save() {
    try {
      const r = request();
      const body = { name: r.name, horizon_years: r.years, events: r.events };
      if (draft.id) await put(`/api/scenarios/${draft.id}`, body);
      else draft.id = (await post('/api/scenarios', body)).id;
      saved = (await get('/api/scenarios')).items;
      toast('Scenariot är sparat.', 'ok');
      drawNav();
      drawEditor();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function remove() {
    if (!(await confirmDialog(`Ta bort scenariot ${draft.name}?`, { danger: true, confirmLabel: 'Ta bort' }))) return;
    await del(`/api/scenarios/${draft.id}`);
    saved = (await get('/api/scenarios')).items;
    select(null);
  }

  async function run() {
    let r;
    try {
      r = request();
    } catch (e) {
      return setKids(results, h('div', { class: 'alert error' }, e.message));
    }
    setKids(results, h('p', { class: 'muted' }, 'Räknar …'));
    try {
      show(await post('/api/plan/run', { years: r.years, events: r.events, overrides: r.overrides }), r);
    } catch (e) {
      setKids(results, h('div', { class: 'alert error' }, e.message));
    }
  }

  function show(d, req) {
    const months = d.scenario.points.map((p) => p.month);
    const hasEvents = req.events.length > 0;
    const costNow = d.purchases.reduce((n, p) => n + p.now.total, 0);
    const costStress = d.purchases.reduce((n, p) => n + p.stressed.total, 0);
    const inp = d.inputs;
    const series = [{ key: 'base', label: 'Om inget förändras', className: 'l-base', values: d.base.points.map((p) => p.net_worth) }];
    if (hasEvents) {
      series.push({ key: 'scn', label: draft.name, className: 'l-scn', values: d.scenario.points.map((p) => p.net_worth) });
      if (d.purchases.length) series.push({ key: 'stress', label: 'Räntan +2 procentenheter', className: 'l-stress', values: d.stress.points.map((p) => p.net_worth) });
    }
    const delta = d.delta_end;
    setKids(
      results,
      h('h2', { class: 'mt-l' }, 'Resultat'),
      d.scenario.first_shortfall ? h('div', { class: 'alert error' }, `Pengarna räcker inte. Från ${fmtYm(d.scenario.first_shortfall)} är både kontanter och placeringar slut, så du behöver låna mer, spara mer eller skjuta på något.`) : null,
      !d.scenario.first_shortfall && d.stress.first_shortfall ? h('div', { class: 'alert warn' }, `Klarar du det om räntan stiger? Med två procentenheter högre ränta räcker pengarna inte från ${fmtYm(d.stress.first_shortfall)}.`) : null,
      d.warnings.map((w) => h('div', { class: 'alert warn' }, w)),
      h('div', { class: 'kpis' },
        kpi(`Eget kapital om ${req.years} år`, fmtSek(d.scenario.end.net_worth), hasEvents ? `utan förändring ${fmtSek(d.base.end.net_worth)}` : ''),
        hasEvents ? kpi('Skillnad mot att inget göra', `${delta > 0 ? '+' : ''}${fmtSek(delta)}`, `efter ${req.years} år`, delta < 0 ? 'neg' : 'pos') : null,
        d.purchases.length ? kpi('Kostnad per månad i början', fmtSek(costNow), `ränta, amortering och löpande. Räntan +2 punkter: ${fmtSek(costStress)}`) : null,
        d.scenario.peak_debt_ratio > 0 ? kpi('Högsta skuldkvot', fmtNum(d.scenario.peak_debt_ratio, 1).replace(/\s/g, ' ') + ' ×', 'skulder / årsinkomst efter skatt') : null,
        kpi('Räntekostnad totalt', fmtSek(d.scenario.total_interest), `under ${req.years} år`)),
      h('div', { class: 'card flush' }, lineChart({ months, series, label: 'Eget kapital över tid' })),
      h('h3', { class: 'mt-m' }, 'Nyckeltal över tid'),
      h('div', { class: 'card flush' }, dataTable({
        rows: d.scenario.milestones,
        columns: [
          { label: 'Om', render: (m) => `${m.years} år` },
          { label: 'Eget kapital', num: true, render: (m) => fmtSek(m.net_worth) },
          ...(hasEvents ? [{ label: 'Utan förändring', num: true, render: (m) => fmtSek(d.base.points[m.years * 12 - 1].net_worth) }] : []),
          { label: 'Skulder', num: true, render: (m) => fmtSek(m.debts) },
          { label: 'Kontanter och placeringar', num: true, render: (m) => fmtSek(m.cash + m.invested) },
        ],
      })),
      d.scenario.sold.length ? h('p', { class: 'muted small' }, d.scenario.sold.map((s) => `${s.name} säljs ${fmtYm(s.month)} för ${fmtSek(s.value)}, varav ${fmtSek(s.loan_repaid)} går till lånet.`).join(' ')) : null,
      h('details', { class: 'mt-m' },
        h('summary', {}, 'Vad räknas med?'),
        h('ul', { class: 'warn-list' },
          h('li', {}, `Start: kontanter ${fmtSek(inp.start.cash)}, placeringar ${fmtSek(inp.start.invested)}, övriga tillgångar ${fmtSek(inp.start.fixed)}, skulder ${fmtSek(inp.start.debts.reduce((n, x) => n + x.balance, 0))}.`),
          h('li', {}, `Inkomst ${fmtSek(inp.baseline.income)} per månad (${{ budget: 'från budgeten', history: `snitt av ${inp.baseline.history_months} månader`, none: 'okänd' }[inp.baseline.income_source] || 'angiven av dig'}), utgifter ${fmtSek(inp.baseline.expenses)} (${{ budget: 'från budgeten', history: 'snitt av senaste månaderna', none: 'okända' }[inp.baseline.expenses_source] || 'angivna av dig'}).${inp.baseline.excluded_interest ? ' Låneräntor räknas separat från lånens villkor.' : ''}`),
          h('li', {}, `Avkastning placeringar ${fmtPct(inp.assumptions.return_rate / 100, 1)}, ränta kontanter ${fmtPct(inp.assumptions.cash_rate / 100, 1)}, övriga tillgångar ${fmtPct(inp.assumptions.fixed_growth / 100, 1)}, inflation ${fmtPct(inp.assumptions.inflation / 100, 1)} per år. Ändra under Inställningar.`),
          h('li', {}, 'Allt är nominellt: inkomster och utgifter följer inflationen, lånebetalningar gör det inte. Skatt, bidrag och ränteavdrag är inte modellerade, och inkomsten är det som sätts in på kontot.'))),
      h('p', { class: 'muted small' }, 'Det här är en räkneövning på antaganden, inte en förutsägelse eller ett råd. Små ändringar i avkastning, ränta och värdeutveckling ger stora skillnader över tio år eller mer.'),
    );
  }

  drawNav();
  drawEditor();
}
