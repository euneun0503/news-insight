"""공감·추천·댓글 수 수집 가능 여부 점검 → 실행 주석으로 결과 출력"""
import json, re, sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
import store, collect  # noqa
S = collect.make_session(2)
day = "2026-10-08"
rk = store.read_json(store.ranking_path(day))
keys = [(r[0], r[1]) for r in rk["items"] if r[0] in ("346", "296")][:3]
for oid, aid in keys:
    ref = {"Referer": f"https://n.news.naver.com/mnews/article/{oid}/{aid}"}
    out = {"key": f"{oid}_{aid}"}
    tries = {
        "like": f"https://news.like.naver.com/v1/search/contents?suppress_response_codes=true&q=NEWS%5Bne_{oid}_{aid}%5D",
        "like_rec": f"https://news.like.naver.com/v1/search/contents?suppress_response_codes=true&q=NEWS_RECOMMEND%5Bne_{oid}_{aid}%5D",
        "cbox": f"https://apis.naver.com/commentBox/cbox/web_naver_list_jsonp.json?ticket=news&templateId=default_society&pool=cbox5&lang=ko&country=KR&objectId=news{oid}%2C{aid}&pageSize=1&page=1&sort=FAVORITE",
    }
    for k, u in tries.items():
        try:
            r = S.get(u, timeout=10, headers=ref)
            t = r.text
            nums = re.findall(r'"(reactionType|count|commentCount|totalCount|displayName|comment)"\s*:\s*"?([^",}]{1,30})', t)[:14]
            out[k] = [r.status_code, nums or t[:160]]
        except Exception as e:
            out[k] = ["ERR", str(e)[:100]]
    page = S.get(f"https://n.news.naver.com/mnews/article/{oid}/{aid}", timeout=12)
    body = re.search(r'id="dic_area"(.*?)</article>', page.text, re.S)
    txt = re.sub(r"<[^>]+>", "", body.group(1)) if body else ""
    out["body_chars"] = len(re.sub(r"\s+", "", txt))
    out["imgs"] = page.text.count('class="end_photo_org"') + page.text.count("_LAZY_LOADING")
    print("::notice::" + json.dumps(out, ensure_ascii=False)[:900])
