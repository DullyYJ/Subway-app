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
          keySet: !!env.DATA_GO_KR_KEY,
          keyType: env.DATA_GO_KR_KEY
            ? (/%[0-9A-Fa-f]{2}/.test(env.DATA_GO_KR_KEY) ? 'encoding(자동 디코드 적용)' : 'decoding')
            : 'none',
          allowed: ALLOWED_HOSTS
        }),
        { headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS } }
      );
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
  }
};
