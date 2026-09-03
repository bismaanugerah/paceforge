/**
 * PaceForge — server/strava.js
 * Talks to Strava's OAuth + Activities API (plain fetch, no SDK) and turns a
 * raw activity list into the handful of numbers PaceForge's form actually
 * needs. Runs entirely server-side — the client never sees a Strava token.
 */

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';
// Single-activity DETAIL endpoint (note: /activities/{id}, not
// /athlete/activities) — only this one, not the list endpoint above,
// includes `best_efforts` (see bestEffortWithinRuns below).
const ACTIVITY_DETAIL_URL = 'https://www.strava.com/api/v3/activities';

function getCredentials() {
  // Same client ID value as js/config.js (it's public, not a secret) — set
  // once more here as a server env var so this file doesn't need to know
  // about js/config.js at all.
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('STRAVA_CLIENT_ID / STRAVA_CLIENT_SECRET belum diset di environment variable server.');
  }
  return { clientId, clientSecret };
}

// First leg of the OAuth dance: trade the one-time `code` Strava redirected
// back with for an access + refresh token pair, plus the athlete's basic
// profile (Strava only includes `athlete` in this specific response, never
// again on later refreshes).
async function exchangeCodeForToken(code) {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Strava token exchange gagal (${res.status})`);
  return data; // { access_token, refresh_token, expires_at, athlete: {...} }
}

// expires_at (from Strava) is a unix-seconds timestamp already, not a TTL —
// refresh a bit before it actually lapses to avoid a request racing expiry.
async function refreshAccessToken(refreshToken) {
  const { clientId, clientSecret } = getCredentials();
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Strava token refresh gagal (${res.status})`);
  return data; // { access_token, refresh_token, expires_at }
}

// Pages through /athlete/activities, filtered to Run-type activities that
// started after `afterEpochSeconds`. Capped at 3 pages (600 activities) —
// plenty for a recreational runner's last ~6 months, and keeps this well
// under Strava's rate limit (200 req/15min, 2000/day per app) even if many
// users refresh their summary around the same time.
async function fetchRecentRuns(accessToken, afterEpochSeconds) {
  const perPage = 200;
  const maxPages = 3;
  const runs = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = `${ACTIVITIES_URL}?after=${afterEpochSeconds}&per_page=${perPage}&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    const data = await res.json();
    if (!res.ok) throw new Error(data?.message || `Strava activities fetch gagal (${res.status})`);
    if (!Array.isArray(data) || data.length === 0) break;
    for (const activity of data) {
      if (activity.type === 'Run') runs.push(activity);
    }
    if (data.length < perPage) break; // halaman terakhir
  }
  return runs;
}

function daysAgo(n) {
  return new Date(Date.now() - n * 24 * 3600 * 1000);
}

// Fetches one activity's full detail — needed only for `best_efforts` (see
// bestEffortWithinRuns below), which the list endpoint fetchRecentRuns uses
// doesn't include.
async function fetchActivityDetail(accessToken, activityId) {
  const res = await fetch(`${ACTIVITY_DETAIL_URL}/${activityId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.message || `Strava activity detail fetch gagal (${res.status})`);
  return data;
}

// Strava's start_date_local is the athlete's local wall-clock time,
// serialized as ISO 8601 but with a 'Z' suffix as if it were UTC (Strava's
// own documented quirk) — so a Date parsed from it has the *local*
// calendar date sitting in its UTC-getters, not its local ones (those
// would additionally apply *this server's* own timezone offset on top,
// which is wrong here). Read with getUTC*() specifically so this stays
// correct regardless of what timezone the server process itself runs in.
function localDateStr(startDateLocalIso) {
  const d = new Date(startDateLocalIso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Riegel's race-time-prediction formula — same formula/exponent as
// js/planGenerator.js's predictRaceTime, duplicated here since this runs
// server-side and has no access to that client-only module. Used below to
// compare race-tagged runs of different distances on equal footing (a fast
// 5K and a slower half marathon aren't directly comparable by raw time).
function riegelPredict(timeSec, fromKm, toKm) {
  return timeSec * Math.pow(toKm / fromKm, 1.06);
}

// workout_type === 1 is how Strava itself tags an activity as "Race" (set by
// the athlete, either at upload or afterward in Strava). Among those, in the
// last 3 months, picks the one that best represents current fitness — the
// BEST performance (fastest 10K-equivalent time via Riegel), not simply the
// most recently run one: a mediocre-effort race run last week is a worse
// fitness signal than a strong one run six weeks ago. A tagged race is used
// AS A WHOLE, start to finish — never trimmed to a faster-looking segment —
// since Riegel's prediction assumes a single maximal, paced effort over the
// full distance, which is exactly what a real race already is.
function bestTaggedRace(runs, cutoff90) {
  let best = null;
  let bestEquivSec = Infinity;
  for (const run of runs) {
    const startedAt = new Date(run.start_date_local || run.start_date);
    if (Number.isNaN(startedAt.getTime()) || startedAt < cutoff90) continue;
    if (run.workout_type !== 1) continue;
    const km = (run.distance || 0) / 1000;
    if (!(km > 0) || !(run.moving_time > 0)) continue;
    const equivSec = riegelPredict(run.moving_time, km, 10);
    if (equivSec < bestEquivSec) {
      bestEquivSec = equivSec;
      best = { distanceKm: Math.round(km * 10) / 10, timeSec: Math.round(run.moving_time), equivSec };
    }
  }
  return best;
}

const MIN_EFFORT_KM = 3; // below this, a "best effort" is more likely a stride/segment PR than a real pace signal
const MAX_DETAIL_FETCHES = 8; // caps the extra per-activity API calls this adds — see bestEffortWithinRuns' own comment
const MIN_PLAUSIBLE_PACE_SEC_PER_KM = 120; // 2:00/km — same implausibility floor js/planGenerator.js uses; catches GPS glitches before they become someone's goal pace

// Most runners never manually tag a Strava activity "Race" — even a session
// that WAS their best recent effort. Detecting a race-worthy performance
// can't depend on that tag, so this instead looks at the fastest QUALITY
// SEGMENT within an athlete's recent runs: a tempo/interval session's hard
// portion, not diluted by that same run's warm up/cool down/recovery jogs
// (which whole-activity average pace — all fetchRecentRuns' list endpoint
// returns — can't separate out). Strava computes this itself per activity as
// `best_efforts` (its "fastest 5K/10K/etc within this run" feature), but
// only on the single-activity DETAIL endpoint, not the list one, so getting
// it costs one extra API call per activity checked.
// To stay well inside Strava's rate limit (200 req/15min — see
// fetchRecentRuns above) this only fetches detail for a bounded shortlist:
// the MAX_DETAIL_FETCHES fastest non-Race-tagged runs (by simple whole-
// activity pace, Riegel-normalized) in the last 90 days — cheap to compute
// from data already in hand, and a run whose OVERALL pace isn't at least
// competitive has little chance of containing a genuinely fast segment
// worth the extra call. Race-tagged runs are excluded here entirely — see
// bestTaggedRace above, which handles those on their own terms.
async function bestEffortWithinRuns(accessToken, runs, cutoff90) {
  const candidates = runs.filter(run => {
    const startedAt = new Date(run.start_date_local || run.start_date);
    if (Number.isNaN(startedAt.getTime()) || startedAt < cutoff90) return false;
    if (run.workout_type === 1) return false;
    const km = (run.distance || 0) / 1000;
    return km >= MIN_EFFORT_KM && run.moving_time > 0;
  });
  candidates.sort((a, b) => riegelPredict(a.moving_time, a.distance / 1000, 10) - riegelPredict(b.moving_time, b.distance / 1000, 10));
  const shortlist = candidates.slice(0, MAX_DETAIL_FETCHES);

  let best = null;
  let bestEquivSec = Infinity;
  await Promise.all(shortlist.map(async (run) => {
    let detail;
    try {
      detail = await fetchActivityDetail(accessToken, run.id);
    } catch {
      return; // best-effort only (pun intended) — one failed detail fetch shouldn't break the whole summary
    }
    for (const effort of detail.best_efforts || []) {
      const km = (effort.distance || 0) / 1000;
      if (km < MIN_EFFORT_KM || !(effort.moving_time > 0)) continue;
      if (effort.moving_time / km < MIN_PLAUSIBLE_PACE_SEC_PER_KM) continue; // implausibly fast — likely a GPS glitch, not a real effort
      const equivSec = riegelPredict(effort.moving_time, km, 10);
      if (equivSec < bestEquivSec) {
        bestEquivSec = equivSec;
        best = { distanceKm: Math.round(km * 10) / 10, timeSec: Math.round(effort.moving_time), equivSec };
      }
    }
  }));
  return best;
}

// Turns a raw Run-activity list into exactly the fields PaceForge's form
// can use to prefill itself. See supabase/schema.sql + api/strava-summary.js
// for how this gets cached. `accessToken` is only needed for
// bestEffortWithinRuns' detail fetches — everything else here works purely
// off the already-fetched `runs` list.
async function summarizeRuns(runs, accessToken) {
  const cutoff28 = daysAgo(28);
  const cutoff90 = daysAgo(90);
  const cutoff56 = daysAgo(56);

  let km28 = 0;
  let longestKm90 = 0;
  const dayOfWeekCounts = new Array(7).fill(0);

  for (const run of runs) {
    const startedAt = new Date(run.start_date_local || run.start_date);
    if (Number.isNaN(startedAt.getTime())) continue;
    const km = (run.distance || 0) / 1000;

    if (startedAt >= cutoff28) km28 += km;
    if (startedAt >= cutoff90) longestKm90 = Math.max(longestKm90, km);
    if (startedAt >= cutoff56) dayOfWeekCounts[startedAt.getDay()]++;
  }

  // Compare the athlete's best tagged-race performance against the best
  // quality segment found within their other runs, and keep whichever one
  // is the stronger fitness signal (lower 10K-equivalent time) — not
  // hardcoded to always prefer the tagged race, since an old/soft-effort
  // "race" tag shouldn't outrank a genuinely faster recent tempo session.
  const taggedRace = bestTaggedRace(runs, cutoff90);
  const effortBest = await bestEffortWithinRuns(accessToken, runs, cutoff90);
  const candidates = [taggedRace, effortBest].filter(Boolean).sort((a, b) => a.equivSec - b.equivSec);
  const bestPerformance = candidates[0] || null;

  const suggestedDaysOfWeek = dayOfWeekCounts
    .map((count, dow) => ({ dow, count }))
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .map(d => d.dow);

  // Lightweight per-activity list (one entry per run, whole `runs` window —
  // not clipped to any of the cutoffs above) so the client can match a
  // plan day against whatever actually happened on that calendar date —
  // see js/app.js's markCompletedSessionsFromStrava. Deliberately just
  // date/distance/time (+ id), not the full Strava activity payload. `id`
  // is what lets the client ask api/strava-activity-detail.js for that one
  // activity's `best_efforts` afterward, for a recently-completed session
  // whose comparison shouldn't be diluted by warm up/cool down — see that
  // endpoint's own comment for why this isn't done for every matched run.
  const recentRuns = runs
    .map(run => {
      const date = localDateStr(run.start_date_local || run.start_date);
      if (!date || !(run.distance > 0)) return null;
      return { id: run.id, date, km: Math.round((run.distance / 1000) * 100) / 100, movingTimeSec: Math.round(run.moving_time || 0) };
    })
    .filter(Boolean);

  return {
    currentWeeklyKm: km28 > 0 ? Math.round(km28 / 4) : null,
    longestRecentRunKm: longestKm90 > 0 ? Math.round(longestKm90 * 10) / 10 : null,
    // isEstimate: false only when bestPerformance came from a genuine
    // Strava-tagged race (=== taggedRace); true when it's the best quality
    // segment found within an otherwise-untagged run instead — see
    // js/app.js's applyStravaSummaryToForm for how the two get labeled
    // differently on the form.
    recentRace: bestPerformance ? {
      distanceKm: bestPerformance.distanceKm,
      timeSec: bestPerformance.timeSec,
      isEstimate: bestPerformance !== taggedRace,
    } : null,
    suggestedDaysOfWeek,
    recentRuns,
  };
}

module.exports = { exchangeCodeForToken, refreshAccessToken, fetchRecentRuns, fetchActivityDetail, summarizeRuns };
