"""Sanitization fixtures only; no network, service reads, or real QQ state."""
import importlib.util
import json
import pathlib
import unittest
from unittest.mock import patch

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / 'scripts' / 'inspect-qq-runtime.py'
SPEC = importlib.util.spec_from_file_location('qq_runtime_inspector', SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)
SECRET = 'synthetic-secret-do-not-publish'


class Privacy(unittest.TestCase):
    def test_only_aggregate_allowlisted_fields_are_returned(self):
        fixture = {
            'config': {'enabled': True, 'dryRun': False, 'ownerQQ': '1234567890', 'botQQ': '9876543210',
                       'secret': SECRET, 'allow': {'private': [], 'groups': []}, 'speakUp': {'enabled': True}},
            'onebot': {'state': 'connected', 'login': {'uin': '9876543210', 'nickname': SECRET}, 'problem': SECRET},
            'stats': {'received': 2, 'sent': 3, 'errors': SECRET, 'private': SECRET},
            'speakUp': {'count': 1, 'nextAt': 100, 'last': 90, 'nudgedFor': 80, 'text': SECRET},
            'memory': {'lastConsolidate': {'at': 20, 'added': 1, 'pending': 0, 'failed': 0, 'text': SECRET}},
            'modules': [{'id': 'memory', 'enabled': True, 'running': 'builtin', 'error': SECRET},
                        {'id': SECRET, 'enabled': True}],
            'sessions': [{'sessionId': SECRET, 'chat': SECRET}],
        }
        with patch.object(MODULE, 'connect', return_value=None), patch.object(MODULE, 'fetch_json', return_value=fixture):
            output = MODULE.inspect()
        rendered = json.dumps(output)
        self.assertNotIn(SECRET, rendered)
        self.assertNotIn('1234567890', rendered)
        self.assertNotIn('9876543210', rendered)
        self.assertTrue(output['botIdentityMatches'])
        self.assertEqual(output['speakUp']['last'], 90)
        self.assertEqual(output['speakUp']['nudgedFor'], 80)
        self.assertIsNone(output['stats']['errors'])
        self.assertEqual(len(output['modules']), 1)

    def test_nonfinite_or_non_numeric_metadata_is_rejected(self):
        for value in [True, False, float('nan'), float('inf'), SECRET, {'text': SECRET}]:
            self.assertIsNone(MODULE.number(value))
        self.assertEqual(MODULE.number(1), 1)


if __name__ == '__main__':
    unittest.main()
