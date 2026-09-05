/**
 * PaceForge — auth.js
 * Wires every login/logout button (header + gate screen) to Strava login
 * (api/strava-login.js → Strava consent → api/strava-callback.js →
 * api/session.js) and exposes window.PaceForgeAuth so app.js can react to
 * login state without knowing anything about how the session is
 * implemented server-side.
 *
 * DUMMY MODE: while js/config.js still has the placeholder STRAVA_CLIENT_ID
 * (no real Strava app connected yet), "login" is simulated — a fake local
 * athlete is stored in localStorage so the login-gated flow (including the
 * Strava-data auto-fill in app.js) can be tried end-to-end before any real
 * Strava app / server env vars exist. Once js/config.js is filled in, this
 * file automatically switches to real Strava login — nothing else needs to
 * change.
 */
(() => {
  const cfg = window.PACEFORGE_CONFIG || {};
  const looksUnconfigured = !cfg.STRAVA_CLIENT_ID || cfg.STRAVA_CLIENT_ID.includes('YOUR-STRAVA');

  const DUMMY_SESSION_KEY = 'paceforge_dummy_session';

  const loginBtns = document.querySelectorAll('[data-action="login"]');
  const logoutBtns = document.querySelectorAll('[data-action="logout"]');
  const userInfo = document.getElementById('userInfo');
  const userNameEl = document.getElementById('userName');
  const syncStatus = document.getElementById('syncStatus');
  const dummyBadge = document.getElementById('dummyBadge');
  const dummyModeNote = document.getElementById('dummyModeNote');

  const authChangeListeners = [];
  // "Replay last value to late subscribers" (same idea as a BehaviorSubject):
  // app.js is a separate <script src> loaded right after this one, and the
  // browser is free to process an already-elapsed fetch callback while it's
  // still fetching that next script over the network — so notifyAuthChange
  // can genuinely fire before app.js has registered its listener.
  // NOT_YET_KNOWN vs. null (logged out) has to stay distinguishable.
  const NOT_YET_KNOWN = Symbol('not-yet-known');
  let lastUser = NOT_YET_KNOWN;

  function notifyAuthChange(user) {
    lastUser = user;
    authChangeListeners.forEach(fn => fn(user));
  }

  function setLoggedInUI(user) {
    loginBtns.forEach(btn => { btn.hidden = !!user; });
    userInfo.hidden = !user;
    userNameEl.textContent = user ? ([user.firstname, user.lastname].filter(Boolean).join(' ') || 'Runner') : '';
  }

  // `variant` picks the leading icon css/styles.css draws on .sync-status
  // — 'ai' for "PaceForge filled this in for you", the default check for a
  // plain save/load, the alert for an error. Kept as a class rather than
  // markup so the message itself stays textContent: some of these lines
  // carry values from the server.
  function setSyncStatus(text, isError, variant) {
    if (!text) {
      syncStatus.hidden = true;
      syncStatus.textContent = '';
      return;
    }
    syncStatus.hidden = false;
    syncStatus.textContent = text;
    syncStatus.classList.toggle('is-error', !!isError);
    syncStatus.classList.toggle('is-ai', variant === 'ai');
  }

  if (looksUnconfigured) {
    // --- Dummy mode: belum ada app Strava sungguhan tersambung ---
    if (dummyBadge) dummyBadge.hidden = false;
    if (dummyModeNote) dummyModeNote.hidden = false;

    function signInDummy() {
      const dummyUser = { id: 'dummy-athlete', firstname: 'Demo', lastname: 'Runner (mode dummy)', profilePicture: '' };
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
    // --- Real mode: app Strava + server env vars sudah disambungkan ---
    loginBtns.forEach(btn => btn.addEventListener('click', () => {
      window.location.href = '/api/strava-login';
    }));

    logoutBtns.forEach(btn => btn.addEventListener('click', async () => {
      try {
        await fetch('/api/logout', { method: 'POST' });
      } catch { /* tetap update UI meski request logout gagal */ }
      setLoggedInUI(null);
      notifyAuthChange(null);
      setSyncStatus('');
    }));

    // api/strava-callback.js redirect balik ke sini dengan ?strava_error=...
    // kalau user tolak akses atau tukar-token gagal — tampilkan lalu bersihkan
    // dari URL supaya tidak muncul lagi kalau halaman di-refresh.
    const params = new URLSearchParams(window.location.search);
    const stravaError = params.get('strava_error');
    if (stravaError) {
      setSyncStatus(`Gagal login dengan Strava: ${stravaError}`, true);
      params.delete('strava_error');
      const cleanUrl = window.location.pathname + (params.toString() ? `?${params}` : '');
      window.history.replaceState({}, '', cleanUrl);
    }

    // Silent background check, bukan error user-facing kalau gagal (mis.
    // serverless function belum jalan — mis. lokal via .claude/serve.ps1
    // tanpa `vercel dev`) — cukup anggap belum login, jangan tampilkan
    // banner merah untuk sesuatu yang belum tentu user coba lakukan.
    // Kegagalan pas user benar-benar klik tombol login/logout tetap
    // ditampilkan (lihat listener di atas).
    fetch('/api/session')
      .then(res => res.json())
      .then(data => {
        const user = data.loggedIn ? data.athlete : null;
        setLoggedInUI(user);
        notifyAuthChange(user);
      })
      .catch(err => {
        console.warn('[PaceForge] Gagal cek status login (dianggap belum login):', err.message);
        notifyAuthChange(null);
      });
  }

  window.PaceForgeAuth = {
    isDummy: () => looksUnconfigured,
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
