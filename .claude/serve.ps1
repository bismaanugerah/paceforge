$root = Split-Path -Parent $PSScriptRoot
$port = if ($env:PORT) { $env:PORT } else { 5173 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"

# `setx` (or the Windows GUI) writes an env var to the registry, but a process
# already running when that happens keeps its old inherited $env: — it won't
# see the new value until a fresh process/session picks it up. To avoid
# making beginners restart their whole terminal, fall back to reading
# straight from the registry if $env: doesn't have it yet.
function Get-EnvOrRegistry($name) {
  $val = [Environment]::GetEnvironmentVariable($name)
  if ($val) { return $val }
  foreach ($regPath in @("HKCU:\Environment", "HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment")) {
    try {
      $val = (Get-ItemProperty -Path $regPath -Name $name -ErrorAction Stop).$name
      if ($val) { return $val }
    } catch {}
  }
  return $null
}

if (-not (Get-EnvOrRegistry "ANTHROPIC_API_KEY")) {
  Write-Host "NOTE: ANTHROPIC_API_KEY is not set - the '/api/enhance-plan' AI endpoint will return an error until you set it (and, if this server was already running, restart it)."
}

$mime = @{
  ".html" = "text/html"; ".css" = "text/css"; ".js" = "application/javascript";
  ".json" = "application/json"; ".svg" = "image/svg+xml"; ".png" = "image/png";
}

# The rule-based schedule (days/km/pace) is computed entirely client-side in
# js/planGenerator.js. Claude never rewrites it from scratch -- this endpoint
# asks it to review the already-computed plan (optionally flagging/adjusting
# a handful of individual non-long-run sessions) and write qualitative
# coaching notes. Claude's adjustments are advisory only -- js/app.js
# validates and clamps every one before applying anything. Keep this prompt
# in sync with api/enhance-plan.js's copy.
$AI_SYSTEM_PROMPT = @'
Kamu pelatih lari berpengalaman, menulis singkat dalam Bahasa Indonesia.
Kamu menerima draft jadwal latihan mingguan yang SUDAH DIHITUNG oleh sistem
rule-based: tiap minggu berisi fase, total km, dan daftar sesi lari (hari
"dow" 0=Minggu..6=Sabtu, jenis sesi, jarak km).

Input JSON bisa membawa "mode" ("race" -- default kalau field ini tidak ada
sama sekali -- atau "nonRace") dan "nonRaceStyle" ("baseBuilding" atau
"maintenance", cuma ada kalau mode "nonRace"). PENTING kalau mode "nonRace":
- Ini BUKAN persiapan race sungguhan -- "raceLabel"/"raceDate" di input cuma
  "gaya latihan" (template rasio volume) & tanggal akhir blok, bukan race
  asli. JANGAN sebut nama/jarak race itu (mis. "half marathon", "5K")
  sebagai tujuan pelari di "intro" atau "weeklyNotes" -- sebut sebagai
  "training block" atau "blok latihan" saja, tanpa embel-embel nama race.
- "baseBuilding": tujuan pelari menaikkan fitness/volume bertahap, belum
  ada race spesifik di depan mata.
- "maintenance": tujuan pelari MENJAGA fitness (volume mingguannya sengaja
  flat, bukan naik) -- jangan tulis catatan seolah-olah dia sedang
  "membangun" menuju puncak, karena memang tidak ada puncak yang dikejar.
- Minggu terakhir berjenis sesi "evaluation" (bukan "race") -- itu cuma
  self-test ringan/opsional, BUKAN race sungguhan. Isi "raceDayTips" untuk
  kasus ini dengan tips seputar minggu evaluasi/deload itu (bukan pacing
  race hari-H) dan/atau saran buat blok berikutnya, bukan tips race day.
- Sesi berjenis "fartlek" itu unstructured (surge+jog santai sesuai
  feeling) -- jangan disarankan lewat "adjustments" (memang tidak termasuk
  daftar jenis yang boleh disarankan di poin 1 di bawah).

Tugasmu:
1. Tinjau apakah ada sesi individual berjenis "easy", "recovery", "tempo",
   "interval", atau "repetition" SAJA (JANGAN PERNAH longRun/race/shakeout/
   evaluation/fartlek) yang jaraknya terasa tidak realistis untuk jenis
   sesinya (mis. easy run yang kepanjangan dibanding long run minggu itu,
   tempo run yang mustahil dijaga terus-menerus di pace tempo, atau
   repetition run yang kepanjangan untuk sesi sprint-pendek-recovery-penuh).
   Kalau nemu, sarankan lewat field "adjustments" (PALING BANYAK 5, tiap
   saran maksimal sekitar ±20% dari jarak aslinya). Kalau semua sesi sudah
   masuk akal, "adjustments" cukup array kosong -- JANGAN dipaksakan
   cari-cari masalah yang tidak ada.
2. Tambahkan catatan pelatih yang personal & actionable, mempertimbangkan
   catatan tambahan pelari (cedera/jadwal/preferensi) jika ada.

Balas HANYA JSON valid (tanpa code fence, tanpa teks lain), format PERSIS:
{"adjustments": [{"week": N, "dow": 0-6, "type": "easy|recovery|tempo|interval|repetition", "suggestedKm": X, "reason": "maks 12 kata"}], "intro": "maks 2 kalimat ringkasan strategi", "weeklyNotes": [{"week": N, "note": "maks 12 kata"}], "raceDayTips": "maks 3 kalimat: pacing, nutrisi, mental (kalau mode nonRace: tips minggu evaluasi & lanjut ke blok berikutnya, bukan tips race day)"}

Hemat kata: weeklyNotes JANGAN mencakup semua minggu, HANYA minggu yang
penting/beda (minggu pertama, tiap transisi fase, cutback, minggu puncak,
tiap minggu taper/evaluasi). Minggu rutin yang mirip minggu sebelumnya:
lewati saja, jangan dipaksa dikomentari.
'@

# User-triggered (runner says "I'm sick/tired/injured today"), separate
# from the automatic post-generation review above. Keep this prompt in
# sync with api/adjust-plan-feedback.js's copy.
$FEEDBACK_SYSTEM_PROMPT = @'
Kamu pelatih lari berpengalaman, menulis singkat dalam Bahasa Indonesia.
Pelari lagi kasih tau kondisinya (sakit/cedera/capek/sibuk/dll) dan minta
jadwal latihan yang SUDAH DIHITUNG sistem rule-based disesuaikan buat
beberapa hari ke depan yang dia pilih sendiri.

Kamu menerima:
- "note": catatan kondisi pelari, bahasa bebas.
- "days": daftar sesi yang BOLEH disesuaikan (hari "dow" 0=Minggu..6=Sabtu,
  minggu "week", jenis sesi "type", jarak "km" saat ini). Long run BOLEH
  ada di daftar ini kalau memang perlu disesuaikan -- race day TIDAK PERNAH
  ada di daftar ini.

Tugasmu: untuk tiap sesi di "days" yang menurutmu perlu disesuaikan
berdasarkan catatan pelari, sarankan salah satu:
- "skip": sesi itu diistirahatkan total (jarak jadi 0).
- "reduce": jarak diturunkan ke "suggestedKm" (HARUS lebih kecil dari jarak
  aslinya, jangan pernah menaikkan).
Sesi yang menurutmu masih aman dijalankan seperti rencana, JANGAN
dimasukkan ke "adjustments" sama sekali. Sesuaikan levelnya sama beratnya
kondisi pelari -- capek ringan mungkin cuma perlu diturunkan sedikit,
cedera/sakit lebih baik banyak sesi di-skip.

Balas HANYA JSON valid (tanpa code fence, tanpa teks lain), format PERSIS:
{"adjustments": [{"week": N, "dow": 0-6, "action": "skip|reduce", "suggestedKm": X, "reason": "maks 12 kata"}], "summary": "maks 2 kalimat, jelaskan ke pelari kenapa jadwalnya disesuaikan begini"}
'@

function Send-JsonResponse($res, $statusCode, $jsonText) {
  $res.StatusCode = $statusCode
  $res.ContentType = "application/json"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonText)
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

# Shared by both AI endpoints below (enhance-plan and adjust-plan-feedback)
# -- same call/response/error shape, only the system prompt, user message,
# and token budget differ.
function Send-AiResponse($res, $apiKey, $model, $systemPrompt, $userContent, $maxTokens) {
  $requestBody = @{
    model = $model
    max_tokens = $maxTokens
    system = $systemPrompt
    messages = @(@{ role = "user"; content = $userContent })
  } | ConvertTo-Json -Depth 10

  try {
    $aiResponse = Invoke-RestMethod -Uri "https://api.anthropic.com/v1/messages" -Method Post -Headers @{
      "x-api-key" = $apiKey
      "anthropic-version" = "2023-06-01"
      "content-type" = "application/json"
    } -Body $requestBody -TimeoutSec 60

    $textOut = $aiResponse.content[0].text
    $textOut = $textOut -replace '^\s*```json\s*', '' -replace '\s*```\s*$', ''
    # Validate it's actually JSON before handing it to the browser.
    $null = $textOut | ConvertFrom-Json
    Send-JsonResponse $res 200 $textOut
  } catch {
    $errDetail = $_.Exception.Message
    if ($_.Exception.Response) {
      try {
        $stream = $_.Exception.Response.GetResponseStream()
        $streamReader = New-Object System.IO.StreamReader($stream)
        $errBody = $streamReader.ReadToEnd()
        $streamReader.Close()
        if ($errBody) { $errDetail = $errBody }
      } catch {}
    }
    Send-JsonResponse $res 502 (@{ error = "Gagal memanggil Claude API: $errDetail" } | ConvertTo-Json)
  }
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $req = $context.Request
  $res = $context.Response
  try {
    $path = $req.Url.LocalPath

    if ($req.HttpMethod -eq "POST" -and ($path -eq "/api/enhance-plan" -or $path -eq "/api/adjust-plan-feedback")) {
      $apiKey = Get-EnvOrRegistry "ANTHROPIC_API_KEY"
      if (-not $apiKey) {
        Send-JsonResponse $res 400 (@{ error = "ANTHROPIC_API_KEY belum diset di environment variable server. Set dulu (mis. `$env:ANTHROPIC_API_KEY = 'sk-ant-...') lalu restart server." } | ConvertTo-Json)
      } else {
        $reader = New-Object System.IO.StreamReader($req.InputStream, $req.ContentEncoding)
        $bodyText = $reader.ReadToEnd()
        $reader.Close()

        # Defaults to Haiku 4.5 — the cheapest/fastest model in the current
        # lineup, plenty for short qualitative coaching notes. Override by
        # setting ANTHROPIC_MODEL (e.g. to "claude-sonnet-5") for better —
        # but pricier — writing quality.
        $model = Get-EnvOrRegistry "ANTHROPIC_MODEL"
        if (-not $model) { $model = "claude-haiku-4-5-20251001" }

        if ($path -eq "/api/enhance-plan") {
          Send-AiResponse $res $apiKey $model $AI_SYSTEM_PROMPT "Data rencana latihan (JSON):`n$bodyText" 900
        } else {
          Send-AiResponse $res $apiKey $model $FEEDBACK_SYSTEM_PROMPT $bodyText 700
        }
      }
    } else {
      if ($path -eq "/") { $path = "/index.html" }
      $filePath = Join-Path $root ($path.TrimStart("/"))
      if (Test-Path $filePath -PathType Leaf) {
        $ext = [System.IO.Path]::GetExtension($filePath)
        $ct = $mime[$ext]
        if (-not $ct) { $ct = "application/octet-stream" }
        $bytes = [System.IO.File]::ReadAllBytes($filePath)
        $res.ContentType = $ct
        $res.ContentLength64 = $bytes.Length
        $res.OutputStream.Write($bytes, 0, $bytes.Length)
      } else {
        $res.StatusCode = 404
        $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found: $path")
        $res.OutputStream.Write($msg, 0, $msg.Length)
      }
    }
  } catch {
    $res.StatusCode = 500
  } finally {
    $res.OutputStream.Close()
  }
}
