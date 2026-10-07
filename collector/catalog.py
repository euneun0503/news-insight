"""
네이버 뉴스 언론사 목록(카테고리별) + 매체마다 랭킹/조회수 제공 여부를 조사해 data/media_catalog.json 에 저장.

  python collector/catalog.py            # 목록 갱신
  python collector/catalog.py --check    # + 발행 수 빠른 집계(목록만) vs 상세 확인 집계 비교

출처
 1) 네이버 언론사 목록 페이지(카테고리 제목 아래 언론사 링크)
 2) 언론사 코드(oid) 001~999 를 media.naver.com/press/{oid}/ranking 으로 하나씩 확인 (목록에 없는 매체 보완)
 3) 카테고리를 페이지에서 못 읽으면 아래 기본 분류표 → 그래도 없으면 '기타'
"""
import argparse
import datetime as dt
import json
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
from store import DATA, today_kst  # noqa: E402
import collect  # noqa: E402

CATS = ["종합", "방송/통신", "경제", "인터넷/IT", "매거진", "전문지", "지역", "외신", "포토", "기타"]
CAT_RE = re.compile(r"^\s*(종합|방송\s*[/·]?\s*통신|경제|인터넷\s*[/·]?\s*IT|IT|매거진|전문지|지역|외신|포토)\s*$")

# 페이지에서 카테고리를 못 읽을 때 쓰는 기본 분류 (네이버 언론사 편집판 분류 기준)
DEFAULT_CAT = {
    "종합": "032 005 020 021 081 022 023 025 028 469",
    "방송/통신": "421 003 001 422 449 215 437 056 214 057 055 374 448 052",
    "경제": "009 008 648 011 277 018 366 123 014 015 016",
    "인터넷/IT": "079 629 119 417 006 031 047 002 138 029 293 030 092",
    "매거진": "145 024 308 586 262 094 243 033 037 053 353 036 050",
    "전문지": "127 662 607 640 044 296 346 584 310",
    "지역": "087 654 082 088 656 666 658 657 659 660 655 661",
}
DEFAULT_CAT = {oid: c for c, s in DEFAULT_CAT.items() for oid in s.split()}

LIST_PAGES = [
    "https://news.naver.com/main/officeList.naver",
    "https://media.naver.com/channel/settings",
]


def norm_cat(t):
    t = re.sub(r"\s+", "", t).replace("·", "/")
    if t in ("IT", "인터넷IT"):
        return "인터넷/IT"
    if t == "방송통신":
        return "방송/통신"
    return t


def from_pages(session, debug):
    """목록 페이지에서 (oid, 이름, 카테고리) 수집 — 문서 순서대로 훑으며 가장 최근 카테고리 제목을 붙인다"""
    found = {}
    for url in LIST_PAGES:
        try:
            r = session.get(url, timeout=20)
            debug[url] = {"status": r.status_code, "final": r.url, "len": len(r.text)}
            (DATA / "cache").mkdir(parents=True, exist_ok=True)
            (DATA / "cache" / f"catalog_{len(debug)}.html").write_text(r.text[:400000], "utf-8")
            if r.status_code != 200:
                continue
            soup = BeautifulSoup(r.text, "html.parser")
            cat = None
            for el in soup.find_all(True):
                if el.name in ("h2", "h3", "h4", "h5", "dt", "strong", "em", "button", "span", "a", "li", "th") and len(el.get_text(strip=True)) <= 12:
                    m = CAT_RE.match(el.get_text(" ", strip=True))
                    if m and not el.find(href=True):
                        cat = norm_cat(m.group(1))
                        continue
                if el.name == "a" and el.get("href"):
                    m = re.search(r"(?:[?&]oid=|/press/)(\d{3})(?!\d)", el["href"])
                    name = el.get_text(" ", strip=True)
                    if not name and el.find("img"):
                        name = el.find("img").get("alt", "")
                    if m and name and len(name) <= 25:
                        oid = m.group(1)
                        f = found.setdefault(oid, {"name": name, "cat": None, "src": url})
                        if cat and not f["cat"]:
                            f["cat"] = cat
            # 페이지 안 JSON(스크립트)에 들어 있는 경우
            for m in re.finditer(r'"(?:officeId|oid|pressId)"\s*:\s*"(\d{3})"\s*,\s*"(?:officeName|name|pressName)"\s*:\s*"([^"]{1,25})"', r.text):
                found.setdefault(m.group(1), {"name": m.group(2), "cat": None, "src": url + "#json"})
        except Exception as e:
            debug[url] = {"error": str(e)}
    return found


def probe(session, oid, day):
    """랭킹 페이지로 매체 존재·이름·랭킹/조회수 제공 여부 확인"""
    url = f"https://media.naver.com/press/{oid}/ranking?date={day.replace('-', '')}"
    try:
        r = session.get(url, timeout=15, allow_redirects=True)
    except Exception:
        return None
    if r.status_code != 200 or f"/press/{oid}" not in r.url:
        return None
    soup = BeautifulSoup(r.text, "html.parser")
    name = ""
    for sel in ("meta[property='og:title']", "meta[name='twitter:title']"):
        t = soup.select_one(sel)
        if t and t.get("content"):
            name = t["content"]
            break
    if not name and soup.title:
        name = soup.title.get_text()
    name = re.split(r"\s*[:|\-]\s*(?:네이버|NAVER)|\s*[:|]\s*", name.strip())[0].strip()
    n, views = 0, 0
    for a in soup.select("a._es_pc_link"):
        if a.select_one("strong.list_title"):
            n += 1
            v = a.select_one("span.list_view")
            if v and re.search(r"\d", v.get_text()):
                views += 1
    if not name and not n:
        return None
    return {"name": name or oid, "ranking": n > 0, "views": views > 0, "n": n}


def count_check(session, days, oids):
    """빠른 집계(목록 날짜만) vs 저장된 상세 확인 집계 비교"""
    out = {}
    for oid in oids:
        for d in days:
            fast = len(collect.list_day_exact(session, oid, d))
            ar = store.read_json(store.articles_path(d)) or {"items": []}
            full = sum(1 for x in ar["items"] if x[0] == oid)
            out[f"{oid} {d}"] = {"fast": fast, "detail": full}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--max-oid", type=int, default=999)
    a = ap.parse_args()
    session = collect.make_session(8)
    debug = {}
    day = (today_kst() - dt.timedelta(days=1)).isoformat()

    pages = from_pages(session, debug)
    oids = sorted(set(pages) | {f"{i:03d}" for i in range(1, a.max_oid + 1)})
    with ThreadPoolExecutor(max_workers=8) as ex:
        probes = dict(zip(oids, ex.map(lambda o: probe(session, o, day), oids)))

    media = {}
    for oid in oids:
        p = probes.get(oid)
        pg = pages.get(oid)
        if not p and not pg:
            continue
        name = (pg or {}).get("name") or (p or {}).get("name") or oid
        if p and p.get("name") and p["name"] != oid and len(p["name"]) <= 20:
            name = p["name"]
        cat = (pg or {}).get("cat") or DEFAULT_CAT.get(oid) or "기타"
        media[oid] = {
            "name": name,
            "cat": cat,
            "ranking": bool(p and p["ranking"]),
            "views": bool(p and p["views"]),
            "in_list": bool(pg),
        }
    # 목록 페이지에 있었던 매체 + 랭킹이 있는 매체만 (oid 탐색에서 우연히 걸린 비활성 코드는 제외)
    media = {o: m for o, m in media.items() if m["in_list"] or m["ranking"]}
    cats = [c for c in CATS if any(m["cat"] == c for m in media.values())]
    cats += sorted({m["cat"] for m in media.values()} - set(cats))
    doc = {
        "updated_at": store.now_kst().isoformat(timespec="seconds"),
        "probe_day": day,
        "categories": cats,
        "media": media,
        "counts": {
            "total": len(media),
            "ranking": sum(m["ranking"] for m in media.values()),
            "views": sum(m["views"] for m in media.values()),
        },
    }
    store.write_json(DATA / "media_catalog.json", doc, pretty=True)
    if a.check:
        days = [(today_kst() - dt.timedelta(days=i)).isoformat() for i in (8, 9, 10)]
        debug["count_check"] = count_check(session, days, ["346", "296", "001"])
    debug["pages_found"] = len(pages)
    debug["pages_with_cat"] = sum(1 for v in pages.values() if v["cat"])
    store.write_json(DATA / "cache" / "catalog_debug.json", debug, pretty=True)
    print(json.dumps(doc["counts"], ensure_ascii=False), "| 페이지:", debug["pages_found"], "카테고리 읽음:", debug["pages_with_cat"])


if __name__ == "__main__":
    main()
