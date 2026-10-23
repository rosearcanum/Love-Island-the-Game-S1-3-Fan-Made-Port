#!/usr/bin/env python3
"""
Convert the downloaded season packs into files the PC player can read.

    py extract_season.py                         (finds LoveIsland_Seasons and converts every season in it)
    py extract_season.py LoveIsland_Seasons      (same, with the folder given)
    py extract_season.py LoveIsland_Seasons/S02  (just one season)

Writes to  data/S02/  next to this script:
    objects/<bundle>.json   every story/character object, with references as "cab:id" strings
    episodes.json           episode order and where each episode's story lives
    sprites/ + sprites.json character layer images with their pivot points
    backgrounds/ + backgrounds.json
    audio/ + audio.json     (skip with --no-audio)
    thumbs/                 episode thumbnails

Needs:  pip install UnityPy
"""
import argparse
import json
import os
import re
import sys
import time

def _ensure_unitypy():
    try:
        import UnityPy  # noqa: F401
        return
    except ImportError:
        pass
    import subprocess
    import shutil
    # UnityPy has no ready-made build for brand-new Pythons yet. If an older one is installed,
    # rerun this script with it, however the script was started.
    if sys.version_info >= (3, 15) and not os.environ.get("LI_RELAUNCHED"):
        env = dict(os.environ, LI_RELAUNCHED="1", PYTHON_MANAGER_AUTOMATIC_INSTALL="false")
        la = os.environ.get("LOCALAPPDATA", "")
        candidates = []
        for v, n in (("3.14", "314"), ("3.13", "313"), ("3.12", "312")):
            for exe in (os.path.join(la, "Python", f"pythoncore-{v}-64", "python.exe"),
                        os.path.join(la, "Programs", "Python", f"Python{n}", "python.exe")):
                if os.path.isfile(exe):
                    candidates.append(([exe], v))
            candidates.append((["py", "-" + v], v))
        for cmd, v in candidates:
            ok = subprocess.run(cmd + ["-c", "import sys"], stdin=subprocess.DEVNULL,
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env).returncode == 0
            if ok:
                print(f"Python {sys.version_info.major}.{sys.version_info.minor} is too new for the converter; using Python {v} instead.\n")
                r = subprocess.run(cmd + [os.path.abspath(__file__)] + sys.argv[1:], env=env)
                sys.exit(r.returncode)
    print("This needs the UnityPy library. Installing it now (one time only)...")
    r = subprocess.run([sys.executable, "-m", "pip", "install", "UnityPy"])
    if r.returncode != 0:
        print("\nCouldn't install UnityPy automatically.")
        print(f"This Python ({sys.version_info.major}.{sys.version_info.minor}) is probably too new for it.")
        print("Install Python 3.14 alongside it (in cmd:  py install 3.14  or get it from python.org),")
        print("then double-click '1 - Convert seasons.bat' again. It picks 3.14 automatically.")
        input("\nPress Enter to close...")
        sys.exit(1)


_ensure_unitypy()
import UnityPy  # noqa: E402
try:
    # UnityPy's fast C reader crashes on some of these story files; use the safe Python reader.
    import UnityPy.helpers.TypeTreeHelper as _tth
    _tth.read_typetree_boost = None
except Exception:
    pass

HERE = os.path.dirname(os.path.abspath(__file__))
EXTRAS_VERSION = 3   # bump when new kinds of files are added, so older conversions get topped up

# Editor-only fields that the player never needs.
STRIP = {
    "m_GameObject", "m_Enabled", "m_Script", "guid", "guidHash", "position", "scrollPosition",
    "parentPosition", "anyStatePosition", "entryPosition", "exitPosition", "childGraphPositions",
    "uniqueNameHash", "keyTags",
}


def safe_name(s):
    return re.sub(r"[^A-Za-z0-9_.-]+", "_", s)[:150]


class Bundle:
    def __init__(self, path):
        self.path = path
        self.name = os.path.basename(path)
        self.env = UnityPy.load(path)
        self.files = [f for f in self.env.assets]
        self.objects = {}
        self.container = {}
        for f in self.files:
            for o in f.objects.values():
                self.objects[o.path_id] = o
        self.af = self.files[0]
        self.cab = self.af.name.lower()
        self.ext = [e.path.split("/")[-1].lower() for e in self.af.externals]
        for o in self.objects.values():
            if o.type.name == "AssetBundle":
                for p, info in o.read_typetree()["m_Container"]:
                    self.container[p.lower()] = info["asset"]["m_PathID"]

    def ref(self, r):
        fid, pid = r.get("m_FileID", 0), r.get("m_PathID", 0)
        if not pid:
            return None
        cab = self.cab if fid == 0 else (self.ext[fid - 1] if fid - 1 < len(self.ext) else f"ext{fid}")
        return f"{cab}:{pid}"

    def clean(self, v):
        if isinstance(v, dict):
            if set(v.keys()) == {"m_FileID", "m_PathID"}:
                return self.ref(v)
            return {k: self.clean(x) for k, x in v.items() if k not in STRIP}
        if isinstance(v, list):
            return [self.clean(x) for x in v]
        if isinstance(v, float) and v.is_integer():
            return int(v)
        return v

    def class_of(self, o):
        try:
            return o.read(check_read=False).m_Script.read().m_ClassName
        except Exception:
            return None


def export_objects(b, outdir, effect_pids=None, map_refs=None):
    out = {}
    controllers = []
    for pid, o in b.objects.items():
        if o.type.name != "MonoBehaviour":
            continue
        cls = b.class_of(o)
        if not cls:
            continue
        try:
            t = o.read_typetree()
        except Exception:
            continue
        d = b.clean(t)
        d["_c"] = cls
        out[str(pid)] = d
        if cls == "BaseParticleEffect" and effect_pids is not None:
            effect_pids.append(pid)
        if cls == "OpenWorldNode" and map_refs is not None:
            r = (t.get("overrideBackground") or {})
            if r.get("m_PathID") and not r.get("m_FileID"):
                map_refs.add(r["m_PathID"])
        if cls == "StoryController":
            controllers.append({"id": d.get("id"), "key": f"{b.cab}:{pid}", "bundle": b.name,
                                "name": d.get("m_Name")})
    with open(os.path.join(outdir, "objects", b.name + ".json"), "w", encoding="utf-8") as f:
        json.dump({"cab": b.cab, "bundle": b.name, "objects": out}, f, ensure_ascii=False,
                  separators=(",", ":"))
    return controllers, len(out)


def export_sprites(b, outdir, meta):
    by_pid = {v: k for k, v in b.container.items()}
    n = 0
    for pid, o in b.objects.items():
        if o.type.name != "Sprite":
            continue
        path = by_pid.get(pid)
        try:
            s = o.read()
            img = s.image
        except Exception:
            continue
        fname = safe_name(os.path.splitext(os.path.basename(path))[0] if path else s.m_Name) + f"_{abs(pid) % 100000}.png"
        img.save(os.path.join(outdir, "sprites", fname))
        info = {"file": fname, "w": img.width, "h": img.height,
                "px": float(s.m_Pivot.x), "py": float(s.m_Pivot.y)}
        meta[f"{b.cab}:{pid}"] = info
        if path:
            meta[path] = info
        n += 1
    return n


def export_textures_for(b, pid, outdir, sub, stem):
    o = b.objects.get(pid)
    if not o or o.type.name != "Texture2D":
        return None
    tex = o.read()
    img = tex.image
    has_alpha = img.mode in ("RGBA", "LA") and img.getextrema()[-1][0] < 255
    fname = safe_name(stem) + (".png" if has_alpha else ".jpg")
    dest = os.path.join(outdir, sub, fname)
    if has_alpha:
        img.save(dest)
    else:
        img.convert("RGB").save(dest, quality=90)
    return fname


def export_effects(b, outdir, meta, pids):
    """Emoji bursts ("explojis"): the emoji picture plus the particle settings the game used."""
    n = 0
    for pid in pids:
        o = b.objects.get(pid)
        try:
            e = o.read_typetree()
        except Exception:
            continue
        tex_pid = (e.get("texture") or {}).get("m_PathID") if e.get("overrideTexture") else 0
        ps = {}
        go = b.objects.get((e.get("model") or {}).get("m_PathID", 0))
        if go:
            for comp in go.read_typetree().get("m_Component", []):
                c = b.objects.get(comp["component"]["m_PathID"])
                if not c:
                    continue
                if c.type.name == "ParticleSystemRenderer" and not tex_pid:
                    for m in c.read_typetree().get("m_Materials", []):
                        mo = b.objects.get(m.get("m_PathID", 0))
                        if not mo:
                            continue
                        for name, env in mo.read_typetree()["m_SavedProperties"]["m_TexEnvs"]:
                            if name == "_MainTex" and env["m_Texture"]["m_PathID"]:
                                tex_pid = env["m_Texture"]["m_PathID"]
                elif c.type.name == "ParticleSystem":
                    try:
                        t = c.read_typetree()
                        init = t.get("InitialModule", {})
                        bursts = t.get("EmissionModule", {}).get("m_Bursts", [])
                        ps = {
                            "lifetime": init.get("startLifetime", {}).get("scalar"),
                            "speed": init.get("startSpeed", {}).get("scalar"),
                            "size": init.get("startSize", {}).get("scalar"),
                            "gravity": init.get("gravityModifier", {}).get("scalar"),
                            "count": sum((x.get("countCurve", {}) or {}).get("scalar", 0) or 0 for x in bursts) or None,
                            "looping": bool(t.get("looping")),
                        }
                    except Exception:
                        pass
        tex = None
        to = b.objects.get(tex_pid) if tex_pid else None
        if to and to.type.name == "Texture2D":
            tname = to.read().m_Name
            tex = safe_name(tname) + ".png"
            dest = os.path.join(outdir, "effects", tex)
            if not os.path.exists(dest):
                to.read().image.save(dest)
        if not tex:
            continue
        flags = {k: bool(e.get("override" + k.capitalize())) for k in ("count", "size", "speed", "duration", "position")}
        meta[f"{b.cab}:{pid}"] = {
            "name": e.get("m_Name"), "tex": tex, "ps": ps, "use": flags,
            "count": e.get("particleCount"), "size": e.get("particleSize"), "speed": e.get("particleSpeed"),
            "duration": e.get("particleDuration"),
        }
        n += 1
    return n


def export_map_pictures(b, outdir, meta, pids):
    """Villa map pictures used by "choose where to go" scenes (stored as plain pictures in story packs)."""
    n = 0
    for pid in pids:
        key = f"{b.cab}:{pid}"
        if key in meta:
            continue
        o = b.objects.get(pid)
        if not o or o.type.name != "Texture2D":
            continue
        name = o.read().m_Name
        f = export_textures_for(b, pid, outdir, "backgrounds", name.lower())
        if f:
            meta[key] = {"name": name, "files": [f]}
            n += 1
    return n


def export_texts(b, meta):
    """Text files inside story packs (localisation tables and the like). Some lines are stored as a key such as
    "AJ.2.I.was.wondering.li" and the player looks their wording up here."""
    n = 0
    for pid, o in b.objects.items():
        if o.type.name != "TextAsset":
            continue
        try:
            t = o.read()
            s = getattr(t, "m_Script", None)
            if s is None:
                s = getattr(t, "script", b"")
            if isinstance(s, (bytes, bytearray)):
                s = bytes(s).decode("utf-8", "replace")
            else:
                s = str(s).encode("utf-8", "surrogateescape").decode("utf-8", "replace")
        except Exception:
            continue
        if not s.strip() or len(s) > 8_000_000 or "\x00" in s[:2000]:
            continue
        meta[f"{b.cab}:{pid}"] = {"name": getattr(t, "m_Name", ""), "text": s}
        n += 1
    return n


def export_backgrounds(b, outdir, meta):
    n = 0
    for path, pid in b.container.items():
        o = b.objects.get(pid)
        if not o or o.type.name != "MonoBehaviour" or b.class_of(o) != "BackgroundSettings":
            continue
        bs = o.read_typetree()
        go = b.objects.get(bs["model"]["m_PathID"])
        if not go:
            continue
        files = []
        for comp in go.read_typetree()["m_Component"]:
            c = b.objects.get(comp["component"]["m_PathID"])
            if c and c.type.name == "MonoBehaviour":
                t = c.read_typetree()
                if "m_Texture" in t and t["m_Texture"]["m_PathID"]:
                    f = export_textures_for(b, t["m_Texture"]["m_PathID"], outdir, "backgrounds",
                                            os.path.splitext(os.path.basename(path))[0])
                    if f:
                        files.append(f)
        if files:
            info = {"name": bs.get("m_Name"), "files": files}
            meta[path] = info
            meta[f"{b.cab}:{pid}"] = info
            n += 1
    return n


def export_audio(b, outdir, meta):
    n = 0
    clips = {}
    for pid, o in b.objects.items():
        if o.type.name == "MonoBehaviour" and b.class_of(o) == "AudioObject":
            t = o.read_typetree()
            files = []
            for ac in t.get("audioClips", []):
                cpid = ac["clip"]["m_PathID"]
                if cpid not in clips:
                    co = b.objects.get(cpid)
                    if not co:
                        continue
                    clip = co.read()
                    try:
                        samples = clip.samples
                    except Exception as e:
                        print(f"    could not decode audio {clip.m_Name}: {e}")
                        continue
                    for name, data in samples.items():
                        fname = safe_name(name)
                        with open(os.path.join(outdir, "audio", fname), "wb") as f:
                            f.write(data)
                        clips[cpid] = fname
                        n += 1
                        break
                if cpid in clips:
                    files.append(clips[cpid])
            meta[f"{b.cab}:{pid}"] = {"name": t.get("m_Name"), "files": files,
                                      "loop": t.get("loopType", 0) != 0, "volume": t.get("volume", 1)}
    # AudioSettings -> AudioObject
    for pid, o in b.objects.items():
        if o.type.name == "MonoBehaviour" and b.class_of(o) == "AudioSettings":
            t = o.read_typetree()
            target = meta.get(f"{b.cab}:{t['audio']['m_PathID']}")
            if target:
                meta[f"{b.cab}:{pid}"] = target
    return n


def export_thumbs(b, outdir, episodes):
    for ep in episodes:
        ref = ep.get("thumb")
        if not ref or not ref.startswith(b.cab + ":"):
            continue
        pid = int(ref.split(":")[1])
        f = export_textures_for(b, pid, outdir, "thumbs", ep["key"])
        ep["thumbFile"] = f


def music_broken(outdir):
    """True if music files are missing, or were shrunk to OGG (which some Windows browsers can't play)."""
    p = os.path.join(outdir, "audio.json")
    if not os.path.isfile(p):
        return False
    with open(p, encoding="utf-8") as f:
        meta = json.load(f)
    files = {fn for m in meta.values() for fn in m.get("files", [])}
    return any(fn.lower().endswith(".ogg") or not os.path.isfile(os.path.join(outdir, "audio", fn)) for fn in files)


def repair_audio(sdir, outdir):
    """Export the music again from the season's audio pack (as WAV)."""
    names = [n for n in os.listdir(sdir) if n.endswith("_audio")]
    if not names:
        return
    print(f"{os.path.basename(outdir)}: restoring the music...", flush=True)
    for fn in os.listdir(os.path.join(outdir, "audio")):
        if fn.lower().endswith(".ogg"):
            os.remove(os.path.join(outdir, "audio", fn))
    audio = {}
    b = Bundle(os.path.join(sdir, names[0]))
    n = export_audio(b, outdir, audio)
    with open(os.path.join(outdir, "audio.json"), "w", encoding="utf-8") as f:
        json.dump(audio, f, ensure_ascii=False, indent=0)
    print(f"  {n} tracks restored")


def find_seasons(path):
    """Return the season folders (S01, S02...) at or under path."""
    path = os.path.abspath(path)
    if os.path.isfile(os.path.join(path, "Android")) or any(n.endswith("_stories") for n in os.listdir(path)):
        return [path]
    found = [os.path.join(path, n) for n in sorted(os.listdir(path))
             if re.fullmatch(r"S\d+", n) and os.path.isdir(os.path.join(path, n))]
    if not found:
        # Unzipping often adds an extra folder layer (LoveIsland_Seasons\LoveIsland_Seasons\S01): look one level down.
        for n in sorted(os.listdir(path)):
            inner = os.path.join(path, n)
            if os.path.isdir(inner) and any(re.fullmatch(r"S\d+", m) for m in os.listdir(inner)):
                return find_seasons(inner)
    return found


def default_source():
    home = os.path.expanduser("~")
    for c in (os.path.join(HERE, "LoveIsland_Seasons"), os.path.join(os.path.dirname(HERE), "LoveIsland_Seasons"),
              os.path.join(home, "Downloads", "LoveIsland_Seasons"), os.path.join(home, "Desktop", "LoveIsland_Seasons")):
        if os.path.isdir(c):
            return c
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("source", nargs="?", help="LoveIsland_Seasons folder, or one season folder like .../S02")
    ap.add_argument("--out", default=os.path.join(HERE, "data"))
    ap.add_argument("--no-audio", action="store_true", help="skip music (saves about 1.5 GB)")
    ap.add_argument("--force", action="store_true", help="convert again even if already done")
    ap.add_argument("--batch", action="store_true", help="don't wait for Enter at the end (used by BUILD.bat)")
    args = ap.parse_args()
    double_clicked = args.source is None and not args.batch

    src = args.source or default_source()
    if not src or not os.path.isdir(src):
        print("Couldn't find the LoveIsland_Seasons folder.")
        print("Put it next to this folder or in Downloads, or run:  py extract_season.py <path to LoveIsland_Seasons>")
        if double_clicked:
            input("\nPress Enter to close...")
        return
    seasons = find_seasons(src)
    if not seasons:
        print(f"No season folders (S01, S02...) found in {src}")
    for sdir in seasons:
        name = os.path.basename(sdir.rstrip("/\\"))
        done_before = os.path.isfile(os.path.join(args.out, name, "episodes.json"))
        if not args.force and done_before:
            if not args.no_audio and music_broken(os.path.join(args.out, name)):
                try:
                    repair_audio(sdir, os.path.join(args.out, name))
                except Exception as e:
                    print(f"{name}: couldn't repair the music ({e})")
            ver_file = os.path.join(args.out, name, "extras.txt")
            ver = int(open(ver_file).read().strip() or 0) if os.path.isfile(ver_file) else 0
            if ver >= EXTRAS_VERSION:
                print(f"{name}: already converted (use --force to redo)")
                continue
            args.effects_only = True     # converted with an older version: just add the newest extras
            args.extras_have = ver
        try:
            extract(sdir, args)
        except Exception as e:
            print(f"\n{name} failed: {e}")
        args.effects_only = False
    print("\nAll done. Start the game with play.py.")
    if double_clicked:
        input("\nPress Enter to close...")


def extract(sdir, args):
    sdir = os.path.abspath(sdir)
    season = os.path.basename(sdir.rstrip("/\\"))
    outdir = os.path.join(args.out, season)
    for sub in ("objects", "sprites", "backgrounds", "audio", "thumbs", "effects"):
        os.makedirs(os.path.join(outdir, sub), exist_ok=True)

    names = sorted(n for n in os.listdir(sdir) if not n.startswith(".") and n not in ("Android", "iOS")
                   and not n.endswith(".part"))
    print(f"Extracting {season}: {len(names)} packs -> {outdir}")
    controllers, sprites, bgs, audio, cabs, effects, texts = [], {}, {}, {}, {}, {}, {}
    if getattr(args, "effects_only", False):
        have = getattr(args, "extras_have", 0)
        need_fx = have < 2
        print(f"Adding the newest extras to {season} ({'emoji reactions, villa maps, ' if need_fx else ''}story text tables)...")
        bg_path = os.path.join(outdir, "backgrounds.json")
        bgs = json.load(open(bg_path, encoding="utf-8")) if os.path.isfile(bg_path) else {}
        for n in names:
            if "_stories" not in n:
                continue
            b = Bundle(os.path.join(sdir, n))
            k = m = 0
            if need_fx:
                pids, maps = [], set()
                for pid, o in b.objects.items():
                    if o.type.name != "MonoBehaviour":
                        continue
                    cls = b.class_of(o)
                    if cls == "BaseParticleEffect":
                        pids.append(pid)
                    elif cls == "OpenWorldNode":
                        try:
                            r = o.read_typetree().get("overrideBackground") or {}
                            if r.get("m_PathID") and not r.get("m_FileID"):
                                maps.add(r["m_PathID"])
                        except Exception:
                            pass
                k = export_effects(b, outdir, effects, pids)
                m = export_map_pictures(b, outdir, bgs, maps)
            t = export_texts(b, texts)
            print(f"  {n}: " + (f"{k} effects, {m} maps, " if need_fx else "") + f"{t} text tables")
            del b
        if need_fx:
            with open(os.path.join(outdir, "effects.json"), "w", encoding="utf-8") as f:
                json.dump(effects, f, ensure_ascii=False, indent=0)
            with open(bg_path, "w", encoding="utf-8") as f:
                json.dump(bgs, f, ensure_ascii=False, indent=0)
        with open(os.path.join(outdir, "texts.json"), "w", encoding="utf-8") as f:
            json.dump(texts, f, ensure_ascii=False, indent=0)
        with open(os.path.join(outdir, "extras.txt"), "w") as f:
            f.write(str(EXTRAS_VERSION))
        print(f"Done: {len(texts)} text tables" + (f", {len(effects)} emoji effects." if need_fx else "."))
        return
    ipmeta = None
    t0 = time.time()
    for n in names:
        print(f"  {n} ...", end="", flush=True)
        b = Bundle(os.path.join(sdir, n))
        cabs[b.cab] = n
        if n.endswith("_audio"):
            if not args.no_audio:
                print(f" {export_audio(b, outdir, audio)} clips", end="")
            c, k = export_objects(b, outdir)
        elif n.endswith("_backgrounds"):
            print(f" {export_backgrounds(b, outdir, bgs)} backgrounds", end="")
            c, k = export_objects(b, outdir)
        elif n.endswith("_avatars"):
            print(f" {export_sprites(b, outdir, sprites)} sprites", end="")
            c, k = export_objects(b, outdir)
        else:
            export_sprites(b, outdir, sprites)   # choice pictures and icons live in story packs too
            export_texts(b, texts)
            pids, maps = [], set()
            c, k = export_objects(b, outdir, pids, maps)
            if pids:
                print(f" {export_effects(b, outdir, effects, pids)} effects", end="")
            if maps:
                export_map_pictures(b, outdir, bgs, maps)
            if n.endswith("_ip_metadata"):
                ipmeta = b
        controllers += c
        print(f" {k} objects")
        del b

    # Episode list from the season info pack.
    episodes = []
    by_id = {c["id"]: c for c in controllers}
    with open(os.path.join(outdir, "objects", ipmeta.name + ".json"), encoding="utf-8") as f:
        meta_objs = json.load(f)["objects"]
    for d in meta_objs.values():
        if d["_c"] != "EpisodeInformation":
            continue
        key = d.get("episodeMetadataKey", "")
        m = re.search(r"D(\d+)E(\d+)", key)
        ctrl = by_id.get(d.get("storyControllerId"))
        episodes.append({
            "key": key, "name": d.get("m_Name"),
            "day": int(m.group(1)) if m else 0, "ep": int(m.group(2)) if m else 0,
            "controllerId": d.get("storyControllerId"),
            "controller": ctrl["key"] if ctrl else None,
            "bundle": ctrl["bundle"] if ctrl else None,
            "loadingBackground": (d.get("loadingScreenBackground") or "").lower(),
            "abAlt": bool(d.get("isABTestAlt")), "thumb": d.get("episodeThumbnail"),
        })
    episodes.sort(key=lambda e: (e["day"], e["ep"], e["abAlt"], e["name"] or ""))
    ipb = Bundle(os.path.join(sdir, ipmeta.name))
    export_thumbs(ipb, outdir, episodes)

    def dump(name, obj):
        with open(os.path.join(outdir, name), "w", encoding="utf-8") as f:
            json.dump(obj, f, ensure_ascii=False, indent=0)

    dump("episodes.json", episodes)
    dump("controllers.json", controllers)
    dump("sprites.json", sprites)
    dump("backgrounds.json", bgs)
    dump("audio.json", audio)
    dump("cabs.json", cabs)
    dump("effects.json", effects)
    dump("texts.json", texts)
    with open(os.path.join(outdir, "extras.txt"), "w") as f:
        f.write(str(EXTRAS_VERSION))
    missing = [e["key"] for e in episodes if not e["controller"]]
    print(f"\nDone in {time.time() - t0:.0f}s: {len(episodes)} episodes, {len(controllers)} story controllers,"
          f" {len(sprites)//2} sprites, {len(bgs)//2} backgrounds.")
    if missing:
        print(f"  Note: {len(missing)} episodes had no matching story: {', '.join(missing[:10])}")


if __name__ == "__main__":
    main()
