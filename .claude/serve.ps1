$root = Split-Path -Parent $PSScriptRoot
$port = 5173
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
# js/planGenerator.js and never touched here. This endpoint only asks Claude
# for qualitative coaching notes layered on top of that already-fixed plan.
$AI_SYSTEM_PROMPT = @'
Kamu pelatih lari, menulis singkat dalam Bahasa Indonesia. Data rencana lari
(jarak & fase per minggu) SUDAH DIHITUNG dan TIDAK BOLEH diubah/disebut ulang
beda. Tugasmu HANYA menambah catatan pelatih yang personal & actionable,
mempertimbangkan catatan tambahan pelari (cedera/jadwal/preferensi) jika ada.

Balas HANYA JSON valid (tanpa code fence, tanpa teks lain), format PERSIS:
{"intro": "maks 2 kalimat ringkasan strategi", "weeklyNotes": [{"week": N, "note": "maks 12 kata"}], "raceDayTips": "maks 3 kalimat: pacing, nutrisi, mental"}

Hemat kata: weeklyNotes JANGAN mencakup semua minggu — HANYA minggu yang
penting/beda (minggu pertama, tiap transisi fase, cutback, minggu puncak,
tiap minggu taper, race week). Minggu rutin yang mirip minggu sebelumnya:
lewati saja, jangan dipaksa dikomentari.
'@

function Send-JsonResponse($res, $statusCode, $jsonText) {
  $res.StatusCode = $statusCode
  $res.ContentType = "application/json"
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($jsonText)
  $res.OutputStream.Write($bytes, 0, $bytes.Length)
}

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $req = $context.Request
  $res = $context.Response
  try {
    $path = $req.Url.LocalPath

    if ($req.HttpMethod -eq "POST" -and $path -eq "/api/enhance-plan") {
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
        $requestBody = @{
          model = $model
          max_tokens = 900
          system = $AI_SYSTEM_PROMPT
          messages = @(@{ role = "user"; content = "Data rencana latihan (JSON):`n$bodyText" })
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
