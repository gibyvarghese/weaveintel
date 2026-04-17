// Authentication related functions
import { api } from './api.js';
import { state } from './state.js';
import { h } from './dom.js';

function triggerRender() {
  (globalThis as any).render?.();
}

export async function doLogin(email: string, pass: string) {
  if (!email || !pass) {
    state.authError = 'Email and password are required';
    return;
  }

  try {
    const r = await api.post('/auth/login', { email, password: pass });
    if (r.ok) {
      const d = await r.json();
      state.user = d.user;
      state.csrfToken = d.csrfToken;
      await loadChatsAfterAuth();
      triggerRender();
    } else {
      const err = await r.json();
      state.authError = err.error || 'Login failed';
      triggerRender();
    }
  } catch (e: any) {
    state.authError = e.message || 'Login error';
    triggerRender();
  }
}

export async function doRegister(name: string, email: string, pass: string) {
  if (!name || !email || !pass) {
    state.authError = 'All fields are required';
    return;
  }

  try {
    const r = await api.post('/auth/register', { name, email, password: pass });
    if (r.ok) {
      const d = await r.json();
      state.user = d.user;
      state.csrfToken = d.csrfToken;
      await loadChatsAfterAuth();
      triggerRender();
    } else {
      const err = await r.json();
      state.authError = err.error || 'Registration failed';
      triggerRender();
    }
  } catch (e: any) {
    state.authError = e.message || 'Registration error';
    triggerRender();
  }
}

export async function doLogout() {
  try {
    await api.post('/auth/logout', {});
  } catch (e) {
    console.error('Logout error:', e);
  }
  state.user = null;
  state.csrfToken = '';
  state.messages = [];
  state.chats = [];
  state.currentChatId = null;
  state.view = 'chat';
  triggerRender();
}

export async function initiateOAuthFlow(provider: string) {
  try {
    const r = await api.post('/oauth/authorize-url', { provider });
    const data = await r.json();

    if (!r.ok || !data.authUrl) {
      state.authError = data.error || 'Could not get authorization URL';
      (globalThis as any).render?.();
      return;
    }

    const width = 500;
    const height = 700;
    const left = window.screenX + Math.max(0, (window.outerWidth - width) / 2);
    const top = window.screenY + Math.max(0, (window.outerHeight - height) / 2);
    const popup = window.open(
      data.authUrl,
      `${provider}-oauth`,
      `width=${width},height=${height},left=${left},top=${top}`,
    );

    if (!popup) {
      state.authError = 'Popup blocked. Please allow popups and try again.';
      (globalThis as any).render?.();
      return;
    }

    let completed = false;
    let pollTimer: number | undefined;
    let timeoutTimer: number | undefined;

    const cleanup = () => {
      window.removeEventListener('message', onMessage);
      if (pollTimer) window.clearInterval(pollTimer);
      if (timeoutTimer) window.clearTimeout(timeoutTimer);
    };

    const finalizeAuth = async () => {
      if (completed) return;
      try {
        const meR = await api.get('/auth/check');
        if (!meR.ok) return;

        const meD = await meR.json();
        if (!meD.authenticated) return;
        completed = true;
        cleanup();
        state.user = meD.user;
        state.csrfToken = meD.csrfToken;
        state.authError = '';
        try { popup.close(); } catch { /* ignore */ }
        await loadChatsAfterAuth();
        (globalThis as any).render?.();
      } catch {
        // ignore transient polling errors
      }
    };

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (!event.data || event.data.type !== 'oauth-success') return;
      void finalizeAuth();
    };

    window.addEventListener('message', onMessage);
    pollTimer = window.setInterval(() => {
      if (popup.closed) {
        cleanup();
        return;
      }
      void finalizeAuth();
    }, 1200);
    timeoutTimer = window.setTimeout(() => {
      if (completed) return;
      cleanup();
      state.authError = 'OAuth timed out. Please try again.';
      (globalThis as any).render?.();
    }, 120000);
  } catch (e: any) {
    state.authError = 'OAuth flow failed: ' + (e.message || 'Unknown error');
    (globalThis as any).render?.();
  }
}

async function loadChatsAfterAuth() {
  try {
    const r = await api.get('/chats');
    const data = await r.json();
    state.chats = data.chats || [];
    state.view = 'chat';
    state.authMode = 'login';
    state.authError = '';

    if (state.chats.length && !state.currentChatId) {
      state.currentChatId = state.chats[0].id;
    }

    // Load other data
    const modelsR = await api.get('/models');
    state.models = (await modelsR.json()).models || [];

    const toolsR = await api.get('/tools');
    state.tools = (await toolsR.json()).tools || [];

    const prefsR = await api.get('/user/preferences');
    const prefs = await prefsR.json();
    if (prefs.preferences?.theme) state.theme = prefs.preferences.theme;
  } catch (e) {
    console.error('Failed to load after auth:', e);
  }
}

export function renderAuth(): HTMLElement {
  const isLogin = state.authMode === 'login';
  const card = h('div', { className: 'auth-wrap' },
    h('div', { className: 'auth-card' },
      h('h1', null,
        Object.assign(document.createElement('span'), {
          innerHTML:
            '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#8A8A8A" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px;margin-right:6px"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/><path d="M8 10h.01"/><path d="M12 10h.01"/><path d="M16 10h.01"/></svg>',
        }),
        ' ',
        h('span', null, 'gene'),
        'Weave'
      ),
      h('p', { className: 'sub' }, isLogin ? 'Sign in to your account' : 'Create a new account'),
      !isLogin
        ? h('div', { className: 'field' },
            h('label', null, 'Name'),
            h('input', { type: 'text', id: 'auth-name', placeholder: 'Your name' })
          )
        : null,
      h('div', { className: 'field' },
        h('label', null, 'Email'),
        h('input', { type: 'email', id: 'auth-email', placeholder: 'you@example.com' })
      ),
      h('div', { className: 'field' },
        h('label', null, 'Password'),
        h('input', { type: 'password', id: 'auth-pass', placeholder: '••••••••' })
      ),
      h('button', {
        className: 'btn',
        onClick: () => {
          const email = (document.getElementById('auth-email') as HTMLInputElement)?.value;
          const pass = (document.getElementById('auth-pass') as HTMLInputElement)?.value;
          if (isLogin) {
            doLogin(email, pass);
          } else {
            const name = (document.getElementById('auth-name') as HTMLInputElement)?.value;
            doRegister(name, email, pass);
          }
        },
      }, isLogin ? 'Sign In' : 'Create Account'),
      h('div', { className: 'divider' },
        h('div', { className: 'line' }),
        h('span', null, 'or'),
        h('div', { className: 'line' })
      ),
      h('div', { className: 'oauth-btns' },
        h('button', { className: 'oauth-btn', onClick: () => initiateOAuthFlow('google'), title: 'Sign in with Google' }, h('span', null, '🔷'), 'Google'),
        h('button', { className: 'oauth-btn', onClick: () => initiateOAuthFlow('github'), title: 'Sign in with GitHub' }, h('span', null, '⬛'), 'GitHub'),
        h('button', { className: 'oauth-btn', onClick: () => initiateOAuthFlow('microsoft'), title: 'Sign in with Microsoft' }, h('span', null, '🟦'), 'Microsoft'),
        h('button', { className: 'oauth-btn', onClick: () => initiateOAuthFlow('apple'), title: 'Sign in with Apple' }, h('span', null, '🍎'), 'Apple'),
        h('button', { className: 'oauth-btn', onClick: () => initiateOAuthFlow('facebook'), title: 'Sign in with Facebook' }, h('span', null, '📘'), 'Facebook')
      ),
      h('div', { className: 'err' }, state.authError),
      h('div', { className: 'toggle' },
        isLogin ? 'No account? ' : 'Already have an account? ',
        h('a', {
          onClick: () => {
            state.authMode = isLogin ? 'register' : 'login';
            state.authError = '';
            triggerRender();
          },
        }, isLogin ? 'Register' : 'Sign In')
      )
    )
  );
  return card;
}
