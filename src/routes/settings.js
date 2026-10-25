import { bad, forbidden } from '../http.js';
import { f, parse } from '../validate.js';
import { setSetting, tx } from '../db.js';
import { getSettings, isAdmin } from '../domain.js';
import { audit, changesFor } from '../audit.js';

const SCHEMA = {
  company_name: f.str({ required: true, max: 80, label: 'Företagsnamn' }),
  locked_until: f.date({ nullable: true, label: 'Låst till och med' }),
  mileage_rate: f.num({ required: true, min: 0, max: 100, label: 'Milersättning (kr/km)' }),
  tb_cost_basis: f.oneOf(['worked', 'billable'], { label: 'Kostnad i TB' }),
  bench_cap_hours: f.num({ nullable: true, min: 0, max: 100000, label: 'Gräns för odebiterbar tid' }),
  forecast_utilization: f.num({ required: true, min: 1, max: 100, label: 'Beläggning i prognoser' }),
};

export function registerSettings({ db, router }) {
  router.add('GET', '/api/settings', {}, () => getSettings(db));

  // Ekonomi-superuser får låsa perioder. Övriga inställningar ändrar bara administratörer.
  router.add('PATCH', '/api/settings', { auth: 'finance_super' }, ({ user, body }) => {
    const data = parse(body, SCHEMA, { partial: true });
    if (!Object.keys(data).length) throw bad('Inget att uppdatera.');
    if (!isAdmin(user) && Object.keys(data).some((k) => k !== 'locked_until')) {
      throw forbidden('Du kan bara ändra periodlåsningen. Övriga inställningar ändrar administratörer.');
    }
    const before = getSettings(db);
    tx(db, () => {
      for (const [key, value] of Object.entries(data)) setSetting(db, key, value ?? '');
      const onlyLock = Object.keys(data).every((k) => k === 'locked_until');
      audit(db, user, { entity: 'setting', action: 'update', label: onlyLock ? 'Periodlåsning' : 'Inställningar', changes: changesFor(db, before, data) });
    });
    return getSettings(db);
  });
}
