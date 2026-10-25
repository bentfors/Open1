import { get } from './api.js';

export const state = {
  user: null,
  settings: {},
  approvalCount: 0,
};

export async function refreshApprovalCount() {
  try {
    state.approvalCount = (await get('/api/approvals/count')).count;
  } catch {
    state.approvalCount = 0;
  }
  document.dispatchEvent(new CustomEvent('approvals-changed'));
}

export const isAdmin = () => state.user?.role === 'admin';
// Ekonomi har två nivåer: 1 = ekonomi (skapar underlag), 2 = superuser (avskriver, ångrar underlag, låser perioder). Administratörer har 2.
export const financeLevel = () => state.user?.finance_level ?? 0;
export const isFinance = () => financeLevel() >= 1;
export const isFinanceSuper = () => financeLevel() >= 2;
