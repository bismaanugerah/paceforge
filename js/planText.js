/**
 * PaceForge — plan display text (js/planText.js)
 *
 * Pure text/labelling helpers turning one `day` object from
 * PaceForgeGenerator.generatePlan() into the words a human reads: the
 * session-type badge ("Interval", "Long Run"), its pace-zone name, and the
 * warm up -> reps -> cool down breakdown caption.
 *
 * Lives in its own file (rather than inside js/app.js, where all of this
 * started) because there are now THREE renderers that must describe a
 * session identically: the day table + "today" card on screen, the PDF
 * export, and the calendar feed (js/ics.js, which runs server-side in
 * api/calendar.js, where no DOM exists at all). Everything here is a
 * plain function of its arguments, no DOM and no module state, so the
 * Node-side calendar feed can load this exact file rather than
 * reimplementing "what is this session called" a second time and letting
 * the two drift.
 *
 * Colors are deliberately NOT here — those stay in js/app.js, which is
 * also the only place that knows whether it needs a CSS variable or a
 * jsPDF hex triple. structureToSegments returns each segment's semantic
 * `role` instead, and each renderer resolves that to its own color format.
 */

const PaceForgePlanText = (() => {

  // A rest day defaults to nudging toward strength/gym work as a
  // productive use of the slot — but only on a weekday. Weekend rest is
  // usually genuine recovery (from the week's harder weekday running, and
  // often sits right next to the long run), not another slot to fill, so
  // it's shown as plain "Rest" instead. This is purely a display choice —
  // day.type is always 'rest' either way, so nothing that touches the data
  // (applyFeedbackAdjustment, markCompletedSessionsFromStrava's completion
  // matching, saved-plan persistence, ...) needs to know about it — only
  // the label/color lookups below (renderDayRow, PDF export) key off this
  // instead of day.type directly.
  const WEEKEND_DOWS = new Set([0, 6]);
  function restDisplayKey(day) {
    if (day.type !== 'rest') return day.type;
    return WEEKEND_DOWS.has(day.dow) ? 'rest' : 'restStrength';
  }

  // Which VDOT pace zone a given session TYPE trains at — the reverse of
  // js/app.js's ZONE_TYPE_COLOR_KEY, which maps the same zones back onto
  // the session-type colors.
  // Drives the workout-structure bar's colors (a session's "hard" segments
  // are colored by its own zone, its warm up/recovery/cool down segments by
  // the Easy zone — see js/app.js's roleColorCss/structureToSegments) and the
  // Pace Target column (names the zone instead of a specific week's pace
  // number, which ramps week to week and is less useful to internalize
  // than "this is an Interval day"). A marathon-specific long run (MSL)
  // overrides 'longRun' -> 'marathon' per-day — see zoneForDay.
  const TYPE_TO_ZONE = {
    recovery: 'easy',
    easy: 'easy',
    shakeout: 'easy',
    longRun: 'easy',
    tempo: 'threshold',
    interval: 'interval',
    repetition: 'repetition',
    // See planGenerator.js's weekPaces.fartlek comment — work segments
    // reference Interval zone as a loose ceiling/reference, not a strict
    // target.
    fartlek: 'interval',
    marathonPace: 'marathon',
    // Only actually used for the conservativeMode variant of 'evaluation'
    // (a real self-test paced at weekPaces.tempo — see planGenerator.js's
    // 'race'-day-type branch): a normal, non-conservative Time Trial has
    // no prescribed pace, so the Pace Target column shows "Time Trial"
    // instead, keyed off day.paceSecPerKm being unset rather than this
    // zone mapping (see renderDayRow/the PDF export).
    evaluation: 'threshold',
    // First-timer only — just feeds roleColorCss' 'work' segment color
    // (Easy green) for the structure bar; the Pace Target column itself
    // never reaches this mapping for runWalk (see paceTargetLabel, which
    // special-cases it to "Run/Walk" before falling through here).
    runWalk: 'easy',
  };

  // Short zone labels for the Pace Target column / bar tooltips — matches
  // PaceForgeVDOT.ZONE_LABELS except calling the threshold zone "Tempo"
  // here, since that's the name the day-table's own session-type badges
  // (TYPE_LABELS in planGenerator.js) use for it.
  const ZONE_SHORT_LABEL = { easy: 'Easy', marathon: 'Marathon', threshold: 'Tempo', interval: 'Interval', repetition: 'Repetition' };

  function zoneForDay(day) {
    if (day.type === 'longRun' && day.isMarathonSpecific) return 'marathon';
    return TYPE_TO_ZONE[day.type] || null;
  }

  // The session-type badge's text for a day — shared by the day table
  // (renderDayRow) and the "today" hero card (renderTodayCard) so those
  // two can never end up naming the same session differently. See
  // paceTargetLabel just below for why First-timer's evaluation day gets
  // a gentler "5K" label than the other modes' "Time Trial".
  function dayTypeLabel(day, isFirstTimerPlan) {
    const { TYPE_LABELS } = PaceForgeGenerator;
    if (day.type === 'longRun' && day.isMarathonSpecific) {
      return `${TYPE_LABELS.longRun} (Pace ${day.structure?.paceLabel || 'Marathon'})`;
    }
    if (day.type === 'evaluation' && isFirstTimerPlan) return '5K';
    const displayKey = restDisplayKey(day);
    return TYPE_LABELS[displayKey] || displayKey;
  }

  // Pace Target column text — shared by the on-screen day row and the PDF
  // export so the two never drift. day.type === 'race' always gets "Race
  // Pace" (day.paceSecPerKm is real goal race pace there). 'evaluation' is
  // split on whether paceSecPerKm is actually set: conservativeMode's
  // variant is a real self-test at weekPaces.tempo (falls through to its
  // zone label, "Tempo"), while a normal Time Trial has no prescribed pace
  // at all (see planGenerator.js's 'race'-day-type branch) — it wouldn't
  // make sense to hit a target on a day whose whole point is discovering
  // your own current pace by racing it.
  // 'Time Trial' reads as too daunting for a total-beginner First-timer
  // plan (user feedback) — same day.type ('evaluation') as Base Building/
  // Maintenance's own evaluation week, just a gentler label for this one
  // mode specifically (those two keep "Time Trial"). isFirstTimerPlan is
  // passed in rather than read from module state here so this stays a
  // plain function of its arguments, like the rest of this file's label
  // helpers.
  function paceTargetLabel(day, zone, isFirstTimerPlan) {
    if (day.type === 'race') return 'Race Pace';
    if (day.type === 'evaluation' && day.paceSecPerKm == null) return isFirstTimerPlan ? '5K' : 'Time Trial';
    // No prescribed pace at all for a run/walk session — the target is the
    // time interval (see structureToSegments), not a pace, so this doesn't
    // fall through to a zone label (which would misleadingly show "Easy").
    if (day.type === 'runWalk') return 'Run/Walk';
    return zone ? ZONE_SHORT_LABEL[zone] : '—';
  }

  function formatKm(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`;
  }

  // Turns a day.structure object into plain { segments, caption } data —
  // shared by the HTML bar (js/app.js's renderWorkoutStructure), the PDF
  // bar (its drawStructureBar) and the calendar export's event description
  // (js/ics.js), so all three never drift apart. Each segment carries a
  // `role` ('work' | 'easy' | 'recovery') rather than a literal color,
  // since those renderers need different color formats (CSS var vs. hex
  // for jsPDF vs. none at all for plain-text calendar events) — each
  // resolves role -> color itself via js/app.js's roleColorCss/
  // roleColorHex, using the day's own zone (see zoneForDay) for 'work'.
  // Recovery segments show their DURATION (recoverySec), not distance —
  // real interval recoveries are jogged/walked for a set time, not a set
  // distance (see buildRepsStructure in planGenerator.js for how
  // recoverySec still gets a km equivalent purely for the bar's width).
  function formatRecoveryDuration(sec) {
    return `${Math.round(sec)} detik`;
  }

  // Run/walk-only (First-timer mode) — unlike formatRecoveryDuration above
  // (never past ~2 minutes for every other session type's recovery jog),
  // a run/walk segment can run up to 25 minutes by the program's final
  // week, where "1500 detik" reads far worse than "25 menit". Kept
  // separate from formatRecoveryDuration itself rather than changing that
  // one's behavior, to avoid altering already-shipped interval/repetition/
  // fartlek/tempo captions no one asked to change.
  function formatMinSec(sec) {
    const m = Math.floor(sec / 60);
    const s = Math.round(sec % 60);
    if (m === 0) return `${s} detik`;
    if (s === 0) return `${m} menit`;
    return `${m} menit ${s} detik`;
  }

  function structureToSegments(structure) {
    let segments;
    let caption = '';
    if (structure.kind === 'interval') {
      const recoveryLabel = formatRecoveryDuration(structure.recoverySec);
      segments = [{ label: 'Warm Up', km: structure.warmupKm, role: 'easy' }];
      for (let i = 0; i < structure.reps; i++) {
        segments.push({ label: `Set ${i + 1}`, km: structure.workKm, role: 'work' });
        segments.push({ label: 'Recovery', km: structure.recoveryKm, role: 'recovery', durationLabel: recoveryLabel });
      }
      segments.push({ label: 'Cool Down', km: structure.cooldownKm, role: 'easy' });
      caption = `Warm up ${formatKm(structure.warmupKm)} → ${structure.reps}× (${formatKm(structure.workKm)} hard + ${recoveryLabel} recovery) → Cool down ${formatKm(structure.cooldownKm)}`;
    } else if (structure.kind === 'tempo') {
      segments = [
        { label: 'Warm Up', km: structure.warmupKm, role: 'easy' },
        { label: 'Tempo', km: structure.tempoKm, role: 'work' },
        { label: 'Cool Down', km: structure.cooldownKm, role: 'easy' },
      ];
      caption = `Warm up ${formatKm(structure.warmupKm)} → Tempo ${formatKm(structure.tempoKm)} → Cool down ${formatKm(structure.cooldownKm)}`;
    } else if (structure.kind === 'racePace') {
      // Race-specific long run (MSL / its half-marathon equivalent) — easy
      // buildup FIRST, race pace to FINISH, see
      // buildRaceSpecificLongRunStructure in planGenerator.js for why that
      // order specifically.
      segments = [
        { label: 'Easy', km: structure.easyKm, role: 'easy' },
        { label: `Pace ${structure.paceLabel}`, km: structure.paceKm, role: 'work' },
      ];
      caption = `${formatKm(structure.easyKm)} easy → ${formatKm(structure.paceKm)} pace ${structure.paceLabel}`;
    } else if (structure.kind === 'runWalk') {
      // First-timer mode only (see generateFirstTimerPlan in
      // planGenerator.js). Segments alternate run/walk by TIME, like
      // interval's recovery segments already do (durationLabel), but here
      // 'work' is easy-effort running (not a hard rep) and 'recovery' is a
      // genuine walk, not a jog — see roleColorCss, which already colors
      // 'work' by the day's own zone (Easy, for runWalk — see
      // TYPE_TO_ZONE.runWalk) and 'recovery' its own fixed gray, so this
      // reuses both roles as-is without needing a third one. walkKm/walkSec
      // of 0 (the program's final week — see FIRST_TIMER_PROGRAM) omits
      // the walk segment entirely rather than rendering a zero-width one.
      const runLabel = formatMinSec(structure.runSec);
      segments = [];
      for (let i = 0; i < structure.reps; i++) {
        segments.push({ label: 'Lari', km: structure.runKm, role: 'work', durationLabel: runLabel });
        if (structure.walkSec > 0) {
          segments.push({ label: 'Jalan', km: structure.walkKm, role: 'recovery', durationLabel: formatMinSec(structure.walkSec) });
        }
      }
      caption = structure.walkSec > 0
        ? `${structure.reps}× (lari ${runLabel} + jalan ${formatMinSec(structure.walkSec)})`
        : `Lari ${runLabel} tanpa henti`;
    } else {
      // 'simple' — a single continuous block, no warm up/cool down split.
      segments = [{ label: 'Run', km: structure.km, role: 'work' }];
    }
    return { segments, caption };
  }

  return {
    restDisplayKey, zoneForDay, dayTypeLabel, paceTargetLabel,
    structureToSegments, formatKm, formatRecoveryDuration, formatMinSec,
    TYPE_TO_ZONE, ZONE_SHORT_LABEL,
  };
})();
