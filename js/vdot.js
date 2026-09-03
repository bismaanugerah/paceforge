/**
 * PaceForge — VDOT training pace zones (js/vdot.js)
 * Pure, rule-based logic (no AI / no network calls) — same style as
 * planGenerator.js, kept in its own file since it's a distinct concern
 * (exercise-physiology pace zones) from schedule generation.
 *
 * Implements Jack Daniels & Jimmy Gilbert's published VDOT formulas (the
 * same methodology popularized by calculators like vdoto2.com — their exact
 * internals are proprietary/undisclosed, but the underlying physiology
 * formulas below are the public, widely-cited ones from "Daniels' Running
 * Formula" / the original 1979 Daniels-Gilbert paper, reproduced across many
 * independent running-coach references):
 *
 *   VO2 (ml/kg/min)   = -4.60 + 0.182258*v + 0.000104*v^2   (v = m/min)
 *   %VO2max(t)        = 0.8 + 0.1894393*e^(-0.012778*t) + 0.2989558*e^(-0.1932605*t)
 *                        (t = race duration in minutes)
 *   VDOT              = VO2 / %VO2max(t)
 *
 * A race performance (distance + time) plugged into both equations yields a
 * VDOT "fitness score". Reversing the first equation (solve VO2 -> velocity)
 * at various %VO2max targets then yields training paces for each of
 * Daniels' 5 named intensity zones.
 */

const PaceForgeVDOT = (() => {

  // %VO2max target range per training zone. Confirmed against vdoto2.com's
  // own published ranges for Easy/Marathon/Threshold/Interval; Repetition's
  // exact range isn't published by any calculator (Daniels describes it
  // qualitatively as "current 1500m/mile race effort" instead) — 105-120%
  // is the range commonly cited in independent summaries of Daniels'
  // Running Formula for R pace, used here as the closest public reference.
  const ZONE_PCT_RANGES = {
    easy: [0.59, 0.74],
    marathon: [0.75, 0.84],
    threshold: [0.83, 0.88],
    interval: [0.97, 1.00],
    repetition: [1.05, 1.20],
  };

  const ZONE_ORDER = ['easy', 'marathon', 'threshold', 'interval', 'repetition'];

  const ZONE_LABELS = {
    easy: 'Easy',
    marathon: 'Marathon',
    threshold: 'Threshold',
    interval: 'Interval',
    repetition: 'Repetition',
  };

  function vo2FromVelocity(v) { // v in meters/minute
    return -4.60 + 0.182258 * v + 0.000104 * v * v;
  }

  function pctVO2MaxForDuration(t) { // t in minutes
    return 0.8 + 0.1894393 * Math.exp(-0.012778 * t) + 0.2989558 * Math.exp(-0.1932605 * t);
  }

  // Invert vo2FromVelocity: given a target VO2, solve the quadratic for v.
  function velocityFromVO2(vo2) { // -> meters/minute
    const a = 0.000104, b = 0.182258, c = -(4.60 + vo2);
    return (-b + Math.sqrt(b * b - 4 * a * c)) / (2 * a);
  }

  function paceSecPerKmFromVO2(vo2) {
    const v = velocityFromVO2(vo2); // m/min
    return 60000 / v; // 1000m / (v m/min) -> min/km, *60 -> sec/km
  }

  /** VDOT score from an actual (or hypothetical) race performance. */
  function vdotFromPerformance(distanceKm, timeSec) {
    if (!(distanceKm > 0) || !(timeSec > 0)) return null;
    const v = (distanceKm * 1000) / (timeSec / 60); // m/min
    const t = timeSec / 60; // minutes
    const vo2 = vo2FromVelocity(v);
    const pctMax = pctVO2MaxForDuration(t);
    return vo2 / pctMax;
  }

  /** Fallback used when there's no recent-race input: treat the generator's
   * own goal pace at the target race distance as a hypothetical "race
   * performance" and back out an equivalent VDOT from it. Less precise than
   * a real race result (goal pace may itself be a generic fitness-level
   * default), but keeps the pace-zone table available either way. */
  function vdotFromGoalPace(raceDistanceKm, goalPaceSecPerKm) {
    if (!(raceDistanceKm > 0) || !(goalPaceSecPerKm > 0)) return null;
    return vdotFromPerformance(raceDistanceKm, goalPaceSecPerKm * raceDistanceKm);
  }

  /** All 5 training-pace zones for a given VDOT, each as a {fastSec, slowSec}
   * sec/km range (fastSec = high end of the zone's %VO2max range, slowSec =
   * low end) — matching how VDOT calculators present zones as a range
   * rather than a single number. */
  function paceZonesFromVDOT(vdot) {
    if (!(vdot > 0)) return null;
    const zones = {};
    ZONE_ORDER.forEach(key => {
      const [lo, hi] = ZONE_PCT_RANGES[key];
      zones[key] = {
        fastSec: paceSecPerKmFromVO2(vdot * hi),
        slowSec: paceSecPerKmFromVO2(vdot * lo),
      };
    });
    return zones;
  }

  function formatPaceRange(fastSec, slowSec) {
    const fmt = sec => {
      const r = Math.max(0, Math.round(sec));
      const m = Math.floor(r / 60);
      const s = r % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    };
    return `${fmt(fastSec)}–${fmt(slowSec)} /km`;
  }

  return {
    vdotFromPerformance, vdotFromGoalPace, paceZonesFromVDOT, formatPaceRange,
    ZONE_ORDER, ZONE_LABELS, ZONE_PCT_RANGES,
  };
})();
