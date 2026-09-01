/**
 * PaceForge — api/strava-summary.js
 * Returns the derived numbers js/app.js uses to prefill the training-plan
 * form: recent weekly km, longest recent run, last detected race, and which
 * weekdays the athlete runs most. Refreshes the Strava access token when
 * it's stale, and caches the computed summary for an hour so a page reload
 * doesn't re-hit Strava's API every time.
 */
const { getSession } = require('../server/session');
const { selectOne, upsert } = require('../server/supabaseAdmin');
const { refreshAccessToken, fetchRecentRuns, summarizeRuns } = require('../server/strava');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam
const LOOKBACK_DAYS = 190; // sedikit lebih dari 180 hari (buffer buat deteksi race terakhir)

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

  try {
    const athlete = await selectOne('strava_athletes', 'athlete_id', session.athleteId);
    if (!athlete) {
      res.status(404).json({ error: 'Akun Strava tidak ditemukan — coba logout lalu login lagi.' });
      return;
    }

    if (athlete.summary_cache && athlete.summary_cached_at) {
      const age = Date.now() - new Date(athlete.summary_cached_at).getTime();
      if (age < CACHE_TTL_MS) {
        res.status(200).json(athlete.summary_cache);
        return;
      }
    }

    let accessToken = athlete.access_token;
    const nowSec = Math.floor(Date.now() / 1000);
    if (athlete.expires_at - nowSec < 300) {
      const refreshed = await refreshAccessToken(athlete.refresh_token);
      accessToken = refreshed.access_token;
      await upsert('strava_athletes', {
        athlete_id: athlete.athlete_id,
        access_token: refreshed.access_token,
        refresh_token: refreshed.refresh_token,
        expires_at: refreshed.expires_at,
        updated_at: new Date().toISOString(),
      }, 'athlete_id');
    }

    const afterEpoch = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 3600;
    const runs = await fetchRecentRuns(accessToken, afterEpoch);
    const summary = summarizeRuns(runs);

    await upsert('strava_athletes', {
      athlete_id: athlete.athlete_id,
      summary_cache: summary,
      summary_cached_at: new Date().toISOString(),
    }, 'athlete_id');

    res.status(200).json(summary);
  } catch (err) {
    res.status(502).json({ error: `Gagal mengambil data Strava: ${err.message}` });
  }
};
