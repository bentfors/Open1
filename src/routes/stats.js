import { bad } from '../http.js';
import { f, parse, optId } from '../validate.js';
import { isFinanceSuper } from '../domain.js';
import { addDays, addMonths, monthEnd, monthStart, today } from '../dates.js';
import { buildStats, scenario } from '../stats.js';

const SCENARIO_SCHEMA = {
  count: f.int({ required: true, min: 1, max: 20, label: 'Antal konsulter' }),
  rate: f.num({ required: true, min: 0, max: 100000, label: 'Timpris' }),
  cost: f.num({ required: true, min: 0, max: 100000, label: 'Timkostnad' }),
  hours_per_week: f.num({ min: 0.5, max: 80, label: 'Timmar per vecka' }),
  start: f.date({ label: 'Start' }),
  length_months: f.int({ nullable: true, min: 1, max: 60, label: 'Längd (månader)' }),
  months: f.int({ min: 3, max: 24, label: 'Prognoshorisont' }),
};

export function registerStats({ db, router }) {
  // Vems statistik som visas: användaren själv, eller för administratörer och ekonomi-superuser den som väljs.
  const who = (user, query) => (isFinanceSuper(user) ? (optId(query.earner_id, 'Mottagare') ?? user.id) : user.id);

  router.add('GET', '/api/stats', {}, ({ user, query }) => {
    const months = query.months ? parse({ months: Number(query.months) }, { months: SCENARIO_SCHEMA.months }).months : 12;
    return buildStats(db, who(user, query), { months });
  });

  router.add('GET', '/api/stats/scenario', {}, ({ user, query }) => {
    const raw = Object.fromEntries(Object.entries(query).filter(([k]) => k in SCENARIO_SCHEMA && query[k] !== ''));
    const p = parse(Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, ['start'].includes(k) ? v : Number(String(v).replace(',', '.'))])), SCENARIO_SCHEMA);
    const start = p.start ?? addMonths(today(), 1);
    if (start < today()) throw bad('Starten kan inte ligga bakåt i tiden.');
    const end = p.length_months ? monthEnd(addMonths(start, p.length_months - 1)) : null;
    return scenario(db, who(user, query), {
      count: p.count,
      rate: p.rate,
      cost: p.cost,
      hours_per_week: p.hours_per_week ?? 40,
      start,
      end,
      months: p.months ?? 12,
    });
  });

  // Vilka som har en statistikvy: de med provisionsregler eller konsulter att vara BM för.
  router.add('GET', '/api/stats/people', { auth: 'finance_super' }, () =>
    db
      .prepare(
        `SELECT u.id, u.name, c.name AS category FROM users u LEFT JOIN categories c ON c.id = u.category_id
         WHERE u.active = 1 AND (EXISTS (SELECT 1 FROM commission_rules r WHERE r.earner_id = u.id)
                                 OR EXISTS (SELECT 1 FROM users x WHERE x.bm_id = u.id AND x.active = 1))
         ORDER BY u.name`,
      )
      .all(),
  );
}
