# 뉴스 인사이트 (Editorial Intelligence)

네이버 언론사 **랭킹 기사**와 매체별 **전체 발행 기사**를 자동으로 모아, 기자가 기사 쓰는 데 바로 쓸 수 있는 통계를 보여주는 사이트입니다.
GitHub 하나로 돌아갑니다 — 서버 비용 없음.

```
GitHub Actions (30분마다(3시간마다 전체, 매일 07:30 강제 전체))          GitHub 저장소 (= 데이터베이스)          GitHub Pages (사이트)
 collector/collect.py   ──커밋──▶   data/ranking/날짜.json        ──배포──▶  index.html
  · 랭킹 10개 매체                  data/articles/날짜.json                   · 시장현황 · 키워드 랭킹
  · 발행목록 7개 매체               data/summary/월.json (집계)                · 매체비교 · 기사목록
                                    data/board.json  ◀──관리자 화면──        · 작성 인사이트 · 기자통계
                                    data/uploads/ (배너 이미지)               · 공지·배너·게시판
```

## 화면 구성

| 메뉴 | 내용 |
|---|---|
| 시장 현황 | 기간 KPI(직전 동일기간 대비 증감), 매체별 일별 추이, 랭킹 조회수 순위, 많이 다룬/급상승 키워드, 공지, 랭킹 상위 기사, 수집 상태 |
| 키워드 랭킹 | 제목 키워드별 발행량·랭킹 진입·조회수·추이. 정렬: 종합 / 조회수 / 발행량 / **급상승** / **기회**(적게 쓰였는데 많이 읽힌 주제). 키워드를 누르면 일별 추이, 매체별 현황, 함께 쓰인 키워드, 많이 읽힌 기사 |
| 키워드 랭킹 › 검색 키워드 | **네이버 월간 검색량 랭킹**(관심 키워드·기사 제목 키워드·연관검색어, PC/모바일, 광고 경쟁도)과 기간 내 발행량 비교 → **기사 부족**(많이 찾는데 기사가 적은 주제) 정렬. **구글 트렌드 한국 급상승 검색어** 누적 랭킹과 관련 뉴스 |
| 매체 비교 | 발행·조회수·점유율·랭킹 기사 평균·1위 평균·효율(조회수÷발행), 요일별 성과, 발행 시간대 히트맵 |
| 기사 목록 | 랭킹/전체 발행 기사 검색(공백=AND)·매체 필터·정렬·엑셀 저장 |
| 작성 인사이트 | 잘 읽힌 발행 시간대·요일, 제목 패턴(숫자, 질문형, 따옴표, 말줄임, [머리표] 등)별 조회수 차이, 제목 길이별 성과, 자동 요약 문장 |
| 기자 통계 | 기자별 발행·랭킹 진입·조회수·진입률 |
| 공지·게시판 | 공지/배너/게시글. 상단 공지줄과 배너를 누르면 해당 게시글로 이동 |
| 관리자 | GitHub 계정으로 로그인 → 글 작성·수정·숨김·삭제, 배너 이미지 업로드, 게시 기간 예약, 수집 수동 실행 |

모든 분석 화면은 상단의 **기간 버튼(어제·7일·30일·이번 달·지난 달·분기·올해)** 또는 **날짜 입력 + 조회** 버튼으로 같은 기간을 공유합니다. 기간은 주소(URL)에 저장되므로 링크를 공유하면 같은 화면이 열립니다. **보고서 엑셀**은 요약·일별·매체별·키워드·랭킹기사·기자 시트를 한 파일로 내려받습니다.

## 기존 노트북 대비 고친 점

- **날짜 오류**: 모든 날짜를 한국시간 기준으로 계산합니다(GitHub 서버는 UTC라 하루씩 밀리던 문제). 기사 날짜는 상세페이지 입력시각으로 확정하고, 목록의 다른 날짜 기사는 실제 날짜 파일로 옮깁니다.
- **중복/병합**: 기사 고유키(언론사코드+기사번호)로 병합 → 여러 번 수집하거나 과거 엑셀을 다시 가져와도 중복되지 않습니다.
- **속도**: 상세페이지 결과를 캐시해서 두 번째 수집부터는 새 기사만 확인합니다. 화면은 월별 요약 파일만 읽어 1년치도 빠르게 그립니다.
- **누락 방지**: 어떤 매체 수집이 실패해도 기존 데이터를 지우지 않고, 실패 내역을 화면(수집 상태)에 표시합니다. 오늘 날짜 랭킹은 ‘집계 중’으로 구분합니다.
- **조회 0 문제**: 이전 사이트처럼 업로드한 파일 종류에 따라 칸이 비지 않도록, 랭킹·발행 데이터를 각각 날짜별로 누적하고 화면에 “랭킹 n/n일 · 발행 n/n일 수집됨”을 항상 보여줍니다.

---

## 설치 (처음 한 번, 약 10분)

### 1. 저장소 만들기
- 관리자 3~4명이 함께 쓸 예정이면 **무료 Organization**을 하나 만들고 그 아래에 저장소를 만드는 것을 추천합니다(관리자 토큰 발급이 쉬움).
- 저장소는 **Public**으로 만드세요(무료 GitHub Pages 조건). 수집 데이터는 네이버에 공개된 정보입니다.
- 이 폴더의 파일을 모두 올립니다 (`.github` 폴더, `.nojekyll` 파일 포함).

```bash
git init && git add . && git commit -m "뉴스 인사이트"
git branch -M main
git remote add origin https://github.com/<조직또는아이디>/<저장소>.git
git push -u origin main
```

### 2. 저장소 설정
1. **Settings → Pages → Build and deployment → Source: `GitHub Actions`**
2. **Settings → Actions → General → Workflow permissions: `Read and write permissions`** 선택 후 Save
3. 주소는 `https://<조직또는아이디>.github.io/<저장소>/` 입니다.

### 3. 첫 수집 (과거 데이터 채우기)
**Actions → 뉴스 수집 → Run workflow** 에서 시작일/종료일을 넣고 실행합니다. 처음에는 한 번에 **7~31일** 단위로 나눠 돌리는 것을 권장합니다(상세페이지를 모두 확인하므로 시간이 걸립니다). 이후에는 30분마다(3시간마다 전체, 매일 07:30 강제 전체) 자동으로 어제~오늘을 갱신합니다.

### 4. 관리자 등록 (3~4명)
1. **Settings → Collaborators (Organization이면 Members/Teams)** 에서 관리자를 초대하고 Write 권한을 줍니다.
2. 특정 사람만 관리자로 제한하려면 `assets/js/config.js` 의 `admins: ["github아이디1", "아이디2"]` 를 채웁니다.
3. 각 관리자는 사이트 **관리자** 메뉴의 안내대로 토큰을 만들어 로그인합니다.
   - Organization 저장소: Fine-grained 토큰 (Contents·Actions: Read and write)
   - 개인 계정 저장소에 초대된 경우: Classic 토큰 (`public_repo`, `workflow`)
4. 글을 저장하면 저장소의 `data/board.json` 에 커밋되고, 1~2분 뒤 사이트 전체에 반영됩니다. 여러 관리자가 동시에 저장해도 서로 덮어쓰지 않도록 최신본에 다시 적용해 저장합니다. 변경 이력은 GitHub 커밋 기록에 남습니다.

### 5. 네이버 검색량 켜기 (선택, 무료)
1. [네이버 검색광고](https://searchad.naver.com) 가입 → 도구 → **API 사용 관리**에서 API 키 발급 (광고비를 쓰지 않아도 발급됩니다)
2. GitHub 저장소 **Settings → Secrets and variables → Actions → New repository secret** 으로 3개 등록
   - `NAVER_AD_API_KEY` (액세스라이선스), `NAVER_AD_SECRET` (비밀키), `NAVER_AD_CUSTOMER_ID` (CUSTOMER_ID)
3. 다음 자동 수집부터 검색 키워드 탭에 검색량이 표시됩니다. 조회 대상은 `collector/config.json` 의 `search_seeds`(관심 키워드) + 그날 기사 제목 상위 40개 키워드와 각각의 연관검색어입니다.

구글 급상승 검색어는 키 없이 자동 수집됩니다.

### 6. 설정 바꾸기
- `collector/config.json`
  - `ranking_media`: 랭킹 수집 매체 (네이버 언론사 코드)
  - `publish_media`: 전체 발행목록 수집 매체 (매체가 많을수록 수집 시간이 늘어납니다)
  - `our_media`: 우리 매체 (화면에서 주황색으로 강조)
  - 새 매체는 `media` 에 `"코드": "이름"` 을 추가합니다. 코드는 `media.naver.com/press/코드` 에서 확인.
- `assets/js/config.js`: 사이트 이름, 관리자 목록, 커스텀 도메인 사용 시 `repo: "조직/저장소"`
- 수집 주기: `.github/workflows/collect.yml` 의 `cron`

---

## 기존 엑셀 자료 가져오기

Colab 노트북으로 만든 엑셀(랭킹 파일, `*_상세` 시트가 있는 발행 파일)을 그대로 이관할 수 있습니다.

```bash
pip install -r collector/requirements.txt
python collector/import_excel.py 네이버_랭킹뉴스_*.xlsx 헬스조선_코메디닷컴_*.xlsx
git add data && git commit -m "과거 자료 이관" && git push
```

엑셀에는 기자명이 없으므로, 가져온 뒤 아래 명령으로 기자명을 채울 수 있습니다(기사 페이지를 하나씩 확인, 이미 확인한 기사는 건너뜀).

```bash
python collector/fill_reporters.py                       # 전체
python collector/fill_reporters.py --only ranking        # 랭킹 기사만 (빠름)
```

조선·동아·중앙·데일리안처럼 네이버 랭킹에 조회수를 공개하지 않는 매체는 조회수 0이 아니라 **미공개**로 처리해 합계·점유율에서 제외합니다.

## 내 PC에서 직접 수집하기

```bash
pip install -r collector/requirements.txt
python collector/collect.py                                   # 어제~오늘
python collector/collect.py --start 2026-09-01 --end 2026-09-30
python collector/collect.py --only ranking                     # 랭킹만
python collector/collect.py --media 346,296 --only publish     # 특정 매체 발행목록만
git add data && git commit -m "수집" && git push
```

> **참고**: GitHub Actions 서버는 해외에 있습니다. 만약 네이버가 해외 접속을 막아 수집 경고(0건)가 반복되면, 사무실 PC에서 위 명령을 작업 스케줄러로 돌리고 push 하는 방식으로 바꾸면 됩니다. 화면과 관리자 기능은 그대로 쓸 수 있습니다.

## 데이터 기준

- **랭킹 조회수**: 네이버 언론사별 랭킹 페이지(상위 20건)에 표시된 값. 오늘 날짜는 하루가 끝날 때까지 바뀌며 자정 이후 수집분부터 확정값입니다.
- **발행 기사**: news.naver.com 언론사별 기사목록 + 기사 상세페이지 입력시각(KST).
- **검색량**: 네이버 검색광고 API의 최근 30일 PC·모바일 검색수(10회 미만은 5로 표시). 하루 1회 조회.
- **급상승 검색어**: 구글 트렌드 한국 RSS(대략치). 네이버 실시간 검색어는 2021년 서비스 종료로 제공되지 않습니다.
- **키워드**: 제목에서 조사·불용어를 뺀 단어 빈도(종합점수 = 발행수 + 랭킹진입×3). 검색량과는 다른 지표입니다. 기간이 길면 일별 상위 250개 키워드를 합산합니다.
- **기간 제한**: 기사 단위 전체 목록은 31일(랭킹은 93일) 이하 기간에서 제공. 그보다 긴 기간은 요약 통계와 일별 상위 30개 랭킹 기사로 보여줍니다.

## 파일 구조

```
index.html                 사이트 (한 페이지 앱)
assets/css/style.css
assets/js/
  config.js                사이트 설정
  main.js                  라우팅·기간 필터·보고서 엑셀
  data.js                  데이터 로딩·기간 집계
  views.js                 분석 화면 6종
  board.js                 공지·배너·게시판
  admin.js                 관리자 (GitHub API)
  charts.js / util.js
collector/
  collect.py               수집기
  store.py                 저장·병합·키워드·요약 빌드
  search.py                검색 키워드 (구글 급상승 + 네이버 검색량)
  import_excel.py          과거 엑셀 이관
  config.json              매체 설정
data/                      수집 데이터 (자동 생성)
tools/make_demo_data.py    화면 테스트용 가짜 데이터 (실제 저장소에서는 실행 금지)
.github/workflows/
  collect.yml              30분마다(3시간마다 전체, 매일 07:30 강제 전체) 수집 + 배포
  deploy.yml               관리자 글 저장/코드 수정 시 배포
```
