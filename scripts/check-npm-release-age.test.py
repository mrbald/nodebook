import json
import unittest
from datetime import datetime, timezone
from importlib import import_module
from unittest.mock import patch

age = import_module("check-npm-release-age")


class ReleaseAgeTests(unittest.TestCase):
    def test_aliased_package_keeps_its_identity_when_moved(self):
        entry = {"name": "@org/lib", "version": "1.0.0",
                 "resolved": "https://registry.npmjs.org/@org/lib/-/lib-1.0.0.tgz"}

        def packages(path):
            return age.lockfile_packages(json.dumps({"lockfileVersion": 3, "packages": {path: entry}}))

        original = packages("node_modules/acme/node_modules/alias")
        self.assertEqual(original, packages("node_modules/alias"))
        self.assertEqual(age.registry_package(*original.pop()), ("@org/lib", "1.0.0"))
        with self.assertRaises(ValueError):
            age.registry_package("@org/lib", "1.0.0", "https://example.org/lib-1.0.0.tgz")

    def test_full_five_days_and_unpublished_version(self):
        now = datetime(2026, 11, 20, 12, tzinfo=timezone.utc)
        cutoff = now - age.minimum_age("min-release-age=5\n")
        times = {"1.0.0": "2026-11-15T12:00:00Z", "1.0.1": "2026-11-15T12:00:01Z"}
        with patch.object(age, "publication_times", return_value=times):
            self.assertEqual(age.check_packages({("lib", "1.0.0")}, cutoff), [])
            self.assertEqual(len(age.check_packages({("lib", "1.0.1"), ("lib", "2.0.0")}, cutoff)), 2)


if __name__ == "__main__":
    unittest.main()
