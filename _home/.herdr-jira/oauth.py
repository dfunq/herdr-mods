"""Atlassian OAuth 2.0 (3LO) helper for the herdr Jira panel.

  python oauth.py login   opens the browser, catches the callback on localhost, saves tokens
  python oauth.py token   prints {"access_token", "cloud_id", "site"} as JSON, refreshing when needed
  python oauth.py logout  deletes the saved tokens

app.json (written by you): {"client_id": "...", "client_secret": "...", "site": "your-site.atlassian.net" (optional)}
tokens.json (written here): access/refresh tokens and the chosen site.
"""
import contextlib, html, http.client, http.server, json, os, secrets, subprocess, sys, time
import urllib.error, urllib.parse, urllib.request, webbrowser

DIR = os.path.dirname(os.path.abspath(__file__))
APP, TOKENS = os.path.join(DIR, "app.json"), os.path.join(DIR, "tokens.json")
PIDFILE = os.path.join(DIR, "login.pid")
PORT = 8765
REDIRECT = f"http://localhost:{PORT}/callback"
SCOPES = "read:jira-work write:jira-work read:jira-user offline_access"


def log(msg):
    try:
        with open(os.path.join(DIR, "login.log"), "a") as f:
            f.write(time.strftime("%H:%M:%S ") + msg + "\n")
    except Exception:
        pass


def drop_pidfile():
    """Remove login.pid, but only when it is this process's."""
    try:
        if int(open(PIDFILE).read()) == os.getpid():
            os.remove(PIDFILE)
    except Exception:
        pass


def fail(msg, code=1):
    log("fail: " + str(msg))
    drop_pidfile()
    print(json.dumps({"error": msg}))
    sys.exit(code)


def app():
    try:
        a = json.load(open(APP, encoding="utf-8-sig"))
        if a.get("client_id") and a.get("client_secret") and "paste" not in a["client_id"]:
            return a
    except Exception:
        pass
    fail("no-app")


def post(url, body):
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.load(r)


def save(tok, extra):
    data = {**extra, "access_token": tok["access_token"],
            "refresh_token": tok.get("refresh_token") or extra.get("refresh_token"),
            "expires_at": time.time() + int(tok.get("expires_in", 3600)) - 60}
    try:
        os.chmod(DIR, 0o700)  # tokens live here: owner only (does nothing useful on Windows)
    except OSError:
        pass
    # Write beside the file, then swap it in: a reader never sees half a file.
    tmp = "%s.%d.tmp" % (TOKENS, os.getpid())
    try:
        with os.fdopen(os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w", encoding="utf-8") as f:
            json.dump(data, f)
        os.replace(tmp, TOKENS)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise
    return data


def load():
    try:
        t = json.load(open(TOKENS, encoding="utf-8"))
        return t if isinstance(t, dict) else None
    except Exception:
        return None


@contextlib.contextmanager
def locked():
    """Hold tokens.lock: one refresh at a time, because Atlassian replaces the refresh token on every use.
    Without a lock (an odd filesystem, a long wait on Windows) the refresh still goes ahead."""
    f = None
    try:
        f = open(os.path.join(DIR, "tokens.lock"), "a+")
        try:
            import fcntl
            fcntl.flock(f, fcntl.LOCK_EX)
        except ImportError:
            import msvcrt
            f.seek(0)
            for _ in range(3):  # each try waits about 10 s
                try:
                    msvcrt.locking(f.fileno(), msvcrt.LK_LOCK, 1)
                    break
                except OSError:
                    pass
    except Exception:
        pass
    try:
        yield
    finally:
        if f:
            f.close()  # closing lets the lock go


def refresh(a, t):
    """Trade the refresh token for new tokens. Only Atlassian saying no means the login is gone;
    anything else leaves tokens.json as it is, to try again later."""
    if not t.get("refresh_token"):
        fail("no-login")
    try:
        tok = post("https://auth.atlassian.com/oauth/token", {
            "grant_type": "refresh_token", "client_id": a["client_id"], "client_secret": a["client_secret"],
            "refresh_token": t["refresh_token"]})
    except urllib.error.HTTPError as e:
        fail("no-login" if e.code in (400, 401, 403) else f"Atlassian returned {e.code}")
    except (OSError, http.client.HTTPException):  # no network, DNS, timeout, dropped connection
        fail("Can't reach Atlassian")
    except ValueError:
        fail("Atlassian sent an answer that can't be read")
    if not isinstance(tok, dict) or not tok.get("access_token"):
        fail("Atlassian sent an answer that can't be read")
    return save(tok, t)


def is_helper(pid):
    """Is this pid a sign-in helper? Pids get reused, so check before stopping one."""
    try:
        if os.name == "nt":  # no command line without extra tools: settle for "a Python process"
            out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                                 capture_output=True, text=True, timeout=5).stdout
            return out.strip().lower().startswith('"py')
        out = subprocess.run(["ps", "-p", str(pid), "-o", "command="], capture_output=True, text=True, timeout=5).stdout
        return "oauth.py" in out
    except Exception:
        return False


def login():
    a, state, got = app(), secrets.token_urlsafe(16), {}

    # Only one sign-in at a time: stop an earlier helper still waiting for its callback.
    try:
        old = int(open(PIDFILE).read())
        if old != os.getpid() and is_helper(old):
            os.kill(old, 9)
            time.sleep(0.5)
    except Exception:
        pass
    with open(PIDFILE, "w") as f:
        f.write(str(os.getpid()))

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            log("request " + u.path + " keys=" + ",".join(sorted(urllib.parse.parse_qs(u.query))))
            if u.path != "/callback":
                self.send_response(404); self.end_headers(); return
            q = urllib.parse.parse_qs(u.query)
            ours = q.get("state", [""])[0] == state  # anything else didn't come from this sign-in
            ok = ours and "code" in q
            if ok:
                got["code"] = q["code"][0]
            elif ours and "error" in q:
                got["error"] = q.get("error_description", q["error"])[0]
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.end_headers()
            msg = ("Signed in to Jira. You can close this tab." if ok else
                   f"Jira sign-in failed: {html.escape(got.get('error') or 'this link is from an older sign-in attempt')}. Close this tab and click Log in again.")
            self.wfile.write(f"<html><body style='font-family:sans-serif;padding:40px'>{msg}</body></html>".encode())

        def log_message(self, *a):
            pass

    class Exclusive(http.server.HTTPServer):
        allow_reuse_address = False

        def server_bind(self):
            import socket
            if hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            super().server_bind()

    class Exclusive6(Exclusive):
        import socket as _s
        address_family = _s.AF_INET6

    try:
        srv = Exclusive(("127.0.0.1", PORT), H)
    except OSError:
        fail(f"Port {PORT} is busy. Close other sign-in attempts and try again.")
    srv.timeout = 1
    # The callback URL says "localhost", which browsers often try as IPv6 (::1) first: listen there too.
    servers = [srv]
    try:
        srv6 = Exclusive6(("::1", PORT), H)
        srv6.timeout = 1
        servers.append(srv6)
    except OSError:
        pass
    log("listening on %d (%s)" % (PORT, "ipv4+ipv6" if len(servers) > 1 else "ipv4"))
    url = "https://auth.atlassian.com/authorize?" + urllib.parse.urlencode({
        "audience": "api.atlassian.com", "client_id": a["client_id"], "scope": SCOPES,
        "redirect_uri": REDIRECT, "state": state, "response_type": "code", "prompt": "consent"})
    # macOS: Python's webbrowser goes through osascript, which silently does nothing when herdr starts us.
    opened = False
    if sys.platform == "darwin":
        opened = subprocess.run(["/usr/bin/open", url], capture_output=True).returncode == 0
    if not opened:
        webbrowser.open(url)
    log("browser opened=%s" % opened)
    end = time.time() + 280
    import select
    while "code" not in got and "error" not in got and time.time() < end:
        ready, _, _ = select.select(servers, [], [], 1)
        for s in ready:
            s.handle_request()
    for s in servers:
        s.server_close()
    drop_pidfile()
    if "code" not in got:
        fail(got.get("error") or "Sign-in timed out or was cancelled.")
    tok = post("https://auth.atlassian.com/oauth/token", {
        "grant_type": "authorization_code", "client_id": a["client_id"], "client_secret": a["client_secret"],
        "code": got["code"], "redirect_uri": REDIRECT})
    req = urllib.request.Request("https://api.atlassian.com/oauth/token/accessible-resources",
                                 headers={"Authorization": f"Bearer {tok['access_token']}", "Accept": "application/json"})
    with urllib.request.urlopen(req, timeout=20) as r:
        sites = json.load(r)
    site = next((s for s in sites if a.get("site") and a["site"] in s.get("url", "")), sites[0] if sites else None)
    if not site:
        fail("This login has no Jira site.")
    log("signed in to " + site.get("url", "?"))
    save(tok, {"cloud_id": site["id"], "site": site["url"]})
    print(json.dumps({"ok": True, "site": site["url"]}))


def token():
    a = app()
    t = load() or fail("no-login")
    if time.time() > t.get("expires_at", 0):
        with locked():
            # Another panel may have refreshed while we waited: use its tokens, ours are spent.
            t = load() or fail("no-login")
            if time.time() > t.get("expires_at", 0):
                t = refresh(a, t)
    print(json.dumps({"access_token": t["access_token"], "cloud_id": t["cloud_id"], "site": t["site"]}))


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "token"
    if cmd == "login":
        login()
    elif cmd == "logout":
        if os.path.exists(TOKENS):
            os.remove(TOKENS)
        print(json.dumps({"ok": True}))
    else:
        token()
