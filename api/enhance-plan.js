/**
 * PaceForge — api/enhance-plan.js
 * Vercel serverless function (Node.js). This is the production version of
 * the same endpoint .claude/serve.ps1 serves locally — same contract, same
 * system prompt — so ANTHROPIC_API_KEY never has to reach the browser.
 *
 * The rule-based schedule (days/km/pace) is computed entirely client-side
 * in js/planGenerator.js and never touched here. This endpoint only asks
 * Claude for qualitative coaching notes layered on top of that
 * already-fixed plan.
 */

const AI_SYSTEM_PROMPT = `Kamu pelatih lari, menulis singkat dalam Bahasa Indonesia. Data rencana lari
(jarak & fase per minggu) SUDAH DIHITUNG dan TIDAK BOLEH diubah/disebut ulang
beda. Tugasmu HANYA menambah catatan pelatih yang personal & actionable,
mempertimbangkan catatan tambahan pelari (cedera/jadwal/preferensi) jika ada.

Balas HANYA JSON valid (tanpa code fence, tanpa teks lain), format PERSIS:
{"intro": "maks 2 kalimat ringkasan strategi", "weeklyNotes": [{"week": N, "note": "maks 12 kata"}], "raceDayTips": "maks 3 kalimat: pacing, nutrisi, mental"}

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
