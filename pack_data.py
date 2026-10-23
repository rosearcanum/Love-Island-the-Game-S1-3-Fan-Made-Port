#!/usr/bin/env python3
"""
Pack the converted seasons (the "data" folder) into one file, LoveIsland.data, which BUILD.bat
puts inside Love Island.exe and the phone app. Text files are compressed; pictures and music
are already compressed, so they're stored as they are.

    py pack_data.py [output path]
"""
import os
import sys
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")


def main():
    out = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else os.path.join(HERE, "build", "LoveIsland.data")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    seasons = [s for s in sorted(os.listdir(DATA)) if os.path.isfile(os.path.join(DATA, s, "episodes.json"))] if os.path.isdir(DATA) else []
    if not seasons:
        sys.exit("No converted seasons found in the data folder.")
    tmp = out + ".part"
    n = 0
    with zipfile.ZipFile(tmp, "w", allowZip64=True) as z:
        for s in seasons:
            for root, _, files in os.walk(os.path.join(DATA, s)):
                for f in sorted(files):
                    if f.endswith((".part", ".tmp")) or f.lower().endswith(".wav") and os.path.isfile(os.path.join(root, f[:-4] + ".mp3")):
                        continue
                    p = os.path.join(root, f)
                    name = os.path.relpath(p, DATA).replace(os.sep, "/")
                    small = f.endswith((".json", ".txt"))
                    z.write(p, name, compress_type=zipfile.ZIP_DEFLATED if small else zipfile.ZIP_STORED)
                    n += 1
    os.replace(tmp, out)
    print(f"Packed {len(seasons)} seasons ({n} files, {os.path.getsize(out) / 1e6:.0f} MB) into {out}")


if __name__ == "__main__":
    main()
