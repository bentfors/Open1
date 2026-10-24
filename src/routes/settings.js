import { bad } from '../http.js';
import { f, parse } from '../validate.js';
import { setSetting } from '../db.js';
import { getSettings } from '../domain.js';

const SCHEMA = {
  company_name: f.str({ required: true, max: 80, label: 'Företagsnamn' }),
  locked_until: f.date({ nullable: true, label: 'Låst till och med' }),
  mileage_rate: f.num({ required: true, min: 0, max: 100, label: 'Milersättning (kr/km)' }),
  tb_cost_basis: f.oneOf(['worked', 'billable'], { label: 'Kostnad i TB' }),
};

export function registerSettings({ db, router }) {
  router.add('GET', '/api/settings', {}, () => getSettings(db));

  router.add('PATCH', '/api/settings', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, SCHEMA, { partial: true });
    if (!Object.keys(data).length) throw bad('Inget att uppdatera.');
    for (const [key, value] of Object.entries(data)) setSetting(db, key, value ?? '');
    return getSettings(db);
  });
}
