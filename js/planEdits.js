/**
 * PaceForge — runner-approved plan edits (js/planEdits.js)
 *
 * A saved plan is stored as its SETTINGS, not as the generated schedule
 * (see js/app.js's savePlanForCurrentUser) — so every time a plan is
 * reopened it's re-run through PaceForgeGenerator.generatePlan() from
 * scratch. Two kinds of edit the runner made by hand survive that only by
 * being replayed against the fresh plan afterwards:
 *
 *   daySwaps          — a session manually moved to a different day.
 *   feedbackOverrides — a session skipped/shortened because the runner
 *                       wasn't feeling well that week.
 *
 * This file is the replay, kept free of DOM and module state so both
 * callers can share it: js/app.js (which re-renders the affected weeks
 * afterwards) and api/calendar.js (which has no DOM at all and just needs
 * the corrected plan to write calendar events from). Without this split,
 * a subscribed calendar would happily show the session the runner had
 * already moved off that day.
 *
 * Every function mutates the plan/day in place and returns which week
 * numbers it touched, so a caller that renders can re-render just those.
 */

const PaceForgePlanEdits = (() => {

  // Every field a day's session actually carries, as opposed to date/
  // dayName/dow (which belong to the calendar day itself, not whatever
  // session is scheduled on it, and must stay put when swapping). Shared
  // by swapPlanDaySessions below and nothing else — kept as a flat list
  // so it's obvious at a glance exactly what does and doesn't move.
  const SESSION_FIELDS = ['type', 'km', 'paceSecPerKm', 'structure', 'isMarathonSpecific', 'workoutVariant', 'recoveryPaceSecPerKm'];

  // Swaps everything about what's scheduled on two days (type, distance,
  // pace, workout structure, ...) while leaving each day's own date fixed
  // — used by handleSwapDayClick below (a user manually moving a session
  // to a different day) and applySavedDaySwaps (replaying that same move
  // after the plan's been regenerated from settings on a later load).
  // Explicitly deletes each field before reassigning rather than relying
  // on Object.assign alone, since Object.assign only overwrites keys that
  // exist on the source — a field the destination day doesn't have (e.g.
  // an easy day has no `structure`) would otherwise survive the swap as a
  // stale leftover from whatever this day used to be.
  function swapPlanDaySessions(dayA, dayB) {
    const sessionA = {};
    const sessionB = {};
    SESSION_FIELDS.forEach(field => {
      if (field in dayA) sessionA[field] = dayA[field];
      if (field in dayB) sessionB[field] = dayB[field];
    });
    SESSION_FIELDS.forEach(field => { delete dayA[field]; delete dayB[field]; });
    Object.assign(dayA, sessionB);
    Object.assign(dayB, sessionA);
  }


  // Applies one "I'm sick/tired" adjustment to a day in place — either
  // 'skip' (rest it entirely) or 'reduce' (shrink it to a smaller
  // distance, rebuilding its workout-structure bar at the new size with
  // the same type-specific builder the generator itself would use, so an
  // interval/tempo/repetition session still shows a correctly-sized
  // warm-up/work/cooldown breakdown rather than a stale one sized for the
  // original distance). Long run uses buildSimpleStructure rather than
  // its usual race-specific builder — this is a one-off runner-approved
  // exception to the plan, not a re-run of the generator's own long-run
  // logic, so losing the race-pace-segment detail here is an acceptable
  // simplification.
  function applyFeedbackAdjustment(day, action, suggestedKm, { fitnessLevel = null, conservativeMode = false } = {}) {
    const km = action === 'skip' ? 0 : Math.max(0, Math.round(suggestedKm * 2) / 2);
    const SESSION_FIELDS_TO_CLEAR = ['structure', 'isMarathonSpecific', 'workoutVariant', 'recoveryPaceSecPerKm'];
    if (action === 'skip' || km <= 0) {
      SESSION_FIELDS_TO_CLEAR.forEach(field => delete day[field]);
      day.type = 'rest';
      day.km = 0;
      return;
    }
    day.km = km;
    const { buildSimpleStructure, buildIntervalStructure, buildTempoStructure, buildRepetitionStructure, buildFartlekStructure } = PaceForgeGenerator;
    if (day.type === 'interval') {
      // day.paceSecPerKm is this day's own I-pace (untouched by the km
      // reduction above) — buildIntervalStructure may re-resolve
      // day.workoutVariant against it if the requested variant no longer
      // fits under its duration cap (see planGenerator.js).
      const built = buildIntervalStructure(km, fitnessLevel, conservativeMode, day.workoutVariant, day.paceSecPerKm, day.recoveryPaceSecPerKm);
      day.workoutVariant = built.resolvedVariant;
      day.structure = built.structure;
    } else if (day.type === 'tempo') {
      day.structure = buildTempoStructure(km, day.workoutVariant, day.recoveryPaceSecPerKm);
    } else if (day.type === 'repetition') {
      const built = buildRepetitionStructure(km, day.workoutVariant, day.paceSecPerKm, day.recoveryPaceSecPerKm);
      day.workoutVariant = built.resolvedVariant;
      day.structure = built.structure;
    } else if (day.type === 'fartlek') {
      // day.recoveryPaceSecPerKm is already weekPaces.easy for a fartlek
      // day (not weekPaces.recovery like interval/repetition) — see
      // planGenerator.js's buildFartlekStructure comment for why.
      day.structure = buildFartlekStructure(km, day.paceSecPerKm, day.recoveryPaceSecPerKm);
    } else {
      day.structure = buildSimpleStructure(km);
    }
  }

  // Replays a saved daySwaps list against a freshly generated plan.
  // Returns the week numbers actually changed.
  function applyDaySwaps(plan, savedSwaps) {
    const touchedWeeks = new Set();
    if (!plan || !Array.isArray(savedSwaps)) return [];
    savedSwaps.forEach(swap => {
      const week = plan.weeks.find(w => w.weekNumber === swap.week);
      if (!week) return;
      const dayA = week.days.find(d => d.dow === swap.dowA);
      const dayB = week.days.find(d => d.dow === swap.dowB);
      if (!dayA || !dayB) return;
      swapPlanDaySessions(dayA, dayB);
      touchedWeeks.add(swap.week);
    });
    return [...touchedWeeks];
  }

  // Replays a saved feedbackOverrides list against a freshly generated
  // plan. `opts` carries the two generator inputs applyFeedbackAdjustment
  // needs to rebuild an interval session's structure at its reduced size
  // (see there) — the caller holds those, this file deliberately holds no
  // state of its own. Returns the week numbers actually changed.
  function applyFeedbackOverrides(plan, savedOverrides, opts = {}) {
    const touchedWeeks = new Set();
    if (!plan || !Array.isArray(savedOverrides)) return [];
    savedOverrides.forEach(entry => {
      const week = plan.weeks.find(w => w.weekNumber === entry.week);
      const day = week?.days.find(d => d.dow === entry.dow);
      if (!day) return;
      // structure isn't saved (large, and cheaply rebuildable) — just
      // reconstruct it the same way applyFeedbackAdjustment does rather
      // than duplicating that logic here. Also relies on it (rather than
      // setting day.type/day.km directly) to clear stale fields left over
      // from whatever this day was regenerated as — a 'rest' override
      // still needs its old structure/workoutVariant/etc wiped, same as
      // a fresh 'skip' does.
      applyFeedbackAdjustment(day, entry.type === 'rest' ? 'skip' : 'reduce', entry.km, opts);
      touchedWeeks.add(entry.week);
    });
    return [...touchedWeeks];
  }

  return { swapPlanDaySessions, applyFeedbackAdjustment, applyDaySwaps, applyFeedbackOverrides, SESSION_FIELDS };
})();
