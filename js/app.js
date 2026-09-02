/**
 * PaceForge — app.js
 * Wires up the form, validates input, calls PaceForgeGenerator, renders results.
 */
(() => {
  const RACE_META = {
    '5k': { km: 5, label: '5K' },
    '10k': { km: 10, label: '10K' },
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
    race: 'var(--type-race)',
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
    race: '#6366f1',
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
  };

  // Short zone labels for the Pace Target column / bar tooltips — the same
  // 5 zones as PaceForgeVDOT.ZONE_LABELS but without that table's
  // parenthetical explainer ("(Santai)"/"(Tempo)"), which would just repeat
  // on every single row here instead of appearing once.
  const ZONE_SHORT_LABEL = { easy: 'Easy', marathon: 'Marathon', threshold: 'Tempo', interval: 'Interval', repetition: 'Repetition' };

  function zoneForDay(day) {
    if (day.type === 'longRun' && day.isMarathonSpecific) return 'marathon';
    return TYPE_TO_ZONE[day.type] || null;
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
  // --type-recovery color already used for "Lari Pemulihan" days
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

  // This week's own VDOT — derived the same way as the top Zona Pace card
  // (see renderPaceZones), just from week.weekGoalPaceSec (that week's own
  // interpolated goal pace, see planGenerator.js) instead of the overall
  // plan's goalPaceSec — so the figure climbs week to week alongside the
  // schedule instead of staying fixed at the plan's single snapshot.
  function weekVdot(meta, week) {
    return PaceForgeVDOT.vdotFromGoalPace(meta.raceDistanceKm, week.weekGoalPaceSec);
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
  const hasRecentRace = document.getElementById('hasRecentRace');
  const recentRaceFields = document.getElementById('recentRaceFields');
  const recentRaceDistanceSel = document.getElementById('recentRaceDistance');
  const recentRaceCustomField = document.getElementById('recentRaceCustomField');
  const recentRaceCustomKm = document.getElementById('recentRaceCustomKm');
  const recentRaceHours = document.getElementById('recentRaceHours');
  const recentRaceMinutes = document.getElementById('recentRaceMinutes');
  const recentRaceSeconds = document.getElementById('recentRaceSeconds');
  const recentRaceHint = document.getElementById('recentRaceHint');
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
  const paceLegend = document.getElementById('paceLegend');
  const planWeeksEl = document.getElementById('planWeeks');
  const aiStatus = document.getElementById('aiStatus');
  const aiRetryBtn = document.getElementById('aiRetryBtn');
  const aiIntro = document.getElementById('aiIntro');
  const aiRaceDayTips = document.getElementById('aiRaceDayTips');

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

  function updateRecentRaceHint() {
    if (!hasRecentRace.checked) {
      recentRaceHint.textContent = DEFAULT_RECENT_RACE_HINT;
      return;
    }
    const h = Number(recentRaceHours.value) || 0;
    const m = Number(recentRaceMinutes.value) || 0;
    const s = Number(recentRaceSeconds.value) || 0;
    const recentTimeSec = h * 3600 + m * 60 + s;
    const fromKm = getRecentRaceDistanceKm();
    const raceKm = getCurrentRaceDistanceKm();
    if (recentTimeSec <= 0 || !fromKm || !raceKm) {
      recentRaceHint.textContent = 'Isi jarak & waktu race yang valid untuk melihat estimasi.';
      return;
    }
    const { predictRaceTime, formatDuration, formatPace } = PaceForgeGenerator;
    const predictedSec = predictRaceTime(recentTimeSec, fromKm, raceKm);
    recentRaceHint.textContent = `Estimasi: ${formatDuration(predictedSec)} untuk ${raceKm} km (pace ${formatPace(predictedSec / raceKm)}). Dipakai otomatis sebagai goal pace kalau kamu tidak isi target waktu finish di bawah.`;
  }

  hasRecentRace.addEventListener('change', () => {
    recentRaceFields.hidden = !hasRecentRace.checked;
    updateRecentRaceHint();
  });
  recentRaceDistanceSel.addEventListener('change', () => {
    recentRaceCustomField.hidden = recentRaceDistanceSel.value !== 'custom';
    updateRecentRaceHint();
  });
  [recentRaceCustomKm, recentRaceHours, recentRaceMinutes, recentRaceSeconds].forEach(el => el.addEventListener('input', updateRecentRaceHint));
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
    const isCustomDistance = getDistanceMode() === 'custom';
    let raceKey = raceDistanceSel.value;
    let raceDistanceKm = RACE_META[raceKey]?.km;
    let raceLabel = RACE_META[raceKey]?.label;
    if (isCustomDistance) {
      raceKey = 'custom';
      raceDistanceKm = Number(customDistanceKm.value);
      raceLabel = `${raceDistanceKm} km`;
      if (!raceDistanceKm || raceDistanceKm <= 0) {
        showError('Masukkan jarak custom yang valid (dalam km).');
        return null;
      }
    }

    if (!raceDateInput.value) { showError('Pilih tanggal race terlebih dahulu.'); return null; }
    const raceDate = new Date(raceDateInput.value + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (raceDate <= today) { showError('Tanggal race harus di masa depan.'); return null; }

    if (!startDateInput.value) { showError('Pilih tanggal mulai training terlebih dahulu.'); return null; }
    const startDate = new Date(startDateInput.value + 'T00:00:00');
    if (startDate < today) { showError('Tanggal mulai training tidak boleh di masa lalu.'); return null; }
    if (startDate >= raceDate) { showError('Tanggal mulai training harus sebelum tanggal race.'); return null; }

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
    if (hasRecentRace.checked) {
      const h = Number(recentRaceHours.value) || 0;
      const m = Number(recentRaceMinutes.value) || 0;
      const s = Number(recentRaceSeconds.value) || 0;
      recentRaceTimeSec = h * 3600 + m * 60 + s;
      recentRaceDistanceKm = getRecentRaceDistanceKm();
      if (recentRaceTimeSec <= 0) { showError('Isi waktu race terakhir yang valid.'); return null; }
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

    hasRecentRace.checked = settings.recentRaceTimeSec != null;
    recentRaceFields.hidden = !hasRecentRace.checked;
    if (hasRecentRace.checked) {
      const isPreset = ['5', '10', '15', '21.1', '42.2'].includes(String(settings.recentRaceDistanceKm));
      recentRaceDistanceSel.value = isPreset ? String(settings.recentRaceDistanceKm) : 'custom';
      recentRaceCustomField.hidden = isPreset;
      if (!isPreset) recentRaceCustomKm.value = settings.recentRaceDistanceKm;
      recentRaceHours.value = Math.floor(settings.recentRaceTimeSec / 3600);
      recentRaceMinutes.value = Math.floor((settings.recentRaceTimeSec % 3600) / 60);
      recentRaceSeconds.value = settings.recentRaceTimeSec % 60;
    }
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
    lastFitnessLevel = settings.fitnessLevel;
    lastConservativeMode = settings.conservativeMode;

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

  async function savePlanForCurrentUser(settings) {
    const payload = {
      settings: {
        ...settings,
        raceDate: settings.raceDate.toISOString().slice(0, 10),
        startDate: settings.startDate.toISOString().slice(0, 10),
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
    recentRace: { distanceKm: 10, timeSec: 52 * 60 + 30 },
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
      hasRecentRace.checked = true;
      recentRaceFields.hidden = false;
      const isPreset = ['5', '10', '15', '21.1', '42.2'].includes(String(summary.recentRace.distanceKm));
      recentRaceDistanceSel.value = isPreset ? String(summary.recentRace.distanceKm) : 'custom';
      recentRaceCustomField.hidden = isPreset;
      if (!isPreset) recentRaceCustomKm.value = summary.recentRace.distanceKm;
      recentRaceHours.value = Math.floor(summary.recentRace.timeSec / 3600);
      recentRaceMinutes.value = Math.floor((summary.recentRace.timeSec % 3600) / 60);
      recentRaceSeconds.value = summary.recentRace.timeSec % 60;
      updateRecentRaceHint();
      filledAny = true;
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
        row.classList.add('is-completed');
        const slot = row.querySelector('.completed-slot');
        if (slot) {
          slot.innerHTML = `<span class="completed-badge" title="Selesai — tercatat ${best.km} km di Strava">✅</span>`;
        }
      });
    });
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

  // Renders the 5-zone VDOT pace table into #paceLegend, using the
  // runner's CURRENT fitness (week 1's VDOT) — the per-week progression
  // itself (VDOT climbing as training advances, same endpoints
  // currentFitnessPaceSec -> goalPaceSec that weekPaces interpolates
  // between in planGenerator.js) is shown per week in the schedule below
  // instead (see the "Zona Pace (VDOT ...)" line rendered under each
  // week's header — weekVdot()), so this card doesn't need to try to
  // encode a start/end range itself. vdot comes from the runner's actual
  // recent-race result when the form has one (most accurate — a real
  // performance), falling back to the generator's own current-fitness pace
  // estimate otherwise (see PaceForgeVDOT.vdotFromGoalPace). Silently
  // renders nothing if that's somehow unavailable/invalid rather than
  // showing a broken table.
  function renderPaceZones(meta) {
    const { formatDuration } = PaceForgeGenerator;
    const { vdotFromPerformance, vdotFromGoalPace, paceZonesFromVDOT, formatPaceRange, ZONE_ORDER, ZONE_LABELS, ZONE_PCT_RANGES } = PaceForgeVDOT;

    let vdot;
    let sourceLabel;
    if (meta.recentRaceTimeSec && meta.recentRaceDistanceKm) {
      vdot = vdotFromPerformance(meta.recentRaceDistanceKm, meta.recentRaceTimeSec);
      sourceLabel = `dari waktu race terakhirmu (${formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km)`;
    } else {
      vdot = vdotFromGoalPace(meta.raceDistanceKm, meta.currentFitnessPaceSec);
      sourceLabel = 'dari estimasi goal pace (belum ada data race terakhir)';
    }
    const zones = vdot ? paceZonesFromVDOT(vdot) : null;
    if (!zones) { paceLegend.innerHTML = ''; return; }

    const generatedDate = formatLongDate(new Date());

    paceLegend.innerHTML = `
      <div class="pace-zone-header">
        <span class="pace-zone-title">🎯 Zona Pace (VDOT ${vdot.toFixed(1)})</span>
        <span class="pace-zone-source">${sourceLabel} • per ${generatedDate}</span>
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
    aiRaceDayTips.hidden = true;
    aiRaceDayTips.innerHTML = '';

    // Warnings
    if (warnings.length) {
      resultWarning.innerHTML = warnings.map(w => `⚠️ ${w}`).join('<br><br>');
      resultWarning.hidden = false;
    } else {
      resultWarning.hidden = true;
    }

    // Summary
    summaryCards.innerHTML = `
      <div class="summary-item"><div class="label">Race</div><div class="value">${meta.raceLabel}</div></div>
      <div class="summary-item"><div class="label">Tanggal Race</div><div class="value" style="font-size:1rem">${formatDate(meta.raceDate)}</div></div>
      <div class="summary-item"><div class="label">Durasi Plan</div><div class="value">${meta.planWeeks} minggu</div></div>
      <div class="summary-item"><div class="label">Peak Weekly Volume</div><div class="value">${meta.peakWeeklyKm} km</div></div>
      <div class="summary-item"><div class="label">Peak Long Run</div><div class="value">${meta.peakLongRunKm} km</div></div>
      <div class="summary-item"><div class="label">Goal Pace</div><div class="value">${formatPace(meta.goalPaceSec)}</div></div>
      ${meta.goalPaceSource === 'recentRace' ? `
      <div class="summary-item"><div class="label">Estimasi dari Race Terakhir</div><div class="value" style="font-size:1rem">${formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km &rarr; ${formatDuration(meta.predictedRaceTimeSec)} ${meta.raceLabel}</div></div>
      ` : ''}
    `;

    // Zona Pace — full 5-zone VDOT table (Jack Daniels methodology, same
    // one popularized by calculators like vdoto2.com), computed from the
    // runner's actual recent-race performance when available, or from the
    // generator's own goal pace otherwise (see PaceForgeVDOT.vdotFromGoalPace)
    // so the table is always shown. Distinct from the schedule's own
    // recovery/easy/tempo/interval pace targets above (which ramp week to
    // week toward goal pace) — this is a fitness-level reference table, not
    // a per-week target.
    renderPaceZones(meta);

    // Weeks
    planWeeksEl.innerHTML = weeks.map(week => {
      const vdot = weekVdot(meta, week);
      const vdotLine = vdot
        ? `<div class="week-vdot">🎯 Zona Pace (VDOT ${vdot.toFixed(1)}) per ${formatLongDate(week.startDate)}</div>`
        : '';
      return `
      <div class="week-block" data-week-number="${week.weekNumber}">
        <div class="week-header">
          <span class="week-title">Minggu ${week.weekNumber}</span>
          <span class="week-phase">${week.phase} • ${formatDate(week.startDate)} – ${formatDate(week.endDate)}</span>
          <span class="week-total">Total: ${week.totalKm} km</span>
        </div>
        ${vdotLine}
        <div class="table-scroll">
          <table class="day-table">
            <thead>
              <tr><th>Hari</th><th>Tanggal</th><th>Sesi</th><th>Jarak</th><th>Pace Target</th></tr>
            </thead>
            <tbody>
              ${week.days.map(renderDayRow).join('')}
            </tbody>
          </table>
        </div>
      </div>
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
      doc.text(`Race day: ${formatDate(meta.raceDate)}`, pageWidth - margin, y + 14, { align: 'right' });

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
      // same VDOT derivation (recent race if given, else the generator's
      // own goal pace, see PaceForgeVDOT.vdotFromGoalPace) and same 5
      // Daniels training zones, so the PDF and on-screen result stay
      // consistent with each other.
      {
        const { vdotFromPerformance, vdotFromGoalPace, paceZonesFromVDOT, formatPaceRange, ZONE_ORDER, ZONE_LABELS, ZONE_PCT_RANGES } = PaceForgeVDOT;
        let vdot, zoneSourceLabel;
        if (meta.recentRaceTimeSec && meta.recentRaceDistanceKm) {
          vdot = vdotFromPerformance(meta.recentRaceDistanceKm, meta.recentRaceTimeSec);
          zoneSourceLabel = `dari waktu race terakhir (${PaceForgeGenerator.formatDuration(meta.recentRaceTimeSec)} / ${meta.recentRaceDistanceKm} km)`;
        } else {
          vdot = vdotFromGoalPace(meta.raceDistanceKm, meta.currentFitnessPaceSec);
          zoneSourceLabel = 'dari estimasi goal pace (belum ada data race terakhir)';
        }
        const zones = vdot ? paceZonesFromVDOT(vdot) : null;
        if (zones) {
          const generatedDate = formatLongDate(new Date());

          doc.setFont('helvetica', 'bold');
          doc.setFontSize(11);
          doc.setTextColor(...inkColor);
          doc.text(`Zona Pace (VDOT ${vdot.toFixed(1)})`, margin, y);
          doc.setFont('helvetica', 'normal');
          doc.setFontSize(8);
          doc.setTextColor(...mutedColor);
          doc.text(pdfSafeText(`${zoneSourceLabel} • per ${generatedDate}`), margin, y + 12);
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
        const vdot = weekVdot(meta, week);
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
          const label = pdfSafeText((day.type === 'longRun' && day.isMarathonSpecific)
            ? `${TYPE_LABELS.longRun} (Pace ${day.structure?.paceLabel || 'Marathon'})`
            : (TYPE_LABELS[day.type] || day.type));
          const km = day.km ? `${day.km} km` : '—';
          // Same zone-name logic as renderDayRow (see there for why) so the
          // PDF's Pace Target column matches the on-screen result exactly.
          const zone = zoneForDay(day);
          const pace = day.type === 'race' ? 'Race Pace' : (zone ? ZONE_SHORT_LABEL[zone] : '—');
          body.push([day.dayName, day.date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' }), label, km, pace]);
          rowMeta.push({ kind: 'day', type: day.type });
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
            if (rowInfo.kind === 'day' && rowInfo.type === 'race') {
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
  const AI_ADJUSTABLE_TYPES = new Set(['easy', 'recovery', 'tempo', 'interval', 'repetition']);
  const MAX_AI_ADJUSTMENTS = 5;

  // Applies Claude's suggested per-day distance adjustments to an
  // already-generated rule-based plan, IN PLACE. Claude's numbers are
  // advisory only — never trusted outright: at most MAX_AI_ADJUSTMENTS
  // sessions, never long run/race/shakeout, and every survivor clamped to
  // within ~20% of its original rule-based distance and to the same
  // absolute ceiling the generator itself enforces for that type
  // (PaceForgeGenerator.MAX_REPETITION_SESSION_KM for repetition,
  // MAX_SUPPORT_SESSION_KM for everything else) either way.
  function applyAiAdjustments(plan, adjustments) {
    if (!Array.isArray(adjustments) || !adjustments.length) return;
    const { buildSimpleStructure, buildIntervalStructure, buildTempoStructure, buildRepetitionStructure, MAX_SUPPORT_SESSION_KM, MAX_REPETITION_SESSION_KM } = PaceForgeGenerator;

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
      const sessionCap = day.type === 'repetition' ? MAX_REPETITION_SESSION_KM : MAX_SUPPORT_SESSION_KM;
      const clamped = Math.min(Math.max(suggested, day.km * 0.8), day.km * 1.2, sessionCap);
      const rounded = Math.round(clamped * 2) / 2;
      if (rounded === day.km) continue;

      day.km = rounded;
      // day.workoutVariant and day.recoveryPaceSecPerKm (both set by the
      // generator for interval/tempo/repetition — see planGenerator.js)
      // are preserved as-is here so an AI distance tweak doesn't silently
      // reset e.g. a "short reps" interval week back to the default
      // variant, or its recovery jog back to a different week's pace.
      if (day.type === 'interval') day.structure = buildIntervalStructure(day.km, lastFitnessLevel, lastConservativeMode, day.workoutVariant, day.recoveryPaceSecPerKm);
      else if (day.type === 'tempo') day.structure = buildTempoStructure(day.km, day.workoutVariant, day.recoveryPaceSecPerKm);
      else if (day.type === 'repetition') day.structure = buildRepetitionStructure(day.km, day.recoveryPaceSecPerKm);
      else day.structure = buildSimpleStructure(day.km);

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
      if (data.raceDayTips) {
        aiRaceDayTips.innerHTML = `<span class="ai-tips-title">Tips Race Day</span>${data.raceDayTips}`;
        aiRaceDayTips.hidden = false;
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

  function renderDayRow(day) {
    const { formatDate, TYPE_LABELS } = PaceForgeGenerator;
    const isRest = day.type === 'rest';
    const isRace = day.type === 'race';
    const rowClass = isRest ? 'is-rest' : (isRace ? 'is-race' : '');
    const label = (day.type === 'longRun' && day.isMarathonSpecific)
      ? `${TYPE_LABELS.longRun} (Pace ${day.structure?.paceLabel || 'Marathon'})`
      : (TYPE_LABELS[day.type] || day.type);
    const km = day.km ? `${day.km} km` : '—';
    // Pace Target names the VDOT zone this session trains at (Easy, Tempo,
    // Interval, Repetition, Marathon) instead of that week's specific pace
    // number — the number ramps week to week (see planGenerator.js's
    // weekPaces) and changes for every plan anyway, while the zone itself
    // is the stable, memorable thing to internalize ("today is an Interval
    // day"). Race day gets its own label since goal race pace doesn't
    // cleanly belong to one of the 5 training zones.
    const zone = zoneForDay(day);
    const pace = isRace ? 'Race Pace' : (zone ? ZONE_SHORT_LABEL[zone] : '—');
    const color = TYPE_COLORS[day.type] || 'var(--type-rest)';
    const structureRow = day.structure
      ? `<tr class="structure-row ${rowClass}"><td colspan="5">${renderWorkoutStructure(day.structure, zone)}</td></tr>`
      : '';
    return `
      <tr class="${rowClass}" data-date="${dateKey(day.date)}">
        <td>${day.dayName}</td>
        <td>${day.date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</td>
        <td><span class="type-badge" style="background:${color}">${label}</span><span class="completed-slot"></span></td>
        <td>${km}</td>
        <td>${pace}</td>
      </tr>
      ${structureRow}
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
  // gray (same as the "Lari Pemulihan" session-type color) rather than
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
      caption = `Warm up ${formatKm(structure.warmupKm)} → ${structure.reps}× (${formatKm(structure.workKm)} keras + ${recoveryLabel} pemulihan) → Cool down ${formatKm(structure.cooldownKm)}`;
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
        { label: 'Santai', km: structure.easyKm, role: 'easy' },
        { label: `Pace ${structure.paceLabel}`, km: structure.paceKm, role: 'work' },
      ];
      caption = `${formatKm(structure.easyKm)} santai → ${formatKm(structure.paceKm)} pace ${structure.paceLabel}`;
    } else {
      // 'simple' — a single continuous block, no warm up/cool down split.
      segments = [{ label: 'Lari', km: structure.km, role: 'work' }];
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
