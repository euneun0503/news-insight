// ⓘ 자료 출처 안내 — 각 숫자·표 옆의 i 버튼을 누르면 출처, 수집 방법, 계산식, 주의할 점을 보여줍니다.
import { esc, kstDateTime } from "./util.js";
import { meta, mediaName, naverCoverage } from "./data.js";

const RANK_URL = "https://media.naver.com/press/346/ranking";
const LIST_URL = "https://news.naver.com/main/list.naver?mode=LPOD&mid=sec&oid=346";
const ART_URL = "https://n.news.naver.com/article/346/0000116684";

const SRC = {
  ranking: { name: "네이버 언론사별 랭킹 (많이 본 뉴스)", url: RANK_URL, how: "매체마다 media.naver.com/press/{언론사코드}/ranking?date=날짜 페이지의 상위 20건과 표시된 조회수" },
  list: { name: "네이버 뉴스 언론사별 기사목록", url: LIST_URL, how: "news.naver.com 언론사별 전체 기사목록을 끝까지 넘기며 수집" },
  article: { name: "네이버 기사 상세페이지", url: ART_URL, how: "기사마다 상세페이지의 입력시각(data-date-time)과 기자 바이라인" },
  searchad: { name: "네이버 검색광고 API (키워드 도구)", url: "https://searchad.naver.com", how: "네이버 공식 API의 최근 30일 PC·모바일 월간 검색수" },
  gtrends: { name: "구글 트렌드 (키워드별 관심도)", url: "https://trends.google.com/trends/explore?geo=KR", how: "구글 트렌드에서 키워드 4개 + 기준어를 함께 비교한 최근 30일 평균 관심도" },
  trends: { name: "구글 트렌드 한국 급상승 검색어", url: "https://trends.google.com/trending?geo=KR", how: "trends.google.com/trending/rss?geo=KR 의 급상승 검색어와 대략 검색량" },
  admin: { name: "사이트 관리자 작성", url: null, how: "관리자 메뉴에서 등록한 글 (GitHub 저장소 data/board.json)" },
};

const NOVIEW = "조선일보·동아일보·중앙일보·데일리안처럼 네이버가 랭킹 조회수를 공개하지 않는 매체는 0이 아니라 ‘미공개’로 보고 합계·점유율·순위에서 뺍니다.";
const TODAY = "오늘 날짜의 랭킹은 하루가 끝날 때까지 계속 바뀝니다. 자정 이후 수집분부터 확정값으로 봅니다.";
const NAVER_ONLY = "조회수는 네이버 뉴스 안에서 읽힌 횟수입니다. 자사 홈페이지·구글·다음 등 다른 경로 조회는 포함되지 않습니다.";
const GAPS = "수집되지 않은 날은 0으로 치지 않고 비워 둡니다. 직전 기간 대비 증감은 수집된 날의 하루 평균끼리 비교합니다.";

export const INFO = {
  pubTotal: { t: "전체 발행 기사", src: ["list", "article"], calc: "선택 기간에 발행된 기사 수의 합. 기사 날짜는 상세페이지 입력시각(한국시간) 기준이며, 같은 기사는 한 번만 셉니다.", note: [GAPS, "발행목록 수집 매체만 포함합니다 (사이드바 하단 참고)."] },
  rankViews: { t: "랭킹 조회수 합", src: ["ranking"], calc: "선택 기간 동안 조회수를 공개하는 매체들의 랭킹 상위 20건 조회수를 모두 더한 값.", note: [NAVER_ONLY, NOVIEW, TODAY, "랭킹 20위 밖 기사의 조회수는 포함되지 않습니다."] },
  ourViews: { t: "우리 매체 랭킹 조회수", src: ["ranking"], calc: "우리 매체 랭킹 상위 20건 조회수의 합. 점유율 = 우리 조회수 ÷ 조회수 공개 매체 전체 합. 순위는 조회수 공개 매체 중 순위.", note: [NAVER_ONLY, TODAY, GAPS] },
  ourPub: { t: "매체 발행 기사", src: ["list", "article"], calc: "선택한 기간에 그 매체가 발행한 기사 수의 합계입니다(하루를 고르면 그날, 7일이면 7일 합계). 일평균 = 합계 ÷ 발행목록이 수집된 날 수. % = 직전 동일 기간(같은 길이의 바로 앞 기간) 합계 대비 증감이며, 두 기간의 수집일 수가 다르면 하루 평균끼리 비교합니다.", note: ["기사 날짜는 상세페이지 입력시각(한국시간) 기준이며, 같은 기사는 한 번만 셉니다."] },
  trend: { t: "일별 추이", src: ["ranking", "list", "article"], calc: "기본 보기(발행 + 조회수)는 선택한 매체의 날짜별 발행 기사 수(막대, 왼쪽 축)와 랭킹 상위 20건 조회수 합(선, 오른쪽 축)을 겹쳐 보여줍니다. 다른 탭에서는 매체별로 비교합니다. 수집되지 않은 날은 비워 둡니다.", note: [NOVIEW, TODAY] },
  mediaRank: { t: "매체별 랭킹 조회수", src: ["ranking"], calc: "매체별 랭킹 상위 20건 조회수 합을 큰 순서로 정렬. 증감은 직전 동일 기간의 하루 평균 대비.", note: [NOVIEW, NAVER_ONLY] },
  kwTitle: { t: "기사 제목 키워드", src: ["ranking", "list"], calc: "기사 제목을 단어로 나눈 뒤 조사·불용어·숫자를 빼고 셉니다. 한 제목에 같은 단어가 여러 번 나와도 1회. 종합점수 = 발행 기사 수 + 랭킹 진입 수 × 3.", note: ["검색량이 아니라 ‘기사 제목에 얼마나 쓰였나’를 나타냅니다.", "형태소 분석기가 아닌 규칙 기반이라 ‘높이’, ‘넘어’ 같은 단어가 섞일 수 있습니다.", "기간이 길면 일별 상위 250개 키워드를 합산합니다."] },
  kwRising: { t: "급상승 키워드", src: ["ranking", "list"], calc: "종합점수가 직전 동일 기간보다 20% 이상 늘어난 키워드(점수 4 이상). NEW는 직전 기간에 없던 키워드. 발행 수와 랭킹 진입 수를 각각 하루 평균으로 바꿔 비교하고, 두 기간 모두 수집된 항목만 씁니다(예: 앞 기간에 발행목록이 없으면 랭킹만 비교). 직전 기간 자료가 없으면 선택 기간을 앞·뒤 절반으로 나눠 비교합니다.", note: [GAPS] },
  kwDetail: { t: "키워드 상세", src: ["ranking", "list", "searchad"], calc: "제목에 이 키워드가 들어간 기사들을 매체·날짜별로 모은 것. 함께 쓰인 키워드는 같은 제목에 함께 나온 횟수(랭킹 기사는 3배 가중).", note: ["네이버 검색량은 검색광고 API가 연결된 경우에만 표시됩니다."] },
  topArticles: { t: "랭킹 상위 기사", src: ["ranking", "article"], calc: "선택 기간 모든 매체 랭킹 기사를 조회수 순으로 정렬. 순위는 그날 그 매체 안에서의 랭킹 순위.", note: [NOVIEW, NAVER_ONLY] },
  notice: { t: "공지사항", src: ["admin"], calc: "관리자가 등록한 공지 중 게시 기간 안에 있는 글.", note: [] },
  mediaTable: { t: "매체별 성과표", src: ["ranking", "list", "article"], calc: "점유율 = 매체 조회수 ÷ 조회수 공개 매체 합. 랭킹 기사 평균 = 조회수 합 ÷ 랭킹 기사 수. 1위 평균 = 날마다 1위 기사 조회수의 평균.", note: [NOVIEW, "발행 기사 수는 그 매체가 네이버에 송고한 전체 기사 수입니다. 일부 날짜만 수집된 매체는 ‘n/m일 수집’으로 표시됩니다."] },
  mediaCombo: { t: "랭킹 조회수 vs 발행량", src: ["ranking", "list"], calc: "막대는 매체별 랭킹 조회수 합, 선은 같은 기간 발행 기사 수.", note: [NOVIEW] },
  weekday: { t: "요일별·주별·월별 랭킹 조회수 합", src: ["ranking", "list"], calc: "매체마다 하루 랭킹 조회수 합(그날 상위 20건 조회수를 더한 값)을 구한 뒤, 요일별은 같은 요일끼리, 주별은 월~일 한 주씩, 월별은 같은 달끼리 더합니다. 막대 아래 숫자는 더한 날 수입니다.", note: ["조회 기간 안의 날짜만 더합니다. 월별 비교는 기간을 여러 달로 넓혀 보세요.", "더한 날 수가 다르면(예: 월요일 5번, 화요일 4번) 합계도 그만큼 차이 납니다."] },
  heatmap: { t: "발행 시간대 히트맵", src: ["list", "article"], calc: "기사 상세페이지 입력시각의 ‘시’ 기준으로 매체별 발행 건수를 셉니다. 진할수록 그 매체 안에서 많은 시간대.", note: ["입력시각이 확인되지 않은 기사는 빠집니다."] },
  articles: { t: "기사 목록", src: ["ranking", "list", "article"], calc: "랭킹 기사: 매체별 랭킹 상위 20건 원본. 전체 발행 기사: 언론사 기사목록 원본. 제목을 누르면 네이버 원문으로 이동합니다.", note: [NOVIEW, "전체 발행 기사 목록은 31일 이하 기간에서 볼 수 있습니다."] },
  insightSummary: { t: "이번 기간 요약", src: ["ranking", "list", "article"], calc: "아래 그래프들의 결과에서 가장 큰 값을 골라 문장으로 만든 것입니다.", note: ["상관관계이지 인과관계가 아닙니다. 기간이 짧거나 기사 수가 적으면 참고만 하세요.", NOVIEW] },
  insightHour: { t: "발행 시간대별 반응", src: ["ranking", "list", "article"], calc: "막대: 시간대별 전체 발행 기사 수. 선: 그 시간에 입력된 랭킹 기사들의 평균 조회수(기사 2건 이상인 시간만).", note: ["랭킹 기사의 입력시각은 상세페이지에서 확인된 경우에만 포함됩니다.", NOVIEW] },
  insightWeekday: { t: "요일별 반응", src: ["ranking", "list"], calc: "요일마다 하루 평균 발행 기사 수, 그리고 하루 랭킹 조회수 합(상위 20건 합계)의 요일 평균.", note: ["기간이 짧으면 요일당 표본이 적습니다."] },
  titlePattern: { t: "제목 패턴별 성과", src: ["ranking"], calc: "랭킹 기사 제목을 규칙으로 분류합니다. 숫자 포함, N가지·N개, 물음표, 따옴표, 말줄임(…), [대괄호] 머리표, 호기심어(이것·이유·비결·정체·방법·진짜·충격·알고 보니·뜻밖), 느낌표. 조회수 차이 = 그 패턴이 있는 기사 평균 ÷ 없는 기사 평균 − 1.", note: ["조회수 미공개 매체 기사는 빠집니다.", "회색 막대는 전체 발행 기사 중 그 패턴 비율입니다(31일 이하 기간)."] },
  titleLength: { t: "제목 길이별 평균 조회수", src: ["ranking"], calc: "랭킹 기사 제목 글자 수(공백 포함) 구간별 평균 조회수. 괄호 안 숫자는 기사 수.", note: ["조회수 미공개 매체 기사는 빠집니다."] },
  reporters: { t: "기자 통계", src: ["article", "ranking", "list"], calc: "기사 상세페이지 바이라인의 기자명 기준으로 기사 원본에서 직접 계산합니다. 발행 = 기간 내 발행 기사 수, 랭킹 진입 = 매체별 랭킹 20위 안에 든 기사 수, 1위 = 그날 매체 랭킹 1위 횟수, 취합 조회수 합계 = 매체별 랭킹 상위 20건에 오른 그 기자 기사의 조회수 합, 최고 조회수 = 그 기자 기사 중 가장 높은 랭킹 조회수, 진입률 = 랭킹 진입 ÷ 발행.", note: ["공동 기자 기사는 ‘홍길동·김철수’처럼 한 이름으로 묶입니다.", "기자명이 없는 기사(사설, 통신 전재 등)는 빠집니다.", "랭킹은 93일, 발행은 31일보다 긴 기간이면 일별 요약값으로 계산합니다.", "과거 엑셀에서 가져온 기사는 ‘기자명 채우기’를 해야 기자명이 들어갑니다."] },
  searchNaver: { t: "네이버 검색량 랭킹", src: ["searchad", "list", "ranking"], calc: "최근 30일 PC + 모바일 실제 검색 횟수 (10회 미만은 5로 표시). 대상: 관심 키워드(설정), 그날 기사 제목 상위 키워드, 그 연관검색어. 기사 부족 = 월간 검색수 ÷ (선택 기간 발행 기사수 + 1).", note: ["검색량은 하루 한 번 조회한 최근 30일 값이라 선택 기간과 정확히 맞지 않습니다.", "광고 경쟁은 검색광고 입찰 경쟁 정도로, 상업성이 높은 키워드일수록 ‘높음’입니다.", "네이버 검색광고 API 키가 있어야 수집됩니다 (무료)."] },
  searchGoogle: { t: "구글 검색량 랭킹", src: ["gtrends", "list", "ranking"], calc: "구글 트렌드에서 키워드 4개와 기준어(기본 ‘날씨’)를 함께 조회해 최근 30일 평균 관심도를 구하고, 기준어 = 100 으로 환산합니다. 이렇게 하면 여러 번 나눠 조회한 키워드끼리도 비교할 수 있습니다.", note: ["구글은 키워드별 실제 검색 횟수를 공개하지 않아 상대값입니다. 네이버 검색수와 직접 비교할 수 없습니다.", "공식 API가 아니라 구글 트렌드 웹 데이터를 읽는 방식이라, 구글이 막으면 그날은 비어 있을 수 있습니다.", "기준어는 collector/config.json 의 google_anchor 에서 바꿀 수 있습니다."] },
  googleTrends: { t: "급상승 검색어", src: ["trends"], calc: "자동 수집 때마다(매시간·3시간마다) 구글 트렌드 한국 급상승 검색어를 받아 날짜별로 누적하고, 여러 날·여러 번 오른 검색어를 위로, 상위 30개를 보여줍니다. 최대 검색량은 구글이 보여주는 대략치(예: 2,000+).", note: ["구글 검색 기준이며 네이버 검색과는 다릅니다.", "네이버 실시간 검색어는 2021년 서비스 종료로 제공되지 않습니다."] },
  readHour: { t: "독자가 많이 읽은 시간대", src: ["ranking"], calc: "네이버 랭킹 조회수는 ‘그날 0시부터 지금까지’ 누적값입니다. 수집기가 매시간 조회수를 기록해 두고, 두 기록 사이에 늘어난 조회수를 그 시간대에 고르게 나눠 시간당 조회수를 추정합니다. 하루 20시간 이상 기록된 날만 평균에 넣습니다.", note: ["각 시점의 랭킹 상위 20건만 추적합니다. 중간에 20위 안으로 새로 들어온 기사는 그 전 증가량을 알 수 없어 그 구간에서 빠집니다.", "수집 간격(약 1시간) 안의 변화는 고르게 나눈 추정치입니다.", NOVIEW, "과거 엑셀 자료(하루 1회 수집)로는 계산할 수 없고, 매시간 자동 수집을 켠 뒤부터 쌓입니다."] },
  coverage: { t: "수집 범위", src: ["ranking", "list"], calc: "", note: ["이 사이트의 합계·점유율·순위는 수집하는 매체끼리 비교한 값이며, 네이버 전체 언론사 기준이 아닙니다.", "수집 매체는 collector/config.json 에서 바꿀 수 있습니다."] },
  reporterCoverage: { t: "기자명 확인 비율", src: ["article"], calc: "기사 상세페이지에서 기자명을 찾은 기사의 비율. 본문 바이라인(예: ‘(서울=뉴스1) 홍길동 기자 =’, ‘홍길동 기자 이메일’)과 기사 정보에서 찾습니다.", note: ["사설·칼럼·통신 전재 기사처럼 기자명이 없는 기사는 빠집니다.", "매체 이름(헬스조선 등)은 기자명으로 세지 않습니다."] },
  status: { t: "수집 상태", src: ["ranking", "list"], calc: "GitHub Actions가 2시간마다 수집기를 실행한 기록.", note: ["실패한 매체는 기존 데이터를 지우지 않고 그대로 둡니다."] },
};

export function info(key) {
  return INFO[key] ? `<button type="button" class="info-btn" data-info="${key}" aria-label="자료 출처 보기" title="자료 출처">i</button>` : "";
}

function render(key) {
  const d = INFO[key];
  const M = meta() || {};
  const run = M.last_run;
  const srcHtml = d.src.map((k) => {
    const s = SRC[k];
    return `<li><b>${esc(s.name)}</b>${s.url ? ` <a href="${s.url}" target="_blank" rel="noopener">열기 ↗</a>` : ""}<div>${esc(s.how)}</div></li>`;
  }).join("");
  const C = naverCoverage();
  if (key === "coverage") d.calc = C.T ? `네이버 전체 기준: ${C.T.basis} ${C.T.count}곳 (${C.T.as_of} 기준). 이 중 랭킹 ${C.r}곳(${C.pc(C.r)}), 전체 발행목록 ${C.p}곳(${C.pc(C.p)})을 수집합니다.` : C.short;
  const media = [
    C.short,
    M.ranking_media?.length && `랭킹 수집 매체: ${M.ranking_media.map(mediaName).join(", ")}`,
    M.publish_media?.length && `발행목록 수집 매체: ${M.publish_media.map(mediaName).join(", ")}`,
    `보관 기간: 최근 ${M.retention_months || 24}개월 (지난 데이터는 오래된 것부터 자동 삭제)`,
  ].filter(Boolean);
  return `<div class="info-pop-head"><b>${esc(d.t)}</b><button type="button" class="info-close" aria-label="닫기">✕</button></div>
    <div class="info-sec"><div class="info-lab">출처</div><ul>${srcHtml}</ul></div>
    <div class="info-sec"><div class="info-lab">계산 방법</div><p>${esc(d.calc)}</p></div>
    ${d.note.length ? `<div class="info-sec"><div class="info-lab">주의할 점</div><ul class="info-notes">${d.note.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></div>` : ""}
    <div class="info-foot">${media.map(esc).join("<br>")}${C.T ? `<br>전체 언론사 수 출처: ${C.T.url ? `<a href="${esc(C.T.url)}" target="_blank" rel="noopener">${esc(C.T.source)}</a>` : esc(C.T.source)}` : ""}${M.first ? `<br>데이터 범위: ${esc(M.first)} ~ ${esc(M.last || "")}` : ""}${run?.at ? `<br>마지막 수집: ${esc(kstDateTime(run.at))}` : M.updated_at ? `<br>마지막 갱신: ${esc(kstDateTime(M.updated_at))}` : ""}</div>`;
}

let pop;
function close() {
  if (pop) { pop.remove(); pop = null; }
}
export function setupInfo() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".info-btn");
    if (btn) {
      e.preventDefault();
      e.stopPropagation();
      const same = pop && pop.dataset.key === btn.dataset.info;
      close();
      if (same) return;
      pop = document.createElement("div");
      pop.className = "info-pop";
      pop.dataset.key = btn.dataset.info;
      pop.setAttribute("role", "dialog");
      pop.innerHTML = render(btn.dataset.info);
      document.body.appendChild(pop);
      const r = btn.getBoundingClientRect();
      const w = Math.min(380, window.innerWidth - 24);
      pop.style.width = w + "px";
      let left = r.left + window.scrollX - 12;
      left = Math.max(12 + window.scrollX, Math.min(left, window.scrollX + window.innerWidth - w - 12));
      pop.style.left = left + "px";
      pop.style.top = r.bottom + window.scrollY + 8 + "px";
      pop.querySelector(".info-close").addEventListener("click", close);
      return;
    }
    if (pop && !e.target.closest(".info-pop")) close();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  window.addEventListener("hashchange", close);
}
