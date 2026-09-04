# PaceForge

Website sederhana untuk membuat **training plan lari** secara otomatis. User mengisi setting
(jarak & tanggal race, kondisi fisik saat ini, ketersediaan waktu latihan, target waktu finish),
lalu PaceForge menyusun jadwal latihan mingguan lengkap dengan jarak dan pace tiap sesi.

HTML/CSS/JS di sisi klien — generator plan-nya sendiri murni rule-based, tanpa AI/API. **Login
wajib** sebelum bisa mengisi form: landing page menampilkan layar "Masuk untuk mulai" dengan
tombol Login dengan Strava. Setelah connect, PaceForge otomatis mengisi sebagian form (rata-rata
km mingguan, lari terjauh, waktu race terakhir, hari latihan tersering) dari histori lari
Strava-mu — tetap bisa diedit sebelum submit — dan setiap plan yang dibuat otomatis tersimpan ke
akun user supaya tidak hilang meski ganti device/browser.

> **Status saat ini: mode dummy.** [`js/config.js`](js/config.js) belum diisi Client ID app Strava
> sungguhan, jadi tombol "Login dengan Strava" untuk sementara mensimulasikan login (athlete palsu
> "Demo Runner", plan & angka Strava dipakai/disimpan dari `localStorage` browser, bukan dari akun
> Strava/cloud sungguhan) — supaya alur login-wajib-dulu + auto-fill ini bisa dicoba end-to-end
> sebelum setup Strava + Supabase asli selesai. Begitu `js/config.js` diisi (lihat "Setup login &
> sinkronisasi plan" di bawah), file [`js/auth.js`](js/auth.js) otomatis pindah ke login Strava
> &amp; Supabase sungguhan tanpa perlu ubah kode lain — badge "MODE DUMMY" di header akan hilang
> dengan sendirinya.

## Cara menjalankan (mode dummy — tanpa setup Strava/Supabase)

Paling gampang: buka `index.html` langsung di browser (double-click filenya), lalu klik "Login
dengan Strava" di layar "Masuk untuk mulai" — karena `js/config.js` masih placeholder, ini akan
mensimulasikan login + data Strava (lihat catatan mode dummy di atas) supaya kamu bisa langsung
coba generator plan-nya (termasuk auto-fill-nya) tanpa perlu setup apa pun dulu.

Kalau mau pengalaman yang lebih mirip server sungguhan (disarankan saat development), jalankan
static server kecil dari folder ini, misalnya:

```bash
npx serve .
```

atau kalau Node tidak tersedia, jalankan script PowerShell yang sudah disiapkan:

```powershell
powershell -ExecutionPolicy Bypass -File .claude/serve.ps1
```

lalu buka `http://localhost:5173`.

## Setup login & sinkronisasi plan sungguhan

Login PaceForge pakai **Strava** langsung (bukan Supabase Auth — OAuth2 Strava bukan
OIDC-compliant jadi tidak bisa dipasang sebagai "provider" bawaan Supabase Auth seperti Google).
Prakteknya: [Supabase](https://supabase.com) dipakai murni sebagai Postgres storage (bukan
identity provider), dan seluruh alur OAuth + akses database jalan lewat serverless function — jadi
butuh hosting yang bisa menjalankannya (misal [Vercel](https://vercel.com)), baik untuk login
Strava maupun endpoint AI (`/api/enhance-plan`) yang sudah ada sebelumnya.

1. **Daftarkan app di Strava**: buka [strava.com/settings/api](https://www.strava.com/settings/api)
   (gratis, pakai akun Strava-mu) → buat app baru → isi *Authorization Callback Domain* dengan
   domain Vercel-mu (mis. `paceforge.vercel.app`, tanpa `https://` atau path) — untuk development
   lokal lewat `vercel dev`, isi `localhost`. Catat **Client ID** & **Client Secret** yang muncul.
2. **Buat project Supabase** (gratis) di [supabase.com](https://supabase.com) → dashboard project
   → **Settings → API** → catat `Project URL` dan key **`service_role`** (BUKAN `anon public` —
   service role key ini full-access, cuma boleh hidup sebagai environment variable server, jangan
   pernah ditaruh di kode client-side).
3. **Buat tabel-tabelnya**: buka **SQL Editor** di dashboard Supabase → paste seluruh isi
   [`supabase/schema.sql`](supabase/schema.sql) → **Run**.
4. **Isi [`js/config.js`](js/config.js)** dengan `Client ID` dari langkah 1 (`STRAVA_CLIENT_ID`) —
   ini identifier publik, aman di kode client-side. Nilai ini di browser cuma dipakai untuk
   mendeteksi mode dummy vs asli; proses OAuth sungguhan pakai `STRAVA_CLIENT_ID` versi server
   (langkah berikut), bukan file ini.
5. **Deploy ke Vercel**: buat akun di [vercel.com](https://vercel.com) → *Add New Project* →
   hubungkan ke repo GitHub ini → deploy (tidak perlu konfigurasi build, situs ini statis + folder
   `api/` otomatis dikenali sebagai serverless function). Di **Project Settings → Environment
   Variables**, tambahkan:
   - `STRAVA_CLIENT_ID` (sama dengan nilai di `js/config.js`) & `STRAVA_CLIENT_SECRET` — dari
     langkah 1.
   - `SUPABASE_URL` & `SUPABASE_SERVICE_ROLE_KEY` — dari langkah 2.
   - `SESSION_JWT_SECRET` — string acak panjang buat menandatangani cookie session (mis. output
     `openssl rand -hex 32`).
   - `ANTHROPIC_API_KEY` (dan opsional `ANTHROPIC_MODEL`) — supaya endpoint catatan pelatih AI
     jalan; tanpa ini generator plan tetap normal, cuma catatan AI-nya yang gagal.

Tanpa langkah-langkah di atas (`js/config.js` masih placeholder), situs tetap berjalan penuh dalam
**mode dummy** — lihat catatan di paling atas.

**Testing alur login lengkap secara lokal** (bukan mode dummy) butuh serverless function beneran
jalan — `.claude/serve.ps1` sengaja tidak direplikasi untuk endpoint Strava (cuma untuk
`/api/enhance-plan` + mode dummy, yang sudah cukup buat iterasi UI sehari-hari). Pakai
[`vercel dev`](https://vercel.com/docs/cli/dev) (`npx vercel dev`, dengan env var di atas diisi di
`.env.local` atau lewat `vercel env pull`) supaya semua endpoint di `api/` benar-benar jalan di
`http://localhost:3000`.

## Struktur file

```
index.html                Halaman utama (gate login, form input, hasil plan)
css/styles.css            Semua styling
js/planGenerator.js       Logika inti pembuatan plan (murni fungsi, tanpa DOM)
js/app.js                 Gating login, wiring form, render hasil, simpan/muat plan, auto-fill Strava
js/config.js              Isi Client ID Strava (lihat setup di atas)
js/auth.js                Login/logout Strava (atau simulasi mode dummy) + expose status ke app.js
api/strava-login.js       Serverless function — bangun URL authorize Strava, redirect + set state cookie
api/strava-callback.js    Serverless function — tukar code->token, simpan athlete, set session cookie
api/session.js            Serverless function — baca cookie session, balas status login ke client
api/logout.js             Serverless function — hapus cookie session
api/strava-summary.js     Serverless function — analisis aktivitas Strava jadi ringkasan buat form
api/plan.js               Serverless function — simpan/muat plan tersimpan (ganti akses langsung Supabase)
api/plan-history.js       Serverless function — riwayat blok latihan yang sudah selesai (buat panel "Riwayat Blok")
api/enhance-plan.js       Serverless function — proxy ke Claude API untuk catatan pelatih
server/session.js         Helper JWT + cookie session (dipakai banyak file di api/)
server/supabaseAdmin.js   Helper fetch ke Supabase REST pakai service-role key (server-only)
server/strava.js          Helper OAuth token + fetch/analisis aktivitas Strava
supabase/schema.sql       Skema tabel `strava_athletes` + `plans` + `plan_history`, RLS default-deny (akses cuma dari server)
.claude/launch.json       Config untuk preview server (dipakai tool Claude Code)
.claude/serve.ps1         Static file server + endpoint AI lokal berbasis PowerShell (dev tanpa Vercel)
```

## Cara kerja algoritma (`js/planGenerator.js`)

Semua rule-based, tidak ada AI/API di baliknya:

1. **Durasi plan** ditentukan dari jumlah minggu sampai race, dibatasi oleh rekomendasi umum per
   jarak race (5K: 8 minggu, 10K: 10 minggu, Half Marathon: 12 minggu, Full Marathon: 16 minggu),
   termasuk jumlah minggu taper di akhir (1–3 minggu tergantung jarak).
   - Kalau waktu tersisa lebih pendek dari rekomendasi → plan dipadatkan + muncul warning.
   - Kalau waktu tersisa lebih panjang → plan tetap memakai durasi rekomendasi (dihitung mundur
     dari tanggal race) + muncul catatan untuk menjaga mileage di minggu-minggu sebelumnya.
2. **Volume mingguan** naik bertahap dari mileage saat ini menuju target puncak (peak week),
   dengan cutback week (turun 20%) setiap minggu ke-4, lalu taper turun signifikan di
   minggu-minggu terakhir sebelum race.
3. **Volume mingguan puncak** naik dari mileage saat ini dengan batas aman ~1.1x–1.6x (bukan
   angka acak — ini kira-kira selaras dengan aturan umum "jangan naikkan mileage mingguan lebih
   dari ~10%/minggu"). **Jarak long run** puncak dihitung sebagai persentase dari volume mingguan
   puncak tsb (20–35% tergantung frekuensi latihan — makin jarang hari latihan, makin besar porsi
   long run, karena sesi lain sengaja dibuat pendek), lalu di-clamp ke rentang berbasis
   riset per jenis race (mis. half marathon ~15–19 km, full marathon ~29–35 km). Kalau volume
   mingguan aman dari mileage saat ini ternyata tidak cukup untuk mencapai rentang itu tanpa bikin
   satu sesi long run makan >40% volume minggu itu, long run puncak dibatasi lebih rendah dan
   muncul warning yang menyarankan menaikkan base mileage dulu — bukan diam-diam kasih long run
   yang lebih pendek dari yang seharusnya.
4. **Pace tiap jenis sesi** (recovery, easy, long run, tempo, interval) dihitung sebagai persentase
   dari goal pace, yang ditentukan dengan prioritas: (a) **target waktu finish** eksplisit kalau
   diisi, (b) kalau tidak, **waktu race/time-trial terakhir** (jarak bebas, kalau diisi)
   diproyeksikan ke jarak race target pakai rumus prediksi race time Riegel
   (`waktu2 = waktu1 × (jarak2/jarak1)^1.06`), (c) kalau keduanya kosong, default per level
   kebugaran. Makin dekat jarak race terakhir itu ke jarak race target, makin akurat proyeksinya
   — karena itu field-nya menerima jarak apa pun (5K–full marathon/custom), bukan dipatok ke 5K.
   Saat goal pace berasal dari race terakhir, hasil proyeksinya ditampilkan sebagai salah satu
   output di halaman hasil plan.
5. **Jadwal harian** memetakan jenis sesi (easy/tempo/interval/long run/rest) ke hari-hari yang
   dipilih user. Long run dipetakan ke hari yang dipilih user secara eksplisit (default: hari
   terakhir yang dipilih, biasanya akhir pekan, tapi bisa diganti di form).
6. **Minggu race**: long run diganti shakeout run pendek + hari race itu sendiri dengan jarak dan
   goal pace race yang sesungguhnya.
7. **Mode latihan konservatif** (opsional, untuk cedera/nyeri): kalau diaktifkan, kenaikan volume
   mingguan (weekly growth rate 8% → 5%, cap multiplier lebih rendah), porsi speedwork (20% → 12%
   dari volume minggu itu), dan kenaikan jarak long run per minggu (maks 20% → 15%) semuanya
   diturunkan — bukan cuma catatan teks, angka di jadwal benar-benar berubah.

Ini adalah heuristik umum ala running-plan pemula/menengah — bukan pengganti saran pelatih lari
atau tenaga medis (sudah ada disclaimer ini di halaman hasil).
