# PaceForge

Website sederhana untuk membuat **training plan lari** secara otomatis. User mengisi setting
(jarak & tanggal race, kondisi fisik saat ini, ketersediaan waktu latihan, target waktu finish),
lalu PaceForge menyusun jadwal latihan mingguan lengkap dengan jarak dan pace tiap sesi.

Murni HTML/CSS/JS statis — tidak butuh backend, database, atau API key apa pun.

## Cara menjalankan

Paling gampang: buka `index.html` langsung di browser (double-click filenya).

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

## Struktur file

```
index.html            Halaman utama (form input + hasil plan)
css/styles.css         Semua styling
js/planGenerator.js    Logika inti pembuatan plan (murni fungsi, tanpa DOM)
js/app.js              Wiring form, validasi input, render hasil ke halaman
.claude/launch.json    Config untuk preview server (dipakai tool Claude Code)
.claude/serve.ps1      Static file server sederhana berbasis PowerShell
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
   dari goal pace (target waktu finish dibagi jarak race, atau default per level kebugaran bila
   target waktu tidak diisi).
5. **Jadwal harian** memetakan jenis sesi (easy/tempo/interval/long run/rest) ke hari-hari yang
   dipilih user, dengan long run selalu jatuh di hari terakhir yang dipilih (biasanya akhir pekan).
6. **Minggu race**: long run diganti shakeout run pendek + hari race itu sendiri dengan jarak dan
   goal pace race yang sesungguhnya.

Ini adalah heuristik umum ala running-plan pemula/menengah — bukan pengganti saran pelatih lari
atau tenaga medis (sudah ada disclaimer ini di halaman hasil).
