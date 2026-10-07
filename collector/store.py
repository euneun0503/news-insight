# -*- coding: utf-8 -*-
"""
데이터 저장소 공통 모듈
- 날짜는 모두 한국시간(KST) 기준 'YYYY-MM-DD'
- 기사 고유키 = (oid, aid) → 같은 기사가 여러 번 수집돼도 1건으로 병합
- 일별 원본(ranking/articles) → 월별 요약(summary) → 전체 목록(meta) 순으로 빌드

파일 형식 (용량을 줄이려고 배열로 저장)
  data/ranking/YYYY-MM-DD.json
    items: [oid, aid, rank, views, title, reporter, pub("YYYY-MM-DD HH:MM" 또는 "")]
  data/articles/YYYY-MM-DD.json
    items: [oid, aid, "HH:MM", title, reporter]
  data/summary/YYYY-MM.json   (대시보드가 긴 기간을 빠르게 그리기 위한 일별 집계)
  data/meta.json              (매체 목록, 수집된 날짜 범위, 최근 수집 상태)
"""
import json
import re
import datetime as dt
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
KST = dt.timezone(dt.timedelta(hours=9))
CONFIG = json.loads((ROOT / "collector" / "config.json").read_text("utf-8"))


def _expand_config(cfg):
    """data/media_catalog.json(네이버 언론사 전체 목록)이 있으면 매체 이름·수집 대상을 넓힌다.
    - ranking_all: 랭킹이 있는 매체는 모두 랭킹 수집
    - count_all: 상세 수집(publish_media) 외 모든 매체는 발행 '건수'만 빠르게 집계
    view_rank / view_pub = 대시보드 기본 표시 매체 (원래 설정 목록)"""
    cfg.setdefault("view_rank", list(cfg["ranking_media"]))
    cfg.setdefault("view_pub", list(cfg["publish_media"]))
    cfg["count_media"] = []
    p = ROOT / "data" / "media_catalog.json"
    if not p.exists():
        return cfg
    try:
        cat = json.loads(p.read_text("utf-8")).get("media", {})
    except Exception:
        return cfg
    names = {o: m["name"] for o, m in cat.items() if m.get("name")}
    names.update(cfg["media"])
    cfg["media"] = names
    if cfg.get("ranking_all"):
        cfg["ranking_media"] = cfg["ranking_media"] + [o for o in sorted(cat) if cat[o].get("ranking") and o not in cfg["ranking_media"]]
    if cfg.get("count_all"):
        # 상세 수집 매체도 건수는 함께 집계 → 상세 수집이 아직 안 된 날짜도 발행 수가 보임 (상세 수집분이 있으면 그것을 우선)
        cfg["count_media"] = sorted(set(cat) | set(cfg["publish_media"]))
    return cfg


CONFIG = _expand_config(CONFIG)


# ── 날짜 ─────────────────────────────────────────────────────
def now_kst():
    return dt.datetime.now(KST)


def today_kst():
    return now_kst().date()


def date_range(start, end):
    s = dt.date.fromisoformat(start)
    e = dt.date.fromisoformat(end)
    if s > e:
        raise ValueError(f"시작일({start})이 종료일({end})보다 늦습니다.")
    out = []
    while s <= e:
        out.append(s.isoformat())
        s += dt.timedelta(days=1)
    return out


# ── 파일 입출력 ──────────────────────────────────────────────
def read_json(path, default=None):
    path = Path(path)
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text("utf-8"))
    except Exception:
        return default


def write_json(path, obj, pretty=False):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, ensure_ascii=False, indent=1 if pretty else None,
                     separators=None if pretty else (",", ":"))
    tmp = path.with_suffix(".tmp")
    tmp.write_text(txt, "utf-8")
    tmp.replace(path)


def ranking_path(day):
    return DATA / "ranking" / f"{day}.json"


def articles_path(day):
    return DATA / "articles" / f"{day}.json"


def clean_text(s):
    if not s:
        return ""
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(s))
    return re.sub(r"\s+", " ", s).strip()


ARTICLE_RE = re.compile(r"/article/(?:\w+/)?(\d{3})/(\d{6,})")
ARTICLE_QS_RE = re.compile(r"oid=(\d{3}).*?aid=(\d{6,})")


def article_key(href):
    """네이버 기사 URL → (oid, aid). 쿼리스트링이 달라도 같은 기사로 인식."""
    if not href:
        return None
    m = ARTICLE_RE.search(href) or ARTICLE_QS_RE.search(href)
    return (m.group(1), m.group(2)) if m else None


# ── 병합 ─────────────────────────────────────────────────────
def merge_articles(day, oid, new_items, collected_at, src=None):
    """
    day 파일에 한 매체의 기사들을 병합.
    new_items: [(oid, aid, "HH:MM", title, reporter)]  (모두 실제 발행일 == day 인 것만)
    기존 기사는 유지하고, 새 기사 추가 + 비어 있던 시각/기자명은 보완.
    """
    path = articles_path(day)
    doc = read_json(path, {"date": day, "media": {}, "items": []})
    index = {(r[0], r[1]): i for i, r in enumerate(doc["items"])}
    added = 0
    for it in new_items:
        k = (it[0], it[1])
        if k in index:
            old = doc["items"][index[k]]
            for j in (2, 3, 4):
                if not old[j] and it[j]:
                    old[j] = it[j]
        else:
            index[k] = len(doc["items"])
            doc["items"].append(list(it))
            added += 1
    doc["items"].sort(key=lambda r: (r[0], r[2] or "99:99", r[1]))
    m = doc["media"].setdefault(oid, {})
    if src:                    # 업로드 파일로 채운 것 (collector/uploads.py)
        m["src"], m["upload"] = "upload", src
    elif m.get("src") == "upload" and any(it[4] for it in new_items):
        m.pop("src", None)     # 직접 수집(기자명 포함)이 들어오면 수집 데이터로 전환
        m.pop("upload", None)
    m["collected_at"] = collected_at
    m["n"] = sum(1 for r in doc["items"] if r[0] == oid)
    write_json(path, doc)
    return added


def counts_path(day):
    return DATA / "counts" / f"{day}.json"


def save_titles(oid, by_day):
    """발행 건수만 세는 매체의 기사 제목 (기사 목록 화면용): data/titles/YYYY-MM/{oid}.json = {day: [[aid, title]]}"""
    months = {}
    for day, items in by_day.items():
        months.setdefault(day[:7], {})[day] = items
    for ym, days in months.items():
        path = DATA / "titles" / ym / f"{oid}.json"
        doc = read_json(path, {}) or {}
        doc.update(days)
        write_json(path, doc)


def save_counts(day, counts, collected_at):
    """발행 '건수'만 집계한 매체: {oid: n}. 실패(None)한 매체는 기존 값 유지"""
    path = counts_path(day)
    doc = read_json(path, {"date": day, "media": {}})
    for oid, n in counts.items():
        if n is None:
            continue
        if n == "unsure":          # 날짜 확정 불가(최근 상대 표기) → 잘못된 값이 남지 않게 지움
            doc["media"].pop(oid, None)
            continue
        doc["media"][oid] = {"n": n, "at": collected_at}
    write_json(path, doc)


def save_ranking(day, per_media, collected_at, final):
    """
    per_media: {oid: [items]} (실패한 매체는 None)
    실패한 매체는 기존 데이터를 그대로 유지 → 일시적 오류로 데이터가 사라지지 않음.
    """
    path = ranking_path(day)
    doc = read_json(path, {"date": day, "media": {}, "items": []})
    keep = defaultdict(list)
    for r in doc["items"]:
        keep[r[0]].append(r)
    for oid, items in per_media.items():
        if items:  # 새로 받은 게 있을 때만 교체
            keep[oid] = items
            doc["media"][oid] = {"collected_at": collected_at, "n": len(items), "final": final}
    doc["items"] = [r for oid in sorted(keep) for r in sorted(keep[oid], key=lambda x: x[2])]
    doc["collected_at"] = collected_at
    doc["final"] = all(v.get("final") for v in doc["media"].values()) if doc["media"] else False
    write_json(path, doc)
    return doc


# ── 시간대별 조회수 (매시간 스냅샷) ──────────────────────────
def snap_path(day):
    return DATA / "snap" / f"{day}.json"


def save_snapshot(day, per_media, now):
    """
    랭킹 조회수를 수집 시각과 함께 기록. 네이버 랭킹 조회수는 '그날 하루 누적'이라
    두 시각의 차이 = 그 사이에 읽힌 횟수.
    m = 그날 0시부터 지난 분. 다음 날 새벽(6시 전)에 다시 받은 전날 값은 하루 끝(1440)으로 기록.
    """
    d = dt.date.fromisoformat(day)
    if d == now.date():
        m = now.hour * 60 + now.minute
    elif d == now.date() - dt.timedelta(days=1) and now.hour < 6:
        m = 1440
    else:
        return
    doc = read_json(snap_path(day), {"date": day, "snaps": []})
    v = {f"{r[0]}_{r[1]}": r[3] for items in per_media.values() if items for r in items if r[3] is not None}
    if not v:
        return
    doc["snaps"] = [s for s in doc["snaps"] if s["m"] != m] + [{"m": m, "v": v}]
    doc["snaps"].sort(key=lambda s: s["m"])
    write_json(snap_path(day), doc)


def read_hours(day):
    """스냅샷 → 매체별 시간대(0~23시) 조회수 증가 추정치. 랭킹 상위 기사 기준."""
    doc = read_json(snap_path(day))
    if not doc or not doc.get("snaps"):
        return None
    out = defaultdict(lambda: [0.0] * 24)
    prev_m, prev_v, baseline = 0, {}, True   # 0시 기준 조회수 = 0
    covered = 0
    for s in doc["snaps"]:
        m, v = s["m"], s["v"]
        span = m - prev_m
        if span <= 0:
            continue
        for key, views in v.items():
            if key in prev_v:
                inc = views - prev_v[key]
            elif baseline:
                inc = views
            else:
                continue          # 이전 시각엔 상위 20위 밖 → 그 사이 증가량을 알 수 없어 제외
            if inc <= 0:
                continue
            oid = key.split("_")[0]
            per_min = inc / span
            for h in range(prev_m // 60, min(24, (m - 1) // 60 + 1)):
                lo, hi = max(prev_m, h * 60), min(m, h * 60 + 60)
                if hi > lo:
                    out[oid][h] += per_min * (hi - lo)
        covered += span
        prev_m, prev_v, baseline = m, v, False
    return {"h": {o: [round(x) for x in arr] for o, arr in out.items()}, "snaps": len(doc["snaps"]), "cov": covered}


# ── 키워드 추출 ─────────────────────────────────────────────
JOSA = sorted("""로부터 으려면 하세요 으면서 으면 하면 려면 세요 으로부터 에서부터 에게서 으로는 으로도 이라는 이라며 에서는 에서도 에게는
에서 에게 으로 까지 부터 처럼 보다 이나 이란 이며 라는 라며 에는 에도 와의 과의 하는 했다 한다
된다 됐다 해야 하고 하며 은 는 을 를 에 의 로 와 과 도 가 만""".split(), key=len, reverse=True)

STOPWORDS = set("""
기자 단독 종합 속보 포토 영상 사진 인터뷰 칼럼 사설 오늘 내일 어제 이유 위해 대한 관련 이번 지난
올해 지금 가장 모든 이상 이하 통해 따라 때문 경우 정도 사실 우리 그리고 하지만 그러나 결국 이후
이전 현재 최근 무엇 어떻게 왜 누가 이것 그것 저것 여기 거기 하나 무슨 있다 없다 있는 없는 같은
다른 많은 이런 그런 저런 했던 되는 위한 대해 함께 바로 계속 다시 이제 아직 벌써 매우 너무 정말
진짜 보니 알고 보면 하세요 가야 해야 이럴 그럴 저럴 만에 뭐야 뭘까 뭐지 무슨 이유는 결국 됐다 했다 있었다 하면 이것 이거 그래서 까닭 뭐길래 이렇게 그렇게 무조건 절대 반드시 생각 사람들 모르는 하루 오전 오후 발표 공개 진행 예정 확인 결과 제공 사용 시작 처음
""".split())

TAG_RE = re.compile(r"\[[^\]]{0,20}\]|【[^】]{0,20}】|<[^>]{0,20}>")
WORD_RE = re.compile(r"[가-힣A-Za-z0-9]+")
NUMLIKE_RE = re.compile(r"^\d+[가-힣]{0,2}$")


def keywords(title):
    """제목 → 키워드 집합(한 제목에서 같은 단어는 1회)."""
    t = TAG_RE.sub(" ", title or "")
    out = set()
    for w in WORD_RE.findall(t):
        if w.isdigit() or NUMLIKE_RE.match(w):
            continue
        if re.match(r"[가-힣]", w):
            for j in JOSA:
                if w.endswith(j) and len(w) - len(j) >= (1 if len(j) >= 2 else 2):
                    w = w[: -len(j)]
                    break
        else:
            w = w.upper() if len(w) <= 5 else w.lower()
        if len(w) < 2 or w in STOPWORDS:
            continue
        out.add(w)
    return out


# ── 월별 요약 빌드 ───────────────────────────────────────────
def build_day_summary(day):
    rk = read_json(ranking_path(day))
    ar = read_json(articles_path(day))
    cn = read_json(counts_path(day))
    if not rk and not ar and not cn:
        return None
    s = {}
    rh = read_hours(day)
    if rh:
        s["readH"] = rh
    kw = defaultdict(lambda: [0, 0, 0, 0])  # word -> [발행 기사수, 랭킹 기사수, 랭킹 조회수, 조회수 있는 랭킹 기사수]
    rep = defaultdict(lambda: [0, 0, 0])  # (name, oid) -> [발행수, 랭킹수, 랭킹조회수]

    if ar:
        pub = Counter()
        pub_h = defaultdict(lambda: [0] * 24)
        for oid, aid, hm, title, reporter in ar["items"]:
            pub[oid] += 1
            if hm:
                pub_h[oid][int(hm[:2])] += 1
            for w in keywords(title):
                kw[w][0] += 1
            if reporter:
                rep[(reporter, oid)][0] += 1
        s["pub"] = dict(pub)
        s["pubH"] = dict(pub_h)
        s["pubMedia"] = sorted(ar.get("media", {}).keys())
    if cn and cn.get("media"):
        # 발행 수는 네이버 목록으로 센 '건수'를 모든 매체에 같은 기준으로 우선 사용 (상세 수집은 일부 실패로 조금 적을 수 있음)
        s.setdefault("pub", {})
        s.setdefault("pubMedia", [])
        for o, m in cn["media"].items():
            s["pub"][o] = m["n"]
        s["pubCnt"] = sorted(cn["media"])

    if rk:
        rank = {}
        rank_h = [[0] * 24, [0] * 24]  # 발행시각별 [랭킹 기사수, 조회수]
        for oid, aid, rnk, views, title, reporter, pub_dt in rk["items"]:
            # views 가 None 이면 네이버가 그 매체의 조회수를 표시하지 않은 것 (0 이 아님)
            r = rank.setdefault(oid, [0, 0, 0, 0])  # [기사수, 조회수합, 1위 조회수, 조회수 제공 여부]
            r[0] += 1
            has = views is not None
            v = views or 0
            if has:
                r[1] += v
                r[3] = 1
            if rnk == 1 and has:
                r[2] = v
            if has and pub_dt and len(pub_dt) >= 13:
                h = int(pub_dt[11:13])
                rank_h[0][h] += 1
                rank_h[1][h] += v
            for w in keywords(title):
                kw[w][1] += 1
                if has:
                    kw[w][2] += v
                    kw[w][3] += 1
            if reporter:
                x = rep[(reporter, oid)]
                x[1] += 1
                x[2] += v
        s["rank"] = rank
        s["rankH"] = rank_h
        s["rankFinal"] = bool(rk.get("final"))
        s["top"] = sorted(rk["items"], key=lambda r: -(r[3] if r[3] is not None else -1))[:30]

    # 키워드: 의미 있는 것만 상위 250개 (발행 1회 + 랭킹 0회짜리 잡음 제거)
    scored = [(w, v) for w, v in kw.items() if v[0] + v[1] >= 2 or v[1] >= 1]
    scored.sort(key=lambda x: -(x[1][0] + x[1][1] * 3))
    s["kw"] = [[w] + v for w, v in scored[:250]]
    reps = sorted(rep.items(), key=lambda x: -(x[1][2] * 10 + x[1][0]))[:80]
    s["rep"] = [[name, oid] + v for (name, oid), v in reps]
    return s


def build_month(ym):
    days = {}
    names = sorted({p.stem for p in (DATA / "ranking").glob(f"{ym}-*.json")} |
                   {p.stem for p in (DATA / "articles").glob(f"{ym}-*.json")} |
                   {p.stem for p in (DATA / "counts").glob(f"{ym}-*.json")})
    for d in names:
        s = build_day_summary(d)
        if s:
            days[d] = s
    write_json(DATA / "summary" / f"{ym}.json", {"month": ym, "days": days})
    return len(days)


def build_meta(status=None):
    rk_days = sorted(p.stem for p in (DATA / "ranking").glob("*.json"))
    ar_days = sorted(p.stem for p in (DATA / "articles").glob("*.json"))
    months = sorted(p.stem for p in (DATA / "summary").glob("*.json"))
    meta = read_json(DATA / "meta.json", {}) or {}
    meta["coverage"] = media_coverage()
    cat = read_json(DATA / "media_catalog.json")
    if cat:
        meta["naver_catalog"] = dict(cat.get("counts", {}), updated_at=cat.get("updated_at"))
    meta.update({
        "retention_months": CONFIG.get("retention_months", 24),
        "updated_at": now_kst().isoformat(timespec="seconds"),
        "media": CONFIG["media"],
        "ranking_media": CONFIG["ranking_media"],
        "publish_media": CONFIG["publish_media"],
        "count_media": CONFIG.get("count_media", []),
        "view_rank": CONFIG.get("view_rank"),
        "view_pub": CONFIG.get("view_pub"),
        "our_media": CONFIG.get("our_media"),
        "compare_media": CONFIG.get("compare_media", "296"),
        "ranking_size": CONFIG.get("ranking_size", 20),
        "naver_total": CONFIG.get("naver_total"),
        "google_anchor": CONFIG.get("google_anchor", "날씨"),
        "ranking_days": rk_days,
        "article_days": ar_days,
        "months": months,
        "search_days": sorted(p.stem for p in (DATA / "search").glob("*.json")),
        "snap_days": sorted(p.stem for p in (DATA / "snap").glob("*.json")),
        "first": min(rk_days[:1] + ar_days[:1]) if (rk_days or ar_days) else None,
        "last": max(rk_days[-1:] + ar_days[-1:]) if (rk_days or ar_days) else None,
    })
    if status is not None:
        meta["last_run"] = status
        hist = meta.get("runs", [])
        hist.insert(0, {k: status[k] for k in ("at", "ok", "ranking", "articles", "counts", "errors_n") if k in status})
        meta["runs"] = hist[:20]
    write_json(DATA / "meta.json", meta, pretty=True)
    return meta


def rebuild(days):
    """변경된 날짜들이 속한 월 요약 + meta 재생성"""
    for ym in sorted({d[:7] for d in days}):
        build_month(ym)


# ── 보관 기간 (기본 24개월) ─────────────────────────────────
def prune(months=None):
    """보관 기간(config retention_months, 기본 24개월)보다 오래된 데이터를 오래된 것부터 삭제.
    일별 파일(랭킹·발행·건수·스냅샷·검색어)은 기준일 이전 날짜, 월별 파일(요약·접속/활동 기록)은 기준월 이전 달을 지운다.
    기준월 요약은 남은 날짜로 다시 만든다. 지운 파일 수를 돌려준다."""
    months = months or CONFIG.get("retention_months", 24)
    t = today_kst()
    y, m = t.year, t.month - months
    while m <= 0:
        m += 12
        y -= 1
    import calendar
    cutoff = dt.date(y, m, min(t.day, calendar.monthrange(y, m)[1])).isoformat()  # 이 날짜부터 보관
    cut_ym = cutoff[:7]
    removed = 0
    for sub in ("ranking", "articles", "counts", "snap", "search"):
        for p in (DATA / sub).glob("*.json"):
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", p.stem) and p.stem < cutoff:
                p.unlink()
                removed += 1
    import shutil
    for p in (DATA / "titles").glob("*"):
        if p.is_dir() and re.fullmatch(r"\d{4}-\d{2}", p.name) and p.name < cut_ym:
            shutil.rmtree(p)
            removed += 1
    for sub in ("summary", "logs/access", "logs/activity"):
        for p in (DATA / sub).glob("*.json"):
            if re.fullmatch(r"\d{4}-\d{2}", p.stem) and p.stem < cut_ym:
                p.unlink()
                removed += 1
    if removed and (DATA / "summary" / f"{cut_ym}.json").exists():
        build_month(cut_ym)
    return {"cutoff": cutoff, "removed": removed}


def media_coverage():
    """매체별 수집 현황: {oid: {"r": [첫날, 마지막날, 수집일수, [빠진날…]], "p": …(발행 상세), "c": …(발행 건수)}}"""
    def span(days_by_oid):
        out = {}
        for oid, ds in days_by_oid.items():
            ds = sorted(ds)
            full = date_range(ds[0], ds[-1])
            have = set(ds)
            miss = [d for d in full if d not in have]
            out[oid] = [ds[0], ds[-1], len(ds), miss[:40]]
        return out
    rk, ar, cn = defaultdict(set), defaultdict(set), defaultdict(set)
    for p in (DATA / "ranking").glob("*.json"):
        doc = read_json(p) or {}
        for o in {it[0] for it in doc.get("items", [])}:
            rk[o].add(p.stem)
    for p in (DATA / "articles").glob("*.json"):
        doc = read_json(p) or {}
        for o, m in (doc.get("media") or {}).items():
            if m.get("n") is not None:
                ar[o].add(p.stem)
    for p in (DATA / "counts").glob("*.json"):
        doc = read_json(p) or {}
        for o, m in (doc.get("media") or {}).items():
            if m.get("n") is not None:
                cn[o].add(p.stem)
    R, P, C = span(rk), span(ar), span(cn)
    cov = {}
    for o in set(R) | set(P) | set(C):
        cov[o] = {k: v[o] for k, v in (("r", R), ("p", P), ("c", C)) if o in v}
    return cov
