#!/usr/bin/env python3
"""PostToolUse (Edit|Write) hook: fast per-file check.

Reads the hook JSON on stdin, checks the single edited file, and stays SILENT
on success. On failure it writes the error to stderr and exits 2, which feeds
the error straight back to Claude in the same turn (no user round-trip).

Also records which app was touched into .claude/.verify_touched so the Stop
hook (verify_build.py) only runs the expensive build for apps that changed.
"""
import sys, os, json, subprocess

JS_APPS = ["crypto-charting-ui", "crypto-wallet"]
ALL_APPS = JS_APPS + ["crypto-data-collector"]


def fail(msg):
    sys.stderr.write(msg + "\n")
    sys.exit(2)


def record_touch(norm):
    token = next((a for a in ALL_APPS if a in norm), None)
    if not token:
        return
    try:
        state = os.path.join(os.getcwd(), ".claude", ".verify_touched")
        seen = set(open(state).read().split()) if os.path.exists(state) else set()
        seen.add(token)
        with open(state, "w") as f:
            f.write("\n".join(sorted(seen)))
    except Exception:
        pass


def app_dir_for(norm):
    for app in JS_APPS:
        key = "/" + app + "/"
        i = norm.find(key)
        if i != -1:
            return norm[: i + 1 + len(app)]
    return None


def main():
    try:
        data = json.load(sys.stdin)
    except Exception:
        sys.exit(0)
    fp = (data.get("tool_input") or {}).get("file_path") or ""
    if not fp:
        sys.exit(0)
    norm = fp.replace("\\", "/")
    if "/node_modules/" in norm or "/__pycache__/" in norm:
        sys.exit(0)

    if norm.endswith(".py") and "crypto-data-collector" in norm:
        record_touch(norm)
        r = subprocess.run([sys.executable, "-m", "py_compile", fp],
                           capture_output=True, text=True)
        if r.returncode != 0:
            fail("py_compile failed for %s:\n%s" % (fp, r.stderr or r.stdout))
        sys.exit(0)

    if norm.endswith((".js", ".jsx")):
        appdir = app_dir_for(norm)
        if appdir:
            record_touch(norm)
            # Syntax gate only: fail on fatal PARSE errors, not lint-style
            # rules (no-unused-vars etc.) that don't break the running app and
            # may already be present in the file. `vite build` at the Stop gate
            # is the authoritative "does it build" check.
            r = subprocess.run('npx eslint --format json "%s"' % fp, cwd=appdir,
                               shell=True, capture_output=True, text=True)
            try:
                report = json.loads(r.stdout or "[]")
                fatal = [m for f in report for m in f.get("messages", [])
                         if m.get("fatal")]
            except Exception:
                fatal = []
            if fatal:
                detail = "\n".join("  line %s: %s" % (m.get("line"), m.get("message"))
                                   for m in fatal)
                fail("Syntax error in %s:\n%s" % (fp, detail))
        sys.exit(0)

    sys.exit(0)


if __name__ == "__main__":
    main()
