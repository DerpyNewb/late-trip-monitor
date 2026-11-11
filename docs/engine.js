/* The late-trip check for the browser. It mirrors monitor.py rule for rule, and test_monitor.py
   runs both on the sample shift to prove they agree. `node docs/engine.js samples` prints the replay. */
(function (root) {
  'use strict';

  const STALE = 15; // minutes without a driver update before a trip is "unknown", never "late"
  const LEAD = 30;  // minutes before the window opens that drivers should be reporting
  const STEP = 5;   // minutes between scheduled checks
  const STATUSES = ['en_route', 'arrived', 'picked_up', 'dropped_off', 'no_show', 'cancelled'];
  const CONTACT = ['arrived', 'picked_up', 'dropped_off', 'no_show'];
  const ALERTS = ['at_risk', 'late', 'unknown'];
  const TRIP_FIELDS = ['trip_id', 'rider_ref', 'purpose', 'mobility', 'zone', 'desk', 'driver_id', 'window_start', 'window_end'];
  const UPDATE_FIELDS = ['at', 'trip_id', 'driver_id', 'status'];

  // Times are whole minutes since 1970, computed in UTC so no time zone shifts them (the Python side uses naive times).
  const pad = (n) => String(n).padStart(2, '0');
  function parseTime(text) {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2}) (\d{1,2}):(\d{1,2})$/.exec(text);
    const [y, mo, d, h, mi] = m ? m.slice(1).map(Number) : [];
    const date = m && new Date(Date.UTC(y, mo - 1, d, h, mi));
    if (!m || h > 23 || mi > 59 || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
      throw new Error(`time '${text}' is not YYYY-MM-DD HH:MM`);
    }
    return date.getTime() / 60000;
  }
  function fmt(t) {
    const d = new Date(t * 60000);
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
  }
  const hm = (t) => fmt(t).slice(11);

  // RFC 4180 CSV, read the way Python's csv module reads it. Each row keeps the line it ends on.
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    let line = 1;
    text = text.replace(/^﻿/, '');
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (quoted) {
        if (c === '"' && text[i + 1] === '"') { field += '"'; i += 1; } else if (c === '"') quoted = false;
        else { if (c === '\n') line += 1; field += c; }
      } else if (c === '"' && field === '') quoted = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i + 1] === '\n') i += 1;
        row.push(field);
        rows.push({ cells: row, line });
        row = []; field = ''; line += 1;
      } else field += c;
    }
    if (field !== '' || row.length) { row.push(field); rows.push({ cells: row, line }); }
    return rows.filter((r) => !(r.cells.length === 1 && r.cells[0] === ''));
  }

  function readRows(text, fields) {
    const [head, ...rows] = parseCSV(text);
    if (!head) return [];
    return rows.map(({ cells, line }) => {
      const row = {};
      head.cells.forEach((name, i) => { row[name] = cells[i]; });
      const missing = fields.filter((name) => !(row[name] || '').trim());
      return { line, row, error: missing.length ? `missing ${missing.join(', ')}` : null };
    });
  }

  /** Read trips.csv and updates.csv text. Bad rows are listed in `rejected`; good rows still load. */
  function load(tripsText, updatesText) {
    const trips = new Map();
    const rejected = [];
    for (const { line, row, error } of readRows(tripsText, TRIP_FIELDS)) {
      try {
        if (error) throw new Error(error);
        if (trips.has(row.trip_id)) throw new Error(`trip ${row.trip_id} is listed twice`);
        const start = parseTime(row.window_start);
        const end = parseTime(row.window_end);
        if (end <= start) throw new Error('pickup window ends before it starts');
        const trip = {};
        TRIP_FIELDS.forEach((k) => { trip[k] = row[k]; });
        trips.set(row.trip_id, { ...trip, window_start: start, window_end: end, updates: [] });
      } catch (err) {
        rejected.push({ file: 'trips.csv', line, reason: err.message });
      }
    }
    for (const { line, row, error } of readRows(updatesText, UPDATE_FIELDS)) {
      try {
        if (error) throw new Error(error);
        const trip = trips.get(row.trip_id);
        if (!trip) throw new Error(`unknown trip ${row.trip_id}`);
        if (row.driver_id !== trip.driver_id) throw new Error(`driver ${row.driver_id} is not assigned to ${row.trip_id}`);
        if (!STATUSES.includes(row.status)) throw new Error(`unknown status '${row.status}'`);
        if (row.status === 'en_route' && !row.eta) throw new Error('en_route update has no ETA');
        const at = parseTime(row.at);
        trip.updates.push({ at, status: row.status, eta: row.status === 'en_route' ? parseTime(row.eta) : null });
      } catch (err) {
        rejected.push({ file: 'updates.csv', line, reason: err.message });
      }
    }
    trips.forEach((trip) => trip.updates.sort((a, b) => a.at - b.at));
    return { trips, rejected };
  }

  /** [time, minutes late] when the driver's arrival is known, or [null, null]. */
  function arrival(trip, now = null) {
    const contact = trip.updates.find((u) => CONTACT.includes(u.status) && (now === null || u.at <= now));
    if (!contact) return [null, null];
    const late = contact.at - trip.window_end;
    if (contact.status === 'arrived' || contact.status === 'no_show' || late <= 0) return [contact.at, Math.max(late, 0)];
    return [null, null]; // first sign of the driver came after the window, but the arrival itself wasn't recorded
  }

  /** [state, reason] for a trip, using only the updates received by `now`. */
  function stateAt(trip, now) {
    let last = null;
    for (const u of trip.updates) { if (u.at <= now) last = u; else break; }
    const start = trip.window_start;
    const end = trip.window_end;
    if (last && last.status !== 'en_route') {
      if (last.status === 'cancelled') return ['cancelled', `Cancelled at ${hm(last.at)}`];
      const [when, late] = arrival(trip, now);
      if (when === null) return [last.status, 'Arrival time not recorded'];
      return [last.status, `Arrived ${hm(when)}, ${late ? `${late} min after the window` : 'on time'}`];
    }
    if (!last || now - last.at > STALE) {
      if (now < start - LEAD) return ['scheduled', `Window ${hm(start)}-${hm(end)}`];
      return ['unknown', `No update from driver ${trip.driver_id} ${last ? `since ${hm(last.at)}` : 'yet'}`];
    }
    if (now > end) return ['late', `Window closed ${hm(end)}; driver ETA ${hm(last.eta)}`];
    if (last.eta > end) return ['at_risk', `Driver ETA ${hm(last.eta)} is after the window closes at ${hm(end)}`];
    return ['on_track', `Driver ETA ${hm(last.eta)}`];
  }

  const riderText = (eta) => `Hi, this is your ride service. Your driver is running late and should arrive around ${hm(eta)}. `
    + 'Reply to this message or call us if you need to change your trip.';

  function summarize(trips, alerts) {
    const warned = new Map(alerts.filter((a) => a.kind === 'at_risk').map((a) => [a.trip_id, parseTime(a.at)]));
    const lastStatus = (t) => (t.updates.length ? t.updates[t.updates.length - 1].status : null);
    const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
    let onTime = 0; let late = 0; let unrecorded = 0; let missed = 0; let falseAlarms = 0;
    const minutesLate = [];
    const warnings = [];
    for (const trip of trips.values()) {
      if (lastStatus(trip) === 'cancelled') continue;
      const [when, by] = arrival(trip);
      if (when === null) unrecorded += 1;
      else if (by) {
        late += 1;
        minutesLate.push(by);
        if (warned.has(trip.trip_id)) warnings.push(trip.window_end - warned.get(trip.trip_id)); else missed += 1;
      } else {
        onTime += 1;
        if (warned.has(trip.trip_id)) falseAlarms += 1;
      }
    }
    const all = [...trips.values()];
    const count = (kind) => alerts.filter((a) => a.kind === kind).length;
    return {
      trips: trips.size,
      cancelled: all.filter((t) => lastStatus(t) === 'cancelled').length,
      no_shows: all.filter((t) => lastStatus(t) === 'no_show').length,
      on_time: onTime, late, arrival_not_recorded: unrecorded,
      on_time_rate: onTime + late ? Math.round((100 * onTime) / (onTime + late)) : null,
      average_minutes_late: avg(minutesLate),
      alerts: { at_risk: count('at_risk'), late: count('late'), unknown: count('unknown') },
      late_with_warning: warnings.length, late_without_warning: missed,
      average_warning_minutes: avg(warnings),
      at_risk_but_on_time: falseAlarms,
    };
  }

  /** Run the check every STEP minutes across the shift: each trip's state changes, and the alerts in order. */
  function replay(trips, rejected = []) {
    const list = [...trips.values()];
    if (!list.length) throw new Error('no valid trips to replay');
    const floorHour = (t) => t - (((t % 60) + 60) % 60);
    const start = floorHour(list.reduce((m, t) => Math.min(m, t.window_start - LEAD), Infinity));
    const latest = list.reduce((m, t) => t.updates.reduce((n, u) => Math.max(n, u.at), Math.max(m, t.window_end)), -Infinity);
    const end = floorHour(latest + 60);
    const sent = new Set();
    const alerts = [];
    const changes = new Map(list.map((t) => [t.trip_id, []]));
    let tick = 0;
    for (let now = start; now <= end; now += STEP, tick += 1) {
      const states = list.map((trip) => stateAt(trip, now));
      list.forEach((trip, i) => {
        const [state, reason] = states[i];
        const seen = changes.get(trip.trip_id);
        const prev = seen[seen.length - 1];
        if (!prev || prev[1] !== state || prev[2] !== reason) seen.push([tick, state, reason]);
      });
      list.forEach((trip, i) => {
        const [state, reason] = states[i];
        if (!ALERTS.includes(state) || sent.has(`${trip.trip_id}|${state}`)) return;
        sent.add(`${trip.trip_id}|${state}`); // one alert per trip and kind, like the primary key in monitor.py
        const last = trip.updates.filter((u) => u.at <= now).pop();
        alerts.push({
          trip_id: trip.trip_id, kind: state, at: fmt(now), desk: trip.desk, driver_id: trip.driver_id, reason,
          rider_text: state !== 'unknown' ? riderText(last.eta) : null, tick,
        });
      });
    }
    const rows = list.map((trip) => {
      const row = {};
      TRIP_FIELDS.forEach((k) => { row[k] = trip[k]; });
      return { ...row, window_start: hm(trip.window_start), window_end: hm(trip.window_end), changes: changes.get(trip.trip_id) };
    });
    return {
      shift_date: fmt(start).slice(0, 10), start: fmt(start), step_minutes: STEP, ticks: tick,
      trips: rows, alerts, rejected, summary: summarize(trips, alerts),
    };
  }

  const Engine = { STEP, ALERTS, parseTime, fmt, hm, load, stateAt, arrival, replay };
  if (typeof module === 'object' && module.exports) {
    module.exports = Engine;
    if (require.main === module) {
      const fs = require('fs');
      const path = require('path');
      const dir = process.argv[2] || 'samples';
      const read = (name) => fs.readFileSync(path.join(dir, name), 'utf8');
      const { trips, rejected } = load(read('trips.csv'), read('updates.csv'));
      process.stdout.write(JSON.stringify(replay(trips, rejected)));
    }
  } else {
    root.Engine = Engine;
  }
}(typeof window === 'undefined' ? globalThis : window));
