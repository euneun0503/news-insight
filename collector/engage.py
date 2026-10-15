"""기사 반응 수집 (댓글 수 · 공감 반응 · 추천)

대상: 랭킹 기사 중 조회수를 공개하는 매체의 기사 전부 (config.json engage_media 에 매체 코드를 적으면 그 매체만).
네이버 기사 화면이 불러오는 것과 같은 공개 데이터를 읽어 수집 시점의 숫자를 저장합니다.
실패해도 랭킹 수집은 계속되고, 그 기사는 '미수집'으로 남습니다.

저장: data/engage/YYYY-MM-DD.json
  {"updated_at": ISO, "items": {"346_0000123456": {"cm": 댓글 수, "re": {좋아요 등}, "rc": {추천 등}, "at": ISO}}}
"""
import json
import re
from concurrent.futures import ThreadPoolExecutor

COMMENT_API = "https://apis.naver.com/commentBox/cbox/web_neo_list_jsonp.json"
LIKE_API = "https://news.like.naver.com/v1/search/contents"

# 기사 본문 위 감정 반응(NEWS)과 본문 아래 추천(NEWS_MAIN)
REACTION_LABEL = {"like": "좋아요", "warm": "훈훈해요", "sad": "슬퍼요", "angry": "화나요", "want": "후속기사 원해요"}
RECOMMEND_LABEL = {"useful": "쏠쏠정보", "wow": "흥미진진", "touched": "공감백배", "analytical": "분석탁월", "recommend": "후속강추"}


def _article_url(oid, aid):
    return f"https://n.news.naver.com/mnews/article/{oid}/{aid}"


def parse_jsonp(text):
    """jQuery123({...}); → dict"""
    m = re.search(r"^[^(]*\((.*)\)\s*;?\s*$", text.strip(), re.S)
    return json.loads(m.group(1) if m else text)


def comment_count(j):
    res = (j or {}).get("result") or {}
    cnt = res.get("count") or {}
    for k in ("comment", "total"):
        if isinstance(cnt.get(k), int):
            return cnt[k]
    if isinstance(res.get("commentCount"), int):
        return res["commentCount"]
    return None


def split_reactions(j):
    """좋아요 API 응답 → (감정 반응 dict, 추천 dict). 모르는 종류도 그대로 둠."""
    re_, rc = {}, {}
    for c in (j or {}).get("contents") or []:
        for r in c.get("reactions") or []:
            t, n = r.get("reactionType"), r.get("count")
            if t and isinstance(n, int):
                target = rc if t in RECOMMEND_LABEL else re_  # 종류로 나눔 (네이버는 지금 추천 5종만 씀)
                target[t] = target.get(t, 0) + n  # 뉴스·연예·스포츠 중 실제로 쓰인 곳의 값을 더함 (나머지는 0)
    return re_, rc


# 연예·스포츠 기사는 네이버 연예/스포츠 화면이라 댓글·반응 저장소 이름이 다름 → 뉴스에서 0이면 차례로 확인
COMMENT_TICKETS = [
    {"ticket": "news", "templateId": "default_society", "pool": "cbox5"},
    {"ticket": "entertain", "templateId": "default_entertain", "pool": "cbox5"},
    {"ticket": "sports", "templateId": "default_sports", "pool": "cbox2"},
]


def fetch_one(session, oid, aid):
    out = {}
    ref = {"Referer": _article_url(oid, aid)}
    best = None
    for t in COMMENT_TICKETS:
        try:
            r = session.get(COMMENT_API, timeout=10, headers=ref, params={
                **t, "lang": "ko", "country": "KR", "objectId": f"news{oid},{aid}", "pageSize": 1, "indexSize": 1,
                "page": 1, "sort": "FAVORITE", "initialize": "true", "_callback": "cb"})
            if r.ok:
                n = comment_count(parse_jsonp(r.text))
                if n is not None:
                    best = max(best or 0, n)
                    if n > 0:
                        break
        except Exception:
            pass
    if best is not None:
        out["cm"] = best
    try:
        k = f"ne_{oid}_{aid}"
        r = session.get(LIKE_API, timeout=10, headers=ref, params={
            "suppress_response_codes": "true",
            "q": f"NEWS[{k}]|NEWS_MAIN[{k}]|ENTERTAIN[{k}]|ENTERTAIN_MAIN[{k}]|SPORTS[{k}]|SPORTS_MAIN[{k}]"})
        if r.ok:
            re_, rc = split_reactions(r.json())
            out["re"] = re_  # 아무도 누르지 않은 기사는 빈 값({}) = 0
            out["rc"] = rc
    except Exception:
        pass
    return out


def collect(session, keys, at, path, workers=4):
    """keys: [(oid, aid)] → path(JSON)에 병합 저장. 반환: (성공 건수, 대상 건수)"""
    old = {}
    if path.exists():
        try:
            old = json.loads(path.read_text("utf-8")).get("items", {})
        except Exception:
            old = {}
    keys = list(dict.fromkeys(keys))
    with ThreadPoolExecutor(max_workers=workers) as ex:
        results = list(ex.map(lambda k: (k, fetch_one(session, *k)), keys))
    ok = 0
    for (oid, aid), v in results:
        if not v:
            continue
        ok += 1
        v["at"] = at
        old[f"{oid}_{aid}"] = {**old.get(f"{oid}_{aid}", {}), **v}
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"updated_at": at, "items": old}, ensure_ascii=False, separators=(",", ":")), "utf-8")
    return ok, len(keys)
