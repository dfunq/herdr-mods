"""Dictation for the herdr Jira panel, using Chrome's built-in speech recognition (Web Speech API).

`python stt.py` serves a tiny page on 127.0.0.1:8766 and opens it as a Chrome app window. On Windows the
window is shrunk to a small "Listening" strip at the top centre of the screen, kept on top, and focus goes back
to herdr; it only stays large while Chrome shows its one-time microphone prompt. The page streams text to
/text; the mod polls GET /state for live text and POSTs /stop. On /done this prints {"text": ...} or
{"error": ...}, closes the window and exits. Audio is recognised by Google's speech service.

Note: on this PC a Chrome policy (UserDataDir) pins Chrome to the main profile, so the window opens in the
user's own Chrome and command-line switches such as --user-data-dir are ignored there.
"""
import ctypes, json, os, shutil, socket, subprocess, sys, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PORT = 8766
WIN, MAC = os.name == "nt", sys.platform == "darwin"
SMALL, BIG = (240, 64), (460, 260)  # BIG only while Chrome's mic prompt needs room
TITLE = "herdr dictation"
BLOCKED = ("Microphone blocked. Allow it for 127.0.0.1:8766 in Chrome (site settings), and check the system setting: "
           "Windows: Settings > Privacy & security > Microphone > allow desktop apps. "
           "Mac: System Settings > Privacy & Security > Microphone > Google Chrome.")
state = {"text": "", "stop": False, "done": False, "error": None, "perm": None}

PAGE = """<!doctype html><meta charset=utf-8><title>%s</title>
<style>html,body{margin:0;height:100%%;background:#1e1f22;color:#ddd;font:12px system-ui;overflow:hidden}
.row{display:flex;align-items:center;gap:7px;padding:0 10px;height:100%%;white-space:nowrap}
.dot{flex:none;width:8px;height:8px;border-radius:4px;background:#e5484d;animation:p 1s infinite}@keyframes p{50%%{opacity:.3}}
#t{overflow:hidden;text-overflow:ellipsis;color:#999}</style>
<div class=row><span class=dot></span><b id=s>Listening</b><span id=t></span></div>
<script>
const post = (p, b) => fetch(p, {method: "POST", body: JSON.stringify(b || {})}).catch(() => {});
const R = window.SpeechRecognition || window.webkitSpeechRecognition;
let finals = "", stopped = false, ended = false, r;
function finish(err) {
  if (ended) return; ended = true;
  post(err ? "/error" : "/done", {text: finals.trim(), error: err}).finally(() => setTimeout(() => window.close(), 200));
}
if (navigator.permissions) navigator.permissions.query({name: "microphone"}).then(p => {
  post("/perm", {state: p.state}); p.onchange = () => post("/perm", {state: p.state});
}).catch(() => {});
if (!R) finish("This Chrome has no speech recognition");
else {
  r = new R(); r.continuous = true; r.interimResults = true; r.lang = navigator.language || "en-US";
  r.onresult = e => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finals += (finals ? " " : "") + t.trim(); else interim += t;
    }
    const all = (finals + " " + interim).trim();
    document.getElementById("t").textContent = all.slice(-60); post("/text", {text: all});
  };
  r.onerror = e => { if (e.error !== "no-speech" && e.error !== "aborted") finish("microphone " + e.error); };
  r.onend = () => { if (stopped) finish(); else try { r.start(); } catch (_) {} };
  r.start();
  addEventListener("pagehide", () => { if (!ended) navigator.sendBeacon("/done", JSON.stringify({text: finals.trim()})); });
  let misses = 0;  // the helper is gone (its dialog closed and the process was killed): close ourselves
  setInterval(() => fetch("/poll").then(x => x.json()).then(j => { misses = 0; if (j.stop && !stopped) { stopped = true; r.stop(); } })
    .catch(() => { if (++misses >= 5) { ended = true; window.close(); } }), 200);
}
</script>""" % TITLE


class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass

    def reply(self, body, ctype="application/json"):
        b = body.encode()
        self.send_response(200); self.send_header("Content-Type", ctype); self.send_header("Content-Length", str(len(b)))
        self.end_headers(); self.wfile.write(b)

    def do_GET(self):
        if self.path == "/": self.reply(PAGE, "text/html; charset=utf-8")
        elif self.path == "/poll": self.reply(json.dumps({"stop": state["stop"]}))
        elif self.path == "/state": self.reply(json.dumps({k: state[k] for k in ("text", "done", "error")}))
        else: self.reply("{}")

    def do_POST(self):
        n = int(self.headers.get("Content-Length") or 0)
        try: body = json.loads(self.rfile.read(n) or b"{}")
        except ValueError: body = {}
        if self.path == "/text": state["text"] = body.get("text", "")
        elif self.path == "/stop": state["stop"] = True
        elif self.path == "/perm": state["perm"] = body.get("state")
        elif self.path == "/done": state["text"] = body.get("text", state["text"]); state["done"] = True
        elif self.path == "/error": state["error"] = body.get("error") or "speech error"; state["done"] = True
        self.reply("{}")


class Server(ThreadingHTTPServer):
    allow_reuse_address = False

    def server_bind(self):
        if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def find_chrome():
    if MAC:
        c = "/Applications/Google Chrome.app"
        return c if os.path.exists(c) else None
    if WIN:
        return next((c for c in (r"C:\Program Files\Google\Chrome\Application\chrome.exe",
                                 os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe")) if os.path.exists(c)), None)
    return next((shutil.which(c) for c in ("google-chrome", "google-chrome-stable", "chromium") if shutil.which(c)), None)


def work_area():
    try:
        if WIN:
            class R(ctypes.Structure): _fields_ = [(n, ctypes.c_long) for n in ("l", "t", "r", "b")]
            r = R(); ctypes.windll.user32.SystemParametersInfoW(0x30, 0, ctypes.byref(r), 0)  # SPI_GETWORKAREA
            return r.r, r.b
        if MAC:
            out = subprocess.run(["osascript", "-e", 'tell application "Finder" to get bounds of window of desktop'],
                                 capture_output=True, text=True, timeout=5).stdout
            return tuple(int(v) for v in out.split(",")[2:4])
    except Exception:
        pass
    return None


def place(size):
    wa = work_area()
    # top-centre of the main screen; on a Mac, below the menu bar
    return ((wa[0] - size[0]) // 2, 40 if MAC else 12) if wa else (40, 40)


def hide_new_windows(ready):
    """Windows: catch every new top-level Chrome window the moment it is created and make it invisible and
    small before it is first drawn, so the launch never flashes at Chrome's remembered size. manage_window
    shows ours once its title confirms it; anything else (a Chrome window the user opened in these few
    seconds) gets its opacity and position back."""
    import ctypes.wintypes as w
    u = ctypes.windll.user32
    u.SetWindowLongW.restype = ctypes.c_long
    u.GetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int]
    u.SetWindowLongW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_long]
    proto = ctypes.WINFUNCTYPE(None, w.HANDLE, w.DWORD, w.HWND, w.LONG, w.LONG, w.DWORD, w.DWORD)
    x, y = place(SMALL)

    def on_event(_hook, _event, hwnd, id_object, _child, _thread, _time):
        if id_object != 0 or not hwnd or hwnd in caught: return
        if u.GetParent(hwnd) or u.GetWindow(hwnd, 4): return  # child or owned (menus, bubbles)
        cls = ctypes.create_unicode_buffer(64); u.GetClassNameW(hwnd, cls, 64)
        if cls.value != "Chrome_WidgetWin_1" or not (u.GetWindowLongW(hwnd, -16) & 0xC00000): return  # needs a caption
        r = w.RECT(); u.GetWindowRect(hwnd, ctypes.byref(r))
        caught[hwnd] = (r.left, r.top, r.right - r.left, r.bottom - r.top)
        u.SetWindowLongW(hwnd, -20, u.GetWindowLongW(hwnd, -20) | 0x80000)  # WS_EX_LAYERED
        u.SetLayeredWindowAttributes(hwnd, 0, 0, 2)  # fully transparent
        u.SetWindowPos(hwnd, None, x, y, SMALL[0], SMALL[1], 0x4 | 0x10)  # NOZORDER|NOACTIVATE

    cb = proto(on_event)
    hook = u.SetWinEventHook(0x8000, 0x8002, None, cb, 0, 0, 0)  # OBJECT_CREATE..OBJECT_SHOW, out of context
    ready.set()
    msg, end = w.MSG(), time.time() + 6
    while time.time() < end and not state["done"]:
        while u.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1): u.DispatchMessageW(ctypes.byref(msg))
        time.sleep(0.001)
    u.UnhookWinEvent(hook)
    for h, (rx, ry, rw, rh) in list(caught.items()):
        if h not in mine and u.IsWindow(h):  # not ours: undo
            u.SetLayeredWindowAttributes(h, 0, 255, 2)
            u.SetWindowPos(h, None, rx, ry, rw, rh, 0x4 | 0x10)


caught, mine = {}, set()


def manage_window(prev):
    """Windows: find our app window by title the moment it shows, pin it small in the corner, on top,
    and hand focus back. While Chrome's mic prompt is pending, keep it big enough to click Allow."""
    u = ctypes.windll.user32
    proto = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    found = []

    def each(h, _):
        hw = ctypes.c_void_p(h)
        if u.IsWindowVisible(hw):
            b = ctypes.create_unicode_buffer(256); u.GetWindowTextW(hw, b, 256)
            if TITLE in b.value or "127.0.0.1:8766" in b.value: found.append(h)
        return True

    cb, hwnd, size, refocused = proto(each), None, None, False
    while not state["done"]:
        if hwnd is None:
            found.clear(); u.EnumWindows(cb, 0)
            hwnd = found[0] if found else None
            if hwnd is not None:
                mine.add(hwnd)
        if hwnd is not None:
            want = BIG if state["perm"] == "prompt" else SMALL
            if want != size:
                x, y = place(want)
                u.SetWindowPos(ctypes.c_void_p(hwnd), ctypes.c_void_p(-1), x, y, want[0], want[1], 0x10 | 0x40)  # TOPMOST, NOACTIVATE|SHOWWINDOW
                if size is None: u.SetLayeredWindowAttributes(ctypes.c_void_p(hwnd), 0, 255, 2)  # placed: show it
                size = want
            if want == SMALL and not refocused and prev and u.GetForegroundWindow() != prev:
                u.keybd_event(0x12, 0, 0, 0); u.keybd_event(0x12, 0, 2, 0)  # Alt tap lets SetForegroundWindow through
                u.SetForegroundWindow(ctypes.c_void_p(prev)); refocused = True
        time.sleep(0.005 if hwnd is None else 0.1)
    if hwnd is not None:
        time.sleep(0.5)
        if u.IsWindow(ctypes.c_void_p(hwnd)): u.PostMessageW(ctypes.c_void_p(hwnd), 0x10, 0, 0)  # WM_CLOSE


def main():
    try: srv = Server(("127.0.0.1", PORT), H)
    except OSError: print(json.dumps({"error": "Dictation is already running"})); return
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    chrome = find_chrome()
    if not chrome: print(json.dumps({"error": "Google Chrome not found"})); return
    x, y = place(SMALL)
    flags = [f"--app=http://127.0.0.1:{PORT}/", f"--window-size={SMALL[0]},{SMALL[1]}", f"--window-position={x},{y}"]
    if MAC:
        # the binary, not `open`: a running Chrome ignores `open --args`, but forwards a direct launch's --app
        subprocess.Popen([os.path.join(chrome, "Contents/MacOS/Google Chrome"), *flags])
    else:
        prev = ctypes.windll.user32.GetForegroundWindow() if WIN else None
        if WIN:
            ready = threading.Event()
            threading.Thread(target=hide_new_windows, args=(ready,), daemon=True).start()
            ready.wait(2)
        subprocess.Popen([chrome, *flags])
        if WIN: threading.Thread(target=manage_window, args=(prev,), daemon=True).start()
    end = time.time() + 600
    while not state["done"] and time.time() < end: time.sleep(0.1)
    time.sleep(0.7)  # let the window close itself (or manage_window close it) before the server goes
    srv.shutdown()
    err = state["error"]
    if err and any(k in err for k in ("not-allowed", "audio-capture")): err = BLOCKED
    print(json.dumps({"error": err} if err else {"text": state["text"]}))


if __name__ == "__main__":
    if sys.argv[1:] == ["stop"]:  # the mod calls this when its dialog closes or sends mid-dictation
        import urllib.request
        try: urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{PORT}/stop", data=b"{}", method="POST"), timeout=2)
        except OSError: pass
    else:
        main()
