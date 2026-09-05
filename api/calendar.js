/**
 * PaceForge — api/calendar.js
 *
 * Serves one athlete's saved plan as a subscribable iCalendar feed:
 *
 *   webcal://<host>/api/calendar?token=<calendar token>
 *
 * The difference from the "Simpan ke Kalender" download button in
 * js/app.js is that this one keeps up: a calendar app re-fetches the URL
 * on its own schedule, so a day-swap, a shortened session, or a whole new
 * block generated later shows up in the runner's calendar without them
 * exporting anything again.
 *
 * Authenticated by the token in the query string, NOT by the session
 * cookie — Google/Apple fetch this from their own servers with no cookies
 * involved. See server/session.js's buildCalendarToken for what that
 * token can and can't do.
 */
const { readCalendarToken } = require('../server/session');
const { selectOne } = require('../server/supabaseAdmin');
const { buildPlanFromSettings, buildIcs } = require('../server/planEngine');

module.exports = async (req, res) => {
  // Deliberately text/plain on every error path: the caller is a calendar
  // client, not a browser, and handing it a JSON body under a
  // text/calendar content type would leave some clients showing a parse
  // error instead of the reason.
  const fail = (status, message) => {
    res.status(status).setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.send(message);
  };

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    fail(405, 'Method not allowed');
    return;
  }

  const token = typeof req.query?.token === 'string' ? req.query.token : null;
  const athleteId = readCalendarToken(token);
  if (!athleteId) {
    fail(401, 'Link kalender ini tidak valid atau sudah kedaluwarsa. Buka PaceForge dan ambil link kalender yang baru.');
    return;
  }

  try {
    const row = await selectOne('plans', 'athlete_id', athleteId);
    if (!row || !row.settings) {
      fail(404, 'Belum ada training plan tersimpan untuk akun ini.');
      return;
    }

    const plan = buildPlanFromSettings(row.settings);
    const ics = buildIcs(plan, {
      calendarName: `PaceForge — ${plan.meta.raceLabel}`,
      uidNamespace: String(athleteId),
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
    // inline, not attachment: a subscribed client reads this in place. A
    // browser opening the same URL out of curiosity gets a filename to
    // save it under rather than a wall of text.
    res.setHeader('Content-Disposition', 'inline; filename="paceforge.ics"');
    // The plan only changes when the runner edits it, but a calendar
    // client polls on its own (often hourly) — an hour of caching cuts
    // most of that load without the runner ever noticing a stale feed,
    // since the edits they make in the browser are already visible there
    // immediately.
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.send(ics);
  } catch (err) {
    console.error('[PaceForge] Gagal membangun feed kalender:', err);
    fail(502, `Gagal membangun feed kalender: ${err.message}`);
  }
};
