"""기자 이메일 과거 채우기 (contacts.yml)

기자 한 명당 최근 기사 1건만 열어 바이라인 이메일을 찾습니다. 못 찾으면 다음 실행 때 다른 기사로 최대 3번까지.
- 대상 기자: 헬스조선·코메디닷컴은 시작일 이후 발행 기사의 기자 전부, 그 밖의 매체는 최근 N일 랭킹 기사의 기자
- 한 번에 최대 --minutes 분만 돌고, 몇 분마다 저장합니다. 남은 기자가 있으면 워크플로가 다음 실행을 이어 붙입니다.
- 진행 상황(건수·속도)은 data/contacts/backfill.json 에 남습니다. 기자 이름은 해시로만 저장합니다.

사용: python collector/contacts_backfill.py 시작일 종료일 [ranking_days] [--minutes 40]
"""
import hashlib
import json
import sys
import time
import datetime as dt
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import store  # noqa: E402
import contacts  # noqa: E402
from bs4 import BeautifulSoup  # noqa: E402
from collect import make_session  # noqa: E402
from store import CONFIG, DATA, now_kst  # noqa: E402

STATE = DATA / "contacts" / "backfill.json"
MAX_TRIES = 3


def hk(oid, name):
    return hashlib.sha256(f"{oid}|{name}".encode()).hexdigest()[:16]


def names_of(s):
    return [n.strip() for n in (s or "").split("·") if 2 <= len(n.strip()) <= 4]


def targets(start, end, rdays):
    """{(oid, 이름): [최근 기사 aid 들(최신순)]}"""
    ours = set(CONFIG.get("engage_publish_media", ["346", "296"]))
    arts = {}
    def add(oid, name, aid, when):
        arts.setdefault((oid, name), []).append((when, aid))
    for d in store.date_range(start, end):
        for a in (store.read_json(store.articles_path(d), None) or {}).get("items", []):
            if a[0] in ours:
                for n in names_of(a[4] if len(a) > 4 else ""):
                    add(a[0], n, a[1], d + (a[2] or ""))
    e = dt.date.fromisoformat(end)
    for d in store.date_range((e - dt.timedelta(days=rdays - 1)).isoformat(), end):
        for r in (store.read_json(store.ranking_path(d), None) or {}).get("items", []):
            for n in names_of(r[5] if len(r) > 5 else ""):
                add(r[0], n, r[1], r[6] or d)
    out = {}
    for k, lst in arts.items():
        seen, aids = set(), []
        for _, aid in sorted(lst, reverse=True):
            if aid not in seen:
                seen.add(aid)
                aids.append(aid)
        out[k] = aids[:MAX_TRIES]
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    minutes = 40
    if "--minutes" in sys.argv:
        minutes = int(sys.argv[sys.argv.index("--minutes") + 1])
        args = [a for a in args if a != str(minutes)]
    start, end = args[0], args[1]
    rdays = int(args[2]) if len(args) > 2 and args[2] else 7
    deadline = time.time() + minutes * 60

    contacts.PREFIX = "bf-"  # 30분 수집 파일과 따로 저장
    st = store.read_json(STATE, None) or {}
    tries = st.get("tries", {})   # 해시 → 시도 횟수
    found = set(st.get("found", []))  # 이메일을 찾은 기자 해시
    tg = targets(start, end, rdays)
    todo = [(k, aids) for k, aids in tg.items() if hk(*k) not in found and tries.get(hk(*k), 0) < min(MAX_TRIES, len(aids))]
    print(f"대상 기자 {len(tg)}명 · 이미 찾음 {sum(1 for k in tg if hk(*k) in found)}명 · 이번에 확인할 기자 {len(todo)}명")

    session = make_session(6)
    t0, done, hit = time.time(), 0, 0

    def one(item):
        (oid, name), aids = item
        aid = aids[tries.get(hk(oid, name), 0)]
        try:
            r = session.get(f"https://n.news.naver.com/mnews/article/{oid}/{aid}", timeout=10)
            if not r.ok:
                return (oid, name), False
            pairs = contacts.extract(BeautifulSoup(r.text, "html.parser"), r.text)
            contacts.record(oid, aid, now_kst().strftime("%Y-%m-%d"), pairs)
            return (oid, name), any(n == name for n, _ in pairs)
        except Exception:
            return (oid, name), False

    def save(final=False):
        contacts.flush()
        remaining = sum(1 for k, aids in tg.items() if hk(*k) not in found and tries.get(hk(*k), 0) < min(MAX_TRIES, len(aids)))
        el = max(1, time.time() - t0)
        st.update({"tries": tries, "found": sorted(found), "updated_at": now_kst().isoformat(timespec="seconds"),
                   "status": {"대상 기자": len(tg), "이메일 찾은 기자": sum(1 for k in tg if hk(*k) in found), "남은 기자": remaining,
                              "이번 실행 확인": done, "이번 실행 찾음": hit, "분당 확인": round(done / el * 60, 1), "끝남": final and remaining == 0}})
        STATE.parent.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(st, ensure_ascii=False, separators=(",", ":")), "utf-8")
        return remaining

    last_save = time.time()
    with ThreadPoolExecutor(max_workers=6) as ex:
        it = iter(todo)
        futs = set()
        def submit():
            for item in it:
                if time.time() > deadline:
                    return False
                futs.add(ex.submit(one, item))
                return True
            return False
        for _ in range(12):
            submit()
        while futs:
            f = next(as_completed(futs))
            futs.discard(f)
            (oid, name), ok = f.result()
            h = hk(oid, name)
            tries[h] = tries.get(h, 0) + 1
            done += 1
            if ok:
                found.add(h)
                hit += 1
            if time.time() - last_save > 180:
                save()
                last_save = time.time()
                print(f"  {done}건 확인 · 이메일 {hit}명 · 분당 {round(done / max(1, time.time() - t0) * 60)}건")
            submit()
    remaining = save(final=True)
    print(f"이번 실행: {done}명 확인, {hit}명 이메일 찾음, 남은 기자 {remaining}명")
    Path("backfill_more").write_text("1" if remaining else "0")


if __name__ == "__main__":
    main()
