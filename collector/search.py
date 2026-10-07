#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
검색 키워드 수집기

1) 구글 트렌드 한국 급상승 검색어 (API 키 불필요)
     https://trends.google.com/trending/rss?geo=KR
     → 실행할 때마다 그날 파일에 누적(같은 검색어는 최대 트래픽으로 갱신)

2) 네이버 월간 검색량 (네이버 검색광고 API, 무료 – 키가 있을 때만)
     환경변수 NAVER_AD_API_KEY, NAVER_AD_SECRET, NAVER_AD_CUSTOMER_ID
     · 조회 대상 = config.json 의 search_seeds(관심 키워드) + 그날 기사 제목 상위 키워드
     · 각 키워드의 최근 30일 PC/모바일 검색수 + 연관검색어 검색수
     · 검색량은 월 단위 값이라 하루 1회만 조회 (--force 로 재조회)

  python collector/search.py              # 오늘
  python collector/search.py --force      # 네이버 검색량 다시 조회
결과: data/search/YYYY-MM-DD.json
"""
import argparse
import base64
import json
import hashlib
import hmac
import os
import re
import sys
import time
import xml.etree.ElementTree as ET
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
from store import CONFIG, DATA, now_kst, today_kst, clean_text  # noqa: E402

UA = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}


def search_path(day):
    return DATA / "search" / f"{day}.json"


def parse_traffic(s):
    """'200+' '1,000+' '2K+' '2만+' → 정수"""
    if not s:
        return 0
    t = s.replace(",", "").replace("+", "").strip()
    m = re.match(r"([\d.]+)\s*([KkMm만천]?)", t)
    if not m:
        return 0
    n = float(m.group(1))
    mul = {"K": 1e3, "k": 1e3, "M": 1e6, "m": 1e6, "만": 1e4, "천": 1e3}.get(m.group(2), 1)
    return int(n * mul)


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_google_rss(xml_text):
    root = ET.fromstring(xml_text)
    out = []
    for item in root.iter("item"):
        row = {"title": "", "traffic": 0, "pub": "", "news": []}
        for ch in item:
            name = _local(ch.tag)
            if name == "title":
                row["title"] = clean_text(ch.text)
            elif name == "approx_traffic":
                row["traffic"] = parse_traffic(ch.text)
            elif name == "pubDate":
                row["pub"] = (ch.text or "").strip()
            elif name == "news_item":
                n = {_local(x.tag): clean_text(x.text) for x in ch}
                if n.get("news_item_title"):
                    row["news"].append([n.get("news_item_title", ""), n.get("news_item_url", ""), n.get("news_item_source", "")])
        if row["title"]:
            row["news"] = row["news"][:3]
            out.append(row)
    return out


def fetch_google():
    r = requests.get("https://trends.google.com/trending/rss?geo=KR", headers=UA, timeout=20)
    r.raise_for_status()
    return parse_google_rss(r.text)


# ── 구글 트렌드 키워드별 검색 관심도 ─────────────
# 구글은 키워드별 실제 검색 횟수를 공개하지 않으므로, 트렌드의 상대 관심도(0~100)를 받는다.
# 한 번에 5개까지만 비교되므로 매번 '기준어'를 함께 넣어 기준어 = 100 으로 환산 → 묶음끼리 비교 가능.
GT = "https://trends.google.com/trends/api"


def _gt_json(text):
    return json.loads(text[text.index("{"):])


def google_interest(words, anchor, timeframe="today 1-m"):
    """words → {word: 기준어 대비 관심도(기준어=100)} . 실패한 묶음은 건너뜀"""
    s = requests.Session()
    s.headers.update(UA)
    try:
        s.get("https://trends.google.com/trends/?geo=KR", timeout=15)  # 쿠키
    except Exception:
        pass
    out = {}
    words = [w for w in dict.fromkeys(words) if w and w != anchor]
    for i in range(0, len(words), 4):
        group = [anchor] + words[i:i + 4]
        req = {"comparisonItem": [{"keyword": w, "geo": "KR", "time": timeframe} for w in group], "category": 0, "property": ""}
        try:
            r = s.get(f"{GT}/explore", params={"hl": "ko", "tz": "-540", "req": json.dumps(req, ensure_ascii=False)}, timeout=20)
            if r.status_code == 429:
                time.sleep(20)
                r = s.get(f"{GT}/explore", params={"hl": "ko", "tz": "-540", "req": json.dumps(req, ensure_ascii=False)}, timeout=20)
            r.raise_for_status()
            w = next(x for x in _gt_json(r.text)["widgets"] if x.get("id") == "TIMESERIES")
            r2 = s.get(f"{GT}/widgetdata/multiline", params={"hl": "ko", "tz": "-540", "req": json.dumps(w["request"], ensure_ascii=False), "token": w["token"]}, timeout=20)
            r2.raise_for_status()
            rows = _gt_json(r2.text)["default"]["timelineData"]
            avg = [sum(row["value"][j] for row in rows) / max(1, len(rows)) for j in range(len(group))]
            if avg[0] <= 0:
                continue
            for j, word in enumerate(group[1:], 1):
                out[word] = round(avg[j] / avg[0] * 100, 1)
        except Exception as e:
            print(f"  ⚠️ 구글 관심도 실패 ({','.join(group[1:])}): {e}")
        time.sleep(1.5)
    return out


# ── 네이버 검색광고 API ────────────────────────
def _ad_headers(method, uri):
    key, secret, cid = os.environ.get("NAVER_AD_API_KEY"), os.environ.get("NAVER_AD_SECRET"), os.environ.get("NAVER_AD_CUSTOMER_ID")
    ts = str(int(time.time() * 1000))
    sig = base64.b64encode(hmac.new(secret.encode(), f"{ts}.{method}.{uri}".encode(), hashlib.sha256).digest()).decode()
    return {"X-Timestamp": ts, "X-API-KEY": key, "X-Customer": str(cid), "X-Signature": sig}


def naver_ad_enabled():
    return all(os.environ.get(k) for k in ("NAVER_AD_API_KEY", "NAVER_AD_SECRET", "NAVER_AD_CUSTOMER_ID"))


def _qc(v):
    if isinstance(v, (int, float)):
        return int(v)
    return 5 if "<" in str(v) else int(re.sub(r"\D", "", str(v)) or 0)  # "< 10" → 5


def norm_kw(w):
    return re.sub(r"\s+", "", w or "").upper()


def fetch_naver_volumes(words):
    """words → (volume{word:[pc, mobile, comp]}, related[[word, pc, mobile, comp, seed]])"""
    volume, related = {}, {}
    want = {norm_kw(w): w for w in words}
    batch = [w for w in dict.fromkeys(norm_kw(w) for w in words) if w]
    for i in range(0, len(batch), 5):
        hints = batch[i:i + 5]
        uri = "/keywordstool"
        try:
            r = requests.get("https://api.searchad.naver.com" + uri, params={"hintKeywords": ",".join(hints), "showDetail": "1"},
                             headers=_ad_headers("GET", uri), timeout=20)
            if r.status_code == 429:
                time.sleep(2)
                continue
            r.raise_for_status()
        except Exception as e:
            print(f"  ⚠️ 네이버 검색량 조회 실패 ({','.join(hints)}): {e}")
            continue
        for row in r.json().get("keywordList", []):
            k = row.get("relKeyword", "")
            pc, mo = _qc(row.get("monthlyPcQcCnt")), _qc(row.get("monthlyMobileQcCnt"))
            comp = {"높음": 3, "중간": 2, "낮음": 1}.get(row.get("compIdx"), 0)
            nk = norm_kw(k)
            if nk in want:
                volume[want[nk]] = [pc, mo, comp]
            elif pc + mo >= 100 and nk not in related:
                related[nk] = [k, pc, mo, comp, hints[0]]
        time.sleep(0.35)
    rel = sorted(related.values(), key=lambda x: -(x[1] + x[2]))[:400]
    return volume, rel


def title_keywords(day, n=40):
    s = store.read_json(DATA / "summary" / f"{day[:7]}.json", {}) or {}
    kw = (s.get("days", {}).get(day) or {}).get("kw", [])
    if not kw:  # 오늘 요약이 아직 없으면 어제
        import datetime as dt
        y = (dt.date.fromisoformat(day) - dt.timedelta(days=1)).isoformat()
        s = store.read_json(DATA / "summary" / f"{y[:7]}.json", {}) or {}
        kw = (s.get("days", {}).get(y) or {}).get("kw", [])
    return [k[0] for k in kw[:n]]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--force", action="store_true", help="네이버 검색량을 오늘 이미 조회했어도 다시 조회")
    ap.add_argument("--trends-only", action="store_true", help="구글 급상승 검색어만 (매시간 가벼운 수집용)")
    a = ap.parse_args()
    day = today_kst().isoformat()
    path = search_path(day)
    doc = store.read_json(path, {"date": day, "google": [], "volume": {}, "related": [], "seeds": []})
    ts = now_kst().isoformat(timespec="seconds")
    errors = []

    # 1) 구글 트렌드
    try:
        rows = fetch_google()
        idx = {g["title"]: g for g in doc["google"]}
        hm = now_kst().strftime("%H:%M")
        for r in rows:
            g = idx.get(r["title"])
            if g:
                g["traffic"] = max(g["traffic"], r["traffic"])
                g["last"] = hm
                if r["news"]:
                    g["news"] = r["news"]
            else:
                r.update({"first": hm, "last": hm})
                r.pop("pub", None)
                doc["google"].append(r)
                idx[r["title"]] = r
        doc["google"].sort(key=lambda g: -g["traffic"])
        print(f"구글 급상승 검색어 {len(rows)}개 (오늘 누적 {len(doc['google'])}개)")
    except Exception as e:
        errors.append(f"구글 트렌드: {e}")
        print("  ⚠️ 구글 트렌드 실패:", e)

    # 2) 네이버 검색량
    if a.trends_only:
        pass
    elif naver_ad_enabled():
        if doc.get("volume") and not a.force:
            print("네이버 검색량: 오늘 이미 조회함 (건너뜀)")
        else:
            seeds = CONFIG.get("search_seeds", [])
            words = list(dict.fromkeys(seeds + title_keywords(day)))
            vol, rel = fetch_naver_volumes(words)
            doc["volume"], doc["related"], doc["seeds"] = vol, rel, seeds
            doc["volume_at"] = ts
            print(f"네이버 검색량 {len(vol)}개 키워드, 연관검색어 {len(rel)}개")
    else:
        print("네이버 검색광고 API 키 없음 → 검색량 수집 생략 (README 참고)")

    # 3) 구글 키워드별 관심도 (하루 1회)
    if a.trends_only:
        pass
    elif doc.get("gvol") and not a.force:
        print("구글 관심도: 오늘 이미 조회함 (건너뜀)")
    else:
        anchor = CONFIG.get("google_anchor", "날씨")
        words = list(dict.fromkeys(CONFIG.get("search_seeds", []) + title_keywords(day, 20)))
        gv = google_interest(words, anchor)
        if gv:
            doc["gvol"], doc["gvol_anchor"], doc["gvol_at"] = gv, anchor, ts
        print(f"구글 관심도 {len(gv)}개 키워드 (기준어 '{anchor}' = 100)")
        if not gv:
            errors.append("구글 관심도: 받지 못함 (구글이 일시적으로 막았을 수 있음)")

    doc["collected_at"] = ts
    doc["errors"] = errors
    store.write_json(path, doc)
    meta = store.read_json(DATA / "meta.json", {}) or {}
    meta["search_days"] = sorted(p.stem for p in (DATA / "search").glob("*.json"))
    meta["naver_volume"] = naver_ad_enabled() or bool(meta.get("naver_volume"))
    store.write_json(DATA / "meta.json", meta, pretty=True)


if __name__ == "__main__":
    main()
