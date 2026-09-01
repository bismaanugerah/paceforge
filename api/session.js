/**
 * PaceForge — api/session.js
 * Tells the client whether the current browser has a valid PaceForge
 * session cookie (set by api/strava-callback.js) and, if so, who — the
 * client-side equivalent of the old `supabase.auth.getSession()` call.
 */
const { getSession } = require('../server/session');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const session = getSession(req);
  if (!session) {
    res.status(200).json({ loggedIn: false });
    return;
  }

  res.status(200).json({
    loggedIn: true,
    athlete: {
      id: session.athleteId,
      firstname: session.firstname,
      lastname: session.lastname,
      profilePicture: session.profilePicture,
    },
  });
};
