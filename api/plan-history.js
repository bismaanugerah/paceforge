/**
 * PaceForge — api/plan-history.js
 * List (GET) / append (POST) snapshots of the athlete's already-finished
 * training blocks — the "Riwayat Blok" panel's data source (see
 * loadAndRenderBlockHistory in js/app.js). A snapshot only gets appended on
 * a genuine rolling-block transition (a new plan generated after the
 * previous one's block-end date has passed — see archivePreviousBlock in
 * js/app.js), never on an in-place edit of a still-upcoming plan.
 *
 * Deliberately separate from api/plan.js's `plans` table: that one holds
 * ONLY the current active block (one row per athlete, overwritten on every
 * save); this one accumulates one row per past block instead, and is never
 * overwritten — see supabase/schema.sql's plan_history table.
 */
const { getSession } = require('../server/session');
const { selectMany, insert } = require('../server/supabaseAdmin');

// Plenty for a multi-year rolling-block history (even weekly Maintenance
// regenerations wouldn't realistically approach this) without the list —
// or the trend chart built from it — growing unbounded.
const HISTORY_LIMIT = 50;

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Belum login.' });
    return;
  }

  if (req.method === 'GET') {
    try {
      const rows = await selectMany('plan_history', 'athlete_id', session.athleteId, 'block_end', HISTORY_LIMIT);
      // Lightweight by design (mirrors api/strava-summary.js's recentRuns
      // list) — never the full `settings` jsonb, which the trend chart/list
      // has no use for; that column exists purely for a possible future
      // "lihat detail blok ini" drill-down.
      res.status(200).json({
        blocks: rows.map(r => ({
          id: r.id,
          mode: r.mode,
          nonRaceStyle: r.non_race_style,
          raceLabel: r.race_label,
          raceDistanceKm: r.race_distance_km,
          blockStart: r.block_start,
          blockEnd: r.block_end,
          totalKm: r.total_km,
          startVdot: r.start_vdot,
          endVdot: r.end_vdot,
        })),
      });
    } catch (err) {
      res.status(502).json({ error: `Gagal memuat riwayat blok: ${err.message}` });
    }
    return;
  }

  if (req.method === 'POST') {
    try {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
      const { mode, nonRaceStyle, raceLabel, raceDistanceKm, blockStart, blockEnd, totalKm, startVdot, endVdot, settings } = body || {};
      if (!mode || !raceLabel || !blockStart || !blockEnd || !settings) {
        res.status(400).json({ error: 'Field snapshot blok tidak lengkap.' });
        return;
      }
      await insert('plan_history', {
        athlete_id: session.athleteId,
        mode,
        non_race_style: nonRaceStyle || null,
        race_label: raceLabel,
        race_distance_km: raceDistanceKm ?? null,
        block_start: blockStart,
        block_end: blockEnd,
        total_km: totalKm ?? null,
        start_vdot: startVdot ?? null,
        end_vdot: endVdot ?? null,
        settings,
      });
      res.status(200).json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: `Gagal menyimpan riwayat blok: ${err.message}` });
    }
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
