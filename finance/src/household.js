import { insertRow, tx } from './db.js';
import { seedHousehold } from './domain.js';
import { bad } from './http.js';

export function createHousehold(db, user) {
  return insertRow(db, 'households', { name: `Hushållet ${user.name}` });
}

export function newUserHousehold(db, userId, name) {
  const householdId = createHousehold(db, { name });
  db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(householdId, userId);
  seedHousehold(db, userId, householdId);
  return householdId;
}

export const members = (db, householdId) => db.prepare('SELECT id, name, email FROM users WHERE household_id = ? AND active = 1 ORDER BY id').all(householdId);

/**
 * Flyttar användaren till ett annat hushåll. Kategorier slås ihop på namn (målhushållets typ gäller), regler
 * flyttas om mönstret är ledigt, konton, innehav, mål och scenarier följer med. Budgeten i det gamla hushållet
 * ersätts av målhushållets.
 */
export function joinHousehold(db, user, targetId) {
  const oldId = user.household_id;
  if (oldId === targetId) throw bad('Du är redan med i det hushållet.');
  if (members(db, oldId).length > 1) throw bad('Lämna ditt nuvarande hushåll innan du går med i ett annat.');
  tx(db, () => {
    const targetCats = new Map(db.prepare('SELECT id, name FROM categories WHERE household_id = ?').all(targetId).map((c) => [c.name.toLowerCase(), c.id]));
    const targetPatterns = new Set(db.prepare('SELECT pattern FROM rules WHERE household_id = ?').all(targetId).map((r) => r.pattern.toLowerCase()));
    const mapping = new Map();
    const move = [];
    for (const c of db.prepare('SELECT id, name FROM categories WHERE household_id = ?').all(oldId)) {
      const same = targetCats.get(c.name.toLowerCase());
      if (same) {
        mapping.set(c.id, same);
        db.prepare('UPDATE transactions SET category_id = ? WHERE category_id = ?').run(same, c.id);
      } else move.push(c.id);
    }
    for (const r of db.prepare('SELECT id, pattern, category_id FROM rules WHERE household_id = ?').all(oldId)) {
      if (targetPatterns.has(r.pattern.toLowerCase())) db.prepare('DELETE FROM rules WHERE id = ?').run(r.id);
      else db.prepare('UPDATE rules SET household_id = ?, category_id = ? WHERE id = ?').run(targetId, mapping.get(r.category_id) ?? r.category_id, r.id);
    }
    for (const id of move) db.prepare('UPDATE categories SET household_id = ? WHERE id = ?').run(targetId, id);
    for (const id of mapping.keys()) db.prepare('DELETE FROM categories WHERE id = ?').run(id);
    for (const table of ['accounts', 'holdings']) db.prepare(`UPDATE ${table} SET household_id = ? WHERE user_id = ?`).run(targetId, user.id);
    for (const table of ['goals', 'scenarios']) db.prepare(`UPDATE ${table} SET household_id = ? WHERE household_id = ?`).run(targetId, oldId);
    db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(targetId, user.id);
    db.prepare('DELETE FROM households WHERE id = ?').run(oldId);
  });
}

// Skapar nytt hushåll åt den som lämnar. Gemensamma kategorier och regler kopieras, och användarens
// transaktioner pekas om till kopiorna, så ingen kategorisering går förlorad.
export function leaveHousehold(db, user) {
  const oldId = user.household_id;
  const others = members(db, oldId).filter((m) => m.id !== user.id);
  if (!others.length) throw bad('Du är ensam i hushållet.');
  return tx(db, () => {
    // Först över till en kvarvarande medlem: kopiorna nedan får samma (user_id, namn) som originalen.
    handOver(db, user.id, others[0].id, oldId);
    const newId = createHousehold(db, user);
    const map = new Map();
    for (const c of db.prepare('SELECT id, name, kind FROM categories WHERE household_id = ?').all(oldId)) {
      map.set(c.id, insertRow(db, 'categories', { user_id: user.id, household_id: newId, name: c.name, kind: c.kind }));
    }
    for (const r of db.prepare('SELECT pattern, category_id FROM rules WHERE household_id = ?').all(oldId)) {
      insertRow(db, 'rules', { user_id: user.id, household_id: newId, pattern: r.pattern, category_id: map.get(r.category_id) });
    }
    const mine = db.prepare('SELECT id FROM accounts WHERE user_id = ?').all(user.id).map((a) => a.id);
    for (const [from, to] of map) db.prepare(`UPDATE transactions SET category_id = ? WHERE category_id = ? AND account_id IN (SELECT id FROM accounts WHERE user_id = ?)`).run(to, from, user.id);
    // Mål i det gamla hushållet ska inte längre peka på konton som lämnat det.
    for (const id of mine) db.prepare('DELETE FROM goal_accounts WHERE account_id = ?').run(id);
    for (const table of ['accounts', 'holdings']) db.prepare(`UPDATE ${table} SET household_id = ? WHERE user_id = ?`).run(newId, user.id);
    db.prepare('UPDATE users SET household_id = ? WHERE id = ?').run(newId, user.id);
    return newId;
  });
}

function handOver(db, fromUser, toUser, householdId) {
  db.prepare('UPDATE categories SET user_id = ? WHERE user_id = ? AND household_id = ?').run(toUser, fromUser, householdId);
  db.prepare('UPDATE rules SET user_id = ? WHERE user_id = ? AND household_id = ?').run(toUser, fromUser, householdId);
}

/** Raderar användaren. Delade hushållsdata (kategorier, regler) lämnas kvar till övriga medlemmar. */
export function deleteUser(db, user) {
  tx(db, () => {
    const others = members(db, user.household_id).filter((m) => m.id !== user.id);
    if (others.length) handOver(db, user.id, others[0].id, user.household_id);
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    if (!others.length) db.prepare('DELETE FROM households WHERE id = ?').run(user.household_id);
  });
}
