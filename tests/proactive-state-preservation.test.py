"""Synthetic state/file regressions; no API, model, QQ, or server access.

These checks do not establish that a native proactive timer has fired or that
any real message has been received.
"""
import contextlib
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import types
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).resolve().parents[1] / 'deployment' / 'set-proactive.py'
SPEC = importlib.util.spec_from_file_location('qqai_set_proactive', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def snapshot(**changes):
    value = {'day': 'Sat Oct 31 2026', 'count': 17, 'nextAt': 4_000_000,
             'last': 2_000_000, 'nudgedFor': 1_000_000,
             'futureNativeField': {'preserve': True}}
    value.update(changes)
    return {'value': value, 'uid': 1001, 'gid': 1001, 'mode': 0o600}


class StatePreservation(unittest.TestCase):
    def test_same_day_count_seventeen_is_preserved_and_reset_is_rejected(self):
        before = snapshot()
        result = MODULE.verify_state_transition(before, copy.deepcopy(before))
        self.assertFalse(result['counterResetByScript'])
        self.assertFalse(result['nativeDayRolloverObserved'])
        self.assertEqual(before['value']['count'], 17)
        for count in (0, 16, 18):
            with self.subTest(changed_count=count), self.assertRaises(ValueError):
                MODULE.verify_state_transition(before, snapshot(count=count))

    def test_only_next_deadline_changes_are_accepted(self):
        before = snapshot()
        for deadline in (0, 9_000_000):
            with self.subTest(nextAt=deadline):
                after = snapshot(nextAt=deadline)
                result = MODULE.verify_state_transition(before, after)
                self.assertTrue(result['otherStateFieldsPreserved'])
                self.assertEqual(after['value']['count'], 17)
                self.assertEqual(before['value']['nextAt'], 4_000_000)

    def test_last_nudge_or_unknown_field_changes_are_rejected(self):
        before = snapshot()
        for key in ('last', 'nudgedFor', 'futureNativeField'):
            for operation in ('replace', 'remove'):
                after = snapshot(nextAt=0)
                if operation == 'replace':
                    after['value'][key] = 0
                else:
                    after['value'].pop(key)
                with self.subTest(field=key, operation=operation), self.assertRaises(ValueError):
                    MODULE.verify_state_transition(before, after)

    def test_native_new_day_reset_is_separately_marked(self):
        class FixtureDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                value = cls(2026, 10, 31, 6, 0, tzinfo=dt.timezone.utc)
                return value.astimezone(tz) if tz else value.replace(tzinfo=None)

        before = snapshot(day='Fri Oct 30 2026')
        after = snapshot(count=0, nextAt=9_000_000)
        with patch.object(MODULE, 'dt', types.SimpleNamespace(datetime=FixtureDateTime)):
            result = MODULE.verify_state_transition(before, after)
            self.assertTrue(result['nativeDayRolloverObserved'])
            self.assertFalse(result['counterResetByScript'])
            for invalid in (snapshot(day='Sun Nov 01 2026', count=0), snapshot(count=17)):
                with self.subTest(invalid=invalid['value']), self.assertRaises(ValueError):
                    MODULE.verify_state_transition(before, invalid)

    def test_atomic_deadline_edit_preserves_file_owner_mode_and_other_fields(self):
        with tempfile.TemporaryDirectory(prefix='qqai-proactive-unit-') as directory:
            path = Path(directory) / 'speakup.json'
            path.write_bytes(MODULE.encoded(snapshot()['value']))
            path.chmod(0o640)
            before = MODULE.read_file(path)
            updated = {**before['value'], 'nextAt': 0}
            MODULE.atomic_write(path, MODULE.encoded(updated), uid=before['uid'],
                                gid=before['gid'], mode=before['mode'])
            after = MODULE.read_file(path)
            self.assertEqual(after['value'], updated)
            self.assertEqual(after['value']['count'], 17)
            self.assertEqual(after['mode'], 0o640)
            for key in ('uid', 'gid', 'mode'):
                self.assertEqual(after[key], before[key])
            self.assertTrue(MODULE.verify_state_transition(before, after)['ownerAndModePreserved'])
            self.assertEqual(list(Path(directory).iterdir()), [path])
            for key in ('uid', 'gid', 'mode'):
                altered = {**after, key: after[key] + 1}
                with self.subTest(changed_metadata=key), self.assertRaises(ValueError):
                    MODULE.verify_state_transition(before, altered)

    def test_absent_state_stays_absent_during_configuration_transaction(self):
        # Exercise the actual transaction's absent-file branch with an in-memory
        # transport. All paths are temporary; importing the live inspector or
        # attempting a real urllib request immediately fails this test.
        with tempfile.TemporaryDirectory(prefix='qqai-proactive-unit-') as directory:
            root = Path(directory)
            config_path, state_path = root / 'config.json', root / 'speakup.json'
            fixture = {
                'enabled': True, 'dryRun': False, 'ownerQQ': 'synthetic-owner',
                'speakUp': {**MODULE.TARGET, 'enabled': False, 'maxPerDay': 4},
                'modules': {'purpose': {'enabled': False}}, 'ext': {},
                'privateFixture': 'must-stay-unchanged',
            }
            config_path.write_bytes(MODULE.encoded(fixture))
            config_path.chmod(0o600)
            requested = []
            private_records = {}

            def current_state(_opener, path):
                self.assertEqual(path, '/aurabot/api/state')
                return {'ok': True, 'config': copy.deepcopy(fixture), 'modules': [
                    {'id': 'purpose', 'enabled': False, 'running': None},
                    {'id': 'speakup', 'enabled': True, 'running': 'builtin'},
                ]}

            def synthetic_save(request, timeout):
                self.assertEqual(request.full_url, 'http://127.0.0.1:3080/aurabot/api/save')
                self.assertEqual(request.get_method(), 'POST')
                body = json.loads(request.data)
                self.assertEqual(body, {'speakUp': MODULE.TARGET})
                requested.append(body)
                fixture['speakUp'].update(body['speakUp'])
                config_path.write_bytes(MODULE.encoded(fixture))
                return io.BytesIO(b'{"ok": true}')

            opener = types.SimpleNamespace(open=synthetic_save)
            helper = types.SimpleNamespace(ORIGIN='http://127.0.0.1:3080',
                                           connect=lambda: opener, fetch_json=current_state)

            def record(_directory, name, value, *, raw=False):
                private_records[name] = value if raw else copy.deepcopy(value)

            output = io.StringIO()
            previous_umask = os.umask(0o077)
            try:
                with contextlib.ExitStack() as stack:
                    stack.enter_context(patch.object(MODULE.os, 'geteuid', return_value=0))
                    stack.enter_context(patch.object(MODULE, 'private_record_dir', return_value=root))
                    stack.enter_context(patch.object(MODULE, 'save_private', side_effect=record))
                    stack.enter_context(patch.object(MODULE, 'CONFIG_FILE', config_path))
                    stack.enter_context(patch.object(MODULE, 'STATE_FILE', state_path))
                    stack.enter_context(patch.object(MODULE, 'inspector', return_value=helper))
                    writer = stack.enter_context(patch.object(MODULE, 'atomic_write',
                        side_effect=AssertionError('missing state must not be written')))
                    stack.enter_context(patch.object(MODULE.urllib.request.OpenerDirector, 'open',
                        side_effect=AssertionError('network is forbidden in this unit test')))
                    stack.enter_context(patch('sys.argv', [str(SCRIPT), '--record-dir', str(root)]))
                    stack.enter_context(contextlib.redirect_stdout(output))
                    self.assertEqual(MODULE.main(), 0)
                    writer.assert_not_called()
            finally:
                os.umask(previous_umask)
            self.assertFalse(state_path.exists())
            self.assertEqual(len(requested), 1)
            result = private_records['result.json']
            self.assertFalse(result['stateWriteAttempted'])
            self.assertFalse(result['statePreservation']['stateExistedBefore'])
            self.assertFalse(result['statePreservation']['scriptCreatedState'])
            self.assertFalse(result['nativeDeadlineObserved'])
            self.assertTrue(result['otherDiskConfigUnchanged'])
            self.assertTrue(json.loads(output.getvalue())['ok'])
            self.assertNotIn('synthetic-owner', output.getvalue())
            self.assertNotIn('must-stay-unchanged', output.getvalue())


if __name__ == '__main__':
    unittest.main()
