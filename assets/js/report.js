// 일간·주간·월간 보고서 — 디자인된 PDF / PPT
// 한 번 계산한 '슬라이드 모델'을 화면(미리보기·PDF)과 PPT 두 가지로 그립니다. 슬라이드 크기 1280×720 (16:9)
import { $, $$, esc, h, fmt, pct, toast, addDays, dateList, weekday, weekdayIdx, mmdd, dotDate, kstToday, kstDateTime, loadScript, holiday, mediaColor } from "./util.js";
import { meta, mediaName, Range, keywordTable, mediaSel } from "./data.js";

const W = 1280, H = 720;
const C = { navy: "#0f2341", navy2: "#1c3a66", ink: "#1e293b", sub: "#64748b", line: "#e2e8f0", soft: "#f1f5f9", our: "#f97316", ourSoft: "#fff4ea", cmp: "#2563eb", cmpSoft: "#eef4ff", up: "#dc2626", down: "#2563eb", green: "#16a34a", gray: "#94a3b8" };
const LIB = {
  pdf: "https://cdn.jsdelivr.net/npm/jspdf@2.5.1/dist/jspdf.umd.min.js",
  canvas: "https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js",
  ppt: "https://cdn.jsdelivr.net/npm/pptxgenjs@3.12.0/dist/pptxgen.bundle.js",
};
const KIND = { day: "일간", week: "주간", month: "월간" };

// ── 기간 ──────────────────────────────
const monday = (d) => addDays(d, -((weekdayIdx(d) + 6) % 7));
const monthEnd = (ym) => { const [y, m] = ym.split("-").map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
const prevMonth = (ym) => { const [y, m] = ym.split("-").map(Number); return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`; };
export function periodOf(kind, anchor) {
  if (kind === "day") return { s: anchor, e: anchor, ps: addDays(anchor, -1), pe: addDays(anchor, -1) };
  if (kind === "week") { const s = monday(anchor); return { s, e: addDays(s, 6), ps: addDays(s, -7), pe: addDays(s, -1) }; }
  const ym = anchor.slice(0, 7), pm = prevMonth(ym);
  return { s: ym + "-01", e: monthEnd(ym), ps: pm + "-01", pe: monthEnd(pm) };
}
function buckets(kind, p) {
  if (kind === "day") return dateList(addDays(p.e, -13), p.e).map((d) => ({ s: d, e: d, label: `${mmdd(d)}(${weekday(d)})`, hol: !!holiday(d) || weekdayIdx(d) === 0 }));
  if (kind === "week") return Array.from({ length: 8 }, (_, i) => { const s = addDays(p.s, -7 * (7 - i)); return { s, e: addDays(s, 6), label: `${mmdd(s)}~${mmdd(addDays(s, 6))}` }; });
  const out = [];
  let ym = p.s.slice(0, 7);
  for (let i = 0; i < 6; i++) { out.unshift({ s: ym + "-01", e: monthEnd(ym), label: `${ym.slice(2, 4)}.${ym.slice(5)}월` }); ym = prevMonth(ym); }
  return out;
}
const label = (kind, p) => (kind === "day" ? `${dotDate(p.s)} (${weekday(p.s)})` : kind === "week" ? `${dotDate(p.s)}(월) ~ ${dotDate(p.e)}(일)` : `${p.s.slice(0, 4)}년 ${Number(p.s.slice(5, 7))}월`);
const prevWord = { day: "전일", week: "전주", month: "전월" };

// ── 계산 ─────────────────────────────
const ch = (a, b) => (a == null || !b ? null : (a - b) / b);
const sumBy = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
function byArticle(list) {
  const m = new Map();
  for (const a of list) {
    if (a.views == null) continue;
    const k = a.oid + a.aid;
    const x = m.get(k) || { ...a, views: 0, days: 0, best: 99 };
    x.views += a.views; x.days++; x.best = Math.min(x.best, a.rank);
    m.set(k, x);
  }
  return [...m.values()].sort((a, b) => b.views - a.views);
}

export async function buildModel(kind, anchor) {
  const M = meta();
  const our = M.our_media, cmp = M.compare_media;
  const p = periodOf(kind, anchor);
  const today = kstToday();
  const eCap = p.e > today ? today : p.e;
  const R = await new Range(p.s, eCap).init();
  const P = await new Range(p.ps, p.pe).init();
  // 추이 구간: 수집 시작일 이전 구간은 빼고, 너무 적으면(월간 1~2개월뿐) 이번 달을 주 단위로 나눠 보여 줌
  const first = M.first || "0000";
  let B = buckets(kind, p).filter((b) => b.e >= first);
  let trendUnit = kind === "day" ? "최근 14일 일별" : kind === "week" ? `최근 ${B.length}주 주별` : `최근 ${B.length}개월 월별`;
  if (kind === "month" && B.length < 3) {
    B = [];
    for (let s = monday(p.s); s <= p.e; s = addDays(s, 7)) {
      const bs = s < p.s ? p.s : s, be = addDays(s, 6) > p.e ? p.e : addDays(s, 6);
      B.push({ s: bs, e: be, label: `${mmdd(bs)}~${mmdd(be)}` });
    }
    trendUnit = "이번 달 주별 (수집 시작 전 달은 제외)";
  }
  if (B[0].s < first) B[0] = { ...B[0], s: first };
  const T = await new Range(B[0].s, eCap).init();
  const A = R.agg, PA = P.agg, TA = T.agg;
  const rk = (await R.ranking()) || A.top;
  const S = await R.search().catch(() => null);
  const kw = keywordTable(A, PA.rankDayCount || PA.pubDayCount ? PA : null);

  const views = (agg, o) => agg.rank[o]?.views ?? null;
  const pubs = (agg, o) => agg.pub[o] ?? null;
  const rankList = (agg) => Object.keys(agg.rank).sort((a, b) => agg.rank[b].views - agg.rank[a].views);
  const rl = rankList(A), prl = rankList(PA);
  const share = (agg, o) => (agg.rank[o] && agg.rankViews ? agg.rank[o].views / agg.rankViews : null);
  const days = Math.max(1, A.rankDayCount);
  const our1 = byArticle(rk.filter((a) => a.oid === our));
  const all1 = byArticle(rk);
  // 네이버 전체(모든 수집 매체) 주요 뉴스: 일별 요약의 상위 30건
  const allNews = byArticle(Object.entries(R.sum || {}).flatMap(([d, s]) => (s?.top || []).map((r) => ({ day: d, oid: r[0], aid: r[1], rank: r[2], views: r[3], title: r[4], reporter: r[5] }))));
  const entries = (o) => new Set(rk.filter((a) => a.oid === o).map((a) => a.aid)).size;

  // 추이 (버킷별 합)
  const tr = B.map((b) => {
    const ds = dateList(b.s, b.e > eCap ? eCap : b.e).filter((d) => d >= T.s);
    const rd = ds.filter((d) => TA.covered.rank.includes(d)), pd = ds.filter((d) => TA.covered.pub.includes(d));
    const sv = (o) => (rd.length ? sumBy(rd, (d) => TA.rankDay[d]?.[o]) : null);
    const sp = (o) => (pd.length ? sumBy(pd, (d) => TA.pubDay[d]?.[o]) : null);
    const tot = rd.length ? sumBy(rd, (d) => sumBy(Object.values(TA.rankDay[d] || {}), (v) => v)) : null;
    return { ...b, ov: sv(our), cv: sv(cmp), tv: tot, op: sp(our), cp: sp(cmp), share: tot ? sv(our) / tot : null, rdays: rd.length, pdays: pd.length };
  });

  const k = {
    our, cmp, ourN: mediaName(our), cmpN: mediaName(cmp),
    v: views(A, our), pv: views(PA, our), cv: views(A, cmp), pcv: views(PA, cmp),
    p: pubs(A, our), pp: pubs(PA, our), cp: pubs(A, cmp), pcp: pubs(PA, cmp),
    sh: share(A, our), psh: share(PA, our),
    rank: rl.indexOf(our) + 1 || null, prank: prl.indexOf(our) + 1 || null, nMedia: rl.length,
    ent: entries(our), cent: entries(cmp),
    top: our1[0],
  };
  k.rate = k.p ? Math.min(1, k.ent / k.p) : null;
  k.crate = k.cp ? Math.min(1, k.cent / k.cp) : null;

  // 핵심 인사이트 문장
  const sgn = (x) => (x == null ? "" : `${x >= 0 ? "+" : ""}${(x * 100).toFixed(1)}%`);
  const ins = [];
  if (k.v != null) ins.push(`${k.ourN} 랭킹 조회수 ${fmt(k.v)}회 — ${prevWord[kind]} 대비 ${sgn(ch(k.v, k.pv)) || "비교 자료 없음"}${k.rank ? `, 선택 매체 ${k.nMedia}곳 중 ${k.rank}위${k.prank && k.prank !== k.rank ? ` (${prevWord[kind]} ${k.prank}위)` : ""}` : ""}`);
  if (k.v != null && k.cv != null) ins.push(`${k.cmpN} 대비 조회수 ${k.v >= k.cv ? "우위" : "열세"} ${sgn(ch(k.v, k.cv))} (${k.cmpN} ${fmt(k.cv)}회) · 발행 ${fmt(k.p)}건 vs ${fmt(k.cp)}건`);
  if (k.sh != null) ins.push(`조회수 점유율 ${pct(k.sh)}${k.psh != null ? ` (${prevWord[kind]} ${pct(k.psh)}, ${k.sh >= k.psh ? "+" : ""}${((k.sh - k.psh) * 100).toFixed(1)}%p)` : ""}`);
  if (k.p != null) ins.push(`${k.ourN} 발행 ${fmt(k.p)}건 (하루 평균 ${(k.p / Math.max(1, A.pubDays?.[our] || 1)).toFixed(1)}건) · 랭킹 진입 ${fmt(k.ent)}건, 진입률 ${pct(k.rate, 0)}`);
  if (k.top) ins.push(`최다 조회 기사: "${k.top.title.slice(0, 46)}${k.top.title.length > 46 ? "…" : ""}" ${fmt(k.top.views)}회`);
  const rising = kw.filter((r) => (r.isNew || (r.change ?? 0) > 0.5) && r.score >= 3).sort((a, b) => (b.isNew - a.isNew) || (b.change ?? 0) - (a.change ?? 0)).slice(0, 10);
  if (rising.length) ins.push(`기사 키워드 급상승: ${rising.slice(0, 5).map((r) => r.word).join(", ")}`);
  if (S?.google?.length) ins.push(`구글 급상승 검색어: ${S.google.slice(0, 5).map((x) => x.title).join(", ")}`);

  return { kind, trendUnit, p: { ...p, e: eCap, eFull: p.e }, M, A, PA, R, k, tr, rl, rk, our1, all1, allNews, kw, rising, S, ins, generated: new Date().toISOString(), partial: eCap < p.e || A.partialDays.length > 0 };
}

// ── 슬라이드 모델 ──────────────────────
// 블록: kpis / chart / table / bullets / news / text — box = [x, y, w, h] (px, 1280×720 기준)
const dl = (x) => (x == null ? { t: "-", tone: "" } : Math.abs(x) < 0.0005 ? { t: "변동 없음", tone: "" } : { t: `${x >= 0 ? "▲" : "▼"} ${Math.abs(x * 100).toFixed(1)}%`, tone: x >= 0 ? "up" : "down" });
const dlp = (a, b) => (a == null || b == null ? { t: "-", tone: "" } : { t: `${a >= b ? "▲" : "▼"} ${Math.abs((a - b) * 100).toFixed(1)}%p`, tone: a >= b ? "up" : "down" });
const dRank = (a, b) => (!a || !b ? { t: "-", tone: "" } : a === b ? { t: "유지", tone: "" } : { t: `${a < b ? "▲" : "▼"} ${Math.abs(a - b)}계단`, tone: a < b ? "up" : "down" });
const cut = (s, n) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

export function slides(m) {
  const { k, kind, p, A, PA, tr } = m;
  const pw = prevWord[kind];
  const out = [];
  const head = (title, sub) => ({ title, sub });

  // 1. 표지
  out.push({ cover: true, title: `뉴스 인사이트 ${KIND[kind]} 보고서`, sub: label(kind, p), meta: [`우리 매체: ${k.ourN} · 비교 매체: ${k.cmpN}`, `작성 ${kstDateTime(m.generated)} · 네이버 뉴스 랭킹·발행 통계`], kpi: [["랭킹 조회수", fmt(k.v), dl(ch(k.v, k.pv))], ["조회수 점유율", pct(k.sh), dlp(k.sh, k.psh)], ["매체 순위", k.rank ? `${k.rank}위` : "-", dRank(k.rank, k.prank)], ["발행 기사", k.p != null ? `${fmt(k.p)}건` : "-", dl(ch(k.p, k.pp))]] });

  // 2. 한눈에 보기
  out.push({
    ...head("한눈에 보기", `${label(kind, p)} · ${pw} 대비${m.partial ? " · 일부 날짜는 집계 진행 중" : ""}`),
    blocks: [
      { t: "kpis", box: [48, 112, 1184, 276], cols: 4, items: [
        { label: `${k.ourN} 랭킹 조회수`, value: fmt(k.v), d: dl(ch(k.v, k.pv)), sub: `${pw} ${fmt(k.pv)}`, our: true },
        { label: "조회수 점유율", value: pct(k.sh), d: dlp(k.sh, k.psh), sub: `선택 매체 ${k.nMedia}곳 합 대비`, our: true },
        { label: "매체 순위 (조회수)", value: k.rank ? `${k.rank}위 / ${k.nMedia}` : "-", d: dRank(k.rank, k.prank), sub: `${pw} ${k.prank ? k.prank + "위" : "-"}`, our: true },
        { label: "랭킹 진입률", value: pct(k.rate, 0), d: { t: `${fmt(k.ent)}건 진입`, tone: "" }, sub: `발행 ${fmt(k.p)}건 중`, our: true },
        { label: `${k.ourN} 발행 기사`, value: k.p != null ? fmt(k.p) : "-", d: dl(ch(k.p, k.pp)), sub: `${pw} ${fmt(k.pp)}` },
        { label: `${k.cmpN} 랭킹 조회수`, value: fmt(k.cv), d: dl(ch(k.cv, k.pcv)), sub: `${pw} ${fmt(k.pcv)}`, cmp: true },
        { label: `${k.cmpN} 발행 기사`, value: k.cp != null ? fmt(k.cp) : "-", d: dl(ch(k.cp, k.pcp)), sub: `${pw} ${fmt(k.pcp)}`, cmp: true },
        { label: "최다 조회 기사", value: k.top ? fmt(k.top.views) : "-", d: { t: k.top ? `최고 ${k.top.best}위` : "", tone: "" }, sub: k.top ? cut(k.top.title, 22) : "" },
      ] },
      { t: "bullets", box: [48, 404, 1184, 276], title: "핵심 포인트", items: m.ins },
    ],
  });

  // 3. 추이
  const tl = tr.map((b) => b.label);
  out.push({
    ...head("추이 변화", `${m.trendUnit} · ${/이번 달/.test(m.trendUnit) ? "보고 기간 안의 흐름" : "마지막 칸이 이번 보고 기간"}`),
    blocks: [
      { t: "chart", box: [48, 112, 584, 330], title: "랭킹 조회수", kind: "line", labels: tl, series: [{ name: k.ourN, values: tr.map((b) => b.ov), color: C.our }, { name: k.cmpN, values: tr.map((b) => b.cv), color: C.cmp }] },
      { t: "chart", box: [648, 112, 584, 330], title: "발행 기사 수", kind: "bar", labels: tl, series: [{ name: k.ourN, values: tr.map((b) => b.op), color: C.our }, { name: k.cmpN, values: tr.map((b) => b.cp), color: C.cmp }] },
      { t: "table", box: [48, 460, 1184, 220], size: 11, head: ["구분", ...tl], rows: [
        [`${k.ourN} 조회수`, ...tr.map((b) => fmt(b.ov))],
        [`${k.cmpN} 조회수`, ...tr.map((b) => fmt(b.cv))],
        [`${k.ourN} 점유율`, ...tr.map((b) => pct(b.share))],
        [`${k.ourN} 발행`, ...tr.map((b) => fmt(b.op))],
        [`${k.cmpN} 발행`, ...tr.map((b) => fmt(b.cp))],
      ], hl: [0, 2, 3], firstW: 0.13, lastCol: true },
    ],
  });

  // 4. 매체별 성과
  const rows = m.rl.slice(0, 12).map((o, i) => {
    const r = A.rank[o], pr = PA.rank[o];
    return { o, cells: [String(i + 1), mediaName(o), fmt(r.views), dl(ch(r.views, pr?.views)).t, pct(r.views / A.rankViews), fmt(r.views / Math.max(1, r.n)), A.pub[o] != null ? fmt(A.pub[o]) : "-"] };
  });
  out.push({
    ...head("매체별 성과", `선택 매체 랭킹 조회수 순 · 점유율 = 선택 매체 조회수 합 대비 · 조회수 미공개 매체 제외`),
    blocks: [
      { t: "chart", box: [48, 112, 470, 568], title: "랭킹 조회수", kind: "hbar", labels: m.rl.slice(0, 12).map(mediaName), series: [{ name: "랭킹 조회수", values: m.rl.slice(0, 12).map((o) => A.rank[o].views), colors: m.rl.slice(0, 12).map((o) => (o === k.our ? C.our : o === k.cmp ? C.cmp : C.gray)) }] },
      { t: "table", box: [540, 112, 692, 568], size: 12, head: ["순위", "매체", "랭킹 조회수", `${pw} 대비`, "점유율", "기사당 평균", "발행"], widths: [0.08, 0.2, 0.17, 0.14, 0.12, 0.15, 0.14], align: ["c", "l", "r", "r", "r", "r", "r"], rows: rows.map((r) => r.cells), hl: rows.map((r, i) => (r.o === k.our ? i : -1)).filter((i) => i >= 0), hl2: rows.map((r, i) => (r.o === k.cmp ? i : -1)).filter((i) => i >= 0) },
    ],
  });

  // 5. 우리 vs 비교 매체
  const cmpRows = [
    ["랭킹 조회수", fmt(k.v), fmt(k.cv), dl(ch(k.v, k.cv)).t],
    ["조회수 점유율", pct(k.sh), pct(A.rank[k.cmp] ? A.rank[k.cmp].views / A.rankViews : null), ""],
    ["발행 기사", fmt(k.p), fmt(k.cp), dl(ch(k.p, k.cp)).t],
    ["랭킹 진입 기사", fmt(k.ent), fmt(k.cent), dl(ch(k.ent, k.cent)).t],
    ["랭킹 진입률", pct(k.rate, 0), pct(k.crate, 0), ""],
    ["기사당 평균 조회수", fmt(A.rank[k.our] ? A.rank[k.our].views / A.rank[k.our].n : null), fmt(A.rank[k.cmp] ? A.rank[k.cmp].views / A.rank[k.cmp].n : null), ""],
    ["1위 기사 조회수", fmt(m.our1[0]?.views), fmt(byArticle(m.rk.filter((a) => a.oid === k.cmp))[0]?.views), ""],
  ];
  out.push({
    ...head(`${k.ourN} vs ${k.cmpN}`, `같은 기간 핵심 지표 비교 · 차이 = ${k.ourN} 기준`),
    blocks: [
      { t: "table", box: [48, 112, 560, 400], size: 14, head: ["지표", k.ourN, k.cmpN, "차이"], widths: [0.34, 0.22, 0.22, 0.22], align: ["l", "r", "r", "r"], rows: cmpRows, colHl: [1, 2] },
      { t: "chart", box: [632, 112, 600, 400], title: "조회수 점유율 추이", kind: "line", labels: tl, series: [{ name: `${k.ourN} 점유율(%)`, values: tr.map((b) => (b.share == null ? null : +(b.share * 100).toFixed(1))), color: C.our }, { name: `${k.cmpN} 점유율(%)`, values: tr.map((b) => (b.tv ? +((b.cv / b.tv) * 100).toFixed(1) : null)), color: C.cmp }], pctAxis: true },
      { t: "bullets", box: [48, 530, 1184, 150], title: "해석", items: [
        k.v != null && k.cv != null ? `조회수는 ${k.v >= k.cv ? k.ourN : k.cmpN}가 ${fmt(Math.abs(k.v - k.cv))}회 더 많습니다 (${dl(ch(k.v, k.cv)).t}).` : "조회수 비교 자료가 없습니다.",
        k.p != null && k.cp != null ? `발행은 ${k.p >= k.cp ? k.ourN : k.cmpN}가 ${fmt(Math.abs(k.p - k.cp))}건 더 많고, 랭킹 진입률은 ${k.ourN} ${pct(k.rate, 0)} · ${k.cmpN} ${pct(k.crate, 0)}입니다.` : "발행 비교 자료가 없습니다.",
      ] },
    ],
  });

  // 6. 이 기간 주요 뉴스
  const news = (list, n) => list.slice(0, n).map((a, i) => ({ n: i + 1, media: mediaName(a.oid), oid: a.oid, title: a.title, views: a.views, sub: [a.reporter, kind !== "day" && a.days > 1 ? `${a.days}일 랭킹` : "", `최고 ${a.best}위`].filter(Boolean).join(" · ") }));
  out.push({
    ...head("이 기간의 주요 뉴스", "네이버 랭킹 조회수 기준 · 같은 기사가 여러 날 오르면 합산"),
    blocks: [
      { t: "news", box: [48, 112, 584, 568], title: "네이버 전체 매체 TOP 10", items: news(m.allNews, 10) },
      { t: "news", box: [648, 112, 584, 568], title: "선택 매체 TOP 10", items: news(m.all1, 10) },
    ],
  });

  // 7. 우리 매체 기사 성과
  out.push({
    ...head(`${k.ourN} 기사 성과`, `독자가 가장 많이 본 ${k.ourN} 기사 · 랭킹 진입 ${fmt(k.ent)}건`),
    blocks: [{ t: "news", box: [48, 112, 1184, 568], title: `${k.ourN} TOP 10`, items: news(m.our1, 10), wide: true }],
  });

  // 8. 키워드
  const kwTop = m.kw.slice().sort((a, b) => b.score - a.score).slice(0, 12);
  out.push({
    ...head("기사 키워드", `선택 매체 기사 제목에서 뽑은 단어 · 점수 = 발행 + 랭킹 진입×3 · 변화 = ${pw} 대비 하루 평균`),
    blocks: [
      { t: "table", box: [48, 112, 584, 568], size: 12, title: "많이 쓰인 키워드", head: ["#", "키워드", "발행", "랭킹 진입", "점수", "변화"], widths: [0.08, 0.32, 0.14, 0.16, 0.14, 0.16], align: ["c", "l", "r", "r", "r", "r"], rows: kwTop.map((r, i) => [String(i + 1), r.word, fmt(r.pub), fmt(r.rank), fmt(r.score), r.isNew ? "NEW" : r.change == null ? "-" : dl(r.change).t]) },
      { t: "table", box: [648, 112, 584, 568], size: 12, title: "급상승 키워드", head: ["#", "키워드", "발행", "랭킹 진입", "변화"], widths: [0.08, 0.38, 0.16, 0.18, 0.2], align: ["c", "l", "r", "r", "r"], rows: m.rising.slice(0, 12).map((r, i) => [String(i + 1), r.word, fmt(r.pub), fmt(r.rank), r.isNew ? "NEW" : dl(r.change).t]), empty: "비교할 직전 기간 자료가 부족합니다" },
    ],
  });

  // 9. 검색 트렌드
  const S = m.S;
  if (S) {
    const g = S.google.slice(0, 10);
    const grp = {};
    for (const [gname, ws] of Object.entries(S.seedGroups || {})) for (const w of ws) grp[w] = gname;
    const vol = Object.entries(S.volume || {}).map(([w, v]) => ({ w, pc: v[0], mo: v[1], t: v[0] + v[1], g: grp[w] || "" })).sort((a, b) => b.t - a.t).slice(0, 10);
    out.push({
      ...head("검색 트렌드", `구글 급상승 검색어(한국) · 네이버 월간 검색량(검색광고 API${S.volumeDay ? ", " + dotDate(S.volumeDay) + " 기준" : ""})`),
      blocks: [
        { t: "news", box: [48, 112, 584, 568], title: "구글 급상승 검색어 TOP 10", items: g.map((x, i) => ({ n: i + 1, media: x.traffic ? fmt(x.traffic) + "+" : "-", title: x.title, sub: cut(x.news[0]?.[0] || "", 52), views: null })), blue: true },
        vol.length
          ? { t: "chart", box: [648, 112, 584, 568], title: "네이버 관심 분야 검색량 TOP 10 (월간)", kind: "hbar", stacked: true, labels: vol.map((x) => x.w + (x.g ? ` (${x.g})` : "")), series: [{ name: "모바일", values: vol.map((x) => x.mo), color: C.green }, { name: "PC", values: vol.map((x) => x.pc), color: "#86efac" }] }
          : { t: "text", box: [648, 112, 584, 120], text: "네이버 검색량 자료가 아직 없습니다." },
      ],
    });
  }

  // 10. 기자
  const reps = [...A.rep.values()];
  const ourReps = reps.filter((r) => r.oid === k.our).sort((a, b) => b.views - a.views || b.pub - a.pub).slice(0, 10);
  const allReps = reps.filter((r) => r.views > 0).sort((a, b) => b.views - a.views).slice(0, 10);
  out.push({
    ...head("기자 성과", "공동 바이라인은 각 기자에게 모두 반영 · 진입률 = 랭킹 진입 ÷ 발행 (최대 100%)"),
    blocks: [
      { t: "table", box: [48, 112, 584, 568], size: 12, title: `${k.ourN} 기자 TOP 10 (조회수)`, head: ["#", "기자", "발행", "랭킹 진입", "진입률", "랭킹 조회수"], widths: [0.07, 0.25, 0.13, 0.17, 0.15, 0.23], align: ["c", "l", "r", "r", "r", "r"], rows: ourReps.map((r, i) => [String(i + 1), r.name, fmt(r.pub), fmt(r.rank), r.pub ? pct(Math.min(1, r.rank / r.pub), 0) : "-", fmt(r.views)]), empty: "기자 자료가 없습니다" },
      { t: "table", box: [648, 112, 584, 568], size: 12, title: "선택 매체 기자 TOP 10 (조회수)", head: ["#", "기자", "매체", "발행", "랭킹 조회수"], widths: [0.07, 0.25, 0.26, 0.14, 0.28], align: ["c", "l", "l", "r", "r"], rows: allReps.map((r, i) => [String(i + 1), r.name, mediaName(r.oid), fmt(r.pub), fmt(r.views)]), hl: allReps.map((r, i) => (r.oid === k.our ? i : -1)).filter((i) => i >= 0) },
    ],
  });

  // 11. 데이터 기준
  const exp = dateList(p.s, p.e);
  const missR = exp.filter((d) => !A.covered.rank.includes(d)), missP = exp.filter((d) => !A.covered.pub.includes(d));
  const sel = mediaSel();
  out.push({
    ...head("데이터 기준", "이 보고서의 숫자가 어디서 왔는지"),
    blocks: [{ t: "bullets", box: [48, 112, 1184, 568], items: [
      `보고 기간: ${label(kind, p)} (${exp.length}일) · 비교 기간: ${dotDate(p.ps)} ~ ${dotDate(p.pe)}`,
      `랭킹 수집 ${A.rankDayCount}/${exp.length}일${missR.length ? ` (빠진 날: ${missR.map(mmdd).join(", ")})` : ""} · 발행 수집 ${A.pubDayCount}/${exp.length}일${missP.length ? ` (빠진 날: ${missP.map(mmdd).join(", ")})` : ""}`,
      m.partial ? `오늘(${dotDate(kstToday())})이 포함되어 일부 숫자는 하루가 끝날 때까지 바뀝니다.` : "보고 기간의 하루 집계가 모두 끝난 확정 값입니다.",
      "랭킹 조회수: 네이버 언론사별 랭킹(매체별 상위 20건)에 표시된 하루 조회수의 합. 조회수를 공개하지 않는 매체(조선일보·동아일보·중앙일보·데일리안 등)는 조회수 지표에서 빠집니다.",
      "발행 기사: 네이버 언론사별 기사 목록 + 기사 입력 시각(한국시간)으로 날짜 확정. 랭킹 진입 = 기간 중 랭킹에 오른 서로 다른 기사 수.",
      `대상 매체: 매체 설정 기준 랭킹 ${sel.rank.size}곳 · 발행 ${sel.pub.size}곳 (${k.ourN}·${k.cmpN} 항상 포함)`,
      "검색 트렌드: 구글 트렌드 한국 급상승 검색어, 네이버 검색광고 API 월간 검색량(PC·모바일).",
      `작성: 뉴스 인사이트 · ${kstDateTime(m.generated)} · 데이터 보관 ${m.M.retention_months || 24}개월`,
    ] }],
  });
  return out;
}

// ── HTML 렌더 (미리보기·PDF) ───────────────
const toneColor = (t) => (t === "up" ? C.up : t === "down" ? C.down : C.sub);
function blockHTML(b, idx) {
  const [x, y, w, hh] = b.box;
  const st = `left:${x}px;top:${y}px;width:${w}px;height:${hh}px`;
  if (b.t === "kpis") {
    const rows = Math.ceil(b.items.length / b.cols), gap = 14;
    const cw = (w - gap * (b.cols - 1)) / b.cols, chh = (hh - gap * (rows - 1)) / rows;
    return `<div class="rp-b" style="${st}">${b.items.map((it, i) => `<div class="rp-kpi ${it.our ? "our" : it.cmp ? "cmp" : ""}" style="left:${(i % b.cols) * (cw + gap)}px;top:${Math.floor(i / b.cols) * (chh + gap)}px;width:${cw}px;height:${chh}px">
      <div class="l">${esc(it.label)}</div><div class="v">${esc(it.value)}</div><div class="d" style="color:${toneColor(it.d.tone)}">${esc(it.d.t)}</div><div class="s">${esc(it.sub || "")}</div></div>`).join("")}</div>`;
  }
  if (b.t === "chart") return `<div class="rp-b rp-card" style="${st}"><div class="rp-bt">${esc(b.title || "")}</div><canvas data-ci="${idx}" width="${w - 34}" height="${hh - 60}" style="width:${w - 34}px;height:${hh - 60}px"></canvas></div>`;
  if (b.t === "table") {
    const al = (i) => ({ c: "center", r: "right", l: "left" }[(b.align || [])[i]] || (i === 0 ? "left" : "right"));
    const wd = (i) => (b.widths ? `${b.widths[i] * 100}%` : b.firstW ? (i === 0 ? `${b.firstW * 100}%` : `${((1 - b.firstW) / (b.head.length - 1)) * 100}%`) : "auto");
    return `<div class="rp-b ${b.title ? "rp-card" : ""}" style="${st}">${b.title ? `<div class="rp-bt">${esc(b.title)}</div>` : ""}
      ${b.rows.length ? `<table class="rp-t" style="font-size:${b.size || 12}px"><colgroup>${b.head.map((_, i) => `<col style="width:${wd(i)}">`).join("")}</colgroup><thead><tr>${b.head.map((c, i) => `<th style="text-align:${al(i)}">${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${b.rows.map((r, ri) => `<tr class="${(b.hl || []).includes(ri) ? "hl" : (b.hl2 || []).includes(ri) ? "hl2" : ""}">${r.map((c, i) => `<td style="text-align:${al(i)}" class="${(b.colHl || []).includes(i) ? (i === 1 ? "ch1" : "ch2") : ""} ${/^▲/.test(c) ? "up" : /^▼/.test(c) ? "down" : c === "NEW" ? "new" : ""}">${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>` : `<div class="rp-empty">${esc(b.empty || "자료가 없습니다")}</div>`}</div>`;
  }
  if (b.t === "bullets") return `<div class="rp-b rp-card" style="${st}">${b.title ? `<div class="rp-bt">${esc(b.title)}</div>` : ""}<ul class="rp-ul">${b.items.map((t) => `<li>${esc(t)}</li>`).join("")}</ul></div>`;
  if (b.t === "news") {
    const n = Math.max(1, b.items.length);
    return `<div class="rp-b rp-card" style="${st}"><div class="rp-bt">${esc(b.title)}</div>${b.items.length ? `<div class="rp-news">${b.items.map((a) => `<div class="rp-nw" style="height:${Math.min(50, (hh - 58) / 10)}px"><span class="no ${a.n <= 3 ? "top" : ""}">${a.n}</span><span class="md ${b.blue ? "blue" : ""}" style="${a.oid ? `color:${a.oid === meta().our_media ? C.our : a.oid === meta().compare_media ? C.cmp : C.sub}` : ""}">${esc(a.media)}</span><span class="tt"><b>${esc(cut(a.title, b.wide ? 70 : 38))}</b><i>${esc(a.sub || "")}</i></span>${a.views != null ? `<span class="vw">${fmt(a.views)}</span>` : ""}</div>`).join("")}</div>` : `<div class="rp-empty">자료가 없습니다</div>`}</div>`;
  }
  return `<div class="rp-b" style="${st}"><div class="rp-empty">${esc(b.text || "")}</div></div>`;
}
function slideHTML(s, i, n, m) {
  const foot = `<div class="rp-foot"><span>뉴스 인사이트 · ${KIND[m.kind]} 보고서 · ${esc(label(m.kind, m.p))}</span><span>${i + 1} / ${n}</span></div>`;
  if (s.cover) {
    return `<div class="rp-slide cover"><div class="rp-cv-band"></div><div class="rp-cv-tag">NEWS INSIGHT · ${KIND[m.kind]} REPORT</div><div class="rp-cv-t">${esc(s.title)}</div><div class="rp-cv-s">${esc(s.sub)}</div>
      <div class="rp-cv-k">${s.kpi.map(([l, v, d]) => `<div><span>${esc(l)}</span><b>${esc(v)}</b><em style="color:${d.tone === "up" ? "#fca5a5" : d.tone === "down" ? "#93c5fd" : "#cbd5e1"}">${esc(d.t)} ${d.t !== "-" ? prevWord[m.kind] + " 대비" : ""}</em></div>`).join("")}</div>
      <div class="rp-cv-m">${s.meta.map(esc).join("<br>")}</div><div class="rp-cv-logo">N</div></div>`;
  }
  return `<div class="rp-slide"><div class="rp-hd"><div class="rp-no">${String(i).padStart(2, "0")}</div><div><div class="rp-h">${esc(s.title)}</div><div class="rp-hs">${esc(s.sub || "")}</div></div></div>${s.blocks.map((b, bi) => blockHTML(b, `${i}_${bi}`)).join("")}${foot}</div>`;
}
function drawCharts(root, ss) {
  const Chart = window.Chart;
  if (!Chart) return;
  Chart.defaults.font.family = getComputedStyle(document.body).fontFamily;
  ss.forEach((s, i) => (s.blocks || []).forEach((b, bi) => {
    if (b.t !== "chart") return;
    const cv = $(`canvas[data-ci="${i}_${bi}"]`, root);
    if (!cv) return;
    const hbar = b.kind === "hbar";
    new Chart(cv, {
      type: hbar || b.kind === "bar" ? "bar" : "line",
      data: { labels: b.labels, datasets: b.series.map((sr) => ({ label: sr.name, data: sr.values, borderColor: sr.color || C.gray, backgroundColor: sr.colors || sr.color || C.gray, borderWidth: hbar || b.kind === "bar" ? 0 : 3, pointRadius: 3.5, pointBackgroundColor: sr.color, tension: 0.25, borderRadius: 4, spanGaps: true, maxBarThickness: 34 })) },
      options: {
        responsive: false, animation: false, devicePixelRatio: 2, indexAxis: hbar ? "y" : "x",
        plugins: { legend: { display: b.series.length > 1, position: "bottom", labels: { boxWidth: 10, boxHeight: 10, font: { size: 12 } } }, tooltip: { enabled: false } },
        scales: {
          x: { stacked: !!b.stacked, grid: { display: hbar, color: "#eef2f7" }, ticks: { font: { size: 11 }, color: "#64748b", maxRotation: 0, autoSkip: true, ...(hbar ? { callback: (v) => shortN(v) } : {}) } },
          y: { stacked: !!b.stacked, beginAtZero: true, grid: { color: hbar ? "transparent" : "#eef2f7" }, ticks: { font: { size: hbar ? 12 : 11 }, color: hbar ? "#1e293b" : "#64748b", callback: hbar ? function (v) { return cut(this.getLabelForValue(v), 18); } : (v) => (b.pctAxis ? v + "%" : shortN(v)) } },
        },
      },
    });
  }));
}
const shortN = (v) => (Math.abs(v) >= 1e8 ? (v / 1e8).toFixed(1) + "억" : Math.abs(v) >= 1e4 ? (v / 1e4).toFixed(Math.abs(v) >= 1e5 ? 0 : 1) + "만" : fmt(v));

export function renderSlides(root, m, ss) {
  root.innerHTML = ss.map((s, i) => slideHTML(s, i, ss.length, m)).join("");
  drawCharts(root, ss);
  return $$(".rp-slide", root);
}

// ── PDF ──────────────────────────────
async function toPDF(m, ss, name, onProg) {
  await Promise.all([loadScript(LIB.pdf), loadScript(LIB.canvas)]);
  const host = h(`<div class="rp-host"></div>`);
  document.body.append(host);
  try {
    const els = renderSlides(host, m, ss);
    await document.fonts?.ready;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: "landscape", unit: "px", format: [W, H], hotfixes: ["px_scaling"], compress: true });
    for (const [i, el] of els.entries()) {
      onProg?.(`PDF 만드는 중… ${i + 1}/${els.length}`);
      const cv = await window.html2canvas(el, { scale: 2, backgroundColor: "#ffffff", logging: false, useCORS: true });
      if (i) doc.addPage([W, H], "landscape");
      doc.addImage(cv.toDataURL("image/jpeg", 0.92), "JPEG", 0, 0, W, H, undefined, "FAST");
    }
    doc.setProperties({ title: name, creator: "뉴스 인사이트" });
    doc.save(`${name}.pdf`);
  } finally { host.remove(); }
}

// ── PPT (편집 가능한 도형·표·차트) ─────────────
const IN = (px) => +(px / 96).toFixed(3);
const hex = (c) => c.replace("#", "").toUpperCase();
const FONT = "맑은 고딕";
async function toPPT(m, ss, name, onProg) {
  await loadScript(LIB.ppt);
  const pptx = new window.PptxGenJS();
  pptx.layout = "LAYOUT_WIDE"; // 13.33 × 7.5 in = 1280 × 720 px
  pptx.title = name;
  pptx.company = "뉴스 인사이트";
  const T = (sl, text, x, y, w, hh, o = {}) => sl.addText(text, { x: IN(x), y: IN(y), w: IN(w), h: IN(hh), fontFace: FONT, fontSize: 12, color: hex(C.ink), margin: 0, valign: "top", ...o });
  ss.forEach((s, i) => {
    onProg?.(`PPT 만드는 중… ${i + 1}/${ss.length}`);
    const sl = pptx.addSlide();
    if (s.cover) {
      sl.background = { color: hex(C.navy) };
      sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: IN(14), h: IN(H), fill: { color: hex(C.our) }, line: { color: hex(C.our) } });
      T(sl, `NEWS INSIGHT · ${KIND[m.kind]} REPORT`, 96, 110, 900, 24, { fontSize: 13, color: "FDBA74", bold: true, charSpacing: 2 });
      T(sl, s.title, 96, 150, 1000, 70, { fontSize: 40, bold: true, color: "FFFFFF" });
      T(sl, s.sub, 96, 228, 1000, 40, { fontSize: 22, color: "CBD5E1" });
      s.kpi.forEach(([l, v, d], j) => {
        const x = 96 + j * 272;
        sl.addShape(pptx.ShapeType.roundRect, { x: IN(x), y: IN(330), w: IN(252), h: IN(150), fill: { color: hex(C.navy2) }, line: { color: "2E4A78" }, rectRadius: 0.08 });
        T(sl, l, x + 20, 350, 220, 22, { fontSize: 13, color: "94A3B8" });
        T(sl, v, x + 20, 378, 226, 50, { fontSize: v.length > 9 ? 22 : 28, bold: true, color: "FFFFFF" });
        T(sl, `${d.t} ${d.t !== "-" ? prevWord[m.kind] + " 대비" : ""}`, x + 20, 436, 220, 22, { fontSize: 12, color: d.tone === "up" ? "FCA5A5" : d.tone === "down" ? "93C5FD" : "CBD5E1" });
      });
      T(sl, s.meta.join("\n"), 96, 560, 1000, 60, { fontSize: 13, color: "94A3B8" });
      return;
    }
    sl.background = { color: "FFFFFF" };
    sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: IN(W), h: IN(96), fill: { color: "F8FAFC" }, line: { color: "F8FAFC" } });
    sl.addShape(pptx.ShapeType.rect, { x: 0, y: 0, w: IN(8), h: IN(96), fill: { color: hex(C.our) }, line: { color: hex(C.our) } });
    T(sl, String(i).padStart(2, "0"), 40, 26, 60, 44, { fontSize: 26, bold: true, color: hex(C.our) });
    T(sl, s.title, 104, 22, 1000, 36, { fontSize: 24, bold: true, color: hex(C.navy) });
    T(sl, s.sub || "", 104, 60, 1100, 22, { fontSize: 12, color: hex(C.sub) });
    T(sl, `뉴스 인사이트 · ${KIND[m.kind]} 보고서 · ${label(m.kind, m.p)}`, 48, 694, 900, 18, { fontSize: 9, color: "94A3B8" });
    T(sl, `${i + 1} / ${ss.length}`, 1080, 694, 152, 18, { fontSize: 9, color: "94A3B8", align: "right" });
    for (const b of s.blocks) pptBlock(pptx, sl, b, T);
  });
  await pptx.writeFile({ fileName: `${name}.pptx` });
}
function pptCard(pptx, sl, b, T) {
  const [x, y, w, hh] = b.box;
  sl.addShape(pptx.ShapeType.roundRect, { x: IN(x), y: IN(y), w: IN(w), h: IN(hh), fill: { color: "FFFFFF" }, line: { color: hex(C.line), width: 1 }, rectRadius: 0.06 });
  if (b.title) T(sl, b.title, x + 16, y + 12, w - 32, 24, { fontSize: 14, bold: true, color: hex(C.navy) });
}
function pptBlock(pptx, sl, b, T) {
  const [x, y, w, hh] = b.box;
  if (b.t === "kpis") {
    const rows = Math.ceil(b.items.length / b.cols), gap = 14;
    const cw = (w - gap * (b.cols - 1)) / b.cols, chh = (hh - gap * (rows - 1)) / rows;
    b.items.forEach((it, i) => {
      const cx = x + (i % b.cols) * (cw + gap), cy = y + Math.floor(i / b.cols) * (chh + gap);
      const fill = it.our ? "FFF4EA" : it.cmp ? "EEF4FF" : "F8FAFC";
      sl.addShape(pptx.ShapeType.roundRect, { x: IN(cx), y: IN(cy), w: IN(cw), h: IN(chh), fill: { color: fill }, line: { color: it.our ? "FED7AA" : it.cmp ? "BFDBFE" : hex(C.line) }, rectRadius: 0.06 });
      T(sl, it.label, cx + 16, cy + 12, cw - 32, 18, { fontSize: 11, color: hex(C.sub) });
      T(sl, it.value, cx + 16, cy + 32, cw - 32, 38, { fontSize: it.value.length > 9 ? 19 : 22, bold: true, color: hex(it.our ? "#c2410c" : it.cmp ? "#1d4ed8" : C.ink) });
      T(sl, it.d.t, cx + 16, cy + 72, cw - 32, 16, { fontSize: 11, bold: true, color: hex(toneColor(it.d.tone)) });
      T(sl, it.sub || "", cx + 16, cy + 88, cw - 32, 16, { fontSize: 10, color: "94A3B8" });
    });
    return;
  }
  if (b.t === "bullets") {
    pptCard(pptx, sl, b, T);
    const top = b.title ? 46 : 18;
    T(sl, b.items.map((t) => ({ text: t, options: { bullet: { code: "25A0" }, paraSpaceAfter: 6 } })), x + 20, y + top, w - 40, hh - top - 12, { fontSize: b.items.length > 6 ? 13 : 14, color: hex(C.ink) });
    return;
  }
  if (b.t === "chart") {
    pptCard(pptx, sl, b, T);
    const hbar = b.kind === "hbar";
    const data = b.series.map((sr) => ({ name: sr.name, labels: b.labels, values: sr.values.map((v) => (v == null ? 0 : v)) }));
    const colors = b.series.length === 1 && b.series[0].colors ? b.series[0].colors.map(hex) : b.series.map((sr) => hex(sr.color || C.gray));
    sl.addChart(hbar || b.kind === "bar" ? pptx.ChartType.bar : pptx.ChartType.line, hbar ? data.map((d) => ({ ...d, labels: [...d.labels].reverse(), values: [...d.values].reverse() })) : data, {
      x: IN(x + 10), y: IN(y + 40), w: IN(w - 20), h: IN(hh - 50),
      barDir: hbar ? "bar" : "col", barGrouping: b.stacked ? "stacked" : "clustered", barGapWidthPct: 60,
      chartColors: hbar && b.series.length === 1 && b.series[0].colors ? [...colors].reverse() : colors,
      ...(hbar && b.series.length === 1 && b.series[0].colors ? { } : {}),
      lineSize: 3, lineDataSymbolSize: 6,
      showLegend: b.series.length > 1, legendPos: "b", legendFontSize: 10, legendFontFace: FONT,
      catAxisLabelFontSize: hbar ? 10 : 9, catAxisLabelFontFace: FONT, valAxisLabelFontSize: 9, valAxisLabelFontFace: FONT,
      valAxisLabelFormatCode: b.pctAxis ? '0.0"%"' : "#,##0", valGridLine: { color: "EEF2F7", size: 1 }, catGridLine: { style: "none" },
      showValue: false,
    });
    if (hbar && b.series.length === 1 && b.series[0].colors) {
      // 막대별 색(우리 매체·비교 매체 강조)은 PptxGenJS에서 계열 하나에 지정할 수 없어 범례 대신 안내
      T(sl, `주황 = ${mediaName(meta().our_media)} · 파랑 = ${mediaName(meta().compare_media)}`, x + 16, y + hh - 20, w - 32, 14, { fontSize: 9, color: "94A3B8" });
    }
    return;
  }
  if (b.t === "table") {
    if (b.title) pptCard(pptx, sl, b, T);
    const top = b.title ? 44 : 0;
    if (!b.rows.length) { T(sl, b.empty || "자료가 없습니다", x + 16, y + top + 16, w - 32, 20, { fontSize: 12, color: hex(C.sub) }); return; }
    const al = (i) => ({ c: "center", r: "right", l: "left" }[(b.align || [])[i]] || (i === 0 ? "left" : "right"));
    const iw = w - (b.title ? 24 : 0);
    const colW = b.head.map((_, i) => IN(iw * (b.widths ? b.widths[i] : b.firstW ? (i === 0 ? b.firstW : (1 - b.firstW) / (b.head.length - 1)) : 1 / b.head.length)));
    const fs = Math.max(8, (b.size || 12) - 2);
    const rows = [
      b.head.map((c, i) => ({ text: c, options: { bold: true, color: "FFFFFF", fill: { color: hex(C.navy) }, align: al(i) } })),
      ...b.rows.map((r, ri) => r.map((c, i) => ({ text: c, options: { align: al(i), bold: (b.hl || []).includes(ri) || ((b.colHl || []).includes(i)), fill: { color: (b.hl || []).includes(ri) ? "FFF4EA" : (b.hl2 || []).includes(ri) ? "EEF4FF" : (b.colHl || [])[0] === i ? "FFF4EA" : (b.colHl || [])[1] === i ? "EEF4FF" : ri % 2 ? "F8FAFC" : "FFFFFF" }, color: /^▲/.test(c) ? hex(C.up) : /^▼/.test(c) ? hex(C.down) : c === "NEW" ? hex(C.our) : hex(C.ink) } }))),
    ];
    const rowH = Math.min(0.42, IN((hh - top - 8) / rows.length));
    sl.addTable(rows, { x: IN(x + (b.title ? 12 : 0)), y: IN(y + top), w: IN(iw), colW, fontFace: FONT, fontSize: fs, rowH, border: { type: "solid", pt: 0.5, color: "E2E8F0" }, valign: "middle", margin: [2, 6, 2, 6] });
    return;
  }
  if (b.t === "news") {
    pptCard(pptx, sl, b, T);
    if (!b.items.length) { T(sl, "자료가 없습니다", x + 16, y + 52, w - 32, 20, { fontSize: 12, color: hex(C.sub) }); return; }
    const rowH = Math.min(50, (hh - 58) / 10);
    b.items.forEach((a, j) => {
      const yy = y + 46 + j * rowH;
      sl.addShape(pptx.ShapeType.ellipse, { x: IN(x + 16), y: IN(yy + 6), w: IN(24), h: IN(24), fill: { color: a.n <= 3 ? hex(C.navy) : "E2E8F0" }, line: { color: a.n <= 3 ? hex(C.navy) : "E2E8F0" } });
      T(sl, String(a.n), x + 16, yy + 6, 24, 24, { fontSize: 11, bold: true, align: "center", valign: "middle", color: a.n <= 3 ? "FFFFFF" : hex(C.ink) });
      const mc = a.oid ? (a.oid === meta().our_media ? C.our : a.oid === meta().compare_media ? C.cmp : C.sub) : b.blue ? C.cmp : C.sub;
      T(sl, a.media, x + 50, yy + 4, 90, 16, { fontSize: 10, bold: true, color: hex(mc) });
      const tw = w - (b.wide ? 300 : 270);
      T(sl, cut(a.title, b.wide ? 62 : 26), x + (b.wide ? 150 : 140), yy + 2, tw, 20, { fontSize: 11, bold: true, color: hex(C.ink), fit: "shrink" });
      T(sl, cut(a.sub || "", b.wide ? 90 : 40), x + (b.wide ? 150 : 140), yy + 22, tw, 16, { fontSize: 9, color: "94A3B8" });
      if (a.views != null) T(sl, fmt(a.views), x + w - 124, yy + 6, 108, 20, { fontSize: 12, bold: true, align: "right", color: hex(C.navy) });
    });
    return;
  }
  T(sl, b.text || "", x, y, w, hh, { fontSize: 14, color: hex(C.sub) });
}

// ── 보고서 창 ─────────────────────────
export async function openReportDialog({ canDownload, onExcel, defaultDay }) {
  const today = kstToday();
  const yday = defaultDay || addDays(today, -1);
  const lastWeek = addDays(monday(today), -7);
  const lastMonth = prevMonth(today.slice(0, 7));
  const st = { kind: "day", anchor: { day: yday, week: lastWeek, month: lastMonth + "-01" }, model: null, ss: null };
  const ov = h(`<div class="rp-ov"><div class="rp-dlg">
    <div class="rp-dh"><div><h3>보고서 받기</h3><div class="sub">일간·주간·월간 보고서를 디자인된 PDF / PPT로 받습니다. PPT는 표·차트를 고쳐 쓸 수 있습니다.</div></div><button class="btn sm" data-x>닫기</button></div>
    <div class="rp-ctl">
      <div class="seg" id="rk"><button data-k="day" class="on">일간</button><button data-k="week">주간</button><button data-k="month">월간</button></div>
      <span id="rpick"></span>
      <span class="rp-per" id="rper"></span>
      <span class="grow"></span>
      <button class="btn primary" id="rpdf">📄 PDF 받기</button>
      <button class="btn primary" id="rppt">📊 PPT 받기</button>
      <button class="btn" id="rxls" title="원자료(표) 엑셀">엑셀(원자료)</button>
    </div>
    <div class="rp-msg" id="rmsg"></div>
    <div class="rp-prev" id="rprev"><div class="loading">미리보기 만드는 중…</div></div>
  </div></div>`);
  document.body.append(ov);
  const close = () => ov.remove();
  $("[data-x]", ov).addEventListener("click", close);
  ov.addEventListener("click", (e) => e.target === ov && close());
  const fileName = () => `뉴스인사이트_${KIND[st.kind]}보고서_${st.model.p.s.replace(/-/g, "")}${st.kind === "day" ? "" : "-" + st.model.p.eFull.replace(/-/g, "")}`;
  const picker = () => {
    const a = st.anchor[st.kind];
    $("#rpick", ov).innerHTML = st.kind === "month"
      ? `<input type="month" class="input" id="rd" value="${a.slice(0, 7)}" max="${today.slice(0, 7)}">`
      : `<button class="btn sm" data-mv="-1">◀</button><input type="date" class="input" id="rd" value="${a}" max="${today}"><button class="btn sm" data-mv="1">▶</button>`;
    $("#rd", ov).addEventListener("change", (e) => { const v = e.target.value; if (!v) return; st.anchor[st.kind] = st.kind === "month" ? v + "-01" : st.kind === "week" ? monday(v) : v; build(); });
    $$("[data-mv]", ov).forEach((b) => b.addEventListener("click", () => { const step = st.kind === "week" ? 7 : 1; const n = addDays(st.anchor[st.kind], +b.dataset.mv * step); if (n > today) return; st.anchor[st.kind] = n; picker(); build(); }));
  };
  let seq = 0;
  const build = async () => {
    const my = ++seq;
    const p = periodOf(st.kind, st.anchor[st.kind]);
    $("#rper", ov).textContent = label(st.kind, p);
    $("#rprev", ov).innerHTML = '<div class="loading">미리보기 만드는 중…</div>';
    try {
      const model = await buildModel(st.kind, st.anchor[st.kind]);
      if (my !== seq) return;
      st.model = model;
      st.ss = slides(model);
      const box = $("#rprev", ov);
      box.innerHTML = "";
      const inner = h(`<div class="rp-scale"></div>`);
      box.append(inner);
      renderSlides(inner, model, st.ss);
      const noData = !model.A.rankDayCount && !model.A.pubDayCount;
      $("#rmsg", ov).innerHTML = noData ? '<span class="warn">이 기간에는 수집된 데이터가 없습니다.</span>' : model.partial ? `<span class="warn">보고 기간에 오늘·집계 중인 날이 있어 숫자가 바뀔 수 있습니다.</span>` : `슬라이드 ${st.ss.length}장 · 아래는 미리보기입니다.`;
    } catch (e) {
      console.error(e);
      $("#rprev", ov).innerHTML = `<div class="err-box">보고서를 만들지 못했습니다: ${esc(e.message)}</div>`;
    }
  };
  $$("#rk button", ov).forEach((b) => b.addEventListener("click", () => { st.kind = b.dataset.k; $$("#rk button", ov).forEach((x) => x.classList.toggle("on", x === b)); picker(); build(); }));
  const run = (fn, btn) => async () => {
    if (!canDownload()) return toast("다운로드 권한이 없습니다. 마스터에게 요청하세요.", 3000);
    if (!st.model) return toast("미리보기를 만드는 중입니다. 잠시 후 다시 눌러 주세요.");
    btn.disabled = true;
    const old = btn.textContent;
    try { await fn(st.model, st.ss, fileName(), (t) => (btn.textContent = t)); toast("저장했습니다"); }
    catch (e) { console.error(e); toast("만들기 실패: " + e.message, 5000); }
    finally { btn.disabled = false; btn.textContent = old; }
  };
  $("#rpdf", ov).addEventListener("click", run(toPDF, $("#rpdf", ov)));
  $("#rppt", ov).addEventListener("click", run(toPPT, $("#rppt", ov)));
  $("#rxls", ov).addEventListener("click", () => { const p = st.model?.p; onExcel(p ? { s: p.s, e: p.e } : null); });
  picker();
  build();
}
