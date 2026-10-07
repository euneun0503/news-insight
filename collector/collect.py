#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
네이버 뉴스 수집기 (랭킹 + 매체별 전체 발행목록)

사용법
  python collector/collect.py                       # 어제~오늘 (기본, 자동수집용)
  python collector/collect.py --start 2026-09-01 --end 2026-09-30
  python collector/collect.py --only ranking        # 랭킹만
  python collector/collect.py --only publish --media 346,296
  python collector/collect.py --fast                # 상세페이지 확인 생략(빠르지만 날짜 경계 오차 가능)

개선점 (기존 노트북 대비)
  1) 모든 날짜를 한국시간 기준으로 계산 (GitHub 서버는 UTC라 날짜가 하루 밀리던 문제 해결)
  2) 기사 고유키(oid/aid)로 병합 → 여러 번 돌려도 중복 없이 누적
  3) 상세페이지 발행일시는 캐시 → 두 번째 실행부터는 새 기사만 조회 (빠름)
  4) 매체 수집이 실패하면 기존 데이터를 지우지 않고 유지, 실패 내역은 meta.json에 기록
  5) 랭킹 기사도 기자명/발행시각을 함께 저장 → 기자 통계, 시간대 분석 가능
"""
import argparse
import re
import sys
import time
import threading
import datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlencode

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent))
import store  # noqa: E402
from store import CONFIG, DATA, clean_text, article_key, now_kst, today_kst  # noqa: E402

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "ko-KR,ko;q=0.9",
    "Referer": "https://news.naver.com/",
}

CACHE_PATH = DATA / "cache" / "article_meta.json"
_cache_lock = threading.Lock()
_errors = []


def log(*a):
    print(*a, flush=True)


def err(msg):
    _errors.append(msg)
    log("  ⚠️", msg)


def make_session(workers):
    s = requests.Session()
    s.headers.update(HEADERS)
    adapter = HTTPAdapter(
        max_retries=Retry(total=4, backoff_factor=1.0,
                          status_forcelist=[429, 500, 502, 503, 504], allowed_methods=["GET"]),
        pool_connections=workers + 4, pool_maxsize=workers + 4)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def parse_views(text):
    if not text:
        return 0
    t = text.replace(",", "")
    m = re.search(r"([\d.]+)\s*만", t)
    if m:
        return int(float(m.group(1)) * 10000)
    digits = re.sub(r"\D", "", t)
    return int(digits) if digits else 0


# ── 기사 상세: 정확한 발행일시 + 기자명 (캐시) ───────────────────────
def load_cache():
    return store.read_json(CACHE_PATH, {}) or {}


def save_cache(cache):
    keep_from = (today_kst() - dt.timedelta(days=CONFIG.get("keep_cache_days", 60))).isoformat()
    pruned = {k: v for k, v in cache.items() if v and v[0] and v[0][:10] >= keep_from}
    store.write_json(CACHE_PATH, pruned)


def _norm_dt(raw):
    """'2026-09-30 10:23:45' / '2026-09-30T10:23:45+09:00' / '20260930102345' → 'YYYY-MM-DD HH:MM'"""
    if not raw:
        return None
    raw = raw.strip()
    m = re.search(r"(\d{4})[-.]?(\d{2})[-.]?(\d{2})[ T]?(\d{2}):?(\d{2})", raw)
    if not m:
        return None
    y, mo, d, h, mi = m.groups()
    # 타임존이 UTC로 붙어 오는 경우 KST로 변환
    tz = re.search(r"(Z|[+-]\d{2}:?\d{2})$", raw)
    if tz and tz.group(1) not in ("+09:00", "+0900"):
        try:
            t = dt.datetime.fromisoformat(raw.replace("Z", "+00:00")).astimezone(store.KST)
            return t.strftime("%Y-%m-%d %H:%M")
        except Exception:
            pass
    return f"{y}-{mo}-{d} {h}:{mi}"


def fetch_article_meta(session, oid, aid):
    url = f"https://n.news.naver.com/mnews/article/{oid}/{aid}"
    r = session.get(url, timeout=12)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    pub = None
    tag = soup.select_one("span.media_end_head_info_datestamp_time[data-date-time]")
    if tag:
        pub = _norm_dt(tag.get("data-date-time"))
    if not pub:
        meta = soup.select_one('meta[property="article:published_time"]')
        if meta:
            pub = _norm_dt(meta.get("content"))
    if not pub:  # 연예/스포츠 등 다른 템플릿
        tag = soup.select_one("em.date, span.date, .article_info .date")
        if tag:
            pub = _norm_dt(tag.get_text(" ", strip=True).replace(".", "-"))
    reporter = ""
    rtag = soup.select_one("em.media_end_head_journalist_name, span.byline_s, .byline .byline_s")
    if rtag:
        reporter = clean_text(rtag.get_text(" ", strip=True))
        reporter = re.sub(r"\s+(기자|특파원|객원기자|선임기자|전문기자|수습기자|논설위원|위원|PD|앵커)(?=\s|$).*$", "", reporter)
        reporter = re.sub(r"\(.*?\)|[\w.+-]+@[\w.-]+", "", reporter).strip()[:20]
    return pub, reporter


def resolve_meta(session, keys, cache, workers):
    """keys: [(oid, aid)] → 캐시에 없는 것만 병렬 조회해서 cache 갱신"""
    todo = [k for k in keys if f"{k[0]}_{k[1]}" not in cache]
    if not todo:
        return 0
    fails = 0
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futs = {ex.submit(fetch_article_meta, session, oid, aid): (oid, aid) for oid, aid in todo}
        for i, f in enumerate(as_completed(futs), 1):
            oid, aid = futs[f]
            try:
                pub, rep = f.result()
                if pub:
                    with _cache_lock:
                        cache[f"{oid}_{aid}"] = [pub, rep]
                else:
                    fails += 1
            except Exception:
                fails += 1
            if i % 100 == 0:
                log(f"      상세 확인 {i}/{len(todo)}")
    return fails


# ── 랭킹 ─────────────────────────────────────────────────────
def fetch_ranking(session, oid, day):
    url = f"https://media.naver.com/press/{oid}/ranking?date={day.replace('-', '')}"
    r = session.get(url, timeout=15)
    r.raise_for_status()
    soup = BeautifulSoup(r.text, "html.parser")
    size = CONFIG.get("ranking_size", 20)
    out, seen = [], set()
    for a in soup.select("a._es_pc_link"):
        title = a.select_one("strong.list_title")
        key = article_key(a.get("href", ""))
        if not title or not key or key in seen:
            continue
        seen.add(key)
        view = a.select_one("span.list_view")
        vtxt = view.get_text() if view else ""
        out.append([key[0], key[1], len(out) + 1, parse_views(vtxt) if re.search(r"\d", vtxt) else None,
                    clean_text(title.get_text()), "", ""])
        if len(out) >= size:
            break
    return out


def collect_ranking(session, days, media, cache, workers):
    summary = {}
    for day in days:
        log(f"\n🏆 랭킹 {day}")
        per_media = {}
        with ThreadPoolExecutor(max_workers=min(4, workers)) as ex:
            futs = {ex.submit(fetch_ranking, session, oid, day): oid for oid in media}
            for f in as_completed(futs):
                oid = futs[f]
                try:
                    items = f.result()
                    per_media[oid] = items
                    if not items:
                        err(f"랭킹 {day} {CONFIG['media'].get(oid, oid)}: 0건 (페이지 구조 변경 또는 데이터 없음)")
                except Exception as e:
                    per_media[oid] = None
                    err(f"랭킹 {day} {CONFIG['media'].get(oid, oid)}: {e}")
        keys = [(r[0], r[1]) for items in per_media.values() if items for r in items]
        resolve_meta(session, keys, cache, workers)
        for items in per_media.values():
            for r in items or []:
                m = cache.get(f"{r[0]}_{r[1]}")
                if m:
                    r[6], r[5] = m[0], m[1]
        final = day < today_kst().isoformat()
        store.save_ranking(day, per_media, now_kst().isoformat(timespec="seconds"), final)
        store.save_snapshot(day, per_media, now_kst())
        summary[day] = {oid: (len(v) if v is not None else "error") for oid, v in per_media.items()}
        log("   " + ", ".join(f"{CONFIG['media'].get(o, o)} {n}" for o, n in summary[day].items()))
    return summary


# ── 전체 발행목록 ────────────────────────────────────────────
LIST_SELECTOR = "ul.type02 li, ul.type06_headline li, ul.type06 li"


def rough_date(raw, today):
    """목록의 날짜 표시('2026.10.06.', '3일전', '어제', '2시간전', '10:23') → 대략적인 날짜. 모르면 None"""
    s = (raw or "").strip()
    m = re.search(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", s)
    if m:
        return dt.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    if re.search(r"방금|\d+\s*분\s*전|\d+\s*시간\s*전", s):
        return today
    if "어제" in s:
        return today - dt.timedelta(days=1)
    m = re.search(r"(\d+)\s*일\s*전", s)
    if m:
        return today - dt.timedelta(days=int(m.group(1)))
    if re.search(r"\d{1,2}:\d{2}", s):
        return today
    return None


def list_candidates(session, oid, days, max_pages=None):
    """
    언론사별 기사목록을 최신순으로 넘기며 요청 기간(앞뒤 하루 여유) 근처의 기사를 후보로 모은다.
    네이버 목록의 date= 필터는 날짜별로 정확히 걸러주지 않아(기존 노트북에서 확인),
    목록 날짜로는 '대략'만 거르고, 정확한 날짜는 상세페이지 입력시각으로 확정한다.
    """
    today = today_kst()
    first, last = dt.date.fromisoformat(days[0]), dt.date.fromisoformat(days[-1])
    win_lo, win_hi = first - dt.timedelta(days=1), last + dt.timedelta(days=1)
    max_pages = max_pages or max(300, len(days) * 150)
    out, seen, prev_keys, stale = {}, set(), None, 0
    reached = False
    for page in range(1, max_pages + 1):
        params = {"mode": "LPOD", "mid": "sec", "oid": oid, "listType": "title",
                  "date": days[-1].replace("-", ""), "page": page}
        r = session.get("https://news.naver.com/main/list.naver?" + urlencode(params), timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        lis = soup.select(LIST_SELECTOR)
        if not lis:
            reached = True
            break
        page_keys, new_n, any_dated, all_old = set(), 0, False, True
        for li in lis:
            a = li.find("a", href=True)
            if not a:
                continue
            key = article_key(a["href"])
            title = clean_text(a.get_text())
            if not key or key[0] != oid or not title:
                continue
            page_keys.add(key)
            if key in seen:
                continue
            seen.add(key)
            new_n += 1
            span = li.select_one("span.date")
            d = rough_date(span.get_text(strip=True) if span else "", today)
            if d is None:
                out[key] = title          # 날짜를 모르면 일단 후보 (상세페이지에서 확정)
                all_old = False
                continue
            any_dated = True
            if d >= win_lo:
                all_old = False
            if win_lo <= d <= win_hi:
                out[key] = title
        if (prev_keys is not None and page_keys == prev_keys) or new_n == 0:
            reached = True
            break                          # 마지막 페이지 반복 / 새 기사 없음
        prev_keys = page_keys
        stale = stale + 1 if (any_dated and all_old) else 0
        if stale >= 2:
            reached = True
            break                          # 요청 기간보다 오래된 기사만 2페이지 연속
        time.sleep(0.15)
    if not reached:
        err(f"발행목록 {CONFIG['media'].get(oid, oid)}: 페이지 상한({max_pages}) 도달 – {days[0]} 쪽 일부 누락 가능, 기간을 나눠 다시 실행하세요")
    return out


def collect_publish(session, days, media, cache, workers, fast=False):
    summary = {}
    touched = set()
    want = set(days)
    for oid in media:
        name = CONFIG["media"].get(oid, oid)
        log(f"\n📰 발행목록 {name} ({days[0]} ~ {days[-1]})")
        try:
            cands = list_candidates(session, oid, days)
        except Exception as e:
            err(f"발행목록 {name}: {e}")
            for d in days:
                summary.setdefault(d, {})[oid] = "error"
            continue
        log(f"   후보 {len(cands)}건 → 상세페이지에서 날짜 확인")
        fails = 0 if fast else resolve_meta(session, list(cands), cache, workers)
        if fails:
            err(f"발행목록 {name}: 상세 확인 실패 {fails}건 → 제외")
        buckets = {}
        for (o, aid), title in cands.items():
            m = cache.get(f"{o}_{aid}")
            if not (m and m[0]):
                continue                   # 날짜를 확정 못 한 기사는 엉뚱한 날에 넣지 않고 제외
            pday = m[0][:10]
            if pday in want:
                buckets.setdefault(pday, []).append((o, aid, m[0][11:16], title, m[1]))
        ts = now_kst().isoformat(timespec="seconds")
        for pday, items in buckets.items():
            store.merge_articles(pday, oid, items, ts)
            touched.add(pday)
        for d in days:
            summary.setdefault(d, {})[oid] = len(buckets.get(d, []))
        log("   " + ", ".join(f"{d[5:]} {len(buckets.get(d, []))}건" for d in days))
    return summary, touched


def main():
    ap = argparse.ArgumentParser(description="네이버 뉴스 랭킹/발행목록 수집")
    ap.add_argument("--start", help="YYYY-MM-DD (기본: 어제)")
    ap.add_argument("--end", help="YYYY-MM-DD (기본: 오늘)")
    ap.add_argument("--only", choices=["ranking", "publish"], help="한 종류만 수집")
    ap.add_argument("--media", help="매체코드 쉼표구분 (기본: config.json)")
    ap.add_argument("--fast", action="store_true", help="상세페이지 확인 생략")
    ap.add_argument("--no-build", action="store_true", help="요약 재생성 생략")
    a = ap.parse_args()

    today = today_kst()
    start = a.start or (today - dt.timedelta(days=1)).isoformat()
    end = a.end or today.isoformat()
    if end > today.isoformat():
        end = today.isoformat()
    days = store.date_range(start, end)
    workers = CONFIG.get("workers", 8)
    media_filter = set(a.media.split(",")) if a.media else None

    t0 = time.time()
    log("=" * 50)
    log(f"수집 기간: {days[0]} ~ {days[-1]} ({len(days)}일)  /  기준시각 {now_kst():%Y-%m-%d %H:%M} KST")
    log("=" * 50)

    session = make_session(workers)
    cache = load_cache()
    status = {"at": now_kst().isoformat(timespec="seconds"), "range": [days[0], days[-1]]}
    touched = set()
    try:
        if a.only != "publish":
            media = [m for m in CONFIG["ranking_media"] if not media_filter or m in media_filter]
            status["ranking"] = collect_ranking(session, days, media, cache, workers)
            touched |= set(days)
        if a.only != "ranking":
            media = [m for m in CONFIG["publish_media"] if not media_filter or m in media_filter]
            status["articles"], t = collect_publish(session, days, media, cache, workers, a.fast)
            touched |= t
    finally:
        save_cache(cache)

    status["errors"] = _errors[:50]
    status["errors_n"] = len(_errors)
    status["ok"] = len(_errors) == 0
    status["elapsed"] = round(time.time() - t0, 1)
    if not a.no_build:
        store.rebuild(touched)
    store.build_meta(status)
    log(f"\n✅ 완료 ({status['elapsed']}초, 경고 {len(_errors)}건)")


if __name__ == "__main__":
    main()
