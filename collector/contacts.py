"""기자 연락처(소속·이름·이메일) 수집 — 암호화 저장

저장소가 공개이므로 이메일은 평문으로 남기지 않습니다.
- 마스터가 관리자 화면에서 만든 공개키(data/contacts/public_key.json)로만 암호화합니다.
  개인키는 사이트 로그인 금고 열쇠로 잠가 data/contacts/private_key.json 에 두고, 브라우저에서만 풉니다.
- 수집할 때마다 새로 확인된 (매체, 이름, 이메일) 묶음을 한 줄로 암호화해 data/contacts/YYYY-MM.jsonl 에 덧붙입니다.
  같은 조합은 data/contacts/seen.json(해시만 저장)으로 걸러 다시 쓰지 않고, 확인 횟수만 따로 셉니다.
- 공개키가 아직 없으면 아무것도 저장하지 않습니다 (이메일은 버림).

한 줄 형식: {"at": ISO, "k": RSA-OAEP(SHA-256)로 감싼 AES 키(b64), "iv": b64, "ct": AES-256-GCM 암호문(b64)}
암호문을 풀면: [{"o": 매체코드, "n": 이름, "e": 이메일, "d": 기사 날짜, "a": 기사번호}, ...]
"""
import base64
import hashlib
import json
import os
import re
import threading
from pathlib import Path

from store import DATA, now_kst

DIR = DATA / "contacts"
_lock = threading.Lock()
_pending = {}  # (oid, name, email) -> {"d": 처음 본 날짜, "a": aid, "n": 횟수}
# 30분 수집과 과거 채우기가 동시에 돌아도 서로의 파일을 덮지 않도록 파일을 나눔 (과거 채우기: "bf-")
PREFIX = ""

NAME = r"[가-힣]{2,4}"
ROLE = r"(?:기자|특파원|객원기자|선임기자|전문기자|수습기자|기상캐스터|인턴기자)"
EMAIL = r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"
BAD = {"press", "webmaster", "help", "news", "jebo", "master", "admin", "info", "contact", "privacy", "report"}
TITLE = set("선임 전문 객원 수석 수습 인턴 의학전문 전문의 기상 대기자 편집 사진 영상 디지털".split())
UI = set("닫기 열기 확인 취소 수정 입력 공유 저장 삭제 이전 다음 전체 댓글 구독 로그인 메뉴 검색 알림 본문 기사 이메일 제보".split())


def extract(soup, html=""):
    """바이라인·본문에서 (이름, 이메일) 쌍. '홍길동 기자 hong@x.com' / '홍길동 기자(hong@x.com)' / 바이라인 태그"""
    out = []
    def add(n, e):
        e = e.strip(".").lower()
        if n in UI or e.split("@")[0] in BAD or (n, e) in out:
            return
        out.append((n, e))
    texts = [t.get_text(" ", strip=True) for t in soup.select("em.media_end_head_journalist_name, span.byline_s, .byline .byline_s, p.byline_p span, .media_end_head_journalist")]
    body = soup.select_one("#dic_area, #newsct_article, #articeBody, #articleBody, article")
    if body:
        texts.append(body.get_text(" ", strip=True))
    # '홍길동 기자 x@y' / '홍길동 의학전문 기자 x@y' / 앞 낱말이 붙은 '서울 홍길동 기자 x@y' 모두 이름을 바르게 잡도록 앞뒤 두 낱말을 받아 고름
    pat1 = re.compile(r"(?<![가-힣])(" + NAME + r")\s?(?:([가-힣]{2,6})\s)?" + ROLE + r"\s*[\(\[<]?\s*(" + EMAIL + r")")
    pat2 = re.compile(r"(" + EMAIL + r")\s*[\)\]>]?\s*(" + NAME + r")\s?" + ROLE)
    nb = len(texts) - (1 if body else 0)  # 앞쪽은 바이라인 태그, 마지막은 본문
    for i, t in enumerate(texts):
        t = re.sub(r"\s+", " ", t)
        hit = False
        for m in pat1.finditer(t):
            first, mid, mail = m.group(1), m.group(2), m.group(3)
            name = first if not mid or mid in TITLE or len(mid) > 4 else mid
            add(name, mail); hit = True
        if not hit and i < nb:  # '이메일 홍길동 기자' 순서는 짧은 바이라인 태그 안에서만 (본문에서는 앞 기자 메일과 섞임)
            for m in pat2.finditer(t):
                add(m.group(2), m.group(1))
    return out[:4]


def record(oid, aid, day, pairs):
    if not pairs:
        return
    with _lock:
        for n, e in pairs:
            k = (oid, n, e)
            x = _pending.get(k)
            if x:
                x["n"] += 1
            else:
                _pending[k] = {"d": (day or "")[:10], "a": aid, "n": 1}


def _hash(oid, n, e):
    return hashlib.sha256(f"{oid}|{n}|{e}".encode()).hexdigest()[:20]


def _encrypt(pub_pem, payload):
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import padding
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM
    pub = serialization.load_pem_public_key(pub_pem.encode())
    key, iv = AESGCM.generate_key(bit_length=256), os.urandom(12)
    ct = AESGCM(key).encrypt(iv, json.dumps(payload, ensure_ascii=False).encode(), None)
    wrapped = pub.encrypt(key, padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None))
    b = lambda x: base64.b64encode(x).decode()
    return {"k": b(wrapped), "iv": b(iv), "ct": b(ct)}


def flush(log=print):
    """모은 연락처를 암호화해 저장. 반환: 새로 저장한 건수 (공개키가 없으면 None)"""
    with _lock:
        pend = dict(_pending)
        _pending.clear()
    keyf = DIR / "public_key.json"
    if not keyf.exists():
        if pend:
            log(f"   ✉️ 기자 이메일 {len(pend)}건 확인 — 암호화 열쇠가 아직 없어 저장하지 않음 (관리자 화면에서 마스터가 설정)")
        return None
    pub_pem = json.loads(keyf.read_text("utf-8"))["pem"]
    seenf = DIR / f"{PREFIX}seen.json"
    seen = json.loads(seenf.read_text("utf-8")) if seenf.exists() else {}
    new = []
    for (oid, n, e), x in pend.items():
        h = _hash(oid, n, e)
        if h in seen:
            seen[h]["c"] = seen[h].get("c", 1) + x["n"]
            seen[h]["l"] = max(seen[h].get("l", ""), x["d"])
        else:
            seen[h] = {"c": x["n"], "f": x["d"], "l": x["d"]}
            new.append({"o": oid, "n": n, "e": e, "d": x["d"], "a": x["a"]})
    if new:
        now = now_kst()
        f = DIR / f"{PREFIX}{now:%Y-%m}.jsonl"
        DIR.mkdir(parents=True, exist_ok=True)
        with open(f, "a", encoding="utf-8") as fp:
            fp.write(json.dumps({"at": now.isoformat(timespec="seconds"), **_encrypt(pub_pem, new)}) + "\n")
        idxf = DIR / f"{PREFIX}index.json"
        idx = json.loads(idxf.read_text("utf-8")) if idxf.exists() else {"files": []}
        if f.name not in idx["files"]:
            idx["files"].append(f.name)
        idx["updated_at"] = now.isoformat(timespec="seconds")
        idxf.write_text(json.dumps(idx, ensure_ascii=False), "utf-8")
    if pend:
        seenf.write_text(json.dumps(seen, separators=(",", ":")), "utf-8")
        log(f"   ✉️ 기자 이메일 새로 {len(new)}건 암호화 저장 (확인 {len(pend)}건)")
    return len(new)
