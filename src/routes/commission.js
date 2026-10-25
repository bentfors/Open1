import { bad, notFound } from '../http.js';
import { f, parse } from '../validate.js';
import { insertRow, updateRow, tx } from '../db.js';
import { listRules } from '../commission.js';

const RULE_SCHEMA = {
  earner_id: f.int({ required: true, min: 1, label: 'Mottagare' }),
  name: f.str({ max: 100, label: 'Namn' }),
  kind: f.oneOf(['tb_percent', 'per_consultant', 'tb_tiered'], { required: true, label: 'Typ' }),
  period: f.oneOf(['month', 'quarter'], { required: true, label: 'Period' }),
  percent: f.num({ nullable: true, min: 0, max: 100, label: 'Procent' }),
  amount: f.num({ nullable: true, min: 0, max: 10000000, label: 'Belopp per konsult' }),
  min_hours: f.num({ min: 0, max: 744, label: 'Minsta antal timmar' }),
  valid_from: f.date({ nullable: true, label: 'Gäller från' }),
  valid_to: f.date({ nullable: true, label: 'Gäller till' }),
};

function parseTiersInput(raw) {
  if (!Array.isArray(raw) || !raw.length || raw.length > 20) throw bad('Ange mellan 1 och 20 trappsteg.');
  const tiers = raw.map((t) => {
    const min = Number(t?.min);
    const percent = Number(t?.percent);
    if (!Number.isInteger(min) || min < 0 || min > 100000) throw bad('Antal konsulter i ett trappsteg måste vara ett heltal från 0.');
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) throw bad('Procent i ett trappsteg måste vara mellan 0 och 100.');
    return { min, percent };
  });
  tiers.sort((a, b) => a.min - b.min);
  if (tiers[0].min !== 0) throw bad('Första trappsteget måste börja på 0 konsulter.');
  if (new Set(tiers.map((t) => t.min)).size !== tiers.length) throw bad('Två trappsteg har samma antal konsulter.');
  return tiers;
}

function parseIdList(raw, label) {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length > 500 || !raw.every((n) => Number.isInteger(n) && n > 0)) throw bad(`${label} är ogiltig.`);
  return [...new Set(raw)];
}

export function registerCommission({ db, router }) {
  router.add('GET', '/api/commission-rules', { auth: 'finance_super' }, () => listRules(db));

  // Validerar hela regeln efter sammanslagning med det som redan finns.
  function validate(merged, sources, categories) {
    if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(merged.earner_id)) throw bad('Mottagaren finns inte.');
    if (merged.valid_from && merged.valid_to && merged.valid_to < merged.valid_from) throw bad('Slutdatum kan inte ligga före startdatum.');
    if (merged.kind === 'tb_percent' && (merged.percent === null || merged.percent === undefined)) throw bad('Ange procent.');
    if (merged.kind === 'per_consultant' && (merged.amount === null || merged.amount === undefined)) throw bad('Ange belopp per konsult.');
    if (merged.kind !== 'per_consultant' && !sources.length) throw bad('Välj minst en konsult vars TB provisionen gäller.');
    for (const id of sources) if (!db.prepare('SELECT 1 FROM users WHERE id = ?').get(id)) throw bad('En vald konsult finns inte.');
    for (const id of categories) if (!db.prepare('SELECT 1 FROM categories WHERE id = ?').get(id)) throw bad('En vald kategori finns inte.');
  }

  function writeRule(id, data, sources, categories, tiers) {
    const row = { ...data };
    if (tiers !== undefined) row.tiers = tiers ? JSON.stringify(tiers) : null;
    updateRow(db, 'commission_rules', id, row);
    if (sources !== undefined) {
      db.prepare('DELETE FROM commission_rule_sources WHERE rule_id = ?').run(id);
      for (const uid of sources) db.prepare('INSERT INTO commission_rule_sources (rule_id, user_id) VALUES (?, ?)').run(id, uid);
    }
    if (categories !== undefined) {
      db.prepare('DELETE FROM commission_rule_categories WHERE rule_id = ?').run(id);
      for (const cid of categories) db.prepare('INSERT INTO commission_rule_categories (rule_id, category_id) VALUES (?, ?)').run(id, cid);
    }
  }

  router.add('POST', '/api/commission-rules', { auth: 'admin' }, ({ body }) => {
    const data = parse(body, RULE_SCHEMA);
    const sources = parseIdList(body.source_ids, 'Konsulterna') ?? [];
    const categories = parseIdList(body.category_ids, 'Kategorierna') ?? [];
    const tiers = data.kind === 'tb_tiered' ? parseTiersInput(body.tiers) : null;
    data.min_hours ??= 0;
    data.name ??= '';
    // Fält som inte hör till regeltypen sparas inte, så att de inte kan förvirra senare.
    if (data.kind !== 'tb_percent') data.percent = null;
    if (data.kind !== 'per_consultant') data.amount = null;
    validate(data, sources, categories);
    return tx(db, () => {
      const id = insertRow(db, 'commission_rules', { earner_id: data.earner_id, kind: data.kind, period: data.period });
      writeRule(id, data, data.kind === 'per_consultant' ? [] : sources, categories, tiers);
      return { id };
    });
  });

  router.add('PATCH', '/api/commission-rules/:id', { auth: 'admin' }, ({ params, body }) => {
    const id = Number(params.id);
    const [existing] = listRules(db, { ruleId: id });
    if (!existing) throw notFound('Regeln finns inte.');
    const data = parse(body, RULE_SCHEMA, { partial: true });
    const merged = { ...existing, ...data };
    const sources = parseIdList(body.source_ids, 'Konsulterna') ?? existing.sources.map((s) => s.id);
    const categories = parseIdList(body.category_ids, 'Kategorierna') ?? existing.categories.map((c) => c.id);
    const tiers = merged.kind === 'tb_tiered' ? (body.tiers !== undefined ? parseTiersInput(body.tiers) : existing.tiers) : null;
    if (merged.kind === 'tb_tiered' && !tiers.length) throw bad('Ange minst ett trappsteg.');
    if (merged.kind !== 'tb_percent') data.percent = null;
    if (merged.kind !== 'per_consultant') data.amount = null;
    validate(merged, sources, categories);
    tx(db, () => writeRule(id, data, merged.kind === 'per_consultant' ? [] : sources, categories, tiers));
    return { ok: true };
  });

  router.add('DELETE', '/api/commission-rules/:id', { auth: 'admin' }, ({ params }) => {
    db.prepare('DELETE FROM commission_rules WHERE id = ?').run(Number(params.id));
    return { ok: true };
  });
}
