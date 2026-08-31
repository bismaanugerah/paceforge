/**
 * PaceForge — supabaseClient.js
 * Creates the shared Supabase client from js/config.js, or leaves
 * window.PaceForgeSupabase as null when config hasn't been filled in yet
 * (login/sync UI degrades gracefully — the plan generator itself still
 * works fully without it).
 */
(() => {
  const cfg = window.PACEFORGE_CONFIG || {};
  const { SUPABASE_URL, SUPABASE_ANON_KEY } = cfg;
  const looksUnconfigured =
    !SUPABASE_URL || !SUPABASE_ANON_KEY ||
    SUPABASE_URL.includes('YOUR-PROJECT-REF') || SUPABASE_ANON_KEY.includes('YOUR-ANON');

  if (looksUnconfigured) {
    console.warn('[PaceForge] Supabase belum dikonfigurasi di js/config.js — login & sinkronisasi plan dinonaktifkan.');
    window.PaceForgeSupabase = null;
    return;
  }

  if (typeof supabase === 'undefined' || !supabase.createClient) {
    console.error('[PaceForge] Library supabase-js gagal dimuat (cek koneksi/CDN) — login & sinkronisasi plan dinonaktifkan.');
    window.PaceForgeSupabase = null;
    return;
  }

  window.PaceForgeSupabase = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
})();
