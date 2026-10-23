#!/usr/bin/env python3
"""
Start the Love Island PC player.

Double-click this file (or run  py play.py). It starts a small local server that only
your own computer can reach, then opens the game in its own window. Close the game window
to quit. Saves go in your user folder (%APPDATA%/LoveIsland/saves), so they survive rebuilds.

The seasons are read from the "data" folder next to this file, or from the single packed
file LoveIsland.data (that's what BUILD.bat puts inside "Love Island.exe").

Options:  --browser   open in your normal browser instead of an app window
          --port N    use a specific port

This file can also be built into "Love Island.exe" with build_exe.bat.
"""
import http.server
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import urllib.parse
import webbrowser
import zipfile

if getattr(sys, "frozen", False):
    # Running as Love Island.exe: player files are inside the exe, data and saves sit next to it.
    ROOT = os.path.dirname(os.path.abspath(sys.executable))
    RES = getattr(sys, "_MEIPASS", ROOT)
else:
    ROOT = RES = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "data")
PACK = next((p for p in (os.path.join(RES, "LoveIsland.data"), os.path.join(ROOT, "LoveIsland.data")) if os.path.isfile(p)), None)
APPDIR = os.path.join(os.environ.get("APPDATA") or os.path.expanduser("~"), "LoveIsland")
SAVES = os.path.join(APPDIR, "saves")
WINDOWED = getattr(sys, "frozen", False) and sys.stdout is None


def _move_old_saves():
    """Saves used to live next to the game; keep them when switching to the user folder."""
    old = os.path.join(ROOT, "saves")
    if os.path.isdir(old) and not os.path.isdir(SAVES):
        try:
            shutil.copytree(old, SAVES)
        except Exception:
            pass


class Pack:
    """Read season files straight out of LoveIsland.data (one zip file), without unpacking it."""
    def __init__(self, path):
        self.path = path
        self.local = threading.local()
        with zipfile.ZipFile(path) as z:
            self.names = set(z.namelist())

    def read(self, name):
        z = getattr(self.local, "z", None)
        if z is None:
            z = self.local.z = zipfile.ZipFile(self.path)
        return z.read(name)

    def seasons(self):
        return sorted({n.split("/")[0] for n in self.names if n.count("/") == 1 and n.endswith("/episodes.json")})


USE_FOLDER = os.path.isdir(DATA) and any(os.path.isfile(os.path.join(DATA, s, "episodes.json")) for s in os.listdir(DATA))
PACKED = Pack(PACK) if PACK and not USE_FOLDER else None
SAFE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")

TYPES = {".js": "text/javascript", ".json": "application/json", ".css": "text/css", ".html": "text/html",
         ".wav": "audio/wav", ".ogg": "audio/ogg", ".mp3": "audio/mpeg", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml",
         ".woff2": "font/woff2"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def log_message(self, *a):
        pass

    def guess_type(self, path):
        return TYPES.get(os.path.splitext(path)[1].lower()) or super().guess_type(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-cache")
        super().end_headers()

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _save_path(self, q):
        season, name = q.get("season", [""])[0], q.get("name", [""])[0]
        if not (SAFE.match(season) and SAFE.match(name)):
            return None
        return os.path.join(SAVES, season, name + ".json")

    def do_GET(self):
        u = urllib.parse.urlparse(self.path)
        if u.path in ("/", "/index.html"):
            self.send_response(302)
            self.send_header("Location", "/player/index.html")
            self.end_headers()
            return
        if u.path == "/api/seasons":
            out = []
            if PACKED:
                out = [{"id": s} for s in PACKED.seasons()]
            elif os.path.isdir(DATA):
                for s in sorted(os.listdir(DATA)):
                    if os.path.isfile(os.path.join(DATA, s, "episodes.json")):
                        out.append({"id": s})
            return self._json(200, out)
        if u.path == "/api/save":
            p = self._save_path(urllib.parse.parse_qs(u.query))
            if not p or not os.path.isfile(p):
                return self._json(200, None)
            with open(p, "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if u.path.startswith("/player/"):
            self.directory = RES
        elif u.path.startswith("/data/"):
            if PACKED:
                return self._packed(urllib.parse.unquote(u.path[len("/data/"):]))
            self.directory = ROOT
        else:
            return self._json(404, None)
        return super().do_GET()

    def _packed(self, name):
        if ".." in name or name not in PACKED.names:
            return self._json(404, None)
        body = PACKED.read(name)
        self.send_response(200)
        self.send_header("Content-Type", self.guess_type(name))
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_PUT(self):
        u = urllib.parse.urlparse(self.path)
        if u.path != "/api/save":
            return self._json(404, None)
        p = self._save_path(urllib.parse.parse_qs(u.query))
        if not p:
            return self._json(400, None)
        n = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(n)
        try:
            json.loads(body)
        except Exception:
            return self._json(400, None)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = p + ".tmp"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, p)
        return self._json(200, {"ok": True})

    do_POST = do_PUT


def message(text, title="Love Island"):
    """Show a message: a popup when running as a windowed .exe, otherwise print it."""
    if WINDOWED and os.name == "nt":
        import ctypes
        ctypes.windll.user32.MessageBoxW(None, text, title, 0x40)
    else:
        print(text)


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def find_app_browser():
    """Edge or Chrome can open a page as a standalone app window (no tabs or address bar)."""
    cands = []
    for env in ("PROGRAMFILES(X86)", "PROGRAMFILES", "LOCALAPPDATA"):
        base = os.environ.get(env)
        if base:
            cands += [os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe"),
                      os.path.join(base, "Google", "Chrome", "Application", "chrome.exe")]
    cands += ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
              "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"]
    for name in ("msedge", "google-chrome", "chromium", "chromium-browser", "chrome"):
        w = shutil.which(name)
        if w:
            cands.append(w)
    return next((c for c in cands if c and os.path.isfile(c)), None)


def main():
    args = sys.argv[1:]
    port = int(args[args.index("--port") + 1]) if "--port" in args else free_port()
    _move_old_saves()
    if not PACKED and (not os.path.isdir(DATA) or not os.listdir(DATA)):
        message("No converted seasons found.\n\nPut the \"data\" folder made by the converter next to this program:\n"
                + ROOT)
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{port}/player/index.html"
    print(f"Love Island is running at {url}")

    exe = None if "--browser" in args else find_app_browser()
    if exe:
        profile = os.path.join(APPDIR, "window")
        print("Opening the game window. Close it to quit.")
        try:
            subprocess.run([exe, f"--app={url}", f"--user-data-dir={profile}", "--window-size=1280,760",
                            "--autoplay-policy=no-user-gesture-required", "--no-first-run",
                            "--no-default-browser-check"])
        except KeyboardInterrupt:
            pass
    else:
        webbrowser.open(url)
        if WINDOWED:
            message("The game opened in your browser.\n\nClick OK here when you're done playing to quit.")
        else:
            print("Opened in your browser. Keep this window open while you play; press Ctrl+C to quit.")
            try:
                threading.Event().wait()
            except KeyboardInterrupt:
                pass
    server.shutdown()


if __name__ == "__main__":
    main()
