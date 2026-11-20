"""Check the publication dates of new npm packages in a pull request lockfile."""

import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote, unquote, urlsplit
from urllib.request import Request, urlopen

REGISTRY = "registry.npmjs.org"
PACKAGE_NAME = re.compile(r"(?:@[A-Za-z0-9._~-]+/)?[A-Za-z0-9._~-]+")
PACKAGE_VERSION = re.compile(r"\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.+-]+)?")


def lockfile_packages(contents):
    lockfile = json.loads(contents)
    if lockfile.get("lockfileVersion") != 3:
        raise ValueError("expected an npm lockfile at version 3")

    # Compare package identities independently of placement in node_modules.
    packages = set()
    for path, entry in lockfile["packages"].items():
        if not path:
            continue
        installed_name = path.removeprefix("node_modules/").rsplit("/node_modules/", 1)[-1]
        packages.add(
            (entry.get("name", installed_name), entry.get("version", ""), entry.get("resolved", ""))
        )
    return packages


def registry_package(name, version, resolved):
    if not PACKAGE_NAME.fullmatch(name) or not PACKAGE_VERSION.fullmatch(version):
        raise ValueError(f"invalid registry package identity {name!r}@{version!r}")

    archive = f"/{name}/-/{name.rsplit('/', 1)[-1]}-{version}.tgz"
    source = urlsplit(resolved)
    if (
        source.scheme != "https"
        or source.netloc != REGISTRY
        or unquote(source.path) != archive
        or source.query
        or source.fragment
    ):
        raise ValueError(f"{name}@{version} has an unverifiable source: {resolved!r}")
    return name, version


def minimum_age(config):
    settings = re.findall(r"(?m)^\s*min-release-age\s*=\s*([0-9]+)[ \t]*$", config)
    if len(settings) != 1 or int(settings[0]) < 1:
        raise ValueError(".npmrc must set one positive min-release-age in days")
    return timedelta(days=int(settings[0]))


def publication_times(name):
    request = Request(f"https://{REGISTRY}/{quote(name, safe='')}")
    with urlopen(request, timeout=20) as response:
        metadata = json.load(response)
    return metadata["time"]


def check_packages(packages, cutoff):
    times_by_name = {}
    problems = []
    for name, version in sorted(packages):
        try:
            if name not in times_by_name:
                times_by_name[name] = publication_times(name)
            value = times_by_name[name][version]
            published = datetime.fromisoformat(value.replace("Z", "+00:00"))
            if published.utcoffset() is None:
                raise ValueError("timestamp has no timezone")
        except (KeyError, OSError, TypeError, ValueError) as error:
            problems.append(f"{name}@{version}: cannot verify registry publication time ({error})")
            continue
        if published > cutoff:
            problems.append(
                f"{name}@{version}: published {published.isoformat()}, after cutoff {cutoff.isoformat()}"
            )
    return problems


def main(base_sha):
    if not re.fullmatch(r"[0-9a-f]{40}", base_sha):
        raise ValueError("expected the full base commit SHA")

    if Path("npm-shrinkwrap.json").exists():
        raise ValueError("npm-shrinkwrap.json would take precedence over the checked package-lock.json")

    base = subprocess.check_output(["git", "show", f"{base_sha}:package-lock.json"])
    candidate = Path("package-lock.json").read_bytes()
    if base == candidate:
        print("npm lockfile is unchanged.")
        return 0

    new_packages = lockfile_packages(candidate) - lockfile_packages(base)
    if not new_packages:
        print("npm lockfile has no new package versions or sources.")
        return 0

    age = minimum_age(Path(".npmrc").read_text())
    cutoff = datetime.now(timezone.utc) - age
    problems = check_packages({registry_package(*entry) for entry in new_packages}, cutoff)
    for problem in problems:
        print(problem, file=sys.stderr)
    if problems:
        return 1

    print(f"Verified publication age for {len(new_packages)} new npm package versions or sources.")
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit("usage: check-npm-release-age.py BASE_COMMIT_SHA")
    try:
        sys.exit(main(sys.argv[1]))
    except (KeyError, TypeError, ValueError, OSError, subprocess.CalledProcessError) as error:
        sys.exit(f"npm release age check failed: {error}")
