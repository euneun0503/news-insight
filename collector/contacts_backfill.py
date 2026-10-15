"""기자 이메일 과거 채우기 — 이미 수집한 기사 페이지를 다시 열어 바이라인 이메일만 모읍니다 (contacts.yml)

사용: python collector/contacts_backfill.py 시작일 종료일 [ranking_days]
  - 헬스조선·코메디닷컴(config our/compare 매체): 시작일~종료일 발행 기사 전부
  - 그 밖의 매체: 종료일 기준 최근 ranking_days일(기본 7) 랭킹 기사
"""
import sys
import datetime as dt
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
import contacts  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402
from collect import make_session  # noqa: E402
from store import CONFIG  # noqa: E402


def main():
    start, end = sys.argv[1], sys.argv[2]
    rdays = int(sys.argv[3]) if len(sys.argv) > 3 and sys.argv[3] else 7
    ours = set(CONFIG.get("engage_publish_media", ["346", "296"]))
    keys = {}
    for d in store.date_range(start, end):
        for a in (store.read_json(store.articles_path(d), None) or {}).get("items", []):
            if a[0] in ours:
                keys[(a[0], a[1])] = d
    e = dt.date.fromisoformat(end)
    for d in store.date_range((e - dt.timedelta(days=rdays - 1)).isoformat(), end):
        for r in (store.read_json(store.ranking_path(d), None) or {}).get("items", []):
            keys.setdefault((r[0], r[1]), d)
    print(f"기사 {len(keys)}건 확인 (우리 매체 발행 {start}~{end}, 전 매체 랭킹 최근 {rdays}일)")
    session = make_session(8)

    def one(k):
        (oid, aid), d = k
        try:
            r = session.get(f"https://n.news.naver.com/mnews/article/{oid}/{aid}", timeout=12)
            if r.ok:
                contacts.record(oid, aid, d, contacts.extract(BeautifulSoup(r.text, "html.parser"), r.text))
        except Exception:
            pass

    with ThreadPoolExecutor(max_workers=8) as ex:
        for i, _ in enumerate(ex.map(one, keys.items()), 1):
            if i % 500 == 0:
                print(f"  {i}/{len(keys)}")
                contacts.flush()  # 중간 저장
    n = contacts.flush()
    print("완료", n)


if __name__ == "__main__":
    main()
