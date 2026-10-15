"""이슈데스크 수집기 (GitHub Actions에서 실행)

- 커뮤니티 인기글(실시간 커뮤니티 인기글 모음 trends.json)에서 최근 36시간 글을 모아
  건강·문화·연예인·이슈로 나누고 반응(조회·추천·댓글) 순으로 골라 오늘 보고서에 더합니다.
- 이미 있는 항목(같은 URL)은 반응 수치만 갱신하고, 사람이 쓴 기사 앵글은 그대로 둡니다.
- ANTHROPIC_API_KEY 가 있으면 새 항목의 기사 앵글·확인할 것·추천도를 Claude가 작성합니다.
  없으면 반응 수치로 추천도를 매기고 앵글 칸은 '자동 수집'으로 둡니다.
- 결과: data/issuedesk/YYYY-MM-DD.json, data/issuedesk/index.json
"""
import json
import os
import re
import sys
import urllib.request
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))
ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "issuedesk"
TRENDS = "https://gumoyaz.github.io/korean-community-crawler/data/trends.json"
MAX_NEW = int(os.environ.get("ISSUEDESK_MAX_NEW", "20"))
MAX_PER_CAT = 8

HEALTH = re.compile(r"건강|다이어트|살\s?빼|체중|비만|마운자로|위고비|병원|의사|간호|약국|약\b|처방|암\b|질환|증상|식단|영양|백신|독감|코로나|감기|수술|성형|운동|헬스|수면|커피|혈압|당뇨|치매|우울|정신과|탈모|임신|출산|생리|피부과|식약처|건보")
CULTURE = re.compile(r"드라마|영화|예능|방송|시청률|넷플릭스|공연|전시|뮤지컬|책\b|소설|웹툰|여행|맛집|음식|식당|카페|메뉴|케이팝|K-?팝|노래|음원|앨범|패션|트렌드|광고|유행")
EXCLUDE = re.compile(r"\.gif|\.mp4|ㅋㅋㅋ|짤|레전드\s*$|후방|ㄷㄷㄷㄷ|언더붑|노출|ㅗ")


def now_kst():
    return datetime.now(KST)


def fetch_json(url):
    req = urllib.request.Request(url, headers={"User-Agent": "news-insight-issuedesk/1.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return json.loads(r.read().decode("utf-8"))


def parse_date(s):
    if not s:
        return None
    try:
        d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=KST)
        return d.astimezone(KST)
    except ValueError:
        m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
        return datetime.fromisoformat(m.group(1)).replace(tzinfo=KST) if m else None


def classify(p):
    t = p.get("title", "")
    if p.get("is_celeb"):
        return "연예인"
    if HEALTH.search(t) or p.get("is_beauty"):
        return "건강"
    if CULTURE.search(t) or p.get("is_food") or p.get("is_travel") or p.get("is_fashion"):
        return "문화"
    return "이슈"


def heat(p):
    return (p.get("views") or 0) / 10000 + (p.get("likes") or 0) / 300 + (p.get("comments") or 0) / 60


def stars(h):
    return 5 if h >= 12 else 4 if h >= 6 else 3 if h >= 3 else 2 if h >= 1.5 else 1


def claude_angles(items):
    """새 항목에 기사 앵글·확인할 것·추천도를 붙인다 (키가 없으면 건너뜀)."""
    key = os.environ.get("ANTHROPIC_API_KEY")
    if not key or not items:
        return False
    lines = [f'{i}. [{x["category"]}] {x["title"]} ({x["source"]}, 조회 {x.get("views")}, 추천 {x.get("likes")}, 댓글 {x.get("comments")})' for i, x in enumerate(items)]
    prompt = (
        "한국 언론사 온라인 이슈팀 데스크입니다. 아래 커뮤니티 인기글 각각에 대해 기사화 관점을 정리해 주세요.\n"
        "각 항목마다 JSON 객체 {\"i\": 번호, \"score\": 1~5 정수(기사화 추천도), \"angle\": 한두 문장(어떤 기사로 쓸 수 있는지), "
        "\"check\": 한 문장(확인할 사실·취재원·주의점), \"drop\": 기사 가치가 없거나 선정적·사적 신상 폭로면 true}를 만들고, "
        "JSON 배열 하나만 출력하세요. 확인되지 않은 주장은 단정하지 말고, 원문 제목의 혐오 표현은 옮기지 마세요.\n\n" + "\n".join(lines)
    )
    body = json.dumps({
        "model": os.environ.get("ISSUEDESK_MODEL", "claude-sonnet-5-5"),
        "max_tokens": 6000,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")
    req = urllib.request.Request("https://api.anthropic.com/v1/messages", data=body, headers={
        "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            res = json.loads(r.read().decode("utf-8"))
        text = "".join(b.get("text", "") for b in res.get("content", []) if b.get("type") == "text")
        arr = json.loads(text[text.index("["): text.rindex("]") + 1])
    except Exception as e:  # 실패해도 수집 결과는 저장
        print("Claude 앵글 작성 실패:", e, file=sys.stderr)
        return False
    for a in arr:
        try:
            x = items[int(a["i"])]
        except (KeyError, ValueError, IndexError, TypeError):
            continue
        if a.get("drop"):
            x["_drop"] = True
            continue
        x["score"] = max(1, min(5, int(a.get("score") or x["score"])))
        x["angle"] = str(a.get("angle") or x["angle"])[:400]
        x["check"] = str(a.get("check") or "")[:300]
        x.pop("auto", None)
    return True


def main():
    now = now_kst()
    today = now.strftime("%Y-%m-%d")
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / f"{today}.json"
    idx_path = OUT / "index.json"
    idx = json.loads(idx_path.read_text("utf-8")) if idx_path.exists() else {"days": []}

    if path.exists():
        doc = json.loads(path.read_text("utf-8"))
    else:
        doc = {"date": today, "note": "", "items": []}
        prev = sorted(d for d in idx.get("days", []) if d < today)
        if prev:  # 보도자료는 새로 모을 때까지 직전 보고서 것을 이어서 보여줌
            p = json.loads((OUT / f"{prev[-1]}.json").read_text("utf-8"))
            if p.get("press"):
                doc["press"] = p["press"]

    data = fetch_json(TRENDS)
    posts = data.get("posts", data if isinstance(data, list) else [])
    cutoff = now - timedelta(hours=36)
    by_url = {i["url"]: i for i in doc["items"]}
    updated = 0
    cands = []
    for p in posts:
        url, title = p.get("url"), (p.get("title") or "").strip()
        if not url or not title:
            continue
        if url in by_url:  # 기존 항목은 수치만 갱신
            for k in ("views", "likes", "comments"):
                if p.get(k):
                    by_url[url][k] = max(by_url[url].get(k) or 0, p[k])
            updated += 1
            continue
        d = parse_date(p.get("date"))
        if d and d < cutoff:
            continue
        if p.get("is_humor") or p.get("is_game") or p.get("is_car") or EXCLUDE.search(title):
            continue
        cands.append((heat(p), p, d))

    cands.sort(key=lambda c: -c[0])
    per_cat, new = {}, []
    for hval, p, d in cands:
        cat = classify(p)
        if per_cat.get(cat, 0) >= MAX_PER_CAT or len(new) >= MAX_NEW or hval < 1:
            continue
        per_cat[cat] = per_cat.get(cat, 0) + 1
        new.append({
            "category": cat, "title": p["title"].strip(), "url": p["url"],
            "source": p.get("source_label") or p.get("source") or "",
            "views": p.get("views") or None, "likes": p.get("likes") or None, "comments": p.get("comments") or None,
            "score": stars(hval), "angle": "자동 수집 항목입니다. 기사 앵글은 아직 작성되지 않았습니다.", "check": "",
            "covered": False, "press": [], "date": (d or now).strftime("%Y-%m-%d"), "auto": True,
        })

    used_claude = claude_angles(new)
    new = [x for x in new if not x.pop("_drop", False)]
    doc["items"].extend(new)
    doc["date"] = today
    doc["generatedAt"] = now.isoformat(timespec="seconds")
    doc["refreshedAt"] = doc["generatedAt"]
    if not doc.get("note"):
        doc["note"] = f"{now:%H:%M} 자동 수집: 최근 36시간 커뮤니티 인기글 중 반응이 큰 {len(new)}건을 모았습니다."
    path.write_text(json.dumps(doc, ensure_ascii=False, indent=1), "utf-8")

    days = sorted(set(idx.get("days", [])) | {today})
    idx.update({"days": days, "updatedAt": doc["generatedAt"]})
    idx_path.write_text(json.dumps(idx, ensure_ascii=False), "utf-8")
    print(f"{today}: 새 항목 {len(new)}건 추가, 기존 {updated}건 수치 갱신, Claude 앵글 {'사용' if used_claude else '미사용'}")


if __name__ == "__main__":
    main()
