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
import os
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


# ── 기자명 추출 (여러 방식으로 시도) ─────────────────────────
_ROLE = r"(?:기자|특파원|객원기자|선임기자|전문기자|수습기자|논설위원|칼럼니스트|PD|앵커)"
_BYLINE_SEL = ("em.media_end_head_journalist_name, .media_end_head_journalist_name, "
               ".media_end_head_journalist_box em, span.byline_s, .byline .byline_s, p.byline_p span, "
               "[class*=journalist_name], [class*=byline], [class*=reporter], [class*=writer]")


def _clean_name(t):
    t = clean_text(t)
    t = re.sub(r"\(.*?\)|\[.*?\]|[\w.+-]+@[\w.-]+", " ", t)
    t = re.sub(r"\s+" + _ROLE + r"(?=\s|$|[·,/]).*$", "", t).strip()
    t = re.sub(r"^(글|사진|취재|정리)\s*[=:]?\s*", "", t)
    return t if 1 < len(t) <= 20 and re.search(r"[가-힣A-Za-z]", t) and not re.search(r"구독|응원|기사|뉴스", t) else ""


_MEDIA_WORDS = set(CONFIG["media"].values()) | {"뉴스", "연합", "기자", "사진", "영상", "그래픽", "편집", "온라인", "디지털", "헬스", "닷컴",
    "이미지", "일러스트", "자료", "출처", "제공", "확대", "크게보기", "원본", "보기", "구독", "응원", "제보", "취재", "인턴", "수습", "객원",
    "선임", "전문", "기획", "특별", "공동", "본지", "본사", "온라인팀", "디지털팀", "뉴스팀", "정치부", "사회부", "경제부", "국제부", "문화부"}
_NAME = r"[가-힣]{2,4}"
_ROLE_RE = r"(?:기자|특파원|객원기자|선임기자|전문기자|수습기자|기상캐스터)"


def _ok_name(n):
    return n and n not in _MEDIA_WORDS and not any(w in n for w in ("뉴스", "일보", "신문", "닷컴", "조선", "기자"))


def parse_reporter(soup, html=""):
    """
    네이버 기사 상단 기자 이름표는 화면에서 따로 불러와 원본 HTML에는 없다.
    그래서 본문에 적힌 바이라인에서 찾는다.
      ① (서울=뉴스1) 홍길동 기자 =   ② 홍길동 기자 (email)   ③ 본문 끝 '홍길동 기자'
    매체 이름이 잡히지 않도록 걸러낸다.
    """
    names = []
    def add(n):
        n = n.strip()
        if _ok_name(n) and n not in names:
            names.append(n)
    # 0) 정적 HTML에 이름표가 있는 경우 (구형 템플릿)
    for tag in soup.select("em.media_end_head_journalist_name, span.byline_s, .byline .byline_s, p.byline_p span"):
        m = re.match(r"\s*(" + _NAME + r")\s*" + _ROLE_RE, tag.get_text(" ", strip=True))
        if m:
            add(m.group(1))
    body = soup.select_one("#dic_area, #newsct_article, #articeBody, #articleBody, article")
    txt = re.sub(r"\s+", " ", body.get_text(" ", strip=True)) if body else ""
    if not names and txt:
        # ① 통신사형 리드: (서울=뉴스1) 홍길동 김철수 기자 =
        m = re.search(r"\([^()]{1,15}=[^()]{1,15}\)\s*((?:" + _NAME + r"[\s·ㆍ,]*){1,3})\s*" + _ROLE_RE, txt[:400])
        if m:
            for n in re.split(r"[\s·ㆍ,]+", m.group(1)):
                add(n)
    if not names and txt:
        # ② 이메일 바이라인: 홍길동 기자 hong@...  (본문 어디든, 마지막 것 우선)
        for m in re.finditer(r"(" + _NAME + r")\s?(?:[가-힣]{2,6}\s)?" + _ROLE_RE + r"\s*[\(\[<]?\s*[\w.+-]+@[\w.-]+", txt):
            add(m.group(1))
    if not names and txt:
        # ③ 리드/끝부분의 '홍길동 기자'
        for seg in (txt[:200], txt[-250:]):
            for m in re.finditer(r"(?:^|[\s\]\)=])(" + _NAME + r")\s(?:[가-힣]{2,6}\s)?" + _ROLE_RE + r"(?=[\s=\(\[]|$)", seg):
                add(m.group(1))
            if names:
                break
    return "·".join(names[:3])


def _debug_sample(oid, aid, soup, html, rep, origin=""):
    """매체마다 첫 기사 1건의 바이라인 주변을 저장 (추출이 맞는지 점검용)"""
    with _dbg_lock:
        if any(d["oid"] == oid for d in _dbg) or len(_dbg) >= 30:
            return
        body = soup.select_one("#dic_area, #newsct_article, article")
        txt = re.sub(r"\s+", " ", body.get_text(" ", strip=True)) if body else ""
        _dbg.append({"oid": oid, "aid": aid, "found": rep, "origin": origin, "head": txt[:160], "tail": txt[-160:]})
        store.write_json(DATA / "cache" / "byline_debug.json", _dbg, pretty=True)


_dbg_lock = threading.Lock()
_dbg = []


_ORIGIN_ROLE = r"(?:인턴\s?|수습\s?|객원\s?|선임\s?|전문\s?|취재\s?)?(?:기자|특파원)"


def parse_origin_reporter(html):
    """언론사 원문 페이지에서 기자명: 구조화 데이터 → 메타 태그 → 화면 글자 순"""
    soup = BeautifulSoup(html, "html.parser")
    cands = []
    for sc in soup.select('script[type="application/ld+json"]'):
        for m in re.finditer(r'"author"\s*:\s*(\[[^\]]*\]|\{[^}]*\})', sc.string or ""):
            cands += re.findall(r'"name"\s*:\s*"([^"]{2,30})"', m.group(1))
    for sel in ['meta[name="author"]', 'meta[property="article:author"]', 'meta[name="byl"]', 'meta[property="dable:author"]',
                'meta[name="dable:author"]', 'meta[name="twitter:creator"]', 'meta[property="og:article:author"]']:
        t = soup.select_one(sel)
        if t and t.get("content"):
            cands.append(t["content"])
    names = []
    for c in cands:
        for part in re.split(r"[,/·ㆍ|]", c):
            part = re.sub(r"\(.*?\)|[\w.+-]+@[\w.-]+", " ", part)
            part = re.sub(r"\s*" + _ORIGIN_ROLE + r".*$", "", part).strip()
            if re.fullmatch(_NAME, part) and _ok_name(part) and part not in names:
                names.append(part)
    if names:
        return "·".join(names[:3])
    for t in soup(["script", "style", "noscript"]):
        t.decompose()
    txt = re.sub(r"\s+", " ", soup.get_text(" ", strip=True))
    found = re.findall(r"(?:^|[\s=\]\)·|/])(" + _NAME + r")\s(?:[가-힣]{2,6}\s)?" + _ORIGIN_ROLE + r"(?=[\s=\(\[·,]|$)", txt)
    found = [f for f in found if _ok_name(f)]
    if found:
        from collections import Counter
        return Counter(found).most_common(1)[0][0]
    return ""


def fetch_origin_reporter(session, soup):
    a = soup.select_one("a.media_end_head_origin_link[href], a[class*=origin_link][href]")
    if not a:
        return "", ""
    url = a["href"].replace("&amp;", "&")
    try:
        r = session.get(url, timeout=12, headers={"Referer": "https://n.news.naver.com/"})
        r.encoding = r.apparent_encoding if (r.encoding or "").lower() in ("iso-8859-1", "ascii") else r.encoding
        return parse_origin_reporter(r.text), url
    except Exception:
        return "", url


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
    reporter = parse_reporter(soup, r.text)
    origin = ""
    if not reporter:
        reporter, origin = fetch_origin_reporter(session, soup)   # 네이버에 기자명이 없으면 언론사 원문에서
    _debug_sample(oid, aid, soup, r.text, reporter, origin)
    return pub, reporter


def resolve_meta(session, keys, cache, workers):
    """keys: [(oid, aid)] → 캐시에 없는 것만 병렬 조회해서 cache 갱신"""
    # 캐시에 없거나, 예전 방식으로 기자명을 못 찾은 항목(버전 표시 없음)은 다시 조회
    todo = [k for k in keys if (cache.get(f"{k[0]}_{k[1]}") or [None, None, 0])[-1] != 6]
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
                        cache[f"{oid}_{aid}"] = [pub, rep, 6]
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


def list_candidates(session, oid, day, seen, max_pages=150):
    """
    언론사별 기사목록(date=그날)을 끝까지 넘기며 후보 수집.
    목록 날짜 표시로 그날 ±1일 밖의 기사는 거르고, 정확한 날짜는 상세페이지 입력시각으로 확정한다.
    """
    today = today_kst()
    d0 = dt.date.fromisoformat(day)
    win_lo, win_hi = d0 - dt.timedelta(days=1), d0 + dt.timedelta(days=1)
    out, prev_keys, stale = {}, None, 0
    for page in range(1, max_pages + 1):
        params = {"mode": "LPOD", "mid": "sec", "oid": oid, "listType": "title", "date": day.replace("-", ""), "page": page}
        r = session.get("https://news.naver.com/main/list.naver?" + urlencode(params), timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        lis = soup.select(LIST_SELECTOR)
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
            if d is None or win_lo <= d <= win_hi:
                out[key] = title
            if d is None or d >= win_lo:
                all_old = False
            any_dated = any_dated or d is not None
        if not page_keys or page_keys == prev_keys or new_n == 0:
            return out                     # 목록 끝
        prev_keys = page_keys
        stale = stale + 1 if (any_dated and all_old) else 0
        if stale >= 2:
            return out                     # 그날보다 오래된 기사만 계속 나옴
        time.sleep(0.15)
    err(f"발행목록 {day} {CONFIG['media'].get(oid, oid)}: 페이지 상한({max_pages}) 도달 – 일부 누락 가능")
    return out


def list_day_exact(session, oid, day, max_pages=150):
    """발행 '건수'용 빠른 집계: 목록(date=그날)만 넘기며 그날 기사 key 모음. 상세페이지는 열지 않는다.
    목록에 날짜가 적혀 있으면 그 날짜가 같은 것만, 시각만 있으면 요청한 날짜로 본다."""
    out, prev_keys, stale = set(), None, 0
    seen = set()
    for page in range(1, max_pages + 1):
        params = {"mode": "LPOD", "mid": "sec", "oid": oid, "listType": "title", "date": day.replace("-", ""), "page": page}
        r = session.get("https://news.naver.com/main/list.naver?" + urlencode(params), timeout=15)
        r.raise_for_status()
        soup = BeautifulSoup(r.text, "html.parser")
        page_keys, new_n, older = set(), 0, 0
        for li in soup.select(LIST_SELECTOR):
            a = li.find("a", href=True)
            key = article_key(a["href"]) if a else None
            if not key or key[0] != oid:
                continue
            page_keys.add(key)
            if key in seen:
                continue
            seen.add(key)
            new_n += 1
            span = li.select_one("span.date")
            m = re.search(r"(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})", span.get_text() if span else "")
            d = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}" if m else day
            if d == day:
                out.add(key)
            elif d < day:
                older += 1
        if not page_keys or page_keys == prev_keys or new_n == 0:
            return out
        prev_keys = page_keys
        stale = stale + 1 if older and older == new_n else 0
        if stale >= 2:
            return out
        time.sleep(0.1)
    err(f"발행 건수 {day} {CONFIG['media'].get(oid, oid)}: 페이지 상한 도달")
    return out


def collect_counts(session, days, media, workers):
    """상세 수집 대상이 아닌 매체들의 발행 '건수'만 집계 (매체 단위 병렬)"""
    if not media:
        return {}
    log(f"\n🔢 발행 건수 {len(media)}개 매체 ({days[0]} ~ {days[-1]})")
    res = {d: {} for d in days}

    def one(oid):
        for d in days:
            try:
                res[d][oid] = len(list_day_exact(session, oid, d))
            except Exception as e:
                res[d][oid] = None
                err(f"발행 건수 {d} {CONFIG['media'].get(oid, oid)}: {e}")

    with ThreadPoolExecutor(max_workers=min(8, workers)) as ex:
        list(ex.map(one, media))
    ts = now_kst().isoformat(timespec="seconds")
    for d in days:
        store.save_counts(d, res[d], ts)
    log("   " + ", ".join(f"{d[5:]} {sum(v for v in res[d].values() if v)}건" for d in days))
    return {d: {o: ("error" if n is None else n) for o, n in res[d].items()} for d in days}


def collect_publish(session, days, media, cache, workers, fast=False):
    summary = {}
    touched = set()
    want = set(days)
    for oid in media:
        name = CONFIG["media"].get(oid, oid)
        log(f"\n📰 발행목록 {name} ({days[0]} ~ {days[-1]})")
        cands, seen, failed = {}, set(), []
        for day in days:
            try:
                cands.update(list_candidates(session, oid, day, seen))
            except Exception as e:
                failed.append(day)
                err(f"발행목록 {day} {name}: {e}")
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
            summary.setdefault(d, {})[oid] = "error" if d in failed else len(buckets.get(d, []))
        log("   " + ", ".join(f"{d[5:]} {len(buckets.get(d, []))}건" for d in days))
    return summary, touched


def main():
    ap = argparse.ArgumentParser(description="네이버 뉴스 랭킹/발행목록 수집")
    ap.add_argument("--start", help="YYYY-MM-DD (기본: 어제)")
    ap.add_argument("--end", help="YYYY-MM-DD (기본: 오늘)")
    ap.add_argument("--only", choices=["ranking", "publish", "counts"], help="한 종류만 수집")
    ap.add_argument("--media", help="매체코드 쉼표구분 (기본: config.json)")
    ap.add_argument("--fast", action="store_true", help="상세페이지 확인 생략")
    ap.add_argument("--no-build", action="store_true", help="요약 재생성 생략")
    ap.add_argument("--no-counts", action="store_true", help="발행 건수(전체 매체) 집계 생략")
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
        if a.only not in ("publish", "counts"):
            media = [m for m in CONFIG["ranking_media"] if not media_filter or m in media_filter]
            status["ranking"] = collect_ranking(session, days, media, cache, workers)
            touched |= set(days)
        if a.only not in ("ranking", "counts"):
            media = [m for m in CONFIG["publish_media"] if not media_filter or m in media_filter]
            status["articles"], t = collect_publish(session, days, media, cache, workers, a.fast)
            touched |= t
        if a.only != "ranking":
            cmedia = [m for m in CONFIG.get("count_media", []) if not media_filter or m in media_filter]
            if cmedia and not a.no_counts:
                status["counts"] = collect_counts(session, days, cmedia, workers)
                touched |= set(days)
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
