/**
 * 길동무 버스 프록시 워커
 *  - 공공데이터 API의 serviceKey를 서버에서 주입 (앱에 키가 노출되지 않음)
 *  - TAGO / 서울 TOPIS / 경기 GBIS 도메인만 허용
 *  - XML·JSON 응답을 그대로 전달 (앱이 text로 받아 파싱)
 *
 * 사용법:  GET /tago?url=<인코딩된 원본 API URL>
 * 예시:    /tago?url=http%3A%2F%2Fws.bus.go.kr%2Fapi%2Frest%2Farrive%2FgetArrInfoByUid%3FarsId%3D02123
 */

const ALLOWED_HOSTS = [
  'apis.data.go.kr',    // TAGO(국토부), 경기 GBIS, 소상공인 상가정보
  'api.odcloud.kr',     // 일부 data.go.kr 신규 API
  'ws.bus.go.kr',       // 서울 TOPIS (버스도착·정류소)
  'openapi.gbis.go.kr', // 경기 GBIS 예비 엔드포인트
  'apis.data.go.kr.'    // 끝에 점이 붙는 변형 방어
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
};

function hostAllowed(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  return ALLOWED_HOSTS.some(a => h === a.replace(/\.$/, ''));
}


/* ══════════════════════════════════════════════════════════════
 * 📰 뉴스 수집·제공
 *   왜 서버에서 하나:
 *     앱이 기기마다 70개 피드를 CORS 프록시로 긁으면 느리고 자주 실패한다.
 *     서버가 정기적으로 한 번 모아 D1에 넣어두면 앱은 한 번만 받아가면 된다.
 *   중복 방지: link 를 PRIMARY KEY 로 두고 INSERT OR IGNORE
 *   자동 삭제: 매일 새벽, 보관 기간이 지난 기사 제거
 * ══════════════════════════════════════════════════════════════ */

const NEWS_FEEDS = {
  '증시': [
    'https://news.google.com/rss/search?q=%EC%BD%94%EC%8A%A4%ED%94%BC%20%EC%BD%94%EC%8A%A4%EB%8B%A5%20%EC%A6%9D%EC%8B%9C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A3%BC%EC%8B%9D%EC%8B%9C%EC%9E%A5%20%EC%99%B8%EA%B5%AD%EC%9D%B8%20%EC%88%9C%EB%A7%A4%EC%88%98%20%EA%B3%B5%EB%AA%A8%EC%A3%BC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%89%B4%EC%9A%95%EC%A6%9D%EC%8B%9C%20%EB%82%98%EC%8A%A4%EB%8B%A5%20%EB%8B%A4%EC%9A%B0%EC%A7%80%EC%88%98+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%AF%B8%EA%B5%AD%EC%A6%9D%EC%8B%9C%20%EC%9B%94%EA%B0%80%20S%26P500+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A6%9D%EA%B6%8C%EC%82%AC%20%EB%AA%A9%ED%91%9C%EC%A3%BC%EA%B0%80%20%EC%8B%A4%EC%A0%81%EB%B0%9C%ED%91%9C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B0%B0%EB%8B%B9%20%EC%9E%90%EC%82%AC%EC%A3%BC%20%EC%86%8C%EA%B0%81+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%83%81%EC%9E%A5%EA%B8%B0%EC%97%85%20%EC%9D%B8%EC%88%98%ED%95%A9%EB%B3%91+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A6%9D%EC%8B%9C%20%EC%A0%84%EB%A7%9D%20%EB%A6%AC%ED%8F%AC%ED%8A%B8+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B0%9C%EC%9D%B8%20%EA%B8%B0%EA%B4%80%20%EB%A7%A4%EB%A7%A4%EB%8F%99%ED%96%A5+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B9%84%ED%8A%B8%EC%BD%94%EC%9D%B8%20%EA%B0%80%EC%83%81%EC%9E%90%EC%82%B0%20%EC%8B%9C%EC%84%B8+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ],
  '경제': [
    'https://news.google.com/rss/search?q=%ED%99%98%EC%9C%A8%20%EC%9B%90%EB%8B%AC%EB%9F%AC%20%EA%B8%B0%EC%A4%80%EA%B8%88%EB%A6%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%AC%BC%EA%B0%80%20%EC%86%8C%EB%B9%84%EC%9E%90%EB%AC%BC%EA%B0%80%20%EC%9D%B8%ED%94%8C%EB%A0%88%EC%9D%B4%EC%85%98+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B6%80%EB%8F%99%EC%82%B0%20%EC%95%84%ED%8C%8C%ED%8A%B8%20%EC%A0%84%EC%84%B8%20%EB%B6%84%EC%96%91+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%88%98%EC%B6%9C%20%EB%AC%B4%EC%97%AD%EC%88%98%EC%A7%80%20%EA%B2%BD%EC%83%81%EC%88%98%EC%A7%80+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B3%A0%EC%9A%A9%20%EC%B7%A8%EC%97%85%EC%9E%90%20%EC%8B%A4%EC%97%85%EB%A5%A0%20%EC%9E%84%EA%B8%88+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%86%8C%EB%B9%84%20%EB%82%B4%EC%88%98%20%EA%B2%BD%EA%B8%B0+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B8%88%EC%9C%B5%EA%B6%8C%20%EB%8C%80%EC%B6%9C%20%EA%B8%88%EB%A6%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%84%B8%EA%B8%88%20%EC%97%B0%EB%A7%90%EC%A0%95%EC%82%B0%20%EC%A0%95%EC%B1%85+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%9B%90%EC%9E%90%EC%9E%AC%20%EC%9C%A0%EA%B0%80%20%EA%B5%AD%EC%A0%9C%EC%9C%A0%EA%B0%80+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B8%B0%EC%97%85%20%EC%8B%A4%EC%A0%81%20%EB%A7%A4%EC%B6%9C%20%EC%98%81%EC%97%85%EC%9D%B4%EC%9D%B5+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ],
  '사회': [
    'https://news.google.com/rss/search?q=%EC%82%AC%EA%B1%B4%EC%82%AC%EA%B3%A0%20%EA%B2%BD%EC%B0%B0%20%ED%99%94%EC%9E%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B5%90%ED%86%B5%EC%82%AC%EA%B3%A0%20%EC%A7%80%ED%95%98%EC%B2%A0%20%EB%B2%84%EC%8A%A4%20%EC%82%AC%EA%B3%A0+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B2%95%EC%9B%90%20%ED%8C%90%EA%B2%B0%20%EA%B2%80%EC%B0%B0%20%EC%88%98%EC%82%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%82%A0%EC%94%A8%20%EA%B8%B0%EC%83%81%EC%B2%AD%20%ED%83%9C%ED%92%8D%20%ED%8F%AD%EC%97%BC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B5%90%EC%9C%A1%20%ED%95%99%EA%B5%90%20%EB%8C%80%ED%95%99%20%EC%9E%85%EC%8B%9C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A7%80%ED%95%98%EC%B2%A0%20%EB%B2%84%EC%8A%A4%20%EA%B5%90%ED%86%B5%20%EC%A0%95%EC%B1%85+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B3%91%EC%9B%90%20%EC%9D%98%EB%A3%8C%20%EA%B1%B4%EA%B0%95%EB%B3%B4%ED%97%98+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%95%84%ED%8C%8C%ED%8A%B8%20%EC%9E%AC%EA%B0%9C%EB%B0%9C%20%EC%A3%BC%EB%AF%BC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%ED%99%98%EA%B2%BD%20%EB%AF%B8%EC%84%B8%EB%A8%BC%EC%A7%80%20%EC%9E%AC%ED%99%9C%EC%9A%A9+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B3%B5%EC%A7%80%20%EC%97%B0%EA%B8%88%20%EC%A7%80%EC%9B%90%EA%B8%88+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ],
  '정치': [
    'https://news.google.com/rss/search?q=%EA%B5%AD%ED%9A%8C%20%EB%B3%B8%ED%9A%8C%EC%9D%98%20%EB%B2%95%EC%95%88%20%EC%B2%98%EB%A6%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%8C%80%ED%86%B5%EB%A0%B9%EC%8B%A4%20%EC%A0%95%EB%B6%80%20%EC%A0%95%EC%B1%85%20%EB%B0%9C%ED%91%9C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%97%AC%EC%95%BC%20%EB%8C%80%ED%91%9C%20%EC%A0%95%EC%B9%98%EA%B6%8C%20%EA%B3%B5%EB%B0%A9+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%84%A0%EA%B1%B0%20%EC%97%AC%EB%A1%A0%EC%A1%B0%EC%82%AC%20%EC%A7%80%EC%A7%80%EC%9C%A8+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%99%B8%EA%B5%90%20%EC%A0%95%EC%83%81%ED%9A%8C%EB%8B%B4%20%ED%95%9C%EB%AF%B8%20%ED%95%9C%EC%9D%BC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B5%AD%EC%A0%95%EA%B0%90%EC%82%AC%20%EC%83%81%EC%9E%84%EC%9C%84+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A7%80%EB%B0%A9%EC%9E%90%EC%B9%98%EB%8B%A8%EC%B2%B4%20%EC%8B%9C%EB%8F%84%EC%A7%80%EC%82%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A0%95%EB%8B%B9%20%EB%8B%B9%EB%8C%80%ED%91%9C%20%ED%9A%8C%EC%9D%98+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B5%AD%EB%B0%A9%20%EC%95%88%EB%B3%B4%20%EA%B5%B0+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B2%95%20%EA%B0%9C%EC%A0%95%EC%95%88%20%EC%8B%9C%ED%96%89+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ],
  '연예': [
    'https://news.google.com/rss/search?q=%EC%97%B0%EC%98%88%EA%B3%84%20%EC%86%8C%EC%8B%9D+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%95%84%EC%9D%B4%EB%8F%8C%20%EA%B7%B8%EB%A3%B9+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%93%9C%EB%9D%BC%EB%A7%88%20%EB%B0%A9%EC%98%81+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%98%81%ED%99%94%20%EA%B0%9C%EB%B4%89+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B0%80%EC%88%98%20%EC%8B%A0%EA%B3%A1+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B0%B0%EC%9A%B0%20%EC%B6%9C%EC%97%B0+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%98%88%EB%8A%A5%20%ED%94%84%EB%A1%9C%EA%B7%B8%EB%9E%A8+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B0%A9%EC%86%A1%20%ED%94%84%EB%A1%9C%EA%B7%B8%EB%9E%A8+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=K%ED%8C%9D%20%EC%95%84%EC%9D%B4%EB%8F%8C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%97%B0%EC%98%88%EC%9D%B8%20%EA%B7%BC%ED%99%A9+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ],
  '스포츠': [
    'https://news.google.com/rss/search?q=%ED%94%84%EB%A1%9C%EC%95%BC%EA%B5%AC%20KBO%20%EA%B2%BD%EA%B8%B0%20%EA%B2%B0%EA%B3%BC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%B6%95%EA%B5%AC%20K%EB%A6%AC%EA%B7%B8%20%EA%B5%AD%EA%B0%80%EB%8C%80%ED%91%9C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%86%90%ED%9D%A5%EB%AF%BC%20%EC%9D%B4%EA%B0%95%EC%9D%B8%20%ED%95%B4%EC%99%B8%EC%B6%95%EA%B5%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%ED%94%84%EB%A1%9C%EB%86%8D%EA%B5%AC%20%EB%B0%B0%EA%B5%AC%20KBL+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%98%AC%EB%A6%BC%ED%94%BD%20%EC%95%84%EC%8B%9C%EC%95%88%EA%B2%8C%EC%9E%84%20%EB%A9%94%EB%8B%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%95%BC%EA%B5%AC%20%EC%88%9C%EC%9C%84%20%EA%B2%BD%EA%B8%B0%20%EC%9D%BC%EC%A0%95+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%B6%95%EA%B5%AC%20%EB%8C%80%ED%91%9C%ED%8C%80%20%ED%8F%89%EA%B0%80%EC%A0%84+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B3%A8%ED%94%84%20%EB%8C%80%ED%9A%8C%20%EC%9A%B0%EC%8A%B9+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=e%EC%8A%A4%ED%8F%AC%EC%B8%A0%20%EB%A6%AC%EA%B7%B8+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EA%B2%A9%ED%88%AC%EA%B8%B0%20UFC%20%EA%B2%BD%EA%B8%B0+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ],
  'IT': [
    'https://news.google.com/rss/search?q=%EC%9D%B8%EA%B3%B5%EC%A7%80%EB%8A%A5%20AI%20%EC%B1%97GPT+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B0%98%EB%8F%84%EC%B2%B4%20%EC%82%BC%EC%84%B1%EC%A0%84%EC%9E%90%20SK%ED%95%98%EC%9D%B4%EB%8B%89%EC%8A%A4+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%8A%A4%EB%A7%88%ED%8A%B8%ED%8F%B0%20%EA%B0%A4%EB%9F%AD%EC%8B%9C%20%EC%95%84%EC%9D%B4%ED%8F%B0%20%EC%B6%9C%EC%8B%9C+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%84%A4%EC%9D%B4%EB%B2%84%20%EC%B9%B4%EC%B9%B4%EC%98%A4%20%ED%94%8C%EB%9E%AB%ED%8F%BC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%8A%A4%ED%83%80%ED%8A%B8%EC%97%85%20%ED%88%AC%EC%9E%90%20%EC%9C%A0%EC%B9%98%20IT%EC%97%85%EA%B3%84+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%ED%81%B4%EB%9D%BC%EC%9A%B0%EB%93%9C%20%EB%8D%B0%EC%9D%B4%ED%84%B0%EC%84%BC%ED%84%B0+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%B3%B4%EC%95%88%20%ED%95%B4%ED%82%B9%20%EA%B0%9C%EC%9D%B8%EC%A0%95%EB%B3%B4+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%A0%84%EA%B8%B0%EC%B0%A8%20%EB%B0%B0%ED%84%B0%EB%A6%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EC%9A%B0%EC%A3%BC%20%EC%9C%84%EC%84%B1%20%EB%B0%9C%EC%82%AC+when:14d&hl=ko&gl=KR&ceid=KR:ko',
    'https://news.google.com/rss/search?q=%EB%A1%9C%EB%B4%87%20%EC%9E%90%EB%8F%99%ED%99%94%20%EA%B8%B0%EC%88%A0+when:14d&hl=ko&gl=KR&ceid=KR:ko'
  ]
};

const NEWS_KEEP_DAYS  = 30;   // 이 기간이 지나면 삭제
const NEWS_PER_CAT    = 120;  // 카테고리별로 내려주는 최대 건수
const NEWS_FEED_LIMIT = 60;   // 피드 하나에서 가져올 최대 건수

async function ensureNewsTable(env) {
  const sqls = [
    `CREATE TABLE IF NOT EXISTS news (
       link TEXT PRIMARY KEY,
       cat TEXT NOT NULL,
       title TEXT NOT NULL,
       source TEXT DEFAULT '',
       ts INTEGER NOT NULL,
       created_at INTEGER NOT NULL
     )`,
    `CREATE INDEX IF NOT EXISTS idx_news_cat_ts ON news(cat, ts DESC)`
  ];
  for (const sql of sqls) {
    try { await env.DB.prepare(sql).run(); } catch (e) { /* 이미 있으면 무시 */ }
  }
}

// XML 엔티티 되돌리기 — Workers 에는 DOMParser 가 없어 직접 처리한다
function xmlDecode(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ')
    // 뉴스 제목에 자주 나오는 이름 엔티티들 (…, –, ‘’, “”)
    .replace(/&hellip;/g, '\u2026').replace(/&mdash;/g, '\u2014').replace(/&ndash;/g, '\u2013')
    .replace(/&lsquo;/g, '\u2018').replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C').replace(/&rdquo;/g, '\u201D')
    .replace(/&middot;/g, '\u00B7')
    // 숫자 엔티티 (&#8230; / &#x2026;)
    .replace(/&#x([0-9A-Fa-f]+);/g, function(_, h){ return String.fromCodePoint(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function(_, d){ return String.fromCodePoint(parseInt(d, 10)); })
    .replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pickTag(block, tag) {
  const m = new RegExp('<' + tag + '[^>]*>([\\s\\S]*?)<\\/' + tag + '>').exec(block);
  return m ? m[1] : '';
}

// 구글 뉴스 RSS → [{title, link, source, ts}]
function parseRss(xml) {
  const out = [];
  const chunks = String(xml || '').split(/<item[\s>]/).slice(1);
  for (const raw of chunks) {
    const cut = raw.indexOf('</item>');
    const block = cut >= 0 ? raw.slice(0, cut) : raw;
    const rawTitle = xmlDecode(pickTag(block, 'title'));
    const link = xmlDecode(pickTag(block, 'link'));
    if (!rawTitle || !link) continue;
    // 구글 뉴스 제목 형식: "기사제목 - 언론사"
    const parts = rawTitle.split(' - ');
    const title  = parts.length > 1 ? parts.slice(0, -1).join(' - ') : rawTitle;
    const source = parts.length > 1 ? parts[parts.length - 1] : xmlDecode(pickTag(block, 'source'));
    let ts = Date.parse(xmlDecode(pickTag(block, 'pubDate')));
    if (!isFinite(ts)) ts = Date.now();
    out.push({ title, link, source, ts });
    if (out.length >= NEWS_FEED_LIMIT) break;
  }
  return out;
}

const NEWS_GAP_MS   = 700;   // 피드 사이 간격 — 한꺼번에 쏘면 구글이 503으로 막는다
const NEWS_RETRY     = 2;    // 503/429 일 때 재시도 횟수
const NEWS_RETRY_MS  = 2500; // 재시도 전 대기

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 피드 하나를 받아온다. 막히면(503/429) 잠시 쉬었다 다시 시도한다. */
async function fetchFeed(u) {
  for (let attempt = 0; attempt <= NEWS_RETRY; attempt++) {
    try {
      const r = await fetch(u, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; gildongmu/1.0)',
          'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
          'Accept-Language': 'ko-KR,ko;q=0.9'
        },
        cf: { cacheTtl: 600, cacheEverything: true }
      });
      if (r.status === 503 || r.status === 429) {
        if (attempt < NEWS_RETRY) { await sleep(NEWS_RETRY_MS * (attempt + 1)); continue; }
        return [];
      }
      if (!r.ok) return [];
      return parseRss(await r.text());
    } catch (e) {
      if (attempt < NEWS_RETRY) { await sleep(NEWS_RETRY_MS); continue; }
      return [];
    }
  }
  return [];
}

// 카테고리 하나를 수집해 D1 에 넣는다
//   ★ 예전에는 10개 피드를 Promise.all 로 한꺼번에 쐈다. 카테고리 4개쯤 지나면
//     구글이 503("Sorry...")으로 막아 그 카테고리가 통째로 0건이 됐다.
//     순차로 돌리고 사이에 간격을 둔다.
async function collectCat(env, cat) {
  const feeds = NEWS_FEEDS[cat] || [];
  const now = Date.now();

  const results = [];
  for (let i = 0; i < feeds.length; i++) {
    if (i > 0) await sleep(NEWS_GAP_MS);
    results.push(await fetchFeed(feeds[i]));
  }

  // 같은 수집 안에서의 중복 먼저 제거
  const seen = new Set();
  const rows = [];
  for (const arr of results) {
    for (const n of arr) {
      if (seen.has(n.link)) continue;
      seen.add(n.link);
      rows.push(n);
    }
  }

  // D1 은 한 번에 너무 많은 문장을 묶으면 실패하므로 나눠 넣는다
  let added = 0, failed = 0;
  const CHUNK = 25;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const part = rows.slice(i, i + CHUNK);
    try {
      await env.DB.batch(part.map((n) => env.DB.prepare(
        'INSERT OR IGNORE INTO news (link, cat, title, source, ts, created_at) VALUES (?, ?, ?, ?, ?, ?)'
      ).bind(n.link, cat, n.title, n.source || '', n.ts, now)));
      added += part.length;
    } catch (e) { failed += part.length; }
  }
  // 받아온 건 있는데 하나도 안 들어갔다면 원인을 알 수 있어야 한다
  return { fetched: rows.length, added, failed };
}

// 전체 수집 — 카테고리를 순차로 돈다(동시에 다 돌리면 서브요청 한도에 걸린다)
async function collectAllNews(env) {
  await ensureNewsTable(env);
  const stat = {};
  for (const cat of Object.keys(NEWS_FEEDS)) {
    stat[cat] = await collectCat(env, cat);
  }
  return stat;
}

/* ── 정기 수집: 한 번에 한 카테고리씩 ──────────────────────────
 *   3시간마다 도니 하루 8회. 카테고리가 7개라 하루면 한 바퀴를 돈다.
 *   한 번에 10개 피드만 받으므로 구글이 막을 이유가 없고,
 *   D1 에는 30일치가 쌓여 있어 목록이 비지 않는다.
 *   어디까지 돌았는지는 meta 테이블에 저장한다(워커는 상태를 기억하지 못한다).
 */
async function ensureMetaTable(env) {
  try {
    await env.DB.prepare('CREATE TABLE IF NOT EXISTS news_meta (k TEXT PRIMARY KEY, v TEXT)').run();
  } catch (e) {}
}

async function metaGet(env, k) {
  try {
    const r = await env.DB.prepare('SELECT v FROM news_meta WHERE k = ?').bind(k).first();
    return r ? r.v : null;
  } catch (e) { return null; }
}

async function metaSet(env, k, v) {
  try {
    await env.DB.prepare(
      'INSERT INTO news_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'
    ).bind(k, String(v)).run();
  } catch (e) {}
}

async function collectNextCat(env) {
  await ensureNewsTable(env);
  await ensureMetaTable(env);
  const cats = Object.keys(NEWS_FEEDS);
  let idx = parseInt(await metaGet(env, 'rotIdx'), 10);
  if (!isFinite(idx) || idx < 0 || idx >= cats.length) idx = 0;
  const cat = cats[idx];
  const stat = await collectCat(env, cat);
  await metaSet(env, 'rotIdx', (idx + 1) % cats.length);
  return { cat, ...stat };
}

// 보관 기간이 지난 기사 삭제
async function purgeOldNews(env) {
  await ensureNewsTable(env);
  const cut = Date.now() - NEWS_KEEP_DAYS * 24 * 3600 * 1000;
  try {
    const r = await env.DB.prepare('DELETE FROM news WHERE ts < ?').bind(cut).run();
    return (r && r.meta && r.meta.changes) || 0;
  } catch (e) { return 0; }
}

async function readNews(env, cat, limit) {
  await ensureNewsTable(env);
  const n = Math.min(Math.max(parseInt(limit, 10) || NEWS_PER_CAT, 1), 300);
  const q = cat
    ? env.DB.prepare('SELECT link, cat, title, source, ts FROM news WHERE cat = ? ORDER BY ts DESC LIMIT ?').bind(cat, n)
    : env.DB.prepare('SELECT link, cat, title, source, ts FROM news ORDER BY ts DESC LIMIT ?').bind(n);
  const r = await q.all();
  return (r && r.results) || [];
}

// 카테고리 전부를 한 번에 — 앱은 이 하나만 부르면 된다
async function readAllNews(env, per) {
  await ensureNewsTable(env);
  const n = Math.min(Math.max(parseInt(per, 10) || NEWS_PER_CAT, 1), 300);
  const out = {};
  for (const cat of Object.keys(NEWS_FEEDS)) {
    try {
      const r = await env.DB.prepare(
        'SELECT link, cat, title, source, ts FROM news WHERE cat = ? ORDER BY ts DESC LIMIT ?'
      ).bind(cat, n).all();
      out[cat] = (r && r.results) || [];
    } catch (e) { out[cat] = []; }
  }
  return out;
}

function jsonRes(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS }
  });
}

// ══════════════════════════════════════════════════════════════
// /kakao-local 프록시 + D1 캐시
//   gentle-lab-7e47subway-api 워커(worker/index.js)에 붙여 넣는 조각.
//   같은 질문은 카카오에 다시 묻지 않는다 → 호출량이 실사용의 5~10% 수준으로 떨어진다.
//
//   필요한 것: 시크릿 KAKAO_REST_KEY  (npx wrangler secret put KAKAO_REST_KEY)
//              D1 바인딩 env.DB       (이미 subway-db 로 연결돼 있음)
// ══════════════════════════════════════════════════════════════

const KAKAO_TTL_MS   = 90 * 24 * 3600 * 1000;   // 저장 90일
const KAKAO_CACHE_MAX = 20000;                  // 정리 기준 행 수

// 캐시 테이블 (최초 1회만 만들어짐)
let _kakaoTableReady = false;
async function ensureKakaoCache(env) {
  if (_kakaoTableReady) return;
  await env.DB.prepare(
    'CREATE TABLE IF NOT EXISTS kakao_cache (k TEXT PRIMARY KEY, v TEXT, ts INTEGER)'
  ).run();
  await env.DB.prepare(
    'CREATE INDEX IF NOT EXISTS idx_kakao_ts ON kakao_cache(ts)'
  ).run();
  _kakaoTableReady = true;
}

// ★ 좌표는 100m 격자(소수 3자리)로 뭉친다.
//   지오코딩 결과는 몇 십 m 움직인다고 달라지지 않는다.
//   앱에서도 같은 규칙으로 키를 만들기 때문에 두 겹이 서로 어긋나지 않는다.
function kakaoCacheKey(path, qs) {
  let q = String(qs || '');
  if (/coord2/.test(String(path || ''))) {
    q = q.replace(/(^|&)(x|y)=(-?\d+(?:\.\d+)?)/g,
      (_m, pre, k, v) => pre + k + '=' + (Math.round(parseFloat(v) * 1000) / 1000).toFixed(3));
  }
  return String(path || '') + '?' + q;
}

async function handleKakaoLocal(request, env) {
  const url  = new URL(request.url);
  const path = url.searchParams.get('path') || '';
  const qs   = url.searchParams.get('qs')   || '';

  // 허용 경로만 (임의 경로 프록시 방지)
  if (!/^(search\/(keyword|address|category)\.json|geo\/(coord2regioncode|coord2address|transcoord)\.json)$/.test(path)) {
    return new Response(JSON.stringify({ error: 'path not allowed' }), {
      status: 400, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
    });
  }

  const key = kakaoCacheKey(path, qs);
  const now = Date.now();

  // 1) 캐시 먼저
  try {
    await ensureKakaoCache(env);
    const row = await env.DB.prepare('SELECT v, ts FROM kakao_cache WHERE k = ?').bind(key).first();
    if (row && (now - Number(row.ts || 0)) < KAKAO_TTL_MS) {
      return new Response(row.v, {
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'access-control-allow-origin': '*',
          'x-cache': 'HIT'
        }
      });
    }
  } catch (e) { /* 캐시가 실패해도 원본 호출로 진행 */ }

  // 2) 카카오 호출
  const key_ = env.KAKAO_REST_KEY;
  if (!key_) {
    return new Response(JSON.stringify({ error: 'KAKAO_REST_KEY not set' }), {
      status: 500, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
    });
  }

  let body = '', status = 502;
  try {
    const r = await fetch('https://dapi.kakao.com/v2/local/' + path + (qs ? ('?' + qs) : ''), {
      headers: { Authorization: 'KakaoAK ' + key_ }
    });
    status = r.status;
    body   = await r.text();
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e && e.message || e) }), {
      status: 502, headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' }
    });
  }

  // 3) 성공하고 결과가 있을 때만 저장 — 빈 응답·오류를 90일 붙들지 않는다
  if (status === 200) {
    try {
      const j = JSON.parse(body);
      if (j && Array.isArray(j.documents) && j.documents.length) {
        await env.DB.prepare(
          'INSERT INTO kakao_cache (k, v, ts) VALUES (?, ?, ?) ' +
          'ON CONFLICT(k) DO UPDATE SET v = excluded.v, ts = excluded.ts'
        ).bind(key, body, now).run();
      }
    } catch (e) { /* 저장 실패는 무시 */ }
  }

  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'x-cache': 'MISS'
    }
  });
}

// 오래된 캐시 정리 (cron 이나 /admin/kakao-purge 에서 호출)
async function purgeKakaoCache(env) {
  await ensureKakaoCache(env);
  const cut = Date.now() - KAKAO_TTL_MS;
  const r = await env.DB.prepare('DELETE FROM kakao_cache WHERE ts < ?').bind(cut).run();
  return (r && r.meta && r.meta.changes) || 0;
}

// ══════════════════════════════════════════════════════════════
// /seoul — 서울 열린데이터 지하철 실시간 (키 주입 + 키 로테이션)
//   앱 호출: /seoul?path=realtimeStationArrival/0/10/아라
//   실제 주소: https://swopenapi.seoul.go.kr/api/subway/{KEY}/json/{path}
//
//   키는 시크릿 SEOUL_API_KEY 에 둔다. 쉼표로 여러 개 넣으면
//   일일 한도(ERROR-337)나 인증 실패(INFO-100)가 뜰 때 다음 키로 넘어간다.
//     npx wrangler secret put SEOUL_API_KEY
//     → key1,key2,key3
// ══════════════════════════════════════════════════════════════

const SEOUL_BASE = 'https://swopenapi.seoul.go.kr/api/subway';

// ★ 호출 아끼기 — 서울 지하철 인증키는 하루 1,000건이라 그냥 쓰면 금방 닳는다.
//   같은 역을 여러 사람이 봐도 한 번만 나가도록 세 겹으로 막는다.
//     ① 같은 isolate 메모리   (가장 빠름)
//     ② Cloudflare 엣지 캐시  (같은 지역 사용자끼리 공유)
//     ③ 동시요청 합치기       (10명이 동시에 눌러도 upstream 1회)
//   도착정보는 10초, 열차위치는 15초. 원본이 그 정도 주기로 갱신되므로
//   신선도 손해는 거의 없고 호출량은 사용자 수에 비례하지 않게 된다.
const SEOUL_TTL = { arrival: 10, position: 15, other: 1800 };

function seoulTtl(path) {
  if (/^realtimeStationArrival\//.test(path)) return SEOUL_TTL.arrival;
  if (/^realtimePosition\//.test(path))       return SEOUL_TTL.position;
  return SEOUL_TTL.other;
}

const _seoulMem      = new Map();   // path -> { exp, body, status }
const _seoulInflight = new Map();   // path -> Promise
const seoulStats     = { upstream: 0, mem: 0, edge: 0, coalesced: 0 };

function seoulMemGet(path) {
  const e = _seoulMem.get(path);
  if (!e) return null;
  if (Date.now() > e.exp) { _seoulMem.delete(path); return null; }
  return e;
}
function seoulMemPut(path, status, body, ttlSec) {
  _seoulMem.set(path, { exp: Date.now() + ttlSec * 1000, body, status });
  if (_seoulMem.size > 500) {                       // 오래된 것부터 정리
    for (const [k, v] of _seoulMem) { if (Date.now() > v.exp) _seoulMem.delete(k); }
  }
}
function seoulRes(body, status, from, ttlSec, usedKey) {
  const h = {
    'Content-Type': 'application/json; charset=utf-8',
    ...CORS,
    'Cache-Control': 'public, max-age=' + ttlSec,
    'x-seoul-cache': from
  };
  if (usedKey != null) h['x-seoul-key'] = String(usedKey);   // 몇 번째 키가 쓰였는지
  return new Response(body, { status, headers: h });
}

// 이 서비스들만 허용 (임의 경로 프록시 방지)
const SEOUL_SERVICES = /^(realtimeStationArrival|realtimePosition|getShtrmPath|SearchSTNBySubwayLineInfo|SearchInfoBySubwayNameService)\//;

function seoulKeys(env) {
  return String(env.SEOUL_API_KEY || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function handleSeoul(request, env) {
  const url  = new URL(request.url);
  const path = url.searchParams.get('path') || '';

  if (!SEOUL_SERVICES.test(path)) {
    return jsonRes({ ok: false, error: 'path not allowed' }, 400);
  }

  const keys = seoulKeys(env);
  if (!keys.length) {
    return jsonRes({ ok: false, error: 'SEOUL_API_KEY not set' }, 500);
  }

  const ttl = seoulTtl(path);

  // ① 메모리
  const hit = seoulMemGet(path);
  if (hit) { seoulStats.mem++; return seoulRes(hit.body, hit.status, 'MEM', ttl); }

  // ② 엣지 캐시 (같은 지역 사용자끼리 공유)
  const cacheKey = new Request('https://seoul-cache/' + encodeURIComponent(path));
  let edge = null;
  try { edge = await caches.default.match(cacheKey); } catch (e) { /* 캐시 없으면 그냥 진행 */ }
  if (edge) {
    seoulStats.edge++;
    const body = await edge.text();
    seoulMemPut(path, edge.status, body, ttl);
    return seoulRes(body, edge.status, 'EDGE', ttl);
  }

  // ③ 같은 경로를 동시에 여러 명이 요청하면 upstream 은 한 번만
  const flying = _seoulInflight.get(path);
  if (flying) {
    seoulStats.coalesced++;
    const r = await flying;
    return seoulRes(r.body, r.status, 'WAIT', ttl, r.key);
  }

  const job = seoulUpstream(path, keys, ttl, cacheKey);
  _seoulInflight.set(path, job);
  try {
    const r = await job;
    return seoulRes(r.body, r.status, 'MISS', ttl, r.key);
  } finally {
    _seoulInflight.delete(path);
  }
}

// 실제 호출 (키 로테이션 포함) — 성공하면 두 캐시에 모두 넣는다
async function seoulUpstream(path, keys, ttl, cacheKey) {
  let lastBody = '', lastStatus = 502;

  for (let i = 0; i < keys.length; i++) {
    const target = SEOUL_BASE + '/' + encodeURIComponent(keys[i]) + '/json/' + path;
    let body = '', status = 502;
    try {
      const r = await fetch(target, {
        headers: { Accept: 'application/json', 'User-Agent': 'gildongmu/1.0' },
        cf: { cacheTtl: ttl, cacheEverything: false }
      });
      seoulStats.upstream++;
      status = r.status;
      body   = await r.text();
    } catch (e) {
      lastBody = JSON.stringify({ ok: false, error: String((e && e.message) || e) });
      continue;                       // 다음 키로
    }

    lastBody = body; lastStatus = status;

    // 한도 초과·키 문제면 다음 키로, 그 외에는 그대로 돌려준다
    let code = '';
    try {
      const j = JSON.parse(body);
      code = (j && j.errorMessage && j.errorMessage.code)
          || (j && j.status && j.status.code) || '';
    } catch (e) { /* JSON 이 아니면 그대로 반환 */ }

    if (code === 'ERROR-337' || code === 'INFO-100' || code === 'ERROR-336') continue;

    // 정상 응답만 캐시에 넣는다(한도 초과 메시지를 10초 붙들면 안 된다)
    if (status === 200) {
      seoulMemPut(path, status, body, ttl);
      try {
        await caches.default.put(cacheKey, new Response(body, {
          headers: { 'Content-Type': 'application/json; charset=utf-8',
                     'Cache-Control': 'public, max-age=' + ttl }
        }));
      } catch (e) { /* 엣지 캐시 실패는 무시 */ }
    }
    return { body, status, key: i + 1 };
  }

  // 모든 키가 막힘 — 앱은 이 경우 정적 시각표로 폴백한다
  return { body: lastBody || JSON.stringify({ ok: false, error: 'all keys exhausted' }),
           status: lastStatus, key: 'exhausted' };
}

export default {
  async fetch(request, env) {
    const reqUrl = new URL(request.url);

    // CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    // 상태 확인용
    if (reqUrl.pathname === '/' || reqUrl.pathname === '/health') {
      return new Response(
        JSON.stringify({
          ok: true,
          service: 'gildongmu-bus-proxy',
          // 배포된 코드가 어느 버전인지 확인용 — 새 기능이 안 보이면 여기부터 본다
          version: 'seoul-cache-2026-09-02',
          routes: ['/tago', '/seoul', '/kakao-local', '/news/all', '/news',
                   '/admin/news-collect', '/admin/news-debug', '/admin/news-purge', '/admin/kakao-purge'],
          keySet: !!env.DATA_GO_KR_KEY,
          kakaoKeySet: !!env.KAKAO_REST_KEY,
          seoulKeyCount: seoulKeys(env).length,
          seoulStats,   // upstream=실제 호출, mem/edge/coalesced=아낀 횟수

          keyType: env.DATA_GO_KR_KEY
            ? (/%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY) ? 'encoding(자동 디코드 적용)' : 'decoding')
            : 'none',
          allowed: ALLOWED_HOSTS
        }),
        { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
      );
    }

    /* ── 📰 뉴스 ─────────────────────────────────────────────── */
    if (reqUrl.pathname === '/news/all') {
      try {
        const per = reqUrl.searchParams.get('per');
        return jsonRes({ ok: true, per: Number(per) || NEWS_PER_CAT, cats: await readAllNews(env, per) });
      } catch (e) {
        return jsonRes({ ok: false, error: String((e && e.message) || e) }, 500);
      }
    }
    if (reqUrl.pathname === '/news') {
      try {
        const cat = reqUrl.searchParams.get('cat') || '';
        return jsonRes({ ok: true, cat, items: await readNews(env, cat, reqUrl.searchParams.get('limit')) });
      } catch (e) {
        return jsonRes({ ok: false, error: String((e && e.message) || e) }, 500);
      }
    }
    /* 점검용 수동 실행 — cron 이 도는지 확인할 때 쓴다 */
    if (reqUrl.pathname === '/admin/news-collect') {
      try {
        // ?cat=연예 → 한 카테고리만 (구글에 막히지 않는 안전한 방법)
        // ?next=1  → 순환 순서상 다음 카테고리 하나
        const one = reqUrl.searchParams.get('cat');
        if (one) {
          if (!NEWS_FEEDS[one]) return jsonRes({ ok: false, error: 'unknown cat: ' + one }, 400);
          await ensureNewsTable(env);
          return jsonRes({ ok: true, cat: one, ...(await collectCat(env, one)) });
        }
        if (reqUrl.searchParams.get('next')) {
          return jsonRes({ ok: true, ...(await collectNextCat(env)) });
        }
        return jsonRes({ ok: true, added: await collectAllNews(env) });
      } catch (e) { return jsonRes({ ok: false, error: String((e && e.message) || e) }, 500); }
    }
    /* 피드가 왜 비는지 집어내는 진단 — 카테고리 하나를 피드별로 뜯어본다 */
    if (reqUrl.pathname === '/admin/news-debug') {
      try {
        const cat = reqUrl.searchParams.get('cat') || '연예';
        const feeds = NEWS_FEEDS[cat] || [];
        const out = [];
        for (const u of feeds) {
          const row = { q: decodeURIComponent((/q=([^&]+)/.exec(u) || [])[1] || '') };
          try {
            const r = await fetch(u, {
              headers: { 'User-Agent': 'gildongmu-news/1.0', 'Accept': 'application/rss+xml,*/*' }
            });
            row.status = r.status;
            const t = await r.text();
            row.bytes = t.length;
            row.itemTags = (t.match(/<item[\s>]/g) || []).length;
            row.parsed = parseRss(t).length;
            if (!row.parsed) row.head = t.slice(0, 300);   // 무엇이 왔는지 눈으로 본다
          } catch (e) {
            row.error = String((e && e.message) || e);
          }
          out.push(row);
        }
        return jsonRes({ ok: true, cat, feeds: out });
      } catch (e) {
        return jsonRes({ ok: false, error: String((e && e.message) || e) }, 500);
      }
    }
    /* 어떤 형태의 검색어가 통과하는지 한 번에 비교한다.
       503 이 검색어 때문인지, 속도 제한인지, 파라미터 때문인지 가른다. */
    if (reqUrl.pathname === '/admin/news-probe') {
      const q = reqUrl.searchParams.get('q') || '아이돌';
      const eq = encodeURIComponent(q);
      const cases = [
        { name: 'search+when14d', url: 'https://news.google.com/rss/search?q=' + eq + '+when:14d&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'search(기간없음)', url: 'https://news.google.com/rss/search?q=' + eq + '&hl=ko&gl=KR&ceid=KR:ko' },
        { name: 'search(로케일없음)', url: 'https://news.google.com/rss/search?q=' + eq },
        { name: 'ENTERTAINMENT토픽', url: 'https://news.google.com/rss/headlines/section/topic/ENTERTAINMENT?hl=ko&gl=KR&ceid=KR:ko' },
        { name: '전체헤드라인', url: 'https://news.google.com/rss?hl=ko&gl=KR&ceid=KR:ko' },
        { name: '비교용(코스피)', url: 'https://news.google.com/rss/search?q=' + encodeURIComponent('코스피') + '+when:14d&hl=ko&gl=KR&ceid=KR:ko' }
      ];
      const out = [];
      for (const c of cases) {
        try {
          const r = await fetch(c.url, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; gildongmu/1.0)',
              'Accept': 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
              'Accept-Language': 'ko-KR,ko;q=0.9'
            }
          });
          const t = await r.text();
          out.push({
            name: c.name, status: r.status, bytes: t.length,
            items: (t.match(/<item[\s>]/g) || []).length,
            head: (t.match(/<item[\s>]/g) || []).length ? undefined : t.slice(0, 160)
          });
        } catch (e) {
          out.push({ name: c.name, error: String((e && e.message) || e) });
        }
        await sleep(1200);   // 사이를 충분히 벌려 속도 제한 영향을 배제한다
      }
      return jsonRes({ ok: true, q, cases: out });
    }
    if (reqUrl.pathname === '/admin/news-purge') {
      try { return jsonRes({ ok: true, deleted: await purgeOldNews(env) }); }
      catch (e) { return jsonRes({ ok: false, error: String((e && e.message) || e) }, 500); }
    }

    /* ── 📍 카카오 로컬 (D1 캐시 경유) ────────────────────────
     *   같은 좌표(100m 격자)·같은 검색어는 카카오에 다시 묻지 않는다.
     */
    if (reqUrl.pathname === '/kakao-local') {
      return handleKakaoLocal(request, env);
    }
    if (reqUrl.pathname === '/admin/kakao-purge') {
      try { return jsonRes({ ok: true, purged: await purgeKakaoCache(env) }); }
      catch (e) { return jsonRes({ ok: false, error: String((e && e.message) || e) }, 500); }
    }

    /* ── 🚇 서울 지하철 실시간 ───────────────────────────────── */
    if (reqUrl.pathname === '/seoul') {
      return handleSeoul(request, env);
    }

    if (reqUrl.pathname !== '/tago') {
      return new Response('Not found', { status: 404, headers: CORS });
    }

    const target = reqUrl.searchParams.get('url');
    if (!target) {
      return new Response('Missing url', { status: 400, headers: CORS });
    }

    let u;
    try {
      u = new URL(target);
    } catch (e) {
      return new Response('Bad url', { status: 400, headers: CORS });
    }

    if (!hostAllowed(u.hostname)) {
      return new Response('Forbidden host: ' + u.hostname, { status: 403, headers: CORS });
    }

    if (!env.DATA_GO_KR_KEY) {
      return new Response('Server key not configured', { status: 500, headers: CORS });
    }

    // ★ serviceKey 주입 (앱은 빈 값으로 보냄)
    //   data.go.kr 키는 Encoding(%2B..) / Decoding(+..) 두 형태가 있다.
    //   Encoding 키를 그대로 넣으면 searchParams.set이 다시 인코딩해(%252B) 인증 실패한다.
    //   → 퍼센트 인코딩이 보이면 한 번 디코드해 원본으로 되돌린 뒤 넣는다.
    let key = String(env.DATA_GO_KR_KEY || '');
    if (/%[0-9A-Fa-f]{2}/.test(key)) {
      try { key = decodeURIComponent(key); } catch (e) { /* 디코드 실패 시 원본 사용 */ }
    }
    u.searchParams.set('serviceKey', key);
    // 서울 TOPIS(ws.bus.go.kr)는 "변수명은 대소문자를 구분"한다고 문서에 명시돼 있어
    // 대문자 S 형태도 함께 넣어 둔다(무시되면 그만, 필요하면 이쪽이 인식된다).
    if (/(^|\.)ws\.bus\.go\.kr$/.test(u.hostname)) {
      u.searchParams.set('ServiceKey', key);
      u.searchParams.set('resultType', 'json');
    }

    // 서울 TOPIS는 https를 지원하지 않는 경우가 있어 http로 시도 후 실패 시 https 재시도
    const tryFetch = async (urlStr) => {
      return await fetch(urlStr, {
        method: 'GET',
        headers: { 'Accept': '*/*', 'User-Agent': 'gildongmu/1.0' },
        cf: { cacheTtl: 5, cacheEverything: false }
      });
    };

    let upstream;
    try {
      upstream = await tryFetch(u.toString());
      if (!upstream.ok && u.protocol === 'https:') {
        const alt = new URL(u.toString());
        alt.protocol = 'http:';
        upstream = await tryFetch(alt.toString());
      }
    } catch (e) {
      try {
        const alt = new URL(u.toString());
        alt.protocol = u.protocol === 'https:' ? 'http:' : 'https:';
        upstream = await tryFetch(alt.toString());
      } catch (e2) {
        return new Response('Upstream error: ' + (e2.message || e2), { status: 502, headers: CORS });
      }
    }

    const body = await upstream.text();
    const ct = upstream.headers.get('Content-Type') || 'text/xml; charset=utf-8';

    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': ct, ...CORS }
    });
  },

  /* ── ⏰ 정기 실행 ────────────────────────────────────────────
   *   wrangler.toml 의 crons 와 짝을 맞춘다.
   *     "20 4 * * *"  → 매일 새벽 4시 20분, 오래된 기사 삭제
   *     그 외         → 뉴스 수집
   */
  async scheduled(event, env, ctx) {
    const cron = String((event && event.cron) || '');
    if (cron.indexOf('20 4 ') === 0) {
      ctx.waitUntil(purgeOldNews(env).then((n) => console.log('[뉴스] 오래된 기사 ' + n + '건 삭제')));
      ctx.waitUntil(purgeKakaoCache(env).then((n) => console.log('[카카오] 오래된 캐시 ' + n + '건 삭제')).catch(() => {}));
      return;
    }
    ctx.waitUntil(collectNextCat(env).then((s) => console.log('[뉴스] 수집 ' + JSON.stringify(s))));
  }
};
