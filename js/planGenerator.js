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
  //
  // maxSupportKm: absolute ceiling for a single non-long-run session (easy/
  // recovery/tempo/interval) at THIS race distance, regardless of what its
  // weeklySplitForDays share would otherwise compute. The proportional
  // split keeps every support session smaller than that week's long run,
  // but weekKm itself has no upper bound of its own (it grows off
  // currentWeeklyKm with no ceiling, while the long run gets clamped to
  // longRunMin/Max above) — so on a high-volume plan the *other* sessions
  // can still land at an unrealistic absolute distance even while staying
  // smaller than the long run (a 17km "tempo run" is not a tempo run for a
  // 5K plan no matter how big that week's long run is).
  //
  // Sourced from Hal Higdon's Intermediate 1 plans specifically (a
  // recreational/non-elite tier, unlike e.g. Pete Pfitzinger's 55-70+
  // mile/week "medium-long run" plans, which run considerably higher) —
  // the longest non-long-run session in each plan's own peak week, read
  // directly off its published weekly schedule table:
  //   5K:    Sat "fast" 5mi  (8km)   at peak long run 7mi  (11.3km)
  //   10K:   Tue 6mi         (9.7km) at peak long run 8mi  (12.9km)
  //   Half:  Wed 6mi         (9.7km) at peak long run 12mi (19.3km)
  //   Full:  Wed 8mi         (12.9km) at peak long run 20mi (32.2km)
  // All four of these plans run 5 days/week, but this ceiling is applied
  // as-is regardless of daysPerWeek — see the comment where it's read
  // (generatePlan, below) for why a day-based scaling factor was tried and
  // then dropped.
  const RACE_PROFILES = {
    '5k':   { recWeeks: 8,  taperWeeks: 1, longRunMin: 8,  longRunMax: 12, maxSupportKm: 8 },
    '10k':  { recWeeks: 10, taperWeeks: 1, longRunMin: 12, longRunMax: 16, maxSupportKm: 10 },
    // Non-race-only "Medium Distance" template (see index.html's
    // #raceDistance — Race mode never offers this value): the plain
    // arithmetic average of 10k's and half's own numbers below, so a
    // Base Building/Maintenance runner who doesn't want either the 5K
    // template's short long runs or the full-marathon-scale volume of
    // Long Distance gets something genuinely in between rather than
    // having to just pick one of the two. taperWeeks is moot here —
    // generatePlan forces non-race taper to 1 week regardless (see
    // isNonRace below) — kept only so this entry has the same shape as
    // every other RACE_PROFILES entry.
    medium: { recWeeks: 11, taperWeeks: 2, longRunMin: 14, longRunMax: 17, maxSupportKm: 10 },
    'half': { recWeeks: 12, taperWeeks: 2, longRunMin: 16, longRunMax: 19, maxSupportKm: 10 },
    'full': { recWeeks: 16, taperWeeks: 3, longRunMin: 29, longRunMax: 32, maxSupportKm: 13 },
  };

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

  // Non-race modes' own (much smaller, flat-across-levels) version of the
  // gain fraction above — used by BOTH Base Building and Maintenance, not
  // just Maintenance (see isNonRace below, not isMaintenance). Neither has
  // a race/goal distance to project toward, and Base Building specifically
  // is meant to raise mileage, not pace — its whole point is volume growth
  // (WEEKLY_GROWTH_RATE, untouched) while VDOT stays nearly flat, the same
  // as Maintenance, not the aggressive multi-factor projection Race mode
  // uses. Deliberately flat regardless of fitnessLevel (unlike
  // CONSERVATIVE_FITNESS_GAIN_PCT, which scales 3-8% by level) and roughly
  // a quarter of that table's smallest entry — small enough that even a
  // stale VDOT input (a non-race user is exactly the kind of runner likely
  // to not have a recent race) can't compound into an unrealistic target,
  // since the target itself barely moves from where it started.
  const NON_RACE_FITNESS_GAIN_PCT = 0.02;

  // Where volume-driven gains taper off to essentially flat — recreational-
  // runner data (Garmin population data + several training-volume studies)
  // puts the steep-improvement zone under roughly 35-45km/week, tapering
  // off by ~60km/week. Originally scoped to goalPaceSec's own
  // volumeGainMultiplier below (a runner already near/above this has little
  // headroom left for volume-driven pace gains), hoisted here so
  // generatePlan's own Base-Building-vs-Maintenance suggestion (see
  // isBaseBuilding below) can reuse the exact same number rather than a
  // second, potentially-drifting 60.
  const VOLUME_GAIN_PLATEAU_KM = 60;

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

  // Training-zone pace = goalPaceSec * multiplier. Ordered slow -> fast,
  // repetition faster than interval, mirroring Daniels' R-pace < I-pace <
  // T-pace ordering (see js/vdot.js's ZONE_PCT_RANGES, which orders the
  // same zones by %VO2max) — NOT used to schedule sessions any more (see
  // weekPaces in generatePlan below, which derives each week's zone paces
  // from the real VDOT %VO2max formulas instead, so the schedule and the
  // separately-displayed "Zona Pace" reference table agree with each
  // other). Kept only as generatePlan's defensive fallback for the rare
  // case PaceForgeVDOT can't produce a zone table for some input.
  const PACE_MULTIPLIERS = {
    recovery: 1.25,
    easy: 1.15,
    longRun: 1.10,
    tempo: 0.97,
    interval: 0.90,
    repetition: 0.83,
  };

  // Single source of truth for "which of the 4 known profiles (5k/10k/half/
  // full) does this race match" — shared by resolveRaceProfile below and
  // resolveQualityRotation (see QUALITY_ROTATIONS further down), so a
  // custom-distance race resolves to the same bucket for both instead of
  // each re-implementing (and risking drifting from) the same thresholds.
  function resolveRaceProfileKey(raceDistanceKm, raceKey) {
    if (RACE_PROFILES[raceKey]) return raceKey;
    // Custom distance: interpolate a sensible profile from nearest known ones.
    if (raceDistanceKm <= 5) return '5k';
    if (raceDistanceKm <= 10) return '10k';
    if (raceDistanceKm <= 21.1) return 'half';
    return 'full';
  }

  function resolveRaceProfile(raceDistanceKm, raceKey) {
    return RACE_PROFILES[resolveRaceProfileKey(raceDistanceKm, raceKey)];
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
      // repetition), not literally always tempo — see QUALITY_ROTATIONS.
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

  // The Peak phase's own start (same boundary buildPhaseForWeek computes
  // internally) — exposed so generatePlan can figure out a given Peak
  // week's position *within* Peak (1st Peak week, 2nd, ...) without
  // re-deriving the boundary inline. Used to progressively ramp the
  // race-pace share of a race-specific long run across the Peak phase —
  // see MSL_PACE_FRACTION_START/END below.
  function peakPhaseStartWeek(buildWeeks) {
    if (buildWeeks <= 1) return 0;
    if (buildWeeks === 2) return 1;
    const baseEnd = Math.max(1, Math.round(buildWeeks / 3));
    return Math.max(baseEnd + 1, Math.round(buildWeeks * 2 / 3));
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

  // Monday=1..Saturday=6, Sunday=7 — a plain ascending week position, used
  // wherever days-of-week need to be compared/sorted/subtracted correctly
  // (dow's own 0=Sunday would otherwise sort Sunday before Monday and,
  // worse, make a Sunday-involving gap subtraction come out negative).
  function chronoRank(dow) { return dow === 0 ? 7 : dow; }

  // Which of `candidates` (day-of-week numbers, ANY order) should host
  // `count` quality (tempo/interval/repetition) sessions — chosen to
  // maximize the smallest gap between any two, rather than just the first
  // `count` chronologically. Back-to-back hard efforts don't give VO2max/
  // lactate-threshold adaptations the ~48-72h they need to actually
  // absorb the training (RunnersConnect; Peregrune "Back-To-Back Running
  // Workouts") — common structured plans place 2 quality sessions on
  // Tuesday/Thursday specifically because a weekend long run anchors one
  // end of the week and that split maximizes the gap on both sides.
  // `count` only reaches 2 with the current QUALITY_TYPES rotation (see
  // workoutTemplate) — small enough that brute-forcing every combination
  // is cheap and always finds the true optimum, not just a good guess.
  function pickSpacedQualityDays(candidates, count) {
    const sorted = [...candidates].sort((a, b) => chronoRank(a) - chronoRank(b));
    if (count >= sorted.length) return sorted;
    if (count <= 1) return sorted.slice(0, count);
    let best = sorted.slice(0, count);
    let bestMinGap = -1;
    const combo = [];
    (function search(start) {
      if (combo.length === count) {
        let minGap = Infinity;
        for (let i = 1; i < combo.length; i++) {
          minGap = Math.min(minGap, chronoRank(combo[i]) - chronoRank(combo[i - 1]));
        }
        if (minGap > bestMinGap) {
          bestMinGap = minGap;
          best = combo.slice();
        }
        return;
      }
      for (let i = start; i < sorted.length; i++) {
        combo.push(sorted[i]);
        search(i + 1);
        combo.pop();
      }
    })(0);
    return best;
  }

  // Below-neutral leg of the goal-pace paceLevelMultiplier curve (see
  // generatePlan) — piecewise-linear through explicitly hand-picked
  // points rather than the single straight line the underlying
  // running-economy research would imply, because that research's own
  // slope was measured across an elite-only pace range this app's
  // recreational audience will never occupy: the curve needs to fall off
  // much faster than that slope in the 6:00-3:00/km range real users are
  // actually in. Sorted slowest (lowest sec/km factor... actually highest
  // sec/km) to fastest; flat above the first point and below the last.
  const PACE_LEVEL_FAST_CURVE = [
    { sec: 360, factor: 1.0 },  // 6:00/km — neutral point
    { sec: 300, factor: 0.75 }, // 5:00/km
    { sec: 270, factor: 0.65 }, // 4:30/km
    { sec: 240, factor: 0.5 },  // 4:00/km
    { sec: 180, factor: 0.4 },  // 3:00/km — floor
  ];
  function paceLevelFastFactor(paceSecPerKm) {
    const first = PACE_LEVEL_FAST_CURVE[0];
    const last = PACE_LEVEL_FAST_CURVE[PACE_LEVEL_FAST_CURVE.length - 1];
    if (paceSecPerKm >= first.sec) return first.factor;
    if (paceSecPerKm <= last.sec) return last.factor;
    for (let i = 0; i < PACE_LEVEL_FAST_CURVE.length - 1; i++) {
      const a = PACE_LEVEL_FAST_CURVE[i];
      const b = PACE_LEVEL_FAST_CURVE[i + 1];
      if (paceSecPerKm <= a.sec && paceSecPerKm >= b.sec) {
        const t = (a.sec - paceSecPerKm) / (a.sec - b.sec);
        return a.factor + (b.factor - a.factor) * t;
      }
    }
    return last.factor; // unreachable given the bounds checks above
  }

  // Shared by workoutTemplate's day-assignment (prioritize these onto
  // weekdays — see below) and applyConservativeAdjustment (shift weight
  // off these onto easy/recovery slots). 'fartlek' counts as a quality
  // effort too (Maintenance mode swaps it in for a rotation slot — see
  // MAINTENANCE_FARTLEK_EVERY/resolveQualitySlot below) so it gets the
  // same weekday-priority/48-72h-spacing placement as tempo/interval/
  // repetition, not treated like a plain easy day. 'marathonPace' is Base
  // Building's own quality slot (see isBaseBuilding in generatePlan) —
  // steadier than a real quality session but still deserves the same
  // weekday placement over a plain easy day.
  const QUALITY_TYPES = new Set(['tempo', 'interval', 'repetition', 'fartlek', 'marathonPace']);

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
  //     block at the same total distance — and, being more recovery-
  //     friendly than an equal-time continuous block, the pick more of the
  //     longer distances (half/full) lean on to accumulate threshold
  //     volume without competing with their own long-run/M-pace work.
  //   - Repetition (R pace): short reps — short (~200m), mid (~300m), long
  //     (~400m) — at faster-than-interval pace with full recovery between
  //     each; builds speed and running economy. Same varying-distance idea
  //     as I-pace above, just over a shorter, faster range.
  //
  // The MIX of these three shifts by race distance, not just their
  // variant — how close the race itself is run to VO2max (I-pace territory)
  // vs lactate threshold (T-pace) is what should drive which one a plan
  // leans on:
  //   - 5K is raced at ~95-98% VO2max, so I-pace and R-pace (speed/economy)
  //     carry the most specific benefit; threshold stays present but
  //     secondary. (McMillan Running's 5K guide; Daniels' Running Formula's
  //     5K-10K plan, whose Phase II centers on R-pace work.)
  //   - 10K sits closer to threshold (~90-95% VO2max) — tempo becomes the
  //     priority pick, interval second, repetition the rare touch.
  //     ("Workout hierarchy in 10K training": long run first, tempo
  //     closest to race demand, intervals third.)
  //   - Half marathon is raced at ~85-90% VO2max, making lactate threshold
  //     THE primary determinant of performance — tempo dominates, interval
  //     drops to an occasional maintenance touch, and repetition survives
  //     only as Daniels' own half-marathon plans use it: paired with tempo
  //     work, not as a standalone speed phase.
  //   - Marathon runs even lower relative to VO2max (~75-85%), so interval
  //     work adds recovery cost that competes with marathon-pace volume for
  //     little specific return — coaching guidance caps it at roughly once
  //     every 10-14 days. Repetition drops out entirely: full-recovery
  //     sprint work has the least transfer to marathon demands and adds
  //     injury risk at a point in the plan carrying the highest overall
  //     volume. (Marathon-specific pace work itself is handled separately,
  //     by the race-specific long run in the Peak phase — see
  //     usesRaceSpecificLongRun below — not by this rotation.)
  //
  // 5K and full both cycle every 6 weeks; 10K and half run longer cycles
  // (9 and 12) that still carry exactly 1 repetition slot each, just diluted
  // across more weeks — repetition's specific benefit fades faster than
  // interval's as the race gets longer (see the comment block above), so
  // rather than dropping it to 0 (like full) or keeping it at the same 1-in-
  // 6 rate as 5k/10k, half keeps it as a rare, deliberate touch: present,
  // but clearly secondary to interval too, not just to tempo. A week with 2
  // quality slots (5-6 days/week plans) reads its 2nd slot half the
  // rotation's own length ahead of the 1st (see qualityPick's slotOffset,
  // sized off rotation.length) so the two never land on the same pick,
  // regardless of how long that particular rotation is.
  const QUALITY_ROTATIONS = {
    '5k': [ // interval 50% / tempo 21% / repetition 29%
      { type: 'interval', variant: 'short' },
      { type: 'interval', variant: 'mid' },
      { type: 'repetition', variant: 'short' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'interval', variant: 'long' },
      { type: 'repetition', variant: 'mid' },
    ],
    '10k': [ // interval 33% / tempo 56% / repetition 11%
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'mid' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'interval', variant: 'short' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'long' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'repetition', variant: 'mid' },
    ],
    // Non-race-only "Medium Distance" template (see RACE_PROFILES.medium
    // above for why this exists) — a hand-authored blend landing close to
    // the arithmetic average of 10k's (interval 33%/tempo 56%/repetition
    // 11%) and half's (interval 17%/tempo 75%/repetition 8%) own mixes
    // above/below, rather than literally interleaving those two arrays
    // (which would bias early cycle weeks toward one flavor and later ones
    // toward the other instead of reading as blended week to week).
    medium: [ // interval 27% / tempo 64% / repetition 9%
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'mid' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'short' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'mid' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'repetition', variant: 'short' },
    ],
    half: [ // interval 17% / tempo 75% / repetition 8%
      { type: 'tempo', variant: 'continuous' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'mid' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'interval', variant: 'mid' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'repetition', variant: 'short' },
    ],
    full: [ // interval 17% / tempo 83% / repetition 0%
      { type: 'tempo', variant: 'cruise' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'tempo', variant: 'cruise' },
      { type: 'interval', variant: 'mid' },
      { type: 'tempo', variant: 'continuous' },
      { type: 'tempo', variant: 'cruise' },
    ],
  };

  // Same distance -> bucket resolution RACE_PROFILES uses (see
  // resolveRaceProfileKey), so a custom-distance race gets the rotation
  // that matches whichever known profile it was already sized against.
  function resolveQualityRotation(raceDistanceKm, raceKey) {
    return QUALITY_ROTATIONS[resolveRaceProfileKey(raceDistanceKm, raceKey)];
  }

  // Resolves one quality slot's workout for a given week from `rotation`
  // (this race's QUALITY_ROTATIONS entry — see resolveQualityRotation).
  // slotOffset distinguishes a week's 1st quality slot (0) from its 2nd
  // (half of rotation.length, passed by the caller) so the two never land
  // on the same pick. Conservative mode (injury/pain flagged by the user)
  // skips repetition specifically — full-recovery, faster-than-interval
  // reps carry more per-stride risk than steady tempo/interval effort —
  // falling back to a continuous tempo session in its place instead of
  // just being removed from the rotation (that fallback keeps every
  // week's quality-session *count* exactly as qualitySessionsForDays
  // expects; only the affected slot's own workout changes).
  function qualityPick(weekIndex, slotOffset, conservativeMode, rotation) {
    const idx = (weekIndex + slotOffset) % rotation.length;
    const pick = rotation[idx];
    if (conservativeMode && pick.type === 'repetition') {
      return { type: 'tempo', variant: 'continuous' };
    }
    return pick;
  }

  // Maintenance mode's own quality-slot resolver: every Nth quality
  // occurrence (across both weeks and a week's 1st/2nd slot, same index
  // space qualityPick already uses) is swapped for Fartlek instead of
  // whatever the race-style rotation would've picked — an unstructured,
  // effort-based session standing in for a structured one. This is
  // Maintenance's "rest" mechanism in place of Base Building's volume
  // cutback (see generatePlan's isMaintenance branch, which deliberately
  // skips the -20%-every-4-weeks cutback): swapping out a fixed-pace
  // session periodically keeps hard-effort exposure from accumulating
  // indefinitely without needing to touch weekly volume, which stays flat
  // by design in this mode. Race mode and Base Building are unaffected —
  // callers pass isMaintenance=false and get qualityPick's own pick back
  // untouched.
  const MAINTENANCE_FARTLEK_EVERY = 4;
  function resolveQualitySlot(weekIndex, slotOffset, conservativeMode, rotation, isMaintenance) {
    if (isMaintenance && (weekIndex + slotOffset) % MAINTENANCE_FARTLEK_EVERY === MAINTENANCE_FARTLEK_EVERY - 1) {
      return { type: 'fartlek' };
    }
    return qualityPick(weekIndex, slotOffset, conservativeMode, rotation);
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
  // have this exact shape, just with different rep distances/recovery
  // durations and effort (see INTERVAL_VARIANT_PROFILES /
  // TEMPO_CRUISE_PROFILE / REPETITION_VARIANT_PROFILES below). `profile`
  // supplies repKm/recoverySec/minReps/maxReps/workExertion plus the
  // warmup/cooldown sizing (as a fraction of sessionKm, clamped to a
  // sensible absolute range). Recovery is defined by DURATION (recoverySec),
  // not distance — real interval recoveries are jogged/walked for a set
  // time, not to a set distance, since pace during recovery isn't the point
  // — converted to an equivalent recoveryKm via `recoveryPaceSecPerKm` (this
  // week's own recovery-zone pace, see weekPaces.recovery in generatePlan
  // below) only so it can share the same km-based rep-count math and
  // bar-width sizing as every other segment; recoverySec itself is what's
  // actually shown.
  function buildRepsStructure(sessionKm, profile) {
    const { repKm, recoverySec, recoveryPaceSecPerKm, minReps, maxReps, workExertion, warmupFrac, warmupMin, warmupMax, cooldownFrac, cooldownMin, cooldownMax } = profile;
    const recoveryKm = recoverySec / recoveryPaceSecPerKm;
    const warmupKm = clamp(sessionKm * warmupFrac, warmupMin, warmupMax);
    const cooldownKm = clamp(sessionKm * cooldownFrac, cooldownMin, cooldownMax);
    const workoutKm = Math.max(sessionKm - warmupKm - cooldownKm, repKm + recoveryKm);
    const reps = clamp(Math.round(workoutKm / (repKm + recoveryKm)), minReps, maxReps);
    return { kind: 'interval', warmupKm, cooldownKm, reps, workKm: repKm, workExertion, recoveryKm, recoverySec };
  }

  // Recovery-jog duration for a reps-based workout, computed from the rep's
  // OWN work time (repKm at this week's actual work pace) instead of a
  // fixed number of seconds — Daniels states recovery as a RATIO of work
  // time (I-pace: recovery ≈ half the work interval; R-pace: "full
  // recovery", ~2-3x work time), and a flat, fixed-second recovery drifts
  // away from that ratio for anyone whose pace differs from whatever pace
  // the constant happened to be tuned against — a beginner and an advanced
  // runner doing the exact same "800m, 90s jog" interval are, in Daniels'
  // own terms, doing two different workouts (very different recovery
  // ratios), even though the app would show them identically. Floored to
  // the nearest 30s (not rounded) so what's actually shown/coached reads as
  // a clean "90 detik pemulihan" instead of the raw math's "94 detik" —
  // Daniels' own tables are written in round numbers too, and rounding UP
  // even by a few seconds would nudge the real recovery:work ratio past
  // what was intended, where flooring only ever pulls it (slightly) tighter.
  // `minSec` is a floor (already a multiple of 30) so a very short rep at a
  // very fast pace still gets a real jog, not next to none.
  function recoverySecForWork(repKm, workPaceSecPerKm, ratio, minSec = 30) {
    const raw = repKm * workPaceSecPerKm * ratio;
    return Math.max(minSec, Math.floor(raw / 30) * 30);
  }

  // Longest-to-shortest order for capVariantByDuration's downgrade cascade
  // below — shared shape by interval and repetition, each with their own
  // profiles/cap.
  const VARIANT_ORDER_LONG_TO_SHORT = ['long', 'mid', 'short'];

  // Picks the longest rep length (from `variant` downward — never upward)
  // whose work time at this week's actual pace still fits under `capSec` —
  // Daniels' own ceiling for how long a single rep can last before it stops
  // training that zone's intended effort: an I-pace rep over 5 minutes is
  // "too demanding" to actually hold at 95-100% VO2max (it drifts toward a
  // slower, T-pace-like effort instead); an R-pace rep is meant to stay
  // short and sharp, capped at 2 minutes. A fixed rep DISTANCE (e.g. the
  // "long" interval's ~1200m) can quietly overshoot either cap for a slower
  // runner even though it's perfectly fine for a faster one at the exact
  // same nominal variant — this re-checks per week, against that week's own
  // ramping pace, rather than locking every runner to the same distance
  // regardless of how long it actually takes them to cover it.
  function capVariantByDuration(profiles, variant, workPaceSecPerKm, capSec) {
    const startIdx = Math.max(0, VARIANT_ORDER_LONG_TO_SHORT.indexOf(variant));
    for (let i = startIdx; i < VARIANT_ORDER_LONG_TO_SHORT.length; i++) {
      const key = VARIANT_ORDER_LONG_TO_SHORT[i];
      if (profiles[key].repKm * workPaceSecPerKm <= capSec) return key;
    }
    return VARIANT_ORDER_LONG_TO_SHORT[VARIANT_ORDER_LONG_TO_SHORT.length - 1]; // shortest still exceeds cap (extremely slow pace) — best available anyway
  }

  // Interval (I-pace) rep-distance variants — see QUALITY_ROTATIONS above for
  // why/when each one gets picked. repKm approximates common track-workout
  // distances; minReps/maxReps keep the rep count realistic for that
  // distance (more short reps fit in a session than long ones). Recovery is
  // NOT listed here — see recoverySecForWork above, computed at build time
  // from each week's actual I-pace instead of a fixed number per variant.
  const INTERVAL_VARIANT_PROFILES = {
    short: { repKm: 0.4, minReps: 5, maxReps: 12 }, // ~400m
    mid:   { repKm: 0.8, minReps: 4, maxReps: 8 },  // ~800m
    long:  { repKm: 1.2, minReps: 3, maxReps: 6 },  // ~1000-1200m
  };
  const INTERVAL_RECOVERY_RATIO = 0.5; // Daniels: recovery ≈ half the work interval's time
  const INTERVAL_MAX_WORK_SEC = 5 * 60; // reps beyond this aren't realistic I-pace effort — see capVariantByDuration

  // Returns { structure, resolvedVariant } rather than the structure alone —
  // `variant` is what the week's rotation asked for, but at this runner's
  // actual pace that rep length might not fit under INTERVAL_MAX_WORK_SEC
  // (see capVariantByDuration), so callers need the ACTUAL variant used to
  // keep dayObj.workoutVariant in sync with what's really shown/rebuilt.
  function buildIntervalStructure(sessionKm, fitnessLevel, conservativeMode, variant, workPaceSecPerKm, recoveryPaceSecPerKm) {
    const resolvedVariant = capVariantByDuration(INTERVAL_VARIANT_PROFILES, variant, workPaceSecPerKm, INTERVAL_MAX_WORK_SEC);
    const repProfile = INTERVAL_VARIANT_PROFILES[resolvedVariant];
    const workExertion = conservativeMode ? 'moderate' : (fitnessLevel === 'beginner' ? 'moderate' : 'high');
    const recoverySec = recoverySecForWork(repProfile.repKm, workPaceSecPerKm, INTERVAL_RECOVERY_RATIO);
    const structure = buildRepsStructure(sessionKm, {
      ...repProfile, recoverySec, workExertion, recoveryPaceSecPerKm,
      warmupFrac: 0.2, warmupMin: 1, warmupMax: 2.5,
      cooldownFrac: 0.15, cooldownMin: 1, cooldownMax: 2,
    });
    return { structure, resolvedVariant };
  }

  // Cruise intervals: ~1 mile (1.6km) T-pace segments with a short (~60s)
  // jog recovery between — Daniels' own preferred way to accumulate T-pace
  // volume for most runners (see QUALITY_ROTATIONS above); recovery here is
  // deliberately shorter than a real interval's, by design.
  const TEMPO_CRUISE_PROFILE = { repKm: 1.6, recoverySec: 60, minReps: 2, maxReps: 4 };

  function buildTempoStructure(sessionKm, variant, recoveryPaceSecPerKm) {
    if (variant === 'cruise') {
      return buildRepsStructure(sessionKm, {
        ...TEMPO_CRUISE_PROFILE, workExertion: 'moderate', recoveryPaceSecPerKm,
        warmupFrac: 0.2, warmupMin: 1, warmupMax: 2,
        cooldownFrac: 0.15, cooldownMin: 1, cooldownMax: 1.5,
      });
    }
    const warmupKm = clamp(sessionKm * 0.25, 1, 2);
    const cooldownKm = clamp(sessionKm * 0.2, 1, 1.5);
    const tempoKm = Math.max(sessionKm - warmupKm - cooldownKm, 1);
    return { kind: 'tempo', warmupKm, cooldownKm, tempoKm };
  }

  // Fartlek ("speed play") — unlike every other quality workout here, real
  // fartlek surges are run/felt by TIME or landmark, not a measured
  // distance, so this is anchored to a fixed work DURATION
  // (FARTLEK_WORK_SEC) and converted to km only for the bar's rendering,
  // the same way buildRepsStructure already converts recoverySec to a km
  // width. Classic "1 minute on / 1 minute off" shape (~6-10 reps) — a
  // loose reference the UI should caption as adjustable "sesuai feeling",
  // not a strict target the way Tempo/Interval reps are.
  //
  // Work effort is meant to reference the Interval zone (~8-9/10 perceived
  // exertion per multiple coaching sources, closer to interval effort than
  // tempo's "comfortably hard" ~7/10 — see callers passing weekPaces.interval
  // as workPaceSecPerKm), but recovery is genuine EASY-pace jogging
  // (weekPaces.easy passed as easyPaceSecPerKm), NOT the slower near-walk
  // pace Interval/Repetition/Tempo-cruise recover at (weekPaces.recovery).
  // That's fartlek's defining difference from structured interval training:
  // "your running pace between speed bursts should be your regular base run
  // pace" (Runstreet); recovery is run "at your easy pace" (McMillan's "The
  // Lost Art of the Fartlek"; TrainingPeaks "Fartlek Run 101") — unlike
  // interval's slower/near-walk recovery.
  const FARTLEK_WORK_SEC = 60;
  const FARTLEK_RECOVERY_RATIO = 1.0; // "1 minute off" — equal work:recovery
  const FARTLEK_MIN_REPS = 6;
  const FARTLEK_MAX_REPS = 10;

  function buildFartlekStructure(sessionKm, workPaceSecPerKm, easyPaceSecPerKm) {
    const repKm = FARTLEK_WORK_SEC / workPaceSecPerKm;
    const recoverySec = FARTLEK_WORK_SEC * FARTLEK_RECOVERY_RATIO;
    return buildRepsStructure(sessionKm, {
      repKm, recoverySec, recoveryPaceSecPerKm: easyPaceSecPerKm,
      minReps: FARTLEK_MIN_REPS, maxReps: FARTLEK_MAX_REPS, workExertion: 'moderate',
      warmupFrac: 0.25, warmupMin: 1, warmupMax: 2,
      cooldownFrac: 0.2, cooldownMin: 1, cooldownMax: 1.5,
    });
  }

  // Repetition (R-pace) rep-distance variants — same idea as
  // INTERVAL_VARIANT_PROFILES above, just shorter distances (R-pace reps
  // are meant to stay brief/sharp, not a distance workout) and their own
  // duration cap/recovery ratio below. Always high-exertion per rep
  // regardless of fitness level or conservative mode (conservative mode
  // instead skips repetition entirely — see qualityPick above — rather
  // than watering this down, since a slow rep isn't really repetition work
  // any more).
  const REPETITION_VARIANT_PROFILES = {
    short: { repKm: 0.2, minReps: 6, maxReps: 10 }, // ~200m
    mid:   { repKm: 0.3, minReps: 5, maxReps: 8 },  // ~300m
    long:  { repKm: 0.4, minReps: 4, maxReps: 6 },  // ~400m
  };
  const REPETITION_RECOVERY_RATIO = 2.5; // Daniels: "full recovery" ≈ 2-3x work time; 2.5x used as the midpoint
  const REPETITION_MAX_WORK_SEC = 2 * 60; // a repetition bout shouldn't run past this — see capVariantByDuration

  // Kept deliberately short overall (see MAX_REPETITION_SESSION_KM below) —
  // real repetition sessions are brief-but-intense, not a distance workout.
  // Returns { structure, resolvedVariant } — see buildIntervalStructure's
  // own comment above for why.
  function buildRepetitionStructure(sessionKm, variant, workPaceSecPerKm, recoveryPaceSecPerKm) {
    const resolvedVariant = capVariantByDuration(REPETITION_VARIANT_PROFILES, variant, workPaceSecPerKm, REPETITION_MAX_WORK_SEC);
    const repProfile = REPETITION_VARIANT_PROFILES[resolvedVariant];
    const recoverySec = recoverySecForWork(repProfile.repKm, workPaceSecPerKm, REPETITION_RECOVERY_RATIO);
    const structure = buildRepsStructure(sessionKm, {
      ...repProfile, recoverySec, workExertion: 'high', recoveryPaceSecPerKm,
      warmupFrac: 0.35, warmupMin: 1, warmupMax: 1.5,
      cooldownFrac: 0.25, cooldownMin: 0.5, cooldownMax: 1,
    });
    return { structure, resolvedVariant };
  }

  // Race-specific long run (MSL for a full marathon, the same idea at
  // half-marathon goal pace for a half plan — see usesRaceSpecificLongRun
  // in generatePlan): an easy-pace buildup FIRST, then a goal-race-pace
  // segment to FINISH — not the whole run at race pace. Mirrors how real
  // marathon plans structure this (e.g. Pete Pfitzinger's "Advanced
  // Marathoning": long runs like "16km with the last 10km at marathon
  // pace", the MP-mileage share growing across the build — his plans
  // range roughly 25-45% of the run at MP early in this block, up to
  // ~60% in the final one or two MSL sessions before taper). Race pace at
  // the END (not the start or middle) is deliberate: it's meant to
  // rehearse holding goal pace on already-tired legs, the same demand as
  // the race's own closing kilometers — the whole reason to do this
  // session instead of just another easy long run.
  const MSL_PACE_FRACTION_START = 0.30; // share of the long run at race pace, this block's 1st Peak week
  const MSL_PACE_FRACTION_END = 0.55;   // ...growing to this share by the last Peak week (pre-taper)

  function buildRaceSpecificLongRunStructure(sessionKm, paceFraction, paceLabel) {
    const paceKm = Math.round(sessionKm * paceFraction * 2) / 2;
    const easyKm = Math.max(Math.round((sessionKm - paceKm) * 2) / 2, 0);
    return { kind: 'racePace', easyKm, paceKm, paceLabel };
  }

  // Absolute ceiling for a repetition session specifically — tighter than
  // profile.maxSupportKm (which still applies to every other non-long-run
  // session type, tempo/interval included): real repetition workouts are
  // short bursts with lots of standing/jogging recovery, not a distance
  // session, so letting one scale up like a tempo run would misrepresent
  // what the workout actually is.
  const MAX_REPETITION_SESSION_KM = 8;

  const TYPE_LABELS = {
    recovery: 'Recovery Run',
    easy: 'Easy Run',
    longRun: 'Long Run',
    tempo: 'Tempo Run',
    interval: 'Interval',
    repetition: 'Repetition',
    shakeout: 'Shakeout Run',
    fartlek: 'Fartlek',
    marathonPace: 'Marathon Pace Run',
    // First-timer mode only (see generateFirstTimerPlan) — the specific
    // run/walk split for that week is shown in the structure caption
    // below this badge (js/app.js's structureToSegments), not baked into
    // the label itself, since it changes every week.
    runWalk: 'Run/Walk',
    // Distance shown separately in its own column (5km, or a lighter
    // self-test distance in conservativeMode — see generatePlan's 'race'
    // day-type branch), not baked into this label.
    evaluation: 'Time Trial',
    rest: 'Rest',
    // Not a real day.type — a rest day is always 'rest' in the data model.
    // This is a display-only key (see app.js's restDisplayKey) a weekday
    // rest day is shown under instead, as a nudge that the slot is also a
    // reasonable place for the runner's own strength/gym session if they
    // do one. Weekend rest stays plain 'Rest' — see restDisplayKey for why.
    // planGenerator.js itself has no opinion on what that session should
    // contain.
    restStrength: 'Rest / Strength Training',
    race: 'RACE DAY! 🏁',
  };

  // ===================== First-timer mode =====================
  // A total beginner has no currentWeeklyKm/VDOT to anchor ANYTHING
  // generatePlan's shared race/non-race machinery does (volume ramp, pace
  // zones, quality-session rotation — all of it assumes some existing
  // running ability to measure) — so unlike Base Building/Maintenance
  // (which reuse ~all of that machinery, just retargeted), First-timer
  // gets its own fully independent generator, dispatched to right at the
  // top of generatePlan below, per this project's standing "keep Race/
  // Base Building/Maintenance logic separate" directive taken one step
  // further. Trains toward a real 5K instead — a fixed, gentle 8-week
  // run/walk interval build-up (run segments lengthen, walk segments
  // shorten, in the well-known spirit countless beginner "run/walk"
  // programs use — this specific week-by-week table is this project's own
  // design, not a reproduction of any single named program), always
  // exactly 3 days/week (rest days between runs matter more for a
  // beginner's tendons/bones adapting than for an experienced runner's
  // cardio), ending in a real 5K Time Trial — reusing the exact same
  // 'evaluation' day-type/no-prescribed-pace shape Base Building's own
  // evaluation week already established (see generatePlan's 'race'-type
  // branch below), just built directly here rather than called, since that
  // branch lives inline inside generatePlan's loop, tightly coupled to
  // state (weekPaces, qualityRotation, ...) First-timer has none of.
  const FIRST_TIMER_DAYS_PER_WEEK = 3;
  const FIRST_TIMER_RACE_LABEL = '5K Pemula';
  // { runSec, walkSec, reps } per week — reps of (run runSec, walk
  // walkSec). Total session length stays a gentle ~20-25 minutes
  // throughout; what changes is the run:walk ratio, converging on
  // continuous running by week 8.
  const FIRST_TIMER_PROGRAM = [
    { runSec: 60,   walkSec: 90, reps: 8 }, // week 1: 20 min
    { runSec: 90,   walkSec: 90, reps: 7 }, // week 2: 21 min
    { runSec: 120,  walkSec: 90, reps: 6 }, // week 3: 21 min
    { runSec: 180,  walkSec: 90, reps: 5 }, // week 4: 22.5 min
    { runSec: 300,  walkSec: 60, reps: 4 }, // week 5: 24 min
    { runSec: 420,  walkSec: 60, reps: 3 }, // week 6: 24 min
    { runSec: 600,  walkSec: 60, reps: 2 }, // week 7: 22 min
    { runSec: 1500, walkSec: 0,  reps: 1 }, // week 8: 25 min continuous, no walk breaks
  ];
  // Week 9's non-5K day(s) — a short, easy shakeout (not week 8's full 25
  // min, not blank rest either) to keep legs loose heading into the real
  // test rather than sitting idle for most of the week.
  const FIRST_TIMER_EVALUATION_SHAKEOUT = { runSec: 600, walkSec: 0, reps: 1 }; // 10 min easy continuous
  // Rough pace ASSUMPTIONS purely so a run/walk session still has a `day.km`
  // — every other subsystem (volume chart, weekly totals, PDF, Strava
  // completion-matching by calendar date) already assumes day.km exists and
  // is meaningful, and forking all of that for "no km" would be a much
  // bigger, riskier change than accepting an approximate figure here. The
  // actual PRESCRIBED target stays the run/walk time split (see
  // structureToSegments' runWalk branch in js/app.js) — km is secondary/FYI,
  // never shown as something to hit.
  const FIRST_TIMER_RUN_PACE_SEC_PER_KM = 8 * 60;   // ~8:00/km, a gentle beginner jog
  const FIRST_TIMER_WALK_PACE_SEC_PER_KM = 12 * 60; // ~12:00/km, a brisk walk

  function buildRunWalkStructure(program) {
    const runKm = program.runSec / FIRST_TIMER_RUN_PACE_SEC_PER_KM;
    const walkKm = program.walkSec / FIRST_TIMER_WALK_PACE_SEC_PER_KM;
    return {
      structure: { kind: 'runWalk', reps: program.reps, runSec: program.runSec, walkSec: program.walkSec, runKm, walkKm },
      km: Math.round((runKm + walkKm) * program.reps * 100) / 100,
    };
  }

  function generateFirstTimerPlan(settings) {
    const { startDate, preferredDays, raceLabel } = settings;
    const planStartAnchor = startOfDay(startDate || new Date());
    // Re-clamped defensively to exactly 3 days, sorted Mon..Sun (Sunday
    // last) — js/app.js's form already locks daysPerWeek/preferredDays to
    // this shape for First-timer, this doesn't trust that blindly.
    const chronoRank = dow => (dow === 0 ? 7 : dow);
    const slotDays = (preferredDays || [])
      .slice()
      .sort((a, b) => chronoRank(a) - chronoRank(b))
      .slice(0, FIRST_TIMER_DAYS_PER_WEEK);

    const totalWeeks = FIRST_TIMER_PROGRAM.length + 1; // 8 build weeks + 1 evaluation (5K) week
    const weeks = [];
    // Aligned to calendar Monday-Sunday weeks — same formula generatePlan
    // itself uses for its own startWeekMonday, so a First-timer plan's week
    // headers read the same "SEN ... – MIN ..." shape as every other mode
    // rather than an unfamiliar "whatever day you started on" boundary.
    const firstWeekMonday = addDays(planStartAnchor, -(planStartAnchor.getDay() === 0 ? 6 : planStartAnchor.getDay() - 1));

    for (let w = 0; w < totalWeeks; w++) {
      const weekStart = addDays(firstWeekMonday, w * 7);
      const days = [];
      for (let i = 0; i < 7; i++) {
        const date = addDays(weekStart, i);
        // Week 1 only: drop days before the runner's actual start date
        // instead of showing them as scheduled-but-blank rows — same
        // trimming generatePlan's own per-week loop already does.
        if (w === 0 && date < planStartAnchor) continue;
        const dow = date.getDay();
        days.push({ date, dayName: DAY_NAMES[dow], dow, type: 'rest', km: 0 });
      }

      const isEvaluationWeek = w === FIRST_TIMER_PROGRAM.length;
      // The 5K itself is ONE day, not every slot day that week — pinned to
      // the LAST selected day (same "takes the place of the runner's own
      // last training day" convention non-race modes already use for their
      // own evaluation week — matching how a real week tapers into race
      // day, not three race attempts in one week). The other slot day(s)
      // keep training — a short, easy shakeout (FIRST_TIMER_EVALUATION_SHAKEOUT),
      // lighter than week 8's own program, not full rest — user feedback
      // was that leaving them blank read as the program abruptly stopping
      // a week early; per user feedback the last week isn't just the 5K.
      const evaluationDow = slotDays[slotDays.length - 1];
      let totalKm = 0;
      slotDays.forEach(dow => {
        const dayObj = days.find(d => d.dow === dow);
        if (!dayObj) return;
        if (isEvaluationWeek && dow === evaluationDow) {
          // Same "real Time Trial, no prescribed pace" shape as Base
          // Building's own evaluation week (see generatePlan's 'race'-type
          // branch) — deliberately duplicated, not called, per this
          // function's own header comment.
          dayObj.type = 'evaluation';
          dayObj.km = 5;
          dayObj.structure = buildSimpleStructure(5);
        } else {
          const program = isEvaluationWeek ? FIRST_TIMER_EVALUATION_SHAKEOUT : FIRST_TIMER_PROGRAM[w];
          const { structure, km } = buildRunWalkStructure(program);
          dayObj.type = 'runWalk';
          dayObj.km = km;
          dayObj.structure = structure;
        }
        totalKm += dayObj.km;
      });

      weeks.push({
        weekNumber: w + 1,
        startDate: days[0].date,
        endDate: days[days.length - 1].date,
        phase: isEvaluationWeek ? 'Evaluasi' : 'Base',
        totalKm: Math.round(totalKm * 10) / 10,
        days,
      });
    }

    const allDayKm = weeks.flatMap(w => w.days.map(d => d.km || 0));

    return {
      meta: {
        raceLabel: raceLabel || FIRST_TIMER_RACE_LABEL,
        raceDistanceKm: 5,
        raceDate: weeks[weeks.length - 1].endDate,
        mode: 'firstTimer', nonRaceStyle: null,
        planWeeks: totalWeeks, taperWeeks: 1, buildWeeks: FIRST_TIMER_PROGRAM.length,
        peakWeeklyKm: Math.max(...weeks.map(w => w.totalKm)),
        peakLongRunKm: Math.round(Math.max(...allDayKm) * 10) / 10,
        goalPaceSec: null, paces: null,
        currentFitnessPaceSec: null,
        goalPaceSource: null,
        recentRaceTimeSec: null, recentRaceDistanceKm: null, predictedRaceTimeSec: null,
        planStart: weeks[0].startDate,
        weeksAvailable: totalWeeks,
        maxSupportKm: null,
      },
      warnings: [
        'Ini program 9 minggu run/walk buat yang belum pernah lari sama sekali — 3 hari seminggu, interval larinya makin panjang tiap minggu sampai kamu siap lari 5K penuh di minggu terakhir. Dengarkan tubuhmu: kalau satu minggu terasa berat, ulangi minggu yang sama sebelum lanjut, jangan dipaksa naik.',
        'Minggu 9 diakhiri lari 5K sungguhan (bukan dipatok pace tertentu) — catat waktumu, lalu generate plan baru pakai mode Base Building dan masukkan waktu itu sebagai "waktu race terakhir" biar plan berikutnya dihitung dari kemampuan barumu.',
      ],
      weeks,
    };
  }
  // ===================== end First-timer mode =====================

  function generatePlan(settings) {
    // Dispatches away from every race/non-race concept below entirely —
    // see generateFirstTimerPlan's own header comment for why this can't
    // just be another isNonRace-style branch inside the function that
    // follows.
    if (settings.mode === 'firstTimer') return generateFirstTimerPlan(settings);

    const {
      raceDistanceKm, raceLabel, raceKey, raceDate, startDate,
      fitnessLevel, currentWeeklyKm, longestRecentRunKm, daysPerWeek, preferredDays, longRunDay,
      targetTimeSec, recentRaceTimeSec, recentRaceDistanceKm, conservativeMode,
      // mode: 'race' (default, existing behavior) | 'nonRace'. nonRaceStyle:
      // 'baseBuilding' | 'maintenance', only meaningful when mode is
      // 'nonRace'. Non-race callers (js/app.js) pass their chosen `endDate`
      // in as `raceDate` — a real calendar date the block's own math
      // (weeksAvailable/planWeeks/phase/cutback below) can anchor to
      // unchanged, exactly as it already does for a real race. What
      // actually differs for non-race plans is scoped narrowly below:
      // taper collapses to a single evaluation week instead of a real
      // race's multi-week taper, there's no race-pace rehearsal long run,
      // the final day is an "Evaluasi" self-test instead of "RACE DAY!",
      // and Maintenance additionally holds volume flat and ramps VDOT only
      // a token amount instead of progressing toward a goal.
      mode, nonRaceStyle,
    } = settings;
    const isNonRace = mode === 'nonRace';
    const isMaintenance = isNonRace && nonRaceStyle === 'maintenance';
    // Base Building's whole point is raising the aerobic base — mostly
    // Easy running plus a Marathon-pace steady day, NOT the race-specific
    // Tempo/Interval/Repetition mix Race mode (and Maintenance, via its own
    // Fartlek-swapped rotation) use. See the qualityPrimary/qualitySecondary
    // resolution below, which is the only place this actually changes
    // anything — everything else (volume ramp, cutback, long-run range from
    // "gaya latihan") stays identical to Race mode's own machinery.
    const isBaseBuilding = isNonRace && nonRaceStyle === 'baseBuilding';

    // Anchor for "how many weeks do I actually have before race day" — the
    // date the runner wants to start training, not necessarily today (e.g.
    // they're finishing up something else first). Falls back to today when
    // not given, which is the previous, unconditional behaviour.
    const planStartAnchor = startOfDay(startDate || new Date());
    const race = startOfDay(raceDate);
    const profile = resolveRaceProfile(raceDistanceKm, raceKey);
    // This race's quality-session mix (see QUALITY_ROTATIONS above) —
    // resolved once here, alongside profile, and reused by qualityPick
    // every week below rather than re-resolving per week.
    const qualityRotation = resolveQualityRotation(raceDistanceKm, raceKey);
    // profile.maxSupportKm is used as-is regardless of daysPerWeek — no
    // per-day scaling. That was tried (scaling it down at 3-4 days, up at
    // 6) to stop a low-day plan's one remaining easy slot from ballooning
    // on a high-volume week, but it fought the more basic relationship a
    // flat cap + longRunClampDeltaKm's redistribution (below) already
    // gets right on its own: for the *same* weekly total, spreading it
    // across more sessions naturally makes each one smaller, not bigger —
    // scaling the ceiling *up* at higher day counts was backwards from
    // that. A flat ceiling this file's day-agnostic proportional split
    // already respects (each slot's raw share only shrinks as
    // weeklySplitForDays divides the week's non-long-run budget across
    // more slots) is what actually prevents the original ballooning
    // symptom, without needing a day-based multiplier on top of it.
    //
    // Scaling by volume is a different axis, though, and IS needed — see
    // supportKmScaleFactor below (computed once theoreticalPeakWeeklyKm is
    // available, since that — not currentWeeklyKm itself — is what actually
    // needs comparing against the reference volume these caps were sourced
    // at). maxSupportKm itself is assigned once that's resolved.
    let maxSupportKm = profile.maxSupportKm; // reassigned below, once supportKmScaleFactor is known
    const isFullMarathonPlan = profile === RACE_PROFILES.full;
    // Race-specific long run (MSL, or its half-marathon equivalent): a
    // long run partly held at goal race pace (see
    // buildRaceSpecificLongRunStructure above) — only meaningful when the
    // race distance itself is close enough to typical long-run distances
    // for race-pace practice within one to make sense (marathon and half
    // marathon; a 5K/10K's long run is far longer than the race itself,
    // so there's no equivalent "race-pace long run" concept for those),
    // and only scheduled during the Peak phase — the block of build weeks
    // with the highest long-run distances, right before taper (see
    // buildPhaseForWeek).
    // Race-pace rehearsal only makes sense against a real race — non-race
    // plans have no actual race pace to rehearse for, so this is forced off
    // regardless of which "gaya latihan" template the user picked.
    const usesRaceSpecificLongRun = !isNonRace && (profile === RACE_PROFILES.full || profile === RACE_PROFILES.half);
    const raceSpecificPaceLabel = isFullMarathonPlan ? 'Marathon' : 'Half Marathon';

    // Weeks always run Monday-Sunday (the conventional training-plan grid,
    // and what lets every week's "phase" and taper logic line up with a
    // calendar week) — counted here as whole Monday-anchored weeks between
    // planStartAnchor's own week and race week, inclusive. When
    // planStartAnchor isn't itself a Monday, its week still counts as one
    // available week even though only part of it is actually usable — see
    // firstMonday/the days-array filter below, which trims week 1 down to
    // just planStartAnchor onward instead of either (a) silently dropping
    // those leading days by rounding the whole plan forward to the next
    // Monday, or (b) scheduling sessions on days before the runner said
    // they'd start.
    const raceWeekMonday = addDays(race, -(race.getDay() === 0 ? 6 : race.getDay() - 1));
    const startWeekMonday = addDays(planStartAnchor, -(planStartAnchor.getDay() === 0 ? 6 : planStartAnchor.getDay() - 1));
    const weeksAvailable = Math.max(1, Math.floor((raceWeekMonday - startWeekMonday) / MS_PER_DAY / 7) + 1);

    let planWeeks = Math.min(weeksAvailable, profile.recWeeks);
    // Non-race plans don't taper for a race — they end in a single
    // deload + optional self-test ("Evaluasi") week instead of the
    // real race's multi-week taper (profile.taperWeeks), so this is
    // forced to at most 1 week regardless of "gaya latihan".
    let taperWeeks = isNonRace
      ? Math.min(1, Math.max(planWeeks - 1, 0))
      : Math.min(profile.taperWeeks, Math.max(planWeeks - 1, 0));
    let buildWeeks = Math.max(planWeeks - taperWeeks, 1);

    // Where the Peak phase starts within the build block, and how many
    // Peak weeks it spans — used below to progressively ramp the
    // race-pace share of each race-specific long run (MSL_PACE_FRACTION_
    // START/END) across those weeks, rather than jumping straight to one
    // fixed fraction. Computed once here since it only depends on
    // buildWeeks, not on any individual week.
    const peakStartWeek = peakPhaseStartWeek(buildWeeks);
    const peakWeeksTotal = Math.max(1, buildWeeks - peakStartWeek);

    // Deliberately mode-specific, NOT one shared constant — an earlier
    // version of this file used the same WEEKLY_GROWTH_RATE for Race and
    // non-race modes alike (the original design's own reasoning: "so both
    // give a consistent, evidence-based sense of how fast weekly mileage
    // can safely grow"), and non-race-specific tuning (see
    // nonRaceWeeklyGrowthRate below) ended up silently regressing Race
    // mode: a 16-week full marathon block landed at only ~29km peak long
    // run (its floor) instead of climbing toward 32km, because the shared
    // curve's own growth target didn't scale with buildWeeks the way
    // Race mode's flat rate always did (see growthMultiplier below, whose
    // whole point is that a longer buildWeeks compounds a flat per-week
    // rate further — a flat multiplier cap regardless of plan length is
    // literally the older bug that design exists to prevent). Each mode
    // now gets its own rate, computed independently, so tuning one can
    // never again silently move the other.
    const RACE_WEEKLY_GROWTH_RATE = conservativeMode ? 1.05 : 1.08;

    // Non-race modes' own rate — scaled by the runner's OWN currentWeeklyKm
    // rather than one flat rate for everyone: a lower-volume runner has
    // more adaptive headroom and tolerates faster relative growth, while a
    // higher-volume runner is closer to their individual ceiling and needs
    // a more conservative pace — total weekly-volume growth itself isn't
    // strongly injury-predictive on its own (see MAX_LONG_RUN_JUMP_RATIO's
    // own BJSM citation, which is why that ratio is tuned separately and
    // doesn't move with this), but it should still track the same "steep
    // zone under ~35-45km/week, tapering off by ~60km/week" shape
    // VOLUME_GAIN_PLATEAU_KM is sourced from, rather than treating a
    // 20km/week beginner and a 55km/week regular runner identically. Only
    // Base Building actually schedules progressive growth (Maintenance
    // holds volume flat regardless — see isMaintenance below), but this is
    // computed for isNonRace generally so it's available wherever needed
    // (e.g. a future non-race prep-phase suggestion).
    //
    // A first attempt at this used 3 discrete tiers (flat rate below 40,
    // stepped down at 40, again at 50) and hit a real bug: the step right
    // at 40 was steep enough that a 30km/week runner (still in the "fast"
    // tier) ended up with a HIGHER peak (64km) than a 45km/week runner
    // (already in the "slower" tier, 57km) — despite starting with LESS
    // volume. Any hard boundary risks this once the rate on either side
    // differs enough, so this is a smooth curve instead: peak weekly
    // volume as a function of currentWeeklyKm (x) is modeled as
    // peak(x) = C · x^q, which is monotonically increasing in x for any
    // x>0 by construction — there's no boundary to jump across — while
    // still tapering (diminishing returns) the way the tiers were trying
    // to approximate: the growth MULTIPLIER peak(x)/x = C·x^(q-1)
    // decreases smoothly as x grows, exactly the "faster from a lower
    // base" shape wanted, just without a cliff. q and C are solved from
    // two confirmed reference points — (20km/week → ~40km/week peak, the
    // original "roughly doubling" example) and (45km/week → ~57-58km/week
    // peak, user-confirmed "~55-60km, +25%" specifically for that volume)
    // — giving q ≈ 0.45, C ≈ 10.39, calibrated against a REFERENCE block
    // of GROWTH_CURVE_REFERENCE_WEEKS build weeks specifically (the two
    // reference points above both came from ~10-build-week test plans —
    // Base Building's own block length is always close to this in
    // practice, since 'medium'/'5k'/'10k'/'half' style templates cap
    // recWeeks at 8-12, but the fixed reference below still protects a
    // longer non-race block the same way it protects Race mode's marathon
    // case, rather than assuming that coincidence holds forever).
    //
    // WEEKLY_GROWTH_RATE is deliberately derived by dividing by that FIXED
    // reference week count, NOT the plan's own actual buildWeeks — dividing
    // by actual buildWeeks would silently erase the "a longer block has
    // more weeks to compound, so it can reach a realistically higher peak"
    // property growthMultiplier's own clamp below depends on (raising a
    // rate back to the exact week count it was derived from always
    // reconstructs the same target, no matter how long buildWeeks actually
    // is). Dividing by the fixed reference instead keeps this rate a pure
    // function of currentWeeklyKm (x), and lets growthMultiplier do what it
    // always did: a longer buildWeeks compounds this same per-week rate
    // further. Monotonicity in x still holds for any buildWeeks up to ~18
    // — raising the monotonic-in-x quantity C·x^(q-1) to any single fixed
    // power preserves monotonicity, it just changes how steep the curve
    // is, so a longer block reaching further doesn't reopen the earlier
    // discrete-tier non-monotonicity bug.
    //
    // conservativeMode scales the target multiplier's excess above 1.0 by
    // the same ratio (0.625) its own flat 5%-vs-8% already implied, rather
    // than a separate curve.
    const GROWTH_CURVE_EXPONENT = 0.45;
    const GROWTH_CURVE_COEFFICIENT = 10.39;
    const GROWTH_CURVE_REFERENCE_WEEKS = 10;
    const targetGrowthMultiplier = GROWTH_CURVE_COEFFICIENT * Math.pow(Math.max(currentWeeklyKm, 1), GROWTH_CURVE_EXPONENT - 1);
    const adjustedGrowthMultiplier = conservativeMode
      ? 1 + (targetGrowthMultiplier - 1) * 0.625
      : targetGrowthMultiplier;
    const nonRaceWeeklyGrowthRate = Math.pow(Math.max(adjustedGrowthMultiplier, 1), 1 / GROWTH_CURVE_REFERENCE_WEEKS);
    const WEEKLY_GROWTH_RATE = isNonRace ? nonRaceWeeklyGrowthRate : RACE_WEEKLY_GROWTH_RATE;

    const warnings = [];
    if (conservativeMode) {
      warnings.push('Mode latihan konservatif aktif — kenaikan volume mingguan, porsi speedwork, dan kenaikan jarak long run di plan ini sengaja diturunkan untuk menjaga cedera/nyeri yang kamu tandai. Kalau nyeri berlanjut, konsultasikan ke dokter/fisioterapis olahraga.');
    }
    if (isNonRace && !conservativeMode && taperWeeks > 0) {
      warnings.push('Minggu terakhir ada Time Trial 5K opsional — lari secepat yang bisa kamu jaga (bukan target pace tertentu, ini beda dari sesi lain di plan ini), lalu catat waktumu. Waktu itu bisa dimasukkan sebagai "waktu race terakhir" (pilih jarak 5K) pas generate plan berikutnya, supaya estimasi pace & VDOT-nya makin akurat dari kondisimu yang sekarang — bukan wajib, tapi lebih informatif daripada nebak.');
    }
    // Base Building's whole point is raising mileage from a lower baseline
    // — past VOLUME_GAIN_PLATEAU_KM, that headroom is mostly gone (same
    // reasoning goalPaceSec's volumeGainMultiplier above already applies to
    // pace gains). This plan's long-run range still scales with
    // supportKmScaleFactor (see peakLongRunKm below), so it isn't a hard
    // wall the way it was before that fix, but growth genuinely does get
    // harder to sustain up here regardless — Maintenance's flat-volume
    // design doesn't have any ceiling to run into in the first place, so
    // it's the better fit once volume is already this high. Advisory
    // only — doesn't block or auto-switch, since the runner may have a
    // real reason to keep pushing volume regardless.
    if (isBaseBuilding && currentWeeklyKm >= VOLUME_GAIN_PLATEAU_KM) {
      warnings.push(`Volume mingguanmu sekarang (${currentWeeklyKm} km) sudah di titik di mana Base Building lewat penambahan volume biasanya makin nggak signifikan hasilnya. Kalau tujuanmu sekarang lebih ke jaga fitness daripada terus naikin mileage, mode Maintenance kemungkinan lebih pas. Base Building tetap bisa dipakai, cuma progresnya bakal kerasa terbatas dari titik ini.`);
    }
    if (weeksAvailable < profile.recWeeks) {
      // raceLabel is a real race name in race mode, but "Aerobic Base"/
      // "Flat Volume" (see js/app.js's NON_RACE_LABEL) in non-race mode —
      // "rekomendasi umum untuk Aerobic Base" reads oddly, so this drops
      // the label entirely for non-race rather than naming the block.
      const recWeeksSubject = isNonRace ? 'blok latihan ini' : raceLabel;
      warnings.push(`Waktu persiapanmu (${weeksAvailable} minggu) lebih pendek dari rekomendasi umum untuk ${recWeeksSubject} (${profile.recWeeks} minggu). Plan ini dipadatkan — fokus jaga konsistensi dan hindari lompatan volume terlalu besar.`);
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
      // Same raceLabel concern as the short-time warning above — "training
      // block Aerobic Base standar" reads oddly, and "sebelum race" is
      // literally wrong when there's no race (raceDate is really just the
      // block's own end date — see generatePlan's mode/nonRaceStyle
      // comment). Non-race phrasing drops both, AND drops the whole
      // "manfaatkan buat naikkan base mileage ke ~X km/minggu" prep-target
      // suggestion below — that's advice for building toward a SEPARATE
      // race-specific block waiting on the other side of the extra weeks,
      // which doesn't apply here: Base Building/Maintenance already IS the
      // base-building block, there's no further structured block it's
      // prepping the runner for.
      if (isNonRace) {
        warnings.push(`Kamu punya ${extraWeeks} minggu ekstra sebelum akhir blok. Plan detail di bawah mencakup ${planWeeks} minggu terakhir (blok yang kamu pilih). Plan di bawah tetap dihitung dari kondisimu sekarang — generate ulang lebih dekat ke tanggal mulai training kalau kondisimu sudah berubah, supaya peak volume & long run-nya ikut menyesuaikan jadi lebih kuat.`);
      } else {
        warnings.push(`Kamu punya ${extraWeeks} minggu ekstra sebelum race. Plan detail di bawah mencakup ${planWeeks} minggu terakhir (training block ${raceLabel} standar) — sebelum itu, manfaatkan buat naikkan base mileage bertahap dari ~${Math.round(prepStartKm)} ke sekitar ${prepTargetWeeklyKm} km/minggu (kira-kira +${Math.round((WEEKLY_GROWTH_RATE - 1) * 100)}% tiap minggu, laju kenaikan aman yang sama dipakai di plan ini). Plan di bawah tetap dihitung dari kondisimu sekarang — generate ulang lebih dekat ke tanggal mulai training kalau base mileage-mu sudah naik, supaya peak volume & long run-nya ikut menyesuaikan jadi lebih kuat.`);
      }
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
      // 2 quality (tempo/interval/repetition) sessions a week is more
      // actual fitness-improving stimulus than 1 — earlier this app only
      // reflected that in how fast weekly pace targets *ramped toward* the
      // goal (see paceProgress below), leaving the goal itself, and so the
      // final VDOT, identical either way. A runner training harder should
      // be projected to land at a faster goal pace too, not just get there
      // sooner and plateau at the same number a 1-session plan reaches —
      // so the achievable gain itself scales with quality-session count.
      const qualityGainMultiplier = qualitySessionsForDays(daysPerWeek) >= 2 ? 1.3 : 1;
      // Aerobic base (weekly volume) is its own driver of fitness gains,
      // separate from quality-session stimulus — but with diminishing
      // returns as it climbs, not a flat "more is better" (see
      // VOLUME_GAIN_PLATEAU_KM above for the sourcing). So this isn't "more
      // growth = more gain" (that direction doesn't hold up — see the
      // reverted first attempt at this) but "more *room below the plateau*
      // = more gain": a runner already running near/above the plateau has
      // little headroom left for volume-driven gains regardless of
      // qualityGainMultiplier, while one starting well under it does.
      // Deliberately modest (up to +25% at currentWeeklyKm near 0, none
      // at/above the plateau) so it nudges the projection rather than
      // dominates it.
      const volumeHeadroom = clamp(1 - currentWeeklyKm / VOLUME_GAIN_PLATEAU_KM, 0, 1);
      const volumeGainMultiplier = 1 + volumeHeadroom * 0.25;
      // Runners already at a fast pace have less room left to get faster
      // for the same training stimulus. Above the 6:00/km neutral point
      // (currentEquivPaceSec slower than that — plenty of room, multiplier
      // >1), the slope is the one running-economy research measured
      // ("Extrapolating Metabolic Savings in Running", PMC6378703: a 1%
      // economy improvement bought a 4:30:00 marathoner, ~6:24/km/384
      // sec/km, 1.17% more pace vs only 0.65% for a 2:03:00 marathoner,
      // ~2:55/km/175 sec/km), re-anchored to cross exactly 1.0 at 6:00/km
      // instead of the study's own ~5:16/km crossing point — capped at
      // the same 1.17 ceiling that slope reaches by ~7:08/km.
      //
      // Below 6:00/km, the falloff is deliberately steeper than that
      // measured slope would give (see paceLevelFastFactor above) — the
      // study's own slope was measured across an elite-only range this
      // app's recreational audience won't occupy, and within the
      // 6:00-3:00/km range real users actually span, the harder-to-improve
      // effect is judged to bite sooner and harder than a straight
      // extrapolation of that slope would show.
      const PACE_LEVEL_NEUTRAL_SEC = 360; // 6:00/km
      const PACE_LEVEL_SLOW_SLOPE = (1.17 - 0.65) / (384 - 175); // per sec/km, from the study
      const PACE_LEVEL_CEILING_FACTOR = 1.17;
      const paceLevelMultiplier = currentEquivPaceSec >= PACE_LEVEL_NEUTRAL_SEC
        ? Math.min(PACE_LEVEL_CEILING_FACTOR, 1 + (currentEquivPaceSec - PACE_LEVEL_NEUTRAL_SEC) * PACE_LEVEL_SLOW_SLOPE)
        : paceLevelFastFactor(currentEquivPaceSec);
      // qualityGainMultiplier/volumeGainMultiplier/paceLevelMultiplier each
      // have their own individually-modest ceiling (1.3/1.25/1.17), but
      // multiplied together they stack: a runner who happens to hit the
      // favorable end of all three at once (2 quality sessions, well under
      // the volume plateau, starting pace slower than 6:00/km) gets
      // 1.3*1.25*1.17 ≈ 1.90x — nearly double CONSERVATIVE_FITNESS_GAIN_PCT's
      // own "deliberately modest" base rate, which defeats the point of
      // that base rate being conservative in the first place. Capped at
      // 1.3x combined (only clamps the aggressive/upper tail — a fast
      // runner's paceLevelMultiplier can still legitimately pull the
      // product well BELOW 1, correctly projecting less room to improve)
      // so at most one factor's worth of "extra stimulus" credit applies,
      // not all three simultaneously.
      const STIMULUS_MULTIPLIER_CAP = 1.3;
      const stimulusMultiplier = Math.min(STIMULUS_MULTIPLIER_CAP, qualityGainMultiplier * volumeGainMultiplier * paceLevelMultiplier);
      // Non-race modes (both Base Building and Maintenance — see
      // NON_RACE_FITNESS_GAIN_PCT's own comment for why Base Building is
      // included here too) skip this whole multi-factor stack (quality-
      // session count, volume headroom, current pace level) and its
      // per-fitness-level base rate — none of that "how much room is there
      // to chase a goal" reasoning applies when there's no goal being
      // chased, just a token improvement.
      const gainFraction = isNonRace
        ? NON_RACE_FITNESS_GAIN_PCT
        : CONSERVATIVE_FITNESS_GAIN_PCT[fitnessLevel]
          * clamp(buildWeeks / profile.recWeeks, 0, 1)
          * (conservativeMode ? 0.5 : 1)
          * stimulusMultiplier;
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

    // The block's start/end VDOT — ramped directly in VDOT-space week to
    // week (see weekVdotScore below), rather than ramping PACE and
    // re-deriving VDOT from that pace afterward like weekPaces.goal still
    // does. That distinction matters specifically for currentVdot: when a
    // recent race exists, currentFitnessPaceSec above already went through
    // predictRaceTime (Riegel) to translate it to raceDistanceKm — a
    // second, independent cross-distance model from VDOT's own
    // %VO2max-vs-duration curve, and the two don't perfectly agree,
    // especially across a big distance jump (5K -> marathon). Re-deriving
    // VDOT from that Riegel-translated pace (the previous approach) could
    // land noticeably off the VDOT computed DIRECTLY from the actual
    // recent-race performance — the exact number already shown, unRiegel'd,
    // on the plan's own top-level "Zona Pace" card (see
    // js/app.js's renderPaceZones) — which is what a runner would actually
    // compare week 1's badge against. Computing currentVdot the same
    // direct way keeps the two in agreement (mod the small ramp already
    // applied by week 1's own paceProgress). goalVdot doesn't have an
    // equivalent "direct" option — it's inherently a projection, so some
    // cross-distance model is unavoidable when recentRaceDistanceKm !=
    // raceDistanceKm — so it's still derived from goalPaceSec as before;
    // Riegel's actual job (predicting a finish time) is confined to that
    // projection and to predictedRaceTimeSec, not reused for this.
    const currentVdot = (recentRaceTimeSec && recentRaceDistanceKm)
      ? PaceForgeVDOT.vdotFromPerformance(recentRaceDistanceKm, recentRaceTimeSec)
      : PaceForgeVDOT.vdotFromGoalPace(raceDistanceKm, currentFitnessPaceSec);
    const goalVdot = PaceForgeVDOT.vdotFromGoalPace(raceDistanceKm, goalPaceSec);

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

    // profile.longRunMin/Max and profile.maxSupportKm (maxSupportKm
    // reassigned just below) were sourced from Hal Higdon's Intermediate 1
    // plans at whatever peak volume those specific published plans reach
    // (see RACE_PROFILES' own comment) — a plan whose own peak volume
    // target is already well past that reference needs both ranges to grow
    // with it, or they clamp hard against a ceiling calibrated for a
    // smaller plan. Compared against theoreticalPeakWeeklyKm here, NOT
    // currentWeeklyKm — growthMultiplier alone can push the former well
    // past referenceWeeklyKm even while the runner's *starting* volume is
    // still comfortably under it (e.g. 36km/week compounding toward
    // ~78km/week over an 11-week block), so currentWeeklyKm was the wrong
    // thing to compare and left this basically inert for exactly the
    // inputs it needed to catch: confirmed live, a 36km/week, 3-day input
    // (whose 50% long-run share hits longRunMax especially early) produced
    // a nearly flat 34-34.5km chart for its entire Base/Build/Peak arc
    // before this fix, currentWeeklyKm-based scaling included. Floored at
    // 1 (never shrinks either ceiling below its sourced value — a low-
    // volume plan's raw shares are already small on their own, this only
    // ever needs to grow) and capped at 2.5x so an extreme input doesn't
    // blow either ceiling out to an implausible number.
    //
    // Two SEPARATE reference volumes/factors, not one shared — an earlier
    // version of this fix used a single factor (both referenced against
    // the fixed 5-day Higdon plans' own implied peak volume) and still
    // reproduced a near-identical flat-growth bug for low-day plans
    // specifically: confirmed live, 40km/week at 3 days/week peaked at
    // just 39km (vs 54km at 5 days/week, same currentWeeklyKm). Cause:
    // longRunShare is 50% at 3 days/week vs 35% at 5, so the RAW long-run
    // target (theoreticalPeakWeeklyKm * longRunShare) grows faster than a
    // 5-day-referenced factor scales the ceiling to match — the ceiling
    // clamped it back down regardless, and since peakWeeklyKm is built
    // FROM peakLongRunKm, the whole week stayed capped near
    // currentWeeklyKm. longRunScaleFactor below is referenced against
    // THIS plan's own actual longRunShare instead, so a low-day plan's
    // bigger long-run demand gets matched by proportionally more scaling
    // headroom, not the same headroom a 5-day plan would get.
    // maxSupportKm's own factor stays 5-day-referenced (reconstructing
    // what Higdon's own 5-day/week plans peaked at, per RACE_PROFILES'
    // sourcing comment) since it isn't tied to longRunShare the same
    // direct multiplicative way a day-count-driven long-run ceiling is.
    //
    // Non-race-only, same as longRunScaleFactor just below — kept separate
    // from Race mode for the same "don't let non-race-specific tuning
    // silently move Race mode" reason WEEKLY_GROWTH_RATE was split above:
    // Race mode's maxSupportKm stays exactly at its Higdon-sourced value
    // regardless of the runner's volume, matching how its long-run range
    // already does.
    const maxSupportReferenceWeeklyKm = profile.longRunMax / weeklySplitForDays(5).longRunShare;
    const maxSupportScaleFactor = isNonRace ? clamp(theoreticalPeakWeeklyKm / maxSupportReferenceWeeklyKm, 1, 2.5) : 1;
    maxSupportKm = profile.maxSupportKm * maxSupportScaleFactor;
    // Long-run range scaling is non-race-only, unlike maxSupportKm just
    // above — a real race's long run is bounded by the RACE itself, not
    // just "how much volume can fit in one session": scaling it the same
    // way for Race mode let a 70km/week half-marathon plan's peak long run
    // reach ~47.5km, more than double the actual 21.1km race distance,
    // which no amount of extra weekly volume makes sensible prep for that
    // specific race. Non-race modes have no such external distance to stay
    // bounded by (see isNonRace's own settings-destructuring comment), so
    // they keep scaling — this is exactly the mechanism the flat-Base-
    // Building-growth bug above needed fixed. Race mode's long run instead
    // stays at its Higdon-sourced value regardless of how much extra
    // volume the runner already carries; maxSupportKm scaling still lets
    // that extra volume go into MORE/longer non-long-run sessions instead.
    const longRunReferenceWeeklyKm = profile.longRunMax / longRunShare;
    const longRunScaleFactor = clamp(theoreticalPeakWeeklyKm / longRunReferenceWeeklyKm, 1, 2.5);
    const scaledLongRunMin = isNonRace ? profile.longRunMin * longRunScaleFactor : profile.longRunMin;
    const scaledLongRunMax = isNonRace ? profile.longRunMax * longRunScaleFactor : profile.longRunMax;

    // Aim for the race's recommended long-run range (now scaled — see
    // above) — longRunShare already reflects a realistic per-days-per-week
    // share (see weeklySplitForDays).
    const peakLongRunKm = clamp(theoreticalPeakWeeklyKm * longRunShare, scaledLongRunMin, scaledLongRunMax);

    // theoreticalPeakWeeklyKm * longRunShare (the long run's raw, nominal
    // slice of the week) almost never survives peakLongRunKm's own
    // longRunMin/Max clamp untouched — fewer training days give the long
    // run a bigger nominal share (50% at 3 days/week vs 27% at 6), so the
    // same currentWeeklyKm input pushes that raw slice PAST longRunMax on
    // a low-day plan (clamped down — the long run "gives back" the
    // excess), while at 6 days the smaller 27% share undershoots even
    // longRunMin (clamped up — the long run "borrows" a deficit just to
    // reach a sane minimum). Left unaccounted for, both directions warp
    // the non-long-run sessions relative to one another across day counts
    // even for the exact same currentWeeklyKm: excess that just vanishes
    // makes a low-day plan's *total* look artificially small, and an
    // unaccounted-for deficit makes a high-day plan's total look
    // artificially big — the opposite of what more training days spread
    // across should do to any one session. Net-ing this delta across the
    // non-long-run slots below (proportional to their own weights, still
    // subject to the same maxSupportKm/95%-of-long-run caps every support
    // session already respects) keeps the week's total anchored to
    // theoreticalPeakWeeklyKm regardless of daysPerWeek, without touching
    // the long run's own number (peakLongRunKm) at all either way.
    const longRunClampDeltaKm = theoreticalPeakWeeklyKm * longRunShare - peakLongRunKm;
    const supportWeightSum = baseSlotWeights.reduce((s, w) => s + w, 0) || 1;

    // The REAL peak weekly volume this plan will ever schedule: peakLongRunKm
    // (above) plus whatever each support slot (easy/recovery/tempo/interval)
    // actually caps out at — the same maxSupportKm and "never >= that
    // week's long run" ceilings the per-day loop below enforces, evaluated
    // here up front. Ramping
    // week-by-week progress toward THIS (rather than the unbounded
    // theoreticalPeakWeeklyKm) is what makes the plan actually climb
    // gradually across the whole build block and peak only in its final
    // week(s) — ramping toward the theoretical number instead made every
    // week identical for however long it took theoreticalPeakWeeklyKm's
    // growth to run past what the caps allow, because the *visible*
    // schedule hit its ceiling in, say, week 5 of a 13-week build block and
    // had nowhere further to go for the remaining 8.
    const peakWeeklyKm = peakLongRunKm + baseSlotWeights.reduce(
      (sum, w) => sum + Math.max(0, Math.min(
        theoreticalPeakWeeklyKm * w + longRunClampDeltaKm * (w / supportWeightSum),
        maxSupportKm,
        peakLongRunKm * 0.95
      )),
      0
    );

    // Safe long-run ramp: don't let the scheduled long run jump up from the
    // runner's actual longest recent run any faster than a sensible weekly
    // increment (~10%, or 1.5km for very short current long runs, whichever
    // is bigger). The ramp base only ever grows (tracks the highest long run
    // scheduled so far) so a cutback week doesn't reset the allowance.
    //
    // 10%/8% (not the previous 20%/15%) per a large 2023-24 cohort study
    // (BJSM, 5,205 runners, 18 months, 588k GPS-tracked sessions — see
    // https://www.researchgate.net/publication/393493797): unlike total
    // weekly mileage growth (which the same study found NOT predictive of
    // injury, undermining the old blanket "10% rule" for that metric),
    // injury risk rose sharply specifically when a single run exceeded
    // 110% of the runner's longest run in the prior 30 days — a 30% jump
    // raised injury risk 64%, doubling it more than doubled the risk. The
    // long run is exactly that "single longest run" growing week to week
    // in a plan, so it's this ratio the finding actually applies to.
    const longRunStartKm = Math.max(longestRecentRunKm || 0, 2);
    let longRunRampBase = longRunStartKm;
    const MAX_LONG_RUN_JUMP_RATIO = conservativeMode ? 0.08 : 0.10;
    const MIN_LONG_RUN_JUMP_KM = conservativeMode ? 1 : 1.5;

    // Taper factors applied to peakWeeklyKm, last entry = race week.
    const TAPER_FACTORS = { 1: [0.55], 2: [0.75, 0.5], 3: [0.75, 0.6, 0.4] };
    const taperFactors = TAPER_FACTORS[taperWeeks] || [];

    // Monday of the detailed plan's first week: walk backwards planWeeks
    // full Monday-Sunday weeks from raceWeekMonday (see weeksAvailable
    // above). When the full lead time is used (planWeeks === weeksAvailable,
    // the common case) this lands on planStartAnchor's own week — its
    // days-array gets trimmed to planStartAnchor onward below rather than
    // scheduling anything before it.
    const firstWeekStart = addDays(raceWeekMonday, -(planWeeks - 1) * 7);

    const sortedPreferredDays = [...preferredDays].sort((a, b) => chronoRank(a) - chronoRank(b));

    // Pace (VDOT) progress speed: more quality (tempo/interval/repetition)
    // sessions per week is more actual fitness-improving stimulus, so a
    // 2-quality-session plan (5-6 days/week) should reach goal pace sooner
    // than a 1-quality-session plan (3-4 days/week) of the same length —
    // not, as before, at literally the same fraction of the build block
    // regardless of how much quality work is actually happening each week.
    // 1.25x lets a 2-session plan reach goal pace by ~80% of the way
    // through the build block and hold it for the rest (paceProgress is
    // clamped to 1 below); a 1-session plan is unaffected (1x — reaches it
    // exactly at the last build week, same as before this existed).
    const qualitySessionsThisPlan = qualitySessionsForDays(daysPerWeek);
    const PACE_PROGRESS_MULTIPLIER = qualitySessionsThisPlan >= 2 ? 1.25 : 1;

    const weeks = [];
    let actualPeakLongRunKm = 0;
    let rampLimited = false;
    let supportSessionCapped = false;
    let actualPeakWeeklyKm = 0;

    for (let w = 0; w < planWeeks; w++) {
      const weekStart = addDays(firstWeekStart, w * 7);
      const isTaperWeek = w >= buildWeeks;
      const isRaceWeek = w === planWeeks - 1;

      let weekKm;
      let longRunTargetKm; // this week's long run before the ramp-safety clamp further below
      let phase;
      let paceProgress; // 0 (currentFitnessPaceSec) -> 1 (goalPaceSec); see weekPaces below
      if (!isTaperWeek && isMaintenance) {
        // Maintenance: volume stays flat at the runner's own current base
        // (no WEEKLY_GROWTH_RATE compounding, no cutback week) — the
        // "rest" mechanism here is the periodic Fartlek swap-in
        // (resolveQualitySlot above), not a volume dip. See generatePlan's
        // isMaintenance destructuring comment for why.
        const progress = buildWeeks === 1 ? 1 : (w + 1) / buildWeeks;
        paceProgress = Math.min(1, progress * PACE_PROGRESS_MULTIPLIER);
        weekKm = currentWeeklyKm;
        longRunTargetKm = longRunStartKm;
        phase = 'Maintenance';
      } else if (!isTaperWeek) {
        const progress = buildWeeks === 1 ? 1 : (w + 1) / buildWeeks;
        paceProgress = Math.min(1, progress * PACE_PROGRESS_MULTIPLIER);
        let linearKm = currentWeeklyKm + (peakWeeklyKm - currentWeeklyKm) * progress;
        // Long run gets its own direct progress-based ramp toward
        // peakLongRunKm — rather than being derived as weekKm*longRunShare
        // — so it reliably reaches the intended race-appropriate distance
        // on the final build week regardless of how weekKm's own
        // progression interacts with the support-session caps above.
        let linearLongRunKm = longRunStartKm + (peakLongRunKm - longRunStartKm) * progress;
        const weekNum1based = w + 1;
        // Base Building cutbacks less often than race-specific training —
        // research on deload frequency specifically distinguishes the two:
        // 3-4 week cycles are for race-specific/intensity-heavy training,
        // while lower-intensity base-building phases (no tempo/interval,
        // just easy + a weekly marathonPace day — see isBaseBuilding above)
        // tolerate 6-8 weeks between deloads (Fittux, "How Often Should You
        // Deload?"). Race mode keeps the original 4-week cadence.
        const CUTBACK_INTERVAL_WEEKS = isBaseBuilding ? 6 : 4;
        const isCutback = weekNum1based % CUTBACK_INTERVAL_WEEKS === 0 && weekNum1based !== buildWeeks;
        weekKm = isCutback ? linearKm * 0.8 : linearKm;
        longRunTargetKm = isCutback ? linearLongRunKm * 0.8 : linearLongRunKm;
        phase = isCutback ? 'Cutback' : buildPhaseForWeek(w, buildWeeks);
      } else if (isMaintenance) {
        // weekKm feeds this week's "other" easy days (every preferred day
        // besides the pinned Time Trial — see the day-assignment loop's
        // `if (isRaceWeek) { if (isNonRace) {...} }` branch, which sizes
        // them off weekKm × baseSlotWeights) — deliberately NOT the
        // Time Trial's own distance (fixed at 5km there) or a real long
        // run (longRunKmThisWeek is forced to 0 for isRaceWeek, so
        // longRunTargetKm below only matters as an intermediate value, not
        // a scheduled session). Deloads off Maintenance's own flat baseline
        // (currentWeeklyKm/longRunStartKm), not peakWeeklyKm/peakLongRunKm
        // — those are leftover progressive-growth figures Maintenance
        // never schedules toward.
        weekKm = currentWeeklyKm * 0.7;
        longRunTargetKm = longRunStartKm * 0.7;
        phase = 'Evaluasi';
        paceProgress = 1;
      } else {
        const taperIdx = w - buildWeeks;
        // isNonRace here covers Base Building's evaluation week too, not
        // just Race mode's real multi-week taper — see isMaintenance's own
        // comment just above for what weekKm actually drives in that case
        // (this branch's own weekKm plays the identical role for Base
        // Building/Race).
        const factor = isNonRace ? 0.7 : (taperFactors[taperIdx] ?? 0.5);
        weekKm = peakWeeklyKm * factor;
        // Taper reduces the long run by the same factor directly, rather
        // than through weekKm*longRunShare — standard taper design (e.g.
        // "75% of peak long run" in the first taper week).
        longRunTargetKm = peakLongRunKm * factor;
        phase = isNonRace ? 'Evaluasi' : (isRaceWeek ? 'Race Week' : 'Taper');
        // Taper is about cutting volume, not intensity/precision — by now
        // the runner should be able to hold goal pace, so pace targets
        // don't taper back down with the mileage.
        paceProgress = 1;
      }
      weekKm = Math.round(weekKm * 10) / 10;

      // This week's zone paces — derived from THIS week's own VDOT (ramped
      // directly in VDOT-space, currentVdot -> goalVdot by paceProgress —
      // see currentVdot's own comment above for why VDOT-space rather than
      // pace-space) run through the real Daniels/Gilbert VDOT formulas
      // (js/vdot.js) — the same ones already used to render the "Zona
      // Pace" reference table shown alongside the plan — rather than the
      // old flat PACE_MULTIPLIERS approximation, which was tuned relative
      // to goal pace directly and could land noticeably outside the
      // %VO2max-correct zone (e.g. a tempo target outside Threshold's real
      // 83-88% VO2max range) — the exact mismatch a runner comparing this
      // table against their own Zona Pace card would notice. weekPaces.goal
      // (the runner's actual predicted race pace, used for MSL segments and
      // predictedRaceTimeSec-adjacent display) keeps ramping in pace-space
      // exactly as before — only how the OTHER zones get derived changed —
      // so early-week quality sessions still target a pace the runner can
      // actually hold right now, tightening toward race-goal pace as the
      // block progresses, exactly as before.
      const weekPaces = {};
      weekPaces.goal = currentFitnessPaceSec + (goalPaceSec - currentFitnessPaceSec) * paceProgress;
      const weekVdotScore = (currentVdot && goalVdot) ? currentVdot + (goalVdot - currentVdot) * paceProgress : null;
      const weekZones = weekVdotScore ? PaceForgeVDOT.paceZonesFromVDOT(weekVdotScore) : null;
      if (weekZones) {
        // Single-number target = each zone's own midpoint — Daniels
        // publishes these as ranges, not points, but a session's own
        // schedule/structure needs one pace to build around; the full
        // range stays visible in the separate Zona Pace table for context.
        const midpoint = z => (z.fastSec + z.slowSec) / 2;
        weekPaces.easy = midpoint(weekZones.easy);
        weekPaces.tempo = midpoint(weekZones.threshold);
        weekPaces.interval = midpoint(weekZones.interval);
        weekPaces.repetition = midpoint(weekZones.repetition);
        // Daniels doesn't publish separate zones for these two: a long run
        // is run at E-pace by his own guidance (a race-specific long run's
        // marathon-pace segment is handled separately, by
        // buildRaceSpecificLongRunStructure — not here), and "recovery" is
        // only ever described qualitatively as slower than Easy, with no
        // %VO2max range of its own. Recovery uses Easy's own slow boundary
        // rather than an arbitrary extra multiplier on top — still
        // Daniels-grounded, just anchored to the loose end of a zone he did
        // publish instead of inventing a number he didn't.
        weekPaces.longRun = weekPaces.easy;
        weekPaces.recovery = weekZones.easy.slowSec;
        // Fartlek's work segments reference Interval zone as a ceiling/
        // reference pace (see buildFartlekStructure's own comment) — reuses
        // the Interval zone number directly rather than a new zone.
        weekPaces.fartlek = weekPaces.interval;
        // Base Building's own quality slot (see isBaseBuilding below) — a
        // continuous, unstructured run at Marathon zone pace (Daniels does
        // publish this one, unlike recovery/longRun above), aerobic-focused
        // rather than the race-specific T/I/R work Race/Maintenance modes
        // use. Named after the day type it drives (weekPaces[type] below),
        // not just "weekPaces.marathon", to match every other zone-per-type
        // entry here.
        weekPaces.marathonPace = midpoint(weekZones.marathon);
      } else {
        // Defensive fallback only — shouldn't occur given the pace floors
        // enforced above (MIN_PLAUSIBLE_PACE_SEC_PER_KM etc.), but the old
        // flat-multiplier approximation is a safer fallback than leaving a
        // week's zones undefined.
        Object.keys(PACE_MULTIPLIERS).forEach(zone => {
          weekPaces[zone] = currentPaces[zone] + (paces[zone] - currentPaces[zone]) * paceProgress;
        });
        weekPaces.fartlek = weekPaces.interval;
        // No flat-multiplier equivalent for Marathon zone (PACE_MULTIPLIERS
        // only ever covered recovery/easy/longRun/tempo/interval/
        // repetition) — split the difference between easy and tempo, the
        // same rough midpoint Marathon zone (75-84% VO2max) sits at between
        // Easy (59-74%) and Threshold (83-88%).
        weekPaces.marathonPace = (weekPaces.easy + weekPaces.tempo) / 2;
      }

      // Which specific workout (type + variant) fills this week's 1st/2nd
      // quality slot — resolved once here so workoutTemplate (deciding
      // *where* each type lands) and the per-day structure builder further
      // below (deciding *what shape* that type's session takes) always
      // agree, instead of picking the rotation twice and risking drift.
      // Base Building always gets exactly ONE steady Marathon-pace day
      // regardless of daysPerWeek — a 5-6 day plan's 2nd quality slot
      // (qualitySessionsForDays) falls back to plain 'easy' instead of a
      // 2nd hard-ish day, since "more easy running" (not more structured
      // sessions) is the actual goal here.
      const qualityPrimary = isBaseBuilding
        ? { type: 'marathonPace' }
        : resolveQualitySlot(w, 0, conservativeMode, qualityRotation, isMaintenance);
      const qualitySecondary = isBaseBuilding
        ? { type: 'easy' }
        : resolveQualitySlot(w, Math.floor(qualityRotation.length / 2), conservativeMode, qualityRotation, isMaintenance);

      // Build the list of workout slots for this week.
      const template = isRaceWeek
        ? buildRaceWeekTemplate(daysPerWeek)
        : workoutTemplate(daysPerWeek, qualityPrimary.type, qualitySecondary.type);

      // Week 1 only, and only when the full lead time is being used
      // (firstWeekStart landed before planStartAnchor — see above): drop
      // the days before planStartAnchor instead of showing them as
      // scheduled-but-blank "Rest" rows the runner never actually
      // had training-wise, or session slots landing on a date before
      // they said they'd start. The per-day assignment loop below already
      // no-ops when a preferred day's dayObj isn't found (see `if
      // (!dayObj) return;`), so a slot that would've landed on a trimmed
      // day is simply left unscheduled that week rather than needing any
      // special-casing here.
      const days = [];
      for (let d = 0; d < 7; d++) {
        const date = addDays(weekStart, d);
        if (w === 0 && date < planStartAnchor) continue;
        const dow = date.getDay();
        days.push({ date, dayName: DAY_NAMES[dow], dow, type: 'rest', km: 0 });
      }

      // Map ordered template slots onto the chronologically-sorted preferred days.
      const slotDays = sortedPreferredDays.slice(0, daysPerWeek);

      // Which type (and, for non-long/race slots, what share of weekKm —
      // see weeklySplitForDays) lands on which day-of-week. Race week pins
      // "race" to the real raceDate's own day-of-week (see raceDow below —
      // NOT necessarily one of the runner's regular training days, and not
      // just "whichever preferred day is chronologically last" like the
      // old index-based mapping assumed). Build/taper weeks instead pin
      // the long run to the user's chosen long-run day — falling back to
      // the last chronological slot if that day somehow isn't selected
      // this week — and fill the remaining slots with the rest of the
      // template, in order, on the other selected days, each carrying its
      // matching weeklySplitForDays weight.
      const typeByDow = {};
      const weightByDow = {};
      // Only meaningful for race week — which specific dows actually got a
      // typeByDow entry below, so the downstream per-day assignment loop
      // (see raceWeekDaysToProcess there) touches exactly those and no
      // others. Deliberately NOT "every preferred day plus raceDow": a
      // preferred day landing AFTER race day chronologically should stay
      // 'rest' (nothing scheduled once the race is over), which is already
      // `days`' own default — including it here with no typeByDow entry
      // would instead assign it `undefined` (the exact bug this whole
      // block was rewritten to fix in the first place — see raceDow below).
      let raceWeekDaysToProcess = [];
      // Race mode pins to the real calendar date's own day-of-week (the
      // user's actual raceDate — not necessarily one of their regular
      // training days, e.g. training Tue/Thu/Sat but racing Sunday: race
      // day happens regardless). Non-race modes instead pin the Time Trial
      // to the LAST of the runner's own selected training days (same
      // fallback slotDays[slotDays.length-1] already uses for longRunDay)
      // — there's no real external date forcing it onto a specific day the
      // way an actual race does, so pinning it to a day outside the
      // runner's own pattern only ever adds an extra, unwanted session:
      // confirmed live, a 3-day/week plan whose block-end date fell
      // outside those 3 days scheduled 4 sessions that week instead of 3.
      const raceDow = isRaceWeek ? (isNonRace ? slotDays[slotDays.length - 1] : race.getDay()) : null;
      if (isRaceWeek) {
        typeByDow[raceDow] = 'race';
        if (isNonRace) {
          // Unlike a real race, the block's end date isn't an event that
          // empties the rest of the week's training — so, unlike race
          // mode just below, EVERY other preferred day gets a real easy
          // run (not just the ones chronologically before the Time Trial,
          // and not the tiny shakeout formula) — confirmed live, the old
          // shared shakeout-only logic produced a jarring near-total drop
          // (e.g. 38km peak week -> 9km) for the final week, since most
          // preferred days either got a token ~2-3km shakeout or (if they
          // fell chronologically after the pinned day) nothing at all.
          // Sized off weekKm — this week's own already-computed deload
          // target (peakWeeklyKm/currentWeeklyKm × 0.7, see the
          // isTaperWeek branches above) — using the SAME non-long-run slot
          // weights (baseSlotWeights) a normal week distributes across its
          // easy/quality days, just re-normalized across however many
          // "other" days this week actually has (no long run or quality
          // slot this week, so nothing else claims a share).
          const otherDows = slotDays
            .filter(dow => dow !== raceDow)
            .sort((a, b) => chronoRank(a) - chronoRank(b));
          const weightSum = baseSlotWeights.reduce((s, w) => s + w, 0) || 1;
          otherDows.forEach((dow, i) => {
            typeByDow[dow] = 'easy';
            weightByDow[dow] = baseSlotWeights[i % baseSlotWeights.length] / weightSum;
          });
          raceWeekDaysToProcess = [...otherDows, raceDow];
        } else {
          // Remaining shakeout slots: every OTHER preferred day that falls
          // chronologically BEFORE race day (a shakeout scheduled after the
          // race wouldn't make sense) — not capped to daysPerWeek-1 like
          // buildRaceWeekTemplate's own slot count assumes, since that count
          // only holds when raceDow itself was already one of the preferred
          // days; when it's an extra day instead, all the runner's normal
          // training days before it still deserve a shakeout.
          const shakeoutDows = slotDays.filter(dow => dow !== raceDow && chronoRank(dow) < chronoRank(raceDow));
          shakeoutDows.forEach(dow => { typeByDow[dow] = 'shakeout'; });
          raceWeekDaysToProcess = [...shakeoutDows, raceDow];
        }
      } else {
        const longRunDow = slotDays.includes(longRunDay) ? longRunDay : slotDays[slotDays.length - 1];
        const restTemplate = template.filter(t => t !== 'longRun');
        const restWeights = conservativeMode
          ? applyConservativeAdjustment(restTemplate, baseSlotWeights)
          : baseSlotWeights;

        // Quality (tempo/interval/repetition) sessions get first claim on
        // weekday (Mon-Fri) slots wherever there's a choice — long run
        // (and often an easy/recovery day) already anchors the weekend,
        // and a hard effort fits a normal weekday routine better than
        // competing with weekend long-run recovery. Only spills onto a
        // weekend day if there aren't enough weekday slots this week to
        // hold every quality session (e.g. daysPerWeek=5 with just 2
        // weekdays picked). Within whichever pool they're drawn from,
        // pickSpacedQualityDays chooses the widest-spaced combination
        // (e.g. Tuesday+Thursday around a Saturday long run, not
        // Monday+Tuesday back to back) rather than just the first slots
        // in the pool — VO2max/lactate-threshold adaptations need
        // ~48-72h to actually absorb a hard session (see its own comment
        // for sources), which two adjacent hard days don't give. Non-
        // quality slots (easy/recovery) fill whatever's left over, kept
        // in their original template order to preserve which slot carries
        // which weeklySplitForDays weight (see restWeights above).
        const nonLongRunDaysChrono = slotDays.filter(dow => dow !== longRunDow);
        const isWeekendDow = dow => dow === 0 || dow === 6;
        const weekdayDays = nonLongRunDaysChrono.filter(dow => !isWeekendDow(dow));
        const weekendDays = nonLongRunDaysChrono.filter(isWeekendDow);
        const qualityIdx = restTemplate.map((t, i) => i).filter(i => QUALITY_TYPES.has(restTemplate[i]));
        const nonQualityIdx = restTemplate.map((t, i) => i).filter(i => !QUALITY_TYPES.has(restTemplate[i]));

        const usedWeekendForQuality = Math.max(0, qualityIdx.length - weekdayDays.length);
        const qualityCandidatePool = [...weekdayDays, ...weekendDays.slice(0, usedWeekendForQuality)];
        const qualityDays = pickSpacedQualityDays(qualityCandidatePool, qualityIdx.length);
        // Restore chronological (Mon..Sun) order among whatever's left for
        // the non-quality slots, same ordering rule used for sortedPreferredDays.
        // Filtered from nonLongRunDaysChrono (every non-long-run selected
        // day), NOT qualityCandidatePool — a weekend day that was never a
        // quality candidate (e.g. Sunday when Saturday's long run already
        // fills the weekend) would otherwise vanish from this list entirely,
        // leaving nonQualityIdx.forEach below one day short and that real
        // calendar day with no type assigned at all (silently left as
        // `undefined` instead of its 'easy'/'recovery' slot).
        const qualityDaysSet = new Set(qualityDays);
        const leftoverDays = nonLongRunDaysChrono
          .filter(dow => !qualityDaysSet.has(dow))
          .sort((a, b) => chronoRank(a) - chronoRank(b));

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

      // Race week only ever touches the dows it actually gave a typeByDow
      // entry (raceWeekDaysToProcess, built above) — which may both omit
      // some preferred days (any landing after race day chronologically
      // stay 'rest', their existing default) and include one that isn't a
      // preferred day at all (raceDow itself, when it falls outside the
      // runner's usual pattern). Build/taper weeks are unaffected, still
      // just slotDays.
      const daysToProcess = isRaceWeek ? raceWeekDaysToProcess : slotDays;
      daysToProcess.forEach((dow) => {
        const type = typeByDow[dow];
        const dayObj = days.find(x => x.dow === dow);
        if (!dayObj) return;

        if (type === 'race') {
          if (isNonRace) {
            // No real race to run — this slot becomes a genuine Time Trial
            // instead: a fixed, standard 5K (matching RACE_META['5k'].km in
            // js/app.js, so a result plugged back in as "waktu race
            // terakhir" maps directly onto the existing 5K option) run at
            // real max-sustainable effort, not a pace this file prescribes
            // — deliberately no paceSecPerKm set (see js/app.js's Pace
            // Target column, which shows "Time Trial" instead of a zone
            // for this type) — the whole point is discovering current
            // fitness by racing it, not hitting a target. This is what
            // feeds the NEXT block: the runner's own recorded time becomes
            // that plan's recentRaceTimeSec/recentRaceDistanceKm input
            // (see the warnings.push below).
            //
            // conservativeMode (injury/pain flagged) keeps the old lighter,
            // non-maximal self-test instead — a real time trial's whole
            // premise (max sustainable effort) isn't appropriate there.
            dayObj.type = 'evaluation';
            if (conservativeMode) {
              dayObj.km = Math.max(2, Math.round(clamp(peakWeeklyKm * 0.15, 3, 10) * 2) / 2);
              dayObj.paceSecPerKm = weekPaces.tempo;
            } else {
              dayObj.km = 5;
            }
            if (dayObj.km > 0) dayObj.structure = buildSimpleStructure(dayObj.km);
            return;
          }
          dayObj.type = 'race';
          dayObj.km = raceDistanceKm;
          dayObj.paceSecPerKm = goalPaceSec;
          return;
        }
        if (type === 'longRun') {
          const isMSL = usesRaceSpecificLongRun && phase === 'Peak';
          dayObj.type = 'longRun';
          dayObj.km = Math.round(longRunKmThisWeek * 2) / 2;
          dayObj.paceSecPerKm = isMSL ? weekPaces.goal : weekPaces.longRun;
          dayObj.isMarathonSpecific = isMSL;
          if (dayObj.km > 0) {
            if (isMSL) {
              // Race-pace share ramps from MSL_PACE_FRACTION_START (this
              // block's 1st Peak week) to _END (its last, right before
              // taper) — see buildRaceSpecificLongRunStructure above.
              const peakWeekIndex = clamp(w - peakStartWeek, 0, peakWeeksTotal - 1);
              const paceFraction = MSL_PACE_FRACTION_START
                + (MSL_PACE_FRACTION_END - MSL_PACE_FRACTION_START) * (peakWeekIndex / Math.max(peakWeeksTotal - 1, 1));
              dayObj.structure = buildRaceSpecificLongRunStructure(dayObj.km, paceFraction, raceSpecificPaceLabel);
            } else {
              dayObj.structure = buildSimpleStructure(dayObj.km);
            }
          }
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
        // or past maxSupportKm. Two safety nets on top of that
        // anyway, for edge cases (e.g. a currentWeeklyKm input that's
        // already high relative to daysPerWeek), neither of which
        // redistributes the trimmed volume elsewhere (a lower actual weekKm
        // total is safer than forcing it into one oversized day):
        //   1. The ramp guardrail above can hold longRunKmThisWeek below its
        //      progress-based target without shrinking the other slots to
        //      match — so clamp against the *actual* long run distance this
        //      week too.
        //   2. Clamp at maxSupportKm regardless, as a final absolute
        //      backstop — tighter still for repetition specifically (see
        //      MAX_REPETITION_SESSION_KM), though maxSupportKm itself can
        //      now come in under that flat number on a short race/low-days
        //      combo (see its own scaling above), so take whichever of the
        //      two is actually smaller rather than assuming
        //      MAX_REPETITION_SESSION_KM always is.
        const sessionCap = type === 'repetition' ? Math.min(MAX_REPETITION_SESSION_KM, maxSupportKm) : maxSupportKm;
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
        // type in one week, see QUALITY_ROTATIONS' comment above).
        if (type === 'interval' && dayObj.km > 0) {
          const variant = (qualityPrimary.type === 'interval' ? qualityPrimary : qualitySecondary).variant;
          dayObj.recoveryPaceSecPerKm = weekPaces.recovery;
          // dayObj.paceSecPerKm (set just above) is this week's actual
          // I-pace — buildIntervalStructure may downgrade `variant` if that
          // pace would push it past INTERVAL_MAX_WORK_SEC, so workoutVariant
          // is set from its resolvedVariant, not the requested one.
          const built = buildIntervalStructure(dayObj.km, fitnessLevel, conservativeMode, variant, dayObj.paceSecPerKm, weekPaces.recovery);
          dayObj.workoutVariant = built.resolvedVariant;
          dayObj.structure = built.structure;
        } else if (type === 'tempo' && dayObj.km > 0) {
          const variant = (qualityPrimary.type === 'tempo' ? qualityPrimary : qualitySecondary).variant;
          dayObj.workoutVariant = variant;
          dayObj.recoveryPaceSecPerKm = weekPaces.recovery;
          dayObj.structure = buildTempoStructure(dayObj.km, variant, weekPaces.recovery);
        } else if (type === 'repetition' && dayObj.km > 0) {
          const variant = (qualityPrimary.type === 'repetition' ? qualityPrimary : qualitySecondary).variant;
          dayObj.recoveryPaceSecPerKm = weekPaces.recovery;
          const built = buildRepetitionStructure(dayObj.km, variant, dayObj.paceSecPerKm, weekPaces.recovery);
          dayObj.workoutVariant = built.resolvedVariant;
          dayObj.structure = built.structure;
        } else if (type === 'fartlek' && dayObj.km > 0) {
          // Recovery is genuine easy pace here (weekPaces.easy), NOT
          // weekPaces.recovery like every other reps-based workout above —
          // see buildFartlekStructure's own comment for why that's
          // deliberate, not an oversight.
          dayObj.recoveryPaceSecPerKm = weekPaces.easy;
          dayObj.structure = buildFartlekStructure(dayObj.km, dayObj.paceSecPerKm, weekPaces.easy);
        } else if (dayObj.km > 0) {
          dayObj.structure = buildSimpleStructure(dayObj.km);
        }
      });

      const totalKm = Math.round(days.reduce((s, d) => s + (d.km || 0), 0) * 10) / 10;
      // Taper/race weeks are intentionally lower-volume by design, so they
      // shouldn't count toward "peak" — only build-phase weeks (Base/Build/
      // Peak/Cutback) do. Tracks what the schedule actually delivers, which
      // can still come in a bit under the peakWeeklyKm target on the rare
      // week where a guardrail (ramp limit, maxSupportKm) trims
      // something — peakWeeklyKm itself is already the realistic figure
      // (see its definition above), not the unbounded theoretical one.
      if (!isTaperWeek) actualPeakWeeklyKm = Math.max(actualPeakWeeklyKm, totalKm);

      weeks.push({
        weekNumber: w + 1,
        // Week 1's days array may be trimmed to start after weekStart (see
        // above) — report its actual first/last rendered day rather than
        // the raw Monday-Sunday bounds, so the header date range shown
        // alongside the days table always matches what's actually in it.
        startDate: days[0].date,
        endDate: days[days.length - 1].date,
        phase,
        totalKm,
        // This week's own interpolated goal pace (see weekPaces.goal above)
        // — exposed per-week for MSL/predicted-time-adjacent display uses.
        weekGoalPaceSec: weekPaces.goal,
        // This week's own VDOT (see weekVdotScore above, ramped directly
        // in VDOT-space) — exposed so js/app.js can show a "VDOT X.X"
        // figure that climbs week to week alongside the schedule, instead
        // of only a single static snapshot. NOT re-derived from
        // weekGoalPaceSec above — see currentVdot's own comment for why
        // that would drift from this.
        weekVdot: weekVdotScore,
        days,
      });
    }

    if (rampLimited) {
      const approachingNoun = isNonRace ? 'akhir blok' : 'race day';
      warnings.push(`Long run puncak di jadwal ini (~${Math.round(actualPeakLongRunKm * 10) / 10} km) sengaja ditahan di bawah target ${Math.round(peakLongRunKm)} km, karena lari terjauhmu saat ini baru ${longestRecentRunKm} km — kenaikan jarak long run dinaikkan bertahap per minggu (maks ~${Math.round(MAX_LONG_RUN_JUMP_RATIO * 100)}%) supaya aman dari cedera. Kalau waktu persiapanmu masih cukup panjang, ini normal dan long run akan terus naik mendekati ${approachingNoun}.`);
    }
    if (supportSessionCapped) {
      warnings.push(`Beberapa sesi easy run/tempo/interval/repetition di jadwal ini dibatasi maksimal ${Math.round(maxSupportKm * 10) / 10} km (repetition: ${MAX_REPETITION_SESSION_KM} km) — dengan volume mingguanmu yang cukup tinggi, porsi proporsionalnya bisa lebih jauh dari itu, tapi sesi selain long run sebaiknya tidak sejauh itu. Total mingguan jadi sedikit lebih rendah dari target sebagai konsekuensinya — lebih aman begitu daripada memaksakan sesi harian yang kepanjangan.`);
    }
    if (Math.abs(currentFitnessPaceSec - goalPaceSec) >= 3) {
      warnings.push(`Pace target di sesi tempo/interval/long run dimulai lebih santai (${formatPace(currentFitnessPaceSec)}, sesuai kemampuanmu saat ini) lalu naik bertahap tiap minggu menuju goal pace ${formatPace(goalPaceSec)} di puncak training block — bukan langsung dipatok di goal pace dari minggu 1.`);
    }

    return {
      meta: {
        raceLabel, raceDistanceKm, raceDate: race,
        mode: mode || 'race', nonRaceStyle: isNonRace ? nonRaceStyle : null,
        planWeeks, taperWeeks, buildWeeks,
        peakWeeklyKm: Math.round(actualPeakWeeklyKm * 10) / 10,
        peakLongRunKm: Math.round(actualPeakLongRunKm * 10) / 10,
        goalPaceSec, paces,
        // Week-1 (current-fitness) pace, alongside goalPaceSec (peak/race
        // pace) above — the same two endpoints weekPaces interpolates
        // between across the build block (see paceProgress). Exposed here
        // so js/app.js's Zona Pace (VDOT) table can show the same
        // start -> peak progression the daily "Pace Target" already
        // reflects, instead of a single static VDOT snapshot.
        currentFitnessPaceSec,
        goalPaceSource,
        recentRaceTimeSec: recentRaceTimeSec || null,
        recentRaceDistanceKm: recentRaceDistanceKm || null,
        predictedRaceTimeSec,
        planStart: firstWeekStart,
        weeksAvailable,
        // Exposed so js/app.js's applyAiAdjustments can clamp an AI-
        // suggested distance tweak to the same ceiling this file itself
        // enforces (see maxSupportKm above) without needing to re-derive it.
        maxSupportKm,
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
    // this file itself enforces, without duplicating either. The support-
    // session ceiling itself is per-race-profile now (see
    // RACE_PROFILES[key].maxSupportKm above) rather than one flat export —
    // js/app.js reads it off plan.meta.maxSupportKm instead.
    buildSimpleStructure, buildIntervalStructure, buildTempoStructure, buildRepetitionStructure,
    buildFartlekStructure,
    MAX_REPETITION_SESSION_KM,
    // Exported so js/app.js's form validation can block Base Building
    // submission past this same threshold (see gatherSettingsFromForm)
    // instead of hardcoding a second, potentially-drifting 60.
    VOLUME_GAIN_PLATEAU_KM,
  };
})();
