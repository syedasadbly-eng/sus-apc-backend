/* ============================================
   WELFARE DEVELOPMENT INTERFACE — front end
   Smart Urban Sensing

   Self-contained. Adds nothing to app.js and touches no existing element.
   If /api/welfare/status is unavailable the whole menu stays hidden, so a
   production build with FEATURE_WELFARE unset shows the dashboard exactly
   as it is today.
   ============================================ */

(function () {
  'use strict';

  const WELFARE_VIEWS = [
    'welfare-console', 'welfare-signals', 'welfare-health', 'welfare-log', 'welfare-rules',
  ];

  const SEV = {
    1: { name: 'Log', cls: 'sev-log' },
    2: { name: 'Notify', cls: 'sev-notify' },
    3: { name: 'Alert', cls: 'sev-alert' },
    4: { name: 'Escalate', cls: 'sev-escalate' },
  };

  const EVENT_LABELS = {
    lone_traveller: 'Lone traveller',
    lone_traveller_late_night: 'Lone traveller (night)',
    end_of_service_occupancy: 'Passenger at depot',
    terminus_occupancy: 'Passenger at terminus',
    stationary_with_occupants: 'Stationary with occupants',
    sensor_stale: 'Feed stale',
    sensor_offline: 'Feed offline',
    sensor_recovered: 'Feed recovered',
    sensor_fault: 'Counter fault',
    sensor_suspect: 'Counter suspect',
    data_quality_drift: 'Data quality drift',
    fall: 'Fall detected',
    violence: 'Violence detected',
    dwell_exceeded: 'Dwell exceeded',
  };

  let enabled = false;
  let pollTimer = null;
  let volumeChart = null;
  let lastStatus = null;

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  async function api(path, opts) {
    const res = await fetch(`/api/welfare${path}`, opts);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return res.json();
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function label(type) {
    return EVENT_LABELS[type] || String(type).replace(/_/g, ' ');
  }

  function timeAgo(iso) {
    if (!iso) return '—';
    const sec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
    if (sec < 60) return `${sec}s ago`;
    if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
    return `${Math.round(sec / 86400)}d ago`;
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString('en-GB', {
        timeZone: lastStatus?.config?.timezone || 'America/Chicago',
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit',
      });
    } catch { return iso; }
  }

  function icons() {
    if (window.lucide?.createIcons) window.lucide.createIcons();
  }

  // -------------------------------------------------------------------------
  // Bootstrap — only reveal the menu if the backend says the flag is on
  // -------------------------------------------------------------------------

  async function bootstrap() {
    try {
      lastStatus = await api('/status');
      enabled = Boolean(lastStatus.enabled);
    } catch {
      enabled = false;
    }
    if (!enabled) return;   // menu stays hidden, dashboard unchanged

    const section = document.getElementById('welfareNavSection');
    if (section) section.hidden = false;

    const tag = document.getElementById('welfareModeTag');
    if (tag) tag.textContent = lastStatus.camera_connected ? 'CAMERA LIVE' : 'NO CAMERA';

    // Simulator panel is opt-in via WELFARE_ALLOW_SIM. On a client-facing
    // service it stays hidden, so injection and purge are never reachable
    // from the UI even by a logged-in user.
    const simPanel = document.getElementById('welfareSimPanel');
    if (simPanel) simPanel.hidden = !lastStatus.allow_sim;

    hookNavigation();
    wireControls();
    icons();
    startPolling();
  }

  /**
   * app.js owns navigation: initNavigation() toggles .active on .nav-item and
   * .view, and updateHeader() already knows the five welfare titles. initView()
   * has no default branch, so it is a safe no-op for these views.
   *
   * We therefore only add a render listener. No class is touched here, so there
   * is no possibility of the two handlers fighting each other.
   */
  function hookNavigation() {
    document.querySelectorAll('#welfareNavSection .nav-item[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => {
        renderView(btn.dataset.view);
        setTimeout(icons, 0);
      });
    });
  }

  function currentWelfareView() {
    return WELFARE_VIEWS.find((v) => document.getElementById(`view-${v}`)?.classList.contains('active'));
  }

  function startPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = setInterval(() => {
      refreshBadge();
      const v = currentWelfareView();
      if (v) renderView(v);
    }, 15000);
    refreshBadge();
  }

  async function refreshBadge() {
    try {
      const stats = await api('/stats?days=7');
      const n = stats.totals?.unacknowledged || 0;
      const badge = document.getElementById('welfareNavCount');
      if (badge) {
        badge.textContent = n;
        badge.hidden = n === 0;
      }
    } catch { /* silent — dev interface must never disrupt the dashboard */ }
  }

  function renderView(view) {
    if (view === 'welfare-console') return renderConsole();
    if (view === 'welfare-signals') return renderSignals();
    if (view === 'welfare-health') return renderHealth();
    if (view === 'welfare-log') return renderLog();
    if (view === 'welfare-rules') return renderRules();
  }

  // -------------------------------------------------------------------------
  // Console
  // -------------------------------------------------------------------------

  async function renderConsole() {
    let stats; let events; let health; let signals;
    try {
      [stats, events, health, signals] = await Promise.all([
        api('/stats?days=7'), api('/events?limit=40&min_severity=2'),
        api('/fleet-health'), api('/signals'),
      ]);
    } catch (err) {
      const feed = document.getElementById('wAlertFeed');
      if (feed) feed.innerHTML = `<div class="welfare-empty">Could not load: ${esc(err.message)}</div>`;
      return;
    }

    const t = stats.totals || {};
    setText('wKpiEscalations', t.escalations ?? 0);
    setText('wKpiAlerts', t.alerts ?? 0);
    const live = signals.filter((s) => s.status === 'live' && s.signal !== 'Sensor integrity').length;
    const off = signals.filter((s) => s.status === 'disabled').length;
    setText('wKpiSignals', off ? `${live} live, ${off} off` : `${live} / 6`);
    const trusted = health.filter((h) => h.trustworthy).length;
    setText('wKpiIntegrity', health.length ? `${trusted} / ${health.length}` : '—');

    // ---- alert feed ----
    const feed = document.getElementById('wAlertFeed');
    if (feed) {
      feed.innerHTML = events.length
        ? events.map(eventCard).join('')
        : '<div class="welfare-empty">No events in the last 7 days. That is the expected state.</div>';
    }

    // ---- vehicle cards ----
    const cards = document.getElementById('wVehicleCards');
    if (cards) {
      cards.innerHTML = health.length
        ? health.map(vehicleCard).join('')
        : '<div class="welfare-empty">No vehicles reporting. Check the MQTT feed.</div>';
    }

    renderVolumeChart(stats.by_day || []);
    icons();
  }

  function eventCard(e) {
    const sev = SEV[e.severity] || SEV[1];
    const sim = e.source === 'simulated'
      ? '<span class="welfare-chip sim">simulated</span>' : '';
    const uc = e.use_case ? `<span class="welfare-chip">UC ${e.use_case}</span>` : '';
    return `
      <div class="welfare-card ${sev.cls}">
        <div class="welfare-card-top">
          <span class="welfare-sev ${sev.cls}">${sev.name}</span>
          <span class="welfare-card-title">${esc(label(e.event_type))}</span>
          <span class="welfare-card-bus">Bus ${esc(e.bus_id)}</span>
          <span class="welfare-card-time">${timeAgo(e.detected_at)}</span>
        </div>
        <div class="welfare-card-reason">${esc(e.reason || '')}</div>
        <div class="welfare-card-meta">
          ${uc}${sim}
          ${e.rule ? `<span class="welfare-chip">${esc(e.rule)}</span>` : ''}
          ${e.onboard != null ? `<span class="welfare-chip">onboard ${e.onboard}</span>` : ''}
          ${e.sensor_health ? `<span class="welfare-chip">feed ${esc(e.sensor_health)}</span>` : ''}
        </div>
      </div>`;
  }

  function vehicleCard(h) {
    const cls = { ok: 'ok', degraded: 'warn', stale: 'warn', faulty: 'bad', offline: 'bad' }[h.health] || 'warn';
    // Show both figures whenever occupancy is modelled. The measured counter
    // must stay visible — the modelled one invents alightings, and nobody
    // reading this panel should have to guess which they are looking at.
    // Values are escaped by the renderer below. Where markup is needed, pass
    // { html } and escape each interpolated value here instead.
    const onboardCell = h.onboard_is_modelled
      ? {
        html: `${esc(h.onboard ?? '—')} <span class="welfare-chip muted">modelled</span>`
            + (h.onboard_raw != null
              ? `<br><span class="welfare-sub">counter reads ${esc(h.onboard_raw)}</span>`
              : ''),
      }
      : (h.onboard ?? '—');
    const rows = [
      ['Onboard', onboardCell],
      ['Feed', h.health],
      ['Rules active', h.trustworthy ? 'yes' : 'suppressed'],
      ['GPS fix', h.gps_valid ? 'live' : 'fallback'],
      ['Last seen', h.last_seen_sec_ago != null ? `${h.last_seen_sec_ago}s ago` : '—'],
      ['Day in / out', `${h.day_in ?? 0} / ${h.day_out ?? 0}`],
    ];
    if (h.lone_for_sec != null) rows.push(['Alone for', `${Math.round(h.lone_for_sec / 60)} min`]);
    if (h.stationary_for_sec != null) rows.push(['Stationary', `${Math.round(h.stationary_for_sec / 60)} min`]);

    return `
      <div class="welfare-vcard ${cls}">
        <div class="welfare-vcard-head">
          <span class="welfare-vcard-bus">Bus ${esc(h.bus_id)}</span>
          <span class="welfare-health-pill ${cls}">${esc(h.health)}</span>
        </div>
        <dl class="welfare-kv">
          ${rows.map(([k, v]) => {
      const cell = (v && typeof v === 'object' && typeof v.html === 'string') ? v.html : esc(v);
      return `<div><dt>${esc(k)}</dt><dd>${cell}</dd></div>`;
    }).join('')}
        </dl>
        ${h.reasons?.length
      ? `<div class="welfare-card-meta">${h.reasons.map((r) => `<span class="welfare-chip bad">${esc(r)}</span>`).join('')}</div>`
      : ''}
      </div>`;
  }

  function renderVolumeChart(byDay) {
    const canvas = document.getElementById('wVolumeChart');
    if (!canvas || !window.Chart) return;
    const labels = byDay.map((d) => d.date);
    const total = byDay.map((d) => d.n);
    const alerts = byDay.map((d) => d.alerts);

    if (volumeChart) {
      volumeChart.data.labels = labels;
      volumeChart.data.datasets[0].data = total;
      volumeChart.data.datasets[1].data = alerts;
      volumeChart.update('none');
      return;
    }
    const css = getComputedStyle(document.documentElement);
    volumeChart = new window.Chart(canvas, {
      type: 'bar',
      data: {
        labels,
        datasets: [
          {
            label: 'All events',
            data: total,
            backgroundColor: css.getPropertyValue('--chart-1')?.trim() || '#5b8def',
            borderRadius: 4,
            maxBarThickness: 42,
          },
          {
            label: 'Alerts (sev 3+)',
            data: alerts,
            backgroundColor: css.getPropertyValue('--chart-5')?.trim() || '#e0567a',
            borderRadius: 4,
            maxBarThickness: 42,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { position: 'bottom' }, datalabels: { display: false } },
        scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
      },
    });
  }

  // -------------------------------------------------------------------------
  // Signals
  // -------------------------------------------------------------------------

  const STATUS_META = {
    live: ['Live', 'ok'],
    blocked: ['Blocked', 'warn'],
    camera: ['Camera', 'info'],
    // Rule exists and is tested, but is switched off pending a data fix.
    disabled: ['Off', 'muted'],
  };

  const USE_CASES = [
    [1, 'Unresponsive patient', 'Dwell', 'blocked'],
    [2, 'Elderly passenger falls in aisle', 'Distress', 'camera'],
    [3, 'Diabetic unconscious', 'Dwell + Distress', 'blocked'],
    [4, 'Silent stroke', 'Dwell + Distress', 'blocked'],
    [5, 'Peak standing capacity', 'Occupancy', 'live'],
    [6, 'Passenger past their stop', 'Lone Traveller', 'disabled'],
    [7, 'Intoxicated aggression', 'Violence & Disruption', 'camera'],
  ];

  const BLOCKERS = [
    ['VS125 dwell field name', 'Milesight', 'Unlocks use cases 1, 3 and 4 in software alone. Single email.'],
    ['Dwell reporting interval', 'Milesight', 'Determines how quickly a dwell alert can fire.'],
    ['Per-zone or vehicle-level dwell', 'Milesight', 'Decides whether zone-level immobility is possible.'],
    ['Fall + Violence + Sound concurrency', 'Milesight', 'If they cannot run together, the camera scope shrinks.'],
    ['Fall detection at 2.1 m', 'Bench test', 'Vendor specifies 3 m minimum. This is the project go/no-go.'],
    ['Depot geofence coordinates', 'Smart Urban', 'Derive from stored GPS: speed = 0 clusters over 20 min.'],
  ];

  async function renderSignals() {
    let signals;
    try { signals = await api('/signals'); } catch (err) {
      setText('wSignalsSubtitle', `Could not load: ${err.message}`);
      return;
    }
    const live = signals.filter((s) => s.status === 'live').length;
    setText('wSignalsSubtitle', `${live} of ${signals.length} rows delivering on installed hardware`);

    const body = document.getElementById('wSignalsBody');
    if (body) {
      body.innerHTML = signals.map((s) => {
        const [txt, cls] = STATUS_META[s.status] || ['—', 'warn'];
        return `<tr>
          <td><strong>${esc(s.signal)}</strong></td>
          <td>${s.use_case ? `UC ${s.use_case}` : '—'}</td>
          <td><span class="welfare-health-pill ${cls}">${txt}</span></td>
          <td>${esc(s.source)}</td>
          <td class="welfare-dim">${esc(s.detail)}</td>
          <td>${s.events == null ? '—' : s.events}</td>
        </tr>`;
      }).join('');
    }

    const uc = document.getElementById('wUseCases');
    if (uc) {
      uc.innerHTML = USE_CASES.map(([n, name, signal, status]) => {
        const [txt, cls] = STATUS_META[status];
        return `<div class="welfare-row">
          <span class="welfare-row-n">${n}</span>
          <div class="welfare-row-main">
            <div class="welfare-row-title">${esc(name)}</div>
            <div class="welfare-dim">${esc(signal)}</div>
          </div>
          <span class="welfare-health-pill ${cls}">${txt}</span>
        </div>`;
      }).join('');
    }

    const bl = document.getElementById('wBlockers');
    if (bl) {
      bl.innerHTML = BLOCKERS.map(([item, owner, why]) => `
        <div class="welfare-row">
          <div class="welfare-row-main">
            <div class="welfare-row-title">${esc(item)}</div>
            <div class="welfare-dim">${esc(why)}</div>
          </div>
          <span class="welfare-chip">${esc(owner)}</span>
        </div>`).join('');
    }
    icons();
  }

  // -------------------------------------------------------------------------
  // Sensor integrity
  // -------------------------------------------------------------------------

  async function renderHealth() {
    let health; let cfg;
    try {
      health = await api('/fleet-health');
      cfg = (await api('/status')).config;
    } catch (err) {
      setText('wHealthSubtitle', `Could not load: ${err.message}`);
      return;
    }
    const trusted = health.filter((h) => h.trustworthy).length;
    setText('wHealthSubtitle',
      health.length
        ? `${trusted} of ${health.length} vehicles have a trusted feed`
        : 'No vehicles have reported since startup');

    const body = document.getElementById('wHealthBody');
    if (body) {
      body.innerHTML = health.length ? health.map((h) => {
        const cls = { ok: 'ok', degraded: 'warn', stale: 'warn', faulty: 'bad', offline: 'bad' }[h.health] || 'warn';
        return `<tr>
          <td><strong>${esc(h.bus_id)}</strong></td>
          <td><span class="welfare-health-pill ${cls}">${esc(h.health)}</span></td>
          <td>${h.trustworthy
    ? '<span class="welfare-chip ok">rules active</span>'
    : '<span class="welfare-chip bad">suppressed</span>'}</td>
          <td>${h.onboard ?? '—'}</td>
          <td>${h.gps_valid
    ? '<span class="welfare-chip ok">live</span>'
    : '<span class="welfare-chip warn">fallback</span>'}</td>
          <td>${h.last_seen_sec_ago != null ? `${h.last_seen_sec_ago}s ago` : '—'}</td>
          <td>${h.day_in ?? 0} / ${h.day_out ?? 0}</td>
          <td class="welfare-dim">${h.reasons?.length ? esc(h.reasons.join(', ')) : '—'}</td>
        </tr>`;
      }).join('')
        : '<tr><td colspan="8" class="welfare-dim">No vehicles reporting.</td></tr>';
    }

    const checks = [
      ['Stale feed', `no data for ${Math.round((cfg.stale_after_sec || 0) / 60)} min`, 'Notify', 'Feed interrupted but may recover'],
      ['Lost feed', `no data for ${Math.round((cfg.offline_after_sec || 0) / 60)} min`, 'Alert', 'Welfare rules suppressed for this vehicle'],
      ['Negative occupancy', 'onboard < 0', 'Alert', 'Impossible value — hard counter fault'],
      ['Stuck counter', `no change in ${cfg.stuck_counter_minutes} min while moving`, 'Notify', 'The failure mode that would cause nightly false alerts'],
      ['Day drift', 'boardings vs alightings differ by more than 10%', 'Notify', 'Checked at the 04:00 service-day rollover'],
      ['No GPS fix', 'occupants aboard, no live fix', 'Degraded', 'Geofence rules fall back to a lower-confidence event'],
    ];
    const el = document.getElementById('wChecks');
    if (el) {
      el.innerHTML = checks.map(([name, cond, sev, why]) => `
        <div class="welfare-row">
          <div class="welfare-row-main">
            <div class="welfare-row-title">${esc(name)}</div>
            <div class="welfare-dim">${esc(cond)} — ${esc(why)}</div>
          </div>
          <span class="welfare-chip">${esc(sev)}</span>
        </div>`).join('');
    }
    icons();
  }

  // -------------------------------------------------------------------------
  // Event log
  // -------------------------------------------------------------------------

  let logRows = [];

  async function renderLog() {
    const sev = document.getElementById('wLogSeverity')?.value || '';
    const bus = document.getElementById('wLogBus')?.value || '';
    const qs = new URLSearchParams({ limit: '300' });
    if (sev) qs.set('min_severity', sev);
    if (bus) qs.set('bus', bus);

    try { logRows = await api(`/events?${qs}`); } catch (err) {
      setText('wLogInfo', `Could not load: ${err.message}`);
      return;
    }

    // Populate the bus filter once, from what actually exists
    const busSel = document.getElementById('wLogBus');
    if (busSel && busSel.options.length <= 1) {
      const seen = [...new Set(logRows.map((r) => r.bus_id))].sort();
      seen.forEach((b) => {
        const o = document.createElement('option');
        o.value = b; o.textContent = `Bus ${b}`;
        busSel.appendChild(o);
      });
    }

    const body = document.getElementById('wLogBody');
    if (body) {
      body.innerHTML = logRows.length ? logRows.map((e) => {
        const s = SEV[e.severity] || SEV[1];
        return `<tr>
          <td class="welfare-mono">${esc(fmtTime(e.detected_at))}</td>
          <td>${esc(e.bus_id)}</td>
          <td>
            <div>${esc(label(e.event_type))}${e.source === 'simulated'
    ? ' <span class="welfare-chip sim">sim</span>' : ''}</div>
            <div class="welfare-dim welfare-mono">${esc(e.rule || '')}</div>
          </td>
          <td><span class="welfare-sev ${s.cls}">${s.name}</span></td>
          <td class="welfare-dim">${esc(e.reason || '')}</td>
          <td>${e.onboard ?? '—'}</td>
          <td>${e.acknowledged
    ? '<span class="welfare-chip ok">ack</span>'
    : `<button class="btn btn-sm w-ack" data-id="${esc(e.event_id)}">Ack</button>`}</td>
        </tr>`;
      }).join('')
        : '<tr><td colspan="7" class="welfare-dim">No events match this filter.</td></tr>';
    }

    setText('wLogInfo', `${logRows.length} event${logRows.length === 1 ? '' : 's'}`);

    document.querySelectorAll('.w-ack').forEach((b) => {
      b.addEventListener('click', async () => {
        try {
          await api(`/events/${encodeURIComponent(b.dataset.id)}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ by: 'dev-console' }),
          });
          renderLog(); refreshBadge();
        } catch { /* ignore */ }
      });
    });
    icons();
  }

  // -------------------------------------------------------------------------
  // Rules & testing
  // -------------------------------------------------------------------------

  async function renderRules() {
    let cfg;
    try { cfg = (await api('/status')).config; } catch { return; }

    // Which families the server has enabled. Anything absent is switched off
    // and its threshold below is inert.
    const on = (cfg.enabled_rules || []);
    const isOn = (f) => on.includes('all') || on.includes(f);

    const rules = [
      ['R12 — Sensor health', 'Gates every rule below',
        `stale ${Math.round(cfg.stale_after_sec / 60)} min · offline ${Math.round(cfg.offline_after_sec / 60)} min · stuck ${cfg.stuck_counter_minutes} min`,
        isOn('sensor_health'), null],
      ['R3 — Lone traveller', 'Occupancy = 1 sustained',
        `${Math.round(cfg.lone_sustain_sec / 60)} min sustain · Notify`,
        isOn('lone_traveller'), 'needs a count that returns to zero'],
      ['R4 — Lone traveller, night', 'Same, inside the night window',
        `${cfg.late_night_from}:00–${String(cfg.late_night_to).padStart(2, '0')}:00 ${esc(cfg.timezone)} · Alert`,
        isOn('lone_traveller'), 'needs a count that returns to zero'],
      ['R6 — End of service', 'Occupants aboard at a depot or terminus',
        `${Math.round(cfg.eos_stationary_sec / 60)} min stationary under ${cfg.stationary_speed_kph} km/h · Escalate at depot`,
        isOn('end_of_service'), 'speed is 0 in every record; bus 515 never empties'],
      ['R9 — Stationary with occupants', 'Same trigger, no geofence match',
        'Notify — lower confidence by design',
        isOn('stationary'), 'cannot separate stationary from missing speed'],
      ['Alert cooldown', 'Repeat suppression per rule per vehicle',
        `${Math.round(cfg.alert_cooldown_sec / 60)} min`, true, null],
    ];

    const el = document.getElementById('wRulesList');
    if (el) {
      el.innerHTML = rules.map(([name, what, thresh, enabled, why]) => `
        <div class="welfare-row${enabled ? '' : ' welfare-row-off'}">
          <div class="welfare-row-main">
            <div class="welfare-row-title">${esc(name)}${enabled ? '' : ' <span class="welfare-chip muted">OFF</span>'}</div>
            <div class="welfare-dim">${esc(what)}${enabled || !why ? '' : ` — ${esc(why)}`}</div>
          </div>
          <span class="welfare-chip${enabled ? '' : ' muted'}">${thresh}</span>
        </div>`).join('');
    }

    const geo = document.getElementById('wGeofences');
    if (geo) {
      const all = [
        ...(cfg.depots || []).map((d) => ({ ...d, kind: 'depot' })),
        ...(cfg.termini || []).map((d) => ({ ...d, kind: 'terminus' })),
      ];
      geo.innerHTML = all.length ? all.map((g) => `
        <div class="welfare-row">
          <div class="welfare-row-main">
            <div class="welfare-row-title">${esc(g.name)}</div>
            <div class="welfare-dim welfare-mono">
              ${Number(g.lat).toFixed(5)}, ${Number(g.lng ?? g.lon).toFixed(5)} · r=${g.radiusM ?? 150} m
              ${g.buses?.length ? ` · buses ${esc(g.buses.join(', '))}` : ''}
            </div>
          </div>
          <span class="welfare-chip ${g.kind === 'depot' ? 'ok' : ''}">${g.kind}</span>
        </div>`).join('')
        : `<div class="welfare-empty">
             No geofences configured. Rule 6 will report
             <em>stationary with occupants</em> instead of naming a depot.
             Set WELFARE_DEPOTS to enable it.
           </div>`;
    }
    icons();
  }

  // -------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------

  function wireControls() {
    document.getElementById('wRefreshBtn')?.addEventListener('click', renderConsole);
    document.getElementById('wLogSeverity')?.addEventListener('change', renderLog);
    document.getElementById('wLogBus')?.addEventListener('change', renderLog);

    document.getElementById('wLogExport')?.addEventListener('click', () => {
      if (!logRows.length) return;
      const cols = ['detected_at', 'bus_id', 'event_type', 'severity', 'rule', 'reason',
        'onboard', 'sensor_health', 'use_case', 'source', 'acknowledged'];
      const csv = [cols.join(',')].concat(logRows.map((r) => cols.map((c) => {
        const v = r[c] ?? '';
        return /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : v;
      }).join(','))).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `welfare-events-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    document.querySelectorAll('.sim-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const busId = document.getElementById('wSimBus')?.value || '515';
        try {
          await api('/simulate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bus_id: busId, scenario: btn.dataset.scenario }),
          });
          setText('wSimStatus', `Injected "${btn.textContent.trim()}" on bus ${busId}`);
          refreshBadge();
        } catch (err) {
          setText('wSimStatus', `Failed: ${err.message}`);
        }
      });
    });

    document.getElementById('wPurgeBtn')?.addEventListener('click', async () => {
      if (!window.confirm('Delete every row in welfare_events? Passenger counting data is not affected.')) return;
      try {
        const r = await api('/simulate/purge', { method: 'POST' });
        setText('wSimStatus', `Cleared ${r.deleted} welfare event${r.deleted === 1 ? '' : 's'}`);
        refreshBadge();
      } catch (err) {
        setText('wSimStatus', `Failed: ${err.message}`);
      }
    });
  }

  function setText(id, v) {
    const el = document.getElementById(id);
    if (el) el.textContent = v;
  }

  // -------------------------------------------------------------------------

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
}());
