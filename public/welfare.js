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
    1: { name: 'For the record', cls: 'sev-log' },
    2: { name: 'Worth knowing', cls: 'sev-notify' },
    3: { name: 'Needs attention', cls: 'sev-alert' },
    4: { name: 'Urgent', cls: 'sev-escalate' },
  };

  const EVENT_LABELS = {
    lone_traveller: 'Someone travelling alone',
    lone_traveller_late_night: 'Someone travelling alone, after dark',
    end_of_service_occupancy: 'Someone still on board at the depot',
    terminus_occupancy: 'Someone still on board at the terminus',
    stationary_with_occupants: 'Parked with people on board',
    dwell_no_alighting: 'Nobody has got off for a while',
    sensor_stale: 'Sensor has gone quiet',
    sensor_offline: 'Sensor is offline',
    sensor_recovered: 'Sensor is back',
    shift_ended: 'Finished for the day',
    sensor_fault: 'Counter is faulty',
    sensor_suspect: 'Counter looks wrong',
    data_quality_drift: 'Counts are drifting',
    fall: 'Possible fall',
    violence: 'Possible altercation',
    dwell_exceeded: 'Long time on board',
  };

  // What the person reading this screen should actually DO. An alert with no
  // action is just noise on a depot wall.
  const EVENT_ACTIONS = {
    lone_traveller: 'Keep an eye on them until someone else boards.',
    lone_traveller_late_night: 'Check they are alright and know their stop.',
    end_of_service_occupancy: 'Walk the bus before it is parked up.',
    terminus_occupancy: 'Walk the bus before it turns around.',
    stationary_with_occupants: 'Check why the bus is held.',
    dwell_no_alighting: 'Check nobody has been left on board.',
    sensor_stale: 'No welfare cover on this bus until it reports again.',
    sensor_offline: 'No welfare cover on this bus. Tell engineering.',
    sensor_recovered: 'Nothing to do — cover is back.',
    shift_ended: 'Nothing to do — the bus has stopped for the night.',
    sensor_fault: 'Counts cannot be trusted. Tell engineering.',
    sensor_suspect: 'Counts may be wrong. Tell engineering.',
    fall: 'Check the passenger immediately.',
    violence: 'Follow the incident procedure.',
  };

  const action = (t) => EVENT_ACTIONS[t] || '';

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
      // One day, to match the console's open-alert window. Seven days made
      // the badge a count of everything nobody had ever acknowledged.
      const stats = await api('/stats?days=1');
      // Real events only. See the unacknowledged_real column in welfare/index.js.
      const t = stats.totals || {};
      // open_real counts severity 2 and up. See the column comment in
      // welfare/index.js for why the old severity-3 count was misleading.
      const n = t.open_real ?? t.unacknowledged ?? 0;
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
    let allEvents; let health;
    try {
      [allEvents, health] = await Promise.all([
        api('/events?limit=60&min_severity=2'), api('/fleet-health'),
      ]);
    } catch (err) {
      const feed = document.getElementById('wAlertFeed');
      if (feed) feed.innerHTML = `<div class="welfare-empty">Could not load: ${esc(err.message)}</div>`;
      return;
    }

    // ---- headline ----
    // Ranked worst-first so the strip always states the most serious live
    // condition. Unwatched buses outrank open alerts: an operator who thinks
    // a bus is covered when it is not is worse off than one with a known alert.
    // Simulated events do not appear on this page at all. A card reading
    // "Possible fall / Check the passenger immediately" is indistinguishable
    // from a real one at a glance, and nothing detected it — there is no
    // camera on either bus and no fall rule in the engine. Test events remain
    // on Rules & Testing and in the Event Log, where the context is explicit.
    const events = allEvents.filter((e) => e.source !== 'simulated');
    const testCount = allEvents.length - events.length;

    const untrusted = health.filter((h) => !h.trustworthy);
    const faulty = health.filter((h) => h.trustworthy && (h.reasons || []).length);
    // A bus that has finished its day is untrusted, and correctly so, but it
    // is not a fault and must not be reported in the same breath as one.
    const offShift = health.filter((h) => h.off_shift);
    const inService = health.filter((h) => !h.off_shift);
    const watchable = untrusted.filter((h) => !h.off_shift);

    // Anything real, unacknowledged and recent enough to still be an
    // operator's problem.
    //
    // Two failures to avoid, and they pull in opposite directions. The
    // original filter wanted severity >= 3 AND under two hours old, which on
    // 4 Sep excluded both of the day's actual alerts - severity 2, one and
    // five hours old - and the strip claimed nothing needed attention.
    // Dropping the window entirely then read "18 open alerts" with the
    // latest being a 20-hour-old offline, because nothing in dev is ever
    // acknowledged and the feed carries a week.
    //
    // So: severity 2 and up, bounded to one day. A day is roughly a service
    // day, so this answers "what has happened on shift", and anything older
    // has stopped being live news - it belongs in the Event Log, which is
    // unfiltered.
    const OPEN_WINDOW_MIN = 24 * 60;
    const open = events
      .filter((e) => {
        if (e.acknowledged || e.severity < 2) return false;
        const age = (Date.now() - Date.parse(e.detected_at)) / 60000;
        return Number.isFinite(age) && age <= OPEN_WINDOW_MIN;
      })
      .sort((a, b) => Date.parse(b.detected_at) - Date.parse(a.detected_at));
    const urgent = open.filter((e) => e.severity >= 3);

    // The headline used to be an if/else chain, so it reported exactly one
    // thing and silently dropped the rest: a paused bus outranked open
    // alerts, and the alerts appeared nowhere in the strip at all. Facts are
    // now collected worst-first and the leftovers go to the sub-line, so
    // nothing can be hidden by something else being worse.
    const facts = [];
    if (!health.length) {
      facts.push({ tone: 'bad', main: 'No buses are reporting', sub: 'Nothing is being watched. Tell engineering.' });
    }
    if (open.length) {
      const n = open.length;
      // The named one is the most serious, not the newest, so the label has
      // to say so - it read "Latest: Sensor is offline ... 20h ago" while two
      // newer alerts sat underneath it.
      const worst = urgent.length ? urgent[0] : open[0];
      const lead = urgent.length && urgent[0] !== open[0] ? 'Most serious' : 'Latest';
      facts.push({
        tone: urgent.length ? 'bad' : 'warn',
        main: `${n} open alert${n > 1 ? 's' : ''}`,
        sub: `${lead}: ${label(worst.event_type)} on bus ${worst.bus_id}, ${timeAgo(worst.detected_at)}.`,
      });
    }
    if (watchable.length) {
      facts.push({
        tone: 'bad',
        main: `${watchable.length} of ${inService.length} buses in service are not being watched`,
        sub: `Welfare alerts are paused on bus ${watchable.map((h) => h.bus_id).join(', ')}.`,
      });
    }
    if (faulty.length) {
      facts.push({
        tone: 'warn',
        main: 'Watching, with a fault',
        sub: `Bus ${faulty.map((h) => h.bus_id).join(', ')} has a sensor fault. Alerts still running.`,
      });
    }

    let tone; let main; let sub;
    if (!facts.length) {
      tone = 'ok';
      if (offShift.length === health.length && health.length) {
        main = 'All buses have finished for the day';
        sub = 'No welfare cover until they start again in the morning.';
      } else {
        main = 'Nothing needs attention';
        sub = `All ${health.length} buses reporting normally.`;
      }
    } else {
      const rank = { bad: 2, warn: 1, ok: 0 };
      facts.sort((a, b) => rank[b.tone] - rank[a.tone]);
      tone = facts[0].tone;
      main = facts[0].main;
      // Lead with the worst fact's own detail, then state every other fact
      // in one line so none of them can vanish.
      sub = [facts[0].sub, ...facts.slice(1).map((f) => f.main)].join(' \u00b7 ');
    }

    // ---- freshness ----
    // The event feed can sit still for hours and be perfectly healthy, so it
    // cannot double as a liveness signal. This reports two separate things:
    // when the browser last asked, and how old the newest message from any
    // bus is. Only the second one can go red.
    const ages = health
      .map((h) => h.last_seen_sec_ago)
      .filter((n) => typeof n === 'number' && Number.isFinite(n));
    const newest = ages.length ? Math.min(...ages) : null;
    const checkedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let fTone = 'ok'; let fText;
    if (newest == null) {
      fTone = 'bad';
      fText = `Checked ${checkedAt} \u2014 no bus has reported since the system started`;
    } else {
      // Buses report every few seconds in service. Minutes of silence is
      // normal off shift; the sensor-health rules own the real fault case,
      // so this only nudges rather than duplicating their alerting.
      if (newest >= 900) fTone = 'bad';
      else if (newest >= 300) fTone = 'warn';
      const age = newest < 90 ? 'seconds ago'
        : `${Math.round(newest / 60)} min ago`;
      const quiet = health.length - ages.filter((n) => n < 300).length;
      fText = `Checked ${checkedAt} \u2014 newest data ${age}`
        + (quiet > 0 ? ` \u00b7 ${quiet} of ${health.length} buses quiet` : '');
    }
    const fresh = document.getElementById('wFreshness');
    if (fresh) {
      fresh.className = `welfare-freshness ${fTone}`;
      fresh.innerHTML = `<span class="pulse"></span><span>${esc(fText)}</span>`;
    }

    const dot = document.getElementById('wHeadlineDot');
    if (dot) dot.className = `welfare-headline-dot ${tone}`;
    const strip = document.getElementById('wHeadline');
    if (strip) strip.className = `welfare-headline ${tone}`;
    setText('wHeadlineMain', main);
    setText('wHeadlineSub', sub);

    // ---- alert feed ----
    const feed = document.getElementById('wAlertFeed');
    if (feed) {
      feed.innerHTML = events.length
        ? events.map(eventCard).join('')
        : `<div class="welfare-empty">Nothing has happened in the last 7 days. That is what you want to see.${
  testCount ? `<div class="welfare-dim" style="margin-top:8px">${testCount} test event${testCount > 1 ? 's' : ''} hidden — see Rules &amp; Testing.</div>` : ''
}</div>`;
    }

    // ---- vehicle cards ----
    const cards = document.getElementById('wVehicleCards');
    if (cards) {
      cards.innerHTML = health.length
        ? health.map(vehicleCard).join('')
        : '<div class="welfare-empty">No buses are reporting.</div>';
    }

    icons();
  }

  // Operator-facing. Leads with the bus and what to do; the rule name, use
  // case number and internal severity code are engineering detail and live on
  // the Rules page, not here.
  function eventCard(e) {
    const sev = SEV[e.severity] || SEV[1];
    const act = action(e.event_type);
    return `
      <div class="welfare-card ${sev.cls}">
        <div class="welfare-card-top">
          <span class="welfare-card-bus strong">Bus ${esc(e.bus_id)}</span>
          <span class="welfare-card-title">${esc(label(e.event_type))}</span>
          <span class="welfare-card-time">${timeAgo(e.detected_at)}</span>
        </div>
        ${act ? `<div class="welfare-card-action">${esc(act)}</div>` : ''}
        <div class="welfare-card-reason">${esc(e.reason || '')}</div>
      </div>`;
  }

  // One line an operator can act on, then a small number of plain facts.
  // Deliberately does NOT hide that occupancy is an estimate: the word
  // "estimated" stays on screen, because the alternative is a depot reading a
  // modelled figure as a headcount.
  function vehicleCard(h) {
    const cls = { ok: 'ok', degraded: 'warn', stale: 'warn', faulty: 'bad', offline: 'bad' }[h.health] || 'warn';

    const REASON_TEXT = {
      no_gps_fix: 'no GPS position',
      stuck_counter: 'counter has stopped moving',
      feed_stale: 'sensor has gone quiet',
      feed_offline: 'sensor is offline',
      negative_occupancy: 'counts do not add up',
    };
    const faults = (h.reasons || []).map((r) => REASON_TEXT[r] || String(r).replace(/_/g, ' '));

    let headline; let sub;
    if (h.off_shift) {
      headline = 'Finished for the day';
      sub = 'Stopped reporting at its normal finishing time. '
        + 'No welfare cover until it starts again.';
    } else if (h.never_reported) {
      headline = 'No contact';
      sub = 'This bus has not reported since the system started. Not being watched.';
    } else if (!h.trustworthy) {
      headline = 'Not being watched';
      sub = faults.length ? `Welfare alerts are paused \u2014 ${faults.join(', ')}.`
        : 'Welfare alerts are paused for this bus.';
    } else if (faults.length) {
      headline = 'Watching, with a fault';
      sub = `${faults.join(', ')}.`;
    } else {
      headline = 'All normal';
      sub = 'Nothing needs attention on this bus.';
    }

    const seen = h.last_seen_sec_ago == null ? 'unknown'
      : h.last_seen_sec_ago < 90 ? 'just now'
        : `${Math.round(h.last_seen_sec_ago / 60)} min ago`;

    const onboard = h.onboard == null ? '\u2014'
      : h.onboard_is_modelled
        ? { html: `about ${esc(h.onboard)} <span class="welfare-sub">estimated</span>` }
        : `${h.onboard}`;

    const rows = [['On board', onboard], ['Last update', seen]];
    if (h.lone_for_sec != null) rows.push(['Alone for', `${Math.round(h.lone_for_sec / 60)} min`]);

    return `
      <div class="welfare-vcard ${cls}">
        <div class="welfare-vcard-head">
          <span class="welfare-vcard-bus">Bus ${esc(h.bus_id)}</span>
          <span class="welfare-health-pill ${cls}">${esc(headline)}</span>
        </div>
        <div class="welfare-vcard-sub">${esc(sub)}</div>
        <dl class="welfare-kv">
          ${rows.map(([k, v]) => {
      const cell = (v && typeof v === 'object' && typeof v.html === 'string') ? v.html : esc(v);
      return `<div><dt>${esc(k)}</dt><dd>${cell}</dd></div>`;
    }).join('')}
        </dl>
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
    live: ['Watching', 'ok'],
    blocked: ['Not yet', 'warn'],
    camera: ['Needs camera', 'info'],
    // Rule exists and is tested, but is switched off pending a data fix.
    disabled: ['Switched off', 'muted'],
  };

  // Status is NOT hardcoded here. It is derived from the signals the engine
  // actually reports, because this list previously said Lone Traveller was
  // switched off and Dwell was blocked long after both went live — a coverage
  // table that contradicts the engine is worse than no coverage table.
  // The signal names must match engine.signals().signal exactly.
  const USE_CASES = [
    [1, 'Unresponsive patient', ['Dwell (proxy)']],
    [2, 'Elderly passenger falls in aisle', ['Distress']],
    [3, 'Diabetic unconscious', ['Dwell (proxy)', 'Distress']],
    [4, 'Silent stroke', ['Dwell (proxy)', 'Distress']],
    [5, 'Peak standing capacity', ['Occupancy']],
    [6, 'Passenger past their stop', ['Lone Traveller', 'End of service']],
    [7, 'Intoxicated aggression', ['Violence & Disruption']],
  ];

  // Worst state wins: a use case needing two signals is only covered when
  // both are live. Ranked so the weakest contributing signal sets the status.
  const STATUS_RANK = { live: 0, blocked: 1, disabled: 2, camera: 3 };

  const TRUST_META = {
    measured: ['measured', 'ok'],
    modelled: ['modelled', 'warn'],
    proxy: ['proxy', 'warn'],
    none: ['not wired', 'muted'],
  };

  // Order the summary tiles by who has to act, not alphabetically.
  const SUMMARY_TILES = [
    ['live', 'Watching', 'Raising events on the buses today'],
    ['blocked', 'Blocked', 'Rule is on but something upstream stops it firing'],
    ['disabled', 'Switched off', 'Deliberate — the data cannot support it yet'],
    ['camera', 'Needs camera', 'Waiting on the AI Pro Dome lab rig'],
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
    let payload;
    try { payload = await api('/signals'); } catch (err) {
      setText('wSignalsSubtitle', `Could not load: ${err.message}`);
      return;
    }
    // The endpoint used to return a bare array. Tolerate both shapes so an
    // older cached script or a stale service does not blank the page.
    const signals = Array.isArray(payload) ? payload : (payload.signals || []);
    const summary = Array.isArray(payload) ? null : payload.summary;

    renderSignalSummary(summary, signals);

    const body = document.getElementById('wSignalsBody');
    if (body) {
      body.innerHTML = signals.map((s) => {
        const [txt, cls] = STATUS_META[s.status] || ['—', 'warn'];
        const [trustTxt, trustCls] = TRUST_META[s.trust] || [];
        return `<tr${s.status === 'disabled' ? ' class="welfare-row-off"' : ''}>
          <td><strong>${esc(s.signal)}</strong></td>
          <td><span class="welfare-health-pill ${cls}">${txt}</span></td>
          <td class="welfare-dim">${esc(s.detail)}${
  s.blocked_by ? `<div class="welfare-kpi-blocked">Blocked: ${esc(s.blocked_by)}</div>` : ''
}</td>
          <td>${trustTxt ? `<span class="welfare-chip ${trustCls}">${esc(trustTxt)}</span>` : '—'}${
  s.basis ? `<div class="welfare-dim welfare-kpi-basis">${esc(s.basis)}</div>` : ''
}</td>
          <td class="welfare-dim welfare-kpi-threshold">${esc(s.threshold || '—')}</td>
          <td>${s.events == null ? '—' : s.events}</td>
        </tr>`;
      }).join('');
    }

    const uc = document.getElementById('wUseCases');
    if (uc) {
      const byName = new Map(signals.map((s) => [s.signal, s]));
      uc.innerHTML = USE_CASES.map(([n, name, needs]) => {
        // Unknown signal names must not silently read as covered.
        const states = needs.map((sig) => byName.get(sig)?.status ?? 'camera');
        const worst = states.reduce((a, b) => (STATUS_RANK[b] > STATUS_RANK[a] ? b : a), 'live');
        const [txt, cls] = STATUS_META[worst] || ['—', 'warn'];
        return `<div class="welfare-row">
          <span class="welfare-row-n">${n}</span>
          <div class="welfare-row-main">
            <div class="welfare-row-title">${esc(name)}</div>
            <div class="welfare-dim">${esc(needs.join(' + '))}</div>
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

  /**
   * KPI status summary strip.
   * Falls back to counting the rows when an older service returns no summary.
   */
  function renderSignalSummary(summary, signals) {
    const s = summary || fallbackSummary(signals);

    const caveats = [];
    if (s.modelled_live) caveats.push(`${s.modelled_live} on a modelled tally`);
    if (s.proxy_live) caveats.push(`${s.proxy_live} a proxy measure`);
    setText('wSignalsSubtitle',
      `${s.by_status.live || 0} of ${s.total} raising events on the buses today`
      + `${caveats.length ? ` — ${caveats.join(', ')}` : ''}`
      + ` · ${s.events_7d} event${s.events_7d === 1 ? '' : 's'} in the last 7 days`);

    const strip = document.getElementById('wSignalsSummary');
    if (!strip) return;

    const tiles = SUMMARY_TILES.map(([key, title, why]) => {
      const n = s.by_status[key] || 0;
      const [, cls] = STATUS_META[key] || ['', 'warn'];
      return `<div class="welfare-kpi-tile ${n ? cls : 'zero'}">
        <div class="welfare-kpi-n">${n}</div>
        <div class="welfare-kpi-title">${esc(title)}</div>
        <div class="welfare-kpi-why">${esc(why)}</div>
      </div>`;
    }).join('');

    const rules = (s.enabled_rules || []).length
      ? (s.enabled_rules || []).map((r) => `<span class="welfare-chip">${esc(r)}</span>`).join(' ')
      : '<span class="welfare-chip bad">none</span>';

    // What the rules are being fed. Stated from the engine's declared mode,
    // not guessed from whether a bus happens to be reporting.
    const occ = s.occupancy;
    const occTile = occ ? `
      <div class="welfare-kpi-tile ${occ.modelled ? 'info' : 'muted'}">
        <div class="welfare-kpi-title">Occupancy source</div>
        <div class="welfare-kpi-rules"><span class="welfare-chip ${
  occ.modelled ? 'warn' : ''}">${occ.modelled ? 'modelled' : 'raw'}</span>${
  occ.confirmed ? '' : ' <span class="welfare-chip">unconfirmed</span>'}</div>
        <div class="welfare-kpi-why">${esc(occ.note || (occ.modelled
    ? 'Every rule below reads the rebalanced tally'
    : 'Rules read the VS125 counter as sent'))}</div>
      </div>` : '';

    strip.innerHTML = `${tiles}${occTile}
      <div class="welfare-kpi-tile wide">
        <div class="welfare-kpi-title">Rule families enabled</div>
        <div class="welfare-kpi-rules">${rules}</div>
        ${(s.blockers || []).length ? `<div class="welfare-kpi-why">${
  s.blockers.length} signal${s.blockers.length === 1 ? '' : 's'} with a named blocker \u2014 see the table below.</div>` : ''}
      </div>`;
  }

  /** Older service, bare-array /signals response. */
  function fallbackSummary(signals) {
    const by = { live: 0, blocked: 0, disabled: 0, camera: 0 };
    for (const s of signals) if (by[s.status] != null) by[s.status] += 1;
    return {
      total: signals.length,
      by_status: by,
      modelled_live: 0,
      proxy_live: 0,
      events_7d: signals.reduce((n, s) => n + (Number.isFinite(s.events) ? s.events : 0), 0),
      blockers: [],
      enabled_rules: [],
      occupancy: null,
    };
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
        ? `${trusted} of ${health.length} buses are being watched`
        : 'No buses have reported since startup');

    const HEALTH_TEXT = {
      ok: 'Working', degraded: 'Working, with a fault',
      stale: 'Gone quiet', faulty: 'Faulty', offline: 'Offline',
      off_shift: 'Finished for the day',
      unknown: 'No contact',
    };
    const REASON_TEXT = {
      no_gps_fix: 'no GPS position',
      stuck_counter: 'counter has stopped moving',
      feed_stale: 'sensor has gone quiet',
      feed_offline: 'sensor is offline',
      negative_occupancy: 'counts do not add up',
    };

    const body = document.getElementById('wHealthBody');
    if (body) {
      body.innerHTML = health.length ? health.map((h) => {
        // Off shift reads as neutral, not bad. The row still says alerts are
        // paused - that stays honest - but a bus parked for the night is not
        // the same class of thing as one that has failed mid-service.
        const cls = h.off_shift ? 'ok'
          : ({ ok: 'ok', degraded: 'warn', stale: 'warn', faulty: 'bad', offline: 'bad' }[h.health] || 'warn');
        const seen = h.last_seen_sec_ago == null ? '—'
          : h.last_seen_sec_ago < 90 ? 'just now'
            : `${Math.round(h.last_seen_sec_ago / 60)} min ago`;
        const faults = h.off_shift ? ['finished for the day']
          : h.never_reported ? ['has not reported at all']
            : (h.reasons || []).map((r) => REASON_TEXT[r] || String(r).replace(/_/g, ' '));
        // "estimated" stays visible: this figure is modelled, and a depot
        // must not read it as a headcount.
        const onboard = h.onboard == null ? '—'
          : h.onboard_is_modelled
            ? `about ${esc(h.onboard)} <span class="welfare-sub">estimated</span>`
            : esc(h.onboard);
        return `<tr>
          <td><strong>${esc(h.bus_id)}</strong></td>
          <td><span class="welfare-health-pill ${cls}">${esc(h.off_shift ? HEALTH_TEXT.off_shift : (HEALTH_TEXT[h.health] || h.health))}</span></td>
          <td>${h.trustworthy
    ? '<span class="welfare-chip ok">yes</span>'
    : `<span class="welfare-chip ${h.off_shift ? 'warn' : 'bad'}">no — alerts paused</span>`}</td>
          <td>${onboard}</td>
          <td>${esc(seen)}</td>
          <td class="welfare-dim">${faults.length ? esc(faults.join(', ')) : 'none'}</td>
        </tr>`;
      }).join('')
        : '<tr><td colspan="6" class="welfare-dim">No buses reporting.</td></tr>';
    }

    const checks = [
      ['Sensor has gone quiet', `nothing heard for ${Math.round((cfg.stale_after_sec || 0) / 60)} min`, 'Worth knowing', 'It may come back on its own'],
      ['Sensor is offline', `nothing heard for ${Math.round((cfg.offline_after_sec || 0) / 60)} min`, 'Needs attention', 'This bus stops being watched'],
      ['Counts do not add up', 'more people off than ever got on', 'Needs attention', 'The counter has a fault'],
      ['Counter has stopped moving', `no change in ${cfg.stuck_counter_minutes} min while driving`, 'Worth knowing', 'Left unchecked this causes false alerts every night'],
      ['Boardings and alightings drift apart', 'more than 10% apart over a day', 'Worth knowing', 'Checked once a day at 04:00'],
      ['No GPS position', 'people aboard, no live fix', 'Reduced cover', 'Anything depending on location is less certain'],
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
    ? ' <span class="welfare-chip sim">test</span>' : ''}</div>
            ${action(e.event_type)
    ? `<div class="welfare-dim">${esc(action(e.event_type))}</div>` : ''}
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

    // Volume history lives here, not on the console: it exists to check a
    // threshold change, which is an engineering job, not an operator one.
    // Real events only: this chart is used to tune thresholds, and the test
    // buttons on this very page would otherwise inflate it.
    api('/stats?days=14')
      .then((st) => {
        renderVolumeChart(st.by_day || []);
        const n = st.simulated_excluded || 0;
        setText('wVolumeNote', n
          ? `Real events only — ${n} test event${n > 1 ? 's' : ''} excluded.`
          : 'Real events only.');
      })
      .catch(() => {});

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
      ['R1 — Dwell (proxy)', 'Occupants held with nobody alighting',
        `${Math.round(cfg.dwell_no_alight_sec / 60)} min held · gap reset ${Math.round(cfg.dwell_max_gap_sec / 60)} min · Notify`,
        isOn('dwell'), 'awaiting the VS125 dwell field from Milesight'],
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
