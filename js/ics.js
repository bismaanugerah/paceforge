/**
 * PaceForge — calendar export (js/ics.js)
 *
 * Turns a plan object from PaceForgeGenerator.generatePlan() into an
 * iCalendar (RFC 5545) document: one event per training session, so the
 * plan lands in whatever calendar the runner already looks at every
 * morning instead of only living in this tab.
 *
 * Pure string building — no DOM, no network. Despite living under js/,
 * this one runs SERVER-side only: api/calendar.js serves its output as a
 * subscribable webcal:// feed, loading this file through
 * server/planEngine.js. index.html deliberately doesn't script-tag it.
 * (It sits here rather than under server/ because it's written against
 * the browser engine's plan objects and leans on js/planText.js, and
 * because a one-off in-browser .ics download is exactly the kind of thing
 * that could come back — an earlier version of this feature had one, and
 * it was dropped in favour of the always-current feed.)
 *
 * Session wording comes from js/planText.js — the same helpers the day
 * table and PDF export use, so a session can't be called one thing on
 * screen and another in the calendar.
 *
 * ALL-DAY EVENTS, deliberately: PaceForge never asks what time of day the
 * runner trains, so any specific hour here would be invented. An all-day
 * event also renders as a banner at the top of the day in both Google and
 * Apple Calendar, which reads as "here's today's session" rather than
 * competing with real, time-bound appointments.
 */

const PaceForgeIcs = (() => {

  const PRODID = '-//PaceForge//Training Plan//ID';

  // Rest days are left out entirely. They'd be over half the events in a
  // 3-4 day/week plan, and a rest day's whole point is that nothing is
  // scheduled — a calendar the runner has to scroll past four "Rest"
  // banners to find Thursday's interval session is worse at its one job.
  // The plan's own rest days remain visible in the app and the PDF.
  function isSessionDay(day) {
    return day.type !== 'rest' && (day.km > 0 || day.type === 'race' || day.type === 'evaluation');
  }

  // RFC 5545 §3.3.11: backslash, semicolon and comma are escaped, and a
  // literal newline becomes '\n'. Carriage returns are dropped rather
  // than escaped (they'd otherwise survive as a stray '\r' in the text).
  function escapeText(str) {
    return String(str)
      .replace(/\\/g, '\\\\')
      .replace(/;/g, '\\;')
      .replace(/,/g, '\\,')
      .replace(/\r/g, '')
      .replace(/\n/g, '\\n');
  }

  // RFC 5545 §3.1: content lines are folded at 75 OCTETS, not characters —
  // this plan text is full of multi-byte characters (—, →, ×, emoji), so
  // folding by string length would produce lines that are legal-looking
  // but too long, and worse, could split a multi-byte character in half.
  // Measures each character's UTF-8 size and never breaks within one.
  function foldLine(line) {
    const MAX_OCTETS = 75;
    const out = [];
    let current = '';
    let octets = 0;
    for (const char of line) {
      const size = utf8Size(char);
      // Continuation lines start with a space, which itself costs an
      // octet — budget for it so folded lines stay within the limit too.
      const limit = out.length === 0 ? MAX_OCTETS : MAX_OCTETS - 1;
      if (octets + size > limit) {
        out.push(current);
        current = '';
        octets = 0;
      }
      current += char;
      octets += size;
    }
    out.push(current);
    return out.join('\r\n ');
  }

  function utf8Size(char) {
    const code = char.codePointAt(0);
    if (code < 0x80) return 1;
    if (code < 0x800) return 2;
    if (code < 0x10000) return 3;
    return 4;
  }

  // 'YYYYMMDD' from the date's LOCAL calendar fields — never
  // toISOString(), which reads UTC fields and lands a full day early for
  // any timezone ahead of UTC (WIB/UTC+7 included). js/app.js hit exactly
  // this bug on its own saved-plan dates; see its dateKey comment.
  function dateStamp(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
  }

  function addDays(date, days) {
    const d = new Date(date.getTime());
    d.setDate(d.getDate() + days);
    return d;
  }

  // DTSTAMP must be a UTC timestamp (RFC 5545 §3.3.5), unlike the all-day
  // DTSTART/DTEND above which are floating local dates.
  function utcStamp(date) {
    return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }

  function formatPace(secPerKm) {
    const m = Math.floor(secPerKm / 60);
    const s = Math.round(secPerKm % 60);
    return `${m}:${String(s).padStart(2, '0')} /km`;
  }

  // "🏃 Interval — 8 km". The emoji earns its place here in a way it
  // wouldn't on screen: in a month view a calendar shows very little of
  // each event, and the leading glyph makes a training day identifiable
  // at a glance before any text is legible.
  // 'race' maps to no emoji on purpose: TYPE_LABELS.race is already
  // "RACE DAY! 🏁" and carries its own flag, so prefixing another one
  // reads as a stutter. 'evaluation' ("Time Trial") has none of its own
  // and does get one. Everything else falls back to a plain runner.
  const TYPE_EMOJI = {
    race: '',
    evaluation: '🏁',
    longRun: '🏃',
    interval: '⚡',
    repetition: '⚡',
    tempo: '⚡',
    fartlek: '⚡',
  };

  function eventSummary(day, isFirstTimerPlan) {
    const label = PaceForgePlanText.dayTypeLabel(day, isFirstTimerPlan);
    // ?? not ||, so 'race's deliberate empty string isn't treated as
    // "missing" and replaced by the runner fallback.
    const emoji = TYPE_EMOJI[day.type] ?? '🏃';
    const distance = day.km > 0 ? ` — ${day.km} km` : '';
    return `${emoji ? `${emoji} ` : ''}${label}${distance}`;
  }

  function eventDescription(day, week, plan) {
    const isFirstTimerPlan = plan.meta.mode === 'firstTimer';
    const zone = PaceForgePlanText.zoneForDay(day);
    const lines = [];

    lines.push(`Minggu ${week.weekNumber} dari ${plan.meta.planWeeks} — ${plan.meta.raceLabel}`);

    const paceTarget = PaceForgePlanText.paceTargetLabel(day, zone, isFirstTimerPlan);
    // day.paceSecPerKm is unset for a plain Time Trial (its whole point is
    // discovering your own pace) and for run/walk sessions, where the
    // target is a time interval — see paceTargetLabel's own comment. Both
    // still get the zone/label line, just without a number after it.
    lines.push(day.paceSecPerKm
      ? `Target: ${paceTarget} · ${formatPace(day.paceSecPerKm)}`
      : `Target: ${paceTarget}`);

    // A 'simple' structure (one continuous run) returns an empty caption —
    // there's nothing to break down that the summary's distance doesn't
    // already say.
    const caption = day.structure ? PaceForgePlanText.structureToSegments(day.structure).caption : '';
    if (caption) lines.push('', caption);

    lines.push('');
    lines.push('Dibuat oleh PaceForge — bukan pengganti saran pelatih lari atau tenaga medis.');
    return lines.join('\n');
  }

  /**
   * buildIcs(plan, options) -> iCalendar string.
   *
   * options.calendarName  Shown as the calendar's name once subscribed.
   * options.uidNamespace  Makes each event's UID stable and unique to one
   *                       runner, so a re-downloaded/re-fetched feed
   *                       UPDATES the existing events rather than
   *                       duplicating them. Callers pass the athlete id
   *                       where they have one (api/calendar.js) and a
   *                       stable local fallback where they don't.
   * options.now           Injectable clock, for DTSTAMP.
   */
  function buildIcs(plan, options = {}) {
    const {
      calendarName = `PaceForge — ${plan.meta.raceLabel}`,
      uidNamespace = 'local',
      now = new Date(),
    } = options;

    const isFirstTimerPlan = plan.meta.mode === 'firstTimer';
    const dtstamp = utcStamp(now);
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      `PRODID:${PRODID}`,
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      `X-WR-CALNAME:${escapeText(calendarName)}`,
      // Non-standard but very widely honored: tells a subscribed client
      // how often to re-poll the feed. Daily is plenty — a plan changes
      // when the runner edits it, not continuously.
      'X-PUBLISHED-TTL:PT24H',
      'REFRESH-INTERVAL;VALUE=DURATION:PT24H',
    ];

    plan.weeks.forEach(week => {
      week.days.forEach(day => {
        if (!isSessionDay(day)) return;
        const start = dateStamp(day.date);
        lines.push('BEGIN:VEVENT');
        // Stable per runner + per calendar date: the same session moved to
        // a different day (a swap) is the same date's event changing
        // content, which is exactly what a calendar client should show.
        lines.push(`UID:paceforge-${uidNamespace}-${start}@paceforge.app`);
        lines.push(`DTSTAMP:${dtstamp}`);
        // DTEND is EXCLUSIVE for all-day events (RFC 5545 §3.6.1) — a
        // one-day event ends on the NEXT day, or Google/Apple render it
        // as a zero-length event that some clients hide entirely.
        lines.push(`DTSTART;VALUE=DATE:${start}`);
        lines.push(`DTEND;VALUE=DATE:${dateStamp(addDays(day.date, 1))}`);
        lines.push(`SUMMARY:${escapeText(eventSummary(day, isFirstTimerPlan))}`);
        lines.push(`DESCRIPTION:${escapeText(eventDescription(day, week, plan))}`);
        lines.push('TRANSP:TRANSPARENT');
        lines.push('END:VEVENT');
      });
    });

    lines.push('END:VCALENDAR');

    // RFC 5545 requires CRLF line endings; fold only after assembling each
    // logical line, since folding inserts CRLF of its own.
    return lines.map(foldLine).join('\r\n') + '\r\n';
  }

  // isSessionDay is exported alongside buildIcs so a caller can count or
  // preview exactly which days will become events, without reproducing
  // the rest-day rule above.
  return { buildIcs, isSessionDay };
})();
