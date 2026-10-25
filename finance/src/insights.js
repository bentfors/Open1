// Regelbaserade observationer ur en månadsrapport. Ren funktion: samma fakta ger samma observationer.
//
// Det här är iakttagelser och diskussionspunkter, inte rekommendationer. Texterna anger vad siffrorna visar och
// aldrig vad någon bör köpa, sälja eller välja. Personliga placeringsråd kräver tillstånd och ska ges av en människa.
//
// audience 'client'  = visas i månadsrapporten som "Att tänka på"
// audience 'advisor' = visas som "Att ta upp med rådgivaren" (kunden ser dem också)

const nf = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 });
const kr = (ore) => `${ore < 0 ? '−' : ''}${nf.format(Math.abs(ore) / 100)} kr`;
const pct = (x) => `${nf.format(Math.round(x * 100))} %`;
const monthsText = (m) => `${nf.format(Math.round(m * 10) / 10).replace(/ /g, ' ')} månader`;

const item = (id, audience, level, title, text) => ({ id, audience, level, title, text });

/**
 * @param {object} f fakta enligt src/report.js
 * @returns {{id:string, audience:'client'|'advisor', level:'warn'|'info'|'ok', title:string, text:string}[]}
 */
export function buildInsights(f) {
  const out = [];

  // ── Resultat ──────────────────────────────────────────────────────
  if (f.income > 0 || f.expense > 0) {
    if (f.net < 0) out.push(item('deficit', 'client', 'warn', 'Underskott', `Utgifterna var ${kr(-f.net)} högre än inkomsterna. Skillnaden kommer från sparande eller ökad skuld.`));
    else out.push(item('saved', 'client', 'ok', 'Sparat i månaden', `Resultatet var ${kr(f.net)}${f.income > 0 ? `, ${pct(f.net / f.income)} av inkomsterna` : ''}.`));
  }

  if (f.expense_avg3 !== null && f.expense - f.expense_avg3 >= 100000 && f.expense >= f.expense_avg3 * 1.15) {
    const top = f.top_changes.filter((c) => c.delta > 0).slice(0, 3);
    out.push(item('expenses_up', 'client', 'warn', 'Högre utgifter än vanligt', `Utgifterna var ${kr(f.expense - f.expense_avg3)} högre än snittet för de föregående månaderna (${kr(f.expense_avg3)}).${top.length ? ` Mest ökade: ${top.map((c) => `${c.category} (+${kr(c.delta)})`).join(', ')}.` : ''}`));
  }

  // ── Budget ────────────────────────────────────────────────────────
  if (f.budget.has) {
    const over = f.budget.lines.filter((l) => l.kind === 'expense' && l.budget > 0 && l.actual > l.budget).sort((a, b) => b.actual - b.budget - (a.actual - a.budget));
    if (over.length) out.push(item('budget_over', 'client', 'warn', 'Över budget', `${over.length} ${over.length === 1 ? 'kategori' : 'kategorier'} över budget: ${over.slice(0, 4).map((l) => `${l.category} (${kr(l.actual - l.budget)} över)`).join(', ')}.`));
    else if (f.budget.total_budget > 0) out.push(item('budget_ok', 'client', 'ok', 'Inom budget', `Inga budgeterade utgiftskategorier överskreds. Utfall ${kr(f.budget.total_actual)} av ${kr(f.budget.total_budget)}.`));
  } else if (f.expense > 0) {
    out.push(item('no_budget', 'client', 'info', 'Ingen budget', 'Det finns ingen budget att jämföra med. Ett förslag kan göras utifrån de senaste månaderna.'));
  }

  // ── Händelser ─────────────────────────────────────────────────────
  for (const m of f.missing_recurring.filter((x) => x.amount > 0).slice(0, 3)) {
    out.push(item(`missing_income:${m.key}`, 'client', 'warn', 'Återkommande inkomst saknas', `"${m.description}" (vanligen ${kr(m.amount)}) kom i föregående månader men syns inte den här månaden. Kontrollera om kontoutdraget är komplett.`));
  }
  const missingExp = f.missing_recurring.filter((x) => x.amount < 0).slice(0, 3);
  if (missingExp.length) out.push(item('missing_expense', 'client', 'info', 'Återkommande utgifter som uteblev', `${missingExp.map((m) => `${m.description} (${kr(-m.amount)})`).join(', ')}. Det kan vara en avslutad tjänst eller ett kontoutdrag som saknas.`));
  if (f.new_large.length) out.push(item('new_large', 'client', 'info', 'Nya större utgifter', `${f.new_large.map((n) => `${n.description} (${kr(-n.amount)})`).join(', ')} förekom inte i de tre föregående månaderna.`));

  // ── Datakvalitet ──────────────────────────────────────────────────
  if (f.uncategorized.count > 0) {
    const share = f.transaction_count ? f.uncategorized.count / f.transaction_count : 0;
    out.push(item('uncategorized', 'client', share > 0.1 ? 'warn' : 'info', 'Okategoriserat', `${f.uncategorized.count} ${f.uncategorized.count === 1 ? 'transaktion' : 'transaktioner'} (${kr(Math.abs(f.uncategorized.amount))} netto) saknar kategori${share > 0.1 ? `, ${pct(share)} av månadens transaktioner, så siffrorna är osäkra` : ''}.`));
  }
  for (const a of f.accounts.filter((x) => x.stale)) out.push(item(`stale:${a.id}`, 'client', 'info', 'Gammalt kontoutdrag', `Senaste transaktionen på ${a.name} är från ${a.last_tx}. Importera nyare utdrag så blir rapporterna rättvisande.`));
  if (f.unpriced.length) out.push(item('unpriced', 'client', 'warn', 'Innehav utan kurs', `${f.unpriced.map((u) => u.name).join(', ')} saknar kurs och räknas inte med i förmögenheten.`));
  for (const d of f.debts.filter((x) => x.rate === null || x.rate === undefined)) out.push(item(`debt_no_rate:${d.name}`, 'client', 'info', 'Skuld utan ränta angiven', `${d.name} (${kr(d.balance)}) saknar ränta, så räntekostnaden i prognoser blir för låg.`));

  // ── Buffert och mål ───────────────────────────────────────────────
  if (f.monthly_expense_basis > 0 && (f.cash > 0 || f.invested > 0)) {
    const months = f.cash / f.monthly_expense_basis;
    out.push(item('buffer', 'client', months < 3 ? 'warn' : months < 6 ? 'info' : 'ok', 'Buffert', `Kontanter och bankkonton motsvarar ${monthsText(months)} av utgifterna (${kr(f.monthly_expense_basis)} per månad). En vanlig tumregel är 3–6 månader.`));
  }
  for (const g of f.goals.filter((x) => x.status === 'behind' || x.status === 'overdue')) {
    out.push(item(`goal:${g.id}`, 'client', 'warn', `Målet ${g.name}`, g.status === 'overdue' ? `Måldatumet har passerat och ${kr(g.shortfall || g.target_amount - g.current)} återstår.` : `Med nuvarande sparande saknas ${kr(g.shortfall)} vid måldatumet. Det krävs ${kr(g.needed_monthly)} i månaden, du sparar ${kr(g.monthly_contribution)}.`));
  }

  // ── Diskussionspunkter för rådgivarmötet ──────────────────────────
  const totalAssets = f.cash + f.invested + f.fixed;
  if (f.monthly_expense_basis > 0 && f.cash > 6 * f.monthly_expense_basis && totalAssets > 0 && f.cash / totalAssets > 0.6) {
    out.push(item('cash_heavy', 'advisor', 'info', 'Stor andel kontanter', `Kontanter och bankkonton är ${pct(f.cash / totalAssets)} av tillgångarna och motsvarar ${monthsText(f.cash / f.monthly_expense_basis)} av utgifterna, mer än buffertens tumregel.`));
  }
  const holdingsTotal = f.holdings.reduce((n, h) => n + h.value, 0);
  if (holdingsTotal > 0) {
    const top = [...f.holdings].sort((a, b) => b.value - a.value)[0];
    const share = top.value / holdingsTotal;
    if ((f.holdings.length >= 2 && share > 0.25) || (f.holdings.length === 1 && share === 1)) {
      out.push(item('concentration', 'advisor', 'info', 'Koncentration i värdepapper', `${top.name} utgör ${pct(share)} av värdepapperen som är registrerade som innehav (${kr(top.value)}).`));
    }
  }
  if (!f.accounts.some((a) => a.kind === 'pension') && f.has_income) {
    out.push(item('no_pension', 'advisor', 'info', 'Inget pensionssparande registrerat', 'Inget konto av typen pension finns i appen. Det kan bero på att pensionen inte lagts in.'));
  }
  if (!f.has_insurance_expense && f.expense > 0) {
    out.push(item('no_insurance', 'advisor', 'info', 'Inga försäkringspremier syns', 'Det finns inga utgifter i kategorin Försäkring de senaste tre månaderna. Det kan bero på att premier betalas via annat konto eller saknas i utdragen.'));
  }
  if (f.annual_income > 0 && f.debts_total > 0) {
    const ratio = f.debts_total / f.annual_income;
    if (ratio >= 3) out.push(item('debt_ratio', 'advisor', ratio >= 5 ? 'warn' : 'info', 'Skuldsättning', `Skulderna är ${nf.format(Math.round(ratio * 10) / 10)} gånger årsinkomsten efter skatt (${kr(f.debts_total)} mot ${kr(f.annual_income)}). Banker räknar på bruttoinkomst, så siffran är inte direkt jämförbar.`));
  }
  for (const d of f.debts.filter((x) => typeof x.rate === 'number' && x.rate >= 8 && x.balance > 0)) {
    out.push(item(`expensive_debt:${d.name}`, 'advisor', 'info', 'Dyr skuld', `${d.name} (${kr(d.balance)}) har ${d.rate} % ränta.`));
  }
  if (f.income > 0 && f.net / f.income < 0.1 && f.net >= 0) {
    out.push(item('low_savings', 'advisor', 'info', 'Låg sparkvot', `Sparkvoten var ${pct(f.net / f.income)} av inkomsterna den här månaden.`));
  }
  if (!f.goals.length) out.push(item('no_goals', 'advisor', 'info', 'Inga mål', 'Inga sparmål eller planer är inlagda.'));

  return out;
}
