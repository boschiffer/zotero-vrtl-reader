#!/usr/bin/env python3
"""把 plugin/ 打成可安装的 .xpi（xpi 就是 zip，manifest.json 必须在包根）。"""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "plugin"
DIST = ROOT / "dist"

manifest = json.loads((SRC / "manifest.json").read_text(encoding="utf8"))
version = manifest["version"]
out = DIST / f"vrtl-reader-{version}.xpi"
DIST.mkdir(exist_ok=True)

FILES = ["manifest.json", "bootstrap.js"]
missing = [f for f in FILES if not (SRC / f).is_file()]
if missing:
    sys.exit(f"missing files: {missing}")

with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for name in FILES:
        z.write(SRC / name, name)

print(out, out.stat().st_size, "bytes")
with zipfile.ZipFile(out) as z:
    print("entries:", z.namelist())
