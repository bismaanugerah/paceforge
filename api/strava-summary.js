/**
 * PaceForge — api/strava-summary.js
 * Returns the derived numbers js/app.js uses to prefill the training-plan
 * form: recent weekly km, longest recent run, last detected race, and which
 * weekdays the athlete runs most. Refreshes the Strava access token when
 * it's stale, and caches the computed summary for an hour so a page reload
 * doesn't re-hit Strava's API every time.
 */
const { getSession } = require('../server/session');
const { selectOne, update } = require('../server/supabaseAdmin');
const { refreshAccessToken, fetchRecentRuns, summarizeRuns } = require('../server/strava');

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 jam
const LOOKBACK_DAYS = 100; // sedikit lebih dari 90 hari (buffer buat deteksi race terbaik 3 bulan terakhir — lihat summarizeRuns)

// Bump this whenever summarizeRuns' output shape or logic changes in a way
// that matters (e.g. adding `recentRace.isEstimate` — see server/strava.js).
// A cached summary computed by an OLDER version is otherwise
// indistinguishable from a fresh one by age alone: the 1-hour TTL above has
// no idea a deploy just changed what "the summary" even means, so without
// this, anyone whose cache was still warm at deploy time keeps getting
// served the stale shape (missing fields silently read as falsy/undefined
// on the client) for up to an hour after the fix already shipped.
// v3: recentRuns entries gained an `id` field (see server/strava.js's
// summarizeRuns) — required by api/strava-activity-detail.js's per-session
// best_efforts lookup in js/app.js, so a v2 cache (which lacks it) has to
// be invalidated too, not just treated as "close enough".
const SUMMARY_CACHE_VERSION = 3;

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

    if (athlete.summary_cache && athlete.summary_cached_at && athlete.summary_cache._cacheVersion === SUMMARY_CACHE_VERSION) {
      const age = Date.now() - new Date(athlete.summary_cached_at).getTime();
      if (age < CACHE_TTL_MS) {
        const { _cacheVersion, ...cached } = athlete.summary_cache;
        res.status(200).json(cached);
        return;
      }
    }

    let accessToken = athlete.access_token;
    const nowSec = Math.floor(Date.now() / 1000);
    if (athlete.expires_at - nowSec < 300) {
      const refreshed = await refreshAccessToken(athlete.refresh_token);
      accessToken = refreshed.access_token;
      // Best-effort: the refreshed token above is already in hand for this
      // request regardless of whether persisting it succeeds — a failure
      // here just means the next request refreshes again, not fatal.
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

    const afterEpoch = Math.floor(Date.now() / 1000) - LOOKBACK_DAYS * 24 * 3600;
    const runs = await fetchRecentRuns(accessToken, afterEpoch);
    const summary = await summarizeRuns(runs, accessToken);

    // Best-effort caching too — the summary is already computed and about
    // to be returned below either way, a caching failure shouldn't turn
    // into a user-facing error.
    try {
      await update('strava_athletes', 'athlete_id', athlete.athlete_id, {
        summary_cache: { ...summary, _cacheVersion: SUMMARY_CACHE_VERSION },
        summary_cached_at: new Date().toISOString(),
      });
    } catch (err) {
      console.warn('[PaceForge] Gagal menyimpan cache summary Strava:', err.message);
    }

    res.status(200).json(summary);
  } catch (err) {
    res.status(502).json({ error: `Gagal mengambil data Strava: ${err.message}` });
  }
};
