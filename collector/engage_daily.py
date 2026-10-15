"""전날 랭킹 기사 반응(댓글·공감 반응·추천) 하루 한 번 수집 — 매일 02:30(한국시간) engage.yml 에서 실행

- 대상: 전날 랭킹 기사 중 조회수를 공개하는 매체의 기사 (config.json engage_media 에 매체 코드를 적으면 그 매체만)
        + 우리 매체(헬스조선·코메디닷컴, config engage_publish_media)의 전날 발행 기사 전부
- 그날 이후에 늘어나는 댓글·반응은 다시 수집하지 않습니다 (하루 1회, 전날 기준).
- 사용: python collector/engage_daily.py [YYYY-MM-DD]  (날짜를 비우면 어제)
"""
import re
import sys
import datetime as dt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
import engage  # noqa: E402
from collect import make_session  # noqa: E402
from store import CONFIG, DATA, now_kst, today_kst  # noqa: E402


def debug(keys):
    """문제 기사 확인용: 기사 주소 이동 결과와 댓글·반응 응답 원문 일부를 data/cache/engage_debug.txt 에 저장"""
    session = make_session(2)
    lines = []
    def say(*a):
        lines.append(" ".join(str(x) for x in a))
        print(*a)
    for k in keys:
        oid, aid = k.split("_")
        try:
            r = session.get(engage._article_url(oid, aid), timeout=12)
            say("==", k, "→", r.url, r.status_code)
            for t in engage.COMMENT_TICKETS:
                c = session.get(engage.COMMENT_API, timeout=10, headers={"Referer": r.url}, params={**t, "lang": "ko", "country": "KR", "objectId": f"news{oid},{aid}", "pageSize": 1, "indexSize": 1, "page": 1, "sort": "FAVORITE", "initialize": "true", "_callback": "cb"})
                say("  댓글", t["ticket"], c.status_code, c.text[:400].replace("\n", " "))
            q = "|".join(f"{x}[ne_{oid}_{aid}]" for x in ["NEWS", "NEWS_MAIN", "ENTERTAIN", "ENTERTAIN_MAIN", "SPORTS", "SPORTS_MAIN"])
            l = session.get(engage.LIKE_API, timeout=10, headers={"Referer": r.url}, params={"suppress_response_codes": "true", "q": q})
            say("  반응", l.status_code, l.text[:800])
            marks = set()
            for pat in [r'data-cid="([^"]+)"', r'(?:NEWS|NEWS_MAIN|ENTERTAIN|SPORTS)\[[^\]]+\]', r'_reactionModule[^>]{0,200}', r'u_likeit[^>]{0,200}', r'cbox[^"\']{0,80}']:
                marks.update(m if isinstance(m, str) else str(m) for m in re.findall(pat, r.text)[:8])
            for m in sorted(marks)[:30]:
                say("  페이지 표식", m[:200])
        except Exception as e:
            say("  오류", k, e)
    (DATA / "cache").mkdir(parents=True, exist_ok=True)
    (DATA / "cache" / "engage_debug.txt").write_text("\n".join(lines), "utf-8")


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "--debug":
        return debug(sys.argv[2].split(","))
    day = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else (today_kst() - dt.timedelta(days=1)).isoformat()
    doc = store.read_json(store.ranking_path(day), None) or {}
    em = CONFIG.get("engage_media")
    keys = [(r[0], r[1]) for r in doc.get("items", []) if (not em or r[0] in em) and r[3] is not None]
    # 헬스조선·코메디닷컴 발행 기사 전부
    pm = CONFIG.get("engage_publish_media", ["346", "296"])
    arts = store.read_json(store.articles_path(day), None) or {}
    pkeys = [(a[0], a[1]) for a in arts.get("items", []) if a[0] in pm]
    print(f"랭킹 {len(keys)}건 + 발행({', '.join(pm)}) {len(pkeys)}건")
    keys += pkeys
    if not keys:
        print(f"{day} 수집할 기사가 없습니다.")
        return
    session = make_session(8)
    ok, n = engage.collect(session, keys, now_kst().isoformat(timespec="seconds"), DATA / "engage" / f"{day}.json", workers=8)
    print(f"💬 {day} 댓글·반응: {ok}/{n}건")
    if n and ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
