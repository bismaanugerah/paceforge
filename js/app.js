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
    shakeout: 'var(--type-easy)',
    rest: 'var(--type-rest)',
    race: 'var(--type-race)',
  };

  const form = document.getElementById('planForm');
  const distanceModeToggle = document.getElementById('distanceModeToggle');
  const presetDistanceField = document.getElementById('presetDistanceField');
  const raceDistanceSel = document.getElementById('raceDistance');
  const customDistanceField = document.getElementById('customDistanceField');
  const customDistanceKm = document.getElementById('customDistanceKm');
  const raceDateInput = document.getElementById('raceDate');
  const raceDateHint = document.getElementById('raceDateHint');
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
  const targetTimeFields = document.getElementById('targetTimeFields');
  const conservativeModeInput = document.getElementById('conservativeMode');
  const userNotesInput = document.getElementById('userNotes');
  const formError = document.getElementById('formError');

  const DAY_LABELS = { 0: 'Minggu', 1: 'Senin', 2: 'Selasa', 3: 'Rabu', 4: 'Kamis', 5: "Jum'at", 6: 'Sabtu' };

  const gateSection = document.getElementById('gateSection');
  const formSection = document.getElementById('formSection');
  const resultSection = document.getElementById('resultSection');
  const resultWarning = document.getElementById('resultWarning');
  const summaryCards = document.getElementById('summaryCards');
  const paceLegend = document.getElementById('paceLegend');
  const planWeeksEl = document.getElementById('planWeeks');
  const aiStatus = document.getElementById('aiStatus');
  const aiRetryBtn = document.getElementById('aiRetryBtn');
  const aiIntro = document.getElementById('aiIntro');
  const aiRaceDayTips = document.getElementById('aiRaceDayTips');

  // Kept around so the AI enhancement step can send a compact summary of the
  // currently-rendered plan (and retry on demand) without recomputing anything.
  let lastPlan = null;

  // Set a sensible default race date: 12 weeks from today.
  const defaultRaceDate = new Date();
  defaultRaceDate.setDate(defaultRaceDate.getDate() + 12 * 7);
  raceDateInput.value = defaultRaceDate.toISOString().slice(0, 10);
  raceDateInput.min = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);

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
    updateEstimate5kHint();
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

  hasTargetTime.addEventListener('change', () => {
    targetTimeFields.hidden = !hasTargetTime.checked;
  });

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

    const fitnessLevel = document.getElementById('fitnessLevel').value;
    const currentWeeklyKm = Number(document.getElementById('currentWeeklyKm').value);
    if (currentWeeklyKm < 0 || Number.isNaN(currentWeeklyKm)) {
      showError('Isi rata-rata jarak lari mingguan yang valid (boleh 0 jika baru mulai).');
      return null;
    }

    const longestRecentRunKm = Number(document.getElementById('longestRecentRunKm').value);
    if (longestRecentRunKm < 0 || Number.isNaN(longestRecentRunKm)) {
      showError('Isi jarak lari terjauhmu dalam 3 bulan terakhir yang valid (boleh 0 jika baru mulai).');
      return null;
    }

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

    let targetTimeSec = null;
    if (hasTargetTime.checked) {
      const h = Number(document.getElementById('targetHours').value) || 0;
      const m = Number(document.getElementById('targetMinutes').value) || 0;
      const s = Number(document.getElementById('targetSeconds').value) || 0;
      targetTimeSec = h * 3600 + m * 60 + s;
      if (targetTimeSec <= 0) { showError('Isi target waktu finish yang valid.'); return null; }
    }

    const conservativeMode = conservativeModeInput.checked;

    return {
      raceDistanceKm, raceLabel, raceKey, raceDate,
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

    document.getElementById('fitnessLevel').value = settings.fitnessLevel;
    document.getElementById('currentWeeklyKm').value = settings.currentWeeklyKm;
    document.getElementById('longestRecentRunKm').value = settings.longestRecentRunKm;
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
    targetTimeFields.hidden = !hasTargetTime.checked;
    if (hasTargetTime.checked) {
      document.getElementById('targetHours').value = Math.floor(settings.targetTimeSec / 3600);
      document.getElementById('targetMinutes').value = Math.floor((settings.targetTimeSec % 3600) / 60);
      document.getElementById('targetSeconds').value = settings.targetTimeSec % 60;
    }

    userNotesInput.value = userNotes || '';
  }

  function generateAndShowPlan(settings) {
    const plan = PaceForgeGenerator.generatePlan(settings);
    renderPlan(plan);
    enhanceWithAI();
    return plan;
  }

  // --- Login gate ---
  function showGate() {
    gateSection.hidden = false;
    formSection.hidden = true;
    resultSection.hidden = true;
  }
  function showForm() {
    gateSection.hidden = true;
    formSection.hidden = false;
    resultSection.hidden = true;
  }

  // --- Cloud sync (Supabase), or a localStorage stand-in while auth.js is
  // still in dummy mode (see js/auth.js) — same save/load shape either way,
  // so nothing here needs to change once a real Supabase project is wired up.
  const paceforgeAuth = window.PaceForgeAuth;
  const DUMMY_PLAN_KEY = 'paceforge_dummy_plan';

  async function savePlanForCurrentUser(settings) {
    const payload = {
      settings: { ...settings, raceDate: settings.raceDate.toISOString().slice(0, 10) },
      user_notes: userNotesInput.value.trim(),
    };

    const client = paceforgeAuth && paceforgeAuth.getClient();
    if (!client) {
      if (paceforgeAuth && paceforgeAuth.isDummy()) {
        localStorage.setItem(DUMMY_PLAN_KEY, JSON.stringify(payload));
        paceforgeAuth.setSyncStatus('✓ Plan tersimpan (mode dummy — lokal di browser ini saja).');
      }
      return;
    }

    const { data: { user } = {} } = await client.auth.getUser();
    if (!user) return;

    paceforgeAuth.setSyncStatus('Menyimpan plan ke akunmu...');
    const { error } = await client.from('plans').upsert({
      user_id: user.id,
      ...payload,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    if (error) {
      paceforgeAuth.setSyncStatus(`Gagal menyimpan plan ke akun: ${error.message}`, true);
    } else {
      paceforgeAuth.setSyncStatus('✓ Plan tersimpan ke akunmu.');
    }
  }

  async function loadSavedPlanForUser(user) {
    if (!user) return;
    const client = paceforgeAuth && paceforgeAuth.getClient();

    if (!client) {
      if (paceforgeAuth && paceforgeAuth.isDummy()) {
        const raw = localStorage.getItem(DUMMY_PLAN_KEY);
        if (!raw) return;
        const data = JSON.parse(raw);
        const settings = { ...data.settings, raceDate: new Date(data.settings.raceDate + 'T00:00:00') };
        applySettingsToForm(settings, data.user_notes || '');
        generateAndShowPlan(settings);
        paceforgeAuth.setSyncStatus('✓ Plan terakhir dimuat (mode dummy — lokal).');
      }
      return;
    }

    paceforgeAuth.setSyncStatus('Memuat plan tersimpan...');
    const { data, error } = await client
      .from('plans')
      .select('settings, user_notes')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      paceforgeAuth.setSyncStatus(`Gagal memuat plan tersimpan: ${error.message}`, true);
      return;
    }
    if (!data) {
      // Belum pernah menyimpan plan dari akun ini — bukan error, cuma
      // belum ada apa-apa yang perlu direstore.
      paceforgeAuth.setSyncStatus('');
      return;
    }

    const settings = { ...data.settings, raceDate: new Date(data.settings.raceDate + 'T00:00:00') };
    applySettingsToForm(settings, data.user_notes || '');
    generateAndShowPlan(settings);
    paceforgeAuth.setSyncStatus('✓ Plan terakhir dimuat dari akunmu.');
  }

  if (paceforgeAuth) {
    paceforgeAuth.onAuthChange((user) => {
      if (user) {
        showForm();
        loadSavedPlanForUser(user);
      } else {
        showGate();
      }
    });
  } else {
    // PaceForgeAuth failed to initialize entirely (script error) — fail
    // safe by keeping the gate up rather than silently exposing the form.
    showGate();
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearError();

    const settings = gatherSettingsFromForm();
    if (!settings) return;

    generateAndShowPlan(settings);
    savePlanForCurrentUser(settings);
  });

  document.getElementById('printBtn').addEventListener('click', () => window.print());
  aiRetryBtn.addEventListener('click', enhanceWithAI);
  document.getElementById('newPlanBtn').addEventListener('click', () => {
    resultSection.hidden = true;
    formSection.hidden = false;
    formSection.scrollIntoView({ behavior: 'smooth' });
  });

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

    // Pace legend
    const legendZones = [
      ['recovery', meta.paces.recovery],
      ['easy', meta.paces.easy],
      ['longRun', meta.paces.longRun],
      ['tempo', meta.paces.tempo],
      ['interval', meta.paces.interval],
    ];
    paceLegend.innerHTML = legendZones.map(([type, sec]) => `
      <div class="legend-item">
        <span class="legend-dot" style="background:${TYPE_COLORS[type]}"></span>
        ${TYPE_LABELS[type]}: <strong>${formatPace(sec)}</strong>
      </div>
    `).join('');

    // Weeks
    planWeeksEl.innerHTML = weeks.map(week => `
      <div class="week-block" data-week-number="${week.weekNumber}">
        <div class="week-header">
          <span class="week-title">Minggu ${week.weekNumber}</span>
          <span class="week-phase">${week.phase} • ${formatDate(week.startDate)} – ${formatDate(week.endDate)}</span>
          <span class="week-total">Total: ${week.totalKm} km</span>
        </div>
        <table class="day-table">
          <thead>
            <tr><th>Hari</th><th>Tanggal</th><th>Sesi</th><th>Jarak</th><th>Pace Target</th></tr>
          </thead>
          <tbody>
            ${week.days.map(renderDayRow).join('')}
          </tbody>
        </table>
      </div>
    `).join('');

    resultSection.hidden = false;
    formSection.hidden = true;
    resultSection.scrollIntoView({ behavior: 'smooth' });
  }

  // Runs automatically right after every plan is generated. Sends a compact
  // summary of the already-computed plan (phase + total km per week — never
  // the day-by-day numbers) plus the user's free-text notes to the server,
  // which asks Claude for qualitative coaching notes only. The rule-based
  // distances/paces already rendered above are never touched.
  async function enhanceWithAI() {
    if (!lastPlan) return;
    const { meta, weeks } = lastPlan;
    const { formatPace } = PaceForgeGenerator;

    aiRetryBtn.hidden = true;
    aiStatus.hidden = false;
    aiStatus.classList.remove('is-error');
    aiStatus.textContent = '✨ Meminta catatan pelatih dari Claude...';

    const payload = {
      raceLabel: meta.raceLabel,
      raceDate: meta.raceDate.toISOString().slice(0, 10),
      fitnessLevel: document.getElementById('fitnessLevel').value,
      planWeeks: meta.planWeeks,
      peakWeeklyKm: meta.peakWeeklyKm,
      peakLongRunKm: meta.peakLongRunKm,
      goalPace: formatPace(meta.goalPaceSec),
      conservativeMode: conservativeModeInput.checked,
      userNotes: userNotesInput.value.trim(),
      weeks: weeks.map(w => ({ week: w.weekNumber, phase: w.phase, totalKm: w.totalKm })),
    };

    try {
      const res = await fetch('/api/enhance-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server merespons status ${res.status}`);

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

      aiStatus.textContent = '✨ Catatan AI berhasil ditambahkan ke plan di atas.';
    } catch (err) {
      aiStatus.classList.add('is-error');
      aiStatus.textContent = `Gagal minta saran AI: ${err.message}. Plan dasar di atas tetap berlaku.`;
      aiRetryBtn.hidden = false;
    }
  }

  function renderDayRow(day) {
    const { formatPace, formatDate, TYPE_LABELS } = PaceForgeGenerator;
    const isRest = day.type === 'rest';
    const isRace = day.type === 'race';
    const rowClass = isRest ? 'is-rest' : (isRace ? 'is-race' : '');
    const label = TYPE_LABELS[day.type] || day.type;
    const km = day.km ? `${day.km} km` : '—';
    const pace = (!isRest && day.paceSecPerKm) ? formatPace(day.paceSecPerKm) : '—';
    const color = TYPE_COLORS[day.type] || 'var(--type-rest)';
    return `
      <tr class="${rowClass}">
        <td>${day.dayName}</td>
        <td>${day.date.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' })}</td>
        <td><span class="type-badge" style="background:${color}">${label}</span></td>
        <td>${km}</td>
        <td>${pace}</td>
      </tr>
    `;
  }
})();
