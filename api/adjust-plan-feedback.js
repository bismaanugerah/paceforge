/**
 * PaceForge — api/adjust-plan-feedback.js
 * Vercel serverless function (Node.js). Separate from api/enhance-plan.js
 * (the automatic post-generation review) — this one is user-triggered:
 * the runner tells the app they're sick/tired/injured/busy, for whichever
 * upcoming days they pick (this week only, or from today through the rest
 * of the plan), and Claude suggests backing those specific sessions off.
 * Same "advisory only" contract as enhance-plan.js: js/app.js validates
 * and clamps every adjustment (never increasing a session, never touching
 * race day) before applying anything — this endpoint and the prompt below
 * just ask nicely, they don't enforce it.
 */

const AI_SYSTEM_PROMPT = `Kamu pelatih lari berpengalaman, menulis singkat dalam Bahasa Indonesia.
Pelari lagi kasih tau kondisinya (sakit/cedera/capek/sibuk/dll) dan minta
jadwal latihan yang SUDAH DIHITUNG sistem rule-based disesuaikan buat
beberapa hari ke depan yang dia pilih sendiri.

Kamu menerima:
- "note": catatan kondisi pelari, bahasa bebas.
- "days": daftar sesi yang BOLEH disesuaikan (hari "dow" 0=Minggu..6=Sabtu,
  minggu "week", jenis sesi "type", jarak "km" saat ini). Long run BOLEH
  ada di daftar ini kalau memang perlu disesuaikan — race day TIDAK PERNAH
  ada di daftar ini.

Tugasmu: untuk tiap sesi di "days" yang menurutmu perlu disesuaikan
berdasarkan catatan pelari, sarankan salah satu:
- "skip": sesi itu diistirahatkan total (jarak jadi 0).
- "reduce": jarak diturunkan ke "suggestedKm" (HARUS lebih kecil dari jarak
  aslinya, jangan pernah menaikkan).
Sesi yang menurutmu masih aman dijalankan seperti rencana, JANGAN
dimasukkan ke "adjustments" sama sekali. Sesuaikan levelnya sama beratnya
kondisi pelari — capek ringan mungkin cuma perlu diturunkan sedikit,
cedera/sakit lebih baik banyak sesi di-skip.

Balas HANYA JSON valid (tanpa code fence, tanpa teks lain), format PERSIS:
{"adjustments": [{"week": N, "dow": 0-6, "action": "skip|reduce", "suggestedKm": X, "reason": "maks 12 kata"}], "summary": "maks 2 kalimat, jelaskan ke pelari kenapa jadwalnya disesuaikan begini"}`;

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

  // Same default as enhance-plan.js (cheapest/fastest model, plenty for
  // this) — override with ANTHROPIC_MODEL if better writing quality is
  // worth the extra cost.
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
        max_tokens: 700,
        system: AI_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: bodyText }],
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
