/* ==========================================================================
 * auth.js — Gatekeeper por lista blanca (window.ALLOWED_EMAILS)
 * --------------------------------------------------------------------------
 *  - Sin sesión válida: oculta la app ([data-shell="app"]) y muestra la
 *    pantalla de ingreso ([data-auth="gate"]).
 *  - Con sesión: muestra la app y escribe el correo en [data-auth="email"].
 *  - La sesión se guarda en sessionStorage (o en localStorage si el usuario
 *    marca "Mantener la sesión") bajo la clave `auth_user`. En cada carga se
 *    vuelve a validar contra la lista vigente: quitar un correo de
 *    auth_config.js revoca su acceso en la siguiente recarga.
 *
 * Expone: window.Auth = { user, whenAuthenticated(), logout(), normalize }
 *   whenAuthenticated() → Promise<string> que resuelve con el correo cuando
 *   hay sesión. data_loader.js lo espera antes de descargar los datos.
 *
 * Requiere (cargado antes): auth_config.js.
 * ========================================================================== */
(function () {
  'use strict';

  const STORAGE_KEY = 'auth_user';
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const normalize = (email) => String(email ?? '').trim().toLowerCase();

  const allowed = new Set(
    (Array.isArray(window.ALLOWED_EMAILS) ? window.ALLOWED_EMAILS : []).map(normalize).filter((e) => EMAIL_RE.test(e))
  );
  if (!allowed.size) console.warn('[auth] window.ALLOWED_EMAILS está vacío o no existe: nadie podrá ingresar.');

  /* ---------- Almacenamiento (puede no estar disponible: modo privado, etc.) --- */

  const stores = () => {
    const out = [];
    for (const name of ['sessionStorage', 'localStorage']) {
      try {
        if (window[name]) out.push(window[name]);
      } catch (_) {
        /* acceso bloqueado */
      }
    }
    return out;
  };

  function readSession() {
    for (const s of stores()) {
      try {
        const v = normalize(s.getItem(STORAGE_KEY));
        if (v) return v;
      } catch (_) {
        /* sin acceso */
      }
    }
    return null;
  }

  function writeSession(email, persistent) {
    clearSession();
    try {
      (persistent ? localStorage : sessionStorage).setItem(STORAGE_KEY, email);
    } catch (_) {
      // Sin almacenamiento la sesión dura solo mientras la página siga abierta
      console.warn('[auth] No se pudo guardar la sesión en el navegador.');
    }
  }

  function clearSession() {
    for (const s of stores()) {
      try {
        s.removeItem(STORAGE_KEY);
      } catch (_) {
        /* sin acceso */
      }
    }
  }

  /* ---------- Estado y API pública ----------------------------------------- */

  let resolveAuth;
  const authenticated = new Promise((resolve) => (resolveAuth = resolve));

  const Auth = {
    user: null,
    normalize,
    whenAuthenticated: () => authenticated,
    logout() {
      clearSession();
      location.reload();
    },
  };
  window.Auth = Auth;

  /* ---------- UI ------------------------------------------------------------- */

  const $ = (sel) => document.querySelector(sel);
  const icons = () => window.lucide && typeof window.lucide.createIcons === 'function' && window.lucide.createIcons();

  function enterApp(email) {
    Auth.user = email;
    $('[data-auth="gate"]').hidden = true;
    $('[data-shell="app"]').hidden = false;
    document.querySelectorAll('[data-auth="email"]').forEach((n) => {
      n.textContent = email;
      n.title = email;
    });
    resolveAuth(email);
  }

  function showGate() {
    const gate = $('[data-auth="gate"]');
    const form = gate.querySelector('form');
    const input = form.elements.email;
    const remember = form.elements.remember;
    const error = gate.querySelector('[data-auth="error"]');

    const setError = (msg) => {
      error.textContent = msg || '';
      error.hidden = !msg;
      input.setAttribute('aria-invalid', msg ? 'true' : 'false');
    };

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = normalize(input.value);
      if (!EMAIL_RE.test(email)) {
        setError('Ingresa un correo electrónico válido.');
      } else if (!allowed.has(email)) {
        setError('Este correo no tiene acceso al tablero. Solicita acceso al administrador.');
      } else {
        setError('');
        writeSession(email, remember.checked);
        enterApp(email);
        return;
      }
      input.focus();
      input.select();
    });
    input.addEventListener('input', () => setError(''));

    $('[data-shell="app"]').hidden = true;
    gate.hidden = false;
    icons();
    input.focus();
  }

  function init() {
    document.querySelectorAll('[data-auth="logout"]').forEach((b) => b.addEventListener('click', Auth.logout));

    const saved = readSession();
    if (saved && allowed.has(saved)) {
      enterApp(saved);
    } else {
      if (saved) clearSession(); // correo retirado de la lista blanca
      showGate();
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
