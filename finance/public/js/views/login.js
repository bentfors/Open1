import { get, post } from '../api.js';
import { h, clear } from '../dom.js';

export async function renderAuth(root, onSuccess) {
  let signup = false;
  try {
    signup = (await get('/api/auth/config')).signup;
  } catch {
    /* visa bara inloggning */
  }
  let mode = 'login';

  function draw() {
    const error = h('div', { class: 'alert error hidden', role: 'alert' });
    const name = h('input', { id: 'name', type: 'text', autocomplete: 'name', required: true, maxlength: 100 });
    const email = h('input', { id: 'email', type: 'email', autocomplete: 'username', required: true });
    const password = h('input', { id: 'password', type: 'password', autocomplete: mode === 'login' ? 'current-password' : 'new-password', required: true });
    const button = h('button', { class: 'btn primary', type: 'submit' }, mode === 'login' ? 'Logga in' : 'Skapa konto');
    const form = h(
      'form',
      {
        onsubmit: async (e) => {
          e.preventDefault();
          error.classList.add('hidden');
          button.disabled = true;
          try {
            if (mode === 'login') await post('/api/auth/login', { email: email.value, password: password.value });
            else await post('/api/auth/register', { name: name.value, email: email.value, password: password.value });
            await onSuccess();
          } catch (err) {
            error.textContent = err.message;
            error.classList.remove('hidden');
            password.value = '';
          } finally {
            button.disabled = false;
          }
        },
      },
      error,
      mode === 'register' ? h('div', { class: 'field' }, h('label', { for: 'name' }, 'Namn'), name) : null,
      h('div', { class: 'field' }, h('label', { for: 'email' }, 'E-post'), email),
      h('div', { class: 'field' }, h('label', { for: 'password' }, 'Lösenord'), password, mode === 'register' ? h('div', { class: 'hint' }, 'Minst 10 tecken. Det finns ingen återställning via e-post, så spara det säkert.') : null),
      h('div', { class: 'row between' }, button, signup ? h('button', { class: 'btn ghost sm', type: 'button', onclick: () => ((mode = mode === 'login' ? 'register' : 'login'), draw()) }, mode === 'login' ? 'Skapa konto' : 'Har redan konto') : null),
    );
    clear(root).append(h('div', { class: 'auth-wrap' }, h('div', { class: 'card auth-card' }, h('div', { class: 'brand' }, 'Min ekonomi'), h('h1', {}, mode === 'login' ? 'Logga in' : 'Skapa konto'), form)));
    (mode === 'login' ? email : name).focus();
  }
  draw();
}
