/**
 * PaceForge — api/plan.js
 * Load (GET) / save (POST) the current athlete's last training plan. Same
 * one-row-per-user shape as the old direct `supabase.from('plans')` calls
 * from js/app.js — just proxied through here now that the client no longer
 * holds any Supabase credentials at all.
 */
const { getSession } = require('../server/session');
const { selectOne, upsert } = require('../server/supabaseAdmin');

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Belum login.' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const row = await selectOne('plans', 'athlete_id', session.athleteId);
      res.status(200).json(row ? { settings: row.settings, user_notes: row.user_notes } : { settings: null, user_notes: '' });
    } catch (err) {
      res.status(502).json({ error: `Gagal memuat plan: ${err.message}` });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { settings, user_notes } = body || {};
      if (!settings) {
        res.status(400).json({ error: 'settings wajib diisi.' });
        return;
      }
      await upsert('plans', {
        athlete_id: session.athleteId,
        settings,
        user_notes: user_notes || '',
        updated_at: new Date().toISOString(),
      }, 'athlete_id');
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `Gagal menyimpan plan: ${err.message}` });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
