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
  trends: { name: "구글 트렌드 한국 급상승 검색어", url: "https://trends.google.com/trending?geo=KR", how: "trends.google.com/trending/rss?geo=KR 의 급상승 검색어와 대략 검색량" },
  admin: { name: "사이트 관리자 작성", url: null, how: "관리자 메뉴에서 등록한 글 (GitHub 저장소 data/board.json)" },
};

const NOVIEW = "조선일보·동아일보·중앙일보·데일리안처럼 네이버가 랭킹 조회수를 공개하지 않는 매체는 0이 아니라 ‘미공개’로 보고 합계·점유율·순위에서 뺍니다.";
const TODAY = "오늘 날짜의 랭킹은 하루가 끝날 때까지 계속 바뀝니다. 자정 이후 수집분부터 확정값으로 봅니다.";
const NAVER_ONLY = "조회수는 네이버 뉴스 안에서 읽힌 횟수입니다. 자사 홈페이지·구글·다음 등 다른 경로 조회는 포함되지 않습니다.";
const GAPS = "수집되지 않은 날은 0으로 치지 않고 비워 둡니다. 직전 기간 대비 증감은 수집된 날의 하루 평균끼리 비교합니다.";

const PUB_NOTE = "발행 수: 헬스조선·코메디닷컴 등 11곳은 기사마다 확인해 오늘까지 정확. 나머지 매체는 네이버 목록으로 세는데, 최근 며칠은 목록에 ‘3일전’처럼 나와 날짜가 확정되는 대로(3시간마다) 채워집니다.";
export const INFO = {
  pubTotal: { t: "전체 발행 기사", src: ["list", "article"], calc: "선택 기간에 발행된 기사 수의 합. 기사 날짜는 상세페이지 입력시각(한국시간) 기준이며, 같은 기사는 한 번만 셉니다.", note: [PUB_NOTE, GAPS, "발행목록 수집 매체만 포함합니다 (사이드바 하단 참고)."] },
  rankViews: { t: "랭킹 조회수 합", src: ["ranking"], calc: "선택 기간 동안 조회수를 공개하는 매체들의 랭킹 상위 20건 조회수를 모두 더한 값.", note: [NAVER_ONLY, NOVIEW, TODAY, "랭킹 20위 밖 기사의 조회수는 포함되지 않습니다."] },
  ourViews: { t: "우리 매체 랭킹 조회수", src: ["ranking"], calc: "우리 매체 랭킹 상위 20건 조회수의 합. 점유율 = 우리 조회수 ÷ 조회수 공개 매체 전체 합. 순위는 조회수 공개 매체 중 순위.", note: [NAVER_ONLY, TODAY, GAPS] },
  ourPub: { t: "매체 발행 기사", src: ["list", "article"], calc: "선택한 기간에 그 매체가 발행한 기사 수의 합계입니다(하루를 고르면 그날, 7일이면 7일 합계). 일평균 = 합계 ÷ 발행목록이 수집된 날 수. % = 직전 동일 기간(같은 길이의 바로 앞 기간) 합계 대비 증감이며, 두 기간의 수집일 수가 다르면 하루 평균끼리 비교합니다.", note: [PUB_NOTE, "기사 날짜는 상세페이지 입력시각(한국시간) 기준이며, 같은 기사는 한 번만 셉니다."] },
  trend: { t: "일별 추이", src: ["ranking", "list", "article"], calc: "기본 보기는 헬스조선·코메디닷컴 날짜별 발행 기사 수 비교(막대 + 표)입니다. ‘발행 기사수’·‘랭킹 조회수’ 탭은 매체 설정에서 고른 매체를 날짜별 선으로, ‘발행 + 조회수’는 한 매체의 발행(막대)과 랭킹 조회수(선)를 겹쳐 보여줍니다. 수집되지 않은 날은 비워 둡니다.", note: [PUB_NOTE, NOVIEW, TODAY] },
  mediaRank: { t: "매체별 랭킹 조회수", src: ["ranking"], calc: "매체별 랭킹 상위 20건 조회수 합을 큰 순서로 정렬. 증감은 직전 동일 기간의 하루 평균 대비.", note: [NOVIEW, NAVER_ONLY] },
  kwTitle: { t: "기사 제목 키워드", src: ["ranking", "list"], calc: "기사 제목을 단어로 나눈 뒤 조사·불용어·숫자를 빼고 셉니다. 한 제목에 같은 단어가 여러 번 나와도 1회. 종합점수 = 발행 기사 수 + 랭킹 진입 수 × 3.", note: ["랭킹 기사당 조회 = 랭킹 20위 안에 든 그 키워드 기사 1건당 평균 조회수.", "검색량이 아니라 ‘기사 제목에 얼마나 쓰였나’를 나타냅니다.", "형태소 분석기가 아닌 규칙 기반이라 ‘높이’, ‘넘어’ 같은 단어가 섞일 수 있습니다.", "기간이 길면 일별 상위 250개 키워드를 합산합니다."] },
  kwRising: { t: "급상승 키워드", src: ["ranking", "list"], calc: "종합점수가 직전 동일 기간보다 20% 이상 늘어난 키워드(점수 4 이상). NEW는 직전 기간에 없던 키워드. 발행 수와 랭킹 진입 수를 각각 하루 평균으로 바꿔 비교하고, 두 기간 모두 수집된 항목만 씁니다(예: 앞 기간에 발행목록이 없으면 랭킹만 비교). 직전 기간 자료가 없으면 선택 기간을 앞·뒤 절반으로 나눠 비교합니다.", note: [GAPS] },
  kwDetail: { t: "키워드 상세", src: ["ranking", "list", "searchad"], calc: "제목에 이 키워드가 들어간 기사들을 매체·날짜별로 모은 것. 함께 쓰인 키워드는 같은 제목에 함께 나온 횟수(랭킹 기사는 3배 가중).", note: ["네이버 검색량은 검색광고 API가 연결된 경우에만 표시됩니다."] },
  topArticles: { t: "랭킹 상위 기사", src: ["ranking", "article"], calc: "선택 기간 매체 설정에서 고른 매체의 랭킹 기사를 매체와 상관없이 조회수 높은 순으로 1위부터 매깁니다. 매체 옆 숫자는 그 매체 랭킹 안의 순위입니다. 조회수를 공개하지 않는 매체는 빠집니다.", note: [NOVIEW, NAVER_ONLY] },
  notice: { t: "공지사항", src: ["admin"], calc: "관리자가 등록한 공지 중 게시 기간 안에 있는 글.", note: [] },
  mediaTable: { t: "매체별 성과표", src: ["ranking", "list", "article"], calc: "점유율 = 매체 조회수 ÷ 조회수 공개 매체 합. 랭킹 기사 평균 = 조회수 합 ÷ 랭킹 기사 수. 1위 평균 = 날마다 1위 기사 조회수의 평균.", note: [PUB_NOTE, NOVIEW, "발행 기사 수는 그 매체가 네이버에 송고한 전체 기사 수입니다. 일부 날짜만 수집된 매체는 ‘n/m일 수집’으로 표시됩니다."] },
  mediaCombo: { t: "랭킹 조회수 vs 발행량", src: ["ranking", "list"], calc: "막대는 매체별 랭킹 조회수 합, 선은 같은 기간 발행 기사 수.", note: [PUB_NOTE, NOVIEW] },
  weekday: { t: "주간·월간 랭킹 조회수 합", src: ["ranking", "list"], calc: "매체마다 하루 랭킹 조회수 합(그날 상위 20건 조회수를 더한 값). 주간은 고른 주의 월요일~일요일 7일을 날짜별로, 월간은 고른 달을 주(월~일) 단위로 더해 보여줍니다. 위쪽 조회 기간과 별도로 ◀ ▶ 또는 날짜를 골라 바꿉니다.", note: ["‘수집 전’ 표시가 있는 날은 아직 데이터가 없습니다.", "월간의 첫 주·마지막 주는 그 달에 속한 날만 더합니다."] },
  heatmap: { t: "발행 시간대 히트맵", src: ["list", "article"], calc: "기사 상세페이지 입력시각의 ‘시’ 기준으로 매체별 발행 건수를 셉니다. 진할수록 그 매체 안에서 많은 시간대.", note: ["입력시각이 확인되지 않은 기사는 빠집니다."] },
  articles: { t: "기사 목록", src: ["ranking", "list", "article"], calc: "랭킹 기사: 선택 매체의 랭킹(상위 20건) 기사를 조회수 순으로 전체 순위를 매깁니다(조회수 미공개 매체 제외). 발행 기사: 헬스조선·코메디닷컴이 발행한 기사(상세페이지 입력시각·기자명).", note: [NOVIEW, "전체 발행 기사 목록은 31일 이하 기간에서 볼 수 있습니다."] },
  insightSummary: { t: "이번 기간 요약", src: ["ranking", "list", "article"], calc: "아래 그래프들의 결과에서 가장 큰 값을 골라 문장으로 만든 것입니다.", note: ["상관관계이지 인과관계가 아닙니다. 기간이 짧거나 기사 수가 적으면 참고만 하세요.", NOVIEW] },
  insightHour: { t: "발행 시간대별 반응", src: ["ranking", "list", "article"], calc: "막대: 시간대별 전체 발행 기사 수. 선: 그 시간에 입력된 랭킹 기사들의 평균 조회수(기사 2건 이상인 시간만).", note: ["랭킹 기사의 입력시각은 상세페이지에서 확인된 경우에만 포함됩니다.", NOVIEW] },
  insightWeekday: { t: "요일별 반응", src: ["ranking", "list"], calc: "요일마다 하루 평균 발행 기사 수, 그리고 하루 랭킹 조회수 합(상위 20건 합계)의 요일 평균.", note: ["기간이 짧으면 요일당 표본이 적습니다."] },
  titlePattern: { t: "제목 패턴별 성과", src: ["ranking"], calc: "랭킹 기사 제목을 규칙으로 분류합니다. 숫자 포함, N가지·N개, 물음표, 따옴표, 말줄임(…), [대괄호] 머리표, 호기심어(이것·이유·비결·정체·방법·진짜·충격·알고 보니·뜻밖), 느낌표. 조회수 차이 = 그 패턴이 있는 기사 평균 ÷ 없는 기사 평균 − 1.", note: ["조회수 미공개 매체 기사는 빠집니다.", "회색 막대는 전체 발행 기사 중 그 패턴 비율입니다(31일 이하 기간)."] },
  titleLength: { t: "제목 길이별 평균 조회수", src: ["ranking"], calc: "랭킹 기사 제목 글자 수(공백 포함) 구간별 평균 조회수. 괄호 안 숫자는 기사 수.", note: ["조회수 미공개 매체 기사는 빠집니다."] },
  reporters: { t: "기자 통계", src: ["article", "ranking", "list"], calc: "기사 상세페이지 바이라인의 기자명 기준으로 기사 원본에서 직접 계산합니다. 발행 = 기간 내 발행 기사 수, 랭킹 진입 = 매체별 랭킹 20위 안에 든 서로 다른 기사 수(같은 기사가 여러 날 올라도 1건), 1위 = 그날 매체 랭킹 1위 횟수, 취합 조회수 합계 = 매체별 랭킹 상위 20건에 오른 그 기자 기사의 조회수 합, 최고 조회수 = 그 기자 기사 중 가장 높은 랭킹 조회수, 진입률 = 기간 중 발행한 기사 가운데 매체 랭킹 20위 안에 든 기사 수 ÷ 기간 발행 기사 수 (최고 100%). 발행 당일~다음 2일 랭킹까지 확인합니다. 발행 = 기간 안에 발행된 그 기자 기사 수로, 랭킹에 오른 기사도 모두 포함.", note: ["공동 기자 기사(‘홍길동·김철수’)는 각 기자의 발행·랭킹 진입·조회수에 모두 포함됩니다.", "기자명이 없는 기사(사설, 통신 전재 등)는 빠집니다.", "랭킹은 93일, 발행은 31일보다 긴 기간이면 일별 요약값으로 계산합니다.", "과거 엑셀에서 가져온 기사는 ‘기자명 채우기’를 해야 기자명이 들어갑니다."] },
  repViews: { t: "취합 조회수 합계", src: ["ranking", "article"], calc: "선택 기간에 이 기자의 기사가 네이버 매체별 랭킹(상위 20건)에 올랐던 날마다, 그날 랭킹에 표시된 조회수를 모두 더한 값입니다. 기사 한 건이 여러 날 랭킹에 오르면 날마다의 조회수가 각각 더해집니다.", note: ["기사의 '전체 누적 조회수'가 아니라 사이트가 수집한 랭킹 조회수의 합입니다. 랭킹 20위 밖으로 밀린 뒤의 조회수, 랭킹에 오르지 못한 기사의 조회수는 들어가지 않습니다.", "공동 바이라인 기사는 함께 쓴 기자 모두에게 같은 조회수가 더해집니다.", "조회수를 공개하지 않는 매체(조선일보 등)는 '미공개'로 표시됩니다."] },
  repRank: { t: "랭킹 진입", src: ["ranking", "article"], calc: "네이버 매체별 일별 랭킹(매일 상위 20건)에 이 기자의 기사가 오른 서로 다른 기사 수입니다. 같은 기사가 여러 날 랭킹에 올라도 1건으로 셉니다.", note: ["랭킹은 하루 단위라, 기간 시작 전에 발행된 기사가 기간 중 랭킹에 오르면 랭킹 진입에는 들어가지만 이 기간 발행 수에는 들어가지 않습니다.", "공동 바이라인 기사는 함께 쓴 기자 모두에게 1건씩 들어갑니다.", "‘발행 중 20위 진입’은 이 기간에 발행한 기사 가운데 랭킹에 오른 기사 수(발행 다음 2일 랭킹까지 확인)로, 진입률 계산에 씁니다."] },
  repPub: { t: "발행", src: ["article", "ranking"], calc: "기간 중 기사 상세페이지 바이라인에서 이 기자 이름이 확인된 기사 수 + 기간 중 발행돼 랭킹에 오른 이 기자의 기사(중복 제외).", note: ["‘일부’ 표시: 이 매체의 발행목록(기자명) 수집이 아직 안 된 날이 있어 그날은 랭킹에 오른 기사만 셌습니다. 수집이 끝나면 자동으로 채워집니다.", "진입률은 발행목록이 수집된 날의 기사만으로 계산해 100%를 넘지 않습니다."] },
  repRate: { t: "랭킹 진입률 1위 기자", src: ["article", "ranking"], calc: "기간 중 발행한 기사 가운데 매체 랭킹 20위 안에 든 기사 비율이 가장 높은 기자입니다 (발행 다음 2일 랭킹까지 확인). 발행 5건 이상인 기자만 비교하고, 같으면 발행이 많은 기자가 앞섭니다.", note: ["많이 쓰는 기자보다 '쓴 기사가 잘 읽히는' 기자를 찾는 지표입니다."] },
  repAvg: { t: "기사당 평균 조회수 1위 기자", src: ["ranking"], calc: "취합 조회수 합계 ÷ 랭킹에 오른 횟수. 랭킹에 3번 이상 오른 기자만 비교합니다.", note: ["한 번 크게 터진 기사 하나로 순위가 뒤집히지 않도록 3건 이상 기준을 둡니다.", "랭킹 조회수 기준이라 랭킹 밖 기사는 들어가지 않습니다."] },
  searchNaver: { t: "네이버 검색량 랭킹", src: ["searchad", "list", "ranking"], calc: "최근 30일 PC + 모바일 실제 검색 횟수 (10회 미만은 5로 표시). 대상: 관심 키워드(설정), 그날 기사 제목 상위 키워드, 그 연관검색어.", note: ["검색량은 하루 한 번 조회한 최근 30일 값이라 선택 기간과 정확히 맞지 않습니다.", "광고 경쟁은 검색광고 입찰 경쟁 정도로, 상업성이 높은 키워드일수록 ‘높음’입니다.", "네이버 검색광고 API 키가 있어야 수집됩니다 (무료)."] },
  googleTrends: { t: "급상승 검색어", src: ["trends"], calc: "구글 트렌드 한국의 급상승 검색어(RSS + ‘지금 뜨는 검색어’ 최근 24시간 목록)를 30분마다 받아 하루 단위로 모읍니다. 검색량 순 TOP 200까지 보여주며, 숫자는 구글이 알려주는 대략치(예: 20,000+)입니다.", note: ["네이버는 실시간 급상승 검색어를 2021년에 종료해 제공하지 않습니다.", "‘선택 매체 발행’ = 선택 기간에 선택 매체 기사 제목에 그 검색어가 들어간 기사 수."] },
  readHour: { t: "독자가 많이 읽은 시간대", src: ["ranking"], calc: "네이버 언론사 랭킹의 ‘오늘’ 조회수는 하루 누적이 아니라 최근 약 1시간 동안 읽힌 수로 수시로 바뀝니다(지난 날짜를 열면 하루 합계). 수집기가 30분마다 이 값을 기록해 두고, 하루가 끝나면(다음 날) 각 기록을 ‘직전 1시간’의 가운데 30분 칸에 30분치(÷2)로 넣어 30분 단위 시간대 통계로 확정합니다. 기간 평균은 칸마다 측정된 날 수로 나눈 하루 평균입니다.", note: ["오늘 기록은 아직 쌓는 중이라 내일 반영됩니다. 하루 48칸 중 24칸 이상 측정된 날만 넣습니다.", "네이버가 새벽(대략 2~6시)에 랭킹을 갱신하지 않거나 수집이 빠진 시간은 추정으로 채우지 않고 빈 칸으로 둡니다.", "매체별 랭킹 상위 20건의 조회수 기준이라 전체 기사 조회수가 아니라 상위 기사에 몰린 읽기의 흐름입니다. 갱신 시점 차이로 ±30분 정도 어긋날 수 있습니다.", NOVIEW] },
  coverage: { t: "수집 범위", src: ["ranking", "list"], calc: "", note: ["이 사이트의 합계·점유율·순위는 수집하는 매체끼리 비교한 값이며, 네이버 전체 언론사 기준이 아닙니다.", "수집 매체는 collector/config.json 에서 바꿀 수 있습니다."] },
  reporterCoverage: { t: "기자명 확인 비율", src: ["article"], calc: "기사 상세페이지에서 기자명을 찾은 기사의 비율. 본문 바이라인(예: ‘(서울=뉴스1) 홍길동 기자 =’, ‘홍길동 기자 이메일’)과 기사 정보에서 찾습니다.", note: ["사설·칼럼·통신 전재 기사처럼 기자명이 없는 기사는 빠집니다.", "매체 이름(헬스조선 등)은 기자명으로 세지 않습니다."] },
  status: { t: "수집 상태", src: ["ranking", "list"], calc: "GitHub Actions가 30분마다(3시간마다 전체) 수집기를 실행한 기록.", note: ["실패한 매체는 기존 데이터를 지우지 않고 그대로 둡니다."] },
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
