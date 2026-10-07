#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
기자명 채우기 – 이미 저장된 기사(엑셀에서 가져온 과거 자료 등) 중 기자명이 빈 기사만
네이버 기사 페이지를 열어 바이라인을 읽고 채웁니다. 발행시각이 비어 있으면 함께 채웁니다.

  python collector/fill_reporters.py                      # 전체
  python collector/fill_reporters.py --start 2026-09-21 --end 2026-09-30
  python collector/fill_reporters.py --only ranking       # 랭킹 기사만 (빠름)

한 번 확인한 기사는 data/cache 에 저장되어 다시 조회하지 않습니다.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
from store import CONFIG, DATA  # noqa: E402
import collect  # noqa: E402


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start")
    ap.add_argument("--end")
    ap.add_argument("--only", choices=["ranking", "publish"])
    a = ap.parse_args()

    kinds = [k for k in ("ranking", "articles") if not a.only or (a.only == "ranking") == (k == "ranking")]
    files = []
    for k in kinds:
        for p in sorted((DATA / k).glob("*.json")):
            if (a.start and p.stem < a.start) or (a.end and p.stem > a.end):
                continue
            files.append((k, p))

    # 기자명이 빈 기사 모으기
    need = set()
    docs = {}
    for k, p in files:
        doc = store.read_json(p)
        docs[(k, p)] = doc
        for r in doc["items"]:
            rep = r[5] if k == "ranking" else r[4]
            if not rep:
                need.add((r[0], r[1]))
    print(f"기자명이 빈 기사 {len(need)}건 확인 시작 (파일 {len(files)}개)")

    workers = CONFIG.get("workers", 8)
    session = collect.make_session(workers)
    cache = collect.load_cache()
    try:
        fails = collect.resolve_meta(session, list(need), cache, workers)
    finally:
        collect.save_cache(cache)
    print(f"  상세 확인 실패 {fails}건")

    filled = 0
    for (k, p), doc in docs.items():
        changed = False
        for r in doc["items"]:
            m = cache.get(f"{r[0]}_{r[1]}")
            if not m:
                continue
            pub, rep = m
            if k == "ranking":
                if rep and not r[5]:
                    r[5] = rep; changed = True; filled += 1
                if pub and not r[6]:
                    r[6] = pub; changed = True
            else:
                if rep and not r[4]:
                    r[4] = rep; changed = True; filled += 1
                if pub and not r[2] and pub[:10] == p.stem:
                    r[2] = pub[11:16]; changed = True
        if changed:
            store.write_json(p, doc)
    store.rebuild([p.stem for _, p in files])
    store.build_meta()
    print(f"✅ 기자명 {filled}건 채움")


if __name__ == "__main__":
    main()
