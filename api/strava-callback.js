/**
 * PaceForge — api/strava-callback.js
 * Step 2 of the Strava login flow. Strava redirects the browser back here
 * with `code` (+ the `state` we handed it in api/strava-login.js). Exchanges
 * the code for tokens, upserts the athlete row, mints our own session
 * cookie, then redirects back to `/` — the browser never sees a Strava
 * token directly.
 */
const { exchangeCodeForToken } = require('../server/strava');
const { upsert } = require('../server/supabaseAdmin');
const { buildSessionCookie, readStateCookie, clearStateCookie } = require('../server/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const origin = `${proto}://${req.headers.host}`;
  const { searchParams } = new URL(req.url, origin);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const deniedError = searchParams.get('error');

  function redirectWithError(message, extraHeaders) {
    res.writeHead(302, {
      Location: `${origin}/?strava_error=${encodeURIComponent(message)}`,
      'Set-Cookie': clearStateCookie(req),
      ...extraHeaders,
    });
    res.end();
  }

  if (deniedError) {
    // User klik "Cancel"/tolak akses di halaman consent Strava.
    redirectWithError(deniedError);
    return;
  }

  const expectedState = readStateCookie(req);
  if (!code || !state || !expectedState || state !== expectedState) {
    redirectWithError('invalid_state');
    return;
  }

  try {
    const tokenData = await exchangeCodeForToken(code);
    const athlete = tokenData.athlete || {};
    if (!athlete.id) throw new Error('Strava tidak mengembalikan data athlete.');

    await upsert('strava_athletes', {
      athlete_id: athlete.id,
      access_token: tokenData.access_token,
      refresh_token: tokenData.refresh_token,
      expires_at: tokenData.expires_at,
      firstname: athlete.firstname || null,
      lastname: athlete.lastname || null,
      profile_picture: athlete.profile || null,
      updated_at: new Date().toISOString(),
    }, 'athlete_id');

    const sessionCookie = buildSessionCookie(req, {
      athleteId: athlete.id,
      firstname: athlete.firstname,
      lastname: athlete.lastname,
      profilePicture: athlete.profile,
    });

    res.writeHead(302, {
      Location: `${origin}/`,
      'Set-Cookie': [sessionCookie, clearStateCookie(req)],
    });
    res.end();
  } catch (err) {
    redirectWithError(err.message);
  }
};
