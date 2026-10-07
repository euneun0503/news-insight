// 데이터 로딩 + 기간 집계
import { dateList, monthList, addDays, daysBetween, weekdayIdx } from "./util.js";

export const LIMITS = { rankingDays: 93, articleDays: 31 };

let META = null;
let VER = "";
const cache = new Map();

async function getJSON(path, { fresh = false } = {}) {
  // 미리보기.html(단일 파일)에서는 데이터가 페이지 안에 들어 있음
  if (window.__EMBED__) return window.__EMBED__[path] ?? null;
  const url = fresh ? `${path}?t=${Date.now()}` : `${path}?v=${encodeURIComponent(VER)}`;
  if (!fresh && cache.has(url)) return cache.get(url);
  const p = fetch(url, { cache: fresh ? "no-store" : "default" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null);
  if (!fresh) cache.set(url, p);
  return p;
}

export async function loadMeta() {
  META = (await getJSON("data/meta.json", { fresh: true })) || {
    media: {}, ranking_media: [], publish_media: [], ranking_days: [], article_days: [], months: [],
  };
  VER = META.updated_at || "0";
  META.rankingSet = new Set(META.ranking_days || []);
  META.articleSet = new Set(META.article_days || []);
  META.searchSet = new Set(META.search_days || []);
  return META;
}
export const meta = () => META;

// ── 표시 매체 선택 ─────────────────────────
// 우선순위: 내 설정(이 브라우저) → 사이트 기본값(data/settings.json, 관리자가 저장) → 수집 설정 기본(meta.view_rank / view_pub)
const SEL_KEY = "nk_media_sel";
let SITE = null;
export async function loadSettings() {
  SITE = (await getJSON("data/settings.json", { fresh: true })) || {};
  return SITE;
}
export const siteSettings = () => SITE || {};
export function defaultSel() {
  const v = SITE?.view;
  return {
    rank: v?.rank || META?.view_rank || META?.ranking_media || [],
    pub: v?.pub || META?.view_pub || META?.publish_media || [],
  };
}
export function personalSel() {
  try { const o = JSON.parse(localStorage.getItem(SEL_KEY) || "null"); return o && Array.isArray(o.rank) && Array.isArray(o.pub) ? o : null; } catch { return null; }
}
export function setPersonalSel(sel) {
  try { sel ? localStorage.setItem(SEL_KEY, JSON.stringify(sel)) : localStorage.removeItem(SEL_KEY); } catch {}
}
export function mediaSel() {
  const base = personalSel() || defaultSel();
  const fixed = [META?.our_media, META?.compare_media].filter(Boolean);
  // 랭킹에 넣은 매체는 발행 기사 수도 함께 보여줌 (전체 매체 발행 건수를 수집하므로)
  return { rank: new Set([...base.rank, ...fixed]), pub: new Set([...base.pub, ...fixed]), custom: !!personalSel() };
}
export async function loadCatalog() {
  return (await getJSON("data/media_catalog.json", { fresh: true })) || null;
}

// 네이버 전체 언론사 중 몇 곳을 수집하는지
export function naverCoverage() {
  const C = META?.naver_catalog;
  const T = C?.total ? { count: C.total, basis: "네이버 뉴스 언론사 목록(카테고리별)에 있는 언론사", as_of: (C.updated_at || "").slice(0, 10), source: "네이버 뉴스 언론사 목록 · 매체별 랭킹 페이지 직접 확인", url: "https://news.naver.com/main/officeList.naver" } : META?.naver_total;
  const cov = META?.coverage || {};
  const r = Object.values(cov).filter((c) => c.r).length || META?.ranking_media?.length || 0;
  const p = Object.values(cov).filter((c) => c.p || c.c).length || new Set([...(META?.publish_media || []), ...(META?.count_media || [])]).size;
  if (!T?.count) return { short: `랭킹 ${r}곳 · 발행목록 ${p}곳 수집`, T: null, r, p };
  const pc = (n) => Math.round((n / T.count) * 100) + "%";
  return { short: `네이버 언론사 ${T.count}곳 중 랭킹 ${r}곳(${pc(r)}) · 발행목록 ${p}곳(${pc(p)}) 수집`, T, r, p, pc };
}
export const mediaName = (oid) => META?.media?.[oid] || oid;

export async function loadBoard(fresh = false) {
  const b = await getJSON("data/board.json", { fresh: true });
  return b || { posts: [] };
}

async function loadSummaries(s, e) {
  const months = monthList(s, e).filter((m) => (META.months || []).includes(m));
  const docs = await Promise.all(months.map((m) => getJSON(`data/summary/${m}.json`)));
  const days = {};
  for (const d of docs) if (d) Object.assign(days, d.days);
  return days;
}

export async function loadRankingDays(days) {
  const sel = mediaSel().rank;
  const list = days.filter((d) => META.rankingSet.has(d));
  const docs = await Promise.all(list.map((d) => getJSON(`data/ranking/${d}.json`)));
  const items = [];
  docs.forEach((doc, i) => {
    if (!doc) return;
    for (const r of doc.items) if (sel.has(r[0])) items.push({ day: list[i], oid: r[0], aid: r[1], rank: r[2], views: r[3], title: r[4], reporter: r[5], pub: r[6] });
  });
  return items;
}

export async function loadArticleDays(days) {
  const sel = mediaSel().pub;
  const list = days.filter((d) => META.articleSet.has(d));
  const docs = await Promise.all(list.map((d) => getJSON(`data/articles/${d}.json`)));
  const items = [];
  docs.forEach((doc, i) => {
    if (!doc) return;
    for (const r of doc.items) if (sel.has(r[0])) items.push({ day: list[i], oid: r[0], aid: r[1], time: r[2], title: r[3], reporter: r[4] });
  });
  return items;
}

// 발행 '건수'만 세는 매체의 기사 제목 (발행 시각·기자 없음)
export async function loadTitles(days, oids) {
  const months = [...new Set(days.map((d) => d.slice(0, 7)))];
  const want = new Set(days);
  const docs = await Promise.all(months.flatMap((m) => oids.map((o) => getJSON(`data/titles/${m}/${o}.json`).then((doc) => [o, doc]))));
  const items = [];
  for (const [oid, doc] of docs) {
    if (!doc) continue;
    for (const [day, list] of Object.entries(doc)) if (want.has(day)) for (const [aid, title] of list) items.push({ day, oid, aid, time: "", title, reporter: "", listOnly: true });
  }
  return items;
}

// 검색 키워드: 구글 급상승(기간 내 누적) + 네이버 검색량(기간 내 가장 최근 조회분)
export async function loadSearch(days) {
  // 검색 키워드는 '지금' 지표라, 어제·오늘을 보고 있으면 오늘 수집분까지 포함 (메타에 아직 없어도 파일을 직접 확인)
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const yday = addDays(today, -1);
  const known = new Set([...(META.search_days || []), today]);
  const recent = days.length && days[days.length - 1] >= yday;
  const extra = recent ? [...known].filter((d) => d > days[days.length - 1]).sort() : [];
  let list = [...new Set([...days.filter((d) => known.has(d)), ...extra])].slice(-LIMITS.rankingDays);
  let fallback = false;
  if (!list.length && META.search_days?.length) { list = META.search_days.slice(-1); fallback = true; } // 기간 안에 없으면 가장 최근 수집분
  const docs = (await Promise.all(list.map((d) => getJSON(`data/search/${d}.json`)))).map((doc, i) => doc && { ...doc, day: list[i] }).filter(Boolean);
  const g = new Map();
  for (const doc of docs) {
    for (const r of doc.google || []) {
      const x = g.get(r.title) || { title: r.title, traffic: 0, days: [], news: [] };
      x.traffic = Math.max(x.traffic, r.traffic || 0);
      x.days.push(doc.day);
      if (r.news?.length) x.news = r.news;
      g.set(r.title, x);
    }
  }
  // 네이버 검색량·구글 관심도는 '최근 30일' 값이라 기간 안에 없으면 가장 최근 수집분을 씀
  let volDoc = [...docs].reverse().find((d) => d.volume && Object.keys(d.volume).length);
  let gDoc = [...docs].reverse().find((d) => d.gvol && Object.keys(d.gvol).length);
  if (!volDoc || !gDoc) {
    const cand = [...known].sort().reverse().slice(0, 4);
    for (const d of cand) {
      const doc = await getJSON(`data/search/${d}.json`);
      if (!doc) continue;
      if (!volDoc && doc.volume && Object.keys(doc.volume).length) volDoc = { ...doc, day: d };
      if (!gDoc && doc.gvol && Object.keys(doc.gvol).length) gDoc = { ...doc, day: d };
      if (volDoc && gDoc) break;
    }
  }
  return {
    days: docs.map((d) => d.day),
    fallback,
    google: [...g.values()].sort((a, b) => b.traffic - a.traffic || b.days.length - a.days.length),
    volume: volDoc?.volume || {},
    related: volDoc?.related || [],
    seeds: new Set(volDoc?.seeds || []),
    seedGroups: volDoc?.seed_groups || meta()?.search_seed_groups || null,
    volumeDay: volDoc?.day || null,
    gvol: gDoc?.gvol || {},
    gvolAnchor: gDoc?.gvol_anchor || meta()?.google_anchor || "날씨",
    gvolDay: gDoc?.day || null,
  };
}

/**
 * 기간 데이터 묶음. 페이지마다 필요한 것만 지연 로딩.
 */
export class Range {
  constructor(s, e) {
    this.s = s;
    this.e = e;
    this.days = dateList(s, e);
    this.n = this.days.length;
    this._rank = null;
    this._art = null;
  }
  async init() {
    this.sum = await loadSummaries(this.s, this.e);
    // 31일 이하: 매체별 키워드·기자 파일(data/kw)로 매체 설정에 맞춰 다시 합산
    this.kwDocs = {};
    if (this.n <= LIMITS.articleDays) {
      const ds = this.days.filter((d) => this.sum[d]);
      const docs = await Promise.all(ds.map((d) => getJSON(`data/kw/${d}.json`)));
      ds.forEach((d, i) => docs[i] && (this.kwDocs[d] = docs[i]));
    }
    this.agg = aggregate(this.days, this.sum, this.kwDocs);
    return this;
  }
  get canRanking() { return this.n <= LIMITS.rankingDays; }
  get canArticles() { return this.n <= LIMITS.articleDays; }
  async ranking() {
    if (!this._rank) this._rank = this.canRanking ? loadRankingDays(this.days) : Promise.resolve(null);
    return this._rank;
  }
  async articles() {
    if (!this._art) this._art = this.canArticles ? loadArticleDays(this.days) : Promise.resolve(null);
    return this._art;
  }
  async search() {
    if (!this._search) this._search = loadSearch(this.days);
    return this._search;
  }
  // 직전 동일 기간 (증감 비교용)
  async previous() {
    if (!this._prev) {
      const e = addDays(this.s, -1);
      const s = addDays(e, -(this.n - 1));
      this._prev = new Range(s, e).init();
    }
    return this._prev;
  }
}

export function aggregate(days, sum, kwDocs = {}) {
  const a = {
    days,
    covered: { pub: [], rank: [] },
    partialDays: [],
    pub: {}, pubDay: {}, pubDays: {}, pubH: {}, pubTotal: 0,
    rank: {}, rankDay: {}, rankViews: 0, rankCount: 0, noView: new Set(),
    rankH: [Array(24).fill(0), Array(24).fill(0)],
    wd: { pub: Array(7).fill(0), views: Array(7).fill(0), pubDays: Array(7).fill(0), rankDays: Array(7).fill(0) },
    readH: {}, readDays: 0, // 시간대별 조회수 증가 추정 (매시간 스냅샷)
    kw: new Map(), // word -> {pub, rank, views, daily: {day: score}}
    rep: new Map(),
    top: [],
  };
  const sel = mediaSel();
  const anySel = new Set([...sel.rank, ...sel.pub]);
  for (const d of days) {
    const s = sum[d];
    a.pubDay[d] = {};
    a.rankDay[d] = {};
    if (!s) continue;
    const wi = weekdayIdx(d);
    if (s.pub) {
      a.covered.pub.push(d);
      a.wd.pubDays[wi]++;
      for (const [oid, n] of Object.entries(s.pub)) {
        if (!sel.pub.has(oid)) continue;
        (a.pubDays ||= {})[oid] = (a.pubDays[oid] || 0) + 1; // 매체별 수집된 날 수
        const wo = ((a.wdO ||= {})[oid] ||= [Array(7).fill(0), Array(7).fill(0)]); wo[0][wi] += n; wo[1][wi]++; // 매체별 요일 합·날 수
        a.pub[oid] = (a.pub[oid] || 0) + n;
        a.pubDay[d][oid] = n;
        a.pubTotal += n;
        a.wd.pub[wi] += n;
      }
      for (const [oid, arr] of Object.entries(s.pubH || {})) {
        if (!sel.pub.has(oid)) continue;
        const t = (a.pubH[oid] ||= Array(24).fill(0));
        arr.forEach((v, i) => (t[i] += v));
      }
    }
    if (s.rank) {
      a.covered.rank.push(d);
      if (!s.rankFinal) a.partialDays.push(d);
      a.wd.rankDays[wi]++;
      for (const [oid, [n, v, top1, has]] of Object.entries(s.rank)) {
        if (!sel.rank.has(oid)) continue;
        // has === 0 : 네이버가 이 매체 조회수를 공개하지 않음 → 조회수 통계에서 제외
        if (has === 0) { a.noView.add(oid); (a.rankNV ||= {})[oid] = ((a.rankNV || {})[oid] || 0) + n; continue; }
        const r = (a.rank[oid] ||= { n: 0, views: 0, top1: 0, top1Days: 0, days: 0 });
        r.n += n; r.views += v; r.days++;
        if (top1) { r.top1 += top1; r.top1Days++; }
        a.rankDay[d][oid] = v;
        a.rankViews += v;
        a.rankCount += n;
        a.wd.views[wi] += v;
      }
      if (s.rankHm) { // 매체별 → 선택 매체만
        for (const [oid, hh] of Object.entries(s.rankHm)) {
          if (!sel.rank.has(oid) || a.noView.has(oid)) continue;
          for (const [hr, [n, v]] of Object.entries(hh)) { a.rankH[0][hr] += n; a.rankH[1][hr] += v; }
        }
      } else {
        s.rankH?.[0]?.forEach((v, i) => (a.rankH[0][i] += v));
        s.rankH?.[1]?.forEach((v, i) => (a.rankH[1][i] += v));
      }
      for (const r of s.top || []) if (sel.rank.has(r[0])) a.top.push({ day: d, oid: r[0], aid: r[1], rank: r[2], views: r[3], title: r[4], reporter: r[5], pub: r[6] });
    }
    if (s.readH && s.readH.cov >= 1200) { // 하루의 20시간 이상 기록된 날만
      a.readDays++;
      for (const [oid, arr] of Object.entries(s.readH.h)) {
        if (!sel.rank.has(oid)) continue;
        const t = (a.readH[oid] ||= Array(24).fill(0));
        arr.forEach((v, i) => (t[i] += v));
      }
    }
    const kd = kwDocs[d];
    let kwList = s.kw || [];
    if (kd?.m) { // 선택 매체만 합산: 발행 단어는 발행 선택 매체, 랭킹 단어는 랭킹 선택 매체
      const t = new Map();
      for (const [oid, list] of Object.entries(kd.m)) {
        const P = sel.pub.has(oid), Rk = sel.rank.has(oid);
        if (!P && !Rk) continue;
        for (const [w, p, rk, v, rkv] of list) {
          const x = t.get(w) || [w, 0, 0, 0, 0];
          if (P) x[1] += p;
          if (Rk) { x[2] += rk; x[3] += v; x[4] += rkv; }
          t.set(w, x);
        }
      }
      kwList = [...t.values()].filter((x) => x[1] + x[2] >= 2 || x[2] >= 1).sort((x, y) => y[1] + y[2] * 3 - (x[1] + x[2] * 3)).slice(0, 250);
      a.kwSelDays = (a.kwSelDays || 0) + 1;
    } else if (s.kw) a.kwAllDays = (a.kwAllDays || 0) + 1;
    for (const [w, p, rk, v, rkv] of kwList) {
      const k = a.kw.get(w) || { word: w, pub: 0, rank: 0, views: 0, rankV: 0, daily: {} };
      k.pub += p; k.rank += rk; k.views += v; k.rankV += rkv ?? rk;
      k.daily[d] = (k.daily[d] || 0) + p + rk;
      (k.dP ||= {})[d] = ((k.dP || {})[d] || 0) + p;
      (k.dR ||= {})[d] = ((k.dR || {})[d] || 0) + rk;
      a.kw.set(w, k);
    }
    for (const [name, oid, p, rk, v] of kd?.r || s.rep || []) {
      if (!anySel.has(oid)) continue;
      const key = name + "|" + oid;
      const r = a.rep.get(key) || { name, oid, pub: 0, rank: 0, views: 0 };
      r.pub += p; r.rank += rk; r.views += v;
      a.rep.set(key, r);
    }
  }
  for (const oid of a.noView) delete a.rank[oid];
  a.top.sort((x, y) => (y.views ?? -1) - (x.views ?? -1));
  a.pubDayCount = a.covered.pub.length;
  a.rankDayCount = a.covered.rank.length;
  return a;
}

export const kwScore = (k) => k.pub + k.rank * 3;

// 키워드 목록 + 직전 기간 대비 변화
// 급상승 비교: 발행·랭킹을 따로 하루 평균으로 계산하고, 두 기간 모두 수집된 항목만 비교
// 직전 기간 자료가 없으면 선택 기간을 앞·뒤 절반으로 나눠 비교 (agg.riseMode = "half")
export function keywordTable(agg, prevAgg) {
  const rows = [];
  const covered = [...new Set([...agg.covered.rank, ...agg.covered.pub])].sort();
  const half = !prevAgg && covered.length >= 2;
  const first = new Set(covered.slice(0, Math.floor(covered.length / 2)));
  const pubSet = new Set(agg.covered.pub), rankSet = new Set(agg.covered.rank);
  // 두 비교 구간의 (발행일수, 랭킹일수)
  let A1, B1;
  if (half) {
    A1 = { p: [...first].filter((d) => pubSet.has(d)).length, r: [...first].filter((d) => rankSet.has(d)).length };
    B1 = { p: agg.covered.pub.filter((d) => !first.has(d)).length, r: agg.covered.rank.filter((d) => !first.has(d)).length };
  } else if (prevAgg) {
    A1 = { p: prevAgg.pubDayCount, r: prevAgg.rankDayCount };
    B1 = { p: agg.pubDayCount, r: agg.rankDayCount };
  }
  const useP = A1 && A1.p > 0 && B1.p > 0, useR = A1 && A1.r > 0 && B1.r > 0;
  const hasCmp = !!A1 && (useP || useR);
  agg.riseMode = !hasCmp ? null : half ? "half" : "prev";
  agg.riseParts = hasCmp ? [useP && "발행", useR && "랭킹"].filter(Boolean).join("·") : "";
  agg.riseSplit = half ? [covered[0], [...first].pop(), covered[first.size], covered[covered.length - 1]] : null;
  const rate = (pub, rank, n) => (useP ? pub / n.p : 0) + (useR ? (rank * 3) / n.r : 0);
  for (const k of agg.kw.values()) {
    const score = kwScore(k);
    let prev = 0, cur = 0;
    if (hasCmp) {
      if (half) {
        let ap = 0, ar = 0, bp = 0, br = 0;
        for (const [d, v] of Object.entries(k.dP || {})) first.has(d) ? (ap += v) : (bp += v);
        for (const [d, v] of Object.entries(k.dR || {})) first.has(d) ? (ar += v) : (br += v);
        prev = rate(ap, ar, A1); cur = rate(bp, br, B1);
      } else {
        const p = prevAgg.kw.get(k.word);
        prev = p ? rate(p.pub, p.rank, A1) : 0;
        cur = rate(k.pub, k.rank, B1);
      }
    }
    rows.push({
      ...k,
      score,
      prev: Math.round(prev * 10) / 10,
      cur: Math.round(cur * 10) / 10,
      riseAmt: cur - prev,
      change: hasCmp ? (prev ? (cur - prev) / prev : null) : undefined,
      isNew: hasCmp ? prev === 0 && score >= 3 : false,
      perArticle: k.rankV ? k.views / k.rankV : 0,
    });
  }
  return rows;
}

export function rangeLabel(r) {
  return r.s === r.e ? r.s.replace(/-/g, ".") : `${r.s.replace(/-/g, ".")} ~ ${r.e.replace(/-/g, ".")} (${r.n}일)`;
}

export function presetRange(p, last) {
  // last: 마지막 '확정' 데이터 날짜
  const end = last;
  const [y, m] = end.split("-").map(Number);
  switch (p) {
    case "yesterday": return [end, end];
    case "7": return [addDays(end, -6), end];
    case "30": return [addDays(end, -29), end];
    case "thisMonth": return [`${end.slice(0, 7)}-01`, end];
    case "lastMonth": {
      const first = new Date(Date.UTC(y, m - 2, 1)).toISOString().slice(0, 10);
      const lastD = new Date(Date.UTC(y, m - 1, 0)).toISOString().slice(0, 10);
      return [first, lastD];
    }
    case "quarter": {
      const q = Math.floor((m - 1) / 3) * 3 + 1;
      return [`${y}-${String(q).padStart(2, "0")}-01`, end];
    }
    case "year": return [`${y}-01-01`, end];
  }
  return [addDays(end, -6), end];
}

export { daysBetween };
