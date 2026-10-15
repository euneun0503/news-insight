"""전날 랭킹 기사 반응(댓글·공감 반응·추천) 하루 한 번 수집 — 매일 02:30(한국시간) engage.yml 에서 실행

- 대상: 전날 랭킹 기사 중 조회수를 공개하는 매체의 기사 (config.json engage_media 에 매체 코드를 적으면 그 매체만)
- 그날 이후에 늘어나는 댓글·반응은 다시 수집하지 않습니다 (하루 1회, 전날 기준).
- 사용: python collector/engage_daily.py [YYYY-MM-DD]  (날짜를 비우면 어제)
"""
import sys
import datetime as dt
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
import engage  # noqa: E402
from collect import make_session  # noqa: E402
from store import CONFIG, DATA, now_kst, today_kst  # noqa: E402


def main():
    day = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else (today_kst() - dt.timedelta(days=1)).isoformat()
    doc = store.read_json(store.ranking_path(day), None)
    if not doc:
        print(f"{day} 랭킹 파일이 없습니다.")
        return
    em = CONFIG.get("engage_media")
    keys = [(r[0], r[1]) for r in doc.get("items", []) if (not em or r[0] in em) and r[3] is not None]
    session = make_session(8)
    ok, n = engage.collect(session, keys, now_kst().isoformat(timespec="seconds"), DATA / "engage" / f"{day}.json", workers=8)
    print(f"💬 {day} 랭킹 기사 댓글·반응: {ok}/{n}건")
    if n and ok == 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
