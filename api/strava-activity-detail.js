/**
 * PaceForge — api/strava-activity-detail.js
 * Returns one Strava activity's `best_efforts` (its "fastest 5K/10K/etc
 * within this run" feature) — trimmed to just name/distance/time, nothing
 * else from Strava's much larger detail payload.
 *
 * Only called by js/app.js's markCompletedSessionsFromStrava, and only for
 * a recently-completed session it's already matched to a plan day (see that
 * function's own comment for the rate-limit reasoning behind "recently" —
 * the whole plan's history is deliberately NOT walked here). No server-side
 * caching: a past activity's best_efforts never change, so the client
 * itself caches the response (sessionStorage, keyed by activity id) instead
 * of this endpoint needing its own cache table.
 *
 * Ownership isn't checked explicitly here — Strava's own API already scopes
 * `GET /activities/{id}` to whatever athlete `accessToken` belongs to
 * (someone else's activity id just 404s), so there's nothing extra to
 * enforce on top of that.
 */
const { getSession } = require('../server/session');
const { selectOne, update } = require('../server/supabaseAdmin');
const { refreshAccessToken, fetchActivityDetail } = require('../server/strava');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Belum login.' });
    return;
  }

  const activityId = req.query?.id;
  if (!activityId || !/^\d+$/.test(String(activityId))) {
    res.status(400).json({ error: 'Parameter id tidak valid.' });
    return;
  }

  try {
    const athlete = await selectOne('strava_athletes', 'athlete_id', session.athleteId);
    if (!athlete) {
      res.status(404).json({ error: 'Akun Strava tidak ditemukan — coba logout lalu login lagi.' });
      return;
    }

    let accessToken = athlete.access_token;
    const nowSec = Math.floor(Date.now() / 1000);
    if (athlete.expires_at - nowSec < 300) {
      const refreshed = await refreshAccessToken(athlete.refresh_token);
      accessToken = refreshed.access_token;
      // Best-effort, same reasoning as api/strava-summary.js's own copy of
      // this block — a failed save here just means the next request
      // refreshes again, not fatal to this one.
      try {
        await update('strava_athletes', 'athlete_id', athlete.athlete_id, {
          access_token: refreshed.access_token,
          refresh_token: refreshed.refresh_token,
          expires_at: refreshed.expires_at,
          updated_at: new Date().toISOString(),
        });
      } catch (err) {
        console.warn('[PaceForge] Gagal menyimpan refreshed Strava token:', err.message);
      }
    }

    const detail = await fetchActivityDetail(accessToken, activityId);
    const bestEfforts = (detail.best_efforts || [])
      .filter(effort => effort.distance > 0 && effort.moving_time > 0)
      .map(effort => ({
        name: effort.name,
        distanceKm: Math.round((effort.distance / 1000) * 100) / 100,
        timeSec: Math.round(effort.moving_time),
      }));

    res.status(200).json({ bestEfforts });
  } catch (err) {
    res.status(502).json({ error: `Gagal mengambil detail activity Strava: ${err.message}` });
  }
};
