"""
마스터가 올린 통계 파일(엑셀 → 사이트에서 JSON으로 변환된 data/uploads/stats/*.json)을 수집 데이터에 반영.

원칙: 사이트가 직접 수집한 데이터가 우선. 업로드 파일은 '수집이 비어 있는 곳'만 채운다.
  - 랭킹: 그날 그 매체 랭킹이 없으면 업로드 랭킹(순위·조회수·제목)을 넣는다
  - 발행: 그날 그 매체 발행 건수가 없으면 업로드 건수를 넣고, 기사 제목·시각도 채운다
  - 값이 다르면 바꾸지 않고 '차이'로 기록 → 관리자 > 통계 업로드에서 확인
결과 기록: data/uploads/stats/applied.json

  python collector/uploads.py            # 모든 업로드 반영
  python collector/uploads.py --no-build # 요약 다시 만들기 생략(수집 워크플로에서 따로 할 때)
"""
import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
from store import DATA, CONFIG  # noqa: E402

UP = DATA / "uploads" / "stats"


def load_uploads():
    out = []
    for p in sorted(UP.glob("*.json")):
        if p.name in ("index.json", "applied.json"):
            continue
        try:
            d = json.loads(p.read_text("utf-8"))
        except Exception as e:
            print("읽기 실패", p.name, e)
            continue
        if d.get("id"):
            out.append(d)
    return out


def apply_ranking(up, day, per, rep, touched):
    path = store.ranking_path(day)
    doc = store.read_json(path, {"date": day, "media": {}, "items": []})
    have = {r[0] for r in doc["items"]}
    add = []
    for oid, m in per.items():
        items = m.get("items") or []
        if not items:
            continue
        if oid in have and (doc["media"].get(oid) or {}).get("upload") == up["id"]:
            rep["filled"].append({"day": day, "oid": oid, "type": "랭킹", "n": len(items)})
            continue
        if oid in have:
            mine = {r[1]: r for r in doc["items"] if r[0] == oid}
            diff = sum(1 for it in items if it[0] in mine and it[2] and mine[it[0]][3] not in (None, it[2]))
            miss = sum(1 for it in items if it[0] not in mine)
            src = (doc["media"].get(oid) or {}).get("src")
            rep["same" if not miss and not diff else "diff"].append({"day": day, "oid": oid, "type": "랭킹", "miss": miss, "diff": diff, "src": src or "수집"})
            continue
        for it in items:
            aid, rank, views, title = it[0], it[1], it[2], it[3]
            add.append([oid, aid, rank, views if views else None, title, "", ""])
        doc["media"][oid] = {"collected_at": up.get("at"), "n": len(items), "final": True, "src": "upload", "upload": up["id"]}
        rep["filled"].append({"day": day, "oid": oid, "type": "랭킹", "n": len(items)})
    if add:
        doc["items"] = sorted(doc["items"] + add, key=lambda r: (r[0], r[2]))
        doc["final"] = all(v.get("final") for v in doc["media"].values())
        doc.setdefault("collected_at", up.get("at"))
        store.write_json(path, doc)
        touched.add(day)


def apply_publish(up, day, per, rep, touched):
    cpath = store.counts_path(day)
    cdoc = store.read_json(cpath, {"date": day, "media": {}})
    adoc = store.read_json(store.articles_path(day), {"date": day, "media": {}, "items": []})
    detail = {}
    for r in adoc["items"]:
        detail[r[0]] = detail.get(r[0], 0) + 1
    changed = False
    for oid, m in per.items():
        n = m.get("n")
        items = m.get("items") or []
        if n is None:
            n = len(items)
        if (cdoc["media"].get(oid) or {}).get("upload") == up["id"]:
            rep["filled"].append({"day": day, "oid": oid, "type": "발행", "n": n})
            continue
        mine = detail.get(oid) or (cdoc["media"].get(oid) or {}).get("n")
        if mine:
            src = (cdoc["media"].get(oid) or {}).get("src")
            rep["same" if mine == n else "diff"].append({"day": day, "oid": oid, "type": "발행", "site": mine, "upload": n, "src": src or "수집"})
            continue
        if not n:
            continue
        cdoc["media"][oid] = {"n": n, "at": up.get("at"), "src": "upload", "upload": up["id"]}
        changed = True
        if items:
            if oid in CONFIG["publish_media"]:
                # 상세 수집 매체: 기사 목록(시각·제목)을 넣어 둔다. 기자명은 다음 상세 수집 때 채워짐
                store.merge_articles(day, oid, [(oid, it[0], it[1] or "", it[2], "") for it in items], up.get("at"), src=up["id"])
            else:
                tdoc = store.read_json(DATA / "titles" / day[:7] / f"{oid}.json", {}) or {}
                if day not in tdoc:
                    store.save_titles(oid, {day: [[it[0], it[2]] for it in items]})
        rep["filled"].append({"day": day, "oid": oid, "type": "발행", "n": n})
    if changed:
        store.write_json(cpath, cdoc)
        touched.add(day)


def cleanup(valid):
    """삭제된 업로드 파일로 채웠던 데이터는 되돌린다 (직접 수집한 데이터는 건드리지 않음)"""
    touched = set()
    for sub in ("ranking", "counts", "articles"):
        for p in sorted((DATA / sub).glob("*.json")):
            doc = store.read_json(p)
            if not doc:
                continue
            gone = [o for o, m in doc.get("media", {}).items() if isinstance(m, dict) and m.get("src") == "upload" and m.get("upload") not in valid]
            if not gone:
                continue
            for o in gone:
                doc["media"].pop(o)
            if "items" in doc:
                doc["items"] = [r for r in doc["items"] if r[0] not in gone]
            store.write_json(p, doc)
            touched.add(p.stem)
    return touched


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--no-build", action="store_true")
    a = ap.parse_args()
    ups = load_uploads()
    applied, touched = {}, cleanup({u["id"] for u in ups})
    for up in ups:
        rep = {"filled": [], "same": [], "diff": []}
        for day, per in sorted((up.get("ranking") or {}).items()):
            apply_ranking(up, day, per, rep, touched)
        for day, per in sorted((up.get("publish") or {}).items()):
            apply_publish(up, day, per, rep, touched)
        applied[up["id"]] = {"name": up.get("name"), "kind": up.get("kind"), "at": store.now_kst().isoformat(timespec="seconds"),
                             "filled": rep["filled"], "same": len(rep["same"]), "diff": rep["diff"][:200]}
        print(f"{up.get('name')}: 채움 {len(rep['filled'])} · 일치 {len(rep['same'])} · 차이 {len(rep['diff'])}")
    if ups:
        store.write_json(UP / "applied.json", {"updated_at": store.now_kst().isoformat(timespec="seconds"), "uploads": applied}, pretty=True)
    if touched and not a.no_build:
        store.rebuild(touched)
        store.build_meta()
    print("반영한 날짜:", ", ".join(sorted(touched)) or "없음")


if __name__ == "__main__":
    main()
