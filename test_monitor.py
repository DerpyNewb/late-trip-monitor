import csv
from datetime import datetime
import json
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import make_sample
import monitor

ROOT = Path(__file__).parent


def at(hhmm):
    return datetime(2026, 11, 10, int(hhmm[:2]), int(hhmm[3:]))


def trip(*updates):
    """A 09:00-09:30 pickup window; updates are (time, status, eta)."""
    return {'trip_id': 'T-1', 'driver_id': 'D-01', 'desk': 'North desk', 'window_start': at('09:00'),
            'window_end': at('09:30'), 'updates': [{'at': at(t), 'status': s, 'eta': at(e) if e else None}
                                                    for t, s, e in updates]}


class StateRules(unittest.TestCase):
    def test_eta_decides_on_track_or_at_risk(self):
        self.assertEqual(monitor.state_at(trip(('08:40', 'en_route', '09:20')), at('08:45'))[0], 'on_track')
        self.assertEqual(monitor.state_at(trip(('08:40', 'en_route', '09:40')), at('08:45'))[0], 'at_risk')

    def test_late_only_after_the_window_with_a_fresh_update(self):
        t = trip(('09:25', 'en_route', '09:40'))
        self.assertEqual(monitor.state_at(t, at('09:30'))[0], 'at_risk')
        self.assertEqual(monitor.state_at(t, at('09:35'))[0], 'late')

    def test_silence_is_unknown_not_late(self):
        t = trip(('08:40', 'en_route', '09:10'))
        self.assertEqual(monitor.state_at(t, at('08:55'))[0], 'on_track')
        self.assertEqual(monitor.state_at(t, at('09:00'))[0], 'unknown')
        self.assertEqual(monitor.state_at(t, at('09:45'))[0], 'unknown')

    def test_no_updates_is_scheduled_until_the_lead_time(self):
        self.assertEqual(monitor.state_at(trip(), at('08:25'))[0], 'scheduled')
        self.assertEqual(monitor.state_at(trip(), at('08:30'))[0], 'unknown')

    def test_arrival_settles_the_trip(self):
        on_time = trip(('09:20', 'arrived', None), ('09:50', 'en_route', '10:00'))
        self.assertEqual(monitor.arrival(on_time), (at('09:20'), 0))
        self.assertEqual(monitor.arrival(trip(('09:42', 'arrived', None))), (at('09:42'), 12))
        # Picked up after the window with no arrival update: the arrival time is unknown, not late.
        self.assertEqual(monitor.arrival(trip(('09:42', 'picked_up', None))), (None, None))
        self.assertEqual(monitor.arrival(trip(('09:25', 'picked_up', None))), (at('09:25'), 0))


class Alerts(unittest.TestCase):
    def test_one_alert_per_trip_and_kind_across_runs(self):
        trips = {'T-1': trip(('08:40', 'en_route', '09:45'))}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'alerts.sqlite'
            db = monitor.open_log(path)
            first = monitor.check(db, trips, at('08:45'))
            self.assertEqual([a['kind'] for a in first], ['at_risk'])
            self.assertIn('09:45', first[0]['rider_text'])
            self.assertEqual(monitor.check(db, trips, at('08:50')), [])
            db.close()
            db = monitor.open_log(path)  # a new run of the scheduled job
            self.assertEqual(monitor.check(db, trips, at('08:50')), [])
            db.close()

    def test_unknown_alert_has_no_rider_text(self):
        db = monitor.open_log(':memory:')
        alert, = monitor.check(db, {'T-1': trip()}, at('08:40'))
        db.close()
        self.assertEqual((alert['kind'], alert['rider_text']), ('unknown', None))


class Files(unittest.TestCase):
    def test_bad_rows_are_rejected_and_good_rows_load(self):
        with tempfile.TemporaryDirectory() as folder:
            folder = Path(folder)
            with (folder / 'trips.csv').open('w', newline='') as file:
                rows = csv.writer(file)
                rows.writerow(monitor.TRIP_FIELDS)
                rows.writerow(['T-1', 'R-1', 'Dialysis', 'Wheelchair', 'North', 'North desk', 'D-01', '2026-11-10 09:00', '2026-11-10 09:30'])
                rows.writerow(['T-2', 'R-2', 'Dialysis', 'Wheelchair', 'North', 'North desk', 'D-02', '9 AM', '2026-11-10 09:30'])
            with (folder / 'updates.csv').open('w', newline='') as file:
                rows = csv.writer(file)
                rows.writerow(['at', 'trip_id', 'driver_id', 'status', 'eta'])
                rows.writerow(['2026-11-10 08:40', 'T-1', 'D-01', 'en_route', '2026-11-10 09:10'])
                rows.writerow(['2026-11-10 08:45', 'T-1', 'D-09', 'en_route', '2026-11-10 09:10'])
                rows.writerow(['2026-11-10 08:45', 'T-1', 'D-01', 'lost', ''])
                rows.writerow(['2026-11-10 08:45', 'T-1', 'D-01', 'en_route', ''])
                rows.writerow(['2026-11-10 08:45', 'T-2', 'D-02', 'en_route', '2026-11-10 09:10'])
                rows.writerow(['', 'T-1', 'D-01', 'arrived', ''])
            trips, rejected = monitor.load(folder)
        self.assertEqual(list(trips), ['T-1'])
        self.assertEqual(len(trips['T-1']['updates']), 1)
        self.assertEqual([r['line'] for r in rejected], [3, 3, 4, 5, 6, 7])
        self.assertIn('missing at', rejected[-1]['reason'])


class Sample(unittest.TestCase):
    def test_sample_shift(self):
        data = monitor.replay(ROOT / 'samples')
        s = data['summary']
        self.assertEqual((s['trips'], s['on_time'], s['late'], s['arrival_not_recorded']), (32, 26, 4, 1))
        self.assertEqual(s['alerts'], {'at_risk': 5, 'late': 4, 'unknown': 3})
        self.assertEqual((s['late_with_warning'], s['late_without_warning'], s['at_risk_but_on_time']), (3, 1, 2))
        self.assertEqual(len(data['rejected']), 5)

    def test_dashboard_embeds_the_current_samples(self):
        published = (ROOT / 'docs' / 'data.js').read_text(encoding='utf-8')
        self.assertEqual(published, make_sample.sample_js(ROOT / 'samples'), 'docs/data.js is stale: run python make_sample.py')

    @unittest.skipUnless(shutil.which('node'), 'Node.js is needed to run the browser version')
    def test_browser_version_matches_python(self):
        result = subprocess.run(['node', str(ROOT / 'docs' / 'engine.js'), str(ROOT / 'samples')],
                                capture_output=True, text=True, encoding='utf-8', check=True)
        browser, python = json.loads(result.stdout), monitor.replay(ROOT / 'samples')
        for key in ('start', 'ticks', 'trips', 'alerts', 'rejected', 'summary'):
            self.assertEqual(browser[key], python[key], key)


if __name__ == '__main__':
    unittest.main()
