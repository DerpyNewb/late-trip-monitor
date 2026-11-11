'use strict';

const LABEL = {
  scheduled: 'Not started', on_track: 'On track', at_risk: 'At risk', late: 'Late', unknown: 'No recent update',
  arrived: 'Driver arrived', picked_up: 'Rider on board', dropped_off: 'Completed', no_show: 'No-show', cancelled: 'Cancelled',
};
const ATTENTION = ['late', 'unknown', 'at_risk'];
const DONE = ['arrived', 'picked_up', 'dropped_off', 'no_show'];
const $ = (id) => document.getElementById(id);

function el(tag, attrs, ...children) {
  const node = document.createElement(tag);
  Object.entries(attrs || {}).forEach(([key, value]) => { node[key] = value; });
  children.forEach((child) => node.append(child));
  return node;
}

function start() {
  const data = window.MONITOR_DATA;
  if (!data || !Array.isArray(data.trips)) {
    $('load-error').hidden = false;
    $('counts').textContent = 'No shift loaded.';
    return;
  }
  const [hours, minutes] = data.start.slice(11).split(':').map(Number);
  const clock = (tick) => {
    const total = hours * 60 + minutes + tick * data.step_minutes;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  };
  const stateAt = (trip, tick) => {
    let current = trip.changes[0];
    for (const change of trip.changes) { if (change[0] <= tick) current = change; else break; }
    return { state: current[1], reason: current[2] };
  };
  const attentionCount = (tick) => data.trips.filter((t) => ATTENTION.includes(stateAt(t, tick).state)).length;

  let busiest = 0;
  let most = -1;
  for (let tick = 0; tick < data.ticks; tick += 1) {
    const n = attentionCount(tick);
    if (n > most) { busiest = tick; most = n; }
  }

  const slider = $('time');
  slider.max = data.ticks - 1;
  slider.value = busiest;
  $('shift-date').textContent = new Date(`${data.shift_date}T12:00`).toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
  [...new Set(data.trips.map((t) => t.desk))].sort().forEach((desk) => $('desk').append(el('option', { value: desk, textContent: desk })));
  document.querySelectorAll('.clock button, .clock input, .clock select').forEach((control) => { control.disabled = false; });

  const tripCell = (trip) => el('td', {}, el('strong', { textContent: trip.trip_id }), el('small', { textContent: `Rider ${trip.rider_ref}` }));
  const stateCell = (state) => el('td', {}, el('span', { className: `state ${state}`, textContent: LABEL[state] }));

  function render() {
    const tick = Number(slider.value);
    const desk = $('desk').value;
    const time = clock(tick);
    const trips = data.trips.filter((t) => !desk || t.desk === desk).map((t) => ({ ...t, ...stateAt(t, tick) }));
    $('time-out').textContent = time;
    slider.setAttribute('aria-valuetext', time);
    document.querySelectorAll('.at').forEach((node) => { node.textContent = time; });

    const count = (states) => trips.filter((t) => states.includes(t.state)).length;
    $('counts').textContent = `${desk || 'All desks'} at ${time}: ${count(['late'])} late, ${count(['unknown'])} with no recent update, `
      + `${count(['at_risk'])} at risk, ${count(['on_track'])} on track, ${count(DONE)} arrived or done, `
      + `${count(['scheduled'])} not started, ${count(['cancelled'])} cancelled.`;

    const urgent = trips.filter((t) => ATTENTION.includes(t.state))
      .sort((a, b) => ATTENTION.indexOf(a.state) - ATTENTION.indexOf(b.state) || a.window_end.localeCompare(b.window_end));
    $('attention-rows').replaceChildren(...urgent.map((t) => el('tr', { className: `row-${t.state}` },
      stateCell(t.state), tripCell(t), el('td', { textContent: `${t.window_start}-${t.window_end}` }),
      el('td', { textContent: t.reason }), el('td', { textContent: t.desk }))));
    $('attention-empty').hidden = urgent.length > 0;

    const alerts = data.alerts.filter((a) => a.tick <= tick && (!desk || a.desk === desk)).reverse();
    $('alert-list').replaceChildren(...alerts.map((a) => el('li', {},
      el('p', { className: 'alert-head' }, el('span', { className: `state ${a.kind}`, textContent: LABEL[a.kind] }),
        ` ${clock(a.tick)}, ${a.trip_id} to ${a.desk}`),
      el('p', { textContent: `${a.reason}. Driver ${a.driver_id}.` }),
      ...(a.rider_text ? [el('p', { className: 'draft' }, el('strong', { textContent: 'Draft for the rider, not sent: ' }), a.rider_text)] : []))));
    $('alerts-empty').hidden = alerts.length > 0;

    $('trip-rows').replaceChildren(...trips.map((t) => el('tr', { className: `row-${t.state}` },
      stateCell(t.state), tripCell(t), el('td', { textContent: `${t.window_start}-${t.window_end}` }),
      el('td', { textContent: t.reason }), el('td', { textContent: t.driver_id }), el('td', { textContent: t.desk }),
      el('td', { textContent: `${t.mobility}, ${t.purpose.toLowerCase()}` }))));
  }

  const s = data.summary;
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  $('results-figures').replaceChildren(
    el('p', {}, el('strong', { textContent: s.on_time_rate === null ? 'n/a' : `${s.on_time_rate}%` }), `of ${s.on_time + s.late} trips with a recorded arrival were on time`),
    el('p', {}, el('strong', { textContent: `${s.late_with_warning} of ${s.late}` }), `late arrivals were flagged at risk first, ${s.average_warning_minutes} minutes before the window closed on average`),
    el('p', {}, el('strong', { textContent: String(s.at_risk_but_on_time) }), `at-risk alerts were for trips that still arrived on time`));
  $('results-notes').replaceChildren(...[
    `The ${plural(s.late, 'late arrival')} averaged ${s.average_minutes_late} minutes after the window. `
      + `${s.late_without_warning} ${s.late_without_warning === 1 ? 'was' : 'were'} reported late only after the window had closed, so no early warning was possible.`,
    `${plural(s.arrival_not_recorded, 'trip')} closed without an arrival time; ${plural(s.no_shows, 'no-show')} and ${plural(s.cancelled, 'cancellation')} out of ${s.trips} trips.`,
    `${s.alerts.at_risk + s.alerts.late + s.alerts.unknown} alerts in all: ${s.alerts.at_risk} at risk, ${s.alerts.late} late and ${s.alerts.unknown} with no recent update. Messages sent to riders: 0.`,
  ].map((text) => el('li', { textContent: text })));
  $('rejected-list').replaceChildren(...data.rejected.map((r) => el('li', {}, el('code', { textContent: `${r.file}, line ${r.line}` }), `: ${r.reason}`)));

  let timer = null;
  const stop = () => { clearInterval(timer); timer = null; $('play').textContent = 'Play'; $('play').setAttribute('aria-pressed', 'false'); };
  $('play').addEventListener('click', () => {
    if (timer) { stop(); return; }
    if (Number(slider.value) >= data.ticks - 1) { slider.value = 0; render(); }
    $('play').textContent = 'Pause';
    $('play').setAttribute('aria-pressed', 'true');
    timer = setInterval(() => {
      slider.value = Number(slider.value) + 1;
      render();
      if (Number(slider.value) >= data.ticks - 1) stop();
    }, 350);
  });
  slider.addEventListener('input', () => { stop(); render(); });
  $('desk').addEventListener('change', render);
  $('busiest').addEventListener('click', () => { stop(); slider.value = busiest; render(); });
  $('end').addEventListener('click', () => { stop(); slider.value = data.ticks - 1; render(); });
  render();
}

document.addEventListener('DOMContentLoaded', start);
