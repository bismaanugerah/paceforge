/**
 * PaceForge — server/planEngine.js
 *
 * Runs the browser's own plan engine (js/vdot.js, js/planGenerator.js,
 * js/planText.js, js/planEdits.js, js/ics.js) inside Node, so
 * api/calendar.js can rebuild a saved plan server-side and serve it as a
 * calendar feed.
 *
 * WHY NOT `require()` THOSE FILES: they're plain browser scripts that each
 * declare one top-level `const PaceForgeX = (() => {...})()` and reference
 * each other by that global name — exactly how index.html loads them. A
 * Node `require` would need every one of them to grow a module.exports
 * footer AND some way to see its siblings, which would mean editing five
 * working browser files to suit one server endpoint. Loading them into a
 * single `vm` context instead reproduces the browser's shared-global
 * arrangement exactly, and leaves those files untouched.
 *
 * The one wrinkle: a top-level `const` goes into a context's global
 * LEXICAL scope, not onto its global OBJECT — so `ctx.PaceForgeGenerator`
 * is undefined even after the script runs. Evaluating an expression in
 * that same context can see those bindings, which is what the final
 * runInContext below is for.
 *
 * DEPLOYMENT NOTE: the js/ files are read at RUNTIME, so Vercel's static
 * analysis can't see that api/calendar.js depends on them and won't bundle
 * them on its own — vercel.json's `functions["api/calendar.js"]
 * .includeFiles` is what puts them in the deployed function. Without it
 * this fails with ENOENT in production while working perfectly in
 * `vercel dev`.
 *
 * NOT loaded by the browser — only required from files under api/.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Order matters the same way the <script> tags in index.html do: each
// file's IIFE runs at load time, and planGenerator/planText/ics reference
// their siblings by global name when CALLED (not at load), so only the
// full set being present before the first call actually matters.
const ENGINE_FILES = ['vdot.js', 'planGenerator.js', 'planText.js', 'planEdits.js', 'ics.js'];

// Built once per warm serverless instance — parsing ~6k lines of JS on
// every request would otherwise dominate the response time of what is
// really just a string-building endpoint.
let engine = null;

function loadEngine() {
  if (engine) return engine;
  // `console` is passed through so a stray warn/error inside the engine
  // lands in the function logs instead of throwing ReferenceError. The
  // context otherwise gets its own fresh set of standard globals (Date,
  // Math, Intl, ...), which is all these files use.
  const context = vm.createContext({ console });
  const jsDir = path.join(__dirname, '..', 'js');
  ENGINE_FILES.forEach(file => {
    const src = fs.readFileSync(path.join(jsDir, file), 'utf8');
    vm.runInContext(src, context, { filename: `js/${file}` });
  });
  engine = vm.runInContext(
    '({ PaceForgeVDOT, PaceForgeGenerator, PaceForgePlanText, PaceForgePlanEdits, PaceForgeIcs })',
    context,
  );
  return engine;
}

// 'YYYY-MM-DD' -> a Date at LOCAL midnight, parsed identically to
// js/app.js's loadSavedPlanForUser (`new Date(str + 'T00:00:00')`). Both
// this and js/ics.js's dateStamp read local calendar fields, so the day a
// session lands on is the same one the runner sees in the browser no
// matter what timezone this function happens to run in — appending 'Z'
// (or using Date.parse's bare-date UTC path) instead would shift the
// whole plan a day for any negative-offset server.
function parseStoredDate(value, fallback) {
  if (!value) return fallback;
  const d = new Date(`${value}T00:00:00`);
  return Number.isNaN(d.getTime()) ? fallback : d;
}

/**
 * Rebuilds the plan a runner would see in the browser from the `settings`
 * blob saved by js/app.js's savePlanForCurrentUser — including replaying
 * the two kinds of hand edit that aren't reproducible from settings alone
 * (see js/planEdits.js). Returns the same plan object
 * PaceForgeGenerator.generatePlan() returns.
 */
function buildPlanFromSettings(settings) {
  const { PaceForgeGenerator, PaceForgePlanEdits } = loadEngine();
  const today = new Date();
  const resolved = {
    ...settings,
    raceDate: parseStoredDate(settings.raceDate, today),
    startDate: parseStoredDate(settings.startDate, today),
  };

  const plan = PaceForgeGenerator.generatePlan(resolved);
  PaceForgePlanEdits.applyDaySwaps(plan, settings.daySwaps);
  PaceForgePlanEdits.applyFeedbackOverrides(plan, settings.feedbackOverrides, {
    fitnessLevel: settings.fitnessLevel,
    conservativeMode: !!settings.conservativeMode,
  });
  return plan;
}

function buildIcs(plan, options) {
  return loadEngine().PaceForgeIcs.buildIcs(plan, options);
}

module.exports = { buildPlanFromSettings, buildIcs, loadEngine };
