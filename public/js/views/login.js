import { post } from '../api.js';
import { h, clear } from '../dom.js';

function authCard(title, children) {
  return h(
    'div',
    { class: 'auth-wrap' },
    h('div', { class: 'card auth-card' }, h('div', { class: 'brand' }, 'x-time'), h('h1', {}, title), children),
  );
}

export function renderLogin(root, onSuccess) {
  const error = h('div', { class: 'alert error hidden', role: 'alert' });
  const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true, autofocus: true });
  const password = h('input', { id: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const button = h('button', { class: 'btn primary', type: 'submit' }, 'Logga in');

  const form = h(
    'form',
    {
      onsubmit: async (e) => {
        e.preventDefault();
        error.classList.add('hidden');
        button.disabled = true;
        try {
          await post('/api/auth/login', { email: email.value, password: password.value });
          await onSuccess();
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
          password.value = '';
          password.focus();
        } finally {
          button.disabled = false;
        }
      },
    },
    error,
    h('div', { class: 'field' }, h('label', { for: 'email' }, 'E-post'), email),
    h('div', { class: 'field' }, h('label', { for: 'password' }, 'Lösenord'), password),
    button,
  );
  clear(root).append(authCard('Logga in', form));
  email.focus();
}

export function renderForcedPasswordChange(root, user, onDone) {
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
          await onDone();
        } catch (err) {
          error.textContent = err.message;
          error.classList.remove('hidden');
        }
      },
    },
    h('p', { class: 'muted' }, `Hej ${user.name}. Du måste välja ett eget lösenord innan du fortsätter (minst 10 tecken).`),
    error,
    h('div', { class: 'field' }, h('label', { for: 'current' }, 'Nuvarande lösenord'), current),
    h('div', { class: 'field' }, h('label', { for: 'next' }, 'Nytt lösenord'), next),
    h('div', { class: 'field' }, h('label', { for: 'again' }, 'Upprepa nytt lösenord'), again),
    h('button', { class: 'btn primary', type: 'submit' }, 'Spara lösenord'),
  );
  clear(root).append(authCard('Byt lösenord', form));
  current.focus();
}
