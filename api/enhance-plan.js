/**
 * PaceForge — api/enhance-plan.js
 * Vercel serverless function (Node.js). This is the production version of
 * the same endpoint .claude/serve.ps1 serves locally — same contract, same
 * system prompt — so ANTHROPIC_API_KEY never has to reach the browser.
 *
 * The rule-based schedule (days/km/pace) is computed entirely client-side
 * in js/planGenerator.js. Claude never rewrites it from scratch — this
 * endpoint asks it to (a) review the already-computed week-by-week plan and
 * optionally flag/adjust a handful of individual non-long-run sessions that
 * look unrealistic, and (b) write qualitative coaching notes. Claude's
 * suggested adjustments are advisory only: js/app.js validates and clamps
 * every one (±20% of the original, never touching long run/race day, capped
 * at that plan's race-appropriate maxSupportKm — see RACE_PROFILES in
 * js/planGenerator.js) before applying anything — this endpoint and the
 * prompt below just ask nicely, they don't enforce it.
 */

const AI_SYSTEM_PROMPT = `Kamu pelatih lari berpengalaman, menulis singkat dalam Bahasa Indonesia.
Kamu menerima draft jadwal latihan mingguan yang SUDAH DIHITUNG oleh sistem
rule-based: tiap minggu berisi fase, total km, dan daftar sesi lari (hari
"dow" 0=Minggu..6=Sabtu, jenis sesi, jarak km).

Tugasmu:
1. Tinjau apakah ada sesi individual berjenis "easy", "recovery", "tempo",
   "interval", atau "repetition" SAJA (JANGAN PERNAH longRun/race/shakeout)
   yang jaraknya terasa tidak realistis untuk jenis sesinya (mis. easy run
   yang kepanjangan dibanding long run minggu itu, tempo run yang mustahil
   dijaga terus-menerus di pace tempo, atau repetition run yang kepanjangan
   untuk sesi sprint-pendek-recovery-penuh). Kalau nemu, sarankan lewat
   field "adjustments" (PALING BANYAK 5, tiap saran maksimal sekitar ±20%
   dari jarak aslinya). Kalau semua sesi sudah masuk akal, "adjustments"
   cukup array kosong — JANGAN dipaksakan cari-cari masalah yang tidak ada.
2. Tambahkan catatan pelatih yang personal & actionable, mempertimbangkan
   catatan tambahan pelari (cedera/jadwal/preferensi) jika ada.

Balas HANYA JSON valid (tanpa code fence, tanpa teks lain), format PERSIS:
{"adjustments": [{"week": N, "dow": 0-6, "type": "easy|recovery|tempo|interval|repetition", "suggestedKm": X, "reason": "maks 12 kata"}], "intro": "maks 2 kalimat ringkasan strategi", "weeklyNotes": [{"week": N, "note": "maks 12 kata"}], "raceDayTips": "maks 3 kalimat: pacing, nutrisi, mental"}

Hemat kata: weeklyNotes JANGAN mencakup semua minggu, HANYA minggu yang
penting/beda (minggu pertama, tiap transisi fase, cutback, minggu puncak,
tiap minggu taper, race week). Minggu rutin yang mirip minggu sebelumnya:
lewati saja, jangan dipaksa dikomentari.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(400).json({ error: 'ANTHROPIC_API_KEY belum diset di environment variable server (Vercel project settings).' });
    return;
  }

  // Defaults to Haiku 4.5 — the cheapest/fastest model in the current
  // lineup, plenty for short qualitative coaching notes. Override by
  // setting ANTHROPIC_MODEL (e.g. to "claude-sonnet-5") for better — but
  // pricier — writing quality.
  const model = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';

  let bodyText;
  try {
    bodyText = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } catch {
    res.status(400).json({ error: 'Body request tidak valid.' });
    return;
  }

  try {
    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        max_tokens: 900,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: `Data rencana latihan (JSON):\n${bodyText}` }],
      }),
    });

    const aiData = await aiRes.json();
    if (!aiRes.ok) {
      throw new Error(aiData?.error?.message || `Claude API merespons status ${aiRes.status}`);
    }

    let textOut = aiData.content?.[0]?.text || '';
    textOut = textOut.replace(/^\s*```json\s*/, '').replace(/\s*```\s*$/, '');

    // Validate it's actually JSON before handing it to the browser.
    const parsed = JSON.parse(textOut);
    res.status(200).json(parsed);
  } catch (err) {
    res.status(502).json({ error: `Gagal memanggil Claude API: ${err.message}` });
  }
};
