// 뉴스통계 (N) > 매체 설정: 랭킹 조회수·발행 수에 넣을 매체를 카테고리별로 고른다
import { esc, h, $, $$, toast } from "./util.js";
import { meta, mediaName, loadCatalog, mediaSel, defaultSel, setPersonalSel, personalSel } from "./data.js";
import { adminForSettings, saveSiteSettings } from "./admin.js";

export async function openMediaSettings(slot) {
  if (slot.firstChild) { slot.innerHTML = ""; return; }
  slot.innerHTML = '<div class="card"><div class="loading">언론사 목록 불러오는 중…</div></div>';
  const M = meta();
  const [cat, admin] = await Promise.all([loadCatalog(), adminForSettings().catch(() => null)]);
  const rankOK = new Set(M.ranking_media || []);
  const pubDetail = new Set(M.publish_media || []);
  const pubCount = new Set(M.count_media || []);
  const fixed = new Set([M.our_media, M.compare_media].filter(Boolean));
  // 매체 목록: 언론사 목록 + 수집 중인 매체
  const list = {};
  for (const [oid, m] of Object.entries(cat?.media || {})) list[oid] = { oid, name: M.media?.[oid] || m.name, cat: m.cat || "기타", ranking: m.ranking, views: m.views };
  for (const oid of new Set([...rankOK, ...pubDetail, ...pubCount, ...Object.keys(M.media || {})])) {
    list[oid] ||= { oid, name: mediaName(oid), cat: cat ? "기타" : "수집 매체", ranking: rankOK.has(oid), views: null };
  }
  const cats = [...new Set([...(cat?.categories || []), ...Object.values(list).map((x) => x.cat)])].filter((c) => Object.values(list).some((x) => x.cat === c));
  const cur = mediaSel();
  const sel = { rank: new Set(cur.rank), pub: new Set(cur.pub) };

  const rankState = (m) => (!rankOK.has(m.oid) ? (m.ranking === false ? ["랭킹 없음", false] : ["수집 전", false]) : m.views === false ? ["조회수 미공개", true] : ["조회수", true]);
  const pubState = (m) => (pubDetail.has(m.oid) ? ["발행·기자", true] : pubCount.has(m.oid) ? ["발행 건수", true] : ["수집 전", false]);

  const card = h(`<div class="card ms-card"><div class="card-head"><div><h3>매체 설정</h3>
      <div class="sub">랭킹 조회수 합·차트·표·기자 통계에 넣을 매체를 고릅니다. ${cat ? `네이버 언론사 ${Object.keys(cat.media).length}곳 · 랭킹 있음 ${cat.counts?.ranking ?? "-"}곳 · 조회수 공개 ${cat.counts?.views ?? "-"}곳 (${esc((cat.updated_at || "").slice(0, 10))} 확인)` : "언론사 전체 목록을 아직 만드는 중입니다 — 지금은 수집 중인 매체만 보입니다."}</div></div>
      <button class="btn sm" id="msx">닫기</button></div>
    <div class="ms-tools">
      <input class="input" id="msq" placeholder="매체 이름 검색" style="width:160px">
      <button class="btn sm" data-q="viewsAll">랭킹: 조회수 공개 전체</button>
      <button class="btn sm" data-q="rankNone">랭킹: 모두 해제</button>
      <button class="btn sm" data-q="pubAll">발행: 수집 매체 전체</button>
      <button class="btn sm" data-q="pubNone">발행: 모두 해제</button>
      <button class="btn sm" data-q="def">기본값</button>
      <span class="status-line" id="mscnt"></span>
    </div>
    <div id="mslist"></div>
    <div class="ms-foot">
      <button class="btn primary" id="msapply">내 화면에 적용</button>
      ${admin ? `<button class="btn" id="mssite">모든 사용자 기본값으로 저장</button>` : ""}
      <span class="form-hint">${admin ? `${esc(admin.name)} 님(관리자)으로 로그인됨 · ` : ""}‘내 화면에 적용’은 이 브라우저에만 저장됩니다.${personalSel() ? " 지금 내 설정을 쓰는 중입니다." : ""} 헬스조선·비교 매체는 항상 포함됩니다.</span>
    </div></div>`);
  slot.innerHTML = "";
  slot.append(card);

  const draw = () => {
    const q = $("#msq", card).value.trim();
    const rows = (c) => Object.values(list).filter((m) => m.cat === c && (!q || m.name.includes(q) || m.oid.includes(q))).sort((a, b) => a.name.localeCompare(b.name, "ko"));
    $("#mslist", card).innerHTML = cats.map((c) => {
      const r = rows(c);
      if (!r.length) return "";
      return `<details class="ms-cat" open><summary><b>${esc(c)}</b> <span class="form-hint">${r.length}곳 · 랭킹 ${r.filter((m) => sel.rank.has(m.oid)).length} · 발행 ${r.filter((m) => sel.pub.has(m.oid)).length}</span>
          <span class="ms-catbtn"><button class="btn sm" data-c="${esc(c)}" data-k="rank">랭킹 전체</button><button class="btn sm" data-c="${esc(c)}" data-k="pub">발행 전체</button><button class="btn sm" data-c="${esc(c)}" data-k="none">해제</button></span></summary>
        <div class="ms-grid">${r.map((m) => {
          const [rl, ro] = rankState(m), [pl, po] = pubState(m), fx = fixed.has(m.oid);
          return `<div class="ms-row ${fx ? "fixed" : ""}"><span class="ms-name">${esc(m.name)}${fx ? ' <span class="tag orange">고정</span>' : ""}</span>
            <label class="check ${ro ? "" : "off"}"><input type="checkbox" data-o="${m.oid}" data-t="rank" ${sel.rank.has(m.oid) && ro ? "checked" : ""} ${ro && !fx ? "" : "disabled"}> ${rl}</label>
            <label class="check ${po ? "" : "off"}"><input type="checkbox" data-o="${m.oid}" data-t="pub" ${sel.pub.has(m.oid) && po ? "checked" : ""} ${po && !fx ? "" : "disabled"}> ${pl}</label></div>`;
        }).join("")}</div></details>`;
    }).join("") || '<div class="empty">검색 결과가 없습니다.</div>';
    $("#mscnt", card).textContent = `선택: 랭킹 ${[...sel.rank].filter((o) => rankOK.has(o)).length}곳 · 발행 ${[...sel.pub].filter((o) => pubDetail.has(o) || pubCount.has(o)).length}곳`;
    $$("input[data-o]", card).forEach((x) => x.addEventListener("change", () => { sel[x.dataset.t][x.checked ? "add" : "delete"](x.dataset.o); draw(); }));
    $$("button[data-c]", card).forEach((b) => b.addEventListener("click", (e) => {
      e.preventDefault();
      const ms = Object.values(list).filter((m) => m.cat === b.dataset.c);
      for (const m of ms) {
        if (fixed.has(m.oid)) continue;
        if (b.dataset.k === "rank" && rankState(m)[1]) sel.rank.add(m.oid);
        if (b.dataset.k === "pub" && pubState(m)[1]) sel.pub.add(m.oid);
        if (b.dataset.k === "none") { sel.rank.delete(m.oid); sel.pub.delete(m.oid); }
      }
      draw();
    }));
  };
  $("#msq", card).addEventListener("input", draw);
  $("#msx", card).addEventListener("click", () => (slot.innerHTML = ""));
  $$("button[data-q]", card).forEach((b) => b.addEventListener("click", () => {
    const all = Object.values(list);
    const q = b.dataset.q;
    if (q === "viewsAll") all.forEach((m) => rankOK.has(m.oid) && m.views !== false && sel.rank.add(m.oid));
    if (q === "rankNone") sel.rank = new Set(fixed);
    if (q === "pubAll") all.forEach((m) => pubState(m)[1] && sel.pub.add(m.oid));
    if (q === "pubNone") sel.pub = new Set(fixed);
    if (q === "def") { const d = defaultSel(); sel.rank = new Set([...d.rank, ...fixed]); sel.pub = new Set([...d.pub, ...fixed]); }
    draw();
  }));
  const pack = () => ({ rank: [...sel.rank].filter((o) => rankOK.has(o)).sort(), pub: [...sel.pub].filter((o) => pubDetail.has(o) || pubCount.has(o)).sort() });
  $("#msapply", card).addEventListener("click", () => {
    const v = pack(), d = defaultSel();
    const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);
    const dd = { rank: [...new Set([...d.rank, ...fixed])].filter((o) => rankOK.has(o)).sort(), pub: [...new Set([...d.pub, ...fixed])].filter((o) => pubDetail.has(o) || pubCount.has(o)).sort() };
    setPersonalSel(same(v.rank, dd.rank) && same(v.pub, dd.pub) ? null : v);
    toast("적용했습니다");
    setTimeout(() => location.reload(), 300);
  });
  $("#mssite", card)?.addEventListener("click", async (e) => {
    const v = pack();
    if (!confirm(`모든 사용자의 기본 표시 매체를 랭킹 ${v.rank.length}곳 · 발행 ${v.pub.length}곳으로 바꿀까요?`)) return;
    e.target.disabled = true;
    try {
      await saveSiteSettings(v);
      setPersonalSel(null);
      toast("저장했습니다. 1~2분 후 모든 사용자에게 반영됩니다.", 4000);
      setTimeout(() => location.reload(), 1200);
    } catch (err) {
      toast("저장 실패: " + err.message, 5000);
      e.target.disabled = false;
    }
  });
  draw();
}
