/**
 * PaceForge — api/logout.js
 * Clears the PaceForge session cookie. Doesn't revoke the Strava token
 * itself (the user can do that from Strava's own "My Apps" settings) — this
 * just ends the local session, same scope as the old Supabase signOut().
 */
const { buildLogoutCookie } = require('../server/session');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.setHeader('Set-Cookie', buildLogoutCookie(req));
  res.status(200).json({ ok: true });
};
