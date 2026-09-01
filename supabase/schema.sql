-- PaceForge — Supabase schema
--
-- Cara pakai: buka project Supabase kamu → SQL Editor → paste seluruh isi
-- file ini → Run. Cukup dijalankan sekali per project.
--
-- Login PaceForge pakai Strava (bukan Supabase Auth — OAuth2 Strava bukan
-- OIDC-compliant jadi tidak bisa dipasang sebagai "provider" bawaan Supabase
-- Auth). Karena itu tidak ada tabel `auth.users` yang dipakai di sini sama
-- sekali — identitas user adalah athlete_id dari Strava, dan SATU-SATUNYA
-- yang boleh baca/tulis tabel-tabel ini adalah kode server (lewat
-- SUPABASE_SERVICE_ROLE_KEY, lihat server/supabaseAdmin.js), yang otomatis
-- bypass Row Level Security. RLS di bawah sengaja diaktifkan TANPA satu pun
-- policy — itu bukan lupa, itu maksudnya: default-deny total untuk role
-- anon/authenticated (yang memang tidak dipakai lagi), supaya kalaupun anon
-- key project ini bocor/dipakai langsung dari browser, tetap tidak ada akses
-- sama sekali ke data di sini.

-- Token OAuth Strava + profil dasar per athlete. access_token/refresh_token
-- di-refresh otomatis oleh api/strava-summary.js saat sudah/hampir expired.
-- summary_cache menyimpan hasil analisis aktivitas terakhir supaya tidak
-- perlu hit API Strava di setiap load halaman (lihat komentar di
-- server/strava.js soal rate limit).
create table if not exists public.strava_athletes (
  athlete_id       bigint primary key,
  access_token     text not null,
  refresh_token    text not null,
  expires_at       bigint not null,
  firstname        text,
  lastname         text,
  profile_picture  text,
  summary_cache    jsonb,
  summary_cached_at timestamptz,
  updated_at       timestamptz not null default now()
);

alter table public.strava_athletes enable row level security;

-- Menyimpan HANYA plan terakhir per athlete (satu baris per athlete_id,
-- di-timpa setiap kali user generate plan baru) — bukan riwayat semua plan
-- yang pernah dibuat. Cukup untuk tujuan "jangan hilang, bisa dibuka dari
-- device lain", tanpa perlu UI riwayat/multi-plan.
create table if not exists public.plans (
  athlete_id bigint references public.strava_athletes(athlete_id) on delete cascade primary key,
  settings   jsonb not null,
  user_notes text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.plans enable row level security;

-- `service_role` selalu bypass RLS, TAPI itu lapisan yang beda dari grant
-- privilege dasar Postgres di level tabel — kalau project dibuat dengan
-- "Automatically expose new tables" dimatikan (disarankan di README, demi
-- default-deny anon/authenticated), tabel baru juga tidak otomatis
-- ke-grant ke `service_role`, bukan cuma ke anon/authenticated. Tanpa baris
-- di bawah ini, server/supabaseAdmin.js akan gagal dengan
-- "permission denied for table ..." (Postgres error 42501) meski RLS-nya
-- sendiri sudah benar.
grant select, insert, update, delete on public.strava_athletes to service_role;
grant select, insert, update, delete on public.plans to service_role;
