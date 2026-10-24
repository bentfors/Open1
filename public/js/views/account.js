import { post } from '../api.js';
import { h, toast, add } from '../dom.js';
import { state } from '../state.js';

export function renderAccount(root) {
  const error = h('div', { class: 'alert error hidden', role: 'alert' });
  const current = h('input', { id: 'current', type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { id: 'next', type: 'password', autocomplete: 'new-password', required: true });
  const again = h('input', { id: 'again', type: 'password', autocomplete: 'new-password', required: true });

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.classList.add('hidden');
        if (next.value !== again.value) {
          error.textContent = 'Lösenorden matchar inte.';
          error.classList.remove('hidden');
          return;
        }
        try {
          await post('/api/auth/password', { current: current.value, next: next.value });
          toast('Lösenordet är bytt.', 'ok');
          form.reset();
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
        }
      },
    },
    error,
    h('div', { class: 'field' }, h('label', { for: 'current' }, 'Nuvarande lösenord'), current),
    h('div', { class: 'field' }, h('label', { for: 'next' }, 'Nytt lösenord'), next, h('div', { class: 'hint' }, 'Minst 10 tecken. Andra enheter loggas ut när du byter.')),
    h('div', { class: 'field' }, h('label', { for: 'again' }, 'Upprepa nytt lösenord'), again),
    h('button', { class: 'btn primary', type: 'submit' }, 'Byt lösenord'),
  );

  add(root, 
    h('h1', {}, 'Mitt konto'),
    h('div', { class: 'card' }, h('p', {}, h('strong', {}, state.user.name), ' · ', state.user.email, ' · ', state.user.role === 'admin' ? 'Administratör' : 'Användare'), h('h2', {}, 'Byt lösenord'), form),
  );
}
