#!/usr/bin/env python3
"""
Shrink the converted music from WAV to MP3 (about 10x smaller), for the phone app.
MP3 plays everywhere (PC window, phone app), so this is safe to run on your PC copy too.

    py compress_audio.py            (every season in the data folder)
    py compress_audio.py S02        (just one season)

Needs:  pip install soundfile   (installed automatically if missing)
"""
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")
QUALITY = 0.6   # 0 = best quality / biggest, 1 = smallest


def need(pkg, mod):
    try:
        return __import__(mod)
    except ImportError:
        print(f"Installing {pkg} (one time only)...")
        subprocess.run([sys.executable, "-m", "pip", "install", pkg], check=False)
        return __import__(mod)


def convert(src, dst, sf):
    with sf.SoundFile(src) as fin, sf.SoundFile(dst + ".part", "w", samplerate=fin.samplerate, channels=fin.channels,
                                                format="MP3", subtype="MPEG_LAYER_III", compression_level=QUALITY) as fout:
        # small blocks: the OGG encoder crashes on very large writes
        for block in fin.blocks(blocksize=4096, dtype="float32"):
            fout.write(block)
    os.replace(dst + ".part", dst)


def do_season(sdir, sf):
    meta_path = os.path.join(sdir, "audio.json")
    if not os.path.isfile(meta_path):
        return
    with open(meta_path, encoding="utf-8") as f:
        meta = json.load(f)
    adir = os.path.join(sdir, "audio")
    wavs = sorted({fn for m in meta.values() for fn in m.get("files", []) if fn.lower().endswith((".wav", ".ogg"))})
    print(f"{os.path.basename(sdir)}: {len(wavs)} tracks to convert")
    done = {}
    for i, fn in enumerate(wavs, 1):
        src = os.path.join(adir, fn)
        dst = os.path.join(adir, os.path.splitext(fn)[0] + ".mp3")
        if not os.path.isfile(src):
            if os.path.isfile(dst):
                done[fn] = os.path.basename(dst)
            continue
        print(f"  [{i}/{len(wavs)}] {fn}")
        try:
            convert(src, dst, sf)
            if os.path.getsize(dst) < 1024:
                raise RuntimeError("the result came out empty")
            done[fn] = os.path.basename(dst)
        except Exception as e:
            print(f"    skipped ({e})")
    for m in meta.values():
        m["files"] = [done.get(fn, fn) for fn in m.get("files", [])]
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, ensure_ascii=False, indent=0)
    for fn in done:
        p = os.path.join(adir, fn)
        if os.path.isfile(p):
            os.remove(p)


def main():
    sf = need("soundfile", "soundfile")
    if not os.path.isdir(DATA):
        print("No data folder yet. Run the converter first.")
    else:
        only = [a for a in sys.argv[1:] if not a.startswith("--")]
        for s in sorted(os.listdir(DATA)):
            if not only or s in only:
                do_season(os.path.join(DATA, s), sf)
        print("\nDone.")
    if len(sys.argv) == 1:
        input("Press Enter to close...")
    # (BUILD.bat passes --batch so it doesn't wait)


if __name__ == "__main__":
    main()
