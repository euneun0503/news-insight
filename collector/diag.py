"""수집 실패 원인 점검: 상세 확인이 실패하는 기사 표본을 다시 받아 응답 코드·최종 주소·날짜 표시 여부를 기록 → data/cache/diag.json"""
import datetime as dt, json, re, sys, time
from pathlib import Path
from urllib.parse import urlencode
sys.path.insert(0, str(Path(__file__).resolve().parent))
import store, collect  # noqa
from bs4 import BeautifulSoup

S = collect.make_session(4)
out = {"at": store.now_kst().isoformat(timespec="seconds"), "detail": [], "boundary": []}
cache = collect.load_cache()


def probe(oid, aid):
    rec = {"oid": oid, "aid": aid}
    t0 = time.time()
    try:
        r = S.get(f"https://n.news.naver.com/mnews/article/{oid}/{aid}", timeout=12, allow_redirects=True)
        rec.update(status=r.status_code, url=r.url[:120], sec=round(time.time() - t0, 2), len=len(r.text))
        soup = BeautifulSoup(r.text, "html.parser")
        rec["date_tag"] = bool(soup.select_one("span.media_end_head_info_datestamp_time[data-date-time]"))
        rec["meta_pub"] = bool(soup.select_one('meta[property="article:published_time"]'))
        rec["title"] = (soup.title.get_text()[:60] if soup.title else "")
        m = re.search(r'(\d{4}[.-]\d{2}[.-]\d{2}[ T.]+\d{1,2}:\d{2})', r.text)
        rec["any_date"] = m.group(1) if m else ""
    except Exception as e:
        rec.update(error=type(e).__name__, msg=str(e)[:200], sec=round(time.time() - t0, 2))
    for name, url in (("sports_api", f"https://api-gw.sports.naver.com/news/article/{oid}/{aid}"),
                      ("entertain_api", f"https://api-gw.entertain.naver.com/news/article/{oid}/{aid}")):
        try:
            r = S.get(url, timeout=10, headers={"Referer": "https://m.sports.naver.com/"})
            rec[name] = [r.status_code, r.text[:300]]
        except Exception as e:
            rec[name] = [type(e).__name__, str(e)[:100]]
    try:
        pub, rep = collect.fetch_article_meta(S, oid, aid)
        rec["fixed"] = [pub, rep]
    except Exception as e:
        rec["fixed"] = ["error", str(e)[:100]]
    return rec


day = (store.today_kst() - dt.timedelta(days=1)).isoformat()
for oid in ("421", "001", "081", "119"):
    have = {r[1] for r in (store.read_json(store.articles_path(day)) or {"items": []})["items"] if r[0] == oid}
    keys = []
    for page in range(1, 4):
        r = S.get("https://news.naver.com/main/list.naver?" + urlencode({"mode": "LPOD", "mid": "sec", "oid": oid, "listType": "title", "date": day.replace("-", ""), "page": page}), timeout=15)
        for a in BeautifulSoup(r.text, "html.parser").select("ul.type02 li a[href], ul.type06_headline li a[href], ul.type06 li a[href]"):
            k = store.article_key(a["href"])
            if k and k[0] == oid and k[1] not in have and k not in keys:
                keys.append(k)
    # 캐시에 날짜가 없는 기사(=상세 확인 실패) 우선
    keys = [k for k in keys if not (cache.get(f"{k[0]}_{k[1]}") or [None])[0]][:6] or keys[:3]
    for k in keys:
        out["detail"].append(probe(*k))
        time.sleep(0.3)

for oid, d in (("005", "2026-10-01"), ("008", "2026-10-02"), ("009", "2026-10-04")):
    t0 = time.time()
    try:
        res, sure = collect.list_day_exact(S, oid, d, cache)
        out["boundary"].append({"oid": oid, "day": d, "n": len(res), "sure": sure, "sec": round(time.time() - t0, 1), "errors": collect._errors[-3:]})
    except Exception as e:
        out["boundary"].append({"oid": oid, "day": d, "error": f"{type(e).__name__}: {e}"[:300]})
store.write_json(store.DATA / "cache" / "diag.json", out, pretty=True)
print(json.dumps(out, ensure_ascii=False, indent=1)[:6000])
