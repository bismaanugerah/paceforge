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
 *   startDate: Date | null,   (when the runner wants to start training; defaults to today if omitted)
 *   fitnessLevel: 'beginner' | 'intermediate' | 'advanced',
 *   currentWeeklyKm: number,
 *   longestRecentRunKm: number,  (longest single run in the last ~3 months)
 *   daysPerWeek: number (3-6),
 *   preferredDays: number[]  (0=Sun ... 6=Sat, matches Date#getDay())
 *   longRunDay: number | null  (0=Sun ... 6=Sat, must be one of preferredDays)
 *   targetTimeSec: number | null   (goal finish time in seconds, or null)
 *   recentRaceTimeSec: number | null   (a recent race/time-trial result, or null)
 *   recentRaceDistanceKm: number | null   (distance that result was run over)
 *   conservativeMode: boolean   (dial back volume growth & speedwork for injury/pain)
 * }
 */

const PaceForgeGenerator = (() => {

  const DAY_NAMES = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', "Jum'at", 'Sabtu'];
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  const MS_PER_WEEK = 7 * MS_PER_DAY;

  // Recommended plan length / taper / peak long-run range per race type.
  // Values are generic heuristics (km), not sports-science guarantees.
  const RACE_PROFILES = {
    '5k':   { recWeeks: 8,  taperWeeks: 1, longRunMin: 8,  longRunMax: 12 },
    '10k':  { recWeeks: 10, taperWeeks: 1, longRunMin: 12, longRunMax: 16 },
    'half': { recWeeks: 12, taperWeeks: 2, longRunMin: 16, longRunMax: 19 },
    'full': { recWeeks: 16, taperWeeks: 3, longRunMin: 29, longRunMax: 32 },
  };

  // Absolute ceiling for a single non-long-run session (easy/recovery/
  // tempo/interval), in km, regardless of what its weeklySplitForDays share
  // would otherwise compute. The proportional split keeps every support
  // session smaller than that week's long run, but weekKm itself has no
  // upper bound of its own (it grows off currentWeeklyKm with no ceiling,
  // while the long run gets clamped to a race-appropriate absolute range —
  // see peakLongRunKm below) — so on a high-volume plan the *other*
  // sessions can still land at an unrealistic absolute distance even while
  // staying smaller than the long run (a 17km "tempo run" is not a tempo
  // run no matter how big that week's long run is). A tempo/interval
  // session's actual hard-effort portion is smaller still once warmup/
  // cooldown are subtracted (see buildTempoStructure/buildIntervalStructure).
  const MAX_SUPPORT_SESSION_KM = 15;

  // Default goal pace (sec/km) by fitness level, used only when the user
  // doesn't provide a target finish time. Roughly tuned per level; the
  // "advanced" runner is assumed faster than "beginner".
  const DEFAULT_GOAL_PACE_SEC = {
    beginner: 7 * 60 + 30,
    intermediate: 6 * 60,
    advanced: 4 * 60 + 45,
  };

  // When there's no explicit target time (that section of the form is
  // currently hidden — see js/app.js), goalPaceSec is derived purely from
  // a recent race, which makes it a same-day equivalent-fitness estimate —
  // identical to currentFitnessPaceSec by construction, with no gap left
  // to ramp toward across the build block (every week's pace target would
  // sit flat again despite weeks of training ahead). Project a small,
  // conservative pace improvement over the block instead — total fraction
  // achievable by a FULL recommended-length block (RACE_PROFILES.recWeeks)
  // at that fitness level, scaled down for a shorter/compressed block (see
  // buildWeeks/profile.recWeeks below) and halved again in conservative
  // mode. Deliberately modest: a runner already near their genetic ceiling
  // (advanced) has far less room to gain than a beginner in the same
  // window, and pace gains are much harder-won than the volume growth
  // WEEKLY_GROWTH_RATE below assumes.
  const CONSERVATIVE_FITNESS_GAIN_PCT = {
    beginner: 0.08,
    intermediate: 0.05,
    advanced: 0.03,
  };

  // Absolute floor for any pace this generator will ever schedule or treat
  // as a goal, in sec/km — well under the current marathon world record
  // pace (~2:50/km) and every shorter distance's, so it only ever catches a
  // genuinely broken input (a bad explicit-target entry, a fat-fingered
  // recent-race distance/time, a unit mixup) rather than a legitimately
  // fast target. Without this, a bad input silently produces a physically
  // impossible goal pace (e.g. sub-1-hour marathon) that the week-to-week
  // ramp then faithfully — but nonsensically — chases, which is what makes
  // that ramp look "extreme": the real defect is the target, not the ramp.
  const MIN_PLAUSIBLE_PACE_SEC_PER_KM = 2 * 60; // 2:00 /km

  // Training-zone pace = goalPaceSec * multiplier. Ordered slow -> fast.
  // repetition sits faster than interval, mirroring Daniels' R-pace <
  // I-pace < T-pace ordering (see js/vdot.js's ZONE_PCT_RANGES, which
  // orders the same 5 zones by %VO2max) — these multipliers are a much
  // rougher approximation than the VDOT table's (relative to *this race's*
  // goal pace rather than %VO2max), but the ordering matters more than the
  // exact value for how sessions feel relative to each other.
  const PACE_MULTIPLIERS = {
    recovery: 1.25,
    easy: 1.15,
    longRun: 1.10,
    tempo: 0.97,
    interval: 0.90,
    repetition: 0.83,
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

  // Total-duration formatter (h:mm:ss, or m:ss under an hour) — used for
  // race/finish times, as opposed to formatPace() which is per-km pace.
  function formatDuration(totalSec) {
    const s = Math.max(0, Math.round(totalSec));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const rem = s % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
    return `${m}:${String(rem).padStart(2, '0')}`;
  }

  // Riegel's race-time-prediction formula: predicts a finish time at
  // `toKm` from a known finish time at `fromKm`. The 1.06 exponent is the
  // standard endurance-fatigue factor used across most race predictors.
  function predictRaceTime(timeSec, fromKm, toKm) {
    return timeSec * Math.pow(toKm / fromKm, 1.06);
  }

  // How weekKm splits across the week's sessions, by days/week — long run
  // share plus a weight per non-long-run template slot, in the exact same
  // order workoutTemplate() below returns them (excluding 'longRun'
  // itself). Every entry's weights + longRunShare sum to 1.0.
  //
  // 3/4/5-day splits are pulled from published weekly-mileage-distribution
  // guidance (a long run needing to be a much bigger share of the week
  // when there are only 3-4 runs to carry it, easing down as more days
  // share the load):
  //   - 3 days: quality 20%, easy 30%, long run 50%
  //   - 4 days: easy 20%, quality 20%, easy 25%, long run 35%
  //   - 5 days: recovery-easy 15%, quality(intensity) 15%, medium-easy 20%,
  //     quality(threshold) 15%, long run 35%
  //   (source: runlovers.it "Weekly Mileage Distribution: How to Structure
  //   Your Running Volume")
  // 6 days isn't as commonly published with exact numbers — this is a
  // reasoned extrapolation of the same pattern (long run share keeps
  // easing down; total quality stays close to the classic 80/20
  // easy:hard split) rather than a directly-sourced figure.
  function weeklySplitForDays(daysPerWeek) {
    switch (daysPerWeek) {
      // ['easy', quality]
      case 3: return { longRunShare: 0.50, slotWeights: [0.30, 0.20] };
      // ['easy', quality, 'easy']
      case 4: return { longRunShare: 0.35, slotWeights: [0.20, 0.20, 0.25] };
      // ['easy', quality, 'easy', quality2] — quality/quality2 are whichever
      // workout qualityPick() rotates in that week (tempo/interval/
      // repetition), not literally always tempo — see QUALITY_ROTATION.
      case 5: return { longRunShare: 0.35, slotWeights: [0.15, 0.15, 0.20, 0.15] };
      // ['easy', quality, 'easy', quality2, 'recovery']
      case 6: return { longRunShare: 0.27, slotWeights: [0.18, 0.12, 0.21, 0.12, 0.10] };
      // Fallback for anything outside the 3-6 range the form actually offers.
      default: return { longRunShare: 0.50, slotWeights: [0.50] };
    }
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

  // How many "quality" (tempo/interval/repetition — see QUALITY_TYPES)
  // sessions to schedule per week, by
  // total running days/week — researched against real coaching guidance
  // rather than picked arbitrarily:
  //   - Jack Daniels' Running Formula: beginners get 1 quality day/week;
  //     more experienced runners can handle up to 3, but ALWAYS with at
  //     least one easy/rest day between quality sessions (hard days can't
  //     stack) — 3 is a ceiling, not a default.
  //   - Hal Higdon's marathon plans (5-6 days/week): Intermediate tiers run
  //     ZERO quality days even at that frequency (pure aerobic volume);
  //     Advanced 1 adds exactly 1, Advanced 2 exactly 2 — 2 quality
  //     sessions/week is the common ceiling for a general-purpose amateur
  //     plan, not 3, even at 6 days/week.
  //   - Multiple independently-published 6-day/week plans converge on the
  //     same shape: quality, easy, easy, quality, easy, long, rest — i.e.
  //     2 quality sessions, not 3, regardless of the extra running day.
  // Net rule this plan follows: 1 quality session at 3-4 days/week (not
  // enough easy-day buffer to safely fit a 2nd), 2 quality sessions at 5-6
  // days/week (the 6th day's extra volume goes to another easy/recovery
  // run, not a 3rd hard day — matching every source above). Expressed as
  // Math.max(1, Math.floor((daysPerWeek - 1) / 2)) below for traceability;
  // workoutTemplate's literal per-day arrays are what's actually scheduled
  // and are hand-verified to match this count exactly.
  function qualitySessionsForDays(daysPerWeek) {
    return Math.max(1, Math.floor((daysPerWeek - 1) / 2));
  }

  // Shared by workoutTemplate's day-assignment (prioritize these onto
  // weekdays — see below) and applyConservativeAdjustment (shift weight
  // off these onto easy/recovery slots).
  const QUALITY_TYPES = new Set(['tempo', 'interval', 'repetition']);

  // Which specific workout occupies a week's quality slot(s) — rotates
  // through popular, well-documented variations on Daniels' T/I/R paces
  // instead of the same flat tempo/interval shape every week:
  //   - Interval (I pace): rep length varies — short (~400m), mid (~800m),
  //     long (~1000-1200m). Varying rep distance week to week is standard
  //     interval-training practice (e.g. Daniels' Running Formula's own
  //     workout tables span 200m-1600m reps at I pace).
  //   - Tempo (T pace): a classic continuous tempo block, or "cruise
  //     intervals" — repeated ~1-1.6km T-pace segments with a short jog
  //     recovery between each. Cruise intervals are Daniels' own preferred
  //     way for most runners to accumulate T-pace volume, since holding
  //     the pace in chunks is easier to sustain than one long continuous
  //     block at the same total distance.
  //   - Repetition (R pace): short (~200m) reps at faster-than-interval
  //     pace with full recovery between each — builds speed and running
  //     economy. Daniels recommends occasional R work year-round (not
  //     only in a dedicated speed phase), so it's mixed into the rotation
  //     rather than gated to a specific training phase.
  // Cycles every 6 weeks. A week with 2 quality slots (5-6 days/week
  // plans) reads its 2nd slot 3 positions ahead of the 1st in this same
  // array (see qualityPick's slotOffset) — since every entry differs from
  // the one 3 positions away, the two slots in any given week are always a
  // different pick, without needing a separate rotation for each slot.
  const QUALITY_ROTATION = [
    { type: 'interval', variant: 'mid' },
    { type: 'tempo', variant: 'continuous' },
    { type: 'interval', variant: 'short' },
    { type: 'tempo', variant: 'cruise' },
    { type: 'interval', variant: 'long' },
    { type: 'repetition', variant: null },
  ];

  // Resolves one quality slot's workout for a given week. slotOffset
  // distinguishes a week's 1st quality slot (0) from its 2nd (half the
  // rotation's length, see QUALITY_ROTATION above) so the two never land
  // on the same pick. Conservative mode (injury/pain flagged by the user)
  // skips repetition specifically — full-recovery, faster-than-interval
  // reps carry more per-stride risk than steady tempo/interval effort —
  // falling back to a continuous tempo session in its place instead of
  // just being removed from the rotation (that fallback keeps every
  // week's quality-session *count* exactly as qualitySessionsForDays
  // expects; only the affected slot's own workout changes).
  function qualityPick(weekIndex, slotOffset, conservativeMode) {
    const idx = (weekIndex + slotOffset) % QUALITY_ROTATION.length;
    const pick = QUALITY_ROTATION[idx];
    if (conservativeMode && pick.type === 'repetition') {
      return { type: 'tempo', variant: 'continuous' };
    }
    return pick;
  }

  /** Ordered workout-type template for a given days-per-week, excluding long run
   * which is always appended last (and mapped to the last selected day).
   * primaryType/secondaryType come from qualityPick(...).type — resolved
   * once by the caller (generatePlan) and reused both here and when
   * building that day's actual workout structure, so the two stay in sync. */
  function workoutTemplate(daysPerWeek, primaryType, secondaryType) {
    switch (daysPerWeek) {
      case 3: return ['easy', primaryType, 'longRun']; // 1 quality session — see qualitySessionsForDays
      case 4: return ['easy', primaryType, 'easy', 'longRun']; // 1 quality session
      case 5: return ['easy', primaryType, 'easy', secondaryType, 'longRun']; // 2 quality sessions
      case 6: return ['easy', primaryType, 'easy', secondaryType, 'recovery', 'longRun']; // 2 quality sessions — extra 6th day is recovery, not a 3rd hard day
      default: {
        // The form only offers 3-6 days/week, so this is unreachable today —
        // a safety net if that range ever changes. Built from the same rule
        // as the hand-tuned cases above (capped at 2 quality sessions, same
        // ceiling as the 5/6-day cases, rather than letting the formula's
        // theoretical 3-session cap for 7+ days/week onto an untested path).
        const qualityCount = Math.min(qualitySessionsForDays(daysPerWeek), 2);
        const easyCount = Math.max(daysPerWeek - qualityCount - 1, 0);
        const qualitySlots = qualityCount >= 2 ? [primaryType, secondaryType] : [primaryType];
        return [...Array(easyCount).fill('easy'), ...qualitySlots, 'longRun'];
      }
    }
  }

  // Conservative mode (injury/pain flagged by the user) dials back
  // speedwork same as it always has, just applied to the new weighted
  // split instead of the old flat speedShare formula: shift ~35% of each
  // quality (tempo/interval/repetition) slot's weight over to the easy/recovery
  // slots, in the same order/shape as `types` (which must be the
  // non-long-run template slots, e.g. restTemplate below).
  function applyConservativeAdjustment(types, weights) {
    let reclaimed = 0;
    const adjusted = weights.map((w, i) => {
      if (!QUALITY_TYPES.has(types[i])) return w;
      const cut = w * 0.35;
      reclaimed += cut;
      return w - cut;
    });
    const easyIdxs = types.map((t, i) => (t === 'easy' || t === 'recovery') ? i : -1).filter(i => i >= 0);
    if (easyIdxs.length && reclaimed > 0) {
      const share = reclaimed / easyIdxs.length;
      easyIdxs.forEach(i => { adjusted[i] += share; });
    }
    return adjusted;
  }

  // Visual workout-structure breakdown for every non-rest/race session,
  // expressed in distance (km) — not time — so the bar's segment widths line
  // up with the "Jarak" column already shown for that day: a continuous run
  // (easy/recovery/long run/shakeout) is one solid low-exertion block, while
  // interval/cruise-tempo/repetition sessions break down into warm up +
  // work/recovery reps + cool down, derived from that day's own computed
  // distance. Purely additive for the UI's workout-structure bar; day.km and
  // day.paceSecPerKm (used for weekly totals) are untouched.
  function buildSimpleStructure(sessionKm) {
    return { kind: 'simple', km: sessionKm, exertion: 'low' };
  }

  // Shared builder behind every "warm up -> N reps (work + recovery) -> cool
  // down" workout — real intervals, cruise-style tempo, and repetition all
  // have this exact shape, just with different rep/recovery distances and
  // effort (see INTERVAL_VARIANT_PROFILES / TEMPO_CRUISE_PROFILE /
  // REPETITION_PROFILE below). `profile` supplies repKm/recoveryKm/minReps/
  // maxReps/workExertion plus the warmup/cooldown sizing (as a fraction of
  // sessionKm, clamped to a sensible absolute range).
  function buildRepsStructure(sessionKm, profile) {
    const { repKm, recoveryKm, minReps, maxReps, workExertion, warmupFrac, warmupMin, warmupMax, cooldownFrac, cooldownMin, cooldownMax } = profile;
    const warmupKm = clamp(sessionKm * warmupFrac, warmupMin, warmupMax);
    const cooldownKm = clamp(sessionKm * cooldownFrac, cooldownMin, cooldownMax);
    const workoutKm = Math.max(sessionKm - warmupKm - cooldownKm, repKm + recoveryKm);
    const reps = clamp(Math.round(workoutKm / (repKm + recoveryKm)), minReps, maxReps);
    return { kind: 'interval', warmupKm, cooldownKm, reps, workKm: repKm, workExertion, recoveryKm };
  }

  // Interval (I-pace) rep-distance variants — see QUALITY_ROTATION above for
  // why/when each one gets picked. repKm/recoveryKm approximate common
  // track-workout distances; minReps/maxReps keep the rep count realistic
  // for that distance (more short reps fit in a session than long ones).
  const INTERVAL_VARIANT_PROFILES = {
    short: { repKm: 0.4, recoveryKm: 0.25, minReps: 5, maxReps: 12 }, // ~400m
    mid:   { repKm: 0.8, recoveryKm: 0.4,  minReps: 4, maxReps: 8 },  // ~800m
    long:  { repKm: 1.2, recoveryKm: 0.5,  minReps: 3, maxReps: 6 },  // ~1000-1200m
  };

  function buildIntervalStructure(sessionKm, fitnessLevel, conservativeMode, variant) {
    const repProfile = INTERVAL_VARIANT_PROFILES[variant] || INTERVAL_VARIANT_PROFILES.mid;
    const workExertion = conservativeMode ? 'moderate' : (fitnessLevel === 'beginner' ? 'moderate' : 'high');
    return buildRepsStructure(sessionKm, {
      ...repProfile, workExertion,
      warmupFrac: 0.2, warmupMin: 1, warmupMax: 2.5,
      cooldownFrac: 0.15, cooldownMin: 1, cooldownMax: 2,
    });
  }

  // Cruise intervals: ~1 mile (1.6km) T-pace segments with a short jog
  // recovery between — Daniels' own preferred way to accumulate T-pace
  // volume for most runners (see QUALITY_ROTATION above).
  const TEMPO_CRUISE_PROFILE = { repKm: 1.6, recoveryKm: 0.3, minReps: 2, maxReps: 4 };

  function buildTempoStructure(sessionKm, variant) {
    if (variant === 'cruise') {
      return buildRepsStructure(sessionKm, {
        ...TEMPO_CRUISE_PROFILE, workExertion: 'moderate',
        warmupFrac: 0.2, warmupMin: 1, warmupMax: 2,
        cooldownFrac: 0.15, cooldownMin: 1, cooldownMax: 1.5,
      });
    }
    const warmupKm = clamp(sessionKm * 0.25, 1, 2);
    const cooldownKm = clamp(sessionKm * 0.2, 1, 1.5);
    const tempoKm = Math.max(sessionKm - warmupKm - cooldownKm, 1);
    return { kind: 'tempo', warmupKm, cooldownKm, tempoKm };
  }

  // Repetition (R-pace): short (~200m) reps with generous, full recovery —
  // speed/running-economy work, always high-exertion per rep regardless of
  // fitness level or conservative mode (conservative mode instead skips
  // repetition entirely — see qualityPick above — rather than watering this
  // down, since a slow 200m isn't really repetition work any more).
  const REPETITION_PROFILE = { repKm: 0.2, recoveryKm: 0.3, minReps: 4, maxReps: 10 };

  // Kept deliberately short overall (see MAX_REPETITION_SESSION_KM below) —
  // real repetition sessions are brief-but-intense, not a distance workout.
  function buildRepetitionStructure(sessionKm) {
    return buildRepsStructure(sessionKm, {
      ...REPETITION_PROFILE, workExertion: 'high',
      warmupFrac: 0.35, warmupMin: 1, warmupMax: 1.5,
      cooldownFrac: 0.25, cooldownMin: 0.5, cooldownMax: 1,
    });
  }

  // Absolute ceiling for a repetition session specifically — tighter than
  // MAX_SUPPORT_SESSION_KM (which still applies to every other non-long-run
  // session type, tempo/interval included): real repetition workouts are
  // short bursts with lots of standing/jogging recovery, not a distance
  // session, so letting one scale up like a tempo run would misrepresent
  // what the workout actually is.
  const MAX_REPETITION_SESSION_KM = 8;

  const TYPE_LABELS = {
    recovery: 'Lari Pemulihan',
    easy: 'Lari Santai',
    longRun: 'Lari Jarak Jauh',
    tempo: 'Tempo Run',
    interval: 'Interval / Speedwork',
    repetition: 'Repetition',
    shakeout: 'Lari Ringan (Shakeout)',
    rest: 'Istirahat',
    race: 'RACE DAY! 🏁',
  };

  function generatePlan(settings) {
    const {
      raceDistanceKm, raceLabel, raceKey, raceDate, startDate,
      fitnessLevel, currentWeeklyKm, longestRecentRunKm, daysPerWeek, preferredDays, longRunDay,
      targetTimeSec, recentRaceTimeSec, recentRaceDistanceKm, conservativeMode,
    } = settings;

    // Anchor for "how many weeks do I actually have before race day" — the
    // date the runner wants to start training, not necessarily today (e.g.
    // they're finishing up something else first). Falls back to today when
    // not given, which is the previous, unconditional behaviour.
    const planStartAnchor = startOfDay(startDate || new Date());
    const race = startOfDay(raceDate);
    const profile = resolveRaceProfile(raceDistanceKm, raceKey);
    // Marathon-specific long run (MSL): a long run carrying goal marathon
    // pace, only meaningful for full-marathon plans, and only scheduled
    // during the Peak phase — the block of build weeks with the highest
    // long-run distances, right before taper (see buildPhaseForWeek).
    const isFullMarathonPlan = profile === RACE_PROFILES.full;

    const daysUntilRace = Math.round((race - planStartAnchor) / MS_PER_DAY);
    const weeksAvailable = Math.max(1, Math.floor(daysUntilRace / 7));

    let planWeeks = Math.min(weeksAvailable, profile.recWeeks);
    let taperWeeks = Math.min(profile.taperWeeks, Math.max(planWeeks - 1, 0));
    let buildWeeks = Math.max(planWeeks - taperWeeks, 1);

    // Same safe compounding weekly rate used for the race-specific block's
    // own volume ramp below (peakWeeklyKm) — reused here for the pre-block
    // "prep phase" suggestion (extraWeeks below) so both give a
    // consistent, evidence-based sense of how fast weekly mileage can
    // safely grow, rather than two different numbers.
    const WEEKLY_GROWTH_RATE = conservativeMode ? 1.05 : 1.08;

    const warnings = [];
    if (conservativeMode) {
      warnings.push('Mode latihan konservatif aktif — kenaikan volume mingguan, porsi speedwork, dan kenaikan jarak long run di plan ini sengaja diturunkan untuk menjaga cedera/nyeri yang kamu tandai. Kalau nyeri berlanjut, konsultasikan ke dokter/fisioterapis olahraga.');
    }
    if (weeksAvailable < profile.recWeeks) {
      warnings.push(`Waktu persiapanmu (${weeksAvailable} minggu) lebih pendek dari rekomendasi umum untuk ${raceLabel} (${profile.recWeeks} minggu). Plan ini dipadatkan — fokus jaga konsistensi dan hindari lompatan volume terlalu besar.`);
    }
    const extraWeeks = weeksAvailable - profile.recWeeks;
    if (extraWeeks > 0) {
      // Not "just hold steady" — a runner with this much lead time can (and
      // should) use it to build a stronger aerobic base before the
      // race-specific block starts, the same way real periodization works
      // (a base/prep phase ahead of the structured build). Suggest a
      // concrete target using the same safe per-week growth rate the block
      // itself ramps volume by, rather than a flat "just maintain X km" —
      // floored at 3 km/week so a brand-new runner (currentWeeklyKm 0)
      // still gets a sensible non-zero number to aim for.
      //
      // Two guardrails distinct from the race-block's own peakWeeklyKm
      // growth cap (3.2x/2.2x) below, which is a loose internal anchor
      // that downstream clamps (peakLongRunKm's absolute range, per-session
      // caps) rein in before it becomes a real schedule number — applying
      // it directly here as a literal target would produce nonsense (e.g.
      // naively compounding 8%/week for 17 straight weeks implies ~3.2x,
      // i.e. suggesting 42 km/week become ~134 km/week, an ultra-runner's
      // volume, which is neither realistic nor safe to suggest):
      //   1. Nobody should compound weekly growth uninterrupted for months
      //      — real base-building still needs periodic easier weeks — so
      //      only apply growth across at most a full recommended block's
      //      worth of weeks even if extraWeeks is bigger than that.
      //   2. Cap the total prep-phase gain at a much smaller, genuinely
      //      achievable multiple of today's mileage.
      const PREP_GROWTH_CAP = conservativeMode ? 1.3 : 1.6;
      const prepStartKm = Math.max(currentWeeklyKm, 3);
      const prepGrowthWeeks = Math.min(extraWeeks, profile.recWeeks);
      const prepGrowthMultiplier = clamp(Math.pow(WEEKLY_GROWTH_RATE, prepGrowthWeeks), 1, PREP_GROWTH_CAP);
      const prepTargetWeeklyKm = Math.round(prepStartKm * prepGrowthMultiplier);
      warnings.push(`Kamu punya ${extraWeeks} minggu ekstra sebelum race. Plan detail di bawah mencakup ${planWeeks} minggu terakhir (training block ${raceLabel} standar) — sebelum itu, manfaatkan buat naikkan base mileage bertahap dari ~${Math.round(prepStartKm)} ke sekitar ${prepTargetWeeklyKm} km/minggu (kira-kira +${Math.round((WEEKLY_GROWTH_RATE - 1) * 100)}% tiap minggu, laju kenaikan aman yang sama dipakai di plan ini). Plan di bawah tetap dihitung dari kondisimu sekarang — generate ulang lebih dekat ke tanggal mulai training kalau base mileage-mu sudah naik, supaya peak volume & long run-nya ikut menyesuaikan jadi lebih kuat.`);
    }

    // Goal pace (sec/km), in priority order:
    //   1. Explicit target finish time, if the user set one.
    //   2. A finish time predicted from a recent race/time-trial result at any
    //      distance (Riegel formula) — the closer that distance is to the
    //      target race, the more accurate the prediction.
    //   3. A generic default per fitness level.
    let goalPaceSec;
    let goalPaceSource;
    let predictedRaceTimeSec = null;
    if (targetTimeSec) {
      goalPaceSec = targetTimeSec / raceDistanceKm;
      goalPaceSource = 'explicit';
    } else if (recentRaceTimeSec && recentRaceDistanceKm) {
      predictedRaceTimeSec = predictRaceTime(recentRaceTimeSec, recentRaceDistanceKm, raceDistanceKm);
      const currentEquivPaceSec = predictedRaceTimeSec / raceDistanceKm;
      const gainFraction = CONSERVATIVE_FITNESS_GAIN_PCT[fitnessLevel]
        * clamp(buildWeeks / profile.recWeeks, 0, 1)
        * (conservativeMode ? 0.5 : 1);
      goalPaceSec = currentEquivPaceSec * (1 - gainFraction);
      goalPaceSource = 'recentRace';
    } else {
      goalPaceSec = DEFAULT_GOAL_PACE_SEC[fitnessLevel];
      goalPaceSource = 'fitnessLevel';
    }
    if (goalPaceSec < MIN_PLAUSIBLE_PACE_SEC_PER_KM) {
      warnings.push(`Target pace yang terhitung (${formatPace(goalPaceSec)}) secara fisik tidak mungkin dicapai manusia — kemungkinan ada input yang keliru (waktu/jarak target atau race terakhir). Dibatasi otomatis ke ${formatPace(MIN_PLAUSIBLE_PACE_SEC_PER_KM)} supaya plan tetap masuk akal; cek kembali inputmu.`);
      goalPaceSec = MIN_PLAUSIBLE_PACE_SEC_PER_KM;
    }

    const paces = {};
    Object.keys(PACE_MULTIPLIERS).forEach(zone => {
      paces[zone] = goalPaceSec * PACE_MULTIPLIERS[zone];
    });
    paces.goal = goalPaceSec;

    // Current-fitness pace (sec/km at the goal race distance) — the pace
    // targets scheduled week-to-week ramp from this toward goalPaceSec
    // across the build block, instead of every session (week 1 through
    // taper) sitting at the same goal-derived pace. Priority order:
    //   1. A recent race/time-trial result, translated to the goal
    //      distance (Riegel) — the direct "where the runner's fitness is
    //      right now" signal, same formula used for goalPaceSource
    //      'recentRace' above. When that's also *how* goalPaceSec itself
    //      was derived (no separate explicit target), this comes out
    //      identical to goalPaceSec, so the ramp is naturally flat — there's
    //      no separate "current" data point in that case, just the one
    //      estimate.
    //   2. When the user set an explicit target instead (goal pace is
    //      aspirational, e.g. a finish-time PR goal), but gave no recent
    //      race to anchor "current" ability: fall back to the generic
    //      per-fitness-level pace as a stand-in current-ability estimate,
    //      clamped so it's never faster than the goal itself (a runner
    //      can't be ramping "up" to a slower goal).
    //   3. Otherwise goalPaceSec is already the generic fitness-level
    //      estimate with nothing more specific to ramp from — flat.
    let currentFitnessPaceSec;
    if (recentRaceTimeSec && recentRaceDistanceKm) {
      currentFitnessPaceSec = predictRaceTime(recentRaceTimeSec, recentRaceDistanceKm, raceDistanceKm) / raceDistanceKm;
    } else if (goalPaceSource === 'explicit') {
      currentFitnessPaceSec = Math.max(goalPaceSec, DEFAULT_GOAL_PACE_SEC[fitnessLevel]);
    } else {
      currentFitnessPaceSec = goalPaceSec;
    }
    if (currentFitnessPaceSec < MIN_PLAUSIBLE_PACE_SEC_PER_KM) {
      currentFitnessPaceSec = MIN_PLAUSIBLE_PACE_SEC_PER_KM;
    }
    const currentPaces = {};
    Object.keys(PACE_MULTIPLIERS).forEach(zone => {
      currentPaces[zone] = currentFitnessPaceSec * PACE_MULTIPLIERS[zone];
    });
    currentPaces.goal = currentFitnessPaceSec;

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
    // In conservative mode (injury/pain flagged by the user) volume is grown
    // more slowly and capped lower, on top of the ramp/jump guardrails below.
    // (WEEKLY_GROWTH_RATE itself is declared earlier, alongside the
    // extraWeeks prep-phase warning that reuses it.)
    const growthMultiplier = clamp(Math.pow(WEEKLY_GROWTH_RATE, buildWeeks), 1.15, conservativeMode ? 2.2 : 3.2);
    const { longRunShare, slotWeights: baseSlotWeights } = weeklySplitForDays(daysPerWeek);
    // Theoretical growth target — deliberately NOT what the week-by-week
    // ramp targets (see peakWeeklyKm below). Only used to anchor
    // peakLongRunKm within the race-appropriate absolute range; it has no
    // ceiling of its own and can compound well past anything actually
    // deliverable once session caps are accounted for.
    const theoreticalPeakWeeklyKm = Math.max(currentWeeklyKm * growthMultiplier, currentWeeklyKm); // never plan below current base

    // Aim for the race's recommended long-run range — longRunShare already
    // reflects a realistic per-days-per-week share (see weeklySplitForDays),
    // clamped to the race-appropriate absolute range.
    const peakLongRunKm = clamp(theoreticalPeakWeeklyKm * longRunShare, profile.longRunMin, profile.longRunMax);

    // The REAL peak weekly volume this plan will ever schedule: peakLongRunKm
    // (above) plus whatever each support slot (easy/recovery/tempo/interval)
    // actually caps out at — the same MAX_SUPPORT_SESSION_KM and
    // "never >= that week's long run" ceilings the per-day loop below
    // enforces, evaluated here up front. Ramping week-by-week progress
    // toward THIS (rather than the unbounded theoreticalPeakWeeklyKm) is
    // what makes the plan actually climb gradually across the whole build
    // block and peak only in its final week(s) — ramping toward the
    // theoretical number instead made every week identical for however long
    // it took theoreticalPeakWeeklyKm's growth to run past what the caps
    // allow, because the *visible* schedule hit its ceiling in, say, week 5
    // of a 13-week build block and had nowhere further to go for the
    // remaining 8.
    const peakWeeklyKm = peakLongRunKm + baseSlotWeights.reduce(
      (sum, w) => sum + Math.min(theoreticalPeakWeeklyKm * w, MAX_SUPPORT_SESSION_KM, peakLongRunKm * 0.95),
      0
    );

    // Safe long-run ramp: don't let the scheduled long run jump up from the
    // runner's actual longest recent run any faster than a sensible weekly
    // increment (~20%, or 1.5km for very short current long runs, whichever
    // is bigger). The ramp base only ever grows (tracks the highest long run
    // scheduled so far) so a cutback week doesn't reset the allowance.
    const longRunStartKm = Math.max(longestRecentRunKm || 0, 2);
    let longRunRampBase = longRunStartKm;
    const MAX_LONG_RUN_JUMP_RATIO = conservativeMode ? 0.15 : 0.2;
    const MIN_LONG_RUN_JUMP_KM = conservativeMode ? 1 : 1.5;

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
    let supportSessionCapped = false;
    let actualPeakWeeklyKm = 0;

    for (let w = 0; w < planWeeks; w++) {
      const weekMonday = addDays(firstMonday, w * 7);
      const isTaperWeek = w >= buildWeeks;
      const isRaceWeek = w === planWeeks - 1;

      let weekKm;
      let longRunTargetKm; // this week's long run before the ramp-safety clamp further below
      let phase;
      let paceProgress; // 0 (currentFitnessPaceSec) -> 1 (goalPaceSec); see weekPaces below
      if (!isTaperWeek) {
        const progress = buildWeeks === 1 ? 1 : (w + 1) / buildWeeks;
        paceProgress = progress;
        let linearKm = currentWeeklyKm + (peakWeeklyKm - currentWeeklyKm) * progress;
        // Long run gets its own direct progress-based ramp toward
        // peakLongRunKm — rather than being derived as weekKm*longRunShare
        // — so it reliably reaches the intended race-appropriate distance
        // on the final build week regardless of how weekKm's own
        // progression interacts with the support-session caps above.
        let linearLongRunKm = longRunStartKm + (peakLongRunKm - longRunStartKm) * progress;
        const weekNum1based = w + 1;
        const isCutback = weekNum1based % 4 === 0 && weekNum1based !== buildWeeks;
        weekKm = isCutback ? linearKm * 0.8 : linearKm;
        longRunTargetKm = isCutback ? linearLongRunKm * 0.8 : linearLongRunKm;
        phase = isCutback ? 'Cutback' : buildPhaseForWeek(w, buildWeeks);
      } else {
        const taperIdx = w - buildWeeks;
        const factor = taperFactors[taperIdx] ?? 0.5;
        weekKm = peakWeeklyKm * factor;
        // Taper reduces the long run by the same factor directly, rather
        // than through weekKm*longRunShare — standard taper design (e.g.
        // "75% of peak long run" in the first taper week).
        longRunTargetKm = peakLongRunKm * factor;
        phase = isRaceWeek ? 'Race Week' : 'Taper';
        // Taper is about cutting volume, not intensity/precision — by now
        // the runner should be able to hold goal pace, so pace targets
        // don't taper back down with the mileage.
        paceProgress = 1;
      }
      weekKm = Math.round(weekKm * 10) / 10;

      // This week's zone paces — interpolated between currentPaces (week 1
      // of the build block) and paces/goalPaceSec (peak/race pace), by
      // paceProgress above. Ramping this alongside the volume ramp is what
      // makes early-week quality sessions (interval/tempo/long run) run at
      // a pace the runner can actually hold right now, tightening toward
      // race-goal pace as the block progresses — rather than every week's
      // "Pace Target" column showing the same number from week 1 through
      // race day.
      const weekPaces = {};
      Object.keys(PACE_MULTIPLIERS).forEach(zone => {
        weekPaces[zone] = currentPaces[zone] + (paces[zone] - currentPaces[zone]) * paceProgress;
      });
      weekPaces.goal = currentFitnessPaceSec + (goalPaceSec - currentFitnessPaceSec) * paceProgress;

      // Which specific workout (type + variant) fills this week's 1st/2nd
      // quality slot — resolved once here so workoutTemplate (deciding
      // *where* each type lands) and the per-day structure builder further
      // below (deciding *what shape* that type's session takes) always
      // agree, instead of picking the rotation twice and risking drift.
      const qualityPrimary = qualityPick(w, 0, conservativeMode);
      const qualitySecondary = qualityPick(w, 3, conservativeMode);

      // Build the list of workout slots for this week.
      const template = isRaceWeek
        ? buildRaceWeekTemplate(daysPerWeek)
        : workoutTemplate(daysPerWeek, qualityPrimary.type, qualitySecondary.type);

      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = addDays(weekMonday, d);
        const dow = date.getDay();
        days.push({ date, dayName: DAY_NAMES[dow], dow, type: 'rest', km: 0 });
      }

      // Map ordered template slots onto the chronologically-sorted preferred days.
      const slotDays = sortedPreferredDays.slice(0, daysPerWeek);

      // Which type (and, for non-long/race slots, what share of weekKm —
      // see weeklySplitForDays) lands on which day-of-week. Race week keeps
      // its existing index-based mapping (race always on the last slot).
      // Build/taper weeks instead pin the long run to the user's chosen
      // long-run day — falling back to the last chronological slot if that
      // day somehow isn't selected this week — and fill the remaining
      // slots with the rest of the template, in order, on the other
      // selected days, each carrying its matching weeklySplitForDays weight.
      const typeByDow = {};
      const weightByDow = {};
      if (isRaceWeek) {
        slotDays.forEach((dow, idx) => { typeByDow[dow] = template[idx]; });
      } else {
        const longRunDow = slotDays.includes(longRunDay) ? longRunDay : slotDays[slotDays.length - 1];
        const restTemplate = template.filter(t => t !== 'longRun');
        const restWeights = conservativeMode
          ? applyConservativeAdjustment(restTemplate, baseSlotWeights)
          : baseSlotWeights;

        // Quality (tempo/interval) sessions get first claim on weekday
        // (Mon-Fri) slots wherever there's a choice — long run (and often
        // an easy/recovery day) already anchors the weekend, and a hard
        // effort fits a normal weekday routine better than competing with
        // weekend long-run recovery. Only spills onto a weekend day if
        // there aren't enough weekday slots this week to hold every
        // quality session (e.g. daysPerWeek=5 with just 2 weekdays picked).
        // Non-quality slots (easy/recovery) fill whatever's left over, kept
        // in their original template order to preserve which slot carries
        // which weeklySplitForDays weight (see restWeights above).
        const nonLongRunDaysChrono = slotDays.filter(dow => dow !== longRunDow);
        const isWeekendDow = dow => dow === 0 || dow === 6;
        const weekdayDays = nonLongRunDaysChrono.filter(dow => !isWeekendDow(dow));
        const weekendDays = nonLongRunDaysChrono.filter(isWeekendDow);
        const qualityIdx = restTemplate.map((t, i) => i).filter(i => QUALITY_TYPES.has(restTemplate[i]));
        const nonQualityIdx = restTemplate.map((t, i) => i).filter(i => !QUALITY_TYPES.has(restTemplate[i]));

        const usedWeekdayForQuality = Math.min(qualityIdx.length, weekdayDays.length);
        const usedWeekendForQuality = Math.max(0, qualityIdx.length - weekdayDays.length);
        const qualityDays = [
          ...weekdayDays.slice(0, usedWeekdayForQuality),
          ...weekendDays.slice(0, usedWeekendForQuality),
        ];
        // Restore chronological (Mon..Sun) order among whatever's left for
        // the non-quality slots, same ordering rule used for sortedPreferredDays.
        const leftoverDays = [...weekdayDays.slice(usedWeekdayForQuality), ...weekendDays.slice(usedWeekendForQuality)]
          .sort((a, b) => (a === 0 ? 7 : a) - (b === 0 ? 7 : b));

        typeByDow[longRunDow] = 'longRun';
        qualityIdx.forEach((templateIdx, i) => {
          const dow = qualityDays[i];
          typeByDow[dow] = restTemplate[templateIdx];
          weightByDow[dow] = restWeights[templateIdx];
        });
        nonQualityIdx.forEach((templateIdx, i) => {
          const dow = leftoverDays[i];
          typeByDow[dow] = restTemplate[templateIdx];
          weightByDow[dow] = restWeights[templateIdx];
        });
      }
      let longRunKmThisWeek = isRaceWeek ? 0 : Math.min(longRunTargetKm, peakLongRunKm);
      if (!isRaceWeek) {
        const maxSafeLongRun = longRunRampBase + Math.max(longRunRampBase * MAX_LONG_RUN_JUMP_RATIO, MIN_LONG_RUN_JUMP_KM);
        if (longRunKmThisWeek > maxSafeLongRun) {
          longRunKmThisWeek = maxSafeLongRun;
          rampLimited = true;
        }
        longRunRampBase = Math.max(longRunRampBase, longRunKmThisWeek);
        actualPeakLongRunKm = Math.max(actualPeakLongRunKm, longRunKmThisWeek);
      }

      slotDays.forEach((dow) => {
        const type = typeByDow[dow];
        const dayObj = days.find(x => x.dow === dow);
        if (!dayObj) return;

        if (type === 'race') {
          dayObj.type = 'race';
          dayObj.km = raceDistanceKm;
          dayObj.paceSecPerKm = goalPaceSec;
          return;
        }
        if (type === 'longRun') {
          const isMSL = isFullMarathonPlan && phase === 'Peak';
          dayObj.type = 'longRun';
          dayObj.km = Math.round(longRunKmThisWeek * 2) / 2;
          dayObj.paceSecPerKm = isMSL ? weekPaces.goal : weekPaces.longRun;
          dayObj.isMarathonSpecific = isMSL;
          if (dayObj.km > 0) dayObj.structure = buildSimpleStructure(dayObj.km);
          return;
        }
        if (type === 'shakeout') {
          dayObj.type = 'shakeout';
          dayObj.km = Math.max(2, Math.round(currentWeeklyKm * 0.08));
          dayObj.paceSecPerKm = weekPaces.easy;
          if (dayObj.km > 0) dayObj.structure = buildSimpleStructure(dayObj.km);
          return;
        }

        // This slot's share of weekKm comes straight from
        // weeklySplitForDays (see weightByDow above) — every non-long-run
        // weight is already < longRunShare by construction, and weekKm's own
        // progression is bounded by peakWeeklyKm (which is itself derived
        // from these same caps — see its definition above), so under normal
        // progression no support session can land bigger than the long run
        // or past MAX_SUPPORT_SESSION_KM. Two safety nets on top of that
        // anyway, for edge cases (e.g. a currentWeeklyKm input that's
        // already high relative to daysPerWeek), neither of which
        // redistributes the trimmed volume elsewhere (a lower actual weekKm
        // total is safer than forcing it into one oversized day):
        //   1. The ramp guardrail above can hold longRunKmThisWeek below its
        //      progress-based target without shrinking the other slots to
        //      match — so clamp against the *actual* long run distance this
        //      week too.
        //   2. Clamp at MAX_SUPPORT_SESSION_KM regardless, as a final
        //      absolute backstop (tighter for repetition specifically —
        //      see MAX_REPETITION_SESSION_KM).
        const sessionCap = type === 'repetition' ? MAX_REPETITION_SESSION_KM : MAX_SUPPORT_SESSION_KM;
        let km = weekKm * (weightByDow[dow] ?? 0);
        if (longRunKmThisWeek > 0) km = Math.min(km, longRunKmThisWeek * 0.95);
        if (km > sessionCap) {
          km = sessionCap;
          supportSessionCapped = true;
        }
        dayObj.type = type;
        dayObj.km = Math.max(0, Math.round(km * 2) / 2);
        dayObj.paceSecPerKm = weekPaces[type] ?? weekPaces.easy;
        // qualityPrimary/qualitySecondary (resolved once above, alongside
        // this week's template) tell us which variant this specific
        // interval/tempo day should build as — whichever of the two picks
        // actually matches this slot's type (they're never both the same
        // type in one week, see QUALITY_ROTATION's comment above).
        if (type === 'interval' && dayObj.km > 0) {
          const variant = (qualityPrimary.type === 'interval' ? qualityPrimary : qualitySecondary).variant;
          dayObj.workoutVariant = variant;
          dayObj.structure = buildIntervalStructure(dayObj.km, fitnessLevel, conservativeMode, variant);
        } else if (type === 'tempo' && dayObj.km > 0) {
          const variant = (qualityPrimary.type === 'tempo' ? qualityPrimary : qualitySecondary).variant;
          dayObj.workoutVariant = variant;
          dayObj.structure = buildTempoStructure(dayObj.km, variant);
        } else if (type === 'repetition' && dayObj.km > 0) {
          dayObj.structure = buildRepetitionStructure(dayObj.km);
        } else if (dayObj.km > 0) {
          dayObj.structure = buildSimpleStructure(dayObj.km);
        }
      });

      const totalKm = Math.round(days.reduce((s, d) => s + (d.km || 0), 0) * 10) / 10;
      // Taper/race weeks are intentionally lower-volume by design, so they
      // shouldn't count toward "peak" — only build-phase weeks (Base/Build/
      // Peak/Cutback) do. Tracks what the schedule actually delivers, which
      // can still come in a bit under the peakWeeklyKm target on the rare
      // week where a guardrail (ramp limit, MAX_SUPPORT_SESSION_KM) trims
      // something — peakWeeklyKm itself is already the realistic figure
      // (see its definition above), not the unbounded theoretical one.
      if (!isTaperWeek) actualPeakWeeklyKm = Math.max(actualPeakWeeklyKm, totalKm);

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
    if (supportSessionCapped) {
      warnings.push(`Beberapa sesi lari santai/tempo/interval/repetition di jadwal ini dibatasi maksimal ${MAX_SUPPORT_SESSION_KM} km (repetition: ${MAX_REPETITION_SESSION_KM} km) — dengan volume mingguanmu yang cukup tinggi, porsi proporsionalnya bisa lebih jauh dari itu, tapi sesi selain long run sebaiknya tidak sejauh itu. Total mingguan jadi sedikit lebih rendah dari target sebagai konsekuensinya — lebih aman begitu daripada memaksakan sesi harian yang kepanjangan.`);
    }
    if (Math.abs(currentFitnessPaceSec - goalPaceSec) >= 3) {
      warnings.push(`Pace target di sesi tempo/interval/long run dimulai lebih santai (${formatPace(currentFitnessPaceSec)}, sesuai kemampuanmu saat ini) lalu naik bertahap tiap minggu menuju goal pace ${formatPace(goalPaceSec)} di puncak training block — bukan langsung dipatok di goal pace dari minggu 1.`);
    }

    return {
      meta: {
        raceLabel, raceDistanceKm, raceDate: race,
        planWeeks, taperWeeks, buildWeeks,
        peakWeeklyKm: Math.round(actualPeakWeeklyKm * 10) / 10,
        peakLongRunKm: Math.round(actualPeakLongRunKm * 10) / 10,
        goalPaceSec, paces,
        goalPaceSource,
        recentRaceTimeSec: recentRaceTimeSec || null,
        recentRaceDistanceKm: recentRaceDistanceKm || null,
        predictedRaceTimeSec,
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

  return {
    generatePlan, formatPace, formatDate, formatDuration, predictRaceTime, TYPE_LABELS, DAY_NAMES,
    // Exported so js/app.js can recompute a day's workout-structure bar
    // after applying an AI-suggested distance adjustment (see
    // applyAiAdjustments), and clamp against the same absolute ceiling
    // this file itself enforces, without duplicating either.
    buildSimpleStructure, buildIntervalStructure, buildTempoStructure, buildRepetitionStructure,
    MAX_SUPPORT_SESSION_KM, MAX_REPETITION_SESSION_KM,
  };
})();
