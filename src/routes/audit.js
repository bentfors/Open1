import { HANDLED, sendText } from '../http.js';
import { config } from '../config.js';
import { toCsv } from '../csv.js';
import { ACTION_LABELS, ENTITY_LABELS, auditFacets, queryAudit } from '../audit.js';

const MAX_CSV_ROWS = 20000;

const when = new Intl.DateTimeFormat('sv-SE', { timeZone: config.timezone, dateStyle: 'short', timeStyle: 'medium' });

export function registerAudit({ db, router }) {
  // Ekonomi-superuser och administratörer läser. Ingen kan ändra: det finns inga skrivande rutter, och databasen stoppar det också.
  router.add('GET', '/api/audit', { auth: 'finance_super' }, ({ query, res }) => {
    if (query.format === 'csv') {
      const { rows } = queryAudit(db, { ...query, limit: MAX_CSV_ROWS, offset: 0 }, { maxLimit: MAX_CSV_ROWS });
      const columns = [
        { key: 'at', label: 'När' },
        { key: 'actor', label: 'Utförd av' },
        { key: 'action', label: 'Typ av ändring' },
        { key: 'entity', label: 'Avser' },
        { key: 'label', label: 'Beskrivning' },
        { key: 'customer', label: 'Kund' },
        { key: 'project', label: 'Projekt' },
        { key: 'user', label: 'Användare' },
        { key: 'changes', label: 'Ändrat' },
        { key: 'note', label: 'Anteckning' },
      ];
      const data = rows.map((r) => ({
        at: when.format(new Date(r.at)),
        actor: r.actor_name,
        action: ACTION_LABELS[r.action] ?? r.action,
        entity: ENTITY_LABELS[r.entity] ?? r.entity,
        label: r.label,
        customer: r.customer_label,
        project: r.project_label,
        user: r.user_label,
        changes: r.changes.map((c) => `${c.field}: ${c.from} → ${c.to}`).join('; '),
        note: r.note,
      }));
      sendText(res, 200, toCsv(columns, data), 'text/csv; charset=utf-8', {
        'Content-Disposition': 'attachment; filename="andringslogg.csv"',
      });
      return HANDLED;
    }
    // Filterlistorna behövs bara när sidan öppnas, så de hämtas på begäran (?facets=1).
    return { ...queryAudit(db, query), ...(query.facets === '1' ? { facets: auditFacets(db) } : {}), labels: { entity: ENTITY_LABELS, action: ACTION_LABELS } };
  });
}
