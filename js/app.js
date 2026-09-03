/**
 * PaceForge — app.js
 * Wires up the form, validates input, calls PaceForgeGenerator, renders results.
 */
(() => {
  const RACE_META = {
    '5k': { km: 5, label: '5K' },
    '10k': { km: 10, label: '10K' },
    // Non-race-only value (see planGenerator.js's RACE_PROFILES.medium) —
    // km is a representative distance for pace-projection math only
    // (predictRaceTime/vdotFromGoalPace etc. still need *a* number), the
    // arithmetic midpoint between 10k's and half's own km below.
    medium: { km: 15.5, label: 'Medium Distance' },
    'half': { km: 21.1, label: 'Half Marathon' },
    'full': { km: 42.2, label: 'Full Marathon' },
  };

  const TYPE_COLORS = {
    recovery: 'var(--type-recovery)',
    easy: 'var(--type-easy)',
    longRun: 'var(--type-longrun)',
    tempo: 'var(--type-tempo)',
    interval: 'var(--type-interval)',
    repetition: 'var(--type-repetition)',
    shakeout: 'var(--type-easy)',
    rest: 'var(--type-rest)',
    // Not a real day.type (day.type is always 'rest') — see
    // restDisplayKey, the display-only key a weekday rest day is looked
    // up under instead of plain 'rest' so its badge gets its own color.
    restStrength: 'var(--type-rest-strength)',
    race: 'var(--type-race)',
    // Fartlek's work effort references Interval zone (see
    // TYPE_TO_ZONE/weekPaces.fartlek in planGenerator.js), so it reuses
    // that same color rather than a new one. Evaluation reuses the race
    // badge's indigo — same role as race day (the block's one checkpoint
    // date), just for a non-race plan.
    fartlek: 'var(--type-interval)',
    evaluation: 'var(--type-race)',
    // Marathon zone already reuses the longRun badge color everywhere else
    // (see ZONE_TYPE_COLOR_KEY below) — same here, for the same reason.
    marathonPace: 'var(--type-longrun)',
  };

  // Distinguishes a week's training phase at a glance in the accordion
  // header (see renderPlan) — reuses colors already meaning something else
  // elsewhere in the plan rather than inventing an unrelated palette:
  // Base/Peak/Taper borrow the Easy/Interval/Tempo session-type colors
  // (roughly matching that phase's dominant effort — Base is mostly easy
  // running, Peak leans hardest, Taper backs off like tempo work would),
  // Cutback its own muted recovery color, and Race Week the same indigo
  // already used for the race day badge itself.
  const PHASE_COLORS = {
    Base: 'var(--type-easy)',
    Build: 'var(--color-accent)',
    Peak: 'var(--type-interval)',
    Cutback: 'var(--type-recovery)',
    Taper: 'var(--type-tempo)',
    'Race Week': 'var(--type-race)',
    // Non-race phases (see generatePlan's isMaintenance/isNonRace
    // branches) — Maintenance has no Base/Build/Peak progression of its
    // own, and both sub-modes end in the same "Evaluasi" checkpoint week
    // race mode ends in "Race Week".
    Maintenance: 'var(--type-easy)',
    Evaluasi: 'var(--type-race)',
  };

  // Hex twins of the CSS custom properties above / the exertion colors in
  // styles.css — the PDF export draws with jsPDF's own vector primitives
  // (no DOM, so no access to CSS variables), so it needs the raw values.
  // Keep these in sync with :root in css/styles.css by hand.
  const TYPE_HEX = {
    recovery: '#b0a396',
    easy: '#74b358',
    longRun: '#3aa98c',
    tempo: '#d9a53a',
    interval: '#d97a4f',
    repetition: '#d9455a',
    shakeout: '#74b358',
    rest: '#8b93a3',
    restStrength: '#9d84c9',
    race: '#6366f1',
    fartlek: '#d97a4f',
    evaluation: '#6366f1',
    marathonPace: '#3aa98c',
  };

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

  // Maps each VDOT pace zone (js/vdot.js's ZONE_ORDER) onto the closest
  // matching session type, so the Zona Pace table's row dots — and, below,
  // the workout-structure bars and Pace Target column — all reuse the same
  // colors already meaning that intensity everywhere else in the plan
  // (session-type badges, PDF) instead of introducing a separate palette.
  const ZONE_TYPE_COLOR_KEY = {
    easy: 'easy',
    marathon: 'longRun',
    threshold: 'tempo',
    interval: 'interval',
    repetition: 'repetition',
  };

  // Reverse of the above: which VDOT zone a given session TYPE trains at.
  // Drives the workout-structure bar's colors (a session's "hard" segments
  // are colored by its own zone, its warm up/recovery/cool down segments by
  // the Easy zone — see zoneColorFor/structureToSegments below) and the
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

  // Pace Target column text — shared by the on-screen day row and the PDF
  // export so the two never drift. day.type === 'race' always gets "Race
  // Pace" (day.paceSecPerKm is real goal race pace there). 'evaluation' is
  // split on whether paceSecPerKm is actually set: conservativeMode's
  // variant is a real self-test at weekPaces.tempo (falls through to its
  // zone label, "Tempo"), while a normal Time Trial has no prescribed pace
  // at all (see planGenerator.js's 'race'-day-type branch) — it wouldn't
  // make sense to hit a target on a day whose whole point is discovering
  // your own current pace by racing it.
  function paceTargetLabel(day, zone) {
    if (day.type === 'race') return 'Race Pace';
    if (day.type === 'evaluation' && day.paceSecPerKm == null) return 'Time Trial';
    return zone ? ZONE_SHORT_LABEL[zone] : '—';
  }

  function zoneColorHex(zone) {
    return TYPE_HEX[ZONE_TYPE_COLOR_KEY[zone]] || TYPE_HEX.easy;
  }

  function zoneColorCss(zone) {
    return TYPE_COLORS[ZONE_TYPE_COLOR_KEY[zone]] || TYPE_COLORS.easy;
  }

  // Resolves a workout-structure segment's `role` (see structureToSegments)
  // to an actual color: 'work' segments (reps, tempo block) use the day's
  // own zone color; 'easy' segments (warm up/cool down — genuinely easy-
  // pace running) use the Easy zone's green; 'recovery' segments (the jog
  // between hard reps) get their own fixed gray — the same
  // --type-recovery color already used for "Recovery Run" days
  // elsewhere, since a recovery jog isn't really "Easy zone" pace so much
  // as its own thing, and reads more clearly as a visually distinct gray
  // than folded into the same green as warm up/cool down.
  function roleColorCss(role, zone) {
    if (role === 'work') return zoneColorCss(zone);
    if (role === 'recovery') return TYPE_COLORS.recovery;
    return zoneColorCss('easy');
  }

  function roleColorHex(role, zone) {
    if (role === 'work') return zoneColorHex(zone);
    if (role === 'recovery') return TYPE_HEX.recovery;
    return zoneColorHex('easy');
  }

  // "2 September 2026" style — day + full month name + year, no weekday
  // (PaceForgeGenerator.formatDate includes a weekday, which reads as
  // clutter repeated on every "Zona Pace (VDOT ...) per ..." line: the top
  // card's own generation date, and each week's date below).
  function formatLongDate(date) {
    return date.toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' });
  }

  // 'YYYY-MM-DD' using this Date's own LOCAL calendar fields (never
  // toISOString(), which is UTC and can land on the wrong day depending on
  // the browser's offset) — used to key/match a plan day against a Strava
  // activity's date (see markCompletedSessionsFromStrava), where both
  // sides need to agree on "the runner's local day", the same thing a
  // human means by "that day's run".
  function dateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // This week's own VDOT — computed by planGenerator.js (week.weekVdot,
  // ramped directly in VDOT-space from the runner's actual recent-race
  // performance toward their projected goal) so the figure climbs week to
  // week alongside the schedule instead of staying fixed at the plan's
  // single snapshot. NOT re-derived here from week.weekGoalPaceSec via
  // vdotFromGoalPace any more — that indirect route used to disagree with
  // the top-level Zona Pace card's own (direct, un-Riegel'd) VDOT, most
  // visibly right at week 1 — see planGenerator.js's currentVdot comment.
  function weekVdot(week) {
    return week.weekVdot;
  }

  // The week today actually falls inside, if any — null when the plan
  // hasn't started yet or is already over. Used both to pick which
  // accordion (see renderPlan) starts open and to show the "Minggu saat
  // ini" badge, which should only ever label a week that's genuinely
  // running right now, not whichever week the open-by-default fallback
  // below happens to land on.
  function findCurrentWeek(weeks) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return weeks.find(w => {
      const start = new Date(w.startDate); start.setHours(0, 0, 0, 0);
      const end = new Date(w.endDate); end.setHours(0, 0, 0, 0);
      return today >= start && today <= end;
    }) || null;
  }

  // Which week's accordion (see renderPlan) should start open. Prefers the
  // current week (see findCurrentWeek); if the plan hasn't started yet
  // (generated ahead of time), that's week 1 — the one about to begin, not
  // some arbitrary later week. If it's already over (an old saved plan
  // reopened after race day), it's the last one — so what's shown by
  // default is always "the week the runner would actually want to check
  // right now" rather than always defaulting to one end of the plan.
  function pickDefaultOpenWeek(weeks, currentWeek) {
    if (currentWeek) return currentWeek.weekNumber;
    if (!weeks.length) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const upcoming = weeks.find(w => new Date(w.startDate) > today);
    return (upcoming || weeks[weeks.length - 1]).weekNumber;
  }

  // Section "5. Target Waktu Finish" is hidden in index.html for now (the
  // pace-target ramp needs it paired with a current-fitness baseline that
  // isn't wired up yet — see the comment there). Gate reading it here on
  // the same flag so a stale hasTargetTime.checked/targetTimeSec left over
  // from a previously-saved plan (restoreFormFromSettings still populates
  // those hidden fields for when the feature comes back) can never sneak
  // an explicit target back into a freshly-generated plan while the field
  // to see/fix it is invisible. Flip this back to true together with
  // un-hiding that fieldset.
  const TARGET_TIME_FEATURE_ENABLED = false;

  const form = document.getElementById('planForm');
  const submitBtn = form.querySelector('button[type="submit"]');
  const goalTypeToggle = document.getElementById('goalTypeToggle');
  const goalTypeHint = document.getElementById('goalTypeHint');
  const raceFieldsetLegend = document.getElementById('raceFieldsetLegend');
  const raceDateLabel = document.getElementById('raceDateLabel');
  const distanceModeField = document.getElementById('distanceModeField');
  const distanceModeToggle = document.getElementById('distanceModeToggle');
  const presetDistanceField = document.getElementById('presetDistanceField');
  const raceDistanceSel = document.getElementById('raceDistance');
  const customDistanceField = document.getElementById('customDistanceField');
  const customDistanceKm = document.getElementById('customDistanceKm');
  const raceDateInput = document.getElementById('raceDate');
  const raceDateHint = document.getElementById('raceDateHint');
  const startDateInput = document.getElementById('startDate');
  const daysPerWeekInput = document.getElementById('daysPerWeek');
  const daysPerWeekOutput = document.getElementById('daysPerWeekOutput');
  const dayCheckboxes = document.getElementById('dayCheckboxes');
  const dayCountHint = document.getElementById('dayCountHint');
  const longRunDaySelect = document.getElementById('longRunDay');
  const recentRaceDistanceSel = document.getElementById('recentRaceDistance');
  const recentRaceCustomField = document.getElementById('recentRaceCustomField');
  const recentRaceCustomKm = document.getElementById('recentRaceCustomKm');
  const recentRaceHours = document.getElementById('recentRaceHours');
  const recentRaceMinutes = document.getElementById('recentRaceMinutes');
  const recentRaceSeconds = document.getElementById('recentRaceSeconds');
  const recentRaceHint = document.getElementById('recentRaceHint');
  const recentRaceSourceNote = document.getElementById('recentRaceSourceNote');
  const hasTargetTime = document.getElementById('hasTargetTime');
  const targetInputWrap = document.getElementById('targetInputWrap');
  const targetModeToggle = document.getElementById('targetModeToggle');
  const targetTimeFields = document.getElementById('targetTimeFields');
  const targetPaceFields = document.getElementById('targetPaceFields');
  const targetHoursInput = document.getElementById('targetHours');
  const targetMinutesInput = document.getElementById('targetMinutes');
  const targetSecondsInput = document.getElementById('targetSeconds');
  const targetPaceMinutesInput = document.getElementById('targetPaceMinutes');
  const targetPaceSecondsInput = document.getElementById('targetPaceSeconds');
  const targetPaceHint = document.getElementById('targetPaceHint');
  const conservativeModeInput = document.getElementById('conservativeMode');
  const userNotesInput = document.getElementById('userNotes');
  const formError = document.getElementById('formError');
  const currentWeeklyKmInput = document.getElementById('currentWeeklyKm');
  const longestRecentRunKmInput = document.getElementById('longestRecentRunKm');
  const stravaFillBadge = document.getElementById('stravaFillBadge');

  // Kalau user ngedit salah satu angka ini sendiri setelah auto-fill dari
  // Strava, badge-nya nggak relevan lagi — angkanya sekarang pilihan user,
  // bukan lagi murni dari Strava.
  [currentWeeklyKmInput, longestRecentRunKmInput].forEach(el => {
    el.addEventListener('input', () => { stravaFillBadge.hidden = true; });
  });

  const DAY_LABELS = { 0: 'Minggu', 1: 'Senin', 2: 'Selasa', 3: 'Rabu', 4: 'Kamis', 5: "Jum'at", 6: 'Sabtu' };

  const gateSection = document.getElementById('gateSection');
  const formSection = document.getElementById('formSection');
  const loadingSection = document.getElementById('loadingSection');
  const loadingTitle = document.getElementById('loadingTitle');
  const resultSection = document.getElementById('resultSection');
  const resultWarning = document.getElementById('resultWarning');
  const summaryCards = document.getElementById('summaryCards');
  const volumeChart = document.getElementById('volumeChart');
  const paceLegend = document.getElementById('paceLegend');
  const planWeeksEl = document.getElementById('planWeeks');
  const aiStatus = document.getElementById('aiStatus');
  const aiRetryBtn = document.getElementById('aiRetryBtn');
  const aiIntro = document.getElementById('aiIntro');
  const feelingOffBtn = document.getElementById('feelingOffBtn');
  const feedbackPanel = document.getElementById('feedbackPanel');
  const feedbackNote = document.getElementById('feedbackNote');
  const feedbackSubmitBtn = document.getElementById('feedbackSubmitBtn');
  const feedbackCancelBtn = document.getElementById('feedbackCancelBtn');
  const feedbackStatus = document.getElementById('feedbackStatus');
  const missedWeekBanner = document.getElementById('missedWeekBanner');
  const missedWeekText = document.getElementById('missedWeekText');
  const missedWeekApplyBtn = document.getElementById('missedWeekApplyBtn');
  const missedWeekDismissBtn = document.getElementById('missedWeekDismissBtn');

  // Kept around so the AI review step can send the currently-generated plan
  // (and retry on demand) without recomputing anything.
  let lastPlan = null;
  // fitnessLevel isn't a form field anymore (derived from currentWeeklyKm —
  // see deriveFitnessLevel) but reviewPlanWithAI() still wants it in its
  // payload (and applyAiAdjustments() wants it to rebuild interval
  // structure), so it's kept alongside lastPlan rather than re-read from a
  // DOM element that no longer exists.
  let lastFitnessLevel = null;
  // conservativeMode similarly needs to survive past the submit handler for
  // the same reasons (AI payload + interval-structure rebuild on adjustment).
  let lastConservativeMode = false;
  // Result of the most recent reviewPlanWithAI() call — read right after
  // renderPlan() (which resets the AI-notes DOM) to (re-)apply whichever of
  // the two actually happened. Exactly one of these is non-null after a
  // completed review; both are null while a review is in flight.
  let pendingAiNotes = null;
  let aiReviewErrorMessage = null;
  // The settings that produced lastPlan — kept so a day-swap (see
  // swapPlanDaySessions/handleSwapDayClick below) can re-save the plan
  // through the same savePlanForCurrentUser() path a fresh form submit
  // already uses, without needing to re-read the form.
  let lastSettings = null;
  // Every day-swap the user has made on the current plan, as {week, dowA,
  // dowB} triples — persisted alongside settings (see
  // savePlanForCurrentUser) and replayed against a freshly regenerated
  // plan on load (see loadSavedPlanForUser), since restoring a saved plan
  // re-runs generatePlan() from settings rather than storing the plan
  // itself, and a swap isn't something settings alone can reproduce.
  let daySwaps = [];
  // The day (as {week, dow}) currently picked as a swap's first side,
  // while waiting for the user to click a second day to swap it with —
  // null when no swap is in progress. See handleSwapDayClick.
  let swapSelection = null;
  // Every "I'm sick/tired" adjustment the user has accepted, as {week,
  // dow, type, km} absolute overrides (not deltas — unlike daySwaps,
  // which just exchanges two days' content and so replays cleanly
  // regardless of what a regenerated plan's numbers happen to be, a
  // feedback adjustment's whole point is a *specific* runner-approved
  // distance/type for that slot, so it's saved and replayed as that
  // literal value). Persisted and replayed the same way as daySwaps —
  // see handleFeedbackSubmit and applySavedDaySwaps/applySavedFeedback.
  let feedbackOverrides = [];
  // Week numbers the runner has already acted on (applied or dismissed) via
  // missedWeekBanner — see detectMissedWeek/renderMissedWeekBanner. Unlike
  // daySwaps/feedbackOverrides this isn't replayed against a regenerated
  // plan (there's nothing to reconstruct — it's just "don't ask again about
  // this week"), so it's persisted and restored as plain data only.
  let acknowledgedMissedWeeks = [];

  // Set a sensible default race date: 12 weeks from today.
  const defaultRaceDate = new Date();
  defaultRaceDate.setDate(defaultRaceDate.getDate() + 12 * 7);
  raceDateInput.value = defaultRaceDate.toISOString().slice(0, 10);
  raceDateInput.min = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Default start date: today — the runner can push it later if they're
  // not starting right away. Can't be set in the past.
  const todayStr = new Date().toISOString().slice(0, 10);
  startDateInput.value = todayStr;
  startDateInput.min = todayStr;

  // Default preferred days: Tue, Thu, Sat, Sun (matches default 4 days/week).
  ['2', '4', '6', '0'].forEach(v => {
    const cb = dayCheckboxes.querySelector(`input[value="${v}"]`);
    if (cb) cb.checked = true;
  });

  // 'race' (default, existing behavior) | 'baseBuilding' | 'maintenance'.
  // Drives mode/nonRaceStyle in gatherSettingsFromForm — see
  // PaceForgeGenerator.generatePlan's own settings-destructuring comment
  // for what each actually changes under the hood.
  function getGoalType() {
    return goalTypeToggle.querySelector('input[name="goalType"]:checked').value;
  }

  const GOAL_TYPE_COPY = {
    race: {
      legend: '1. Detail Race',
      dateLabel: 'Tanggal race',
      hint: '',
    },
    baseBuilding: {
      legend: '1. Detail Base Building',
      dateLabel: 'Akhir blok training',
      hint: 'Belum punya race? Sesi mingguannya fokus easy run + 1x lari santai di pace marathon per minggu (bukan tempo/interval kayak race prep) — murni buat naikkan mileage & aerobic base. Volume naik bertahap sepanjang blok, lalu berakhir di minggu evaluasi (deload + opsional time-trial), bukan hari race.',
    },
    maintenance: {
      legend: '1. Detail Maintenance',
      dateLabel: 'Akhir blok training',
      hint: 'Cuma mau jaga fitness tanpa target race? Volume mingguan ditahan flat (tidak naik), dan sesi quality (tempo/interval) diselingi Fartlek secara berkala biar tidak monoton.',
    },
  };

  // Both non-race modes default internally to this "gaya latihan" — see
  // planGenerator.js's RACE_PROFILES.medium/QUALITY_ROTATIONS.medium — with
  // no way for the user to change it (per explicit request: Base Building
  // no longer needs a choice here at all since its sessions are just easy +
  // marathon-pace regardless of "style", and Maintenance's own quality-mix
  // variety comes from QUALITY_ROTATIONS.medium + the Fartlek swap-in, not
  // from picking a distance). #presetDistanceField/#distanceModeField (see
  // updateGoalTypeUI) are hidden entirely for non-race rather than showing
  // a fixed, un-editable value — nothing left to show the user.
  const NON_RACE_DEFAULT_RACE_KEY = 'medium';

  function updateGoalTypeUI() {
    const goalType = getGoalType();
    const isRace = goalType === 'race';
    const copy = GOAL_TYPE_COPY[goalType];
    raceFieldsetLegend.textContent = copy.legend;
    raceDateLabel.textContent = copy.dateLabel;
    goalTypeHint.textContent = copy.hint;

    presetDistanceField.hidden = !isRace;
    distanceModeField.hidden = !isRace;
    if (isRace) {
      if (raceDistanceSel.value === NON_RACE_DEFAULT_RACE_KEY) raceDistanceSel.value = 'half';
      return;
    }
    // Custom km only makes sense as a real race distance — force back to
    // preset if a custom value was set under Race mode. Reuses
    // distanceModeToggle's own change handler (rather than duplicating its
    // presetDistanceField/customDistanceField/updateRecentRaceHint logic)
    // by dispatching a real change event after flipping the radio.
    if (getDistanceMode() === 'custom') {
      distanceModeToggle.querySelector('input[value="preset"]').checked = true;
      distanceModeToggle.dispatchEvent(new Event('change', { bubbles: true }));
    }
    raceDistanceSel.value = NON_RACE_DEFAULT_RACE_KEY;
  }
  goalTypeToggle.addEventListener('change', updateGoalTypeUI);
  updateGoalTypeUI();

  function getDistanceMode() {
    return distanceModeToggle.querySelector('input[name="distanceMode"]:checked').value;
  }

  distanceModeToggle.addEventListener('change', () => {
    const isCustom = getDistanceMode() === 'custom';
    presetDistanceField.hidden = isCustom;
    customDistanceField.hidden = !isCustom;
    updateRecentRaceHint();
  });

  function getCurrentRaceDistanceKm() {
    if (getDistanceMode() === 'custom') {
      const v = Number(customDistanceKm.value);
      return v > 0 ? v : null;
    }
    return RACE_META[raceDistanceSel.value]?.km ?? null;
  }

  function getRecentRaceDistanceKm() {
    if (recentRaceDistanceSel.value === 'custom') {
      const v = Number(recentRaceCustomKm.value);
      return v > 0 ? v : null;
    }
    const v = Number(recentRaceDistanceSel.value);
    return v > 0 ? v : null;
  }

  const DEFAULT_RECENT_RACE_HINT = recentRaceHint.textContent;

  // No more opt-in checkbox gating these fields (see index.html's own
  // comment on the fieldset) — "has a recent race" is now just "the time
  // fields add up to something", checked fresh from the inputs themselves
  // rather than a separate boolean the user has to remember to tick.
  function hasRecentRaceTimeEntered() {
    return (Number(recentRaceHours.value) || 0) * 3600
      + (Number(recentRaceMinutes.value) || 0) * 60
      + (Number(recentRaceSeconds.value) || 0) > 0;
  }

  function updateRecentRaceHint() {
    if (!hasRecentRaceTimeEntered()) {
      recentRaceHint.textContent = DEFAULT_RECENT_RACE_HINT;
      return;
    }
    const h = Number(recentRaceHours.value) || 0;
    const m = Number(recentRaceMinutes.value) || 0;
    const s = Number(recentRaceSeconds.value) || 0;
    const recentTimeSec = h * 3600 + m * 60 + s;
    const fromKm = getRecentRaceDistanceKm();
    const raceKm = getCurrentRaceDistanceKm();
    if (!fromKm || !raceKm) {
      recentRaceHint.textContent = 'Isi jarak race yang valid untuk melihat estimasi.';
      return;
    }
    const { predictRaceTime, formatDuration, formatPace } = PaceForgeGenerator;
    const predictedSec = predictRaceTime(recentTimeSec, fromKm, raceKm);
    recentRaceHint.textContent = `Estimasi: ${formatDuration(predictedSec)} untuk ${raceKm} km (pace ${formatPace(predictedSec / raceKm)}). Dipakai otomatis sebagai goal pace kalau kamu tidak isi target waktu finish di bawah.`;
  }

  // Sets recentRaceSourceNote's text AND look in one place: `badge: true`
  // reuses the exact same green "strava-fill-badge" style as section 2's
  // stravaFillBadge (see index.html) for a value that actually came from
  // Strava (a real race or a detected estimate) — `badge: false` falls back
  // to a plain field-hint for the "nothing found" case, which isn't Strava
  // data at all, just an explanation of its absence.
  function setRecentRaceSourceNote(text, badge) {
    recentRaceSourceNote.textContent = text;
    recentRaceSourceNote.className = badge ? 'strava-fill-badge' : 'field-hint';
    recentRaceSourceNote.hidden = false;
  }

  // Manually touching any of these fields invalidates whatever "dari Strava"
  // / "estimasi" provenance note was showing (see applyStravaSummaryToForm,
  // which sets it) — the number on screen is now the user's own edit, not
  // what Strava reported, so it shouldn't keep claiming a source
  // it no longer accurately describes.
  function clearRecentRaceSourceNote() {
    recentRaceSourceNote.hidden = true;
    recentRaceSourceNote.textContent = '';
  }

  recentRaceDistanceSel.addEventListener('change', () => {
    recentRaceCustomField.hidden = recentRaceDistanceSel.value !== 'custom';
    updateRecentRaceHint();
    clearRecentRaceSourceNote();
  });
  [recentRaceCustomKm, recentRaceHours, recentRaceMinutes, recentRaceSeconds].forEach(el => el.addEventListener('input', () => {
    updateRecentRaceHint();
    clearRecentRaceSourceNote();
  }));
  raceDistanceSel.addEventListener('change', updateRecentRaceHint);
  customDistanceKm.addEventListener('input', updateRecentRaceHint);

  daysPerWeekInput.addEventListener('input', () => {
    daysPerWeekOutput.textContent = `${daysPerWeekInput.value} hari`;
    updateDayCountHint();
    updateLongRunDayOptions();
  });

  dayCheckboxes.addEventListener('change', () => {
    updateDayCountHint();
    updateLongRunDayOptions();
  });

  function updateDayCountHint() {
    const selected = getSelectedDays().length;
    const needed = Number(daysPerWeekInput.value);
    if (selected === needed) {
      dayCountHint.textContent = `✓ ${selected} hari dipilih.`;
      dayCountHint.style.color = 'var(--color-accent)';
    } else {
      dayCountHint.textContent = `Pilih tepat ${needed} hari (saat ini: ${selected}).`;
      dayCountHint.style.color = '';
    }
  }
  updateDayCountHint();

  // Long-run day options are derived straight from the checked training
  // days above — never asked twice. Defaults to the chronologically last
  // selected day (same as the previous implicit behaviour), but the user
  // can override it; the current choice is preserved across updates when
  // it's still among the selected days.
  function updateLongRunDayOptions() {
    const selected = getSelectedDays();
    const sorted = [...selected].sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));
    const previousValue = longRunDaySelect.value ? Number(longRunDaySelect.value) : null;
    longRunDaySelect.innerHTML = sorted.map(dow => `<option value="${dow}">${DAY_LABELS[dow]}</option>`).join('');
    if (previousValue !== null && sorted.includes(previousValue)) {
      longRunDaySelect.value = String(previousValue);
    } else if (sorted.length) {
      longRunDaySelect.value = String(sorted[sorted.length - 1]);
    }
  }
  updateLongRunDayOptions();

  function getTargetMode() {
    return targetModeToggle.querySelector('input[name="targetMode"]:checked').value;
  }

  function updateTargetPaceHint() {
    if (getTargetMode() !== 'pace') { targetPaceHint.hidden = true; return; }
    const paceMin = Number(targetPaceMinutesInput.value) || 0;
    const paceSec = Number(targetPaceSecondsInput.value) || 0;
    const paceSecPerKm = paceMin * 60 + paceSec;
    const raceKm = getCurrentRaceDistanceKm();
    if (paceSecPerKm <= 0 || !raceKm) {
      targetPaceHint.hidden = true;
      return;
    }
    const { formatDuration } = PaceForgeGenerator;
    targetPaceHint.textContent = `≈ ${formatDuration(paceSecPerKm * raceKm)} untuk ${raceKm} km.`;
    targetPaceHint.hidden = false;
  }

  hasTargetTime.addEventListener('change', () => {
    targetInputWrap.hidden = !hasTargetTime.checked;
    updateTargetPaceHint();
  });

  targetModeToggle.addEventListener('change', () => {
    const isPace = getTargetMode() === 'pace';
    targetTimeFields.hidden = isPace;
    targetPaceFields.hidden = !isPace;
    updateTargetPaceHint();
  });
  [targetPaceMinutesInput, targetPaceSecondsInput].forEach(el => el.addEventListener('input', updateTargetPaceHint));
  raceDistanceSel.addEventListener('change', updateTargetPaceHint);
  customDistanceKm.addEventListener('input', updateTargetPaceHint);
  distanceModeToggle.addEventListener('change', updateTargetPaceHint);

  function getSelectedDays() {
    return Array.from(dayCheckboxes.querySelectorAll('input:checked')).map(cb => Number(cb.value));
  }

  function showError(msg) {
    formError.textContent = msg;
    formError.hidden = false;
    formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  function clearError() {
    formError.hidden = true;
    formError.textContent = '';
  }

  // "Level kebugaran" used to be a manual dropdown, but it's redundant now
  // that currentWeeklyKm is usually real Strava data rather than a guess —
  // approximate thresholds, same rough boundaries the old dropdown's option
  // labels described ("belum pernah/baru bisa lari 5K" vs "terbiasa 5-10K"
  // vs "terbiasa 10K+ rutin").
  //
  // Mileage alone is an incomplete signal — it says how much someone runs,
  // not how fast, and this whole classification exists to calibrate pace
  // (interval rep distance, default pace fallback, the conservative
  // pace-ramp gain). A recent race/time-trial is a much more direct read on
  // that, so it takes priority whenever it's available; mileage is only the
  // fallback for when there's no pace data at all to go on.
  function deriveFitnessLevelFromMileage(currentWeeklyKm) {
    if (currentWeeklyKm < 15) return 'beginner';
    if (currentWeeklyKm < 40) return 'intermediate';
    return 'advanced';
  }

  // Boundaries expressed as a 10K-equivalent finish time (Riegel-normalized,
  // so a 5K or half marathon result compares fairly). Anchored to actual
  // Indonesian recreational-running benchmarks rather than a guess:
  //   - "Pemula" 10K finishers typically run 60-90 min (IDN Times); a sub-
  //     5:00/km pace ("pace 4"/"kompetitif") is called out as the amateur
  //     "holy grail" advanced tier, while a sub-3-hour marathon is still
  //     considered an exceptional feat in the Indonesian running community
  //     (i.e. "advanced" here means genuinely strong amateur, not
  //     world-class) — so the advanced cutoff sits at a sub-50:00 10K, not
  //     something far stricter.
  //   - "Rekreasional"/intermediate 10K finishers land 50-70 min.
  // These also line up with planGenerator.js's DEFAULT_GOAL_PACE_SEC
  // per-level paces (4:45/6:00/7:30 per km, i.e. ~47:30/60:00/75:00 over
  // 10K) rounded to clean boundaries.
  function deriveFitnessLevelFromPace(equiv10kTimeSec) {
    if (equiv10kTimeSec <= 50 * 60) return 'advanced'; // sub-5:00/km-equivalent
    if (equiv10kTimeSec <= 65 * 60) return 'intermediate'; // 5:00-6:30/km-equivalent
    return 'beginner';
  }

  function deriveFitnessLevel(currentWeeklyKm, recentRaceTimeSec, recentRaceDistanceKm) {
    if (!recentRaceTimeSec || !recentRaceDistanceKm) return deriveFitnessLevelFromMileage(currentWeeklyKm);
    const equiv10kTimeSec = PaceForgeGenerator.predictRaceTime(recentRaceTimeSec, recentRaceDistanceKm, 10);
    return deriveFitnessLevelFromPace(equiv10kTimeSec);
  }

  // Reads & validates every field, showing an inline error and returning
  // null on the first problem found (same behaviour as the old inline
  // submit-handler code). Returns the settings object PaceForgeGenerator
  // expects otherwise. Pulled out on its own so both the submit handler and
  // the "restore my last plan after login" path can build it identically.
  function gatherSettingsFromForm() {
    const goalType = getGoalType();
    // mode/nonRaceStyle passed straight through to PaceForgeGenerator —
    // see its own settings-destructuring comment. raceDate is reused as the
    // non-race block's end date, not a real race (see GOAL_TYPE_COPY
    // above); raceDistance stays fixed at NON_RACE_DEFAULT_RACE_KEY (see
    // updateGoalTypeUI) since neither non-race mode exposes a choice here.
    const mode = goalType === 'race' ? 'race' : 'nonRace';
    const nonRaceStyle = goalType === 'race' ? null : goalType;
    const isCustomDistance = getDistanceMode() === 'custom';
    let raceKey = raceDistanceSel.value;
    let raceDistanceKm = RACE_META[raceKey]?.km;
    // Non-race: describes what the mode actually DOES (shown verbatim in
    // the summary card/PDF header) rather than RACE_META's race-name label
    // — there's no user-chosen "style" to show any more (see
    // NON_RACE_DEFAULT_RACE_KEY), so showing "Medium Distance" here would
    // just be a confusing, unexplained constant.
    const NON_RACE_LABEL = { baseBuilding: 'Aerobic Base', maintenance: 'Flat Volume' };
    let raceLabel = mode === 'race' ? RACE_META[raceKey]?.label : NON_RACE_LABEL[nonRaceStyle];
    if (isCustomDistance) {
      raceKey = 'custom';
      raceDistanceKm = Number(customDistanceKm.value);
      raceLabel = `${raceDistanceKm} km`;
      if (!raceDistanceKm || raceDistanceKm <= 0) {
        showError('Masukkan jarak custom yang valid (dalam km).');
        return null;
      }
    }

    const dateNoun = mode === 'race' ? 'tanggal race' : 'tanggal akhir blok';
    if (!raceDateInput.value) { showError(`Pilih ${dateNoun} terlebih dahulu.`); return null; }
    const raceDate = new Date(raceDateInput.value + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (raceDate <= today) { showError(`${dateNoun.charAt(0).toUpperCase()}${dateNoun.slice(1)} harus di masa depan.`); return null; }

    if (!startDateInput.value) { showError('Pilih tanggal mulai training terlebih dahulu.'); return null; }
    const startDate = new Date(startDateInput.value + 'T00:00:00');
    if (startDate < today) { showError('Tanggal mulai training tidak boleh di masa lalu.'); return null; }
    if (startDate >= raceDate) { showError(`Tanggal mulai training harus sebelum ${dateNoun}.`); return null; }

    const currentWeeklyKm = Number(currentWeeklyKmInput.value);
    if (currentWeeklyKm < 0 || Number.isNaN(currentWeeklyKm)) {
      showError('Isi rata-rata jarak lari mingguan yang valid (boleh 0 jika baru mulai).');
      return null;
    }

    const longestRecentRunKm = Number(longestRecentRunKmInput.value);
    if (longestRecentRunKm < 0 || Number.isNaN(longestRecentRunKm)) {
      showError('Isi jarak lari terjauhmu dalam 3 bulan terakhir yang valid (boleh 0 jika baru mulai).');
      return null;
    }

    let recentRaceTimeSec = null;
    let recentRaceDistanceKm = null;
    if (hasRecentRaceTimeEntered()) {
      const h = Number(recentRaceHours.value) || 0;
      const m = Number(recentRaceMinutes.value) || 0;
      const s = Number(recentRaceSeconds.value) || 0;
      recentRaceTimeSec = h * 3600 + m * 60 + s;
      recentRaceDistanceKm = getRecentRaceDistanceKm();
      if (!recentRaceDistanceKm || recentRaceDistanceKm <= 0) { showError('Isi jarak race terakhir yang valid.'); return null; }
    }

    // Bukan lagi field manual — diturunkan dari km mingguan (yang sendirinya
    // sudah auto-fill dari Strava kalau connected, atau diisi manual di
    // field yang sama), dikombinasikan dengan pace dari race terakhir kalau
    // ada (lihat deriveFitnessLevel di atas). planGenerator cuma pakai ini
    // sebagai fallback default pace (kalau target waktu finish & race
    // terakhir kosong dua-duanya) dan buat nge-tune jarak reps interval +
    // proyeksi kenaikan pace yang konservatif.
    const fitnessLevel = deriveFitnessLevel(currentWeeklyKm, recentRaceTimeSec, recentRaceDistanceKm);

    const daysPerWeek = Number(daysPerWeekInput.value);
    const preferredDays = getSelectedDays();
    if (preferredDays.length !== daysPerWeek) {
      showError(`Jumlah hari yang dipilih (${preferredDays.length}) harus sama dengan jumlah hari latihan per minggu (${daysPerWeek}).`);
      return null;
    }

    const longRunDay = longRunDaySelect.value !== '' ? Number(longRunDaySelect.value) : null;
    if (longRunDay === null || !preferredDays.includes(longRunDay)) {
      showError('Pilih hari untuk long run dari hari latihan yang sudah kamu tandai.');
      return null;
    }

    let targetTimeSec = null;
    if (TARGET_TIME_FEATURE_ENABLED && hasTargetTime.checked) {
      if (getTargetMode() === 'pace') {
        const paceMin = Number(targetPaceMinutesInput.value) || 0;
        const paceSec = Number(targetPaceSecondsInput.value) || 0;
        const paceSecPerKm = paceMin * 60 + paceSec;
        if (paceSecPerKm <= 0) { showError('Isi target pace yang valid.'); return null; }
        targetTimeSec = paceSecPerKm * raceDistanceKm;
      } else {
        const h = Number(targetHoursInput.value) || 0;
        const m = Number(targetMinutesInput.value) || 0;
        const s = Number(targetSecondsInput.value) || 0;
        targetTimeSec = h * 3600 + m * 60 + s;
      }
      if (targetTimeSec <= 0) { showError('Isi target waktu finish yang valid.'); return null; }
    }

    const conservativeMode = conservativeModeInput.checked;

    return {
      mode, nonRaceStyle,
      raceDistanceKm, raceLabel, raceKey, raceDate, startDate,
      fitnessLevel, currentWeeklyKm, longestRecentRunKm, daysPerWeek, preferredDays, longRunDay,
      targetTimeSec, recentRaceTimeSec, recentRaceDistanceKm, conservativeMode,
    };
  }

  // Reverse of gatherSettingsFromForm — pushes a previously-saved settings
  // object (loaded from Supabase) back into the form fields, keeping every
  // dependent hint/dropdown in sync exactly like a real user filling it in
  // would. Used only when restoring a plan after login.
  function applySettingsToForm(settings, userNotes) {
    // Plans saved before goal-type mode existed won't have `mode` at all —
    // fall back to 'race', same as the old implicit (and still default)
    // behaviour.
    const goalTypeValue = !settings.mode || settings.mode === 'race' ? 'race' : settings.nonRaceStyle;
    const goalTypeRadio = goalTypeToggle.querySelector(`input[value="${goalTypeValue}"]`);
    if (goalTypeRadio) goalTypeRadio.checked = true;
    updateGoalTypeUI();

    const isCustom = settings.raceKey === 'custom';
    distanceModeToggle.querySelector(`input[value="${isCustom ? 'custom' : 'preset'}"]`).checked = true;
    presetDistanceField.hidden = isCustom;
    customDistanceField.hidden = !isCustom;
    if (isCustom) {
      customDistanceKm.value = settings.raceDistanceKm;
    } else {
      raceDistanceSel.value = settings.raceKey;
    }

    raceDateInput.value = settings.raceDate.toISOString().slice(0, 10);
    // Plans saved before the start-date field existed won't have it —
    // fall back to today, same as the old implicit behaviour.
    startDateInput.value = settings.startDate
      ? settings.startDate.toISOString().slice(0, 10)
      : new Date().toISOString().slice(0, 10);

    // fitnessLevel sendiri tidak punya field di form lagi — diturunkan
    // ulang otomatis dari currentWeeklyKm begitu plan digenerate lagi.
    currentWeeklyKmInput.value = settings.currentWeeklyKm;
    longestRecentRunKmInput.value = settings.longestRecentRunKm;
    conservativeModeInput.checked = settings.conservativeMode;

    daysPerWeekInput.value = settings.daysPerWeek;
    daysPerWeekOutput.textContent = `${settings.daysPerWeek} hari`;
    dayCheckboxes.querySelectorAll('input').forEach(cb => {
      cb.checked = settings.preferredDays.includes(Number(cb.value));
    });
    updateDayCountHint();
    updateLongRunDayOptions();
    longRunDaySelect.value = String(settings.longRunDay);

    if (settings.recentRaceTimeSec != null) {
      const isPreset = ['5', '10', '15', '21.1', '42.2'].includes(String(settings.recentRaceDistanceKm));
      recentRaceDistanceSel.value = isPreset ? String(settings.recentRaceDistanceKm) : 'custom';
      recentRaceCustomField.hidden = isPreset;
      if (!isPreset) recentRaceCustomKm.value = settings.recentRaceDistanceKm;
      recentRaceHours.value = Math.floor(settings.recentRaceTimeSec / 3600);
      recentRaceMinutes.value = Math.floor((settings.recentRaceTimeSec % 3600) / 60);
      recentRaceSeconds.value = settings.recentRaceTimeSec % 60;
    } else {
      recentRaceHours.value = 0;
      recentRaceMinutes.value = 0;
      recentRaceSeconds.value = 0;
    }
    // A restored saved plan's settings carry no source provenance (see
    // savePlanForCurrentUser — only the plain time/distance is persisted,
    // not whether it originally came from a Strava race vs. estimate vs. a
    // manual edit), so there's nothing accurate left to label it with.
    clearRecentRaceSourceNote();
    updateRecentRaceHint();

    hasTargetTime.checked = settings.targetTimeSec != null;
    targetInputWrap.hidden = !hasTargetTime.checked;
    // Saved plans only ever store a resolved targetTimeSec, so restore
    // always lands back in "waktu finish" mode — pace is just an
    // alternate way to enter the same value, not a separately-saved mode.
    targetModeToggle.querySelector('input[value="time"]').checked = true;
    targetTimeFields.hidden = false;
    targetPaceFields.hidden = true;
    if (hasTargetTime.checked) {
      targetHoursInput.value = Math.floor(settings.targetTimeSec / 3600);
      targetMinutesInput.value = Math.floor((settings.targetTimeSec % 3600) / 60);
      targetSecondsInput.value = settings.targetTimeSec % 60;
    }
    updateTargetPaceHint();

    userNotesInput.value = userNotes || '';
  }

  // Generates the rule-based plan, then makes the user wait through an AI
  // review pass (reviewPlanWithAI — may adjust a handful of individual
  // sessions, see applyAiAdjustments) BEFORE the plan is shown at all, so
  // what the user sees is never "just whatever the algorithm spat out"
  // unreviewed. If the review fails or times out, the rule-based plan is
  // still shown as-is — the algorithm's own guardrails already make it safe
  // on its own; the AI pass is a second opinion, not a hard dependency.
  // The rule-based schedule itself computes instantly, but that AI pass is
  // a network call (up to a 20s timeout — see reviewPlanWithAI) — swaps to
  // loadingSection for the duration so that wait is never a frozen page,
  // regardless of where the caller found this function mid-flow (a fresh
  // form submit, or restoring a saved plan right after login).
  async function generateAndShowPlan(settings, { restoring = false } = {}) {
    const plan = PaceForgeGenerator.generatePlan(settings);
    lastPlan = plan;
    lastSettings = settings;
    lastFitnessLevel = settings.fitnessLevel;
    lastConservativeMode = settings.conservativeMode;
    // Freshly generated plan has no swaps/overrides applied yet — a
    // restoring caller (loadSavedPlanForUser) replays its saved daySwaps
    // and feedbackOverrides itself right after this returns, once the
    // resulting DOM actually exists to update.
    daySwaps = [];
    swapSelection = null;
    feedbackOverrides = [];
    acknowledgedMissedWeeks = [];

    showLoading(restoring ? 'Memuat training plan-mu...' : undefined);
    loadingSection.scrollIntoView({ behavior: 'smooth', block: 'start' });

    submitBtn.disabled = true;
    try {
      await reviewPlanWithAI();
    } finally {
      submitBtn.disabled = false;
    }

    renderPlan(lastPlan); // hides loadingSection, shows resultSection — see renderPlan
    applyPendingAiReviewToDom();
    return plan;
  }

  // --- Login gate ---
  function showGate() {
    gateSection.hidden = false;
    formSection.hidden = true;
    loadingSection.hidden = true;
    resultSection.hidden = true;
  }
  function showForm() {
    gateSection.hidden = true;
    formSection.hidden = false;
    loadingSection.hidden = true;
    resultSection.hidden = true;
  }
  // Used while checking for a saved plan right after login (see
  // onAuthChange below) — showForm() first, then swapping to a saved plan
  // a moment later used to flash the empty form for returning users with
  // one; showing this instead avoids that, falling back to showForm()
  // only once it's confirmed there's nothing saved to show.
  function showLoading(title) {
    gateSection.hidden = true;
    formSection.hidden = true;
    resultSection.hidden = true;
    loadingSection.hidden = false;
    if (loadingTitle) loadingTitle.textContent = title || 'Menyusun training plan-mu...';
  }

  // Flip in js/config.js once Strava login is actually wired up. While
  // false, the whole login gate/UI stays hidden and the form is shown
  // directly — everything below still runs, it's just never reached.
  const REQUIRE_LOGIN = !!(window.PACEFORGE_CONFIG && window.PACEFORGE_CONFIG.REQUIRE_LOGIN);

  // --- Cloud sync, via api/plan.js (backed by Supabase server-side), or a
  // localStorage stand-in while auth.js is still in dummy mode (see
  // js/auth.js) — same save/load shape either way, so nothing here needs to
  // change once a real Strava app + server env vars are wired up.
  const paceforgeAuth = window.PaceForgeAuth;
  const DUMMY_PLAN_KEY = 'paceforge_dummy_plan';

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

  // Re-renders one week's day rows in place from lastPlan's current data
  // — used after a swap instead of a full renderPlan() so the accordion's
  // open/closed state, other weeks' rows, and everything outside
  // <tbody> (AI notes, race-day tips, ...) are left untouched.
  function reRenderWeek(weekNumber) {
    if (!lastPlan) return;
    const week = lastPlan.weeks.find(w => w.weekNumber === weekNumber);
    const block = planWeeksEl.querySelector(`.week-block[data-week-number="${weekNumber}"]`);
    const tbody = block?.querySelector('table.day-table tbody');
    if (!week || !tbody) return;
    tbody.innerHTML = week.days.map(day => renderDayRow(day, weekNumber)).join('');
  }

  // Replays a saved daySwaps list (see savePlanForCurrentUser/
  // loadSavedPlanForUser) against a just-regenerated lastPlan — restoring
  // a saved plan re-runs generatePlan() from settings rather than storing
  // the plan itself, so a manual day-swap has to be re-applied every time
  // rather than surviving in the regenerated data on its own.
  function applySavedDaySwaps(savedSwaps) {
    if (!Array.isArray(savedSwaps) || !savedSwaps.length || !lastPlan) return;
    const touchedWeeks = new Set();
    savedSwaps.forEach(swap => {
      const week = lastPlan.weeks.find(w => w.weekNumber === swap.week);
      if (!week) return;
      const dayA = week.days.find(d => d.dow === swap.dowA);
      const dayB = week.days.find(d => d.dow === swap.dowB);
      if (!dayA || !dayB) return;
      swapPlanDaySessions(dayA, dayB);
      touchedWeeks.add(swap.week);
    });
    daySwaps = savedSwaps.slice();
    touchedWeeks.forEach(reRenderWeek);
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
  function applyFeedbackAdjustment(day, action, suggestedKm) {
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
      const built = buildIntervalStructure(km, lastFitnessLevel, lastConservativeMode, day.workoutVariant, day.paceSecPerKm, day.recoveryPaceSecPerKm);
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

  // Replays a saved feedbackOverrides list against a just-regenerated
  // lastPlan — same reasoning as applySavedDaySwaps above: restoring a
  // saved plan re-runs generatePlan() from settings, which reproduces
  // none of a runner-approved override on its own.
  function applySavedFeedbackOverrides(savedOverrides) {
    if (!Array.isArray(savedOverrides) || !savedOverrides.length || !lastPlan) return;
    const touchedWeeks = new Set();
    savedOverrides.forEach(entry => {
      const week = lastPlan.weeks.find(w => w.weekNumber === entry.week);
      const day = week?.days.find(d => d.dow === entry.dow);
      if (!day) return;
      // structure isn't saved (large, and cheaply rebuildable) — just
      // reconstruct it the same way applyFeedbackAdjustment does rather
      // than duplicating that logic here. Also relies on it (rather than
      // setting day.type/day.km directly) to clear stale fields left over
      // from whatever this day was regenerated as — a 'rest' override
      // still needs its old structure/workoutVariant/etc wiped, same as
      // a fresh 'skip' does.
      applyFeedbackAdjustment(day, entry.type === 'rest' ? 'skip' : 'reduce', entry.km);
      touchedWeeks.add(entry.week);
    });
    feedbackOverrides = savedOverrides.slice();
    touchedWeeks.forEach(reRenderWeek);
  }

  // Deterministic stand-in for the AI endpoint when it's unavailable
  // (network error, no ANTHROPIC_API_KEY, timeout — reviewPlanWithAI's
  // enhance-plan call degrades the same way, just to "no notes" instead
  // of to a fallback that still does something). Errs conservative and
  // uniform rather than trying to weigh how serious the runner's note
  // sounds without an LLM to actually read it: quality (tempo/interval/
  // repetition) sessions are skipped outright, the long run is cut by
  // 40%, and easy/recovery/shakeout are cut by 25% — every candidate day
  // gets *something* backed off, which is the safe default when "how bad
  // is this, really" can't be judged.
  // planGenerator.js has its own QUALITY_TYPES, but it's private to that
  // file's closure — not worth exporting just for this one check.
  const FEEDBACK_QUALITY_TYPES = new Set(['tempo', 'interval', 'repetition']);
  function buildRuleBasedFeedbackAdjustments(candidates) {
    return candidates.map(day => {
      if (FEEDBACK_QUALITY_TYPES.has(day.type)) return { week: day.week, dow: day.dow, action: 'skip' };
      const cutFraction = day.type === 'longRun' ? 0.4 : 0.25;
      return { week: day.week, dow: day.dow, action: 'reduce', suggestedKm: day.km * (1 - cutFraction) };
    });
  }

  function closeFeedbackPanel() {
    feedbackPanel.hidden = true;
    feedbackStatus.hidden = true;
    feedbackStatus.classList.remove('is-error');
    feedbackNote.value = '';
  }

  // A week counts as "significantly missed" once at least this fraction of
  // its planned km never got run (per Strava — see day.isCompleted, set by
  // markCompletedSessionsFromStrava). Simple fixed threshold rather than
  // anything fancier — same "explainable over clever" spirit as
  // buildRuleBasedFeedbackAdjustments above.
  const MISSED_WEEK_THRESHOLD = 0.4;

  // Looks at the week that just ended (i.e. the one right before whatever
  // week is current today) and flags it when the runner's actual Strava
  // mileage fell far short of what was planned. Only ever looks at THAT one
  // week — not "any past week with a gap" — so the nudge appears right when
  // it's fresh and never resurfaces for an old, long-settled week once the
  // plan has moved on. Returns null whenever there's nothing worth asking
  // about: no plan started/already over (no currentWeek), no prior week to
  // compare (currentWeek is week 1), that prior week planned ~0 km itself
  // (e.g. a rest week), the miss doesn't clear MISSED_WEEK_THRESHOLD, or the
  // runner already acted on this exact week via missedWeekBanner.
  function detectMissedWeek(plan) {
    const currentWeek = findCurrentWeek(plan.weeks);
    if (!currentWeek) return null;
    const missedWeek = plan.weeks.find(w => w.weekNumber === currentWeek.weekNumber - 1);
    if (!missedWeek) return null;
    if (acknowledgedMissedWeeks.includes(missedWeek.weekNumber)) return null;

    const plannedKm = missedWeek.totalKm;
    if (!(plannedKm > 0)) return null;

    let missedKm = 0;
    missedWeek.days.forEach(day => {
      if (day.type === 'rest' || day.type === 'race' || !day.km) return;
      if (!day.isCompleted) missedKm += day.km;
    });
    const missedFraction = missedKm / plannedKm;
    if (missedFraction < MISSED_WEEK_THRESHOLD) return null;

    return {
      missedWeek,
      currentWeek,
      plannedKm,
      missedKm: Math.round(missedKm * 10) / 10,
      missedFraction,
    };
  }

  function closeMissedWeekBanner() {
    missedWeekBanner.hidden = true;
  }

  // Recomputes and shows/hides missedWeekBanner — called after every
  // markCompletedSessionsFromStrava pass (see there) so it's always as
  // current as the completion data it depends on.
  function renderMissedWeekBanner() {
    if (!lastPlan) { closeMissedWeekBanner(); return; }
    const info = detectMissedWeek(lastPlan);
    if (!info) { closeMissedWeekBanner(); return; }

    const ranKm = Math.round((info.plannedKm - info.missedKm) * 10) / 10;
    const pct = Math.round(info.missedFraction * 100);
    missedWeekText.textContent = `⚠️ Minggu ${info.missedWeek.weekNumber} lalu cuma kepakai ${ranKm} dari ${info.plannedKm} km rencana (${pct}% terlewat). Mau PaceForge sesuaikan volume minggu ${info.currentWeek.weekNumber} ini biar nggak lompat balik ke rencana semula?`;
    missedWeekBanner.dataset.week = String(info.missedWeek.weekNumber);
    missedWeekBanner.hidden = false;
  }

  // Marks a week "handled" (applied or dismissed) so detectMissedWeek never
  // asks about it again, and persists that immediately — otherwise a
  // dismiss would just reappear on the next reload/device.
  function acknowledgeMissedWeek(weekNumber) {
    if (!acknowledgedMissedWeeks.includes(weekNumber)) acknowledgedMissedWeeks.push(weekNumber);
    closeMissedWeekBanner();
    if (REQUIRE_LOGIN && lastSettings) savePlanForCurrentUser(lastSettings);
  }

  function handleMissedWeekDismiss() {
    const weekNumber = Number(missedWeekBanner.dataset.week);
    if (Number.isFinite(weekNumber)) acknowledgeMissedWeek(weekNumber);
  }

  // Backs off the CURRENT week's upcoming sessions (never the missed week
  // itself — that's already over) by the same rule-based reduction
  // buildRuleBasedFeedbackAdjustments already uses for the manual "lagi
  // nggak fit?" flow — reused as-is rather than inventing a second set of
  // cut fractions. Deliberately rule-based only, no AI call: unlike a
  // runner's free-text note, "X% of last week's km never got run" doesn't
  // need judgment to interpret.
  function handleMissedWeekApply() {
    if (!lastPlan) return;
    const weekNumber = Number(missedWeekBanner.dataset.week);
    const info = detectMissedWeek(lastPlan);
    if (!info || info.missedWeek.weekNumber !== weekNumber) { closeMissedWeekBanner(); return; }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const candidates = [];
    info.currentWeek.days.forEach(day => {
      const dayDate = new Date(day.date);
      dayDate.setHours(0, 0, 0, 0);
      if (dayDate < today) return; // already run/passed this week — nothing left to back off
      if (day.type === 'race' || day.type === 'rest' || !day.km) return;
      candidates.push({ week: info.currentWeek.weekNumber, dow: day.dow, type: day.type, km: day.km });
    });

    if (candidates.length) {
      const adjustments = buildRuleBasedFeedbackAdjustments(candidates);
      const touchedWeeks = new Set();
      adjustments.forEach(adj => {
        const week = lastPlan.weeks.find(w => w.weekNumber === adj.week);
        const day = week?.days.find(d => d.dow === adj.dow);
        if (!day) return;
        if (adj.action === 'skip') applyFeedbackAdjustment(day, 'skip');
        else applyFeedbackAdjustment(day, 'reduce', adj.suggestedKm);
        feedbackOverrides = feedbackOverrides.filter(o => !(o.week === adj.week && o.dow === adj.dow));
        feedbackOverrides.push({ week: adj.week, dow: adj.dow, type: day.type, km: day.km });
        touchedWeeks.add(adj.week);
      });
      touchedWeeks.forEach(reRenderWeek);
      if (touchedWeeks.size) markCompletedSessionsFromStrava(lastPlan).catch(() => {});
    }

    acknowledgeMissedWeek(weekNumber);
  }

  async function handleFeedbackSubmit() {
    if (!lastPlan) return;
    const note = feedbackNote.value.trim();
    if (!note) {
      feedbackStatus.hidden = false;
      feedbackStatus.classList.add('is-error');
      feedbackStatus.textContent = 'Ceritain dulu kondisimu sebelum disesuaikan.';
      return;
    }
    const scope = document.querySelector('input[name="feedbackScope"]:checked')?.value || 'week';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const scopeWeek = scope === 'today' || scope === 'week' ? (findCurrentWeek(lastPlan.weeks) || lastPlan.weeks[0]) : null;

    // Candidate days: today or later (never past, and — for scope
    // "today" specifically — never later than today either), never race
    // day, and only ones with actual distance — a rest day has nothing
    // left to back off.
    const candidates = [];
    lastPlan.weeks.forEach(week => {
      if (scopeWeek && week.weekNumber !== scopeWeek.weekNumber) return;
      week.days.forEach(day => {
        const dayDate = new Date(day.date);
        dayDate.setHours(0, 0, 0, 0);
        if (dayDate < today) return;
        if (scope === 'today' && dayDate.getTime() !== today.getTime()) return;
        if (day.type === 'race' || day.type === 'rest' || !day.km) return;
        candidates.push({ week: week.weekNumber, dow: day.dow, type: day.type, km: day.km });
      });
    });
    if (!candidates.length) {
      feedbackStatus.hidden = false;
      feedbackStatus.classList.add('is-error');
      feedbackStatus.textContent = 'Nggak ada sesi yang bisa disesuaikan di rentang itu.';
      return;
    }

    feedbackSubmitBtn.disabled = true;
    feedbackStatus.hidden = false;
    feedbackStatus.classList.remove('is-error');
    feedbackStatus.textContent = '✨ Menyesuaikan jadwal...';

    let adjustments;
    let summary;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch('/api/adjust-plan-feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ note, days: candidates }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server merespons status ${res.status}`);
      adjustments = Array.isArray(data.adjustments) ? data.adjustments : [];
      summary = data.summary;
    } catch (err) {
      adjustments = buildRuleBasedFeedbackAdjustments(candidates);
      summary = 'Nggak bisa hubungi AI, jadi jadwalnya disesuaikan otomatis pakai aturan standar (sesi keras diistirahatkan, sesi lain dikurangi).';
    } finally {
      clearTimeout(timeoutId);
      feedbackSubmitBtn.disabled = false;
    }

    // Validated/clamped the same way applyAiAdjustments treats the
    // automatic review's suggestions — every adjustment must reference a
    // day this call actually offered up as a candidate (never trust the
    // AI to only touch what it was given), and 'reduce' can only ever
    // shrink a session, never grow one.
    const candidateByKey = new Map(candidates.map(c => [`${c.week}:${c.dow}`, c]));
    const touchedWeeks = new Set();
    adjustments.forEach(adj => {
      if (!adj || typeof adj.week !== 'number' || typeof adj.dow !== 'number') return;
      const candidate = candidateByKey.get(`${adj.week}:${adj.dow}`);
      if (!candidate) return;
      const week = lastPlan.weeks.find(w => w.weekNumber === adj.week);
      const day = week?.days.find(d => d.dow === adj.dow);
      if (!day || day.type !== candidate.type) return;
      if (adj.action === 'skip') {
        applyFeedbackAdjustment(day, 'skip');
      } else if (adj.action === 'reduce' && Number.isFinite(adj.suggestedKm) && adj.suggestedKm > 0 && adj.suggestedKm < candidate.km) {
        applyFeedbackAdjustment(day, 'reduce', adj.suggestedKm);
      } else {
        return;
      }
      feedbackOverrides = feedbackOverrides.filter(o => !(o.week === adj.week && o.dow === adj.dow));
      feedbackOverrides.push({ week: adj.week, dow: adj.dow, type: day.type, km: day.km });
      touchedWeeks.add(adj.week);
    });
    touchedWeeks.forEach(reRenderWeek);

    if (touchedWeeks.size) {
      markCompletedSessionsFromStrava(lastPlan).catch(() => {});
      if (REQUIRE_LOGIN && lastSettings) savePlanForCurrentUser(lastSettings);
      feedbackStatus.classList.remove('is-error');
      feedbackStatus.textContent = summary || `✓ ${touchedWeeks.size} sesi disesuaikan.`;
    } else {
      feedbackStatus.classList.add('is-error');
      feedbackStatus.textContent = 'Nggak ada sesi yang perlu disesuaikan menurut catatan itu.';
    }
  }

  // Handles a click on a day row's swap button (⇄) — the first click
  // picks that day as the swap's source (highlighted, see renderDayRow),
  // the second click on a different day in the *same* week performs the
  // swap; clicking the already-selected day's button again cancels.
  // Race day is never swappable (it's tied to the runner's actual
  // real-world race date, not a slot that can just move); swapping a
  // long run asks for confirmation first since it's a bigger change to a
  // week's shape than an easy/quality day moving.
  // Does the actual swap (same guardrails and persistence either
  // interaction path needs) between two days in the same week — shared by
  // the click-click flow (handleSwapDayClick) and drag-and-drop
  // (handleDayDrop below), so the rules can't drift between the two ways
  // of doing the same thing. Cross-week swaps aren't supported by either
  // caller (handleSwapDayClick re-targets instead of attempting one;
  // handleDayDrop just no-ops), so this rejects one outright rather than
  // leaving that decision to each caller. Re-renders the week and
  // persists on success; callers are responsible for re-rendering on
  // their own to clear whatever selection/drag-over state they were
  // tracking when this returns false.
  function attemptDaySwap(weekNumber, dowA, dowB) {
    if (!lastPlan || dowA === dowB) return false;
    const week = lastPlan.weeks.find(w => w.weekNumber === weekNumber);
    const dayA = week?.days.find(d => d.dow === dowA);
    const dayB = week?.days.find(d => d.dow === dowB);
    if (!dayA || !dayB) return false;
    // 'evaluation' (non-race modes' self-test day, see planGenerator.js's
    // isNonRace 'race'-day-type branch) is pinned to the block's own end
    // date the exact same way 'race' is pinned to the runner's real race
    // date — neither is a slot that can just move.
    if (dayA.type === 'race' || dayB.type === 'race' || dayA.type === 'evaluation' || dayB.type === 'evaluation') {
      const isEvaluation = dayA.type === 'evaluation' || dayB.type === 'evaluation';
      alert(isEvaluation
        ? 'Minggu evaluasi nggak bisa dipindah — itu tanggal akhir blok, bukan slot latihan.'
        : 'Race day nggak bisa dipindah — itu tanggal race sungguhan, bukan slot latihan.');
      return false;
    }
    // Backstops the UI-level guards in renderDayRow/markCompletedSessionsFromStrava
    // (no swap button, not draggable, on a day already marked completed) —
    // this is what actually rejects a swap attempted via a stale button
    // reference or a drop onto a completed row, which skips draggable
    // entirely but not being a valid drop *target*.
    if (dayA.isCompleted || dayB.isCompleted) {
      alert('Sesi yang sudah kamu jalani nggak bisa ditukar lagi — datanya sudah tercatat dari Strava.');
      return false;
    }
    if (dayA.type === 'longRun' || dayB.type === 'longRun') {
      if (!confirm('Ini bakal mindahin long run ke hari lain minggu ini. Lanjutkan?')) return false;
    }
    swapPlanDaySessions(dayA, dayB);
    daySwaps.push({ week: weekNumber, dowA, dowB });
    reRenderWeek(weekNumber);
    markCompletedSessionsFromStrava(lastPlan).catch(() => {});
    if (REQUIRE_LOGIN && lastSettings) savePlanForCurrentUser(lastSettings);
    return true;
  }

  function handleSwapDayClick(weekNumber, dow) {
    if (!lastPlan) return;
    if (!swapSelection) {
      swapSelection = { week: weekNumber, dow };
      reRenderWeek(weekNumber);
      return;
    }
    const sourceWeek = swapSelection.week;
    const sourceDow = swapSelection.dow;
    if (sourceWeek === weekNumber && sourceDow === dow) {
      swapSelection = null;
      reRenderWeek(weekNumber);
      return;
    }
    if (sourceWeek !== weekNumber) {
      swapSelection = { week: weekNumber, dow };
      reRenderWeek(sourceWeek);
      reRenderWeek(weekNumber);
      return;
    }
    swapSelection = null;
    if (!attemptDaySwap(weekNumber, sourceDow, dow)) reRenderWeek(weekNumber);
  }

  // Drag-and-drop is the desktop-mouse path to the same swap the ⇄ button
  // (handleSwapDayClick) already does — HTML5 drag events don't fire on
  // touch at all, so the button stays as the interaction every device can
  // actually use; this is additive, not a replacement. dragWeek/dragDow
  // track the row currently being dragged (module-scoped so dragover/drop,
  // fired on a *different* row, can read what dragstart recorded — the
  // dataTransfer payload alone would work too, but reading it back
  // requires the 'drop' event specifically, and dragover needs to already
  // know whether to show a valid-drop-target style before that fires).
  let dragWeek = null;
  let dragDow = null;
  function handleDayDragStart(e, weekNumber, dow) {
    dragWeek = weekNumber;
    dragDow = dow;
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `${weekNumber}:${dow}`);
    e.currentTarget.classList.add('is-dragging');
  }
  function handleDayDrop(e, weekNumber, dow) {
    e.preventDefault();
    e.currentTarget.classList.remove('is-drag-over');
    if (dragWeek === weekNumber && dragDow !== null && dragDow !== dow) {
      attemptDaySwap(weekNumber, dragDow, dow);
    }
    dragWeek = null;
    dragDow = null;
  }

  async function savePlanForCurrentUser(settings) {
    const payload = {
      settings: {
        ...settings,
        raceDate: settings.raceDate.toISOString().slice(0, 10),
        startDate: settings.startDate.toISOString().slice(0, 10),
        // Carried inside settings (rather than a sibling payload field)
        // so it flows through the existing dummy-mode localStorage blob
        // and the real /api/plan settings jsonb column unchanged — both
        // already treat settings as an opaque bag, and generatePlan()
        // itself ignores keys it doesn't recognize, so this needed no
        // schema or endpoint change on either path.
        daySwaps,
        feedbackOverrides,
        acknowledgedMissedWeeks,
      },
      user_notes: userNotesInput.value.trim(),
    };

    if (!paceforgeAuth) return;

    if (paceforgeAuth.isDummy()) {
      localStorage.setItem(DUMMY_PLAN_KEY, JSON.stringify(payload));
      paceforgeAuth.setSyncStatus('✓ Plan tersimpan (mode dummy — lokal di browser ini saja).');
      return;
    }

    paceforgeAuth.setSyncStatus('Menyimpan plan ke akunmu...');
    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server merespons status ${res.status}`);
      paceforgeAuth.setSyncStatus('✓ Plan tersimpan ke akunmu.');
    } catch (err) {
      paceforgeAuth.setSyncStatus(`Gagal menyimpan plan ke akun: ${err.message}`, true);
    }
  }

  // Returns true kalau ada plan tersimpan yang berhasil dimuat & diterapkan
  // ke form (dipakai caller untuk memutuskan apakah perlu jatuh ke
  // prefillFromStrava() sebagai gantinya — lihat bawah).
  async function loadSavedPlanForUser(user) {
    if (!user || !paceforgeAuth) return false;

    if (paceforgeAuth.isDummy()) {
      const raw = localStorage.getItem(DUMMY_PLAN_KEY);
      if (!raw) return false;
      const data = JSON.parse(raw);
      const settings = {
        ...data.settings,
        raceDate: new Date(data.settings.raceDate + 'T00:00:00'),
        // Older saved plans predate the start-date field — fall back to today.
        startDate: new Date((data.settings.startDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00'),
      };
      applySettingsToForm(settings, data.user_notes || '');
      await generateAndShowPlan(settings, { restoring: true });
      applySavedDaySwaps(data.settings.daySwaps);
      applySavedFeedbackOverrides(data.settings.feedbackOverrides);
      // Plain data, not replayed against the plan — see the declaration
      // above for why this doesn't need an "apply" step like the two lines
      // above it do.
      acknowledgedMissedWeeks = Array.isArray(data.settings.acknowledgedMissedWeeks) ? data.settings.acknowledgedMissedWeeks.slice() : [];
      // generateAndShowPlan above already rendered missedWeekBanner once,
      // against the freshly-reset (empty) acknowledgedMissedWeeks it starts
      // every plan with — refresh it now that this restore's saved value is
      // actually in place, or a previously-dismissed/applied week's banner
      // would incorrectly reappear on every reload.
      renderMissedWeekBanner();
      paceforgeAuth.setSyncStatus('✓ Plan terakhir dimuat (mode dummy — lokal).');
      return true;
    }

    paceforgeAuth.setSyncStatus('Memuat plan tersimpan...');
    try {
      const res = await fetch('/api/plan');
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server merespons status ${res.status}`);
      if (!data.settings) {
        // Belum pernah menyimpan plan dari akun ini — bukan error, cuma
        // belum ada apa-apa yang perlu direstore.
        paceforgeAuth.setSyncStatus('');
        return false;
      }
      const settings = {
        ...data.settings,
        raceDate: new Date(data.settings.raceDate + 'T00:00:00'),
        // Older saved plans predate the start-date field — fall back to today.
        startDate: new Date((data.settings.startDate || new Date().toISOString().slice(0, 10)) + 'T00:00:00'),
      };
      applySettingsToForm(settings, data.user_notes || '');
      await generateAndShowPlan(settings, { restoring: true });
      applySavedDaySwaps(data.settings.daySwaps);
      applySavedFeedbackOverrides(data.settings.feedbackOverrides);
      // Plain data, not replayed against the plan — see the declaration
      // above for why this doesn't need an "apply" step like the two lines
      // above it do.
      acknowledgedMissedWeeks = Array.isArray(data.settings.acknowledgedMissedWeeks) ? data.settings.acknowledgedMissedWeeks.slice() : [];
      // generateAndShowPlan above already rendered missedWeekBanner once,
      // against the freshly-reset (empty) acknowledgedMissedWeeks it starts
      // every plan with — refresh it now that this restore's saved value is
      // actually in place, or a previously-dismissed/applied week's banner
      // would incorrectly reappear on every reload.
      renderMissedWeekBanner();
      paceforgeAuth.setSyncStatus('✓ Plan terakhir dimuat dari akunmu.');
      return true;
    } catch (err) {
      paceforgeAuth.setSyncStatus(`Gagal memuat plan tersimpan: ${err.message}`, true);
      return false;
    }
  }

  // Data dummy dipakai saat js/config.js belum diisi STRAVA_CLIENT_ID
  // sungguhan — supaya alur auto-fill bisa dicoba tanpa app Strava/server
  // beneran, sama seperti data plan dummy di atas.
  const DUMMY_STRAVA_SUMMARY = {
    currentWeeklyKm: 24,
    longestRecentRunKm: 12.5,
    recentRace: { distanceKm: 10, timeSec: 52 * 60 + 30, isEstimate: false },
    suggestedDaysOfWeek: [2, 4, 6, 0],
  };

  // Dipanggil setelah login (kalau athlete itu belum punya plan tersimpan —
  // lihat wiring di bawah) dan lagi setiap kali "Buat Plan Baru" diklik, biar
  // form baru selalu mulai dari data Strava terkini, bukan angka lama dari
  // plan tersimpan sebelumnya. Mengisi field yang bisa diturunkan dari
  // histori lari di Strava lewat elemen form yang sama yang user isi manual,
  // jadi otomatis tetap bisa diedit sebelum submit.
  async function prefillFromStrava() {
    if (!paceforgeAuth) return;
    // Reset dulu — pemanggilan sebelumnya (kalau ada) mungkin sudah
    // menampilkannya, dan refresh kali ini belum tentu nemu data baru.
    stravaFillBadge.hidden = true;
    let summary;
    if (paceforgeAuth.isDummy()) {
      summary = DUMMY_STRAVA_SUMMARY;
    } else {
      try {
        const res = await fetch('/api/strava-summary');
        summary = await res.json();
        if (!res.ok) throw new Error(summary.error || `Server merespons status ${res.status}`);
      } catch (err) {
        paceforgeAuth.setSyncStatus(`Gagal mengambil data Strava: ${err.message}`, true);
        return;
      }
    }
    applyStravaSummaryToForm(summary);
  }

  function applyStravaSummaryToForm(summary) {
    let filledAny = false;

    if (summary.currentWeeklyKm != null) {
      currentWeeklyKmInput.value = summary.currentWeeklyKm;
      stravaFillBadge.hidden = false;
      filledAny = true;
    }
    if (summary.longestRecentRunKm != null) {
      longestRecentRunKmInput.value = summary.longestRecentRunKm;
      stravaFillBadge.hidden = false;
      filledAny = true;
    }
    if (summary.recentRace) {
      const isPreset = ['5', '10', '15', '21.1', '42.2'].includes(String(summary.recentRace.distanceKm));
      recentRaceDistanceSel.value = isPreset ? String(summary.recentRace.distanceKm) : 'custom';
      recentRaceCustomField.hidden = isPreset;
      if (!isPreset) recentRaceCustomKm.value = summary.recentRace.distanceKm;
      recentRaceHours.value = Math.floor(summary.recentRace.timeSec / 3600);
      recentRaceMinutes.value = Math.floor((summary.recentRace.timeSec % 3600) / 60);
      recentRaceSeconds.value = summary.recentRace.timeSec % 60;
      updateRecentRaceHint();
      // isEstimate (see server/strava.js's summarizeRuns) distinguishes a
      // genuine Strava-tagged race from the best quality segment found
      // within an otherwise-untagged run — worth saying out loud, since the
      // two are different-confidence signals even though they fill the
      // exact same fields the exact same way. Both are real Strava data
      // though, so both get the badge treatment (badge: true).
      setRecentRaceSourceNote(
        summary.recentRace.isEstimate
          ? '📊 Estimasi dari segmen tercepat di salah satu sesi larimu (bukan race resmi di Strava) — edit di bawah kalau kamu punya waktu race asli.'
          : '📊 Dari race yang kamu tandai di Strava.',
        true,
      );
      filledAny = true;
    } else {
      recentRaceHours.value = 0;
      recentRaceMinutes.value = 0;
      recentRaceSeconds.value = 0;
      updateRecentRaceHint();
      setRecentRaceSourceNote('Belum ada race atau sesi cepat (≥3km) yang terdeteksi dari Strava-mu dalam 90 hari terakhir. Isi manual di bawah kalau ada, atau kosongkan — plan akan pakai pace default sesuai level fitnessmu.', false);
    }
    if (Array.isArray(summary.suggestedDaysOfWeek) && summary.suggestedDaysOfWeek.length) {
      const daysPerWeek = Number(daysPerWeekInput.value);
      const picks = summary.suggestedDaysOfWeek.slice(0, daysPerWeek);
      dayCheckboxes.querySelectorAll('input').forEach(cb => {
        cb.checked = picks.includes(Number(cb.value));
      });
      updateDayCountHint();
      updateLongRunDayOptions();
      filledAny = true;
    }

    if (filledAny) {
      paceforgeAuth.setSyncStatus('✨ Sebagian field (km mingguan, lari terjauh, race terakhir, hari latihan) diisi otomatis dari data Strava-mu — cek dulu sebelum submit.');
    }
  }

  // Fake recent activities for dummy mode, generated fresh (relative to
  // "today") on every call rather than baked into DUMMY_STRAVA_SUMMARY
  // above — so the demo still lines up with whatever plan is currently on
  // screen (its week 1 typically starts right around today; see
  // planStartAnchor in planGenerator.js).
  function buildDummyRecentRuns() {
    const daysAgo = n => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
    return [
      { date: dateKey(daysAgo(1)), km: 8.2, movingTimeSec: 48 * 60 },
      { date: dateKey(daysAgo(3)), km: 5.0, movingTimeSec: 27 * 60 },
      { date: dateKey(daysAgo(4)), km: 12.5, movingTimeSec: 68 * 60 },
    ];
  }

  // The overall average pace of an interval/repetition/tempo activity is
  // dragged slow by its warm up/cool down/jogged-recovery segments — see
  // upgradeRecentAnalysisWithSegmentPace below, which fixes this for
  // recently-completed sessions by pulling the actual hard-segment pace out
  // of Strava's own `best_efforts`. This set is only the fallback label used
  // BEFORE (or if) that upgrade happens: 'tempo' isn't listed here since a
  // whole-activity tempo average is still a reasonable (if diluted)
  // approximation, but interval/repetition's averages include full-recovery
  // jogs between reps, which read as "way slower than target" even on a
  // well-executed session — misleading enough to caveat rather than compare
  // outright.
  const NON_COMPARABLE_PACE_TYPES = new Set(['interval', 'repetition']);

  // How many days back from today still get the upgraded, best_efforts-
  // based comparison below (see upgradeRecentAnalysisWithSegmentPace) —
  // roughly "this week + last week". Bounds the extra per-activity Strava
  // API calls this can cost to a handful, regardless of how many weeks/
  // sessions the plan as a whole has already covered — see that function's
  // own comment for the full reasoning.
  const RECENT_ANALYSIS_WINDOW_DAYS = 14;

  // A matched best_effort has to land within this fraction of the planned
  // hard-segment distance to count as "the same segment" — Strava's
  // best_efforts only come in fixed round distances (1K, 1 mile, 5K, ...),
  // never exactly whatever a given workout's warm up/cool down split out
  // to, so this is deliberately loose rather than requiring an exact match
  // that would almost never occur.
  const EFFORT_MATCH_TOLERANCE = 0.4;

  // The planned distance of a session's actual hard segment — the part
  // upgradeRecentAnalysisWithSegmentPace tries to match against one of the
  // activity's best_efforts, as opposed to the warm up/cool down/recovery
  // padding around it. Derived from day.structure.kind (see
  // planGenerator.js's buildTempoStructure/buildRepsStructure), not
  // day.type directly — 'interval' covers real interval, cruise-tempo, AND
  // repetition sessions alike, since they all share the same warm up ->
  // reps -> cool down shape.
  function plannedHardSegmentKm(structure) {
    if (!structure) return null;
    if (structure.kind === 'tempo' && structure.tempoKm > 0) return structure.tempoKm;
    if (structure.kind === 'interval' && structure.reps > 0 && structure.workKm > 0) return structure.reps * structure.workKm;
    return null;
  }

  // sessionStorage cache for api/strava-activity-detail.js responses — a
  // past activity's best_efforts never change, so once fetched this tab
  // never re-fetches it again (a fresh page load in a NEW tab/session
  // does) rather than re-hitting Strava's API on every re-render. Wrapped
  // in try/catch since sessionStorage can throw (private browsing, storage
  // disabled) — a cache miss there just means "fetch fresh", not a hard
  // failure.
  async function fetchActivityDetailCached(activityId) {
    const cacheKey = `paceforge_activity_detail_${activityId}`;
    try {
      const cached = sessionStorage.getItem(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch { /* fall through to a fresh fetch */ }
    const res = await fetch(`/api/strava-activity-detail?id=${activityId}`);
    if (!res.ok) return null;
    const data = await res.json();
    try { sessionStorage.setItem(cacheKey, JSON.stringify(data)); } catch { /* best-effort only */ }
    return data;
  }

  // Picks whichever best_effort's distance is closest (relatively) to
  // targetKm, or null if nothing's within EFFORT_MATCH_TOLERANCE — the
  // closest available proxy for "how fast was the actual hard segment",
  // not necessarily this activity's single fastest effort.
  function closestBestEffort(bestEfforts, targetKm) {
    if (!Array.isArray(bestEfforts) || !bestEfforts.length || !(targetKm > 0)) return null;
    let best = null;
    let bestRelDiff = Infinity;
    bestEfforts.forEach(effort => {
      if (!(effort.distanceKm > 0) || !(effort.timeSec > 0)) return;
      const relDiff = Math.abs(effort.distanceKm - targetKm) / targetKm;
      if (relDiff < bestRelDiff) { bestRelDiff = relDiff; best = effort; }
    });
    return bestRelDiff <= EFFORT_MATCH_TOLERANCE ? best : null;
  }

  const SEGMENT_TYPE_LABEL = { tempo: 'tempo', interval: 'interval', repetition: 'repetition' };

  // Builds the "Pace ... (target ..., N detik/km lebih cepat/lambat)"
  // fragment shared by both the whole-activity baseline (renderCompletedRow
  // below) and the upgraded segment-based version (
  // upgradeRecentAnalysisWithSegmentPace) — same comparison logic either
  // way, just fed a different actualPaceSecPerKm/caveat.
  function buildPaceComparisonLabel(paceLabelPrefix, actualPaceSecPerKm, day, caveat) {
    const { formatPace } = PaceForgeGenerator;
    let label = `${paceLabelPrefix} ${formatPace(actualPaceSecPerKm)}`;
    if (caveat) {
      label += ` (${caveat})`;
    } else if (day.paceSecPerKm) {
      const diffSec = Math.round(actualPaceSecPerKm - day.paceSecPerKm);
      label += Math.abs(diffSec) < 3
        ? ' — pas di target'
        : ` (target ${formatPace(day.paceSecPerKm)}, ${Math.abs(diffSec)} detik/km ${diffSec < 0 ? 'lebih cepat' : 'lebih lambat'})`;
    }
    return label;
  }

  // Renders the baseline (whole-activity-average) comparison into
  // analysisEl — always runs first, for every matched day regardless of how
  // long ago it was, so the plan never waits on the extra best_efforts
  // fetch below just to show SOMETHING (the caller decides separately,
  // via plannedHardSegmentKm, whether this day also qualifies for the
  // upgrade — see markCompletedSessionsFromStrava).
  function renderCompletedRow(analysisEl, day, best) {
    const { formatDuration } = PaceForgeGenerator;
    const actualPaceSecPerKm = best.movingTimeSec / best.km;
    const kmDiff = Math.round((best.km - day.km) * 100) / 100;
    const kmDiffLabel = kmDiff === 0 ? '' : ` (${kmDiff > 0 ? '+' : ''}${kmDiff} km dari rencana)`;
    const caveat = NON_COMPARABLE_PACE_TYPES.has(day.type) ? 'termasuk jeda recovery, bukan pace repetisinya sendiri' : null;
    const paceLabel = buildPaceComparisonLabel('Pace rata-rata', actualPaceSecPerKm, day, caveat);
    analysisEl.innerHTML = `📊 ${best.km} km${kmDiffLabel} &middot; ${paceLabel} &middot; ${formatDuration(best.movingTimeSec)}`;
  }

  // Progressive enhancement over renderCompletedRow's baseline: for a
  // handful of recently-completed tempo/interval/repetition sessions (see
  // RECENT_ANALYSIS_WINDOW_DAYS), fetches that activity's best_efforts and,
  // if one lands close enough to the session's own planned hard-segment
  // distance (see plannedHardSegmentKm), swaps the pace comparison from
  // "whole activity, diluted by warm up/cool down/recovery jogs" to "just
  // the hard segment itself" — including for interval/repetition, which
  // otherwise only ever get the NON_COMPARABLE_PACE_TYPES caveat instead of
  // a real target comparison. Silently leaves the baseline in place on any
  // failure (no detail, no matching effort, request error) — this is an
  // accuracy upgrade on an already-complete, already-useful row, never
  // something worth surfacing as an error.
  async function upgradeRecentAnalysisWithSegmentPace(candidates) {
    const { formatDuration } = PaceForgeGenerator;
    await Promise.all(candidates.map(async ({ analysisEl, day, best, targetKm }) => {
      let detail;
      try {
        detail = await fetchActivityDetailCached(best.id);
      } catch {
        return;
      }
      const effort = detail && closestBestEffort(detail.bestEfforts, targetKm);
      if (!effort) return;

      const actualPaceSecPerKm = effort.timeSec / effort.distanceKm;
      const kmDiff = Math.round((best.km - day.km) * 100) / 100;
      const kmDiffLabel = kmDiff === 0 ? '' : ` (${kmDiff > 0 ? '+' : ''}${kmDiff} km dari rencana)`;
      const segmentLabel = SEGMENT_TYPE_LABEL[day.type] || 'segmen';
      const paceLabel = buildPaceComparisonLabel(`Pace ${segmentLabel} (≈${effort.distanceKm} km):`, actualPaceSecPerKm, day, null);
      analysisEl.innerHTML = `📊 ${best.km} km${kmDiffLabel} &middot; ${paceLabel} &middot; ${formatDuration(best.movingTimeSec)}`;
    }));
  }

  // Compares the currently-shown plan's PAST-or-today sessions against the
  // runner's actual Strava activities, so a page reload or a fresh login
  // shows which sessions have already been done — recomputed fresh every
  // time a plan is displayed (see renderPlan) rather than stored anywhere,
  // so it's always exactly as current as Strava itself. Best-effort: any
  // failure (not logged in, request error, nothing matches) just leaves
  // the schedule showing nothing extra — this is a nice-to-have overlay on
  // an already-complete, already-usable rendered plan, never something
  // that should surface as an error the user has to deal with.
  async function markCompletedSessionsFromStrava(plan) {
    if (!REQUIRE_LOGIN || !paceforgeAuth) return;

    let recentRuns;
    if (paceforgeAuth.isDummy()) {
      recentRuns = buildDummyRecentRuns();
    } else {
      const res = await fetch('/api/strava-summary');
      if (!res.ok) return;
      const summary = await res.json();
      recentRuns = summary.recentRuns;
    }
    if (!Array.isArray(recentRuns) || !recentRuns.length) return;

    // Group by date — a runner can log more than one activity on the same
    // day (a shakeout jog + the main session, say), so pick whichever
    // same-day activity's distance is closest to what was actually
    // planned rather than just the first/last one Strava happens to list.
    const runsByDate = new Map();
    recentRuns.forEach(run => {
      if (!runsByDate.has(run.date)) runsByDate.set(run.date, []);
      runsByDate.get(run.date).push(run);
    });

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const recentCutoff = new Date(today);
    recentCutoff.setDate(recentCutoff.getDate() - RECENT_ANALYSIS_WINDOW_DAYS);

    // Collected while walking every matched day below (see the loop), then
    // resolved in one batch afterward — see upgradeRecentAnalysisWithSegmentPace.
    const upgradeCandidates = [];

    plan.weeks.forEach(week => {
      week.days.forEach(day => {
        if (day.type === 'rest' || !day.km) return;
        const dayDate = new Date(day.date);
        dayDate.setHours(0, 0, 0, 0);
        if (dayDate > today) return; // hasn't happened yet — nothing to match

        const key = dateKey(day.date);
        const candidates = runsByDate.get(key);
        if (!candidates || !candidates.length) return;

        let best = candidates[0];
        let bestDiff = Math.abs(best.km - day.km);
        candidates.slice(1).forEach(c => {
          const diff = Math.abs(c.km - day.km);
          if (diff < bestDiff) { best = c; bestDiff = diff; }
        });

        const row = planWeeksEl.querySelector(`tr[data-date="${key}"]`);
        if (!row) return;
        // Persisted on the day itself, not just this row's class — see
        // isCompleted in renderDayRow, which is what makes the swap
        // button/draggable stay suppressed across a later reRenderWeek
        // too (e.g. after swapping a *different* day the same week).
        day.isCompleted = true;
        row.classList.add('is-completed');
        row.removeAttribute('draggable');
        // This row was already rendered (with a swap button) before this
        // match was found — renderDayRow only knows to leave the button
        // off on days that were already isCompleted at render time, so a
        // day completed just now needs it torn out here instead.
        row.querySelector('.swap-day-btn')?.remove();
        const slot = row.querySelector('.completed-slot');
        if (slot) {
          slot.innerHTML = `<span class="completed-badge" title="Selesai — tercatat ${best.km} km di Strava">✅</span>`;
        }

        // Richer per-session analysis — actual distance/pace/duration from
        // the matched Strava activity, plus how that pace compares to what
        // this session was targeting — rendered into the placeholder row
        // renderDayRow already left right below this one (see analysisRow
        // there) rather than just leaving the ✅ badge to speak for itself.
        const analysisRow = planWeeksEl.querySelector(`tr.completed-analysis-row[data-analysis-date="${key}"]`);
        // The structure bar (interval/tempo breakdown), when present, is its
        // own sibling <tr> between the day row and the analysis row above —
        // tag it too so the whole session block (not just the day row
        // itself) picks up the completed styling, instead of the tint
        // stopping right at the structure bar underneath it.
        const structureRow = row.nextElementSibling?.classList.contains('structure-row') ? row.nextElementSibling : null;
        if (structureRow) structureRow.classList.add('is-completed');
        if (analysisRow) analysisRow.classList.add('is-completed');
        const analysisEl = analysisRow?.querySelector('.completed-analysis');
        if (analysisEl && best.km > 0 && best.movingTimeSec > 0) {
          renderCompletedRow(analysisEl, day, best);
          analysisRow.hidden = false;

          const targetKm = plannedHardSegmentKm(day.structure);
          if (targetKm && best.id && dayDate >= recentCutoff) {
            upgradeCandidates.push({ analysisEl, day, best, targetKm });
          }
        }
      });
    });

    if (upgradeCandidates.length) {
      upgradeRecentAnalysisWithSegmentPace(upgradeCandidates).catch(() => {});
    }

    // Every day.isCompleted flag this pass could set is now set — the
    // exact moment detectMissedWeek's numbers are trustworthy.
    renderMissedWeekBanner();
  }

  if (!REQUIRE_LOGIN) {
    // Login not wired up to a real backend yet — hide every trace of the
    // login UI (gate screen, header login/logout, MODE DUMMY badge) and go
    // straight to the form. Set REQUIRE_LOGIN back to true in
    // js/config.js once Strava login is ready; nothing else here needs to
    // change.
    const authBox = document.getElementById('authBox');
    const dummyBadge = document.getElementById('dummyBadge');
    if (authBox) authBox.hidden = true;
    if (dummyBadge) dummyBadge.hidden = true;
    showForm();
  } else if (paceforgeAuth) {
    paceforgeAuth.onAuthChange((user) => {
      if (user) {
        // Show loading (not the form) while checking for a saved plan —
        // a returning user with one goes straight from this to their
        // result, never seeing the empty form flash by first; showForm()
        // only runs once loadSavedPlanForUser confirms there isn't one.
        showLoading('Memuat training plan-mu...');
        loadSavedPlanForUser(user).then((loaded) => {
          if (!loaded) {
            showForm();
            prefillFromStrava();
          }
        });
      } else {
        showGate();
      }
    });
  } else {
    // PaceForgeAuth failed to initialize entirely (script error) — fail
    // safe by keeping the gate up rather than silently exposing the form.
    showGate();
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    clearError();

    const settings = gatherSettingsFromForm();
    if (!settings) return;

    await generateAndShowPlan(settings);
    if (REQUIRE_LOGIN) savePlanForCurrentUser(settings);
  });

  document.getElementById('printBtn').addEventListener('click', downloadPlanAsPdf);
  // Delegated (rows are rebuilt via innerHTML on every render/re-render,
  // see renderPlan/reRenderWeek) rather than bound per-button.
  planWeeksEl.addEventListener('click', (e) => {
    const btn = e.target.closest('.swap-day-btn');
    if (!btn) return;
    handleSwapDayClick(Number(btn.dataset.week), Number(btn.dataset.dow));
  });
  // Drag-and-drop day swap (desktop mouse only — see handleDayDragStart's
  // comment) — delegated the same way the click handler above is, since
  // every row is rebuilt via innerHTML on each render/re-render.
  planWeeksEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('tr[data-week]');
    if (!row) return;
    handleDayDragStart(e, Number(row.dataset.week), Number(row.dataset.dow));
  });
  planWeeksEl.addEventListener('dragend', (e) => {
    e.target.closest('tr[data-week]')?.classList.remove('is-dragging');
    planWeeksEl.querySelectorAll('.is-drag-over').forEach(el => el.classList.remove('is-drag-over'));
    dragWeek = null;
    dragDow = null;
  });
  planWeeksEl.addEventListener('dragover', (e) => {
    const row = e.target.closest('tr[data-week]');
    if (!row || dragWeek === null) return;
    e.preventDefault(); // required for 'drop' to fire on this element at all
    if (Number(row.dataset.week) === dragWeek) row.classList.add('is-drag-over');
  });
  planWeeksEl.addEventListener('dragleave', (e) => {
    e.target.closest('tr[data-week]')?.classList.remove('is-drag-over');
  });
  planWeeksEl.addEventListener('drop', (e) => {
    const row = e.target.closest('tr[data-week]');
    if (!row) return;
    handleDayDrop(e, Number(row.dataset.week), Number(row.dataset.dow));
  });
  feelingOffBtn.addEventListener('click', () => {
    feedbackPanel.hidden = !feedbackPanel.hidden;
    if (!feedbackPanel.hidden) feedbackNote.focus();
  });
  feedbackCancelBtn.addEventListener('click', closeFeedbackPanel);
  feedbackSubmitBtn.addEventListener('click', handleFeedbackSubmit);
  missedWeekApplyBtn.addEventListener('click', handleMissedWeekApply);
  missedWeekDismissBtn.addEventListener('click', handleMissedWeekDismiss);
  aiRetryBtn.addEventListener('click', async () => {
    aiRetryBtn.hidden = true;
    aiStatus.hidden = false;
    aiStatus.classList.remove('is-error');
    aiStatus.textContent = '✨ Meminta review dari Claude...';
    await reviewPlanWithAI();
    renderPlan(lastPlan);
    applyPendingAiReviewToDom();
  });
  document.getElementById('newPlanBtn').addEventListener('click', () => {
    resultSection.hidden = true;
    formSection.hidden = false;
    formSection.scrollIntoView({ behavior: 'smooth' });
    // The form up to now still holds whatever was last loaded (typically
    // the previously-saved plan's numbers) — refresh the Strava-derived
    // fields so starting a new plan reflects current training, not
    // whatever was true when that saved plan was first generated.
    if (REQUIRE_LOGIN) prefillFromStrava();
  });

  // Renders the 5-zone VDOT pace table into #paceLegend, using whichever
  // week is most relevant right now's own VDOT (week.weekVdot, computed by
  // planGenerator.js — see its own currentVdot/goalVdot comments) — the
  // SAME week (and so the exact same number) pickDefaultOpenWeek opens by
  // default: the week today falls inside, or week 1 if the plan hasn't
  // started yet, or the last week if it's already over. Used to show a
  // fixed "day the plan was generated" snapshot instead, which visibly
  // drifted from the schedule's own per-week "Zona Pace (VDOT ...)" badge
  // (see weekVdot()) as training progressed — this card now always agrees
  // with whichever week's badge it sits above/near. Silently renders
  // nothing if that's somehow unavailable/invalid rather than showing a
  // broken table.
  function renderPaceZones(meta, weeks, currentWeek) {
    const { formatDuration } = PaceForgeGenerator;
    const { paceZonesFromVDOT, formatPaceRange, ZONE_ORDER, ZONE_LABELS, ZONE_PCT_RANGES } = PaceForgeVDOT;

    const relevantWeekNumber = pickDefaultOpenWeek(weeks, currentWeek);
    const relevantWeek = weeks.find(w => w.weekNumber === relevantWeekNumber) || weeks[0];
    const vdot = relevantWeek ? relevantWeek.weekVdot : null;
    const sourceLabel = meta.recentRaceTimeSec && meta.recentRaceDistanceKm
      ? `Minggu ${relevantWeek.weekNumber} • dari waktu race terakhirmu (${formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km)`
      : `Minggu ${relevantWeek.weekNumber} • dari estimasi goal pace (belum ada data race terakhir)`;
    const zones = vdot ? paceZonesFromVDOT(vdot) : null;
    if (!zones) { paceLegend.innerHTML = ''; return; }

    paceLegend.innerHTML = `
      <div class="pace-zone-header">
        <span class="pace-zone-title">🎯 Zona Pace (VDOT ${vdot.toFixed(1)})</span>
        <span class="pace-zone-source">${sourceLabel} • per ${formatLongDate(relevantWeek.startDate)}</span>
      </div>
      <div class="table-scroll">
        <table class="pace-zone-table">
          <thead><tr><th>Zona</th><th>% VO2max</th><th>Pace /km</th></tr></thead>
          <tbody>
            ${ZONE_ORDER.map(key => {
              const [lo, hi] = ZONE_PCT_RANGES[key];
              const color = TYPE_COLORS[ZONE_TYPE_COLOR_KEY[key]] || TYPE_COLORS.easy;
              const paceText = formatPaceRange(zones[key].fastSec, zones[key].slowSec);
              return `
                <tr>
                  <td><span class="zone-name"><span class="zone-dot" style="background:${color}"></span>${ZONE_LABELS[key]}</span></td>
                  <td>${Math.round(lo * 100)}–${Math.round(hi * 100)}%</td>
                  <td><strong>${paceText}</strong></td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      </div>
      <p class="pace-zone-note">Dihitung pakai formula VDOT Jack Daniels (metodologi yang sama dipakai kalkulator seperti vdoto2.com)</p>
    `;
  }

  // Bar chart of every week's totalKm, colored by phase (reuses
  // PHASE_COLORS — the same colors already meaning that phase in each
  // week's accordion header, not a new palette) — the accordion below only
  // ever shows one week's total at a time, so without this a runner has
  // to expand all of them just to see the plan's overall base-build-peak-
  // taper shape.
  //
  // Plain flex/CSS bars, not SVG: an SVG viewBox stretched to the
  // container's width with preserveAspectRatio="none" (the first version
  // of this) scales X and Y by different factors, which distorts text —
  // fine for bars alone, but this chart needs the km value legible on
  // every bar without hovering, and distorted digits defeat that. Flex
  // items given a real pixel height inside a fixed-height track sidestep
  // that entirely, at the cost of needing JS instead of the SVG's own
  // coordinate math.
  function renderVolumeChart(weeks, currentWeek) {
    if (!weeks.length) { volumeChart.innerHTML = ''; return; }

    const maxKm = Math.max(...weeks.map(w => w.totalKm), 1);
    const trackHeight = 90;

    const cols = weeks.map(week => {
      const heightPx = Math.max(3, Math.round((week.totalKm / maxKm) * trackHeight));
      const color = PHASE_COLORS[week.phase] || 'var(--color-text-muted)';
      const isCurrent = currentWeek && week.weekNumber === currentWeek.weekNumber;
      // Rounded to a whole km for the always-visible label — the exact
      // figure (which can carry a .1-.9 decimal, see planGenerator's
      // totalKm) is still available in the hover title below, but doesn't
      // need to fight for space against a dozen other bars' labels.
      return `
        <div class="volume-chart-col${isCurrent ? ' is-current' : ''}" title="Minggu ${week.weekNumber} • ${week.phase} • ${week.totalKm} km">
          <span class="volume-chart-value">${Math.round(week.totalKm)}</span>
          <div class="volume-chart-track">
            <span class="volume-chart-fill" style="height:${heightPx}px;background:${color}"></span>
          </div>
          <span class="volume-chart-week-no">${week.weekNumber}</span>
        </div>
      `;
    }).join('');

    const peakWeek = weeks.reduce((max, w) => (w.totalKm > max.totalKm ? w : max), weeks[0]);
    // Spelled out in words, not just a highlighted bar — a lone highlight
    // in a row of a dozen near-identical bars is too easy to miss as "the
    // current week" versus, say, "the biggest week" or a rendering glitch.
    const currentNote = currentWeek ? ` • Sekarang: Minggu ${currentWeek.weekNumber}` : '';

    // Only lists phases this specific plan actually has (a short 5K block
    // may never see Cutback, for instance) rather than a fixed 6-item
    // legend that would otherwise mention phases nowhere in the chart.
    const phasesPresent = [...new Set(weeks.map(w => w.phase))];
    const legend = phasesPresent.map(phase => `
      <span class="volume-chart-legend-item">
        <span class="volume-chart-legend-dot" style="background:${PHASE_COLORS[phase] || 'var(--color-text-muted)'}"></span>${phase}
      </span>
    `).join('');

    volumeChart.innerHTML = `
      <div class="pace-zone-header">
        <span class="pace-zone-title">📈 Volume Mingguan (km)</span>
        <span class="pace-zone-source">Peak ${peakWeek.totalKm} km di minggu ${peakWeek.weekNumber}${currentNote}</span>
      </div>
      <div class="table-scroll"><div class="volume-chart-bars">${cols}</div></div>
      <div class="volume-chart-legend">${legend}</div>
    `;
  }

  function renderPlan(plan) {
    lastPlan = plan;
    const { meta, warnings, weeks } = plan;
    const { formatPace, formatDate, formatDuration, TYPE_LABELS } = PaceForgeGenerator;

    // Reset any AI notes from a previous plan — they don't apply to this one.
    aiStatus.hidden = true;
    aiStatus.textContent = '';
    aiStatus.classList.remove('is-error');
    aiRetryBtn.hidden = true;
    aiIntro.hidden = true;
    aiIntro.textContent = '';
    closeFeedbackPanel();
    // No separate reset for race-day tips (or the per-week AI notes further
    // below) needed — both get appended straight into a week-block's own
    // markup (see applyPendingAiReviewToDom), and planWeeksEl.innerHTML is
    // about to be fully rebuilt below anyway.

    // Warnings
    if (warnings.length) {
      resultWarning.innerHTML = warnings.map(w => `⚠️ ${w}`).join('<br><br>');
      resultWarning.hidden = false;
    } else {
      resultWarning.hidden = true;
    }

    // Summary — labels swap for a non-race plan (meta.mode/nonRaceStyle,
    // see planGenerator.js): "Race"/"Tanggal Race" don't apply when
    // raceDate is really just the block's own end date.
    const isNonRacePlan = meta.mode && meta.mode !== 'race';
    const raceCardLabel = !isNonRacePlan ? 'Race' : (meta.nonRaceStyle === 'maintenance' ? 'Maintenance' : 'Base Building');
    const dateCardLabel = !isNonRacePlan ? 'Tanggal Race' : 'Akhir Blok';
    summaryCards.innerHTML = `
      <div class="summary-item"><div class="label">${raceCardLabel}</div><div class="value">${meta.raceLabel}</div></div>
      <div class="summary-item"><div class="label">${dateCardLabel}</div><div class="value" style="font-size:1rem">${formatDate(meta.raceDate)}</div></div>
      <div class="summary-item"><div class="label">Durasi Plan</div><div class="value">${meta.planWeeks} minggu</div></div>
      <div class="summary-item"><div class="label">Peak Weekly Volume</div><div class="value">${meta.peakWeeklyKm} km</div></div>
      <div class="summary-item"><div class="label">Peak Long Run</div><div class="value">${meta.peakLongRunKm} km</div></div>
      <div class="summary-item"><div class="label">Goal Pace</div><div class="value">${formatPace(meta.goalPaceSec)}</div></div>
      ${meta.goalPaceSource === 'recentRace' ? `
      <div class="summary-item"><div class="label">Estimasi dari Race Terakhir</div><div class="value" style="font-size:1rem">${formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km &rarr; ${formatDuration(meta.predictedRaceTimeSec)} ${meta.raceLabel}</div></div>
      ` : ''}
    `;

    // Hoisted above renderVolumeChart/the weeks loop below — both need to
    // know which week is "now" (the chart to mark it, the loop to open it
    // by default and badge it).
    const currentWeek = findCurrentWeek(weeks);

    renderVolumeChart(weeks, currentWeek);

    // Zona Pace — full 5-zone VDOT table (Jack Daniels methodology, same
    // one popularized by calculators like vdoto2.com). Tracks whichever
    // week is relevant right now (see renderPaceZones) rather than a fixed
    // day-1 snapshot — this table is what the runner is meant to actually
    // train by week to week, so it needs to agree with THIS week's own
    // "Zona Pace (VDOT ...)" badge below, not describe a fitness level
    // that's already out of date once training has progressed.
    renderPaceZones(meta, weeks, currentWeek);

    // Weeks — each one collapses into just its header (phase/dates/total,
    // still scannable at a glance) so a long plan (a marathon block runs
    // 16+ weeks, each with a structure bar and now a completed-session
    // analysis card per day) doesn't dump its entire length on screen at
    // once. Only the week most relevant right now starts open; see
    // defaultOpenWeekNumber below for which one that is.
    const defaultOpenWeekNumber = pickDefaultOpenWeek(weeks, currentWeek);
    planWeeksEl.innerHTML = weeks.map(week => {
      const vdot = weekVdot(week);
      const vdotLine = vdot
        ? `<div class="week-vdot">🎯 Zona Pace (VDOT ${vdot.toFixed(1)}) per ${formatLongDate(week.startDate)}</div>`
        : '';
      const isOpen = week.weekNumber === defaultOpenWeekNumber;
      const currentWeekBadge = currentWeek && week.weekNumber === currentWeek.weekNumber
        ? '<span class="week-current-badge">Minggu saat ini</span>'
        : '';
      return `
      <details class="week-block" data-week-number="${week.weekNumber}"${isOpen ? ' open' : ''}>
        <summary class="week-header">
          <span class="week-title-group">
            <span class="week-title">Minggu ${week.weekNumber}</span>
            ${currentWeekBadge}
          </span>
          <span class="week-phase"><span class="phase-label" style="color:${PHASE_COLORS[week.phase] || 'inherit'}">${week.phase}</span> • ${formatDate(week.startDate)} – ${formatDate(week.endDate)}</span>
          <span class="week-total">Total: ${week.totalKm} km</span>
          <span class="week-toggle-icon" aria-hidden="true">▾</span>
        </summary>
        ${vdotLine}
        <div class="table-scroll">
          <table class="day-table">
            <thead>
              <tr><th>Hari</th><th>Tanggal</th><th>Sesi</th><th>Jarak</th><th>Pace Target</th></tr>
            </thead>
            <tbody>
              ${week.days.map(day => renderDayRow(day, week.weekNumber)).join('')}
            </tbody>
          </table>
        </div>
      </details>
    `;
    }).join('');

    loadingSection.hidden = true;
    resultSection.hidden = false;
    formSection.hidden = true;
    resultSection.scrollIntoView({ behavior: 'smooth' });

    // Best-effort, not awaited — the schedule above is already fully
    // rendered and usable without this; a completed-session checkmark
    // arriving a beat later (or not at all, if this fails) is a nice-to-
    // have overlay, never something the rest of the page should wait on.
    markCompletedSessionsFromStrava(plan).catch(() => {});
  }

  function hexToRgb(hex) {
    const v = hex.replace('#', '');
    return [parseInt(v.slice(0, 2), 16), parseInt(v.slice(2, 4), 16), parseInt(v.slice(4, 6), 16)];
  }

  // jsPDF's built-in fonts (Helvetica etc.) only cover the WinAnsi/cp1252
  // range — glyphs outside it (→, ⚠, 🏁, ✨, ...) don't throw, they just
  // silently render as the wrong character (→ came out as ↑, ⚠ as "&" in
  // testing). Anything going into doc.text()/autoTable cells is run
  // through this first instead of embedding a custom Unicode font.
  function pdfSafeText(str) {
    return String(str)
      .replace(/→/g, '->')
      .replace(/⚠️|⚠/g, '')
      .replace(/🏁/g, '')
      .replace(/✨/g, '')
      .trim();
  }

  // Builds the currently-shown plan into a proper structured A4 PDF — real
  // vector text and tables via jsPDF + jspdf-autotable, not a screenshot —
  // and downloads it directly, no browser print dialog involved. Mirrors
  // the on-screen report (header, summary, legends, per-week tables with
  // colored session badges and the interval/tempo structure bars) but laid
  // out for print: fixed A4 margins, table headers repeating on page
  // breaks, and week sections never starting right at the bottom edge of a
  // page.
  async function downloadPlanAsPdf() {
    if (!lastPlan || !window.jspdf || !window.jspdf.jsPDF) {
      alert('Fitur simpan PDF belum siap (library belum termuat). Coba muat ulang halaman.');
      return;
    }

    const btn = document.getElementById('printBtn');
    const originalLabel = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Menyiapkan PDF...';

    try {
      const { jsPDF } = window.jspdf;
      const { formatPace, formatDate, TYPE_LABELS } = PaceForgeGenerator;
      const { meta, warnings, weeks } = lastPlan;

      const doc = new jsPDF('p', 'pt', 'a4');
      const pageWidth = doc.internal.pageSize.getWidth();
      const pageHeight = doc.internal.pageSize.getHeight();
      const margin = 40;
      const usableWidth = pageWidth - margin * 2;
      const inkColor = [30, 34, 48];
      const mutedColor = [110, 116, 132];
      let y = margin;

      // --- Header -------------------------------------------------------
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(20);
      doc.setTextColor(...hexToRgb('#1f6f5c'));
      doc.text('PaceForge', margin, y);
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...mutedColor);
      doc.text('Training Plan Lari', margin, y + 14);

      doc.setFont('helvetica', 'bold');
      doc.setFontSize(13);
      doc.setTextColor(...inkColor);
      doc.text(meta.raceLabel, pageWidth - margin, y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(9.5);
      doc.setTextColor(...mutedColor);
      doc.text(`${meta.mode && meta.mode !== 'race' ? 'Block end' : 'Race day'}: ${formatDate(meta.raceDate)}`, pageWidth - margin, y + 14, { align: 'right' });

      y += 26;
      doc.setDrawColor(225, 228, 236);
      doc.line(margin, y, pageWidth - margin, y);
      y += 20;

      // --- Summary stats grid --------------------------------------------
      const summaryItems = [
        ['Durasi Plan', `${meta.planWeeks} minggu`],
        ['Peak Weekly Volume', `${meta.peakWeeklyKm} km`],
        ['Peak Long Run', `${meta.peakLongRunKm} km`],
        ['Goal Pace', formatPace(meta.goalPaceSec)],
      ];
      const summaryColW = usableWidth / summaryItems.length;
      summaryItems.forEach(([label, value], i) => {
        const x = margin + i * summaryColW;
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.3);
        doc.setTextColor(...mutedColor);
        doc.text(label.toUpperCase(), x, y);
        doc.setFont('helvetica', 'bold');
        doc.setFontSize(13.5);
        doc.setTextColor(...hexToRgb('#1f6f5c'));
        doc.text(value, x, y + 17);
      });
      y += 38;

      // --- Warnings -------------------------------------------------------
      if (warnings.length) {
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        const bodyText = warnings.map(w => `• ${pdfSafeText(w)}`).join('\n\n');
        const lines = doc.splitTextToSize(bodyText, usableWidth - 20);
        const warningLineHeight = 8.5 * 1.35;
        const boxHeight = lines.length * warningLineHeight + 16;
        doc.setFillColor(255, 247, 224);
        doc.setDrawColor(230, 190, 110);
        doc.roundedRect(margin, y, usableWidth, boxHeight, 4, 4, 'FD');
        doc.setTextColor(140, 92, 12);
        doc.text(lines, margin + 10, y + 13, { lineHeightFactor: 1.35 });
        y += boxHeight + 18;
      }

      // --- Zona Pace (VDOT) table -----------------------------------------
      // Mirrors the on-screen "Zona Pace" table (see renderPaceZones) —
      // same relevant-week VDOT (week.weekVdot, whichever week today falls
      // inside, or week 1/the last week before/after the block) and same 5
      // Daniels training zones, so the PDF and on-screen result stay
      // consistent with each other.
      {
        const { paceZonesFromVDOT, formatPaceRange, ZONE_ORDER, ZONE_LABELS, ZONE_PCT_RANGES } = PaceForgeVDOT;
        const relevantWeekNumber = pickDefaultOpenWeek(weeks, findCurrentWeek(weeks));
        const relevantWeek = weeks.find(w => w.weekNumber === relevantWeekNumber) || weeks[0];
        const vdot = relevantWeek ? relevantWeek.weekVdot : null;
        const zoneSourceLabel = meta.recentRaceTimeSec && meta.recentRaceDistanceKm
          ? `Minggu ${relevantWeek.weekNumber} • dari waktu race terakhir (${PaceForgeGenerator.formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km)`
          : `Minggu ${relevantWeek.weekNumber} • dari estimasi goal pace (belum ada data race terakhir)`;
        const zones = vdot ? paceZonesFromVDOT(vdot) : null;
        if (zones) {
          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(...inkColor);
          doc.text(`Zona Pace (VDOT ${vdot.toFixed(1)})`, margin, y);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...mutedColor);
          doc.text(pdfSafeText(`${zoneSourceLabel} • per ${formatLongDate(relevantWeek.startDate)}`), margin, y + 12);
          y += 18;

          // Zone name cells get a left inset (see columnStyles below) so
          // didDrawCell can paint a small color dot into that gap — same
          // color key (ZONE_TYPE_COLOR_KEY) used by the on-screen table's
          // dots, keeping the two visually consistent.
          const zoneRowOrder = ZONE_ORDER;
          doc.autoTable({
            startY: y,
            margin: { left: margin, right: margin },
            head: [['Zona', '% VO2max', 'Pace /km']],
            body: zoneRowOrder.map(key => {
              const [lo, hi] = ZONE_PCT_RANGES[key];
              const paceText = formatPaceRange(zones[key].fastSec, zones[key].slowSec);
              return [ZONE_LABELS[key], `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`, paceText];
            }),
            theme: 'grid',
            styles: { font: 'helvetica', fontSize: 8.3, cellPadding: 5, textColor: inkColor, lineColor: [225, 228, 236], lineWidth: 0.5 },
            headStyles: { fillColor: [245, 246, 248], textColor: mutedColor, fontStyle: 'bold', fontSize: 7.2 },
            columnStyles: { 0: { cellWidth: 150, cellPadding: { left: 16, top: 5, right: 5, bottom: 5 } }, 1: { cellWidth: 100 }, 2: { cellWidth: 'auto' } },
            didDrawCell: (data) => {
              if (data.section !== 'body' || data.column.index !== 0) return;
              const key = zoneRowOrder[data.row.index];
              const color = TYPE_HEX[ZONE_TYPE_COLOR_KEY[key]] || TYPE_HEX.easy;
              doc.setFillColor(...hexToRgb(color));
              doc.circle(data.cell.x + 8, data.cell.y + data.cell.height / 2, 3, 'F');
            },
          });
          y = doc.lastAutoTable.finalY + 8;

          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.3);
          doc.setTextColor(...mutedColor);
          const noteLines = doc.splitTextToSize(
            'Dihitung pakai formula VDOT Jack Daniels (metodologi yang sama dipakai kalkulator seperti vdoto2.com)',
            usableWidth
          );
          doc.text(noteLines, margin, y);
          y += noteLines.length * 7.3 * 1.35 + 14;
        }
      }

      // --- Per-week tables --------------------------------------------------
      weeks.forEach((week) => {
        // Keep a week's heading from landing right at the bottom edge with
        // no room for its table underneath.
        if (y > pageHeight - 130) { doc.addPage(); y = margin; }

        doc.setFont('helvetica', 'bold');
        doc.setFontSize(12);
        doc.setTextColor(...inkColor);
        doc.text(`Minggu ${week.weekNumber}`, margin, y);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(8.5);
        doc.setTextColor(...mutedColor);
        doc.text(`${week.phase} • ${formatDate(week.startDate)} – ${formatDate(week.endDate)}`, margin + 78, y);
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(...hexToRgb('#6366f1'));
        doc.text(`Total: ${week.totalKm} km`, pageWidth - margin, y, { align: 'right' });
        y += 14;

        // Same per-week "Zona Pace (VDOT ...)" line as the on-screen
        // result (see weekVdot()) — the VDOT figure climbing week to week.
        const vdot = weekVdot(week);
        if (vdot) {
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(7.6);
          doc.setTextColor(...mutedColor);
          doc.text(pdfSafeText(`Zona Pace (VDOT ${vdot.toFixed(1)}) per ${formatLongDate(week.startDate)}`), margin, y);
          y += 12;
        }

        const rowMeta = [];
        const body = [];
        week.days.forEach(day => {
          const displayKey = restDisplayKey(day);
          const label = pdfSafeText((day.type === 'longRun' && day.isMarathonSpecific)
            ? `${TYPE_LABELS.longRun} (Pace ${day.structure?.paceLabel || 'Marathon'})`
            : (TYPE_LABELS[displayKey] || displayKey));
          const km = day.km ? `${day.km} km` : '—';
          // Shared with renderDayRow (see paceTargetLabel) so the PDF's
          // Pace Target column matches the on-screen result exactly.
          const zone = zoneForDay(day);
          const pace = paceTargetLabel(day, zone);
          body.push([day.dayName, day.date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }), label, km, pace]);
          // type here is the display key (see restDisplayKey) so the cell
          // color below (TYPE_HEX[rowInfo.type]) picks up the same
          // weekday-rest-vs-weekend-rest distinction as the on-screen
          // badge — every other type passes through unchanged, and the
          // rowInfo.type === 'race' check further down still works since
          // restDisplayKey never touches non-rest types.
          rowMeta.push({ kind: 'day', type: displayKey });
          if (day.structure) {
            const { segments, caption } = structureToSegments(day.structure);
            body.push([{ content: '', colSpan: 5, styles: { minCellHeight: 30, fillColor: [255, 255, 255] } }]);
            rowMeta.push({ kind: 'structure', segments, caption, zone });
          }
        });

        doc.autoTable({
          startY: y,
          margin: { left: margin, right: margin, bottom: margin },
          head: [['Hari', 'Tanggal', 'Sesi', 'Jarak', 'Pace Target']],
          body,
          theme: 'grid',
          styles: { font: 'helvetica', fontSize: 8.3, cellPadding: 5, textColor: inkColor, lineColor: [225, 228, 236], lineWidth: 0.5, valign: 'middle' },
          headStyles: { fillColor: [245, 246, 248], textColor: mutedColor, fontStyle: 'bold', fontSize: 7.2 },
          columnStyles: { 0: { cellWidth: 58 }, 1: { cellWidth: 55 }, 2: { cellWidth: 150 }, 3: { cellWidth: 58 }, 4: { cellWidth: 'auto' } },
          didParseCell: (data) => {
            if (data.section !== 'body') return;
            const rowInfo = rowMeta[data.row.index];
            if (!rowInfo) return;
            if (rowInfo.kind === 'day' && data.column.index === 2) {
              data.cell.styles.fillColor = hexToRgb(TYPE_HEX[rowInfo.type] || TYPE_HEX.rest);
              data.cell.styles.textColor = [255, 255, 255];
              data.cell.styles.fontStyle = 'bold';
              data.cell.styles.halign = 'center';
            }
            if (rowInfo.kind === 'day' && (rowInfo.type === 'race' || rowInfo.type === 'evaluation')) {
              data.cell.styles.fontStyle = data.cell.styles.fontStyle || 'bold';
              if (data.column.index !== 2) data.cell.styles.fillColor = [232, 234, 253];
            }
          },
          didDrawCell: (data) => {
            if (data.section !== 'body') return;
            const rowInfo = rowMeta[data.row.index];
            if (!rowInfo || rowInfo.kind !== 'structure') return;
            drawStructureBar(doc, data.cell, rowInfo.segments, rowInfo.caption, rowInfo.zone, mutedColor);
          },
        });

        y = doc.lastAutoTable.finalY + 22;
      });

      // --- Footer (page numbers) on every page ---------------------------
      const pageCount = doc.internal.getNumberOfPages();
      for (let p = 1; p <= pageCount; p++) {
        doc.setPage(p);
        doc.setFont('helvetica', 'normal');
        doc.setFontSize(7.5);
        doc.setTextColor(...mutedColor);
        doc.text(`PaceForge • Halaman ${p} dari ${pageCount}`, pageWidth - margin, pageHeight - 18, { align: 'right' });
      }

      const fileSafeLabel = (meta.raceLabel || 'Plan').replace(/[^\w]+/g, '-');
      doc.save(`PaceForge-${fileSafeLabel}.pdf`);
    } catch (err) {
      alert(`Gagal membuat PDF: ${err.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  }

  // Draws the warm up / work / recovery / cool down bar for one structured
  // workout directly inside its autoTable cell, proportional to distance —
  // the PDF equivalent of renderWorkoutStructure()'s HTML bar. Colored by
  // `zone` (this day's VDOT zone, see zoneForDay) via roleColorHex the same
  // way the HTML bar uses roleColorCss.
  function drawStructureBar(doc, cell, segments, caption, zone, mutedColor) {
    const padX = 6;
    const barX = cell.x + padX;
    const barY = cell.y + 6;
    const barWidth = cell.width - padX * 2;
    const barHeight = 9;
    const gap = 1.2;
    const total = Math.max(segments.reduce((s, seg) => s + Math.max(seg.km, 0.05), 0), 0.05);
    const n = segments.length;
    let x = barX;
    segments.forEach((seg, i) => {
      const w = Math.max((Math.max(seg.km, 0.05) / total) * (barWidth - gap * (n - 1)), 1.5);
      doc.setFillColor(...hexToRgb(roleColorHex(seg.role, zone)));
      doc.roundedRect(x, barY, w, barHeight, 1.5, 1.5, 'F');
      x += w + gap;
    });
    if (caption) {
      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.3);
      doc.setTextColor(...mutedColor);
      doc.text(pdfSafeText(caption), barX, barY + barHeight + 10, { maxWidth: barWidth });
    }
  }

  // Which session types Claude is allowed to suggest an adjustment for —
  // never longRun/race/shakeout, matching the server-side prompt's own
  // instruction (defense in depth: even if the prompt is ignored, this
  // still refuses to touch those). MAX_AI_ADJUSTMENTS caps how many
  // sessions a single review can touch, regardless of how many Claude
  // returns.
  const AI_ADJUSTABLE_TYPES = new Set(['easy', 'recovery', 'tempo', 'interval', 'repetition', 'fartlek', 'marathonPace']);
  const MAX_AI_ADJUSTMENTS = 5;

  // Applies Claude's suggested per-day distance adjustments to an
  // already-generated rule-based plan, IN PLACE. Claude's numbers are
  // advisory only — never trusted outright: at most MAX_AI_ADJUSTMENTS
  // sessions, never long run/race/shakeout, and every survivor clamped to
  // within ~20% of its original rule-based distance and to the same
  // absolute ceiling the generator itself enforces for that type
  // (PaceForgeGenerator.MAX_REPETITION_SESSION_KM for repetition,
  // plan.meta.maxSupportKm — this plan's race-appropriate ceiling, see
  // RACE_PROFILES in planGenerator.js — for everything else) either way.
  function applyAiAdjustments(plan, adjustments) {
    if (!Array.isArray(adjustments) || !adjustments.length) return;
    const { buildSimpleStructure, buildIntervalStructure, buildTempoStructure, buildRepetitionStructure, buildFartlekStructure, MAX_REPETITION_SESSION_KM } = PaceForgeGenerator;
    const maxSupportKm = plan.meta.maxSupportKm;

    let appliedCount = 0;
    const touchedWeeks = new Set();
    for (const adj of adjustments) {
      if (appliedCount >= MAX_AI_ADJUSTMENTS) break;
      if (!adj || typeof adj.week !== 'number' || typeof adj.dow !== 'number') continue;
      const week = plan.weeks.find(w => w.weekNumber === adj.week);
      if (!week) continue;
      const day = week.days.find(d => d.dow === adj.dow);
      if (!day || day.type !== adj.type || !AI_ADJUSTABLE_TYPES.has(day.type)) continue;

      const suggested = Number(adj.suggestedKm);
      if (!Number.isFinite(suggested) || suggested <= 0) continue;
      const sessionCap = day.type === 'repetition' ? MAX_REPETITION_SESSION_KM : maxSupportKm;
      const clamped = Math.min(Math.max(suggested, day.km * 0.8), day.km * 1.2, sessionCap);
      const rounded = Math.round(clamped * 2) / 2;
      if (rounded === day.km) continue;

      day.km = rounded;
      // day.workoutVariant, day.paceSecPerKm and day.recoveryPaceSecPerKm
      // (all set by the generator for interval/tempo/repetition — see
      // planGenerator.js) are preserved as-is here so an AI distance tweak
      // doesn't silently reset e.g. a "short reps" interval week back to
      // the default variant, or its recovery jog back to a different
      // week's pace. buildIntervalStructure/buildRepetitionStructure may
      // still re-resolve workoutVariant against day.paceSecPerKm if it no
      // longer fits that variant's duration cap (see planGenerator.js).
      if (day.type === 'interval') {
        const built = buildIntervalStructure(day.km, lastFitnessLevel, lastConservativeMode, day.workoutVariant, day.paceSecPerKm, day.recoveryPaceSecPerKm);
        day.workoutVariant = built.resolvedVariant;
        day.structure = built.structure;
      } else if (day.type === 'tempo') {
        day.structure = buildTempoStructure(day.km, day.workoutVariant, day.recoveryPaceSecPerKm);
      } else if (day.type === 'repetition') {
        const built = buildRepetitionStructure(day.km, day.workoutVariant, day.paceSecPerKm, day.recoveryPaceSecPerKm);
        day.workoutVariant = built.resolvedVariant;
        day.structure = built.structure;
      } else if (day.type === 'fartlek') {
        day.structure = buildFartlekStructure(day.km, day.paceSecPerKm, day.recoveryPaceSecPerKm);
      } else {
        day.structure = buildSimpleStructure(day.km);
      }

      appliedCount++;
      touchedWeeks.add(week);
    }

    touchedWeeks.forEach(week => {
      week.totalKm = Math.round(week.days.reduce((s, d) => s + (d.km || 0), 0) * 10) / 10;
    });
  }

  // Sends the full day-by-day plan (never just week totals — Claude needs
  // to see each session's actual distance to judge whether it's realistic)
  // plus the user's free-text notes to the server, which asks Claude to (a)
  // optionally flag/adjust a handful of individual non-long-run sessions
  // that look unrealistic and (b) write qualitative coaching notes. Mutates
  // lastPlan in place via applyAiAdjustments with whatever survives
  // validation, and stashes the rest of the result in
  // pendingAiNotes/aiReviewErrorMessage rather than touching the DOM
  // directly — this runs BEFORE the plan's first render (see
  // generateAndShowPlan), and again on retry (after render), so the DOM
  // update has to happen from a shared spot both callers use
  // (applyPendingAiReviewToDom, right after their own renderPlan() call).
  async function reviewPlanWithAI() {
    pendingAiNotes = null;
    aiReviewErrorMessage = null;
    if (!lastPlan) return;

    const { meta, weeks } = lastPlan;
    const { formatPace } = PaceForgeGenerator;

    const payload = {
      // See api/enhance-plan.js's system prompt for what these change —
      // raceLabel/raceDate stay in the payload either way (a non-race plan
      // reuses them as "gaya latihan"/akhir blok, same as the generator
      // itself does), the prompt is what reinterprets them per mode.
      mode: meta.mode,
      nonRaceStyle: meta.nonRaceStyle,
      raceLabel: meta.raceLabel,
      raceDate: meta.raceDate.toISOString().slice(0, 10),
      fitnessLevel: lastFitnessLevel,
      planWeeks: meta.planWeeks,
      peakWeeklyKm: meta.peakWeeklyKm,
      peakLongRunKm: meta.peakLongRunKm,
      goalPace: formatPace(meta.goalPaceSec),
      conservativeMode: !!lastConservativeMode,
      userNotes: userNotesInput.value.trim(),
      weeks: weeks.map(w => ({
        week: w.weekNumber,
        phase: w.phase,
        totalKm: w.totalKm,
        days: w.days.filter(d => d.km > 0).map(d => ({ dow: d.dow, type: d.type, km: d.km })),
      })),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch('/api/enhance-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server merespons status ${res.status}`);
      applyAiAdjustments(lastPlan, data.adjustments);
      pendingAiNotes = data;
    } catch (err) {
      aiReviewErrorMessage = err.name === 'AbortError' ? 'waktu tunggu review habis (20 detik)' : err.message;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  // Reads whatever reviewPlanWithAI() left behind and updates the AI-notes
  // DOM accordingly — always called right after a renderPlan() call, since
  // renderPlan() itself resets that DOM to a blank slate first.
  function applyPendingAiReviewToDom() {
    if (pendingAiNotes) {
      const data = pendingAiNotes;
      if (data.intro) {
        aiIntro.textContent = data.intro;
        aiIntro.hidden = false;
      }
      if (Array.isArray(data.weeklyNotes)) {
        data.weeklyNotes.forEach(({ week, note }) => {
          if (!note) return;
          const block = planWeeksEl.querySelector(`.week-block[data-week-number="${week}"]`);
          if (!block) return;
          const noteEl = document.createElement('div');
          noteEl.className = 'week-ai-note';
          noteEl.textContent = note;
          block.appendChild(noteEl);
        });
      }
      // Appended into the race week's own block (last in lastPlan.weeks) —
      // race-day pacing/nutrition/mental advice belongs with race week
      // itself, not floating in its own card below the entire schedule
      // where it reads as disconnected from the week it's actually about.
      if (data.raceDayTips && lastPlan?.weeks.length) {
        const raceWeekNumber = lastPlan.weeks[lastPlan.weeks.length - 1].weekNumber;
        const block = planWeeksEl.querySelector(`.week-block[data-week-number="${raceWeekNumber}"]`);
        if (block) {
          const isNonRacePlan = lastPlan.meta.mode && lastPlan.meta.mode !== 'race';
          const tipsTitle = isNonRacePlan ? 'Tips Minggu Evaluasi' : 'Tips Race Day';
          const tipsEl = document.createElement('div');
          tipsEl.className = 'week-race-tips';
          tipsEl.innerHTML = `<span class="ai-tips-title">${tipsTitle}</span>${data.raceDayTips}`;
          block.appendChild(tipsEl);
        }
      }
      aiStatus.hidden = false;
      aiStatus.classList.remove('is-error');
      aiStatus.textContent = '✨ Plan sudah ditinjau & diberi catatan oleh Claude.';
    } else if (aiReviewErrorMessage) {
      aiStatus.hidden = false;
      aiStatus.classList.add('is-error');
      aiStatus.textContent = `Gagal minta review AI: ${aiReviewErrorMessage}. Plan dasar (rule-based) di atas tetap berlaku.`;
      aiRetryBtn.hidden = false;
    }
  }

  function renderDayRow(day, weekNumber) {
    const { formatDate, TYPE_LABELS } = PaceForgeGenerator;
    const isRest = day.type === 'rest';
    // 'evaluation' is treated identically to 'race' below (same pinned-to-
    // a-real-date reasoning as attemptDaySwap's own guard) — kept named
    // isRace since it still drives the 'is-race' CSS class either way.
    const isRace = day.type === 'race' || day.type === 'evaluation';
    // Set by markCompletedSessionsFromStrava once a matching Strava
    // activity is found for this date — persisted on the day itself
    // (not just a DOM class) so it survives a reRenderWeek (e.g. after
    // swapping a *different* day the same week) and so attemptDaySwap
    // below can check it directly.
    const isCompleted = !!day.isCompleted;
    const isSwapSelected = !!swapSelection && swapSelection.week === weekNumber && swapSelection.dow === day.dow;
    const rowClass = [isRest ? 'is-rest' : (isRace ? 'is-race' : ''), isSwapSelected ? 'is-swap-selected' : '', isCompleted ? 'is-completed' : ''].filter(Boolean).join(' ');
    const displayKey = restDisplayKey(day);
    const label = (day.type === 'longRun' && day.isMarathonSpecific)
      ? `${TYPE_LABELS.longRun} (Pace ${day.structure?.paceLabel || 'Marathon'})`
      : (TYPE_LABELS[displayKey] || displayKey);
    const km = day.km ? `${day.km} km` : '—';
    // Pace Target names the VDOT zone this session trains at (Easy, Tempo,
    // Interval, Repetition, Marathon) instead of that week's specific pace
    // number — the number ramps week to week (see planGenerator.js's
    // weekPaces) and changes for every plan anyway, while the zone itself
    // is the stable, memorable thing to internalize ("today is an Interval
    // day"). Race day gets its own label since goal race pace doesn't
    // cleanly belong to one of the 5 training zones.
    const zone = zoneForDay(day);
    const pace = paceTargetLabel(day, zone);
    const color = TYPE_COLORS[displayKey] || 'var(--type-rest)';
    const structureRow = day.structure
      ? `<tr class="structure-row ${rowClass}"><td colspan="5">${renderWorkoutStructure(day.structure, zone)}</td></tr>`
      : '';
    // Populated (and unhidden) after the fact by markCompletedSessionsFromStrava
    // once it finds a matching Strava activity for this date — see there for
    // what actually goes in .completed-analysis. Rendered empty/hidden
    // upfront (rather than only added when a match exists) so that lookup
    // never has to touch innerHTML/re-render the row itself.
    const analysisRow = isRest ? '' : `<tr class="completed-analysis-row" data-analysis-date="${dateKey(day.date)}" hidden><td colspan="5"><div class="completed-analysis"></div></td></tr>`;
    // Race day and an already-completed day are never swappable (see
    // handleSwapDayClick/attemptDaySwap) — no button at all rather than a
    // disabled one, since there's nothing a click on it could ever do (a
    // completed day's distance/pace is a record of what you actually
    // ran, not a slot left to plan). The selected source day gets a
    // "cancel" affordance (✕) in place of the swap icon (⇄) instead of a
    // second button, so there's always exactly one control to reason
    // about per row.
    const swapDisabled = isRace || isCompleted;
    const swapBtn = swapDisabled ? '' : `<button type="button" class="swap-day-btn" data-week="${weekNumber}" data-dow="${day.dow}" title="${isSwapSelected ? 'Batal tukar' : 'Tukar dengan hari lain'}" aria-label="${isSwapSelected ? 'Batalkan pemilihan tukar hari' : `Tukar sesi hari ${day.dayName} dengan hari lain`}">${isSwapSelected ? '✕' : '⇄'}</button>`;
    // draggable is left off entirely for race day/a completed day
    // (matching swapBtn above — nothing a drag could ever do there
    // either), rather than draggable plus a drop handler that just
    // rejects it: HTML5 drag events don't fire at all on an element
    // without the attribute, so this is the one place that guard needs
    // to exist instead of three. (A completed day can still be dropped
    // *onto* — draggable only governs being picked up as the source —
    // which is why attemptDaySwap also checks isCompleted itself.)
    return `
      <tr class="${rowClass}" data-date="${dateKey(day.date)}" data-week="${weekNumber}" data-dow="${day.dow}"${swapDisabled ? '' : ' draggable="true"'}>
        <td>${day.dayName}</td>
        <td>${day.date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</td>
        <td><span class="type-badge" style="background:${color}">${label}</span><span class="completed-slot"></span></td>
        <td>${km}</td>
        <td>${pace}${swapBtn}</td>
      </tr>
      ${structureRow}
      ${analysisRow}
    `;
  }

  // Renders the warm up / work / recovery / cool down breakdown for a
  // workout as a proportional segmented bar, sized by DISTANCE (km) so it
  // lines up with the "Jarak" column — visual shorthand for "what does this
  // session actually feel like". Colored by role (see roleColorCss above),
  // not a separate low/moderate/high effort scale: a session's "hard"
  // segments (reps, tempo block) are colored by its own VDOT zone (Tempo/
  // Interval/Repetition/Marathon — matching the Zona Pace table's colors
  // and the Pace Target column's zone name), its warm up/cool down by the
  // Easy zone (green), and the jog-recovery between reps by its own fixed
  // gray (same as the "Recovery Run" session-type color) rather than
  // folded into either. A plain continuous run (easy/recovery/long run/
  // shakeout) renders as a single solid block in its own zone's color;
  // interval/tempo sessions break down into their segments.
  function formatKm(km) {
    return km < 1 ? `${Math.round(km * 1000)} m` : `${Math.round(km * 10) / 10} km`;
  }

  // Turns a day.structure object into plain { segments, caption } data —
  // shared by the HTML bar (renderWorkoutStructure, below) and the PDF bar
  // (drawStructureBar) so the two never drift apart. Each segment carries a
  // `role` ('work' | 'easy' | 'recovery') rather than a literal color,
  // since the two renderers need different color formats (CSS var vs. hex
  // for jsPDF) — each resolves role -> color itself via roleColorCss/
  // roleColorHex, using the day's own zone (see zoneForDay) for 'work'.
  // Recovery segments show their DURATION (recoverySec), not distance —
  // real interval recoveries are jogged/walked for a set time, not a set
  // distance (see buildRepsStructure in planGenerator.js for how
  // recoverySec still gets a km equivalent purely for the bar's width).
  function formatRecoveryDuration(sec) {
    return `${Math.round(sec)} detik`;
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
    } else {
      // 'simple' — a single continuous block, no warm up/cool down split.
      segments = [{ label: 'Run', km: structure.km, role: 'work' }];
    }
    return { segments, caption };
  }

  function renderWorkoutStructure(structure, zone) {
    const { segments, caption } = structureToSegments(structure);

    const bar = segments.map(seg => {
      const color = roleColorCss(seg.role, zone);
      const durationText = seg.durationLabel || formatKm(seg.km);
      return `<span class="structure-seg" style="flex-grow:${Math.max(seg.km, 0.05).toFixed(2)};background:${color}" title="${seg.label} • ${durationText}"></span>`;
    }).join('');

    return `
      <div class="workout-structure">
        <div class="structure-bar">${bar}</div>
        ${caption ? `<div class="structure-caption">${caption}</div>` : ''}
      </div>
    `;
  }
})();
