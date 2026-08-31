/**
 * PaceForge — Training Plan Generator
 * Pure, rule-based logic (no AI / no network calls).
 *
 * generatePlan(settings) -> plan object consumed by app.js for rendering.
 *
 * settings = {
 *   raceDistanceKm: number,
 *   raceLabel: string,
 *   raceDate: Date,
 *   fitnessLevel: 'beginner' | 'intermediate' | 'advanced',
 *   currentWeeklyKm: number,
 *   longestRecentRunKm: number,  (longest single run in the last ~3 months)
 *   daysPerWeek: number (3-6),
 *   preferredDays: number[]  (0=Sun ... 6=Sat, matches Date#getDay())
 *   targetTimeSec: number | null   (goal finish time in seconds, or null)
 * }
 */

const PaceForgeGenerator = (() => {

  const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', "Jum'at", 'Sabtu'];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MS_PER_WEEK = 7 * MS_PER_DAY;

  // Recommended plan length / taper / peak long-run range per race type.
  // Values are generic heuristics (km), not sports-science guarantees.
  // maxLongRunShare = the biggest safe fraction of peak weekly volume a single
  // long run is allowed to be. Real marathon blocks — especially the common
  // 3-4 day/week plans — legitimately run a long run that's a much bigger
  // slice of the week (the classic 20-miler inside a 40-mile week) than a
  // 5K/10K/half build does, so this is race-specific rather than one flat number.
  const RACE_PROFILES = {
    '5k':   { recWeeks: 8,  taperWeeks: 1, longRunMin: 8,  longRunMax: 12, maxLongRunShare: 0.40 },
    '10k':  { recWeeks: 10, taperWeeks: 1, longRunMin: 12, longRunMax: 16, maxLongRunShare: 0.40 },
    'half': { recWeeks: 12, taperWeeks: 2, longRunMin: 16, longRunMax: 19, maxLongRunShare: 0.42 },
    'full': { recWeeks: 16, taperWeeks: 3, longRunMin: 29, longRunMax: 32, maxLongRunShare: 0.55 },
  };

  // Default goal pace (sec/km) by fitness level, used only when the user
  // doesn't provide a target finish time. Roughly tuned per level; the
  // "advanced" runner is assumed faster than "beginner".
  const DEFAULT_GOAL_PACE_SEC = {
    beginner: 7 * 60 + 30,
    intermediate: 6 * 60,
    advanced: 4 * 60 + 45,
  };

  // Training-zone pace = goalPaceSec * multiplier. Ordered slow -> fast.
  const PACE_MULTIPLIERS = {
    recovery: 1.25,
    easy: 1.15,
    longRun: 1.10,
    tempo: 0.97,
    interval: 0.90,
  };

  function resolveRaceProfile(raceDistanceKm, raceKey) {
    if (RACE_PROFILES[raceKey]) return RACE_PROFILES[raceKey];
    // Custom distance: interpolate a sensible profile from nearest known ones.
    if (raceDistanceKm <= 5) return RACE_PROFILES['5k'];
    if (raceDistanceKm <= 10) return RACE_PROFILES['10k'];
    if (raceDistanceKm <= 21.1) return RACE_PROFILES['half'];
    return RACE_PROFILES['full'];
  }

  function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

  function addDays(date, days) {
    return new Date(date.getTime() + days * MS_PER_DAY);
  }

  function startOfDay(date) {
    const d = new Date(date);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function formatPace(secPerKm) {
    const s = Math.round(secPerKm);
    const m = Math.floor(s / 60);
    const rem = s % 60;
    return `${m}:${String(rem).padStart(2, '0')} /km`;
  }

  function formatDate(date) {
    return date.toLocaleDateString('id-ID', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  }

  function longRunShareForDays(daysPerWeek) {
    if (daysPerWeek <= 4) return 0.35;
    if (daysPerWeek === 5) return 0.28;
    return 0.25; // 6 days
  }

  /** Standard running-plan periodization: the build block (everything before
   * taper) splits into thirds — Base (aerobic base, lowest intensity), Build
   * (volume + intensity climbing), Peak (highest-load weeks right before
   * taper) — mirroring how real marathon/half plans are structured. Very
   * short build blocks collapse gracefully (a single build week is just
   * "Peak"; two weeks skip straight from "Base" to "Peak"). Cutback
   * (step-back/recovery) weeks are layered on top of whichever phase they
   * fall in, and taper/race week are handled separately below. */
  function buildPhaseForWeek(weekIndex, buildWeeks) {
    if (buildWeeks <= 1) return 'Peak';
    if (buildWeeks === 2) return weekIndex === 0 ? 'Base' : 'Peak';
    const baseEnd = Math.max(1, Math.round(buildWeeks / 3));
    const buildEnd = Math.max(baseEnd + 1, Math.round(buildWeeks * 2 / 3));
    if (weekIndex < baseEnd) return 'Base';
    if (weekIndex < buildEnd) return 'Build';
    return 'Peak';
  }

  /** Ordered workout-type template for a given days-per-week, excluding long run
   * which is always appended last (and mapped to the last selected day). */
  function workoutTemplate(daysPerWeek, weekIndexInBuild) {
    const alternateSpeed = weekIndexInBuild % 2 === 0 ? 'interval' : 'tempo';
    switch (daysPerWeek) {
      case 3: return ['easy', alternateSpeed, 'longRun'];
      case 4: return ['easy', alternateSpeed, 'easy', 'longRun'];
      case 5: return ['easy', alternateSpeed, 'easy', 'tempo', 'longRun'];
      case 6: return ['easy', alternateSpeed, 'easy', 'tempo', 'recovery', 'longRun'];
      default: return ['easy', 'longRun'];
    }
  }

  const TYPE_LABELS = {
    recovery: 'Lari Pemulihan',
    easy: 'Lari Santai',
    longRun: 'Lari Jarak Jauh',
    tempo: 'Tempo Run',
    interval: 'Interval / Speedwork',
    shakeout: 'Lari Ringan (Shakeout)',
    rest: 'Istirahat',
    race: 'RACE DAY! 🏁',
  };

  function generatePlan(settings) {
    const {
      raceDistanceKm, raceLabel, raceKey, raceDate,
      fitnessLevel, currentWeeklyKm, longestRecentRunKm, daysPerWeek, preferredDays,
      targetTimeSec,
    } = settings;

    const today = startOfDay(new Date());
    const race = startOfDay(raceDate);
    const profile = resolveRaceProfile(raceDistanceKm, raceKey);

    const daysUntilRace = Math.round((race - today) / MS_PER_DAY);
    const weeksAvailable = Math.max(1, Math.floor(daysUntilRace / 7));

    let planWeeks = Math.min(weeksAvailable, profile.recWeeks);
    let taperWeeks = Math.min(profile.taperWeeks, Math.max(planWeeks - 1, 0));
    let buildWeeks = Math.max(planWeeks - taperWeeks, 1);

    const warnings = [];
    if (weeksAvailable < profile.recWeeks) {
      warnings.push(`Waktu persiapanmu (${weeksAvailable} minggu) lebih pendek dari rekomendasi umum untuk ${raceLabel} (${profile.recWeeks} minggu). Plan ini dipadatkan — fokus jaga konsistensi dan hindari lompatan volume terlalu besar.`);
    }
    const extraWeeks = weeksAvailable - profile.recWeeks;
    if (extraWeeks > 0) {
      warnings.push(`Kamu punya ${extraWeeks} minggu ekstra sebelum race. Plan detail di bawah mencakup ${planWeeks} minggu terakhir — sebelum itu, jaga jarak lari mingguan sekitar ${currentWeeklyKm} km agar tetap fit.`);
    }

    // Goal pace (sec/km) either from user's target time or a level default.
    const goalPaceSec = targetTimeSec
      ? targetTimeSec / raceDistanceKm
      : DEFAULT_GOAL_PACE_SEC[fitnessLevel];

    const paces = {};
    Object.keys(PACE_MULTIPLIERS).forEach(zone => {
      paces[zone] = goalPaceSec * PACE_MULTIPLIERS[zone];
    });
    paces.goal = goalPaceSec;

    // Peak weekly volume & peak long run.
    //
    // Peak weekly volume grows off the runner's *current* base at a safe compounding
    // weekly rate (~8%, close to the classic "10% rule" with a little headroom for
    // cutback weeks) applied across however many build weeks the plan actually has.
    // Using build-week count (not a flat multiplier) is what lets a longer block —
    // e.g. 13 build weeks for a marathon vs. 6-9 for a 5K/10K — reach a realistically
    // higher peak, matching how real plans scale: a flat 1.6x cap regardless of plan
    // length is what previously suppressed marathon peak long runs to ~20km instead
    // of the standard 29-32km range.
    const WEEKLY_GROWTH_RATE = 1.08;
    const growthMultiplier = clamp(Math.pow(WEEKLY_GROWTH_RATE, buildWeeks), 1.15, 3.2);
    const longRunShare = longRunShareForDays(daysPerWeek);
    let peakWeeklyKm = Math.max(currentWeeklyKm * growthMultiplier, currentWeeklyKm); // never plan below current base

    // Aim for the race's recommended long-run range, driven off peak weekly volume.
    let peakLongRunKm = clamp(peakWeeklyKm * longRunShare, profile.longRunMin, profile.longRunMax);

    // Guardrail: never let a single long run swallow an unsafe share of the week just
    // to hit the recommended distance. If the runner's safe peak weekly volume can't
    // support it, cap the long run and say so instead of silently shipping a plan that
    // doesn't match the range it's supposed to. The safe share is race-specific — see
    // RACE_PROFILES.maxLongRunShare.
    const safeLongRunCap = peakWeeklyKm * profile.maxLongRunShare;
    if (peakLongRunKm > safeLongRunCap) {
      peakLongRunKm = safeLongRunCap;
      warnings.push(`Long run puncak dibatasi ke sekitar ${Math.round(peakLongRunKm)} km — di bawah rekomendasi umum untuk ${raceLabel} (${profile.longRunMin}-${profile.longRunMax} km) — karena mileage mingguanmu saat ini (${currentWeeklyKm} km) belum cukup untuk mendukung long run sejauh itu dengan aman. Sebaiknya naikkan base mileage mingguan dulu sebelum mulai training block ini.`);
    }

    // Safe long-run ramp: don't let the scheduled long run jump up from the
    // runner's actual longest recent run any faster than a sensible weekly
    // increment (~20%, or 1.5km for very short current long runs, whichever
    // is bigger). The ramp base only ever grows (tracks the highest long run
    // scheduled so far) so a cutback week doesn't reset the allowance.
    let longRunRampBase = Math.max(longestRecentRunKm || 0, 2);
    const MAX_LONG_RUN_JUMP_RATIO = 0.2;
    const MIN_LONG_RUN_JUMP_KM = 1.5;

    // Taper factors applied to peakWeeklyKm, last entry = race week.
    const TAPER_FACTORS = { 1: [0.55], 2: [0.75, 0.5], 3: [0.75, 0.6, 0.4] };
    const taperFactors = TAPER_FACTORS[taperWeeks] || [];

    // Start date of the detailed plan: walk backwards planWeeks full weeks
    // from the Monday on/before race date.
    const raceWeekMonday = addDays(race, -(race.getDay() === 0 ? 6 : race.getDay() - 1));
    const firstMonday = addDays(raceWeekMonday, -(planWeeks - 1) * 7);

    const sortedPreferredDays = [...preferredDays].sort((a, b) => {
      const na = a === 0 ? 7 : a;
      const nb = b === 0 ? 7 : b;
      return na - nb;
    });

    const weeks = [];
    let actualPeakLongRunKm = 0;
    let rampLimited = false;

    for (let w = 0; w < planWeeks; w++) {
      const weekMonday = addDays(firstMonday, w * 7);
      const isTaperWeek = w >= buildWeeks;
      const isRaceWeek = w === planWeeks - 1;

      let weekKm;
      let phase;
      if (!isTaperWeek) {
        const progress = buildWeeks === 1 ? 1 : (w + 1) / buildWeeks;
        let linearKm = currentWeeklyKm + (peakWeeklyKm - currentWeeklyKm) * progress;
        const weekNum1based = w + 1;
        const isCutback = weekNum1based % 4 === 0 && weekNum1based !== buildWeeks;
        weekKm = isCutback ? linearKm * 0.8 : linearKm;
        phase = isCutback ? 'Cutback' : buildPhaseForWeek(w, buildWeeks);
      } else {
        const taperIdx = w - buildWeeks;
        const factor = taperFactors[taperIdx] ?? 0.5;
        weekKm = peakWeeklyKm * factor;
        phase = isRaceWeek ? 'Race Week' : 'Taper';
      }
      weekKm = Math.round(weekKm * 10) / 10;

      // Build the list of workout slots for this week.
      const template = isRaceWeek
        ? buildRaceWeekTemplate(daysPerWeek)
        : workoutTemplate(daysPerWeek, w);

      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = addDays(weekMonday, d);
        const dow = date.getDay();
        days.push({ date, dayName: DAY_NAMES[dow], dow, type: 'rest', km: 0 });
      }

      // Map ordered template slots onto the chronologically-sorted preferred days.
      const slotDays = sortedPreferredDays.slice(0, daysPerWeek);
      const nonLongSlots = template.filter(t => t !== 'longRun' && t !== 'race');
      let longRunKmThisWeek = isRaceWeek ? 0 : Math.min(weekKm * longRunShare, peakLongRunKm);
      if (!isRaceWeek) {
        const maxSafeLongRun = longRunRampBase + Math.max(longRunRampBase * MAX_LONG_RUN_JUMP_RATIO, MIN_LONG_RUN_JUMP_KM);
        if (longRunKmThisWeek > maxSafeLongRun) {
          longRunKmThisWeek = maxSafeLongRun;
          rampLimited = true;
        }
        longRunRampBase = Math.max(longRunRampBase, longRunKmThisWeek);
        actualPeakLongRunKm = Math.max(actualPeakLongRunKm, longRunKmThisWeek);
      }
      const remainingKm = weekKm - longRunKmThisWeek;
      const speedShare = 0.20;

      slotDays.forEach((dow, idx) => {
        const type = template[idx];
        const dayObj = days.find(x => x.dow === dow);
        if (!dayObj) return;

        if (type === 'race') {
          dayObj.type = 'race';
          dayObj.km = raceDistanceKm;
          dayObj.paceSecPerKm = goalPaceSec;
          return;
        }
        if (type === 'longRun') {
          dayObj.type = 'longRun';
          dayObj.km = Math.round(longRunKmThisWeek * 2) / 2;
          dayObj.paceSecPerKm = paces.longRun;
          return;
        }
        if (type === 'shakeout') {
          dayObj.type = 'shakeout';
          dayObj.km = Math.max(2, Math.round(currentWeeklyKm * 0.08));
          dayObj.paceSecPerKm = paces.easy;
          return;
        }

        // Distribute remainingKm across the non-long, non-race slots.
        const countOthers = nonLongSlots.length || 1;
        let km;
        if (type === 'tempo' || type === 'interval') {
          km = weekKm * speedShare;
        } else {
          const usedBySpeed = nonLongSlots.includes('tempo') || nonLongSlots.includes('interval') ? weekKm * speedShare : 0;
          const easySlots = nonLongSlots.filter(t => t === 'easy' || t === 'recovery').length || 1;
          km = (remainingKm - usedBySpeed) / easySlots;
        }
        dayObj.type = type;
        dayObj.km = Math.max(0, Math.round(km * 2) / 2);
        dayObj.paceSecPerKm = paces[type] ?? paces.easy;
      });

      const totalKm = Math.round(days.reduce((s, d) => s + (d.km || 0), 0) * 10) / 10;

      weeks.push({
        weekNumber: w + 1,
        startDate: weekMonday,
        endDate: addDays(weekMonday, 6),
        phase,
        totalKm,
        days,
      });
    }

    if (rampLimited) {
      warnings.push(`Long run puncak di jadwal ini (~${Math.round(actualPeakLongRunKm * 10) / 10} km) sengaja ditahan di bawah target ${Math.round(peakLongRunKm)} km, karena lari terjauhmu saat ini baru ${longestRecentRunKm} km — kenaikan jarak long run dinaikkan bertahap per minggu (maks ~20%) supaya aman dari cedera. Kalau waktu persiapanmu masih cukup panjang, ini normal dan long run akan terus naik mendekati race day.`);
    }

    return {
      meta: {
        raceLabel, raceDistanceKm, raceDate: race,
        planWeeks, taperWeeks, buildWeeks,
        peakWeeklyKm: Math.round(peakWeeklyKm * 10) / 10,
        peakLongRunKm: Math.round(actualPeakLongRunKm * 10) / 10,
        goalPaceSec, paces,
        planStart: firstMonday,
        weeksAvailable,
      },
      warnings,
      weeks,
    };
  }

  function buildRaceWeekTemplate(daysPerWeek) {
    // Race week: a couple of short shakeout runs, rest close to race day, then the race itself.
    const slots = [];
    for (let i = 0; i < daysPerWeek - 1; i++) slots.push('shakeout');
    slots.push('race');
    return slots;
  }

  return { generatePlan, formatPace, formatDate, TYPE_LABELS, DAY_NAMES };
})();
