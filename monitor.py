"""Late-trip monitor: flags pickups at risk of running late from driver app updates.

Fictional reference build. All times are local (Pacific) times for a single shift.
"""
import argparse
import csv
from datetime import datetime, timedelta
import json
from pathlib import Path
import sqlite3
import sys

ROOT = Path(__file__).parent
FMT = '%Y-%m-%d %H:%M'
STALE = timedelta(minutes=15)  # no update from the driver for this long -> "unknown", never "late"
LEAD = timedelta(minutes=30)   # drivers should be reporting this long before the pickup window opens
STEP = timedelta(minutes=5)    # how often the scheduled check runs
STATUSES = {'en_route', 'arrived', 'picked_up', 'dropped_off', 'no_show', 'cancelled'}
SETTLED = STATUSES - {'en_route'}
CONTACT = ('arrived', 'picked_up', 'dropped_off', 'no_show')  # each proves the driver reached the rider by then
ALERTS = ('at_risk', 'late', 'unknown')
TRIP_FIELDS = ('trip_id', 'rider_ref', 'purpose', 'mobility', 'zone', 'desk', 'driver_id', 'window_start', 'window_end')
UPDATE_FIELDS = ('at', 'trip_id', 'driver_id', 'status')


def parse_time(text):
    try:
        return datetime.strptime(text, FMT)
    except (TypeError, ValueError):
        raise ValueError(f'time {text!r} is not YYYY-MM-DD HH:MM') from None


def hm(when):
    return when.strftime('%H:%M')


def read_rows(path, fields):
    """Yield (line, row, error) for each CSV row; a row with a missing field gets an error."""
    with path.open(newline='', encoding='utf-8') as file:
        for line, row in enumerate(csv.DictReader(file), start=2):
            missing = [name for name in fields if not (row.get(name) or '').strip()]
            yield line, row, f'missing {", ".join(missing)}' if missing else None


def load(folder):
    """Read trips.csv and updates.csv. Bad rows are listed in `rejected`; good rows still load."""
    trips, rejected = {}, []

    def reject(file, line, reason):
        rejected.append({'file': file, 'line': line, 'reason': reason})

    for line, row, error in read_rows(folder / 'trips.csv', TRIP_FIELDS):
        try:
            if error:
                raise ValueError(error)
            if row['trip_id'] in trips:
                raise ValueError(f'trip {row["trip_id"]} is listed twice')
            start, end = parse_time(row['window_start']), parse_time(row['window_end'])
            if end <= start:
                raise ValueError('pickup window ends before it starts')
        except ValueError as exc:
            reject('trips.csv', line, str(exc))
            continue
        trips[row['trip_id']] = {**{k: row[k] for k in TRIP_FIELDS}, 'window_start': start, 'window_end': end, 'updates': []}

    for line, row, error in read_rows(folder / 'updates.csv', UPDATE_FIELDS):
        try:
            if error:
                raise ValueError(error)
            trip = trips.get(row['trip_id'])
            if trip is None:
                raise ValueError(f'unknown trip {row["trip_id"]}')
            if row['driver_id'] != trip['driver_id']:
                raise ValueError(f'driver {row["driver_id"]} is not assigned to {row["trip_id"]}')
            if row['status'] not in STATUSES:
                raise ValueError(f'unknown status {row["status"]!r}')
            if row['status'] == 'en_route' and not row.get('eta'):
                raise ValueError('en_route update has no ETA')
            update = {'at': parse_time(row['at']), 'status': row['status'],
                      'eta': parse_time(row['eta']) if row['status'] == 'en_route' else None}
        except ValueError as exc:
            reject('updates.csv', line, str(exc))
            continue
        trip['updates'].append(update)

    for trip in trips.values():
        trip['updates'].sort(key=lambda u: u['at'])
    return trips, rejected


def arrival(trip, now=None):
    """Return (time, minutes late) when the driver's arrival is known, or (None, None)."""
    contact = next((u for u in trip['updates'] if u['status'] in CONTACT and (now is None or u['at'] <= now)), None)
    if contact is None:
        return None, None
    late = int((contact['at'] - trip['window_end']).total_seconds() // 60)
    if contact['status'] in ('arrived', 'no_show') or late <= 0:
        return contact['at'], max(late, 0)
    return None, None  # first sign of the driver came after the window, but the arrival itself wasn't recorded


def state_at(trip, now):
    """Return (state, reason) for a trip, using only the updates received by `now`."""
    seen = [u for u in trip['updates'] if u['at'] <= now]
    last = seen[-1] if seen else None
    start, end = trip['window_start'], trip['window_end']
    if last and last['status'] in SETTLED:
        if last['status'] == 'cancelled':
            return 'cancelled', f'Cancelled at {hm(last["at"])}'
        when, late = arrival(trip, now)
        if when is None:
            got = 'Arrival time not recorded'
        else:
            got = f'Arrived {hm(when)}, ' + (f'{late} min after the window' if late else 'on time')
        return last['status'], got
    if last is None or now - last['at'] > STALE:
        if now < start - LEAD:
            return 'scheduled', f'Window {hm(start)}-{hm(end)}'
        since = f'since {hm(last["at"])}' if last else 'yet'
        return 'unknown', f'No update from driver {trip["driver_id"]} {since}'
    if now > end:
        return 'late', f'Window closed {hm(end)}; driver ETA {hm(last["eta"])}'
    if last['eta'] > end:
        return 'at_risk', f'Driver ETA {hm(last["eta"])} is after the window closes at {hm(end)}'
    return 'on_track', f'Driver ETA {hm(last["eta"])}'


def rider_text(eta):
    return (f'Hi, this is your ride service. Your driver is running late and should arrive around {hm(eta)}. '
            'Reply to this message or call us if you need to change your trip.')


def open_log(path):
    db = sqlite3.connect(path)
    # One alert per trip and kind, enforced by the primary key, so a re-run never repeats an alert.
    db.execute('CREATE TABLE IF NOT EXISTS alerts (trip_id TEXT, kind TEXT, at TEXT, desk TEXT, driver_id TEXT,'
               ' reason TEXT, rider_text TEXT, PRIMARY KEY (trip_id, kind))')
    return db


def check(db, trips, now):
    """The scheduled job: record and return the alerts that are new at `now`."""
    new = []
    with db:
        for trip in trips.values():
            state, reason = state_at(trip, now)
            if state not in ALERTS:
                continue
            eta = next(u['eta'] for u in reversed(trip['updates']) if u['at'] <= now) if state != 'unknown' else None
            alert = {'trip_id': trip['trip_id'], 'kind': state, 'at': now.strftime(FMT), 'desk': trip['desk'],
                     'driver_id': trip['driver_id'], 'reason': reason, 'rider_text': rider_text(eta) if eta else None}
            if db.execute('INSERT OR IGNORE INTO alerts VALUES (:trip_id, :kind, :at, :desk, :driver_id, :reason, :rider_text)',
                          alert).rowcount:
                new.append(alert)
    return new


def summarize(trips, alerts):
    """End-of-shift numbers, including how well the alerts did."""
    warned = {a['trip_id']: parse_time(a['at']) for a in alerts if a['kind'] == 'at_risk'}
    on_time = late = unrecorded = 0
    minutes_late, warnings = [], []
    missed = false_alarms = 0
    for trip in trips.values():
        status = trip['updates'][-1]['status'] if trip['updates'] else None
        if status == 'cancelled':
            continue
        when, by = arrival(trip)
        if when is None:
            unrecorded += 1
        elif by:
            late += 1
            minutes_late.append(by)
            if trip['trip_id'] in warned:
                warnings.append((trip['window_end'] - warned[trip['trip_id']]).total_seconds() / 60)
            else:
                missed += 1
        else:
            on_time += 1
            false_alarms += trip['trip_id'] in warned
    kinds = [a['kind'] for a in alerts]
    return {
        'trips': len(trips),
        'cancelled': sum(t['updates'][-1]['status'] == 'cancelled' for t in trips.values() if t['updates']),
        'no_shows': sum(t['updates'][-1]['status'] == 'no_show' for t in trips.values() if t['updates']),
        'on_time': on_time, 'late': late, 'arrival_not_recorded': unrecorded,
        'on_time_rate': round(100 * on_time / (on_time + late)) if on_time + late else None,
        'average_minutes_late': round(sum(minutes_late) / len(minutes_late)) if minutes_late else 0,
        'alerts': {kind: kinds.count(kind) for kind in ALERTS},
        'late_with_warning': len(warnings), 'late_without_warning': missed,
        'average_warning_minutes': round(sum(warnings) / len(warnings)) if warnings else 0,
        'at_risk_but_on_time': false_alarms,
    }


def replay(folder):
    """Run the check every STEP minutes across the whole shift and collect what the dashboard shows."""
    trips, rejected = load(folder)
    start = min(t['window_start'] - LEAD for t in trips.values()).replace(minute=0)
    end = max([u['at'] for t in trips.values() for u in t['updates']] + [t['window_end'] for t in trips.values()])
    end = (end + timedelta(hours=1)).replace(minute=0)
    db, alerts, changes = open_log(':memory:'), [], {trip_id: [] for trip_id in trips}
    tick, now = 0, start
    while now <= end:
        for trip_id, trip in trips.items():
            current = list(state_at(trip, now))
            if not changes[trip_id] or changes[trip_id][-1][1:] != current:
                changes[trip_id].append([tick] + current)
        alerts += [dict(alert, tick=tick) for alert in check(db, trips, now)]
        tick, now = tick + 1, now + STEP
    db.close()
    rows = [{**{k: trip[k] for k in TRIP_FIELDS}, 'window_start': hm(trip['window_start']),
             'window_end': hm(trip['window_end']), 'changes': changes[trip_id]} for trip_id, trip in trips.items()]
    return {'fictional': True, 'shift_date': start.strftime('%Y-%m-%d'), 'start': start.strftime(FMT),
            'step_minutes': int(STEP.total_seconds() // 60), 'ticks': tick, 'trips': rows, 'alerts': alerts,
            'rejected': rejected, 'summary': summarize(trips, alerts)}


def dashboard_js(data):
    return 'window.MONITOR_DATA = ' + json.dumps(data, indent=1, ensure_ascii=False) + ';\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--files', type=Path, default=ROOT / 'samples', help='folder with trips.csv and updates.csv')
    commands = parser.add_subparsers(dest='command', required=True)
    run = commands.add_parser('check', help='record and print new alerts, as the 5-minute job would')
    run.add_argument('--at', help='check time, YYYY-MM-DD HH:MM (default: now)')
    run.add_argument('--db', type=Path, default=ROOT / 'output' / 'alerts.sqlite')
    commands.add_parser('build', help='replay the shift and write docs/data.js for the dashboard')
    args = parser.parse_args(argv)
    try:
        if args.command == 'build':
            data = replay(args.files)
            (ROOT / 'docs' / 'data.js').write_text(dashboard_js(data), encoding='utf-8', newline='\n')
            s = data['summary']
            print(f'Wrote docs/data.js: {s["trips"]} trips, {s["on_time_rate"]}% on time, '
                  f'{sum(s["alerts"].values())} alerts, {len(data["rejected"])} rejected rows.')
            return 0
        trips, rejected = load(args.files)
        now = parse_time(args.at) if args.at else datetime.now().replace(second=0, microsecond=0)
        args.db.parent.mkdir(parents=True, exist_ok=True)
        db = open_log(args.db)
        try:
            new = check(db, trips, now)
        finally:
            db.close()
        for alert in new:
            print(f'{alert["at"][11:]}  {alert["kind"]:8} {alert["trip_id"]}  {alert["desk"]}: {alert["reason"]}')
        print(f'{len(new)} new alert(s); {len(rejected)} rejected row(s). Nothing was sent to riders.')
        return 0
    except (OSError, ValueError, sqlite3.Error) as exc:
        print(f'Error: {exc}', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
