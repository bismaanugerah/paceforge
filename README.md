# PaceForge

Website sederhana untuk membuat **training plan lari** secara otomatis. User mengisi setting
(jarak & tanggal race, kondisi fisik saat ini, ketersediaan waktu latihan, target waktu finish),
lalu PaceForge menyusun jadwal latihan mingguan lengkap dengan jarak dan pace tiap sesi.

HTML/CSS/JS di sisi klien — generator plan-nya sendiri murni rule-based, tanpa AI/API. **Login
wajib** sebelum bisa mengisi form: landing page menampilkan layar "Masuk untuk mulai" dengan
tombol Login dengan Google (Supabase Auth), dan setiap plan yang dibuat otomatis tersimpan ke akun
user supaya tidak hilang meski ganti device/browser.

> **Status saat ini: mode dummy.** [`js/config.js`](js/config.js) belum diisi project Supabase
> sungguhan, jadi tombol "Login dengan Google" untuk sementara mensimulasikan login (user palsu
> `demo@paceforge.dev`, plan disimpan ke `localStorage` browser, bukan ke akun Google/cloud
> sungguhan) — supaya alur login-wajib-dulu ini bisa dicoba end-to-end sebelum setup Supabase +
> Google OAuth asli selesai. Begitu `js/config.js` diisi (lihat "Setup login & sinkronisasi plan"
> di bawah), file [`js/auth.js`](js/auth.js) otomatis pindah ke Google OAuth &amp; Supabase
> sungguhan tanpa perlu ubah kode lain — badge "MODE DUMMY" di header akan hilang dengan
> sendirinya.

## Cara menjalankan (mode dummy — tanpa setup Supabase)

Paling gampang: buka `index.html` langsung di browser (double-click filenya), lalu klik "Login
dengan Google" di layar "Masuk untuk mulai" — karena `js/config.js` masih placeholder, ini akan
mensimulasikan login (lihat catatan mode dummy di atas) supaya kamu bisa langsung coba generator
plan-nya tanpa perlu setup apa pun dulu.

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

Supaya plan tersimpan ke akun user dan tidak hilang meski ganti device/browser, PaceForge pakai
[Supabase](https://supabase.com) (Auth + Postgres) untuk login Google dan penyimpanan data, dan
butuh hosting yang bisa menjalankan serverless function (misal [Vercel](https://vercel.com)) untuk
endpoint AI (`/api/enhance-plan`) di production.

1. **Buat project Supabase** (gratis) di [supabase.com](https://supabase.com) → dashboard project
   → **Settings → API** → catat `Project URL` dan key `anon public`.
2. **Buat tabel `plans`**: buka **SQL Editor** di dashboard Supabase → paste seluruh isi
   [`supabase/schema.sql`](supabase/schema.sql) → **Run**. Ini juga yang mengaktifkan Row Level
   Security supaya user hanya bisa baca/tulis datanya sendiri.
3. **Aktifkan login Google**: dashboard Supabase → **Authentication → Providers → Google** →
   aktifkan. Ini butuh OAuth Client ID dari
   [Google Cloud Console](https://console.cloud.google.com/apis/credentials) (gratis, tanpa kartu
   kredit) — buat "OAuth client ID" tipe **Web application**, isi *Authorized redirect URI* dengan
   URL callback yang ditunjukkan Supabase di halaman provider Google tsb, lalu paste Client ID &
   Client Secret yang didapat kembali ke Supabase.
4. **Isi [`js/config.js`](js/config.js)** dengan `Project URL` & `anon public key` dari langkah 1.
   Anon key ini aman ditaruh di kode client-side — proteksinya datang dari Row Level Security di
   langkah 2, bukan dari merahasiakan key ini.
5. **Deploy ke Vercel**: buat akun di [vercel.com](https://vercel.com) → *Add New Project* →
   hubungkan ke repo GitHub ini → deploy (tidak perlu konfigurasi build, situs ini statis + folder
   `api/` otomatis dikenali sebagai serverless function). Di **Project Settings → Environment
   Variables**, tambahkan `ANTHROPIC_API_KEY` (dan opsional `ANTHROPIC_MODEL`) supaya endpoint AI
   jalan di production — tanpa ini generator plan tetap normal, hanya catatan pelatih AI yang gagal.
6. Di Supabase **Authentication → URL Configuration**, tambahkan domain Vercel-mu (dan
   `http://localhost:5173` untuk development) ke *Site URL* / *Redirect URLs*.

Tanpa langkah-langkah di atas (`js/config.js` masih placeholder), situs tetap berjalan penuh dalam
**mode dummy** — lihat catatan di paling atas.

## Struktur file

```
index.html              Halaman utama (gate login, form input, hasil plan)
css/styles.css           Semua styling
js/planGenerator.js      Logika inti pembuatan plan (murni fungsi, tanpa DOM)
js/app.js                Gating login, wiring form, render hasil, simpan/muat plan dari akun
js/config.js             Isi Project URL & anon key Supabase (lihat setup di atas)
js/supabaseClient.js     Bikin client Supabase dari config.js (no-op kalau belum diisi)
js/auth.js               Login/logout Google (atau simulasi mode dummy) + expose status ke app.js
api/enhance-plan.js      Serverless function (Vercel) — proxy ke Claude API untuk catatan pelatih
supabase/schema.sql      Skema tabel `plans` + Row Level Security policy
.claude/launch.json      Config untuk preview server (dipakai tool Claude Code)
.claude/serve.ps1        Static file server + endpoint AI lokal berbasis PowerShell (dev tanpa Vercel)
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
