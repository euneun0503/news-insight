"""스포츠·연예 기사 날짜·기자명 위치 확인 → data/cache/diag2.json"""
import json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import store, collect  # noqa
S = collect.make_session(2)
out = []
for oid, aid in (("421", "0009216091"), ("001", "0016364477"), ("081", "0003686924")):
    rec = {"key": f"{oid}_{aid}"}
    for name, url in (("sports", f"https://api-gw.sports.naver.com/news/article/{oid}/{aid}"), ("entertain", f"https://api-gw.entertain.naver.com/news/article/{oid}/{aid}")):
        r = S.get(url, timeout=10)
        try:
            j = r.json()
            def walk(o, p=""):
                res = {}
                if isinstance(o, dict):
                    for k, v in o.items():
                        res.update(walk(v, f"{p}.{k}" if p else k))
                elif isinstance(o, list):
                    for i, v in enumerate(o[:2]):
                        res.update(walk(v, f"{p}[{i}]"))
                else:
                    sv = str(o)
                    res[p] = sv[:80]
                return res
            flat = walk(j)
            rec[name] = {k: v for k, v in flat.items() if re.search(r"date|time|Date|Time|byline|reporter|Reporter|writer|journalist|name|Name", k)}
        except Exception as e:
            rec[name] = f"{r.status_code} {e} {r.text[:200]}"
    page = S.get(f"https://n.news.naver.com/mnews/article/{oid}/{aid}", timeout=12)
    rec["page_dates"] = [page.text[max(0, m.start() - 60): m.end() + 10] for m in re.finditer(r"\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}", page.text)][:5]
    out.append(rec)
store.write_json(store.DATA / "cache" / "diag2.json", out, pretty=True)
print(json.dumps(out, ensure_ascii=False, indent=1)[:5000])
