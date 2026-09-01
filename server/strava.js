/**
 * PaceForge — server/strava.js
 * Talks to Strava's OAuth + Activities API (plain fetch, no SDK) and turns a
 * raw activity list into the handful of numbers PaceForge's form actually
 * needs. Runs entirely server-side — the client never sees a Strava token.
 */

const TOKEN_URL = 'https://www.strava.com/oauth/token';
const ACTIVITIES_URL = 'https://www.strava.com/api/v3/athlete/activities';

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

// Turns a raw Run-activity list into exactly the fields PaceForge's form
// can use to prefill itself. See supabase/schema.sql + api/strava-summary.js
// for how this gets cached.
function summarizeRuns(runs) {
  const cutoff28 = daysAgo(28);
  const cutoff90 = daysAgo(90);
  const cutoff180 = daysAgo(180);
  const cutoff56 = daysAgo(56);

  let km28 = 0;
  let longestKm90 = 0;
  let mostRecentRace = null;
  const dayOfWeekCounts = new Array(7).fill(0);

  for (const run of runs) {
    const startedAt = new Date(run.start_date_local || run.start_date);
    if (Number.isNaN(startedAt.getTime())) continue;
    const km = (run.distance || 0) / 1000;

    if (startedAt >= cutoff28) km28 += km;
    if (startedAt >= cutoff90) longestKm90 = Math.max(longestKm90, km);
    if (startedAt >= cutoff56) dayOfWeekCounts[startedAt.getDay()]++;

    // workout_type === 1 is how Strava itself tags an activity as "Race"
    // (set by the athlete, either at upload or afterward in Strava).
    if (run.workout_type === 1 && startedAt >= cutoff180) {
      if (!mostRecentRace || startedAt > new Date(mostRecentRace.start_date_local || mostRecentRace.start_date)) {
        mostRecentRace = run;
      }
    }
  }

  const suggestedDaysOfWeek = dayOfWeekCounts
    .map((count, dow) => ({ dow, count }))
    .filter(d => d.count > 0)
    .sort((a, b) => b.count - a.count)
    .map(d => d.dow);

  return {
    currentWeeklyKm: km28 > 0 ? Math.round(km28 / 4) : null,
    longestRecentRunKm: longestKm90 > 0 ? Math.round(longestKm90 * 10) / 10 : null,
    recentRace: mostRecentRace ? {
      distanceKm: Math.round((mostRecentRace.distance / 1000) * 10) / 10,
      timeSec: Math.round(mostRecentRace.moving_time),
    } : null,
    suggestedDaysOfWeek,
  };
}

module.exports = { exchangeCodeForToken, refreshAccessToken, fetchRecentRuns, summarizeRuns };
