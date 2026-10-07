// 통계 엑셀 → 사이트 데이터 형식 변환 (화면 없이 동작: 브라우저·node 모두)
// 지원 형식
//  - 랭킹: 시트 머리줄에 날짜·제목·조회수·링크 (예: 매체별 랭킹 시트 + 일별요약)
//  - 발행: 시트 머리줄에 발행일·(발행시각)·제목·링크 (예: 매체_상세 시트), 매체_요약 시트의 발행건수
//  - 그 밖의 표: 원본 그대로 보관(미리보기)
// 매체는 네이버 기사 링크의 언론사 코드(oid)로 판별합니다.

const ART = /\/article\/(?:\w+\/)?(\d{3})\/(\d{6,})/;
const norm = (v) => String(v ?? "").replace(/\s+/g, "").trim();
const findCol = (head, ...keys) => head.findIndex((c) => keys.some((k) => (k instanceof RegExp ? k.test(c) : c === k)));

export function toDay(v) {
  if (v == null || v === "") return null;
  if (v instanceof Date && !isNaN(v)) {
    const k = new Date(v.getTime() + 9 * 3600e3);
    return k.toISOString().slice(0, 10);
  }
  if (typeof v === "number") {
    if (v > 19000101 && v < 21001231) v = String(v);
    else if (v > 30000 && v < 80000) return new Date(Date.UTC(1899, 11, 30) + v * 864e5).toISOString().slice(0, 10); // 엑셀 날짜 숫자
    else return null;
  }
  const s = String(v).trim();
  let m = s.match(/^(20\d{2})(\d{2})(\d{2})$/) || s.match(/^(20\d{2})[-./]\s?(\d{1,2})[-./]\s?(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
}
const toTime = (v) => {
  if (v == null || v === "") return "";
  if (typeof v === "number" && v < 1) { const mm = Math.round(v * 1440); return `${String(Math.floor(mm / 60)).padStart(2, "0")}:${String(mm % 60).padStart(2, "0")}`; }
  const m = String(v).match(/(\d{1,2}):(\d{2})/);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : "";
};
const toNum = (v) => {
  if (typeof v === "number") return Math.round(v);
  const s = String(v ?? "").replace(/[,\s회건]/g, "");
  return /^\d+$/.test(s) ? Number(s) : null;
};

// rows: 시트별 2차원 배열 [{name, rows}]
export function convert(sheets, { fileName = "", nameToOid = {} } = {}) {
  const ranking = {}, publish = {}, names = {}, other = [], used = [];
  const summaryN = []; // [sheetPrefix, day, n]
  for (const sh of sheets) {
    const rows = sh.rows.filter((r) => r && r.some((c) => c !== null && c !== ""));
    // 머리줄 찾기 (위쪽 10줄 안)
    let hi = -1, head = [];
    for (let i = 0; i < Math.min(rows.length, 10); i++) {
      const hd = rows[i].map(norm);
      if (findCol(hd, "링크", /^(url|URL|link)$/) >= 0 && findCol(hd, "제목", /^title$/i) >= 0) { hi = i; head = hd; break; }
      if (findCol(hd, "발행건수", "기사수", "건수") >= 0 && findCol(hd, "발행일", "날짜", "일자") >= 0) { hi = i; head = hd; break; }
    }
    if (hi < 0) {
      if (!/요약|summary/i.test(sh.name)) other.push({ name: sh.name, rows: rows.slice(0, 300).map((r) => r.map((c) => (c instanceof Date ? toDay(c) : c))) });
      continue;
    }
    const cDay = findCol(head, "날짜", "발행일", "일자", "date", /^발행일자$/);
    const cTitle = findCol(head, "제목", /^title$/i);
    const cLink = findCol(head, "링크", /^(url|URL|link)$/);
    const cViews = findCol(head, "조회수", /^views?$/i);
    const cTime = findCol(head, "발행시각", "시각", "시간");
    const cRank = findCol(head, "순위", /^rank$/i);
    const cN = findCol(head, "발행건수", "기사수", "건수");
    const body = rows.slice(hi + 1);
    if (cLink < 0 && cN >= 0) { // 매체_요약: 발행일·발행건수
      for (const r of body) { const d = toDay(r[cDay]), n = toNum(r[cN]); if (d && n != null) summaryN.push([sh.name.replace(/[_\s-]*(요약|summary)$/i, ""), d, n]); }
      used.push(sh.name);
      continue;
    }
    const kind = cViews >= 0 ? "ranking" : "publish";
    let cnt = 0;
    const rankNo = {};
    for (const r of body) {
      const m = String(r[cLink] ?? "").match(ART);
      const d = toDay(cDay >= 0 ? r[cDay] : null);
      if (!m || !d) continue;
      const [, oid, aid] = m;
      const title = String(r[cTitle] ?? "").trim();
      names[oid] ||= sh.name.replace(/[_\s-]*(상세|detail|랭킹)$/i, "");
      if (kind === "ranking") {
        const k = `${d}_${oid}`;
        rankNo[k] = (rankNo[k] || 0) + 1;
        const per = ((ranking[d] ||= {})[oid] ||= { items: [] });
        if (per.items.some((x) => x[0] === aid)) continue;
        per.items.push([aid, toNum(r[cRank]) || rankNo[k], toNum(r[cViews]) || 0, title]);
      } else {
        const per = ((publish[d] ||= {})[oid] ||= { items: [] });
        if (per.items.some((x) => x[0] === aid)) continue;
        per.items.push([aid, toTime(cTime >= 0 ? r[cTime] : ""), title]);
      }
      cnt++;
    }
    if (cnt) used.push(sh.name);
    else other.push({ name: sh.name, rows: rows.slice(0, 300) });
  }
  // 요약 시트의 발행건수: 시트 이름(매체명) → oid
  const byName = { ...nameToOid };
  for (const [oid, nm] of Object.entries(names)) byName[norm(nm)] = oid;
  for (const [nm, d, n] of summaryN) {
    const oid = byName[norm(nm)];
    if (!oid) continue;
    ((publish[d] ||= {})[oid] ||= { items: [] }).n = n;
  }
  for (const per of Object.values(publish)) for (const m of Object.values(per)) if (m.n == null) m.n = m.items.length;
  for (const per of Object.values(ranking)) for (const m of Object.values(per)) m.items.sort((a, b) => a[1] - b[1]);
  const days = [...new Set([...Object.keys(ranking), ...Object.keys(publish)])].sort();
  const kinds = [Object.keys(ranking).length && "ranking", Object.keys(publish).length && "publish"].filter(Boolean);
  return {
    name: fileName,
    kind: kinds.length === 2 ? "mixed" : kinds[0] || "other",
    days,
    media: names,
    ranking,
    publish,
    sheets_used: used,
    other: kinds.length ? other.slice(0, 5) : other.slice(0, 20),
  };
}

// 사이트 데이터와 비교: [{day, oid, type, upload, site, status}]
// status: fill(사이트에 없음 → 채움) / same(일치) / diff(차이 → 사이트 값 유지)
export function compare(doc, site) {
  const out = [];
  for (const [d, per] of Object.entries(doc.ranking)) {
    const rk = site.ranking[d]?.items || [];
    for (const [oid, m] of Object.entries(per)) {
      const mine = rk.filter((r) => r[0] === oid);
      const sum = m.items.reduce((s, x) => s + (x[2] || 0), 0);
      if (!mine.length) { out.push({ day: d, oid, type: "랭킹", upload: `${m.items.length}건 · ${sum.toLocaleString()}회`, site: "-", status: "fill" }); continue; }
      const map = Object.fromEntries(mine.map((r) => [r[1], r]));
      const miss = m.items.filter((x) => !map[x[0]]).length;
      const vd = m.items.filter((x) => map[x[0]] && x[2] && map[x[0]][3] != null && map[x[0]][3] !== x[2]).length;
      const msum = mine.reduce((s, r) => s + (r[3] || 0), 0);
      out.push({ day: d, oid, type: "랭킹", upload: `${m.items.length}건 · ${sum.toLocaleString()}회`, site: `${mine.length}건 · ${msum.toLocaleString()}회`, status: miss ? "diff" : "same", note: miss ? `업로드에만 있는 기사 ${miss}건` : vd ? `조회수는 수집 시각 차이로 ${vd}건 다름 (사이트 값 유지)` : "" });
    }
  }
  for (const [d, per] of Object.entries(doc.publish)) {
    const det = {};
    for (const r of site.articles[d]?.items || []) det[r[0]] = (det[r[0]] || 0) + 1;
    const cnt = site.counts[d]?.media || {};
    for (const [oid, m] of Object.entries(per)) {
      const mine = det[oid] || cnt[oid]?.n || 0;
      out.push({ day: d, oid, type: "발행", upload: `${m.n}건`, site: mine ? `${mine}건` : "-", status: !mine ? "fill" : mine === m.n ? "same" : "diff", note: mine && mine !== m.n ? `${mine > m.n ? "+" : ""}${mine - m.n}건 (사이트 값 유지)` : "" });
    }
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.type.localeCompare(b.type) || a.oid.localeCompare(b.oid));
}
