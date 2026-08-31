/**
 * PaceForge — config.js
 *
 * Isi dua nilai di bawah dari Supabase Dashboard project kamu:
 * Settings → API → "Project URL" dan "anon public" key.
 *
 * Kedua nilai ini AMAN untuk ditaruh di kode client-side (bukan rahasia,
 * beda dengan ANTHROPIC_API_KEY) — proteksi data user sebenarnya datang
 * dari Row Level Security policy di database (lihat supabase/schema.sql),
 * bukan dari menyembunyikan key ini.
 *
 * Selama masih diisi placeholder di bawah, fitur login & sinkronisasi plan
 * otomatis nonaktif (generator plan tetap jalan normal tanpa login).
 */
window.PACEFORGE_CONFIG = {
  SUPABASE_URL: 'https://YOUR-PROJECT-REF.supabase.co',
  SUPABASE_ANON_KEY: 'YOUR-ANON-PUBLIC-KEY',
};
