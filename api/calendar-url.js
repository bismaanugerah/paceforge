/**
 * PaceForge — api/calendar-url.js
 * Hands the logged-in athlete their own calendar-feed URL (see
 * api/calendar.js). Session-cookie authenticated — minting the token has
 * to be gated on actually being logged in, even though using it later
 * isn't.
 *
 * A fresh token is minted on every call rather than stored. It costs one
 * HMAC, keeps a second secret out of the database, and means the answer
 * to "how do I stop sharing this link" is the same as it is for the
 * session secret — rotating SESSION_JWT_SECRET invalidates every issued
 * calendar link at once. (Per-link revocation would need a stored token
 * id to check against; not worth a table for the current single-plan
 * setup.)
 */
const { getSession, buildCalendarToken } = require('../server/session');

module.exports = async (req, res) => {
  const session = getSession(req);
  if (!session) {
    res.status(401).json({ error: 'Belum login.' });
    return;
  }

  const token = buildCalendarToken(session.athleteId);
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const httpUrl = `${proto}://${host}/api/calendar?token=${encodeURIComponent(token)}`;

  res.status(200).json({
    // webcal:// is what makes a click on this SUBSCRIBE (a live feed that
    // keeps updating) instead of downloading a one-off copy — Google
    // Calendar, Apple Calendar and Outlook all register the scheme. Same
    // URL either way, so the https form is returned alongside it for
    // pasting into anything that wants a plain URL.
    webcalUrl: httpUrl.replace(/^https?:\/\//, 'webcal://'),
    httpUrl,
  });
};
