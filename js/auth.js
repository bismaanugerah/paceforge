/**
 * PaceForge — auth.js
 * Wires every login/logout button (header + gate screen) to Supabase Auth
 * (Google sign-in) and exposes window.PaceForgeAuth so app.js can react to
 * login state without knowing anything about Supabase itself.
 *
 * DUMMY MODE: while js/config.js is still unfilled (no real Supabase
 * project yet), "login" is simulated — a fake local user is stored in
 * localStorage so the login-gated flow can be tried end-to-end before any
 * real Google OAuth / Supabase setup exists. Once js/config.js is filled in
 * with a real project, this file automatically switches to real Google
 * sign-in — nothing else needs to change.
 */
(() => {
  const client = window.PaceForgeSupabase;
  const DUMMY_SESSION_KEY = 'paceforge_dummy_session';

  const loginBtns = document.querySelectorAll('[data-action="login"]');
  const logoutBtns = document.querySelectorAll('[data-action="logout"]');
  const userInfo = document.getElementById('userInfo');
  const userEmailEl = document.getElementById('userEmail');
  const syncStatus = document.getElementById('syncStatus');
  const dummyBadge = document.getElementById('dummyBadge');
  const dummyModeNote = document.getElementById('dummyModeNote');

  const authChangeListeners = [];
  // "Replay last value to late subscribers" (same idea as a BehaviorSubject):
  // app.js is a separate <script src> loaded right after this one, and the
  // browser is free to process an already-elapsed setTimeout/Promise
  // callback while it's still fetching that next script over the network —
  // so notifyAuthChange can genuinely fire before app.js has registered its
  // listener. NOT_YET_KNOWN vs. null (logged out) has to stay distinguishable.
  const NOT_YET_KNOWN = Symbol('not-yet-known');
  let lastUser = NOT_YET_KNOWN;

  function notifyAuthChange(user) {
    lastUser = user;
    authChangeListeners.forEach(fn => fn(user));
  }

  function setLoggedInUI(user) {
    loginBtns.forEach(btn => { btn.hidden = !!user; });
    userInfo.hidden = !user;
    userEmailEl.textContent = user?.email || '';
  }

  function setSyncStatus(text, isError) {
    if (!text) {
      syncStatus.hidden = true;
      syncStatus.textContent = '';
      return;
    }
    syncStatus.hidden = false;
    syncStatus.textContent = text;
    syncStatus.classList.toggle('is-error', !!isError);
  }

  if (!client) {
    // --- Dummy mode: no Supabase project configured yet ---
    if (dummyBadge) dummyBadge.hidden = false;
    if (dummyModeNote) dummyModeNote.hidden = false;

    function signInDummy() {
      const dummyUser = {
        id: 'dummy-local-user',
        email: 'demo@paceforge.dev',
        user_metadata: { full_name: 'Demo User (mode dummy)' },
      };
      localStorage.setItem(DUMMY_SESSION_KEY, JSON.stringify(dummyUser));
      setLoggedInUI(dummyUser);
      notifyAuthChange(dummyUser);
    }
    function signOutDummy() {
      localStorage.removeItem(DUMMY_SESSION_KEY);
      setLoggedInUI(null);
      notifyAuthChange(null);
      setSyncStatus('');
    }

    loginBtns.forEach(btn => btn.addEventListener('click', signInDummy));
    logoutBtns.forEach(btn => btn.addEventListener('click', signOutDummy));

    let dummyUser = null;
    try {
      const raw = localStorage.getItem(DUMMY_SESSION_KEY);
      if (raw) dummyUser = JSON.parse(raw);
    } catch { /* ignore malformed storage */ }
    setLoggedInUI(dummyUser);
    notifyAuthChange(dummyUser);
  } else {
    // --- Real mode: Supabase project configured ---
    loginBtns.forEach(btn => btn.addEventListener('click', async () => {
      const { error } = await client.auth.signInWithOAuth({
        provider: 'google',
        options: { redirectTo: window.location.origin + window.location.pathname },
      });
      if (error) setSyncStatus(`Gagal memulai login: ${error.message}`, true);
    }));

    logoutBtns.forEach(btn => btn.addEventListener('click', async () => {
      await client.auth.signOut();
      setSyncStatus('');
    }));

    client.auth.onAuthStateChange((_event, session) => {
      const user = session?.user ?? null;
      setLoggedInUI(user);
      notifyAuthChange(user);
    });

    client.auth.getSession().then(({ data, error }) => {
      if (error) { setSyncStatus(`Gagal cek status login: ${error.message}`, true); return; }
      const user = data.session?.user ?? null;
      setLoggedInUI(user);
      notifyAuthChange(user);
    });
  }

  window.PaceForgeAuth = {
    getClient: () => client,
    isDummy: () => !client,
    // Called with (user) — user is null when logged out. Fires immediately
    // with the current state if already known (see NOT_YET_KNOWN above),
    // then again on every subsequent login/logout.
    onAuthChange(fn) {
      authChangeListeners.push(fn);
      if (lastUser !== NOT_YET_KNOWN) fn(lastUser);
    },
    setSyncStatus,
  };
})();
