/**
 * PaceForge — api/strava-login.js
 * Step 1 of the Strava login flow. Builds Strava's authorize URL server-side
 * (so the client never needs to know the exact scopes/redirect_uri) and
 * 302-redirects the browser there, after stashing a random `state` value in
 * a short-lived cookie so api/strava-callback.js can confirm the callback
 * really belongs to a login this server started (CSRF protection).
 */
const crypto = require('crypto');
const { buildStateCookie } = require('../server/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).send('Method not allowed');
    return;
  }

  const clientId = process.env.STRAVA_CLIENT_ID;
  if (!clientId) {
    res.status(500).send('STRAVA_CLIENT_ID belum diset di environment variable server.');
    return;
  }

  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  const origin = `${proto}://${req.headers.host}`;
  const state = crypto.randomBytes(16).toString('hex');

  const authorizeUrl = new URL('https://www.strava.com/oauth/authorize');
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', `${origin}/api/strava-callback`);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('approval_prompt', 'auto');
  // read: profil dasar. activity:read_all: termasuk aktivitas yang ditandai
  // private (bukan cuma yang public) — perlu supaya rata-rata km
  // mingguan/lari terjauh akurat buat athlete yang men-private-kan
  // aktivitasnya secara default.
  authorizeUrl.searchParams.set('scope', 'read,activity:read_all');
  authorizeUrl.searchParams.set('state', state);

  res.writeHead(302, {
    Location: authorizeUrl.toString(),
    'Set-Cookie': buildStateCookie(req, state),
  });
  res.end();
};
