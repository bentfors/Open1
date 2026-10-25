// Prognos- och scenariomotorn. Ren funktion utan databas, så den går att testa mot handräknade fall.
//
// Modell, månad för månad:
//   1. Händelser som startar den här månaden tas in (köp, engångsbelopp, nya månadsposter).
//   2. Månadens kassaflöde = inkomst − utgifter (+ poster) − räntor − amorteringar. Inkomst, utgifter och poster
//      växer med inflationen. Lånebetalningar gör det inte.
//   3. Kassaflödet läggs på kontanter. Blir kontanterna negativa tas pengar från placeringar. Räcker inte det
//      blir kontanterna negativa, vilket redovisas som underskott: du måste låna eller sälja något mer.
//   4. Kontanter, placeringar och övriga tillgångar växer med respektive antagen takt. Köpta tillgångar med sin egen.
// Allt är nominellt. Belopp i öre. Resultatet är en räkneövning på antaganden, inte en förutsägelse.

const pad = (n) => String(n).padStart(2, '0');
export const ymAdd = (ym, n) => {
  const [y, m] = ym.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad((t % 12) + 1)}`;
};
export const ymDiff = (a, b) => {
  const [ya, ma] = a.split('-').map(Number);
  const [yb, mb] = b.split('-').map(Number);
  return (yb - ya) * 12 + (mb - ma);
};
const monthly = (annualPct) => (1 + annualPct / 100) ** (1 / 12) - 1;

export const EVENT_TYPES = ['purchase', 'one_off', 'monthly'];

/**
 * @param {object} input
 * @param {{cash:number, invested:number, fixed:number, debts:{name:string, balance:number, rate:number|null, amort:number}[]}} input.start
 * @param {{income:number, expenses:number}} input.baseline månadsvärden i dagens penningvärde
 * @param {{return_rate:number, cash_rate:number, fixed_growth:number, inflation:number}} input.assumptions
 * @param {object[]} input.events valideras av validateEvents
 * @param {string} input.startMonth månaden prognosen utgår från (YYYY-MM). Första projicerade månaden är nästa.
 * @param {number} input.years
 * @param {number} [input.rateShock] procentenheter som läggs på alla lånerenter
 */
export function project({ start, baseline, assumptions, events = [], startMonth, years, rateShock = 0 }) {
  const months = years * 12;
  const infl = monthly(assumptions.inflation);
  const rCash = monthly(assumptions.cash_rate);
  const rInv = monthly(assumptions.return_rate);
  const rFixed = monthly(assumptions.fixed_growth);

  let cash = start.cash;
  let invested = start.invested;
  let fixed = start.fixed;
  const debts = start.debts.map((d) => ({ ...d }));
  const assets = []; // köpta tillgångar: { value, growth (per månad), costs (per månad), event }
  const points = [];
  const sold = [];
  const warnings = [];
  let totalInterest = 0;
  let firstShortfall = null;
  let minLiquid = Infinity;
  let peakDebtRatio = 0;
  let peakDebtRatioMonth = null;

  for (let m = 1; m <= months; m++) {
    const ym = ymAdd(startMonth, m);
    const f = (1 + infl) ** m; // inflationsfaktor för poster som följer penningvärdet
    // Händelser daterade före första månaden räknas som att de sker i första månaden.
    const starts = (date) => date === ym || (m === 1 && date < ym);
    let flow = 0; // löpande poster den här månaden
    let lumps = 0; // engångsbelopp den här månaden

    for (const e of events) {
      if (e.type === 'purchase') {
        if (starts(e.date)) {
          const loan = e.price - e.down_payment;
          lumps -= e.down_payment + e.one_off_costs;
          if (loan > 0) {
            debts.push({ name: e.name, balance: loan, rate: e.loan_rate, amort: e.amortization_years > 0 ? Math.round(loan / (e.amortization_years * 12)) : 0, event: e });
            if (e.kind === 'home' && loan / e.price > 0.85) warnings.push(`${e.name}: lånet är ${Math.round((loan / e.price) * 100)} % av priset. Bolånetaket är normalt 85 %, så kontantinsatsen räcker troligen inte.`);
          }
          assets.push({ value: e.price, growth: monthly(e.asset_growth), costs: e.monthly_costs, event: e });
        }
        if (e.sell_date === ym) {
          const a = assets.find((x) => x.event === e);
          if (a) {
            const d = debts.find((x) => x.event === e);
            const repaid = d ? d.balance : 0;
            lumps += a.value - repaid;
            if (d) d.balance = 0;
            assets.splice(assets.indexOf(a), 1);
            sold.push({ name: e.name, month: ym, value: Math.round(a.value), loan_repaid: Math.round(repaid) });
          }
        }
      } else if (e.type === 'one_off') {
        if (starts(e.date)) lumps += e.amount;
      } else if (e.from <= ym && (!e.to || ym <= e.to)) {
        flow += e.amount * f;
      }
    }
    for (const a of assets) flow -= a.costs * f;

    let interest = 0;
    let amort = 0;
    for (const d of debts) {
      if (d.balance <= 0) continue;
      const rate = d.rate === null || d.rate === undefined ? null : Math.max(0, d.rate + rateShock);
      if (rate !== null) interest += (d.balance * rate) / 1200;
      const pay = Math.min(d.balance, d.amort);
      amort += pay;
      d.balance -= pay;
    }
    totalInterest += interest;

    const cashflow = (baseline.income - baseline.expenses) * f + flow - interest - amort + lumps;
    cash += cashflow;
    if (cash < 0 && invested > 0) {
      const take = Math.min(invested, -cash);
      invested -= take;
      cash += take;
    }
    if (cash < 0 && firstShortfall === null) firstShortfall = ym;

    if (cash > 0) cash *= 1 + rCash;
    invested *= 1 + rInv;
    fixed *= 1 + rFixed;
    for (const a of assets) a.value *= 1 + a.growth;

    const assetValue = assets.reduce((n, a) => n + a.value, 0);
    const debtTotal = debts.reduce((n, d) => n + Math.max(0, d.balance), 0);
    minLiquid = Math.min(minLiquid, cash + invested);
    const annualIncome = baseline.income * 12 * f;
    if (annualIncome > 0 && debtTotal / annualIncome > peakDebtRatio) {
      peakDebtRatio = debtTotal / annualIncome;
      peakDebtRatioMonth = ym;
    }
    points.push({ month: ym, cash: Math.round(cash), invested: Math.round(invested), fixed: Math.round(fixed), assets: Math.round(assetValue), debts: Math.round(debtTotal), net_worth: Math.round(cash + invested + fixed + assetValue - debtTotal), interest: Math.round(interest), amortization: Math.round(amort), cashflow: Math.round(cashflow) });
  }

  const at = (y) => points[y * 12 - 1];
  return {
    points,
    end: points.at(-1),
    milestones: [1, 5, 10, 20, 30, 40].filter((y) => y <= years).map((y) => ({ years: y, ...at(y) })),
    total_interest: Math.round(totalInterest),
    first_shortfall: firstShortfall,
    min_liquid: Math.round(minLiquid),
    peak_debt_ratio: peakDebtRatio,
    peak_debt_ratio_month: peakDebtRatioMonth,
    sold,
    warnings,
  };
}

/** Vad ett köp kostar per månad i början (dagens penningvärde), med och utan chock på räntan. */
export function purchaseMonthlyCost(e, rateShock = 0) {
  const loan = e.price - e.down_payment;
  const interest = (loan * Math.max(0, e.loan_rate + rateShock)) / 1200;
  const amort = e.amortization_years > 0 ? loan / (e.amortization_years * 12) : 0;
  return { loan, interest: Math.round(interest), amortization: Math.round(amort), running: e.monthly_costs, total: Math.round(interest + amort + e.monthly_costs) };
}

// ── Validering av händelser (kommer från användaren, lagras som JSON) ────
const isYm = (v) => typeof v === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(v) && Number(v.slice(0, 4)) >= 2000 && Number(v.slice(0, 4)) <= 2100;
const isMoney = (v, { min = -1e13, max = 1e13 } = {}) => Number.isInteger(v) && v >= min && v <= max;
const isPct = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
const name = (v) => typeof v === 'string' && v.trim().length > 0 && v.length <= 80;

/** Returnerar { events, error }. Rensar bort alla okända fält. */
export function validateEvents(raw) {
  if (!Array.isArray(raw)) return { error: 'Händelser måste vara en lista.' };
  if (raw.length > 30) return { error: 'Högst 30 händelser per scenario.' };
  const out = [];
  for (const [i, e] of raw.entries()) {
    const at = `Händelse ${i + 1}`;
    if (!e || typeof e !== 'object' || !EVENT_TYPES.includes(e.type)) return { error: `${at}: okänd typ.` };
    if (!name(e.name)) return { error: `${at}: namn saknas eller är för långt.` };
    if (e.type === 'purchase') {
      if (!isYm(e.date)) return { error: `${at}: datum måste vara ÅÅÅÅ-MM.` };
      if (e.sell_date != null && (!isYm(e.sell_date) || e.sell_date <= e.date)) return { error: `${at}: försäljningsmånaden måste ligga efter köpmånaden.` };
      if (!isMoney(e.price, { min: 1 })) return { error: `${at}: pris måste vara ett belopp i öre.` };
      if (!isMoney(e.down_payment, { min: 0, max: e.price })) return { error: `${at}: kontantinsatsen måste vara mellan 0 och priset.` };
      if (!isMoney(e.monthly_costs ?? 0, { min: 0 }) || !isMoney(e.one_off_costs ?? 0, { min: 0 })) return { error: `${at}: kostnader måste vara belopp i öre.` };
      if (!isPct(e.loan_rate ?? 0, 0, 50)) return { error: `${at}: räntan måste vara mellan 0 och 50 %.` };
      if (!isPct(e.amortization_years ?? 0, 0, 100)) return { error: `${at}: amorteringstiden måste vara 0–100 år.` };
      if (!isPct(e.asset_growth ?? 0, -50, 50)) return { error: `${at}: värdeutvecklingen måste vara mellan −50 och 50 % per år.` };
      out.push({ type: 'purchase', name: e.name.trim(), kind: e.kind === 'home' ? 'home' : 'other', date: e.date, sell_date: e.sell_date ?? null, price: e.price, down_payment: e.down_payment, loan_rate: e.loan_rate ?? 0, amortization_years: e.amortization_years ?? 0, monthly_costs: e.monthly_costs ?? 0, one_off_costs: e.one_off_costs ?? 0, asset_growth: e.asset_growth ?? 0 });
    } else if (e.type === 'one_off') {
      if (!isYm(e.date)) return { error: `${at}: datum måste vara ÅÅÅÅ-MM.` };
      if (!isMoney(e.amount) || e.amount === 0) return { error: `${at}: beloppet måste vara ett belopp i öre, inte noll.` };
      out.push({ type: 'one_off', name: e.name.trim(), date: e.date, amount: e.amount });
    } else {
      if (!isYm(e.from) || (e.to != null && (!isYm(e.to) || e.to < e.from))) return { error: `${at}: ogiltigt tidsintervall.` };
      if (!isMoney(e.amount) || e.amount === 0) return { error: `${at}: beloppet måste vara ett belopp i öre per månad, inte noll.` };
      out.push({ type: 'monthly', name: e.name.trim(), from: e.from, to: e.to ?? null, amount: e.amount });
    }
  }
  return { events: out };
}
