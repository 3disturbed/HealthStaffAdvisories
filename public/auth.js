import { api, el, showNotice, renderNav, can } from '/common.js';

renderNav('');
const msg = el('msg');
const params = new URLSearchParams(window.location.search);

function landingFor(user) {
  if (can(user, 'cases.review')) return '/advisor.html';
  if (can(user, 'users.manage') || can(user, 'system.admin')) return '/admin.html';
  return '/portal.html';
}

const registerForm = el('register-form');
if (registerForm) {
  registerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/auth/register', {
        method: 'POST',
        body: {
          displayName: el('displayName').value,
          email: el('email').value,
          password: el('password').value,
        },
      });
      registerForm.classList.add('hidden');
      showNotice(msg, 'ok', data.message);
    } catch (err) {
      showNotice(msg, 'error', err.message);
    }
  });
}

const loginForm = el('login-form');
if (loginForm) {
  loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const data = await api('/auth/login', {
        method: 'POST',
        body: { email: el('email').value, password: el('password').value },
      });
      window.location.href = landingFor(data.user);
    } catch (err) {
      showNotice(msg, 'error', err.message);
    }
  });
}

if (document.title.startsWith('Confirm email')) {
  const token = params.get('token') || '';
  api('/auth/verify', { method: 'POST', body: { token } })
    .then((data) => {
      document.querySelector('h1').textContent = 'Email confirmed';
      showNotice(msg, 'ok', data.message);
      el('verify-done').classList.remove('hidden');
    })
    .catch((err) => {
      document.querySelector('h1').textContent = 'Confirmation failed';
      showNotice(msg, 'error', err.message);
    });
}

const requestResetForm = el('request-reset-form');
const doResetForm = el('do-reset-form');
if (requestResetForm && doResetForm) {
  const token = params.get('token');
  if (token) {
    requestResetForm.classList.add('hidden');
    doResetForm.classList.remove('hidden');
    doResetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('/auth/reset', { method: 'POST', body: { token, password: el('password').value } });
        doResetForm.classList.add('hidden');
        showNotice(msg, 'ok', data.message);
      } catch (err) {
        showNotice(msg, 'error', err.message);
      }
    });
  } else {
    requestResetForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      try {
        const data = await api('/auth/request-reset', { method: 'POST', body: { email: el('email').value } });
        showNotice(msg, 'ok', data.message);
      } catch (err) {
        showNotice(msg, 'error', err.message);
      }
    });
  }
}
