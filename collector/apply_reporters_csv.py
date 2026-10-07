#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Colab '기자명 채우기' 노트북이 만든 reporters.csv 를 데이터에 반영합니다.
  python collector/apply_reporters_csv.py reporters.csv
CSV 열: oid, aid, 입력시각(YYYY-MM-DD HH:MM), 기자
"""
import csv
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
from store import DATA  # noqa: E402


def main(path):
    info = {}
    with open(path, encoding="utf-8-sig") as fp:
        for r in csv.DictReader(fp):
            info[(r["oid"].zfill(3), r["aid"])] = (r.get("입력시각", ""), r.get("기자", "").strip())
    touched, n_rep = set(), 0
    for kind in ("ranking", "articles"):
        for p in sorted((DATA / kind).glob("*.json")):
            doc = store.read_json(p)
            changed = False
            for r in doc["items"]:
                m = info.get((r[0], r[1]))
                if not m:
                    continue
                pub, rep = m
                ri = 5 if kind == "ranking" else 4
                if rep and r[ri] != rep:
                    r[ri] = rep; changed = True; n_rep += 1
                if kind == "ranking" and pub and not r[6]:
                    r[6] = pub; changed = True
                if kind == "articles" and pub and not r[2] and pub[:10] == p.stem:
                    r[2] = pub[11:16]; changed = True
            if changed:
                store.write_json(p, doc)
                touched.add(p.stem)
    store.rebuild(touched)
    store.build_meta()
    print(f"✅ 기자명 {n_rep}건 반영 ({len(touched)}일)")


if __name__ == "__main__":
    main(sys.argv[1])
