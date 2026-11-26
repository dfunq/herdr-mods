#!/usr/bin/env python3
"""Report each Claude agent's model and effort to herdr as `model`/`effort` pane tokens.

  model.py          refresh once (all agents, or the pane in HERDR_PLUGIN_EVENT_JSON)
  model.py --watch  start a background watcher that refreshes when a transcript changes
                    (needed because /model and /effort don't change agent status)
"""
import glob, json, os, re, signal, subprocess, sys, time

HERDR = os.environ.get("HERDR_BIN_PATH", "herdr")
PROJECTS = os.path.expanduser("~/.claude/projects")
STATE = os.environ.get("HERDR_PLUGIN_STATE_DIR") or os.path.dirname(os.path.abspath(__file__))
PIDFILE = os.path.join(STATE, "watch.pid")

# `/model sonnet` writes: <local-command-stdout>Set model to `Sonnet 5.5` ...
SET_MODEL = re.compile(r"Set model to `?([A-Za-z]+)")
SET_EFFORT = re.compile(r"Set effort(?: level)? to `?([a-z]+)", re.I)
EFFORT = {"medium": "med", "xhigh": "xhi"}
PAD = "\u2800"  # blank braille cell: renders as a space, survives trimming
MODEL_WIDTH = 6  # len("sonnet"), so $effort lines up


PATHS = {}     # session id -> transcript path, so the projects folder isn't searched every tick
REPORTED = {}  # pane id -> the tokens herdr last took from us


def herdr(*args):
    """herdr's JSON answer, or None when it can't be reached or says something else."""
    try:
        out = subprocess.run([HERDR, *args], capture_output=True, text=True, timeout=10)
        return json.loads(out.stdout) if out.stdout.strip().startswith("{") else None
    except (OSError, subprocess.TimeoutExpired, ValueError):
        return None


def transcript_path(session_id):
    path = PATHS.get(session_id)
    if not path or not os.path.exists(path):
        paths = glob.glob(os.path.join(PROJECTS, "*", f"{glob.escape(session_id)}.jsonl"))
        path = PATHS[session_id] = paths[0] if paths else None
    return path


def transcript_model(path):
    """(model, effort) from the newest assistant turn or /model, /effort command."""
    with open(path, "rb") as f:
        f.seek(0, os.SEEK_END)
        f.seek(max(0, f.tell() - 512 * 1024))  # last 512KB is plenty
        lines = f.read().decode("utf-8", "replace").splitlines()
    model = effort = None
    for line in reversed(lines):
        if "<local-command-stdout>Set " in line:
            m = SET_MODEL.search(line)
            model = model or (m and m[1].lower())
            e = SET_EFFORT.search(line)
            effort = effort or (e and e[1].lower())
        elif '"type":"assistant"' in line:
            try:
                turn = json.loads(line)
                turn_model = turn["message"]["model"]
            except (ValueError, KeyError, TypeError):
                continue
            if turn_model and turn_model != "<synthetic>":
                model = model or turn_model
                effort = effort or turn.get("effort") or turn.get("perTurnEffort")
        if model and effort:
            break
    return model, effort


def short(model):
    # claude-opus-5-5 -> opus, claude-sonnet-4-5-20250929 -> sonnet
    m = re.match(r"(?:claude-)?([a-z]+)", model)
    return m[1] if m else model


def agents():
    """[(pane id, transcript path)] for the Claude agent panes, or None when herdr didn't answer."""
    listing = herdr("agent", "list")
    if listing is None:
        return None
    found = []
    for a in (listing.get("result") or {}).get("agents") or []:
        session = (a.get("agent_session") or {}).get("value")
        if a.get("agent") != "claude" or not session or not a.get("pane_id"):
            continue  # not an agent pane of ours: no file search for it
        path = transcript_path(session)
        if path:
            found.append((a["pane_id"], path))
    return found


def report(pane_id, path):
    model, effort = transcript_model(path)
    if not model:
        return
    args = ["--token", f"model={short(model).ljust(MODEL_WIDTH, PAD)}"]
    args += ["--token", f"effort={EFFORT.get(effort, effort)}"] if effort else ["--clear-token", "effort"]
    if REPORTED.get(pane_id) == args:
        return  # herdr already shows this
    try:
        done = subprocess.run([HERDR, "pane", "report-metadata", pane_id,
                               "--source", "herdr-mods.agent-model", *args],
                              capture_output=True, timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        done = False
    if done:
        REPORTED[pane_id] = args
    else:
        REPORTED.pop(pane_id, None)


def refresh():
    event = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON") or "{}")
    only = (event.get("data") or event).get("pane_id")
    for pane_id, path in agents() or []:
        if not only or pane_id == only:
            report(pane_id, path)


def watch():
    seen, misses = {}, 0
    while misses < 5:  # five in a row: herdr is gone, and so are we
        found = agents()
        if found is None:
            misses += 1
            seen.clear(); REPORTED.clear()  # a restarted herdr has lost what we told it
        else:
            misses = 0
            live = {pane_id for pane_id, _ in found}
            for gone in [p for p in list(seen) + list(REPORTED) if p not in live]:
                seen.pop(gone, None); REPORTED.pop(gone, None)  # a pane id can come back as a new pane
            for pane_id, path in found:
                try:
                    mtime = os.path.getmtime(path)
                except OSError:
                    continue
                if seen.get(pane_id) != (path, mtime):
                    seen[pane_id] = (path, mtime)
                    report(pane_id, path)
        time.sleep(3)


def start_watcher():
    """Fork a detached watcher unless one is already running."""
    global _lock
    os.makedirs(STATE, exist_ok=True)
    try:
        import fcntl
    except ImportError:  # no file locks here: trust the pid in the file
        fcntl = None
        try:
            os.kill(int(open(PIDFILE).read()), 0)
            return
        except (OSError, ValueError):
            pass
    if fcntl:
        # The running watcher holds a lock on the pid file for its whole life. A pid alone proves
        # nothing (pids get reused); the lock goes when its holder dies. Forked children keep it.
        _lock = open(PIDFILE, "a+")
        try:
            fcntl.flock(_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            return
        except OSError:
            pass  # a filesystem without locks: carry on unlocked
    if os.fork():
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        if not _lock or fd != _lock.fileno():
            os.dup2(devnull, fd)
    if _lock:  # the pid is for people; the lock is what counts
        _lock.seek(0); _lock.truncate(); _lock.write(str(os.getpid())); _lock.flush()
    else:
        with open(PIDFILE, "w") as f:
            f.write(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    watch()


_lock = None  # the watcher's hold on the pid file


if __name__ == "__main__":
    if "--watch" in sys.argv:
        start_watcher()
    else:
        refresh()
