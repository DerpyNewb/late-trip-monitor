'use strict';

const LABEL = {
  scheduled: 'Not started', on_track: 'On track', at_risk: 'At risk', late: 'Late', unknown: 'No recent update',
  arrived: 'Driver arrived', picked_up: 'Rider on board', dropped_off: 'Completed', no_show: 'No-show', cancelled: 'Cancelled',
};
const ATTENTION = ['late', 'unknown', 'at_risk'];
const DONE = ['arrived', 'picked_up', 'dropped_off', 'no_show'];
const DRIVING = ['on_track', 'at_risk', 'late']; // a driver is on the way, so a delay or a silent app makes sense
const OPEN = ['scheduled', 'on_track', 'at_risk', 'late', 'unknown'];
const CHANGE = { delay: 'driver 20 minutes behind', quiet: "driver's app silent for 25 minutes", cancel: 'rider cancelled' };
const DELAY = 20;
const QUIET = 25;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TRIPS = 500;
const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => {
    if (key.startsWith('data-') || key.startsWith('aria-')) node.setAttribute(key, value); else node[key] = value;
  });
  children.forEach((child) => node.append(child));
  return node;
}

const app = {
  base: null, // { trips, rejected, sample, names }
  edits: [], // { trip_id, kind, at } in the order they were made
  actions: new Map(), // `${trip_id}|${kind}` -> what the dispatcher did with that alert, and when
  trips: null, // base trips with the edits applied
  view: null, // Engine.replay of `trips`
  start: 0,
  busiest: 0,
  timer: null,
  signatures: {},
};

const slider = $('time');
const tickNow = () => Number(slider.value);
const clock = (tick) => window.Engine.hm(app.start + tick * window.Engine.STEP);
const stateAt = (row, tick) => {
  let current = row.changes[0];
  for (const change of row.changes) { if (change[0] <= tick) current = change; else break; }
  return { state: current[1], reason: current[2] };
};

// ---- changes the visitor makes to the shift ----

function cloneTrips(trips) {
  return new Map([...trips].map(([id, trip]) => [id, { ...trip, updates: trip.updates.map((u) => ({ ...u })) }]));
}

function applyEdit(trips, { trip_id: id, kind, at }) {
  const trip = trips.get(id);
  const past = trip.updates.filter((u) => u.at <= at && !(u.at === at && u.status === 'en_route'));
  const future = trip.updates.filter((u) => u.at > at);
  if (kind === 'delay') {
    // Everything still to come happens DELAY minutes later, and the driver keeps sending the new ETA meanwhile.
    const last = trip.updates.filter((u) => u.at <= at && u.status === 'en_route').pop();
    const eta = (last ? last.eta : trip.window_start) + DELAY;
    const meanwhile = [];
    for (let t = at; t < at + DELAY; t += 5) meanwhile.push({ at: t, status: 'en_route', eta });
    trip.updates = [...past, ...meanwhile, ...future.map((u) => ({ ...u, at: u.at + DELAY, eta: u.eta === null ? null : u.eta + DELAY }))];
  } else if (kind === 'quiet') {
    trip.updates = [...trip.updates.filter((u) => u.at <= at), ...future.filter((u) => u.at > at + QUIET)];
  } else {
    trip.updates = [...past, { at, status: 'cancelled', eta: null }];
  }
  trip.updates.sort((a, b) => a.at - b.at);
}

function rebuild(keepTick) {
  const tick = tickNow();
  app.trips = cloneTrips(app.base.trips);
  app.edits.forEach((edit) => applyEdit(app.trips, edit));
  app.view = window.Engine.replay(app.trips, app.base.rejected);
  app.start = window.Engine.parseTime(app.view.start);
  const attention = (t) => app.view.trips.filter((row) => ATTENTION.includes(stateAt(row, t).state)).length;
  app.busiest = 0;
  for (let t = 0, most = -1; t < app.view.ticks; t += 1) {
    const n = attention(t);
    if (n > most) { app.busiest = t; most = n; }
  }
  slider.max = app.view.ticks - 1;
  slider.value = keepTick ? Math.min(tick, app.view.ticks - 1) : app.busiest;
  app.signatures = {};
  renderShift();
  render();
}

function setBase(base) {
  stop();
  app.base = base;
  app.edits = [];
  app.actions.clear();
  const desks = [...new Set([...base.trips.values()].map((t) => t.desk))].sort();
  $('desk').replaceChildren(el('option', { value: '', textContent: 'All desks' }), ...desks.map((d) => el('option', { value: d, textContent: d })));
  rebuild(false);
  const date = new Date(`${app.view.shift_date}T12:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  $('source').textContent = base.sample
    ? `Fictional shift, ${date}. Riders, drivers and zones are made up.`
    : `Your files (${base.names}), shift of ${date}. They stay in this browser.`;
  $('rejected-note').textContent = 'A bad row is listed and skipped, and the rest of the file still loads.'
    + (base.sample ? ' These were added to the sample on purpose.' : '');
  $('use-sample').disabled = base.sample;
}

// ---- drawing ----

function renderShift() {
  const s = app.view.summary;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('results-title').textContent = app.edits.length ? 'End-of-shift results, with your changes' : 'End-of-shift results';
  $('results-figures').replaceChildren(
    el('p', {}, el('strong', { textContent: s.on_time_rate === null ? 'None yet' : `${s.on_time_rate}%` }), `of ${s.on_time + s.late} trips with a recorded arrival were on time`),
    el('p', {}, el('strong', { textContent: `${s.late_with_warning} of ${s.late}` }), `late arrivals were flagged at risk first, ${s.average_warning_minutes} minutes before the window closed on average`),
    el('p', {}, el('strong', { textContent: String(s.at_risk_but_on_time) }), 'at-risk alerts were for trips that still arrived on time'),
  );
  $('results-notes').replaceChildren(...[
    `The ${plural(s.late, 'late arrival')} averaged ${s.average_minutes_late} minutes after the window. `
      + `${s.late_without_warning} ${s.late_without_warning === 1 ? 'was' : 'were'} reported late only after the window had closed, so no early warning was possible.`,
    `${plural(s.arrival_not_recorded, 'trip')} closed without an arrival time; ${plural(s.no_shows, 'no-show')} and ${plural(s.cancelled, 'cancellation')} out of ${s.trips} trips.`,
    `${s.alerts.at_risk + s.alerts.late + s.alerts.unknown} alerts in all: ${s.alerts.at_risk} at risk, ${s.alerts.late} late and ${s.alerts.unknown} with no recent update. Messages sent to riders: 0.`,
  ].map((text) => el('li', { textContent: text })));
  $('rejected-list').replaceChildren(...(app.view.rejected.length
    ? app.view.rejected.map((r) => el('li', {}, el('code', { textContent: `${r.file}, line ${r.line}` }), `: ${r.reason}`))
    : [el('li', { textContent: 'None. Every row loaded.' })]));
  $('edit-list').replaceChildren(...app.edits.map((e) => el('li', { textContent: `${window.Engine.hm(e.at)}: ${e.trip_id}, ${CHANGE[e.kind]}` })));
  $('undo').disabled = !app.edits.length;
  $('reset').disabled = !app.edits.length && !app.actions.size;
}

function alertCard(alert, tick) {
  const key = `${alert.trip_id}|${alert.kind}`;
  const act = app.actions.get(key) || {};
  const handled = act.handledTick !== undefined && act.handledTick <= tick;
  const decided = act.draftTick !== undefined && act.draftTick <= tick ? act.draft : null;
  const text = act.text || alert.rider_text;
  const button = (action, label, secondary = true) => el('button', {
    type: 'button', className: secondary ? 'small secondary' : 'small', textContent: label,
    'data-act': action, 'aria-label': `${label} for ${alert.trip_id}`,
  });
  const card = el('li', { className: handled ? 'handled' : '', tabIndex: -1, 'data-key': key },
    el('p', { className: 'alert-head' }, el('span', { className: `state ${alert.kind}`, textContent: LABEL[alert.kind] }),
      ` ${clock(alert.tick)}, ${alert.trip_id} to ${alert.desk}`),
    el('p', { textContent: `${alert.reason}. Driver ${alert.driver_id}.` }));
  if (alert.rider_text && act.editing) {
    const id = `text-${alert.trip_id}-${alert.kind}`;
    card.append(el('div', { className: 'draft' },
      el('label', { htmlFor: id, textContent: `Text for the rider on ${alert.trip_id}` }),
      el('textarea', { id, rows: 3, maxLength: 480, value: act.pending ?? text }),
      el('div', { className: 'row-actions' }, button('save', 'Save text', false), button('cancel', 'Cancel'))));
  } else if (alert.rider_text) {
    const lead = decided === 'approved' ? `Approved at ${clock(act.draftTick)}. A live setup would text the rider now: `
      : decided === 'discarded' ? `Discarded at ${clock(act.draftTick)}, not sent: ` : 'Draft for the rider, not sent: ';
    card.append(el('p', { className: `draft ${decided || ''}` }, el('strong', { textContent: lead }), text));
    if (!decided) card.append(el('div', { className: 'row-actions' }, button('approve', 'Approve text', false), button('edit', 'Edit text'), button('discard', 'Discard text')));
  }
  card.append(handled ? el('p', { className: 'handled-note', textContent: `Handled at ${clock(act.handledTick)}` })
    : el('div', { className: 'row-actions' }, button('handle', 'Mark handled')));
  return card;
}

function render() {
  const tick = tickNow();
  const desk = $('desk').value;
  const time = clock(tick);
  const trips = app.view.trips.filter((t) => !desk || t.desk === desk).map((t) => ({ ...t, ...stateAt(t, tick) }));
  $('time-out').textContent = time;
  slider.setAttribute('aria-valuetext', time);
  document.querySelectorAll('.at').forEach((node) => { node.textContent = time; });
  $('disrupt-apply').textContent = `Apply at ${time}`;

  const count = (states) => trips.filter((t) => states.includes(t.state)).length;
  $('counts').textContent = `${desk || 'All desks'} at ${time}: ${count(['late'])} late, ${count(['unknown'])} with no recent update, `
    + `${count(['at_risk'])} at risk, ${count(['on_track'])} on track, ${count(DONE)} arrived or done, `
    + `${count(['scheduled'])} not started, ${count(['cancelled'])} cancelled.`;

  const alerts = app.view.alerts.filter((a) => a.tick <= tick && (!desk || a.desk === desk));
  const alertFor = (t) => alerts.find((a) => a.trip_id === t.trip_id && a.kind === t.state);
  const alertStatus = (t) => {
    const act = app.actions.get(`${t.trip_id}|${t.state}`);
    if (!alertFor(t)) return 'Not yet';
    return act && act.handledTick !== undefined && act.handledTick <= tick ? `Handled ${clock(act.handledTick)}` : 'Open';
  };
  const tripCell = (t) => el('td', {}, el('strong', { textContent: t.trip_id }), el('small', { textContent: `Rider ${t.rider_ref}` }));
  const stateCell = (state) => el('td', {}, el('span', { className: `state ${state}`, textContent: LABEL[state] }));
  const urgent = trips.filter((t) => ATTENTION.includes(t.state))
    .sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state) || a.window_end.localeCompare(b.window_end));
  $('attention-rows').replaceChildren(...urgent.map((t) => el('tr', { className: `row-${t.state}` },
    stateCell(t.state), el('td', {}, el('strong', { textContent: t.trip_id }), el('small', { textContent: `Rider ${t.rider_ref}, ${t.desk}` })),
    el('td', { textContent: `${t.window_start}-${t.window_end}` }), el('td', { textContent: t.reason }),
    el('td', { textContent: alertStatus(t) }))));
  $('attention-empty').hidden = urgent.length > 0;

  // Rebuild the alert cards only when something on them changed, so a button isn't replaced mid-click during playback.
  const handledCount = alerts.filter((a) => (app.actions.get(`${a.trip_id}|${a.kind}`) || {}).handledTick <= tick).length;
  $('alerts-count').textContent = alerts.length
    ? `${alerts.length - handledCount} open, ${handledCount} handled. One alert per trip for each problem, so a desk isn't told the same thing twice. Nothing reaches a rider until a dispatcher approves the text.`
    : 'One alert per trip for each problem. Nothing reaches a rider until a dispatcher approves the text.';
  const signature = JSON.stringify([desk, alerts.map((a) => {
    const act = app.actions.get(`${a.trip_id}|${a.kind}`) || {};
    return [a.trip_id, a.kind, act.handledTick <= tick, act.draftTick <= tick && act.draft, act.text, !!act.editing];
  })]);
  if (signature !== app.signatures.alerts) {
    app.signatures.alerts = signature;
    $('alert-list').replaceChildren(...alerts.slice().reverse().map((a) => alertCard(a, tick)));
  }
  $('alerts-empty').hidden = alerts.length > 0;

  $('trip-rows').replaceChildren(...trips.map((t) => el('tr', { className: `row-${t.state}` },
    stateCell(t.state), tripCell(t), el('td', { textContent: `${t.window_start}-${t.window_end}` }),
    el('td', { textContent: t.reason }), el('td', { textContent: t.driver_id }), el('td', { textContent: t.desk }),
    el('td', { textContent: `${t.mobility}, ${t.purpose.toLowerCase()}` }))));

  const open = app.view.trips.map((t) => ({ ...t, ...stateAt(t, tick) })).filter((t) => OPEN.includes(t.state));
  const options = open.map((t) => [t.trip_id, `${t.trip_id}, ${LABEL[t.state].toLowerCase()}, window ${t.window_start}-${t.window_end}`]);
  const optionSignature = JSON.stringify(options);
  if (optionSignature !== app.signatures.options) {
    app.signatures.options = optionSignature;
    const picked = $('disrupt-trip').value;
    $('disrupt-trip').replaceChildren(...(options.length
      ? options.map(([value, textContent]) => el('option', { value, textContent }))
      : [el('option', { value: '', textContent: `No trips in progress at ${time}` })]));
    if (options.some(([value]) => value === picked)) $('disrupt-trip').value = picked;
  }
  $('disrupt-apply').disabled = !options.length;
}

// ---- controls ----

function stop() {
  clearInterval(app.timer);
  app.timer = null;
  $('play').textContent = 'Play';
  $('play').setAttribute('aria-pressed', 'false');
}

function say(id, text, error = false) {
  $(id).textContent = text;
  $(id).classList.toggle('error', error);
}

function wire() {
  $('play').addEventListener('click', () => {
    if (app.timer) { stop(); return; }
    if (tickNow() >= app.view.ticks - 1) { slider.value = 0; render(); }
    $('play').textContent = 'Pause';
    $('play').setAttribute('aria-pressed', 'true');
    app.timer = setInterval(() => {
      slider.value = tickNow() + 1;
      render();
      if (tickNow() >= app.view.ticks - 1) stop();
    }, 350);
  });
  slider.addEventListener('input', () => { stop(); render(); });
  $('desk').addEventListener('change', render);
  $('busiest').addEventListener('click', () => { stop(); slider.value = app.busiest; render(); });
  $('end').addEventListener('click', () => { stop(); slider.value = app.view.ticks - 1; render(); });

  $('disrupt-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const id = $('disrupt-trip').value;
    const kind = $('disrupt-kind').value;
    const at = app.start + tickNow() * window.Engine.STEP;
    const trip = app.trips.get(id);
    if (!trip) return;
    const [state] = window.Engine.stateAt(trip, at);
    if (kind !== 'cancel' && !DRIVING.includes(state)) {
      say('disrupt-status', `${id} has no driver on the way at ${clock(tickNow())} (${LABEL[state].toLowerCase()}). Pick a trip that is on track, at risk or late, or move the shift time.`, true);
      return;
    }
    stop();
    app.edits.push({ trip_id: id, kind, at });
    rebuild(true);
    say('disrupt-status', `${id}: ${CHANGE[kind]} from ${clock(tickNow())}. Press Play to watch the check react.`);
  });
  $('undo').addEventListener('click', () => {
    const edit = app.edits.pop();
    rebuild(true);
    say('disrupt-status', `Undone: ${edit.trip_id}, ${CHANGE[edit.kind]}.`);
  });
  $('reset').addEventListener('click', () => {
    app.edits = [];
    app.actions.clear();
    rebuild(false);
    say('disrupt-status', 'The demo is back to the original shift.');
  });

  $('alert-list').addEventListener('input', (event) => {
    if (event.target.matches('textarea')) app.actions.get(event.target.closest('li').dataset.key).pending = event.target.value;
  });
  $('alert-list').addEventListener('click', (event) => {
    const button = event.target.closest('button[data-act]');
    if (!button) return;
    const key = button.closest('li').dataset.key;
    const act = app.actions.get(key) || {};
    app.actions.set(key, act);
    const tick = tickNow();
    const what = button.dataset.act;
    if (what === 'approve' || what === 'discard') Object.assign(act, { draft: what === 'approve' ? 'approved' : 'discarded', draftTick: tick });
    if (what === 'handle') act.handledTick = tick;
    if (what === 'edit') { stop(); act.editing = true; }
    if (what === 'cancel') { act.editing = false; delete act.pending; }
    if (what === 'save') {
      const text = (act.pending ?? act.text ?? '').trim();
      if (!text) { say('alerts-status', 'The text for the rider is empty. Write something, or press Cancel.', true); return; }
      Object.assign(act, { text, editing: false });
      delete act.pending;
    }
    say('alerts-status', '');
    render();
    renderShift();
    const card = document.querySelector(`#alert-list li[data-key="${CSS.escape(key)}"]`);
    if (card) (what === 'edit' ? card.querySelector('textarea') : card).focus();
  });

  $('files-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const trips = $('trips-file').files[0];
    const updates = $('updates-file').files[0];
    if (!trips || !updates) { say('files-status', 'Choose both files first.', true); return; }
    if (trips.size > MAX_FILE || updates.size > MAX_FILE) { say('files-status', 'Each file must be 2 MB or smaller.', true); return; }
    try {
      const loaded = window.Engine.load(await trips.text(), await updates.text());
      if (!loaded.trips.size) {
        const first = loaded.rejected.find((r) => r.file === 'trips.csv');
        throw new Error(`No usable trips in ${trips.name}.${first ? ` Line ${first.line}: ${first.reason}.` : ' Is it empty?'}`);
      }
      if (loaded.trips.size > MAX_TRIPS) throw new Error(`The demo shows up to ${MAX_TRIPS} trips; ${trips.name} has ${loaded.trips.size}.`);
      const all = [...loaded.trips.values()];
      const first = Math.min(...all.map((t) => t.window_start));
      const last = Math.max(...all.map((t) => Math.max(t.window_end, ...t.updates.map((u) => u.at))));
      if (last - first > 24 * 60) throw new Error('These files cover more than 24 hours. The demo replays one shift.');
      setBase({ trips: loaded.trips, rejected: loaded.rejected, sample: false, names: `${trips.name} and ${updates.name}` });
      const used = all.reduce((n, t) => n + t.updates.length, 0);
      const n = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;
      const bad = loaded.rejected.length;
      say('files-status', `Loaded ${n(loaded.trips.size, 'trip')} and ${n(used, 'driver update')}. `
        + (bad ? `${n(bad, 'row')} ${bad === 1 ? 'was' : 'were'} rejected and ${bad === 1 ? 'is' : 'are'} listed at the bottom of the page.` : 'Every row loaded.'));
    } catch (err) {
      say('files-status', err.message, true);
    }
  });
  $('use-sample').addEventListener('click', () => {
    setBase(sampleBase());
    say('files-status', 'Back to the sample shift.');
  });
}

function sampleBase() {
  const { trips, rejected } = window.Engine.load(window.SAMPLE_FILES['trips.csv'], window.SAMPLE_FILES['updates.csv']);
  return { trips, rejected, sample: true, names: 'sample files' };
}

function start() {
  if (!window.Engine || !window.SAMPLE_FILES) {
    $('load-error').hidden = false;
    $('counts').textContent = 'No shift loaded.';
    return;
  }
  [['get-trips', 'trips.csv'], ['get-updates', 'updates.csv']].forEach(([id, name]) => {
    $(id).href = URL.createObjectURL(new Blob([window.SAMPLE_FILES[name]], { type: 'text/csv' }));
  });
  wire();
  setBase(sampleBase());
  document.querySelectorAll('.clock button, .clock input, .clock select').forEach((control) => { control.disabled = false; });
}

document.addEventListener('DOMContentLoaded', start);
