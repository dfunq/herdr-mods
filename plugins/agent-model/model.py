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


def herdr(*args):
    out = subprocess.run([HERDR, *args], capture_output=True, text=True)
    return json.loads(out.stdout) if out.stdout.strip().startswith("{") else None


def transcript_path(session_id):
    paths = glob.glob(os.path.join(PROJECTS, "*", f"{session_id}.jsonl"))
    return paths[0] if paths else None


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
    listing = herdr("agent", "list") or {}
    for a in listing.get("result", {}).get("agents", []):
        session = (a.get("agent_session") or {}).get("value")
        path = a.get("agent") == "claude" and session and transcript_path(session)
        if path:
            yield a["pane_id"], path


def report(pane_id, path):
    model, effort = transcript_model(path)
    if not model:
        return
    args = ["--token", f"model={short(model).ljust(MODEL_WIDTH, PAD)}"]
    args += ["--token", f"effort={EFFORT.get(effort, effort)}"] if effort else ["--clear-token", "effort"]
    subprocess.run([HERDR, "pane", "report-metadata", pane_id,
                    "--source", "herdr-mods.agent-model", *args],
                   capture_output=True)


def refresh():
    event = json.loads(os.environ.get("HERDR_PLUGIN_EVENT_JSON") or "{}")
    only = (event.get("data") or event).get("pane_id")
    for pane_id, path in agents():
        if not only or pane_id == only:
            report(pane_id, path)


def watch():
    seen = {}
    while True:
        for pane_id, path in agents():
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
    try:
        os.kill(int(open(PIDFILE).read()), 0)
        return
    except (OSError, ValueError):
        pass
    if os.fork():
        return
    os.setsid()
    if os.fork():
        os._exit(0)
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    os.makedirs(STATE, exist_ok=True)
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))
    signal.signal(signal.SIGTERM, lambda *_: os._exit(0))
    watch()


if __name__ == "__main__":
    if "--watch" in sys.argv:
        start_watcher()
    else:
        refresh()
