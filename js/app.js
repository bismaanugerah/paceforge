/**
 * PaceForge — app.js
 * Wires up the form, validates input, calls PaceForgeGenerator, renders results.
 */
(() => {
  // Session-labelling/description helpers — moved out to js/planText.js so
  // the calendar export (js/ics.js) can reuse them from Node too, where
  // there's no DOM and none of this file exists. Pulled in under their
  // original names so every call site below reads exactly as it did when
  // these lived here.
  const {
    restDisplayKey, zoneForDay, dayTypeLabel, paceTargetLabel,
    structureToSegments, formatKm,
  } = PaceForgePlanText;

  // Markup for one icon from the sprite at the top of index.html — a
  // helper rather than the same <svg><use> boilerplate spelled out at
  // every call site. Icons inherit currentColor, so they always match the
  // text they sit beside (see .icon in css/styles.css).
  const icon = (name) => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;

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
    // First-timer mode only — a run/walk session is easy-effort throughout
    // (see generateFirstTimerPlan in planGenerator.js), so it reuses the
    // Easy badge color rather than a new one, same reasoning as fartlek/
    // marathonPace above.
    runWalk: 'var(--type-easy)',
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
    runWalk: '#74b358',
  };

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

  // Whether a week has actually begun (its first day is today or earlier)
  // — the only weeks an "actual vs. planned" comparison means anything
  // for. A week entirely in the future has nothing run yet by definition,
  // so renderVolumeChart leaves it as the plain planned-only bar it's
  // always been rather than drawing a zero-height "actual" underneath it.
  function weekHasStarted(week) {
    const start = new Date(week.startDate);
    start.setHours(0, 0, 0, 0);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return start <= today;
  }

  // Sum of day.actualKm across a week — set by markCompletedSessionsFromStrava
  // once a day is matched to a real Strava activity (see there). A day with
  // no match yet contributes nothing, which is exactly "not run" rather
  // than an assumed zero-distance run, so this under-counts a week whose
  // Strava match hasn't been fetched yet rather than ever over-counting one.
  function weekActualKm(week) {
    return week.days.reduce((sum, d) => sum + (d.actualKm || 0), 0);
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
  const fitnessFieldset = document.getElementById('fitnessFieldset');
  const daysPerWeekInput = document.getElementById('daysPerWeek');
  const daysPerWeekOutput = document.getElementById('daysPerWeekOutput');
  const firstTimerDaysHint = document.getElementById('firstTimerDaysHint');
  const dayCheckboxes = document.getElementById('dayCheckboxes');
  const dayCountHint = document.getElementById('dayCountHint');
  const longRunDayField = document.getElementById('longRunDayField');
  const longRunDaySelect = document.getElementById('longRunDay');
  const recentRaceFieldset = document.getElementById('recentRaceFieldset');
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
  const backToPlanBtn = document.getElementById('backToPlanBtn');
  const loadingSection = document.getElementById('loadingSection');
  const loadingTitle = document.getElementById('loadingTitle');
  const resultSection = document.getElementById('resultSection');
  const resultWarning = document.getElementById('resultWarning');
  const summaryCards = document.getElementById('summaryCards');
  const volumeChart = document.getElementById('volumeChart');
  const paceLegend = document.getElementById('paceLegend');
  const todayCard = document.getElementById('todayCard');
  const planWeeksEl = document.getElementById('planWeeks');
  const resultNotice = document.getElementById('resultNotice');
  const resultNoticeText = document.getElementById('resultNoticeText');
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
  const blockHistorySection = document.getElementById('blockHistorySection');
  const blockHistoryChart = document.getElementById('blockHistoryChart');
  const blockHistoryList = document.getElementById('blockHistoryList');

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
  // dateKey (LOCAL calendar fields), not toISOString().slice(0,10) — see
  // dateKey's own comment. Matters concretely here: for any timezone ahead
  // of UTC (e.g. WIB/UTC+7), toISOString() reads a day EARLIER than the
  // runner's actual local "today" whenever local time is still before
  // midnight UTC (i.e. before 07:00 WIB) — a very real time of day for
  // someone opening this app first thing in the morning to plan today's
  // run. Was silently wrong for every one of this file's date defaults/
  // persistence points before this fix.
  raceDateInput.value = dateKey(defaultRaceDate);
  raceDateInput.min = dateKey(new Date(Date.now() + 24 * 3600 * 1000));

  // Default start date: today — the runner can push it later if they're
  // not starting right away. Can't be set in the past.
  const todayStr = dateKey(new Date());
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

  // `legend` here is the section's NAME only — the "1." / "2." prefix is
  // assigned at runtime by renumberFieldsets from whichever fieldsets are
  // actually visible for the current mode, so First-timer (which hides
  // sections 2 and 4 entirely) reads 1-2-3 instead of the 1-3-5 a
  // hardcoded number would leave behind.
  const GOAL_TYPE_COPY = {
    race: {
      legend: 'Detail Race',
      dateLabel: 'Tanggal race',
      hint: '',
    },
    baseBuilding: {
      legend: 'Detail Base Building',
      dateLabel: 'Akhir blok training',
      hint: 'Belum punya race? Sesi mingguannya fokus easy run + 1x lari santai di pace marathon per minggu (bukan tempo/interval kayak race prep) — murni buat naikkan mileage & aerobic base. Volume naik bertahap sepanjang blok, lalu berakhir di minggu evaluasi (deload + opsional time-trial), bukan hari race.',
    },
    maintenance: {
      legend: 'Detail Maintenance',
      dateLabel: 'Akhir blok training',
      hint: 'Cuma mau jaga fitness tanpa target race? Volume mingguan ditahan flat (tidak naik), dan sesi quality (tempo/interval) diselingi Fartlek secara berkala biar tidak monoton.',
    },
    firstTimer: {
      legend: 'Detail Program Pemula',
      dateLabel: 'Lulus (perkiraan)',
      hint: 'Belum pernah lari sama sekali? Program 9 minggu, 3 hari/minggu, run/walk interval yang makin panjang tiap minggu, diakhiri Time Trial 5K sungguhan di minggu terakhir. Tidak butuh data lari sebelumnya — mulai dari nol.',
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

  // Locked at exactly 3 for First-timer (see FIRST_TIMER_DAYS_PER_WEEK in
  // planGenerator.js) — not a preference, part of the program itself.
  const FIRST_TIMER_DAYS_PER_WEEK = 3;
  // 8 build weeks + 1 evaluation week (see FIRST_TIMER_PROGRAM in
  // planGenerator.js) — the actual generator derives every date from
  // startDate itself and never reads raceDateInput's value for this mode;
  // this only keeps the (disabled, display-only) field showing the right
  // "Lulus (perkiraan)" date so the runner isn't left staring at some
  // unrelated leftover date from whatever goalType was selected before.
  const FIRST_TIMER_TOTAL_DAYS = 9 * 7 - 1;

  function updateFirstTimerRaceDate() {
    if (getGoalType() !== 'firstTimer' || !startDateInput.value) return;
    const start = new Date(`${startDateInput.value}T00:00:00`);
    // dateKey (LOCAL calendar fields), not toISOString().slice(0,10) — the
    // latter reads UTC fields, which silently lands on the wrong calendar
    // day for any timezone ahead of UTC (e.g. WIB/UTC+7 rolls back a full
    // day). Caught live: Sep 4 + 62 days should read Nov 5, toISOString
    // showed Nov 4.
    raceDateInput.value = dateKey(new Date(start.getTime() + FIRST_TIMER_TOTAL_DAYS * 24 * 3600 * 1000));
  }
  startDateInput.addEventListener('input', updateFirstTimerRaceDate);

  // Numbers every VISIBLE fieldset's legend 1..n in document order, so the
  // section numbers a runner reads always run consecutively no matter which
  // sections the current mode hides (First-timer drops "Kondisi Saat Ini"
  // and "Waktu Race Terakhir" entirely; "Target Waktu Finish" is hidden for
  // everyone right now — see index.html). The unnumbered name is cached on
  // the legend itself the first time through so re-running this never
  // stacks a second prefix onto an already-numbered legend.
  function renumberFieldsets() {
    let n = 0;
    form.querySelectorAll('fieldset').forEach(fs => {
      const legend = fs.querySelector('legend');
      if (!legend) return;
      if (!legend.dataset.baseText) legend.dataset.baseText = legend.textContent.trim();
      if (fs.hidden) return;
      n += 1;
      legend.textContent = `${n}. ${legend.dataset.baseText}`;
    });
  }

  function updateGoalTypeUI() {
    const goalType = getGoalType();
    const isRace = goalType === 'race';
    const isFirstTimer = goalType === 'firstTimer';
    const copy = GOAL_TYPE_COPY[goalType];
    // Written to dataset (not textContent) because renumberFieldsets below
    // is what actually renders this legend — it reads baseText and prefixes
    // the section number onto it.
    raceFieldsetLegend.dataset.baseText = copy.legend;
    raceDateLabel.textContent = copy.dateLabel;
    goalTypeHint.textContent = copy.hint;

    // Whole fieldsets/fields First-timer has no use for at all — a total
    // beginner has no baseline mileage/recent race to report, no long run
    // (nothing in the program is a long run), and no volume/speedwork ramp
    // for conservativeMode to soften. Their underlying inputs are left
    // untouched (still whatever they last held) rather than cleared —
    // gatherSettingsFromForm simply never reads them for this mode (see its
    // own settings-building comment), same "hidden but harmless" approach
    // longRunDayField already uses.
    fitnessFieldset.hidden = isFirstTimer;
    recentRaceFieldset.hidden = isFirstTimer;
    longRunDayField.hidden = isFirstTimer;

    daysPerWeekInput.disabled = isFirstTimer;
    firstTimerDaysHint.hidden = !isFirstTimer;
    if (isFirstTimer) {
      daysPerWeekInput.value = String(FIRST_TIMER_DAYS_PER_WEEK);
      daysPerWeekInput.dispatchEvent(new Event('input', { bubbles: true }));
    }

    // Also display-only for First-timer — see updateFirstTimerRaceDate's
    // own comment for why the generator itself never reads this field's
    // value for this mode regardless.
    raceDateInput.disabled = isFirstTimer;
    updateFirstTimerRaceDate();

    // After every fieldset's own hidden flag above is settled, before the
    // isRace early-return below (which only touches .field divs, not
    // fieldsets, so it can't change the numbering).
    renumberFieldsets();

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
      dayCountHint.innerHTML = `${icon('check')} ${selected} hari dipilih.`;
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

  // `field` is the input the message is actually about. Marking and
  // focusing it is what makes a message pinned to the bottom of a
  // five-section form actionable — the text alone left the runner to work
  // out for themselves which of ~15 boxes it meant. Scrolls to the FIELD,
  // not the message: the message sits below the whole form, so scrolling
  // there would push the thing that needs fixing off screen.
  let erroredField = null;
  function showError(msg, field) {
    clearFieldError();
    formError.textContent = msg;
    formError.hidden = false;
    if (field) {
      erroredField = field;
      field.classList.add('has-error');
      field.setAttribute('aria-invalid', 'true');
      field.scrollIntoView({ behavior: 'smooth', block: 'center' });
      // preventScroll so focus() doesn't fight the smooth scroll above
      // with an instant jump of its own. A non-focusable container (the
      // day-chip group) just no-ops here and keeps the outline.
      field.focus({ preventScroll: true });
    } else {
      formError.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }
  function clearFieldError() {
    if (!erroredField) return;
    erroredField.classList.remove('has-error');
    erroredField.removeAttribute('aria-invalid');
    erroredField = null;
  }
  function clearError() {
    formError.hidden = true;
    formError.textContent = '';
    clearFieldError();
  }
  // Any edit anywhere in the form retires the current complaint — leaving
  // a stale red outline on a box the runner has already fixed is worse
  // than showing nothing.
  form.addEventListener('input', () => { if (erroredField) clearError(); });

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
    // First-timer is its own top-level `mode` (not a `nonRaceStyle`, unlike
    // baseBuilding/maintenance) — see planGenerator.js's generatePlan,
    // which dispatches it to a fully independent generator rather than
    // threading it through the shared race/non-race machinery those two
    // still reuse.
    const mode = goalType === 'race' ? 'race' : goalType === 'firstTimer' ? 'firstTimer' : 'nonRace';
    const nonRaceStyle = mode === 'nonRace' ? goalType : null;
    const isCustomDistance = getDistanceMode() === 'custom';
    let raceKey = raceDistanceSel.value;
    let raceDistanceKm = RACE_META[raceKey]?.km;
    // Non-race: describes what the mode actually DOES (shown verbatim in
    // the summary card/PDF header) rather than RACE_META's race-name label
    // — there's no user-chosen "style" to show any more (see
    // NON_RACE_DEFAULT_RACE_KEY), so showing "Medium Distance" here would
    // just be a confusing, unexplained constant.
    const NON_RACE_LABEL = { baseBuilding: 'Aerobic Base', maintenance: 'Flat Volume' };
    let raceLabel = mode === 'race' ? RACE_META[raceKey]?.label
      : mode === 'firstTimer' ? '5K Pemula'
      : NON_RACE_LABEL[nonRaceStyle];
    if (isCustomDistance) {
      raceKey = 'custom';
      raceDistanceKm = Number(customDistanceKm.value);
      raceLabel = `${raceDistanceKm} km`;
      if (!raceDistanceKm || raceDistanceKm <= 0) {
        showError('Masukkan jarak custom yang valid (dalam km).', customDistanceKm);
        return null;
      }
    }

    const dateNoun = mode === 'race' ? 'tanggal race' : 'tanggal akhir blok';
    if (!raceDateInput.value) { showError(`Pilih ${dateNoun} terlebih dahulu.`, raceDateInput); return null; }
    const raceDate = new Date(raceDateInput.value + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (raceDate <= today) { showError(`${dateNoun.charAt(0).toUpperCase()}${dateNoun.slice(1)} harus di masa depan.`, raceDateInput); return null; }

    if (!startDateInput.value) { showError('Pilih tanggal mulai training terlebih dahulu.', startDateInput); return null; }
    const startDate = new Date(startDateInput.value + 'T00:00:00');
    if (startDate < today) { showError('Tanggal mulai training tidak boleh di masa lalu.', startDateInput); return null; }
    if (startDate >= raceDate) { showError(`Tanggal mulai training harus sebelum ${dateNoun}.`, startDateInput); return null; }

    const currentWeeklyKm = Number(currentWeeklyKmInput.value);
    if (currentWeeklyKm < 0 || Number.isNaN(currentWeeklyKm)) {
      showError('Isi rata-rata jarak lari mingguan yang valid (boleh 0 jika baru mulai).', currentWeeklyKmInput);
      return null;
    }
    // Base Building past this volume has very little room left to actually
    // build toward (see planGenerator.js's own VOLUME_GAIN_PLATEAU_KM
    // warning, still shown as a fallback for a plan saved before this
    // block existed and later restored/regenerated outside this form) — a
    // hard stop here, not just a warning, since Maintenance is a strictly
    // better fit at this volume and there's no legitimate reason to talk a
    // user out of it.
    if (nonRaceStyle === 'baseBuilding' && currentWeeklyKm >= PaceForgeGenerator.VOLUME_GAIN_PLATEAU_KM) {
      showError(`Volume mingguanmu sekarang (${currentWeeklyKm} km) sudah di atas ${PaceForgeGenerator.VOLUME_GAIN_PLATEAU_KM} km — di titik ini Base Building nggak banyak lagi yang bisa dinaikkan, jadi mode Maintenance lebih pas buat kondisimu. Pilih "Maintenance" di atas untuk lanjut.`, goalTypeToggle);
      return null;
    }

    const longestRecentRunKm = Number(longestRecentRunKmInput.value);
    if (longestRecentRunKm < 0 || Number.isNaN(longestRecentRunKm)) {
      showError('Isi jarak lari terjauhmu dalam 3 bulan terakhir yang valid (boleh 0 jika baru mulai).', longestRecentRunKmInput);
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
      if (!recentRaceDistanceKm || recentRaceDistanceKm <= 0) { showError('Isi jarak race terakhir yang valid.', recentRaceDistanceSel.value === 'custom' ? recentRaceCustomKm : recentRaceDistanceSel); return null; }
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
      showError(`Jumlah hari yang dipilih (${preferredDays.length}) harus sama dengan jumlah hari latihan per minggu (${daysPerWeek}).`, dayCheckboxes);
      return null;
    }

    const longRunDay = longRunDaySelect.value !== '' ? Number(longRunDaySelect.value) : null;
    if (longRunDay === null || !preferredDays.includes(longRunDay)) {
      showError('Pilih hari untuk long run dari hari latihan yang sudah kamu tandai.', longRunDaySelect);
      return null;
    }

    let targetTimeSec = null;
    if (TARGET_TIME_FEATURE_ENABLED && hasTargetTime.checked) {
      if (getTargetMode() === 'pace') {
        const paceMin = Number(targetPaceMinutesInput.value) || 0;
        const paceSec = Number(targetPaceSecondsInput.value) || 0;
        const paceSecPerKm = paceMin * 60 + paceSec;
        if (paceSecPerKm <= 0) { showError('Isi target pace yang valid.', targetPaceMinutesInput); return null; }
        targetTimeSec = paceSecPerKm * raceDistanceKm;
      } else {
        const h = Number(targetHoursInput.value) || 0;
        const m = Number(targetMinutesInput.value) || 0;
        const s = Number(targetSecondsInput.value) || 0;
        targetTimeSec = h * 3600 + m * 60 + s;
      }
      if (targetTimeSec <= 0) { showError('Isi target waktu finish yang valid.', targetHoursInput); return null; }
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
    const goalTypeValue = !settings.mode || settings.mode === 'race' ? 'race'
      : settings.mode === 'firstTimer' ? 'firstTimer'
      : settings.nonRaceStyle;
    const goalTypeRadio = goalTypeToggle.querySelector(`input[value="${goalTypeValue}"]`);
    if (goalTypeRadio) goalTypeRadio.checked = true;
    updateGoalTypeUI();

    // Only meaningful in Race mode — non-race modes have no custom-distance
    // choice at all (see NON_RACE_DEFAULT_RACE_KEY), and updateGoalTypeUI
    // above already hid #distanceModeField/#presetDistanceField for them.
    // Unconditionally touching those fields' `hidden` here (the previous
    // behaviour) undid that hiding the moment a saved non-race plan was
    // restored — a real bug caught from a live screenshot, not hypothetical.
    const isCustom = goalTypeValue === 'race' && settings.raceKey === 'custom';
    if (goalTypeValue === 'race') {
      distanceModeToggle.querySelector(`input[value="${isCustom ? 'custom' : 'preset'}"]`).checked = true;
      presetDistanceField.hidden = isCustom;
      customDistanceField.hidden = !isCustom;
    }
    if (isCustom) {
      customDistanceKm.value = settings.raceDistanceKm;
    } else {
      raceDistanceSel.value = settings.raceKey;
    }

    raceDateInput.value = dateKey(settings.raceDate);
    // Plans saved before the start-date field existed won't have it —
    // fall back to today, same as the old implicit behaviour.
    startDateInput.value = settings.startDate
      ? dateKey(settings.startDate)
      : dateKey(new Date());

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
    // A genuine rolling-block transition — this call is about to replace
    // an already-generated plan (not a restore-on-login, and not one of
    // the in-place tweaks like day-swap/feedback/missed-week adjustment,
    // none of which ever re-run generatePlan or reach this function at
    // all), AND the block it's replacing has already ended. That combo is
    // what "the runner finished/moved past their previous block and is
    // starting the next one" actually looks like — editing an upcoming
    // plan's numbers and resubmitting does NOT count (raceDate is still in
    // the future), so it never spams plan_history with abandoned edits.
    // Snapshotted BEFORE lastPlan/lastSettings get overwritten below;
    // never awaited — a history-save failure must never block the new
    // plan the runner actually asked for.
    if (!restoring && lastPlan && lastSettings) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      if (lastSettings.raceDate < today) {
        archivePreviousBlock(lastPlan, lastSettings).catch(() => {});
      }
    }

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
    // Independent of this specific plan's own content (it's a cross-block
    // view), so it's fetched once per plan display rather than threaded
    // through renderPlan's own DOM-building — fire-and-forget, same
    // best-effort spirit as the archive call above.
    loadAndRenderBlockHistory().catch(() => {});
    return plan;
  }

  // Snapshots a just-superseded block into plan_history (see
  // api/plan-history.js) so loadAndRenderBlockHistory below has a rolling
  // trend to show. `plan`/`settings` here are the OLD block's — the
  // caller (generateAndShowPlan) calls this before overwriting lastPlan/
  // lastSettings with the new ones.
  async function archivePreviousBlock(plan, settings) {
    if (!paceforgeAuth) return;
    // Start/end VDOT (not peak) — only meaningful for Race mode: Base
    // Building/Maintenance keep VDOT nearly flat by design (same reasoning
    // that hides the Goal Pace card for non-race plans, see renderPlan),
    // so there's no genuine growth to report for them.
    const startVdot = settings.mode === 'race' ? weekVdot(plan.weeks[0]) || null : null;
    const endVdot = settings.mode === 'race' ? weekVdot(plan.weeks[plan.weeks.length - 1]) || null : null;
    const entry = {
      mode: settings.mode,
      nonRaceStyle: settings.nonRaceStyle || null,
      raceLabel: settings.raceLabel,
      raceDistanceKm: settings.raceDistanceKm,
      blockStart: dateKey(settings.startDate),
      blockEnd: dateKey(settings.raceDate),
      // Total km across every week in the block — sensible to compare
      // across different block TYPES (Race/Base Building/Maintenance),
      // unlike a single peak-week number that depends heavily on each
      // type's own volume-curve shape (see the schema.sql comment on
      // total_km for the fuller reasoning).
      totalKm: Math.round(plan.weeks.reduce((sum, w) => sum + (w.totalKm || 0), 0) * 10) / 10,
      startVdot,
      endVdot,
    };

    if (paceforgeAuth.isDummy()) {
      const raw = localStorage.getItem(DUMMY_PLAN_HISTORY_KEY);
      const parsed = raw ? JSON.parse(raw) : [];
      const history = Array.isArray(parsed) ? parsed : [];
      history.unshift({ id: `dummy-${Date.now()}`, ...entry });
      // Same cap as HISTORY_LIMIT in api/plan-history.js — keeps dummy mode's
      // behavior representative of the real one instead of growing forever.
      localStorage.setItem(DUMMY_PLAN_HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
      return;
    }

    await fetch('/api/plan-history', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...entry, settings }),
    });
  }

  // Fetches and renders the "Riwayat Blok" panel — hidden entirely until
  // the runner has at least one finished block (see archivePreviousBlock),
  // so a first-ever plan never shows an empty/awkward "no history yet" box.
  async function loadAndRenderBlockHistory() {
    if (!paceforgeAuth) { blockHistorySection.hidden = true; return; }

    let blocks;
    if (paceforgeAuth.isDummy()) {
      const raw = localStorage.getItem(DUMMY_PLAN_HISTORY_KEY);
      blocks = raw ? JSON.parse(raw) : [];
    } else {
      const res = await fetch('/api/plan-history');
      if (!res.ok) { blockHistorySection.hidden = true; return; }
      const data = await res.json();
      blocks = Array.isArray(data.blocks) ? data.blocks : [];
    }
    if (!blocks.length) { blockHistorySection.hidden = true; return; }

    // Sorted explicitly by blockEnd rather than trusted as-received — both
    // the real endpoint (order=block_end.desc) and dummy mode's unshift
    // already return newest-first in practice, but a chart silently
    // relying on that assumption would misorder itself the moment
    // anything ever violates it (a future edit, a data migration, ...).
    const byBlockEndDesc = blocks.slice().sort((a, b) => (a.blockEnd < b.blockEnd ? 1 : a.blockEnd > b.blockEnd ? -1 : 0));

    const { formatDate } = PaceForgeGenerator;
    // Chart reads oldest→newest (a trend line's natural direction); the
    // list below stays newest-first (most relevant block up top) — same
    // split convention renderVolumeChart's bars vs. the week accordion use.
    const chronological = byBlockEndDesc.slice().reverse();
    // Total km, not peak-week km — comparable across block TYPES (see
    // archivePreviousBlock's own comment on why).
    const maxKm = Math.max(...chronological.map(b => b.totalKm || 0), 1);
    // First-timer blocks (b.mode === 'firstTimer', b.nonRaceStyle === null)
    // fall into the same green as Base Building here — both are "building
    // aerobic capacity from a lower baseline" in spirit, and a 4th color
    // isn't worth it for what's already a 3-way distinction.
    const barColor = b => b.mode === 'race' ? 'var(--type-race)' : (b.nonRaceStyle === 'maintenance' ? 'var(--type-recovery)' : 'var(--type-easy)');

    const cols = chronological.map(b => {
      const heightPx = Math.max(3, Math.round(((b.totalKm || 0) / maxKm) * 90));
      // endVdot only exists for Race blocks (see archivePreviousBlock) —
      // the "(VDOT 40.0)" suffix simply doesn't appear for Base Building/
      // Maintenance bars rather than showing a meaningless "—".
      const vdotSuffix = b.endVdot ? ` (VDOT ${b.endVdot.toFixed(1)})` : '';
      const valueLabel = `${b.totalKm ?? '—'} km${vdotSuffix}`;
      return `
        <div class="volume-chart-col" title="${b.raceLabel} • ${formatDate(new Date(b.blockStart + 'T00:00:00'))} – ${formatDate(new Date(b.blockEnd + 'T00:00:00'))} • Total ${valueLabel}">
          <span class="volume-chart-value">${valueLabel}</span>
          <div class="volume-chart-track">
            <span class="volume-chart-fill" style="height:${heightPx}px;background:${barColor(b)}"></span>
          </div>
          <span class="volume-chart-week-no">${formatDate(new Date(b.blockEnd + 'T00:00:00'))}</span>
        </div>
      `;
    }).join('');

    blockHistoryChart.innerHTML = `
      <div class="pace-zone-header">
        <span class="pace-zone-title">${icon('trend')} Riwayat Blok</span>
        <span class="pace-zone-source">${blocks.length} blok selesai • total km per blok</span>
      </div>
      <div class="table-scroll"><div class="volume-chart-bars">${cols}</div></div>
    `;

    blockHistoryList.innerHTML = byBlockEndDesc.map(b => {
      const dateRange = `${formatDate(new Date(b.blockStart + 'T00:00:00'))} – ${formatDate(new Date(b.blockEnd + 'T00:00:00'))}`;
      const vdotPart = (b.startVdot && b.endVdot)
        ? ` · VDOT ${b.startVdot.toFixed(1)}→${b.endVdot.toFixed(1)} (${b.endVdot >= b.startVdot ? '+' : ''}${(b.endVdot - b.startVdot).toFixed(1)})`
        : '';
      return `
        <div class="block-history-row">
          <span class="block-history-label">${b.raceLabel}</span>
          <span class="block-history-meta">${dateRange} · Total ${b.totalKm ?? '—'} km${vdotPart}</span>
        </div>
      `;
    }).join('');

    blockHistorySection.hidden = false;
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
    // Only "Buat Plan Baru" over an existing plan has somewhere to go
    // back to — this path is a runner with no plan at all.
    backToPlanBtn.hidden = true;
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
  // Separate localStorage key from DUMMY_PLAN_KEY above — that one holds
  // only the current active block (overwritten on every save); this one is
  // an append-only array, the dummy-mode mirror of the real plan_history
  // table (see archivePreviousBlock/loadAndRenderBlockHistory below).
  const DUMMY_PLAN_HISTORY_KEY = 'paceforge_dummy_plan_history';

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
    // A swap inside this week can move today's session onto a different
    // day — the hero card at the top mirrors one of these rows, so it has
    // to be rebuilt from the same just-updated data.
    renderTodayCard(lastPlan);
  }

  // Replays a saved daySwaps list (see savePlanForCurrentUser/
  // loadSavedPlanForUser) against a just-regenerated lastPlan — restoring
  // a saved plan re-runs generatePlan() from settings rather than storing
  // the plan itself, so a manual day-swap has to be re-applied every time
  // rather than surviving in the regenerated data on its own.
  function applySavedDaySwaps(savedSwaps) {
    if (!Array.isArray(savedSwaps) || !savedSwaps.length || !lastPlan) return;
    const touchedWeeks = PaceForgePlanEdits.applyDaySwaps(lastPlan, savedSwaps);
    daySwaps = savedSwaps.slice();
    touchedWeeks.forEach(reRenderWeek);
  }


  // Replays a saved feedbackOverrides list against a just-regenerated
  // lastPlan — same reasoning as applySavedDaySwaps above: restoring a
  // saved plan re-runs generatePlan() from settings, which reproduces
  // none of a runner-approved override on its own.
  function applySavedFeedbackOverrides(savedOverrides) {
    if (!Array.isArray(savedOverrides) || !savedOverrides.length || !lastPlan) return;
    const touchedWeeks = PaceForgePlanEdits.applyFeedbackOverrides(lastPlan, savedOverrides, planEditOpts());
    feedbackOverrides = savedOverrides.slice();
    touchedWeeks.forEach(reRenderWeek);
  }

  // The two generator inputs js/planEdits.js needs but deliberately
  // doesn't hold itself (it's stateless so api/calendar.js can share it)
  // — kept in one place here so every call site passes the same thing.
  function planEditOpts() {
    return { fitnessLevel: lastFitnessLevel, conservativeMode: lastConservativeMode };
  }

  // Thin wrapper so the several direct callers below (the "feeling off"
  // flow, the missed-week re-plan) keep their original 3-argument shape
  // rather than each threading planEditOpts() through by hand.
  function applyFeedbackAdjustment(day, action, suggestedKm) {
    PaceForgePlanEdits.applyFeedbackAdjustment(day, action, suggestedKm, planEditOpts());
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
    missedWeekText.innerHTML = `${icon('alert')} Minggu ${info.missedWeek.weekNumber} lalu cuma kepakai ${ranKm} dari ${info.plannedKm} km rencana (${pct}% terlewat). Mau PaceForge sesuaikan volume minggu ${info.currentWeek.weekNumber} ini biar nggak lompat balik ke rencana semula?`;
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
    feedbackStatus.innerHTML = `${icon('sparkle')} Menyesuaikan jadwal...`;

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
      // `summary` is AI-written text, so it stays textContent — only the
      // app's own fallback sentence is safe to build as markup.
      if (summary) feedbackStatus.textContent = summary;
      else feedbackStatus.innerHTML = `${icon('check')} ${touchedWeeks.size} sesi disesuaikan.`;
    } else {
      feedbackStatus.classList.add('is-error');
      feedbackStatus.textContent = 'Nggak ada sesi yang perlu disesuaikan menurut catatan itu.';
    }
  }

  // A message slot inside one week's own block, used for everything the
  // day-swap flow needs to say. Deliberately not a banner at the top of
  // the page: by week 5 of a 12-week plan that banner is several screens
  // away from the swap button that triggered it, so the runner would get no
  // feedback they could actually see. At most one is ever open.
  //
  // With `confirm`, resolves true/false on the runner's answer — the
  // in-page stand-in for window.confirm(), which as a native modal reads
  // as a browser interruption rather than part of this plan, and on a
  // phone covers the very rows the question is about. `text` is always
  // app-authored copy, never user input.
  function clearWeekNotice() {
    planWeeksEl.querySelectorAll('.week-notice').forEach(el => el.remove());
  }

  function showWeekNotice(weekNumber, text, { isError = false, confirm = false } = {}) {
    clearWeekNotice();
    const block = planWeeksEl.querySelector(`.week-block[data-week-number="${weekNumber}"]`);
    if (!block) return Promise.resolve(false);
    const el = document.createElement('div');
    el.className = `week-notice${isError ? ' is-error' : ''}`;
    el.innerHTML = `<p>${text}</p>${confirm ? `
      <div class="week-notice-actions">
        <button type="button" class="btn btn-secondary btn-small" data-notice="ok">Lanjutkan</button>
        <button type="button" class="btn btn-ghost btn-small" data-notice="cancel">Batal</button>
      </div>` : ''}`;
    // After <summary> so it reads as part of this week's header rather
    // than floating loose above the day rows.
    block.querySelector('summary').insertAdjacentElement('afterend', el);
    if (!confirm) return Promise.resolve(false);
    el.querySelector('[data-notice="ok"]').focus();
    return new Promise(resolve => {
      el.addEventListener('click', (e) => {
        const action = e.target.closest('[data-notice]')?.dataset.notice;
        if (!action) return;
        el.remove();
        resolve(action === 'ok');
      });
    });
  }

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
  //
  // Async only because of the long-run confirmation below — every other
  // path still resolves immediately. Callers that care about the result
  // (handleSwapDayClick) await it; handleDayDrop fires and forgets, same
  // as it did when this was synchronous.
  async function attemptDaySwap(weekNumber, dowA, dowB) {
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
      showWeekNotice(weekNumber, isEvaluation
        ? 'Minggu evaluasi nggak bisa dipindah — itu tanggal akhir blok, bukan slot latihan.'
        : 'Race day nggak bisa dipindah — itu tanggal race sungguhan, bukan slot latihan.', { isError: true });
      return false;
    }
    // Backstops the UI-level guards in renderDayRow/markCompletedSessionsFromStrava
    // (no swap button, not draggable, on a day already marked completed) —
    // this is what actually rejects a swap attempted via a stale button
    // reference or a drop onto a completed row, which skips draggable
    // entirely but not being a valid drop *target*.
    if (dayA.isCompleted || dayB.isCompleted) {
      showWeekNotice(weekNumber, 'Sesi yang sudah kamu jalani nggak bisa ditukar lagi — datanya sudah tercatat dari Strava.', { isError: true });
      return false;
    }
    if (dayA.type === 'longRun' || dayB.type === 'longRun') {
      const proceed = await showWeekNotice(weekNumber, 'Ini bakal mindahin long run ke hari lain minggu ini. Lanjutkan?', { confirm: true });
      if (!proceed) return false;
    }
    clearWeekNotice();
    PaceForgePlanEdits.swapPlanDaySessions(dayA, dayB);
    daySwaps.push({ week: weekNumber, dowA, dowB });
    reRenderWeek(weekNumber);
    markCompletedSessionsFromStrava(lastPlan).catch(() => {});
    if (REQUIRE_LOGIN && lastSettings) savePlanForCurrentUser(lastSettings);
    return true;
  }

  // The prompt shown while a first day is picked and a second is still
  // pending. Until this existed, clicking swap only tinted a row — nothing
  // said a second click was expected, so the half-finished state read as
  // "the button did nothing".
  function promptForSwapPartner(weekNumber, dow) {
    const week = lastPlan.weeks.find(w => w.weekNumber === weekNumber);
    const dayName = week?.days.find(d => d.dow === dow)?.dayName || 'hari itu';
    showWeekNotice(weekNumber, `Pilih hari lain di minggu ini untuk ditukar dengan <strong>${dayName}</strong> — atau klik ✕ di baris itu lagi untuk batal.`);
  }

  async function handleSwapDayClick(weekNumber, dow) {
    if (!lastPlan) return;
    if (!swapSelection) {
      swapSelection = { week: weekNumber, dow };
      reRenderWeek(weekNumber);
      promptForSwapPartner(weekNumber, dow);
      return;
    }
    const sourceWeek = swapSelection.week;
    const sourceDow = swapSelection.dow;
    if (sourceWeek === weekNumber && sourceDow === dow) {
      swapSelection = null;
      reRenderWeek(weekNumber);
      clearWeekNotice();
      return;
    }
    if (sourceWeek !== weekNumber) {
      swapSelection = { week: weekNumber, dow };
      reRenderWeek(sourceWeek);
      reRenderWeek(weekNumber);
      // Re-targeting to another week moves the prompt with it, rather
      // than leaving it stranded on the week no longer being swapped.
      promptForSwapPartner(weekNumber, dow);
      return;
    }
    swapSelection = null;
    if (!await attemptDaySwap(weekNumber, sourceDow, dow)) reRenderWeek(weekNumber);
  }

  // Drag-and-drop is the desktop-mouse path to the same swap the swap button
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
        // dateKey (LOCAL calendar fields), not toISOString() — see its own
        // comment. A real bug here: this used to shift raceDate/startDate
        // back a full day on every save for any timezone ahead of UTC
        // (e.g. WIB/UTC+7) — the very next loadSavedPlanForUser would then
        // restore a plan dated one day earlier than what was actually
        // generated, every single time.
        raceDate: dateKey(settings.raceDate),
        startDate: dateKey(settings.startDate),
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
      paceforgeAuth.setSyncStatus('Plan tersimpan (mode dummy — lokal di browser ini saja).');
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
      paceforgeAuth.setSyncStatus('Plan tersimpan ke akunmu.');
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
        startDate: new Date((data.settings.startDate || dateKey(new Date())) + 'T00:00:00'),
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
      paceforgeAuth.setSyncStatus('Plan terakhir dimuat (mode dummy — lokal).');
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
        startDate: new Date((data.settings.startDate || dateKey(new Date())) + 'T00:00:00'),
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
      paceforgeAuth.setSyncStatus('Plan terakhir dimuat dari akunmu.');
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
          ? 'Estimasi dari segmen tercepat di salah satu sesi larimu (bukan race resmi di Strava) — edit di bawah kalau kamu punya waktu race asli.'
          : 'Dari race yang kamu tandai di Strava.',
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
      paceforgeAuth.setSyncStatus('Sebagian field (km mingguan, lari terjauh, race terakhir, hari latihan) diisi otomatis dari data Strava-mu — cek dulu sebelum submit.', false, 'ai');
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
    analysisEl.innerHTML = `${icon('chart')} ${best.km} km${kmDiffLabel} &middot; ${paceLabel} &middot; ${formatDuration(best.movingTimeSec)}`;
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
      analysisEl.innerHTML = `${icon('chart')} ${best.km} km${kmDiffLabel} &middot; ${paceLabel} &middot; ${formatDuration(best.movingTimeSec)}`;
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
        // The Strava-matched activity's real distance, kept alongside the
        // planned day.km — this is what weekActualKm sums to drive the
        // "actual vs. planned" overlay in renderVolumeChart.
        day.actualKm = best.km;
        row.classList.add('is-completed');
        row.removeAttribute('draggable');
        // This row was already rendered (with a swap button) before this
        // match was found — renderDayRow only knows to leave the button
        // off on days that were already isCompleted at render time, so a
        // day completed just now needs it torn out here instead.
        row.querySelector('.swap-day-btn')?.remove();
        const slot = row.querySelector('.completed-slot');
        if (slot) {
          slot.innerHTML = `<span class="completed-badge" title="Selesai — tercatat ${best.km} km di Strava"></span>`;
        }

        // Richer per-session analysis — actual distance/pace/duration from
        // the matched Strava activity, plus how that pace compares to what
        // this session was targeting — rendered into the placeholder row
        // renderDayRow already left right below this one (see analysisRow
        // there) rather than just leaving the completed badge to speak for itself.
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

    // Every day.isCompleted/actualKm flag this pass could set is now set —
    // the exact moment detectMissedWeek's numbers are trustworthy, the
    // hero card can say whether today's session is already logged, and the
    // volume chart can draw the actual-vs-planned overlay (all three
    // rendered before any of this was known).
    renderTodayCard(plan);
    renderVolumeChart(plan.weeks, findCurrentWeek(plan.weeks));
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

  // In-page stand-in for alert() on the result actions (PDF export) — see
  // #resultNotice in index.html for why a native dialog was the wrong
  // shape for these. Sits directly under the buttons that raise it, so
  // unlike the swap messages (showWeekNotice) it's always already in view.
  function showResultNotice(text) {
    resultNoticeText.textContent = text;
    resultNotice.hidden = false;
  }
  document.getElementById('resultNoticeDismissBtn').addEventListener('click', () => {
    resultNotice.hidden = true;
  });

  document.getElementById('printBtn').addEventListener('click', downloadPlanAsPdf);

  const calendarPanel = document.getElementById('calendarPanel');
  const calendarUrlOut = document.getElementById('calendarUrlOut');
  const calendarSubscribeStatus = document.getElementById('calendarSubscribeStatus');
  document.getElementById('calendarBtn').addEventListener('click', () => {
    calendarPanel.hidden = !calendarPanel.hidden;
    if (!calendarPanel.hidden) calendarPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  document.getElementById('calendarCloseBtn').addEventListener('click', () => { calendarPanel.hidden = true; });
  document.getElementById('calendarSubscribeBtn').addEventListener('click', showCalendarSubscribeUrl);
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
    aiStatus.innerHTML = `${icon('sparkle')} Meminta review dari Claude...`;
    await reviewPlanWithAI();
    renderPlan(lastPlan);
    applyPendingAiReviewToDom();
  });
  document.getElementById('newPlanBtn').addEventListener('click', () => {
    resultSection.hidden = true;
    formSection.hidden = false;
    // Nothing is destroyed by getting here — the current plan is only
    // replaced once this form is actually submitted — but until this
    // button existed there was no way back to it short of reloading the
    // page, which made a mis-click feel like losing the plan.
    backToPlanBtn.hidden = !lastPlan;
    formSection.scrollIntoView({ behavior: 'smooth' });
    // The form up to now still holds whatever was last loaded (typically
    // the previously-saved plan's numbers) — refresh the Strava-derived
    // fields so starting a new plan reflects current training, not
    // whatever was true when that saved plan was first generated.
    if (REQUIRE_LOGIN) prefillFromStrava();
  });
  backToPlanBtn.addEventListener('click', () => {
    if (!lastPlan) return;
    clearError();
    formSection.hidden = true;
    resultSection.hidden = false;
    backToPlanBtn.hidden = true;
    resultSection.scrollIntoView({ behavior: 'smooth' });
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
        <span class="pace-zone-title">${icon('target')} Zona Pace (VDOT ${vdot.toFixed(1)})</span>
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

  // The hero at the top of the result: what this runner is doing TODAY,
  // spelled out before any of the whole-block context below it. Everything
  // else on this page answers "what does the block look like"; on an
  // ordinary morning the question is just "what's on for today", and
  // without this that answer sits several screens down, inside a week's
  // table, identified only by its date.
  //
  // Reads straight off lastPlan via the same label/color/zone/structure
  // helpers the day rows use (dayTypeLabel, zoneForDay, paceTargetLabel,
  // renderWorkoutStructure) rather than formatting its own copy of any of
  // it — so a swap, an AI adjustment or a Strava match can never leave the
  // card describing a different session than the row it mirrors.
  function renderTodayCard(plan) {
    if (!plan || !plan.weeks.length) { todayCard.hidden = true; return; }
    const { formatDate } = PaceForgeGenerator;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayKey = dateKey(today);

    // Weeks are in order and so are the days inside each one (see
    // planGenerator.js), so this flattening is just the plan read back as
    // one continuous calendar. Date keys are 'YYYY-MM-DD', which compares
    // correctly as plain strings — no Date math needed to order them.
    const entries = plan.weeks.flatMap(week => week.days.map(day => ({ week, day })));
    const lastDay = entries[entries.length - 1].day;
    // Block already finished (an old saved plan reopened after race day):
    // there's no "today" left in it to headline, and #blockHistorySection
    // further down is the part that's actually about a finished block.
    if (dateKey(lastDay.date) < todayKey) { todayCard.hidden = true; return; }

    const todayEntry = entries.find(e => dateKey(e.day.date) === todayKey);
    // Plan generated ahead of its own start date — headline the first real
    // session instead, with how long the wait is, rather than showing
    // nothing until the block happens to begin.
    const entry = todayEntry
      || entries.find(e => dateKey(e.day.date) > todayKey && e.day.km)
      || entries.find(e => dateKey(e.day.date) > todayKey);
    if (!entry) { todayCard.hidden = true; return; }

    const { day, week } = entry;
    const isFirstTimerPlan = plan.meta?.mode === 'firstTimer';
    const zone = zoneForDay(day);
    const label = dayTypeLabel(day, isFirstTimerPlan);
    const color = TYPE_COLORS[restDisplayKey(day)] || 'var(--type-rest)';

    const dayDate = new Date(day.date);
    dayDate.setHours(0, 0, 0, 0);
    const daysAway = Math.round((dayDate - today) / 86400000);
    const eyebrow = daysAway === 0 ? 'Hari ini'
      : daysAway === 1 ? 'Besok — sesi pertama'
      : `Sesi pertama — ${daysAway} hari lagi`;

    // A rest day is a legitimate answer to "what's on today", but on its
    // own it leaves the runner with nothing to plan around — so pair it
    // with whatever the next actual session is. Only for the day being
    // headlined; the rest of the plan is right below.
    const nextSession = entries.find(e => dateKey(e.day.date) > dateKey(day.date) && e.day.km);
    const nextLine = (!day.km && nextSession)
      ? `<p class="today-card-next">Berikutnya: <strong>${formatDate(nextSession.day.date)}</strong> · ${dayTypeLabel(nextSession.day, isFirstTimerPlan)}${nextSession.day.km ? ` · ${nextSession.day.km} km` : ''}</p>`
      : '';

    // "How far in am I, and how long is left" — neither was answerable
    // anywhere on this page before: the summary showed the target date as
    // a bare calendar date, and the week number only appeared as a label
    // on each accordion. Weeks rather than days once there's more than a
    // fortnight to go, since that's the unit the plan itself is built in.
    const totalWeeks = plan.weeks.length;
    const endDate = new Date(plan.meta.raceDate);
    endDate.setHours(0, 0, 0, 0);
    const daysLeft = Math.max(0, Math.round((endDate - today) / 86400000));
    const endNoun = plan.meta.mode === 'race' ? 'Race'
      : isFirstTimerPlan ? 'Lulus'
      : 'Akhir blok';
    const countdown = daysLeft === 0 ? `${endNoun} hari ini`
      : daysLeft <= 14 ? `${endNoun} ${daysLeft} hari lagi`
      : `${endNoun} ${Math.round(daysLeft / 7)} minggu lagi`;
    const progressPct = Math.round((week.weekNumber / totalWeeks) * 100);

    const progress = `
      <div class="today-card-progress">
        <div class="today-progress-track"><span class="today-progress-fill" style="width:${progressPct}%"></span></div>
        <p class="today-progress-label"><span>Minggu ${week.weekNumber} dari ${totalWeeks}</span><span>${countdown}</span></p>
      </div>
    `;

    const metrics = [
      day.km ? `<span class="today-card-metric"><strong>${day.km} km</strong></span>` : '',
      day.km ? `<span class="today-card-metric">Pace <strong>${paceTargetLabel(day, zone, isFirstTimerPlan)}</strong></span>` : '',
      // Set by markCompletedSessionsFromStrava, which runs after the first
      // render and calls back in here — see its tail.
      day.isCompleted ? `<span class="today-card-metric today-card-done">${icon('check-circle')} Sudah dijalani</span>` : '',
    ].filter(Boolean).join('');

    todayCard.innerHTML = `
      <div class="today-card-head">
        <span class="today-card-eyebrow">${eyebrow}</span>
        <span class="today-card-week">Minggu ${week.weekNumber} · ${week.phase}</span>
      </div>
      <p class="today-card-title">${formatDate(day.date)}</p>
      <div class="today-card-body">
        <span class="type-badge" style="background:${color}">${label}</span>
        ${metrics}
      </div>
      ${day.structure ? renderWorkoutStructure(day.structure, zone) : ''}
      ${nextLine}
      ${progress}
    `;
    todayCard.hidden = false;
  }

  // Bar chart of every week's totalKm, colored by phase (reuses
  // PHASE_COLORS — the same colors already meaning that phase in each
  // week's accordion header, not a new palette) — the accordion below only
  // ever shows one week's total at a time, so without this a runner has
  // to expand all of them just to see the plan's overall base-build-peak-
  // taper shape.
  //
  // For a week that has actually started (weekHasStarted), the bar splits
  // into two stacked zones instead of one solid fill: a bottom zone in a
  // single vivid color for km actually logged on Strava so far this week
  // (weekActualKm), and — if the target isn't fully met yet — a dim zone
  // above it for what's still left to run. Both zones stay full width,
  // same as every other week's bar, rather than a bullet-graph-style
  // narrow bar centered over a wide one: tried that first, and next to a
  // row of bold full-width bars a thin centered one read as "this bar is
  // too small" rather than "here's a comparison", on exactly the week
  // that matters most. The "done" zone's color is deliberately its own
  // hue (--color-progress) rather than reusing --color-accent, which
  // Build's own phase bar already sits in — a same-colored overlay would
  // vanish into a Build week exactly when checking progress on it matters
  // most. A future week (hasn't started) is a single plain bar, same as
  // always, but dimmed — there's nothing run yet to compare it against,
  // and full brightness reserved for "already happened" (a completed
  // week's done zone, or a just-run today) makes that distinction visible
  // at a glance instead of every week competing for the same attention.
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

    // Resolved once per week up front — an overshot week's actualKm can
    // exceed every week's totalKm (a great week, or a stray extra run),
    // and the chart's own scale (maxKm below) has to stretch to fit that
    // or its bright zone would just clip against the top of the track.
    const rows = weeks.map(week => {
      const hasStarted = weekHasStarted(week);
      const actualKm = hasStarted ? weekActualKm(week) : 0;
      return { week, hasStarted, actualKm };
    });

    const maxKm = Math.max(...rows.map(r => Math.max(r.week.totalKm, r.actualKm)), 1);
    const trackHeight = 90;

    const cols = rows.map(({ week, hasStarted, actualKm }) => {
      const targetHeightPx = Math.max(3, Math.round((week.totalKm / maxKm) * trackHeight));
      const color = PHASE_COLORS[week.phase] || 'var(--color-text-muted)';
      const isCurrent = currentWeek && week.weekNumber === currentWeek.weekNumber;

      let bar;
      if (hasStarted) {
        // doneHeightPx alone (not targetHeightPx) drives the bar's outer
        // height once it exceeds the target — an overshoot week is just
        // taller than a normal one, no remainder zone left to show.
        const doneHeightPx = Math.round((actualKm / maxKm) * trackHeight);
        const outerHeightPx = Math.max(targetHeightPx, doneHeightPx);
        const remainderHeightPx = outerHeightPx - doneHeightPx;
        const doneClass = remainderHeightPx > 0 ? 'volume-chart-done' : 'volume-chart-done is-full';
        bar = `
          ${remainderHeightPx > 0 ? `<span class="volume-chart-remainder" style="height:${remainderHeightPx}px;bottom:${doneHeightPx}px;background:${color}"></span>` : ''}
          ${doneHeightPx > 0 ? `<span class="${doneClass}" style="height:${doneHeightPx}px"></span>` : ''}
        `;
      } else {
        bar = `<span class="volume-chart-fill" style="height:${targetHeightPx}px;background:${color}"></span>`;
      }

      // "Actual/Rencana" once a week has something to report, otherwise
      // just the plan number as before — matches the title text below,
      // which spells the same pair out in full for anyone who hovers. The
      // actual figure gets its own class so it can carry the same vivid
      // color as its bar; the plan figure next to it stays the chart's
      // ordinary muted tone, same as a future week's lone number. Rounded
      // to a whole km same as the plan figure always has been — a dozen+
      // of these columns already have to share the width .table-scroll
      // gives them, and the exact decimal is one hover away in `title`.
      const roundedActual = Math.round(actualKm);
      const valueLabel = hasStarted
        ? `<span class="volume-chart-value-actual">${roundedActual}</span><span class="volume-chart-value-sep">/</span>${Math.round(week.totalKm)}`
        : `${Math.round(week.totalKm)}`;
      const title = hasStarted
        ? `Minggu ${week.weekNumber} • ${week.phase} • ${Math.round(actualKm * 10) / 10} dari ${week.totalKm} km sudah dijalani`
        : `Minggu ${week.weekNumber} • ${week.phase} • ${week.totalKm} km`;

      return `
        <div class="volume-chart-col${isCurrent ? ' is-current' : ''}" title="${title}">
          <span class="volume-chart-value">${valueLabel}</span>
          <div class="volume-chart-track">${bar}</div>
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
    // Only appears once at least one week has actually started — otherwise
    // the legend would explain a color nowhere in the chart yet.
    const actualLegend = rows.some(r => r.hasStarted)
      ? `<span class="volume-chart-legend-item"><span class="volume-chart-legend-dot volume-chart-legend-dot-actual"></span>Sudah dijalani (Strava)</span>`
      : '';

    volumeChart.innerHTML = `
      <div class="pace-zone-header">
        <span class="pace-zone-title">${icon('trend')} Volume Mingguan (km)</span>
        <span class="pace-zone-source">Peak ${peakWeek.totalKm} km di minggu ${peakWeek.weekNumber}${currentNote}</span>
      </div>
      <div class="table-scroll"><div class="volume-chart-bars">${cols}</div></div>
      <div class="volume-chart-legend">${legend}${actualLegend}</div>
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
    // A PDF failure (or any other result-level message) was about the
    // previous plan — it says nothing about this one.
    resultNotice.hidden = true;
    closeFeedbackPanel();
    // No separate reset for race-day tips (or the per-week AI notes further
    // below) needed — both get appended straight into a week-block's own
    // markup (see applyPendingAiReviewToDom), and planWeeksEl.innerHTML is
    // about to be fully rebuilt below anyway.

    // Warnings, as a <details> the runner can fold away. These run to two
    // or three full paragraphs — measured at 786px tall on a 375px screen,
    // more than three times the "today" card above them — and they say the
    // same thing on every visit for the life of the block. Open on first
    // render so nothing is ever hidden from someone who hasn't chosen to
    // hide it; the summary line alone is what they get back to on the
    // visits after that.
    if (warnings.length) {
      const label = warnings.length === 1
        ? 'Satu catatan penting tentang plan ini'
        : `${warnings.length} catatan penting tentang plan ini`;
      resultWarning.innerHTML = `
        <summary class="result-warning-summary">${icon('alert')}<span>${label}</span></summary>
        <div class="result-warning-body">${warnings.map(w => `<p>${w}</p>`).join('')}</div>
      `;
      resultWarning.open = true;
      resultWarning.hidden = false;
    } else {
      resultWarning.hidden = true;
    }

    // Summary — labels swap for a non-race plan (meta.mode/nonRaceStyle,
    // see planGenerator.js): "Race"/"Tanggal Race" don't apply when
    // raceDate is really just the block's own end date.
    const isNonRacePlan = meta.mode && meta.mode !== 'race';
    const raceCardLabel = !isNonRacePlan ? 'Race'
      : meta.mode === 'firstTimer' ? 'Program'
      : (meta.nonRaceStyle === 'maintenance' ? 'Maintenance' : 'Base Building');
    const dateCardLabel = !isNonRacePlan ? 'Tanggal Race' : meta.mode === 'firstTimer' ? 'Lulus (Perkiraan)' : 'Akhir Blok';
    summaryCards.innerHTML = `
      <div class="summary-item"><div class="label">${raceCardLabel}</div><div class="value">${meta.raceLabel}</div></div>
      <div class="summary-item"><div class="label">${dateCardLabel}</div><div class="value is-small">${formatDate(meta.raceDate)}</div></div>
      <div class="summary-item"><div class="label">Durasi Plan</div><div class="value">${meta.planWeeks} minggu</div></div>
      <div class="summary-item"><div class="label">Peak Weekly Volume</div><div class="value">${meta.peakWeeklyKm} km</div></div>
      <div class="summary-item"><div class="label">Peak Long Run</div><div class="value">${meta.peakLongRunKm} km</div></div>
      ${!isNonRacePlan ? `
      <div class="summary-item"><div class="label">Goal Pace</div><div class="value">${formatPace(meta.goalPaceSec)}</div></div>
      ${meta.goalPaceSource === 'recentRace' ? `
      <div class="summary-item"><div class="label">Estimasi dari Race Terakhir</div><div class="value is-small">${formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km &rarr; ${formatDuration(meta.predictedRaceTimeSec)} ${meta.raceLabel}</div></div>
      ` : ''}
      ` : ''}
    `;

    // Hoisted above renderVolumeChart/the weeks loop below — both need to
    // know which week is "now" (the chart to mark it, the loop to open it
    // by default and badge it).
    const currentWeek = findCurrentWeek(weeks);

    renderTodayCard(plan);
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
        ? `<div class="week-vdot">${icon('target')} Zona Pace (VDOT ${vdot.toFixed(1)}) per ${formatLongDate(week.startDate)}</div>`
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

  // Fetches this athlete's subscribable feed URL (api/calendar-url.js) and
  // shows it, copying it to the clipboard in the same click so the common
  // case is paste-and-done. The URL is shown as selectable text either
  // way — clipboard access is denied often enough (insecure origin, a
  // browser setting, an in-app webview) that it can't be the only way to
  // get the link out of here.
  async function showCalendarSubscribeUrl() {
    const setStatus = (text, isError = false) => {
      calendarSubscribeStatus.textContent = text;
      calendarSubscribeStatus.classList.toggle('is-error', isError);
      calendarSubscribeStatus.hidden = !text;
    };

    // Dummy mode has no server behind it at all (see js/auth.js), so the
    // feed has nothing to serve it — say so plainly instead of firing a
    // fetch that can only 404. There's no local fallback to offer since
    // the one-off .ics download was removed.
    if (paceforgeAuth?.isDummy()) {
      calendarUrlOut.hidden = true;
      setStatus('Menghubungkan kalender butuh PaceForge yang sudah di-deploy (server + login Strava sungguhan). Di mode dummy belum ada feed yang bisa dihubungkan.', true);
      return;
    }

    setStatus('Menyiapkan link kalender...');
    try {
      const res = await fetch('/api/calendar-url');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Server merespons status ${res.status}`);

      calendarUrlOut.textContent = data.webcalUrl;
      calendarUrlOut.hidden = false;

      let copied = false;
      try {
        await navigator.clipboard.writeText(data.webcalUrl);
        copied = true;
      } catch { /* clipboard diblokir — link-nya tetap tampil di bawah */ }

      // Deliberately short: the how-to for each calendar app is already
      // spelled out in the panel above this line (see index.html), and
      // repeating a trimmed version of it here would be the copy people
      // read first and the one that's missing the Google desktop caveat.
      setStatus(copied
        ? `${icon('check')} Link disalin ke clipboard — tempel sesuai langkah di atas.`
        : 'Salin link di bawah ini, lalu tempel sesuai langkah di atas.');
    } catch (err) {
      calendarUrlOut.hidden = true;
      setStatus(`Gagal mengambil link kalender: ${err.message}`, true);
    }
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
      showResultNotice('Fitur simpan PDF belum siap (library belum termuat). Coba muat ulang halaman.');
      return;
    }

    resultNotice.hidden = true;
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
      // Goal Pace is meaningless for non-race plans (see the on-screen
      // summary card's own isNonRacePlan check) — VDOT/pace barely moves
      // in these modes by design, so there's no real "goal" being worked
      // toward the way a race's goal pace is.
      const summaryItems = [
        ['Durasi Plan', `${meta.planWeeks} minggu`],
        ['Peak Weekly Volume', `${meta.peakWeeklyKm} km`],
        ['Peak Long Run', `${meta.peakLongRunKm} km`],
        ...(meta.mode && meta.mode !== 'race' ? [] : [['Goal Pace', formatPace(meta.goalPaceSec)]]),
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
      const isFirstTimerPlan = meta.mode === 'firstTimer';
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
            // See paceTargetLabel's own comment — same gentler "5K" badge
            // as the on-screen result for First-timer's evaluation day.
            : (day.type === 'evaluation' && isFirstTimerPlan) ? '5K'
            : (TYPE_LABELS[displayKey] || displayKey));
          const km = day.km ? `${day.km} km` : '—';
          // Shared with renderDayRow (see paceTargetLabel) so the PDF's
          // Pace Target column matches the on-screen result exactly.
          const zone = zoneForDay(day);
          const pace = paceTargetLabel(day, zone, isFirstTimerPlan);
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
      showResultNotice(`Gagal membuat PDF: ${err.message}`);
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
    // First-timer plans have no goal pace/VDOT/long run at all — every
    // other field this payload sends (goalPaceSec, peakLongRunKm, ...) is
    // null/meaningless for this mode (see generateFirstTimerPlan in
    // planGenerator.js), and the AI coach prompt itself doesn't know about
    // run/walk sessions yet either. Skipping outright rather than sending
    // a payload full of nulls the prompt would have to guess at — same
    // "no AI notes" degraded state the app already falls back to when
    // ANTHROPIC_API_KEY isn't configured at all.
    if (lastPlan.meta.mode === 'firstTimer') return;

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
      raceDate: dateKey(meta.raceDate),
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
      aiStatus.innerHTML = `${icon('sparkle')} Plan sudah ditinjau &amp; diberi catatan oleh Claude.`;
    } else if (aiReviewErrorMessage) {
      aiStatus.hidden = false;
      aiStatus.classList.add('is-error');
      aiStatus.textContent = `Gagal minta review AI: ${aiReviewErrorMessage}. Plan dasar (rule-based) di atas tetap berlaku.`;
      aiRetryBtn.hidden = false;
    }
  }

  function renderDayRow(day, weekNumber) {
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
    // Pairs the row with the "today" hero card at the top of the result
    // (see renderTodayCard) — the same date, findable as one thing once
    // the runner scrolls down into the schedule itself. Deliberately loses
    // to is-race/is-swap-selected/is-completed in the stylesheet: on race
    // day or a session already logged, that state is the more useful thing
    // for the row to be saying.
    const isTodayRow = dateKey(day.date) === dateKey(new Date());
    const rowClass = [isRest ? 'is-rest' : (isRace ? 'is-race' : ''), isTodayRow ? 'is-today' : '', isSwapSelected ? 'is-swap-selected' : '', isCompleted ? 'is-completed' : ''].filter(Boolean).join(' ');
    const displayKey = restDisplayKey(day);
    const isFirstTimerPlan = lastPlan?.meta?.mode === 'firstTimer';
    const label = dayTypeLabel(day, isFirstTimerPlan);
    const km = day.km ? `${day.km} km` : '—';
    // Pace Target names the VDOT zone this session trains at (Easy, Tempo,
    // Interval, Repetition, Marathon) instead of that week's specific pace
    // number — the number ramps week to week (see planGenerator.js's
    // weekPaces) and changes for every plan anyway, while the zone itself
    // is the stable, memorable thing to internalize ("today is an Interval
    // day"). Race day gets its own label since goal race pace doesn't
    // cleanly belong to one of the 5 training zones.
    const zone = zoneForDay(day);
    const pace = paceTargetLabel(day, zone, isFirstTimerPlan);
    const color = TYPE_COLORS[displayKey] || 'var(--type-rest)';
    // renderWorkoutStructure returns nothing for a shapeless session (see
    // its own comment), so the row is built from the result rather than
    // from `day.structure` being present — otherwise an Easy Run would
    // still get an empty, padded <tr>.
    const structureHtml = day.structure ? renderWorkoutStructure(day.structure, zone) : '';
    const structureRow = structureHtml
      ? `<tr class="structure-row ${rowClass}"><td colspan="5">${structureHtml}</td></tr>`
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
    // "cancel" affordance (an x icon) in place of the swap icon instead of a
    // second button, so there's always exactly one control to reason
    // about per row.
    const swapDisabled = isRace || isCompleted;
    const swapBtn = swapDisabled ? '' : `<button type="button" class="swap-day-btn" data-week="${weekNumber}" data-dow="${day.dow}" title="${isSwapSelected ? 'Batal tukar' : 'Tukar dengan hari lain'}" aria-label="${isSwapSelected ? 'Batalkan pemilihan tukar hari' : `Tukar sesi hari ${day.dayName} dengan hari lain`}">${icon(isSwapSelected ? 'x' : 'swap')}</button>`;
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
        <!-- data-label carries the column header into the cell itself: on a
             phone the <thead> is hidden and these stack as labelled lines
             instead of columns (see the .day-table rules under the 600px
             media query in css/styles.css). The pace text is wrapped so
             that layout can drop a rest day's meaningless "—" without also
             dropping the swap button sharing this cell. -->
        <td data-label="Jarak">${km}</td>
        <td data-label="Pace"><span class="pace-text">${pace}</span>${swapBtn}</td>
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
  function renderWorkoutStructure(structure, zone) {
    const { segments, caption } = structureToSegments(structure);

    // A single segment with nothing to say about it is one flat block of
    // color spanning the row — it looks like a chart but carries no
    // information the "Jarak" column doesn't already give. That was 33 of
    // the 47 bars on a typical 12-week plan (every Easy and Recovery run),
    // i.e. most of what this element rendered was noise. Skipping them
    // leaves the bar meaning something: this session has a shape.
    if (segments.length < 2 && !caption) return '';

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
