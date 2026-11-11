"""Write the fictional sample shift to samples/trips.csv and samples/updates.csv.

Every rider, driver and zone is made up. The seed is fixed, so the files are the same on every run.
"""
import csv
from datetime import datetime, timedelta
from pathlib import Path
import random

DAY = datetime(2026, 11, 10)
DESKS = {'North': 'North desk', 'Central': 'Central desk', 'South': 'South desk'}
FMT = '%Y-%m-%d %H:%M'

# One scenario per trip, in window order. Most trips go to plan.
SCENARIOS = (['on_time'] * 20 + ['recovered'] * 2 + ['late'] * 3 + ['late_sudden']
             + ['stale_recovers'] * 2 + ['no_arrival_record'] + ['no_show'] * 2 + ['cancelled'])


def minutes(n):
    return timedelta(minutes=n)


def updates_for(kind, trip, rng):
    ws = datetime.strptime(trip['window_start'], FMT)
    we = datetime.strptime(trip['window_end'], FMT)
    driver = trip['driver_id']
    rows = []

    def add(at, status, eta=None):
        rows.append({'at': at.strftime(FMT), 'trip_id': trip['trip_id'], 'driver_id': driver,
                     'status': status, 'eta': eta.strftime(FMT) if eta else ''})

    def drive(start, stop, eta_at):
        """Driver app sends an ETA every 5 minutes from start until stop."""
        at = start
        while at < stop:
            add(at, 'en_route', eta_at(at))
            at += minutes(5)

    def finish(arrived, record_arrival=True, no_show=False):
        if record_arrival:
            add(arrived, 'arrived')
        if no_show:
            add(arrived + minutes(10), 'no_show')
            return
        picked = arrived + minutes(rng.randint(2, 6))
        add(picked, 'picked_up')
        add(picked + minutes(rng.randint(15, 35)), 'dropped_off')

    dispatch = ws - minutes(40)
    if kind == 'cancelled':
        add(ws - minutes(90), 'cancelled')
    elif kind in ('on_time', 'no_show'):
        arrive = ws + minutes(rng.randint(0, 20))
        drive(dispatch, arrive, lambda at: arrive + minutes(rng.randint(-2, 3)))
        finish(arrive, no_show=kind == 'no_show')
    elif kind == 'recovered':
        arrive = ws + minutes(rng.randint(18, 26))
        slow = we + minutes(rng.randint(5, 12))
        drive(dispatch, arrive, lambda at: slow if at < dispatch + minutes(15) else arrive)
        finish(arrive)
    elif kind == 'late':
        arrive = we + minutes(rng.randint(8, 20))
        drive(dispatch, arrive, lambda at: ws + minutes(20) if at < ws + minutes(5) else arrive)
        finish(arrive)
    elif kind == 'late_sudden':
        # The delay is only reported after the window has closed, so no early warning is possible.
        arrive = we + minutes(15)
        drive(dispatch, arrive, lambda at: we - minutes(2) if at <= we else arrive)
        finish(arrive)
    elif kind == 'stale_recovers':
        arrive = ws + minutes(12)
        drive(dispatch, ws - minutes(20), lambda at: arrive)
        drive(ws + minutes(5), arrive, lambda at: arrive)
        finish(arrive)
    elif kind == 'no_arrival_record':
        # The driver app stops reporting; the trip is later closed without an arrival time.
        drive(dispatch, ws - minutes(15), lambda at: ws + minutes(5))
        add(ws + minutes(50), 'dropped_off')
    return rows


def make(folder):
    rng = random.Random(9)
    trips = []
    for d in range(8):
        for k in range(4):
            ws = DAY.replace(hour=6) + minutes(5 * d + 100 * k)
            zone = rng.choice(list(DESKS))
            trips.append({'window_start': ws.strftime(FMT), 'window_end': (ws + minutes(30)).strftime(FMT),
                          'driver_id': f'D-{d + 1:02d}', 'zone': zone, 'desk': DESKS[zone],
                          'rider_ref': f'R-{rng.randint(1000, 9999)}',
                          'purpose': rng.choice(['Dialysis', 'Dialysis', 'Clinic visit', 'Therapy', 'Hospital discharge']),
                          'mobility': rng.choices(['Ambulatory', 'Wheelchair', 'Stretcher'], [6, 3, 1])[0]})
    trips.sort(key=lambda t: (t['window_start'], t['driver_id']))
    kinds = SCENARIOS[:]
    rng.shuffle(kinds)
    updates = []
    for n, (trip, kind) in enumerate(zip(trips, kinds), start=1001):
        trip['trip_id'] = f'T-{n}'
        updates += updates_for(kind, trip, rng)

    # Rows with deliberate mistakes; the monitor must reject them and keep going.
    first = trips[0]
    trips.append(dict(first, trip_id='T-1099', window_end='2026-11-10 05:00'))
    updates += [
        {'at': '2026-11-10 07:00', 'trip_id': 'T-9999', 'driver_id': 'D-01', 'status': 'en_route', 'eta': '2026-11-10 07:20'},
        {'at': '2026-11-10 07:05', 'trip_id': first['trip_id'], 'driver_id': 'D-08', 'status': 'en_route', 'eta': '2026-11-10 07:25'},
        {'at': '2026-11-10 07:10', 'trip_id': first['trip_id'], 'driver_id': first['driver_id'], 'status': 'enroute', 'eta': ''},
        {'at': '2026-11-10 07:15', 'trip_id': first['trip_id'], 'driver_id': first['driver_id'], 'status': 'en_route', 'eta': ''},
    ]
    updates.sort(key=lambda u: u['at'])

    folder.mkdir(exist_ok=True)
    fields = ['trip_id', 'rider_ref', 'purpose', 'mobility', 'zone', 'desk', 'driver_id', 'window_start', 'window_end']
    for name, rows, columns in (('trips.csv', trips, fields), ('updates.csv', updates, ['at', 'trip_id', 'driver_id', 'status', 'eta'])):
        with (folder / name).open('w', newline='', encoding='utf-8') as file:
            writer = csv.DictWriter(file, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
    return len(trips), len(updates)


if __name__ == '__main__':
    print('Wrote %d trips and %d updates.' % make(Path(__file__).parent / 'samples'))
