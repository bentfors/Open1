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
// Ekonomiadministratörer och administratörer: fakturering och ekonomirapporter.
export const isFinance = () => !!state.user?.finance;
