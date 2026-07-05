#!/usr/bin/env python3
"""Stop hook: thorough completion gate, run once per turn.

Reads .claude/.verify_touched (written by verify_file.py) and runs the real
build/test only for apps that were edited this turn. On failure it writes the
error to stderr and exits 2, which blocks the stop and hands the error back to
Claude so it fixes the breakage before returning to the user.

The touched-state file is cleared at the start of every run, so a stop with no
new edits always passes -- this prevents any infinite stop/fix loop.
"""
import sys, os, json, subprocess

JS_APPS = ["crypto-charting-ui", "crypto-wallet"]


def tail(stdout, stderr, n=40):
    text = ((stdout or "") + "\n" + (stderr or "")).strip()
    lines = text.splitlines()
    return "\n".join(lines[-n:]) if len(lines) > n else text


def has_test(appdir):
    try:
        pkg = json.load(open(os.path.join(appdir, "package.json")))
        return bool((pkg.get("scripts") or {}).get("test"))
    except Exception:
        return False


def main():
    try:
        json.load(sys.stdin)
    except Exception:
        pass
    proj = os.getcwd()
    state = os.path.join(proj, ".claude", ".verify_touched")
    if not os.path.exists(state):
        sys.exit(0)
    touched = set(open(state).read().split())
    try:
        os.remove(state)  # clear first -> no infinite stop loop
    except Exception:
        pass
    if not touched:
        sys.exit(0)

    errors = []

    for app in JS_APPS:
        if app not in touched:
            continue
        appdir = os.path.join(proj, app)
        r = subprocess.run("npm run build", cwd=appdir, shell=True,
                           capture_output=True, text=True)
        if r.returncode != 0:
            errors.append("[%s] npm run build FAILED:\n%s"
                          % (app, tail(r.stdout, r.stderr)))
            continue
        if has_test(appdir):
            rt = subprocess.run("npm run test", cwd=appdir, shell=True,
                               capture_output=True, text=True)
            if rt.returncode != 0:
                errors.append("[%s] npm run test FAILED:\n%s"
                              % (app, tail(rt.stdout, rt.stderr)))

    if "crypto-data-collector" in touched:
        cdir = os.path.join(proj, "crypto-data-collector")
        pyfiles = []
        for root, _dirs, files in os.walk(cdir):
            if "__pycache__" in root:
                continue
            pyfiles += [os.path.join(root, f) for f in files if f.endswith(".py")]
        if pyfiles:
            r = subprocess.run([sys.executable, "-m", "py_compile"] + pyfiles,
                               capture_output=True, text=True)
            if r.returncode != 0:
                errors.append("[crypto-data-collector] py_compile FAILED:\n%s"
                              % (r.stderr or r.stdout))

    if errors:
        sys.stderr.write("Verification gate failed -- fix before finishing:\n\n"
                         + "\n\n".join(errors) + "\n")
        sys.exit(2)
    sys.exit(0)


if __name__ == "__main__":
    main()
