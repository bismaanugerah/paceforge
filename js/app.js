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
  const hasTargetTime = document.getElementById('hasTargetTime');
  const targetTimeFields = document.getElementById('targetTimeFields');
  const userNotesInput = document.getElementById('userNotes');
  const formError = document.getElementById('formError');

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
  });

  daysPerWeekInput.addEventListener('input', () => {
    daysPerWeekOutput.textContent = `${daysPerWeekInput.value} hari`;
    updateDayCountHint();
  });

  dayCheckboxes.addEventListener('change', updateDayCountHint);

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

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    clearError();

    // --- Gather & validate ---
    const isCustomDistance = getDistanceMode() === 'custom';
    let raceKey = raceDistanceSel.value;
    let raceDistanceKm = RACE_META[raceKey]?.km;
    let raceLabel = RACE_META[raceKey]?.label;
    if (isCustomDistance) {
      raceKey = 'custom';
      raceDistanceKm = Number(customDistanceKm.value);
      raceLabel = `${raceDistanceKm} km`;
      if (!raceDistanceKm || raceDistanceKm <= 0) {
        return showError('Masukkan jarak custom yang valid (dalam km).');
      }
    }

    if (!raceDateInput.value) return showError('Pilih tanggal race terlebih dahulu.');
    const raceDate = new Date(raceDateInput.value + 'T00:00:00');
    const today = new Date(); today.setHours(0, 0, 0, 0);
    if (raceDate <= today) return showError('Tanggal race harus di masa depan.');

    const fitnessLevel = document.getElementById('fitnessLevel').value;
    const currentWeeklyKm = Number(document.getElementById('currentWeeklyKm').value);
    if (currentWeeklyKm < 0 || Number.isNaN(currentWeeklyKm)) {
      return showError('Isi rata-rata jarak lari mingguan yang valid (boleh 0 jika baru mulai).');
    }

    const longestRecentRunKm = Number(document.getElementById('longestRecentRunKm').value);
    if (longestRecentRunKm < 0 || Number.isNaN(longestRecentRunKm)) {
      return showError('Isi jarak lari terjauhmu dalam 3 bulan terakhir yang valid (boleh 0 jika baru mulai).');
    }

    const daysPerWeek = Number(daysPerWeekInput.value);
    const preferredDays = getSelectedDays();
    if (preferredDays.length !== daysPerWeek) {
      return showError(`Jumlah hari yang dipilih (${preferredDays.length}) harus sama dengan jumlah hari latihan per minggu (${daysPerWeek}).`);
    }

    let targetTimeSec = null;
    if (hasTargetTime.checked) {
      const h = Number(document.getElementById('targetHours').value) || 0;
      const m = Number(document.getElementById('targetMinutes').value) || 0;
      const s = Number(document.getElementById('targetSeconds').value) || 0;
      targetTimeSec = h * 3600 + m * 60 + s;
      if (targetTimeSec <= 0) return showError('Isi target waktu finish yang valid.');
    }

    const settings = {
      raceDistanceKm, raceLabel, raceKey, raceDate,
      fitnessLevel, currentWeeklyKm, longestRecentRunKm, daysPerWeek, preferredDays,
      targetTimeSec,
    };

    const plan = PaceForgeGenerator.generatePlan(settings);
    renderPlan(plan);
    enhanceWithAI();
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
    const { formatPace, formatDate, TYPE_LABELS } = PaceForgeGenerator;

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
