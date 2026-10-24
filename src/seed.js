import { randomBytes } from 'node:crypto';
import { insertRow, tx, setSetting } from './db.js';
import { hashPassword, checkPasswordPolicy } from './auth.js';
import { SETTING_DEFAULTS } from './domain.js';

// Kategorierna är en startlista. De ändras och utökas under Admin > Kategorier.
const CATEGORIES = ['AM', 'BM', 'TA', 'Konsult Talent', 'Konsult Next', 'Konsult Expert', 'Underkonsult', 'OH', 'Chef'];
const ABSENCE_TYPES = ['Semester', 'Sjukdom', 'VAB', 'Föräldraledighet', 'Tjänstledig', 'Övrig frånvaro'];
const INTERNAL_ACTIVITIES = ['Administration', 'Möten', 'Utbildning', 'Försäljning'];

/**
 * Körs vid uppstart. Skapar grunddata och första administratören när databasen är tom.
 * Returnerar { email, password } när ett lösenord genererades, annars null.
 */
export async function bootstrap(db, { adminEmail, adminPassword }) {
  const hasUsers = db.prepare('SELECT COUNT(*) AS n FROM users').get().n > 0;
  if (hasUsers) return null;

  const email = adminEmail || 'admin@x-time.local';
  let password = adminPassword;
  let generated = false;
  if (!password) {
    password = randomBytes(12).toString('base64url');
    generated = true;
  } else {
    const problem = checkPasswordPolicy(password);
    if (problem) throw new Error(`XTIME_ADMIN_PASSWORD: ${problem}`);
  }
  const hash = await hashPassword(password);

  tx(db, () => {
    for (const [key, value] of Object.entries(SETTING_DEFAULTS)) setSetting(db, key, value);
    CATEGORIES.forEach((name, i) => insertRow(db, 'categories', { name, sort: i }));
    ABSENCE_TYPES.forEach((name) => insertRow(db, 'absence_types', { name }));

    const adminId = insertRow(db, 'users', {
      email,
      name: 'Administratör',
      password_hash: hash,
      role: 'admin',
      must_change_password: generated ? 1 : 0,
    });

    const customerId = insertRow(db, 'customers', { name: 'Internt' });
    const projectId = insertRow(db, 'projects', {
      customer_id: customerId,
      code: 'INT-1',
      name: 'Intern tid',
      manager_id: adminId,
      billing_type: 'internal',
      open_for_all: 1,
    });
    for (const name of INTERNAL_ACTIVITIES) {
      insertRow(db, 'activities', { project_id: projectId, name, billable: 0 });
    }
  });

  return generated ? { email, password } : { email, password: null };
}
