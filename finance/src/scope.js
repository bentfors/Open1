// Vad en användare får se och ändra. Konton och innehav ligger i ett hushåll och är antingen delade med
// hushållet eller privata (bara ägaren ser dem). 'me' begränsar en läsning till egna konton.
// Heltalen kommer ur databasen och coerceras med Number, så de kan stå direkt i SQL.
export function scopeOf(user, mode = 'household') {
  const userId = Number(user.id);
  const householdId = Number(user.household_id);
  const me = mode === 'me';
  const sc = {
    userId,
    householdId,
    me,
    mode: me ? 'me' : 'household',
    // SQL-villkor för tabeller med kolumnerna user_id, household_id och shared (accounts, holdings).
    acct: (alias = 'a') => (me ? `${alias}.user_id = ${userId}` : `${alias}.household_id = ${householdId} AND (${alias}.shared = 1 OR ${alias}.user_id = ${userId})`),
    // Innehav på ett konto du inte ser är dolda även om själva innehavet är delat.
    holdings: (alias = 'h') => `${sc.acct(alias)} AND (${alias}.account_id IS NULL OR ${alias}.account_id IN (SELECT x.id FROM accounts x WHERE ${sc.acct('x')}))`,
    get write() {
      return me ? scopeOf(user, 'household') : sc;
    },
  };
  return sc;
}
