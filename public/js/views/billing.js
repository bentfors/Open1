import { get, post, put, del, patch, qs } from '../api.js';
import { state, isFinanceSuper } from '../state.js';
import { h, add, setKids, fmtMoney, fmtNum, fmtDate, fmtMonth, toast, editDialog, openDialog, confirmDialog, promptDialog, dataTable, localToday } from '../dom.js';

const KIND_LABEL = { time: 'Tid', expense: 'Utlägg', mileage: 'Körning' };

function subnav(active) {
  return h(
    'div',
    { class: 'subnav' },
    h('a', { href: '#/fakturering', 'aria-current': active === 'att' ? 'page' : null }, 'Att fakturera'),
    h('a', { href: '#/fakturering/manad', 'aria-current': active === 'manad' ? 'page' : null }, 'Månadsfakturering'),
    h('a', { href: '#/fakturering/underlag', 'aria-current': active === 'underlag' ? 'page' : null }, 'Skapade underlag'),
    isFinanceSuper() ? h('a', { href: '#/fakturering/lon', 'aria-current': active === 'lon' ? 'page' : null }, 'Löneunderlag') : null,
    h('a', { href: '#/fakturering/underkonsulter', 'aria-current': active === 'underkonsulter' ? 'page' : null }, 'Underkonsulter'),
    isFinanceSuper() ? h('a', { href: '#/fakturering/budget', 'aria-current': active === 'budget' ? 'page' : null }, 'Budget') : null,
    h('a', { href: '#/fakturering/lasning', 'aria-current': active === 'lasning' ? 'page' : null }, 'Periodlåsning'),
  );
}

// De senaste 13 månaderna, nyast först. Förvald är förra månaden, som lön och inköp normalt gäller.
function monthChoices() {
  const now = new Date();
  return Array.from({ length: 13 }, (_, i) => {
    const d = new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1));
    return d.toISOString().slice(0, 7);
  });
}

function monthPicker(id, value, onchange) {
  const el = h('select', { id, onchange: (e) => onchange(e.target.value) }, monthChoices().map((m) => h('option', { value: m, selected: m === value }, fmtMonth(m))));
  return h('div', { class: 'field' }, h('label', { for: id }, 'Månad'), el);
}

const PAY_TYPE = { monthly: 'Månadslön', hourly: 'Timlön', subcontractor: 'Underkonsult' };

// ── Månadsfakturering ──────────────────────────────────────────────────
async function monthlyView(root) {
  let month = monthChoices()[1];
  let includeOlder = true;
  const selected = new Set();
  const result = h('div', { class: 'stack' });
  const created = h('div');
  const dateInput = h('input', { id: 'm-date', type: 'date', value: localToday() });
  let data = null;

  async function load() {
    try {
      data = await get(`/api/billing/month${qs({ month, include_older: includeOlder ? '' : '0' })}`);
      selected.clear();
      for (const r of data.rows) if (r.ready > 0) selected.add(r.customer_id);
      draw();
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  function draw() {
    const t = data.totals;
    const chosen = data.rows.filter((r) => selected.has(r.customer_id));
    const sum = round(chosen.reduce((s, r) => s + r.ready, 0));
    const toggle = (r) => h('input', { type: 'checkbox', 'aria-label': `Fakturera ${r.customer_name}`, checked: selected.has(r.customer_id), disabled: !r.ready, onchange: (e) => { if (e.target.checked) selected.add(r.customer_id); else selected.delete(r.customer_id); draw(); } });
    const createBtn = h('button', { class: 'btn primary', type: 'button', disabled: !chosen.length, onclick: () => createAll(chosen, sum) }, chosen.length ? `Skapa ${chosen.length} underlag (${fmtMoney(sum)})` : 'Välj kunder');
    setKids(
      result,
      t.waiting || t.draft_hours
        ? h(
            'div',
            { class: 'alert warn' },
            `I ${fmtMonth(month)} finns ${t.waiting ? `${fmtMoney(t.waiting)} som väntar på attest` : ''}${t.waiting && t.draft_hours ? ' och ' : ''}${t.draft_hours ? `${fmtNum(t.draft_hours)} debiterbara timmar som inte är inskickade` : ''}. Det kommer inte med nu men ligger kvar till nästa gång. `,
            h('a', { href: '#/rapporter/inrapportering' }, 'Se inrapporteringen'),
            '.',
          )
        : h('div', { class: 'alert ok' }, `All debiterbar tid i ${fmtMonth(month)} är attesterad.`),
      h(
        'div',
        { class: 'kpis' },
        kpi('Att fakturera', fmtMoney(t.ready), t.older ? h('div', { class: 'small muted' }, `varav ${fmtMoney(t.older)} från tidigare månader`) : null),
        kpi('Kunder', String(t.customers)),
        kpi('Väntar på attest', fmtMoney(t.waiting)),
        kpi('Fastpris, timmar', fmtNum(t.fixed_hours), h('div', { class: 'small muted' }, 'faktureras separat')),
      ),
      h(
        'div',
        { class: 'card flush' },
        dataTable({
          rows: data.rows,
          empty: `Inget att fakturera för ${fmtMonth(month)}.`,
          columns: [
            { label: '', class: 'check', render: toggle },
            { label: 'Kund', render: (r) => [h('a', { href: `#/fakturering/kund/${r.customer_id}` }, r.customer_name), r.ext_no ? h('div', { class: 'small muted' }, `kundnr ${r.ext_no}`) : null] },
            { label: 'Projekt', num: true, render: (r) => r.projects || '' },
            { label: 'Att fakturera', num: true, render: (r) => (r.ready ? h('strong', {}, fmtMoney(r.ready)) : '') },
            { label: 'Varav äldre', num: true, render: (r) => (r.older ? fmtMoney(r.older) : '') },
            { label: 'Väntar på attest', num: true, render: (r) => (r.waiting ? h('span', { class: 'chip submitted' }, fmtMoney(r.waiting)) : '') },
            { label: 'Ej inskickat', num: true, render: (r) => (r.draft_hours ? h('span', { class: 'chip warn' }, `${fmtNum(r.draft_hours)} h`) : '') },
            { label: 'Fastpris', num: true, render: (r) => (r.fixed_hours ? `${fmtNum(r.fixed_hours)} h` : '') },
          ],
          footer: (c, i) => ['', 'Valt', '', fmtMoney(sum), '', '', '', ''][i],
        }),
        h('div', { class: 'sticky-actions' }, h('div', { class: 'field' }, h('label', { for: 'm-date' }, 'Fakturadatum'), dateInput), h('span', { class: 'spacer' }), createBtn),
      ),
    );
  }

  async function createAll(chosen, sum) {
    if (!(await confirmDialog(`Skapa ${chosen.length} fakturaunderlag på totalt ${fmtMoney(sum)} för ${fmtMonth(month)}? Varje kund får ett underlag med allt som är godkänt.`, { confirmLabel: 'Skapa underlag' }))) return;
    try {
      const r = await post('/api/billing/month', { month, invoice_date: dateInput.value || undefined, include_older: includeOlder, customer_ids: chosen.map((c) => c.customer_id) });
      toast(`${r.created.length} underlag skapade, ${fmtMoney(r.total)}.`, 'ok');
      setKids(
        created,
        h(
          'div',
          { class: 'card flush' },
          h('div', { class: 'group-head' }, `Skapade ${fmtDate(localToday())}`),
          dataTable({
            rows: r.created,
            columns: [
              { label: 'Kund', render: (c) => c.customer_name },
              { label: 'Nummer', render: (c) => c.number },
              { label: 'Belopp', num: true, render: (c) => fmtMoney(c.total) },
              { label: '', class: 'actions', render: (c) => h('a', { class: 'btn sm', href: `/api/invoices/${c.id}?format=csv` }, 'CSV') },
            ],
          }),
        ),
      );
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const older = h('input', { id: 'm-older', type: 'checkbox', checked: true, onchange: (e) => { includeOlder = e.target.checked; load(); } });
  add(
    root,
    h('h1', {}, 'Ekonomi'),
    subnav('manad'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, monthPicker('m-month', month, (v) => { month = v; load(); }), h('div', { class: 'field check' }, h('label', { for: 'm-older' }, older, 'Ta med ofakturerat från tidigare månader')))),
    created,
    result,
    h('p', { class: 'muted small' }, 'Ett underlag per kund med allt godkänt och debiterbart på löpande räkning till och med månadens slut. Det som väntar på attest eller inte är inskickat ligger kvar till nästa gång. Fastprisprojekt faktureras separat. Vill du välja rad för rad, öppna kunden.'),
  );
  await load();
}

// ── Budget ─────────────────────────────────────────────────────────────
const neg = (n) => h('span', { class: n < 0 ? 'neg' : '' }, fmtMoney(n));

async function budgetView(root) {
  const thisYear = new Date().getFullYear();
  let year = thisYear;
  let kst = '';
  const costCenters = await get('/api/cost-centers');
  const result = h('div', { class: 'stack' });
  const editBtn = h('button', { class: 'btn', type: 'button', onclick: () => edit() }, 'Ändra budget');
  let data = null;

  async function load() {
    try {
      data = await get(`/api/budget${qs({ year, kst })}`);
      editBtn.disabled = kst === '';
      editBtn.title = kst === '' ? 'Välj ett kostnadsställe för att ändra dess budget.' : '';
      draw();
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  function draw() {
    const t = data.totals;
    const outcomeCell = (r, key) => {
      const main = r.state === 'past' ? fmtMoney(r.outcome[key]) : h('em', { title: 'Prognos enligt avtalsregistret' }, fmtMoney(r.outcome[key]));
      const sofar = r.state === 'current' ? h('div', { class: 'small muted' }, `utfall hittills ${fmtMoney(r.actual[key])}`) : null;
      return [main, sofar];
    };
    setKids(
      result,
      h(
        'div',
        { class: 'kpis' },
        kpi('Intäkt, budget', fmtMoney(t.budget.revenue), h('div', { class: 'small muted' }, `helår ${year}`)),
        kpi('Intäkt, utfall + prognos', fmtMoney(t.outcome.revenue), h('div', { class: 'small muted' }, 'avvikelse ', neg(t.deviation.revenue))),
        kpi('TB, budget', fmtMoney(t.budget.margin)),
        kpi('TB, utfall + prognos', fmtMoney(t.outcome.margin), h('div', { class: 'small muted' }, 'avvikelse ', neg(t.deviation.margin))),
      ),
      h(
        'div',
        { class: 'card flush' },
        dataTable({
          rows: data.months,
          rowClass: (r) => (r.state === 'current' ? 'picked' : ''),
          columns: [
            { label: 'Månad', render: (r) => [fmtMonth(r.month), r.state === 'current' ? h('span', { class: 'chip accent' }, ' pågår') : null] },
            { label: 'Intäkt budget', num: true, render: (r) => (r.budget.revenue ? fmtMoney(r.budget.revenue) : h('span', { class: 'muted' }, '–')) },
            { label: 'Intäkt utfall / prognos', num: true, render: (r) => outcomeCell(r, 'revenue') },
            { label: 'Avvikelse', num: true, render: (r) => neg(r.deviation.revenue) },
            { label: 'TB budget', num: true, render: (r) => (r.budget.margin ? fmtMoney(r.budget.margin) : h('span', { class: 'muted' }, '–')) },
            { label: 'TB utfall / prognos', num: true, render: (r) => outcomeCell(r, 'margin') },
            { label: 'Avvikelse', num: true, render: (r) => neg(r.deviation.margin) },
          ],
          footer: (c, i) => ['Helår', fmtMoney(t.budget.revenue), fmtMoney(t.outcome.revenue), neg(t.deviation.revenue), fmtMoney(t.budget.margin), fmtMoney(t.outcome.margin), neg(t.deviation.margin)][i],
        }),
      ),
    );
  }

  function edit() {
    const name = kst === '0' ? 'utan kostnadsställe' : costCenters.find((c) => String(c.id) === kst)?.name;
    const inputs = data.months.map((r) => ({
      month: r.month,
      revenue: h('input', { type: 'number', step: '1000', min: '0', value: r.budget.revenue, 'aria-label': `Intäkt ${r.month}` }),
      margin: h('input', { type: 'number', step: '1000', value: r.budget.margin, 'aria-label': `TB ${r.month}` }),
    }));
    const yearRevenue = h('input', { type: 'number', step: '1000', min: '0', placeholder: 'Intäkt helår', 'aria-label': 'Intäkt helår' });
    const yearMargin = h('input', { type: 'number', step: '1000', placeholder: 'TB helår', 'aria-label': 'TB helår' });
    const spread = h('button', {
      class: 'btn sm',
      type: 'button',
      onclick: () => {
        // Jämnt per månad, med öresavrundning lagd på december så att summan blir exakt.
        for (const [input, key] of [[yearRevenue, 'revenue'], [yearMargin, 'margin']]) {
          if (input.value === '') continue;
          const total = Number(input.value);
          const each = Math.round((total / 12) * 100) / 100;
          inputs.forEach((x, i) => (x[key].value = i < 11 ? each : Math.round((total - each * 11) * 100) / 100));
        }
      },
    }, 'Fördela jämnt');
    const error = h('div', { class: 'alert error hidden' });
    const save = h('button', { class: 'btn primary', type: 'button' }, 'Spara budget');
    const { close } = openDialog({
      title: `Budget ${year} · ${name}`,
      wide: true,
      content: [
        error,
        h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', {}, 'Intäkt helår'), yearRevenue), h('div', { class: 'field' }, h('label', {}, 'TB helår'), yearMargin), spread),
        h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            { class: 'data budget-grid' },
            h('thead', {}, h('tr', {}, h('th', {}, 'Månad'), h('th', { class: 'num' }, 'Intäkt'), h('th', { class: 'num' }, 'TB'))),
            h('tbody', {}, inputs.map((x) => h('tr', {}, h('td', {}, fmtMonth(x.month)), h('td', { class: 'num' }, x.revenue), h('td', { class: 'num' }, x.margin)))),
          ),
        ),
      ],
      actions: [h('button', { class: 'btn', type: 'button', onclick: () => close() }, 'Avbryt'), save],
    });
    save.addEventListener('click', async () => {
      save.disabled = true;
      try {
        data = await put('/api/budget', { year, kst: Number(kst), months: inputs.map((x) => ({ month: x.month, revenue: Number(x.revenue.value || 0), margin: Number(x.margin.value || 0) })) });
        toast('Budgeten är sparad.', 'ok');
        close();
        draw();
      } catch (err) {
        error.textContent = err.message;
        error.classList.remove('hidden');
        save.disabled = false;
      }
    });
  }

  const yearSel = h('select', { id: 'b-year', onchange: (e) => { year = Number(e.target.value); load(); } }, [thisYear - 1, thisYear, thisYear + 1].map((y) => h('option', { value: y, selected: y === year }, String(y))));
  const kstSel = h(
    'select',
    { id: 'b-kst', onchange: (e) => { kst = e.target.value; load(); } },
    h('option', { value: '' }, 'Alla kostnadsställen'),
    costCenters.map((c) => h('option', { value: String(c.id) }, `${c.code} ${c.name}${c.active ? '' : ' (inaktivt)'}`)),
    h('option', { value: '0' }, 'Utan kostnadsställe'),
  );
  add(
    root,
    h('h1', {}, 'Ekonomi'),
    subnav('budget'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'b-year' }, 'År'), yearSel), h('div', { class: 'field' }, h('label', { for: 'b-kst' }, 'Kostnadsställe'), kstSel), editBtn)),
    costCenters.length ? null : h('div', { class: 'alert' }, 'Det finns inga kostnadsställen ännu. Lägg till dem under Admin → Kostnadsställen, eller budgetera allt som "Utan kostnadsställe".'),
    result,
    h('p', { class: 'muted small' }, 'Utfall är attesterad tid: intäkt = debiterbar tid × pris, TB = intäkt − kostnad enligt inställningen för TB. Prognosen (kursiv) bygger på avtalsregistret med beläggning och helgdagar, från innevarande månad. Tiden räknas på personens nuvarande kostnadsställe.'),
  );
  await load();
}

// ── Löneunderlag ───────────────────────────────────────────────────────
async function payrollView(root) {
  let month = monthChoices()[1];
  const result = h('div', { class: 'stack' });
  const exportLinks = h('div', { class: 'row' });

  async function run() {
    try {
      const p = await get(`/api/payroll${qs({ month })}`);
      const t = p.totals;
      setKids(
        exportLinks,
        h('a', { class: 'btn', href: `/api/payroll${qs({ month, format: 'csv' })}` }, 'Sammanställning (CSV)'),
        h('a', { class: 'btn', href: `/api/payroll${qs({ month, format: 'lines' })}` }, 'Rader per löneart (CSV)'),
      );
      setKids(
        result,
        t.pending_people
          ? h('div', { class: 'alert warn' }, `${t.pending_people} ${t.pending_people === 1 ? 'person har' : 'personer har'} tid, utlägg eller körningar i ${fmtMonth(month)} som inte är attesterade och därför inte är med. `, h('a', { href: '#/rapporter/inrapportering' }, 'Se inrapporteringen'), '.')
          : h('div', { class: 'alert ok' }, `Allt i ${fmtMonth(month)} är attesterat.`),
        h(
          'div',
          { class: 'kpis' },
          kpi('Personer i underlaget', String(p.rows.length)),
          kpi('Arbetade timmar, timlön', `${fmtNum(t.hourly_hours)} h`),
          kpi('Utlägg att ersätta', fmtMoney(t.expenses)),
          kpi('Milersättning', fmtMoney(round(t.mileage_taxfree + t.mileage_taxable)), h('div', { class: 'small muted' }, `varav ${fmtMoney(t.mileage_taxable)} skattepliktigt`)),
        ),
        h(
          'div',
          { class: 'card flush' },
          dataTable({
            rows: p.rows,
            empty: `Inga avvikelser eller ersättningar i ${fmtMonth(month)}.`,
            columns: [
              { label: 'Person', render: (r) => [r.name, ' ', h('span', { class: 'chip' }, PAY_TYPE[r.pay_type])] },
              { label: 'Arbetade timmar', num: true, render: (r) => (r.pay_type === 'hourly' ? fmtNum(r.worked_hours) : h('span', { class: 'muted' }, fmtNum(r.worked_hours))) },
              { label: 'Frånvaro', render: (r) => (r.absence.length ? r.absence.map((a) => h('div', {}, `${a.name} ${fmtNum(a.hours)} h (${a.days} ${a.days === 1 ? 'dag' : 'dagar'})`, a.pay_code ? h('span', { class: 'muted small' }, ` · löneart ${a.pay_code}`) : null)) : '') },
              { label: 'Utlägg', num: true, render: (r) => (r.expenses.amount ? [fmtMoney(r.expenses.amount), h('div', { class: 'small muted' }, `${r.expenses.count} st, moms ${fmtMoney(r.expenses.vat)}`)] : '') },
              { label: 'Milersättning', num: true, render: (r) => (r.mileage.amount ? [fmtMoney(r.mileage.amount), h('div', { class: 'small muted' }, `${fmtNum(r.mileage.km)} km${r.mileage.taxable ? `, ${fmtMoney(r.mileage.taxable)} skattepliktigt` : ''}`)] : '') },
              {
                label: 'Ej attesterat',
                render: (r) => {
                  const parts = [r.pending.time_hours ? `${fmtNum(r.pending.time_hours)} h tid` : null, r.pending.expenses ? `${r.pending.expenses} utlägg` : null, r.pending.mileage ? `${r.pending.mileage} körningar` : null].filter(Boolean);
                  return parts.length ? h('span', { class: 'chip warn' }, parts.join(', ')) : '';
                },
              },
            ],
          }),
        ),
      );
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  add(
    root,
    h('h1', {}, 'Ekonomi'),
    subnav('lon'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, monthPicker('pay-month', month, (v) => { month = v; run(); }), exportLinks)),
    result,
    h(
      'p',
      { class: 'muted small' },
      'Underlaget innehåller attesterad frånvaro, utlägg och milersättning för månaden, och arbetade timmar för timlönade. Månadslönade utan avvikelser är inte med. Milersättning upp till ',
      `${fmtNum(state.settings.mileage_taxfree_rate ?? 2.5)} kr/km`,
      ' är skattefri, resten skattepliktig. Lönearter sätts under Admin → Inställningar och Admin → Frånvaro. Lås perioden under Periodlåsning när lönen är körd.',
    ),
  );
  await run();
}

// ── Underkonsulter ─────────────────────────────────────────────────────
async function subcontractorView(root) {
  let month = monthChoices()[1];
  const result = h('div', { class: 'stack' });
  const csv = h('a', { class: 'btn', href: '#' }, 'Exportera CSV');

  async function run() {
    try {
      const s = await get(`/api/subcontractors${qs({ month })}`);
      csv.href = `/api/subcontractors${qs({ month, format: 'csv' })}`;
      const t = s.totals;
      const rows = s.rows.flatMap((p) => [{ group: true, ...p }, ...p.projects.map((x) => ({ ...x, person: p.name }))]);
      setKids(
        result,
        t.pending_hours ? h('div', { class: 'alert warn' }, `${fmtNum(t.pending_hours)} timmar i ${fmtMonth(month)} är inte attesterade och ingår inte. Stäm av mot fakturan när allt är attesterat.`) : null,
        h('div', { class: 'kpis' }, kpi('Attesterade timmar', `${fmtNum(t.hours)} h`), kpi('Inköp att stämma av', fmtMoney(t.cost)), kpi('Debiterat kund', fmtMoney(t.revenue)), kpi('TB på underkonsulter', fmtMoney(t.margin))),
        h(
          'div',
          { class: 'card flush' },
          dataTable({
            rows,
            empty: `Inga underkonsulter har rapporterat tid i ${fmtMonth(month)}. En person räknas som underkonsult när ersättningsformen är satt till det under Admin → Användare.`,
            rowClass: (r) => (r.group ? 'group-row' : ''),
            columns: [
              { label: 'Underkonsult / projekt', render: (r) => (r.group ? [r.name, h('span', { class: 'muted small' }, ` · inköpspris nu ${fmtMoney(r.current_rate)}/tim`)] : [r.project, h('div', { class: 'small muted' }, r.customer)]) },
              { label: 'Timmar', num: true, render: (r) => fmtNum(r.hours) },
              { label: 'Inköp', num: true, render: (r) => (r.group ? h('strong', {}, fmtMoney(r.cost)) : fmtMoney(r.cost)) },
              { label: 'Debiterat', num: true, render: (r) => fmtMoney(r.revenue) },
              { label: 'Ej attesterat', num: true, render: (r) => (r.pending_hours ? h('span', { class: 'chip warn' }, `${fmtNum(r.pending_hours)} h`) : '') },
            ],
          }),
        ),
      );
    } catch (err) {
      setKids(result, h('div', { class: 'alert error' }, err.message));
    }
  }

  add(
    root,
    h('h1', {}, 'Ekonomi'),
    subnav('underkonsulter'),
    h('div', { class: 'card' }, h('div', { class: 'filters' }, monthPicker('sub-month', month, (v) => { month = v; run(); }), csv)),
    result,
    h('p', { class: 'muted small' }, 'Inköpet är attesterade timmar gånger det inköpspris (timkostnad) som gällde när tiden attesterades. Jämför med underkonsultens faktura per projekt.'),
  );
  await run();
}

const kpi = (label, value, extra) => h('div', { class: 'kpi' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value), extra);

// ── Att fakturera: alla projekt med något som väntar ───────────────────
async function overview(root) {
  const data = await get('/api/reports/accrued?group_by=project');
  const t = data.total;
  const waiting = round(t.time_unapproved + t.other_unapproved);
  add(
    root,
    h('h1', {}, 'Ekonomi'),
    subnav('att'),
    h(
      'div',
      { class: 'kpis' },
      kpi('Godkänt, redo att fakturera', fmtMoney(t.total_approved)),
      kpi('Väntar på attest eller inskick', fmtMoney(waiting)),
      kpi('Fastpris, timmar utan faktura', fmtNum(t.fixed_hours)),
    ),
    h(
      'div',
      { class: 'card flush' },
      dataTable({
        rows: [...data.rows].sort((a, b) => (a.oldest || '').localeCompare(b.oldest || '')),
        empty: 'Allt är fakturerat. Inget ligger och väntar.',
        columns: [
          { label: 'Projekt', render: (r) => [h('a', { href: `#/fakturering/projekt/${r.key}` }, r.label), r.billing_type === 'fixed' ? h('span', { class: 'chip' }, ' fast pris') : null] },
          { label: 'Kund', render: (r) => h('a', { href: `#/fakturering/kund/${r.customer_id}` }, r.customer_name) },
          { label: 'Äldsta ofakturerade', render: (r) => fmtDate(r.oldest), class: 'nowrap' },
          { label: 'Godkänt', num: true, render: (r) => (r.total_approved ? h('strong', {}, fmtMoney(r.total_approved)) : '') },
          { label: 'Väntar på attest', num: true, render: (r) => (r.time_unapproved + r.other_unapproved ? fmtMoney(round(r.time_unapproved + r.other_unapproved)) : '') },
          { label: 'Fastpris (tim)', num: true, render: (r) => (r.fixed_hours ? fmtNum(r.fixed_hours) : '') },
          { label: '', class: 'actions', render: (r) => h('a', { class: 'btn sm primary', href: `#/fakturering/projekt/${r.key}` }, 'Öppna') },
        ],
        footer: (c, i) => [`Summa`, '', '', fmtMoney(t.total_approved), fmtMoney(waiting), fmtNum(t.fixed_hours), ''][i],
      }),
    ),
    h('p', { class: 'muted small' }, 'Här ligger allt som ännu inte fakturerats eller avskrivits, så att inget glöms bort. Öppna ett projekt för att välja vad som ska med på nästa fakturaunderlag.'),
  );
}

const round = (n) => Math.round(n * 100) / 100;

// ── Projekt- eller kundvy med radval ───────────────────────────────────
async function workbench(root, scope, id) {
  const filter = { from: '', to: '', show: 'open' };
  const selected = new Set();
  let data;
  let byKey = new Map();
  const tiles = h('div', { class: 'kpis' });
  const title = h('div');
  const table = h('div', { class: 'card flush' });
  const bar = h('div', { class: 'sticky-actions' });

  const key = (i) => `${i.kind}:${i.id}`;
  const idParam = scope === 'projekt' ? 'project_id' : 'customer_id';

  async function load() {
    data = await get(`/api/billing/items${qs({ [idParam]: id, ...filter })}`);
    byKey = new Map(data.items.map((i) => [key(i), i]));
    for (const k of [...selected]) if (!byKey.has(k)) selected.delete(k);
    draw();
  }

  const picked = () => [...selected].map((k) => byKey.get(k));
  const idsOf = (rows) => ({
    time_ids: rows.filter((r) => r.kind === 'time').map((r) => r.id),
    expense_ids: rows.filter((r) => r.kind === 'expense').map((r) => r.id),
    mileage_ids: rows.filter((r) => r.kind === 'mileage').map((r) => r.id),
  });

  function drawHeader() {
    const m = data.meta;
    const s = data.summary;
    setKids(
      title,
      h(
        'div',
        { class: 'row between' },
        h(
          'div',
          {},
          h('h1', {}, scope === 'projekt' ? `${m.code} ${m.name}` : m.customer_name),
          h(
            'p',
            { class: 'muted' },
            scope === 'projekt' ? [`${m.customer_name} · `, { hourly: 'Löpande räkning', fixed: 'Fast pris', internal: 'Internt' }[m.billing_type], ' · ', h('a', { href: `#/fakturering/kund/${m.customer_id}` }, 'Visa hela kunden')] : 'Alla projekt för kunden',
          ),
        ),
        h('a', { class: 'btn', href: '#/fakturering' }, '← Att fakturera'),
      ),
    );
    const budgetHours = m.budget_hours ? s.hours / m.budget_hours : null;
    setKids(
      tiles,
      kpi('Rapporterat', `${fmtNum(s.hours)} h`, h('div', { class: 'small muted' }, `varav ${fmtNum(s.billable_hours)} h debiterbara`)),
      kpi('Godkänt, redo att fakturera', fmtMoney(s.open_approved)),
      kpi('Väntar på attest', fmtMoney(s.open_unapproved)),
      kpi('Fakturerat', fmtMoney(s.invoiced)),
      s.waived ? kpi('Avskrivet', fmtMoney(s.waived)) : null,
      budgetHours !== null
        ? kpi('Budget (timmar)', `${Math.round(budgetHours * 100)} %`, h('div', { class: `budget ${budgetHours > 1 ? 'over' : ''}` }, h('span', { style: null })))
        : null,
    );
    const fill = tiles.querySelector('.budget span');
    if (fill) fill.style.width = `${Math.min(100, Math.round(budgetHours * 100))}%`;
  }

  function statusChip(i) {
    if (i.selectable) return h('span', { class: 'chip ready' }, 'Att fakturera');
    if (i.invoice_number) return h('span', { class: 'chip approved', title: `Fakturadatum ${i.invoice_date}` }, `Fakturerad ${i.invoice_number}`);
    if (i.reason === 'Avskriven') return h('span', { class: 'chip', title: i.waived_note }, 'Avskriven');
    const cls = i.reason === 'Väntar på attest' ? 'submitted' : i.reason === 'Avslagen' ? 'rejected' : 'warn';
    return h('span', { class: `chip ${cls}` }, i.reason);
  }

  const rowChecks = new Map();
  const groupChecks = [];

  function draw() {
    drawHeader();
    rowChecks.clear();
    groupChecks.length = 0;
    if (!data.items.length) {
      setKids(table, h('div', { class: 'empty' }, filter.show === 'open' ? 'Inget ofakturerat i den här vyn. 🎉' : 'Inga rader för urvalet.'));
      drawBar();
      return;
    }
    const customerScope = scope === 'kund';
    const tbody = h('tbody');
    const months = new Map();
    for (const i of data.items) {
      const m = i.date.slice(0, 7);
      if (!months.has(m)) months.set(m, []);
      months.get(m).push(i);
    }
    for (const [month, rows] of months) {
      // Månadsrutan väljer det som går att fakturera. Finns inget sådant väljer den resten (för avskrivning).
      const ready = rows.filter((r) => r.selectable);
      const usable = ready.length ? ready : rows.filter((r) => !r.invoice_id);
      const all = h('input', {
        type: 'checkbox',
        'aria-label': `Markera alla i ${fmtMonth(month)}`,
        disabled: !usable.length,
        onchange: (e) => {
          for (const r of usable) e.target.checked ? selected.add(key(r)) : selected.delete(key(r));
          sync();
        },
      });
      groupChecks.push({ box: all, rows: usable });
      add(
        tbody,
        h(
          'tr',
          { class: 'group-row' },
          h('td', { class: 'check' }, all),
          h('td', { colspan: customerScope ? 9 : 8 }, fmtMonth(month), h('span', { class: 'muted small' }, `  ${rows.length} rader`)),
        ),
      );
      for (const i of rows) {
        const box = h('input', {
          type: 'checkbox',
          'aria-label': 'Markera rad',
          disabled: !!i.invoice_id,
          checked: selected.has(key(i)),
          onchange: (e) => {
            e.target.checked ? selected.add(key(i)) : selected.delete(key(i));
            sync();
          },
        });
        rowChecks.set(key(i), box);
        add(
          tbody,
          h(
            'tr',
            { class: i.selectable ? '' : 'inactive', dataset: { key: key(i) } },
            h('td', { class: 'check' }, box),
            h('td', { class: 'nowrap' }, fmtDate(i.date)),
            customerScope ? h('td', {}, i.project_code) : null,
            h('td', {}, KIND_LABEL[i.kind]),
            h('td', {}, i.user_name),
            h('td', {}, i.what, i.note ? h('div', { class: 'small muted' }, i.note) : null),
            h('td', { class: 'num' }, `${fmtNum(i.quantity)} ${i.unit}`),
            h('td', { class: 'num' }, i.rate ? fmtMoney(i.rate) : ''),
            h('td', { class: 'num' }, i.billable && i.amount ? fmtMoney(i.amount) : ''),
            h('td', {}, statusChip(i)),
          ),
        );
      }
    }
    const head = h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { class: 'check' }),
        h('th', {}, 'Datum'),
        customerScope ? h('th', {}, 'Projekt') : null,
        h('th', {}, 'Typ'),
        h('th', {}, 'Person'),
        h('th', {}, 'Aktivitet / beskrivning'),
        h('th', { class: 'num' }, 'Antal'),
        h('th', { class: 'num' }, 'Pris'),
        h('th', { class: 'num' }, 'Belopp'),
        h('th', {}, 'Status'),
      ),
    );
    setKids(table, h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, head, tbody)), data.truncated ? h('div', { class: 'alert warn' }, 'Listan är avkortad. Begränsa perioden för att se allt.') : null);
    sync();
  }

  function sync() {
    for (const [k, box] of rowChecks) {
      box.checked = selected.has(k);
      box.closest('tr')?.classList.toggle('picked', box.checked);
    }
    for (const g of groupChecks) {
      const n = g.rows.filter((r) => selected.has(key(r))).length;
      g.box.checked = n > 0 && n === g.rows.length;
      g.box.indeterminate = n > 0 && n < g.rows.length;
    }
    drawBar();
  }

  function drawBar() {
    const rows = picked();
    const sum = round(rows.reduce((s, r) => s + (r.selectable ? r.amount : 0), 0));
    const canInvoice = rows.length > 0 && rows.every((r) => r.selectable);
    const canWaive = rows.length > 0 && rows.every((r) => !r.invoice_id && r.reason !== 'Avskriven');
    const canRestore = rows.length > 0 && rows.every((r) => r.reason === 'Avskriven');
    const readyCount = data.items.filter((i) => i.selectable).length;
    setKids(
      bar,
      h('button', { class: 'btn', type: 'button', disabled: !readyCount, onclick: () => { for (const i of data.items) if (i.selectable) selected.add(key(i)); sync(); } }, `Markera allt fakturerbart (${readyCount})`),
      h('button', { class: 'btn ghost', type: 'button', disabled: !rows.length, onclick: () => { selected.clear(); sync(); } }, 'Rensa'),
      h('span', { class: 'spacer' }, rows.length ? `${rows.length} markerade${canInvoice ? ` · ${fmtMoney(sum)}` : ''}` : ''),
      isFinanceSuper() && canRestore ? h('button', { class: 'btn', type: 'button', onclick: restore }, 'Ångra avskrivning') : null,
      isFinanceSuper()
        ? h('button', { class: 'btn danger', type: 'button', disabled: !canWaive, title: canWaive || !rows.length ? '' : 'Fakturerade rader kan inte avskrivas', onclick: waive }, 'Avskriv …')
        : null,
      h(
        'button',
        { class: 'btn primary', type: 'button', disabled: !canInvoice, title: canInvoice || !rows.length ? '' : 'Bara godkända, debiterbara rader som inte redan är fakturerade kan faktureras', onclick: createInvoice },
        'Skapa fakturaunderlag …',
      ),
    );
  }

  function createInvoice() {
    const rows = picked();
    const total = round(rows.reduce((s, r) => s + r.amount, 0));
    editDialog({
      title: 'Skapa fakturaunderlag',
      saveLabel: 'Skapa underlag',
      values: { invoice_date: localToday() },
      fields: [
        { name: 'invoice_date', label: 'Fakturadatum', type: 'date', required: true, hint: 'Avgör från vilket datum raderna räknas som fakturerade i upplupet.' },
        { name: 'note', label: 'Anteckning', maxlength: 500, full: true },
      ],
      extra: h('p', { class: 'muted' }, `${rows.length} rader, totalt ${fmtMoney(total)} exkl. moms. Allt annat ligger kvar att fakturera senare.`),
      onSave: async (v) => {
        const r = await post('/api/invoices', { customer_id: data.meta.customer_id, invoice_date: v.invoice_date, note: v.note, ...idsOf(rows) });
        toast(`Underlag ${r.number} skapat (${fmtMoney(r.total)}).`, 'ok');
        selected.clear();
        await load();
      },
    });
  }

  async function waive() {
    const rows = picked();
    const note = await promptDialog({
      title: `Avskriv ${rows.length} rader`,
      label: 'Anledning (till exempel kulans, eller faktureras som fast pris)',
      confirmLabel: 'Avskriv',
    });
    if (!note) return;
    try {
      await post('/api/billing/waive', { ...idsOf(rows), note });
      toast('Raderna är avskrivna och lämnar upplupet.', 'ok');
      selected.clear();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  async function restore() {
    try {
      await post('/api/billing/restore', idsOf(picked()));
      toast('Avskrivningen är ångrad.', 'ok');
      selected.clear();
      await load();
    } catch (err) {
      toast(err.message, 'error');
    }
  }

  const sel = (id2, label, options, value, onchange) =>
    h('div', { class: 'field' }, h('label', { for: id2 }, label), h('select', { id: id2, onchange: (e) => onchange(e.target.value) }, options.map(([v, l]) => h('option', { value: v, selected: v === value }, l))));

  add(
    root,
    title,
    tiles,
    h(
      'div',
      { class: 'card' },
      h(
        'div',
        { class: 'filters' },
        sel('b-show', 'Visa', [['open', 'Ofakturerat'], ['all', 'Allt'], ['invoiced', 'Fakturerat'], ['waived', 'Avskrivet']], filter.show, (v) => { filter.show = v; selected.clear(); load().catch((e) => toast(e.message, 'error')); }),
        h('div', { class: 'field' }, h('label', { for: 'b-from' }, 'Från datum'), h('input', { id: 'b-from', type: 'date', onchange: (e) => { filter.from = e.target.value; load().catch((er) => toast(er.message, 'error')); } })),
        h('div', { class: 'field' }, h('label', { for: 'b-to' }, 'Till datum'), h('input', { id: 'b-to', type: 'date', onchange: (e) => { filter.to = e.target.value; load().catch((er) => toast(er.message, 'error')); } })),
      ),
    ),
    table,
    bar,
  );
  await load();
}

// ── Skapade underlag ───────────────────────────────────────────────────
async function invoiceHistory(root) {
  const box = h('div', { class: 'card flush' });
  const lineColumns = [
    { label: 'Typ', render: (r) => r.kind },
    { label: 'Projekt', render: (r) => r.project },
    { label: 'Beskrivning', render: (r) => r.description },
    { label: 'Antal', num: true, render: (r) => `${fmtNum(r.quantity)} ${r.unit}` },
    { label: 'À-pris', num: true, render: (r) => fmtMoney(r.rate) },
    { label: 'Belopp', num: true, render: (r) => fmtMoney(r.amount) },
  ];

  async function open(r) {
    const inv = await get(`/api/invoices/${r.id}`);
    openDialog({
      title: `Fakturaunderlag ${inv.number} · ${inv.customer_name}`,
      wide: true,
      content: [
        h('p', { class: 'muted' }, `Fakturadatum ${fmtDate(inv.invoice_date)} · avser ${fmtDate(inv.period_from)} – ${fmtDate(inv.period_to)}${inv.note ? ` · ${inv.note}` : ''}`),
        dataTable({ columns: lineColumns, rows: inv.lines, footer: (c, i) => (i === 0 ? 'Summa' : c.label === 'Belopp' ? fmtMoney(inv.total) : '') }),
      ],
    });
  }

  async function reload() {
    const rows = await get('/api/invoices');
    setKids(
      box,
      dataTable({
        rows,
        empty: 'Inga underlag skapade ännu.',
        columns: [
          { label: 'Nr', render: (r) => r.number },
          { label: 'Kund', render: (r) => r.customer_name },
          { label: 'Fakturadatum', render: (r) => fmtDate(r.invoice_date), class: 'nowrap' },
          { label: 'Avser', render: (r) => `${fmtDate(r.period_from)} – ${fmtDate(r.period_to)}`, class: 'nowrap' },
          { label: 'Belopp', num: true, render: (r) => fmtMoney(r.total_amount) },
          {
            label: '',
            class: 'actions',
            render: (r) => [
              h('button', { class: 'btn sm', type: 'button', onclick: () => open(r).catch((e) => toast(e.message, 'error')) }, 'Öppna'),
              ' ',
              h('a', { class: 'btn sm', href: `/api/invoices/${r.id}?format=csv` }, 'CSV'),
              isFinanceSuper() ? ' ' : null,
              !isFinanceSuper() ? null : h(
                'button',
                {
                  class: 'btn sm danger',
                  type: 'button',
                  onclick: async () => {
                    if (!(await confirmDialog(`Ångra underlag ${r.number}? Raderna blir fakturerbara igen.`, { confirmLabel: 'Ångra underlag', danger: true }))) return;
                    try {
                      await del(`/api/invoices/${r.id}`);
                      toast('Underlaget är ångrat.', 'ok');
                      await reload();
                    } catch (err) {
                      toast(err.message, 'error');
                    }
                  },
                },
                'Ångra',
              ),
            ],
          },
        ],
      }),
    );
  }
  add(root, h('h1', {}, 'Ekonomi'), subnav('underlag'), box);
  await reload();
}

// ── Periodlåsning ──────────────────────────────────────────────────────
async function periodLock(root) {
  const settings = await get('/api/settings');
  const canEdit = isFinanceSuper();
  const input = h('input', { id: 'lock-date', type: 'date', value: settings.locked_until || '', disabled: !canEdit });
  const status = h('p', {});
  const showStatus = (date) =>
    setKids(status, date ? ['Perioder till och med ', h('strong', {}, fmtDate(date)), ' är låsta.'] : 'Ingen period är låst.');
  showStatus(settings.locked_until);

  const save = h('button', { class: 'btn primary', type: 'button', disabled: !canEdit }, 'Spara låsning');
  save.addEventListener('click', async () => {
    try {
      const r = await patch('/api/settings', { locked_until: input.value || null });
      state.settings = r;
      showStatus(r.locked_until);
      toast(r.locked_until ? `Perioder till och med ${fmtDate(r.locked_until)} är låsta.` : 'Låsningen är borttagen.', 'ok');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  add(
    root,
    h('h1', {}, 'Ekonomi'),
    subnav('lasning'),
    h(
      'div',
      { class: 'card' },
      h('h2', {}, 'Periodlåsning'),
      status,
      h('p', { class: 'muted' }, 'När en period är låst kan användare varken registrera, ändra eller attestera tid, utlägg och körningar till och med det datumet. Administratörer kan fortfarande rätta. Lås när månaden är fakturerad och bokförd.'),
      h('div', { class: 'filters' }, h('div', { class: 'field' }, h('label', { for: 'lock-date' }, 'Låst till och med'), input), save, h('button', { class: 'btn', type: 'button', disabled: !canEdit, onclick: () => { input.value = ''; save.click(); } }, 'Ta bort låsning')),
      canEdit ? null : h('p', { class: 'muted small' }, 'Bara ekonomi-superuser och administratörer kan ändra låsningen.'),
    ),
  );
}

export async function renderBilling(root, params) {
  const [view, id] = params;
  if (view === 'lasning') return periodLock(root);
  if ((view === 'projekt' || view === 'kund') && Number.isInteger(Number(id))) return workbench(root, view, Number(id));
  if (view === 'underlag') return invoiceHistory(root);
  if (view === 'manad') return monthlyView(root);
  if (view === 'budget' && isFinanceSuper()) return budgetView(root);
  if (view === 'lon' && isFinanceSuper()) return payrollView(root);
  if (view === 'underkonsulter') return subcontractorView(root);
  return overview(root);
}
