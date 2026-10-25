// Målberäkning. Ren funktion. Belopp i öre, avkastning i procent per år (nominell), månadsvis ränta på ränta.
import { ymDiff } from './scenario.js';

const monthlyRate = (annualPct) => (1 + annualPct / 100) ** (1 / 12) - 1;

/**
 * @param {{ target: number, current: number, monthly: number, date: string (YYYY-MM-DD), annualReturn: number }} g
 * @param {string} today YYYY-MM-DD
 */
export function evaluateGoal({ target, current, monthly, date, annualReturn }, today) {
  const n = Math.max(0, ymDiff(today.slice(0, 7), date.slice(0, 7)));
  const i = monthlyRate(annualReturn);
  const growth = (1 + i) ** n;
  const annuity = i === 0 ? n : (growth - 1) / i; // summan av (1+i)^k för k = 0..n-1
  const projected = Math.round(current * growth + monthly * annuity);
  const remaining = Math.max(0, target - current);
  // Månadssparande som krävs för att nå målet till datumet, när det du redan har också växer.
  const needed = n === 0 || annuity === 0 ? remaining : Math.max(0, Math.ceil((target - current * growth) / annuity));

  let status;
  if (current >= target) status = 'reached';
  else if (n === 0) status = 'overdue';
  else if (projected >= target) status = 'on_track';
  else status = 'behind';

  // När nås målet med nuvarande sparande? Räknar högst 50 år framåt.
  let reachedIn = null;
  if (current >= target) reachedIn = 0;
  else if (monthly > 0 || (current > 0 && i > 0)) {
    let v = current;
    for (let k = 1; k <= 600; k++) {
      v = v * (1 + i) + monthly;
      if (v >= target) {
        reachedIn = k;
        break;
      }
    }
  }
  return { months_left: n, progress: target > 0 ? Math.min(1, current / target) : 0, projected, shortfall: Math.max(0, target - projected), needed_monthly: needed, status, reached_in_months: reachedIn };
}
