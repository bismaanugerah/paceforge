-- PaceForge — Supabase schema
--
-- Cara pakai: buka project Supabase kamu → SQL Editor → paste seluruh isi
-- file ini → Run. Cukup dijalankan sekali per project.
--
-- Menyimpan HANYA plan terakhir per user (satu baris per user_id, di-timpa
-- setiap kali user generate plan baru) — bukan riwayat semua plan yang
-- pernah dibuat. Cukup untuk tujuan "jangan hilang, bisa dibuka dari device
-- lain", tanpa perlu UI riwayat/multi-plan.

create table if not exists public.plans (
  user_id    uuid references auth.users(id) on delete cascade primary key,
  settings   jsonb not null,
  user_notes text not null default '',
  updated_at timestamptz not null default now()
);

alter table public.plans enable row level security;

-- Setiap user hanya boleh baca/tulis/update barisnya sendiri — ini yang
-- sebenarnya menjaga data user A tidak bisa dilihat/diubah user B, bukan
-- merahasiakan anon key (anon key memang publik by design di Supabase).
drop policy if exists "Users can view own plan" on public.plans;
create policy "Users can view own plan"
  on public.plans for select
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own plan" on public.plans;
create policy "Users can insert own plan"
  on public.plans for insert
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own plan" on public.plans;
create policy "Users can update own plan"
  on public.plans for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own plan" on public.plans;
create policy "Users can delete own plan"
  on public.plans for delete
  using (auth.uid() = user_id);
