/**
 * PaceForge — config.js
 *
 * STRAVA_CLIENT_ID: isi dengan Client ID app Strava kamu (dari
 * strava.com/settings/api — lihat README, bagian "Setup login &
 * sinkronisasi plan sungguhan"). Ini nilai publik (bukan rahasia — beda
 * dengan STRAVA_CLIENT_SECRET yang HANYA boleh ada sebagai environment
 * variable di server, jangan pernah ditaruh di sini), jadi aman ditaruh di
 * kode client-side. Nilainya di sini HANYA dipakai browser untuk mendeteksi
 * "sudah dikonfigurasi atau belum" (lihat js/auth.js) — proses OAuth
 * sungguhan (redirect ke Strava, tukar token) sepenuhnya terjadi di server
 * (api/strava-login.js, api/strava-callback.js), yang baca client ID-nya
 * sendiri dari environment variable, bukan dari file ini.
 *
 * Selama masih diisi placeholder di bawah, fitur login & sinkronisasi plan
 * otomatis nonaktif alias "mode dummy" (generator plan tetap jalan normal
 * tanpa login sungguhan).
 */
window.PACEFORGE_CONFIG = {
  STRAVA_CLIENT_ID: '276126',

  // Set ke true begitu app Strava + server env vars di atas sudah beneran
  // disambungkan (lihat README, bagian "Setup login & sinkronisasi plan
  // sungguhan"). Selama false: seluruh UI login (gate "Masuk untuk mulai",
  // tombol login/logout di header, badge MODE DUMMY) disembunyikan dan form
  // training plan langsung tampil tanpa login — kodenya tetap ada, tinggal
  // di-flip lagi kapan pun tanpa perlu ubah apa pun yang lain.
  REQUIRE_LOGIN: true,
};
