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

-- Riwayat blok latihan yang SUDAH BERAKHIR (satu baris per blok selesai,
-- append-only — beda dari `plans` di atas yang cuma nyimpen blok AKTIF dan
-- ditimpa terus). Diisi oleh js/app.js's archivePreviousBlock() lewat
-- api/plan-history.js, cuma pas terjadi transisi rolling-block sungguhan
-- (blok lama yang tanggal race/akhirnya sudah lewat, digantikan blok baru)
-- — bukan tiap kali user edit-edit plan yang belum jalan. `settings` disimpan
-- utuh (bukan cuma angka ringkasan) supaya suatu saat bisa buka detail blok
-- lama itu lagi, meski panel riwayat sekarang cuma pakai kolom-kolom
-- ringkasnya (total_km/start_vdot/end_vdot dst — lihat api/plan-history.js).
create table if not exists public.plan_history (
  id                bigserial primary key,
  athlete_id        bigint not null references public.strava_athletes(athlete_id) on delete cascade,
  mode              text not null,            -- 'race' | 'nonRace'
  non_race_style    text,                     -- 'baseBuilding' | 'maintenance' | null (mode 'race')
  race_label        text not null,            -- nama race, atau 'Aerobic Base'/'Flat Volume' utk non-race
  race_distance_km  numeric,
  block_start       date not null,
  block_end         date not null,
  -- Total km SELURUH blok (jumlah totalKm semua minggu), bukan cuma angka
  -- puncak satu minggu — dipilih karena sebanding lintas tipe blok (Race
  -- vs Base Building vs Maintenance punya bentuk kurva volume yang beda-
  -- beda, jadi "puncak" saja tidak fair dibandingkan, "total dikerjakan"
  -- lebih apple-to-apple).
  total_km          numeric,
  -- null utk non-race — VDOT nyaris tidak bergerak di Base Building/
  -- Maintenance by design (lihat kartu Goal Pace yang juga disembunyikan
  -- utk mode itu), jadi tidak ada growth yang berarti buat ditrack.
  start_vdot        numeric,
  end_vdot          numeric,
  settings          jsonb not null,
  created_at        timestamptz not null default now()
);

alter table public.plan_history enable row level security;

-- Migration-safe kalau project ini sudah pernah jalanin versi lama file ini
-- (kolom peak_weekly_km/peak_vdot — superseded, lihat komentar total_km di
-- atas soal kenapa diganti). No-op di project baru (create table di atas
-- sudah langsung pakai bentuk yang baru).
alter table public.plan_history add column if not exists total_km numeric;
alter table public.plan_history add column if not exists start_vdot numeric;
alter table public.plan_history add column if not exists end_vdot numeric;
alter table public.plan_history drop column if exists peak_weekly_km;
alter table public.plan_history drop column if exists peak_vdot;

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
grant select, insert, update, delete on public.plan_history to service_role;
