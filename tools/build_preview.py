#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data/ 폴더의 현재 데이터를 통째로 넣은 '미리보기.html' (더블클릭으로 열리는 단일 파일) 생성
  python tools/build_preview.py            → 미리보기.html
필요: Node.js (npx esbuild 를 자동으로 내려받아 사용)
"""
import json, re, subprocess, sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
data = {}
for p in sorted((ROOT / "data").rglob("*.json")):
    if "cache" in p.parts:
        continue
    data[p.relative_to(ROOT).as_posix()] = json.loads(p.read_text("utf-8"))

js = subprocess.run(["npx", "-y", "esbuild@0.23.1", str(ROOT / "assets/js/main.js"), "--bundle", "--format=iife", "--minify"],
                    capture_output=True, text=True, check=True).stdout
css = (ROOT / "assets/css/style.css").read_text("utf-8")
cfg = (ROOT / "assets/js/config.js").read_text("utf-8")
html = (ROOT / "index.html").read_text("utf-8")
html = html.replace('<link rel="stylesheet" href="assets/css/style.css">', f"<style>{css}</style>")
html = html.replace('<script src="assets/js/config.js"></script>', f"<script>{cfg}</script>")
embed = json.dumps(data, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
js = js.replace("</script", "<\\/script")
# Chart.js(defer) 와 화면 요소가 준비된 뒤 실행
app = "document.addEventListener('DOMContentLoaded',function(){" + js + "});"
html = html.replace('<script type="module" src="assets/js/main.js"></script>',
                    "<script>window.__EMBED__=" + embed + ";</script>\n<script>" + app + "</script>")
html = html.replace("<title>뉴스 인사이트</title>", "<title>뉴스 인사이트 미리보기</title>")
out = ROOT / "미리보기.html"
out.write_text(html, "utf-8")
print(f"✅ {out.name} ({out.stat().st_size // 1024}KB, 데이터 파일 {len(data)}개)")
