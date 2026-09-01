/**
 * 길동무 버스 프록시 워커
 *  - 공공데이터 API의 serviceKey를 서버에서 주입 (앱에 키가 노출되지 않음)
 *  - TAGO / 서울 TOPIS / 경기 GBIS 도메인만 허용
 *  - XML·JSON 응답을 그대로 전달 (앱이 text로 받아 파싱)
 *
 * 사용법:  GET /tago?url=<인코딩된 원본 API URL>
 * 예시:    /tago?url=http%3A%2F%2Fws.bus.go.kr%2Fapi%2Frest%2Farrive%2FgetArrInfoByUid%3FarsId%3D02123
 *
 * ★ 2026-08-31: 응답 캐시 추가
 *   증상: 노선 정류장·차량 위치 조회가 10초 넘게 걸리거나 실패한다.
 *   원인: 공공 API(TAGO/GBIS) 자체가 느리고 간헐적으로 응답을 안 준다.
 *        앱 → Worker → 원본 왕복을 매번 그대로 하니 그 지연이 그대로 드러난다.
 *   대응: 요청 성격별로 짧게 캐시한다.
 *     · 노선 경유정류장 = 거의 안 바뀜    → 24시간
 *     · 노선/정류장 목록 = 하루 단위       → 6시간
 *     · 차량 위치·도착정보 = 실시간        → 5초 (중복 호출만 흡수, 신선도는 유지)
 *   캐시가 맞으면 원본을 아예 안 부르므로 응답이 수십 ms로 떨어진다.
 *   원본이 죽어 있을 때는 마지막 성공분을 돌려준다(stale-while-error).
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

/* ── 응답 캐시 ────────────────────────────────────────────── */
const CACHE = new Map();
const TTL_STATIONS = 24 * 3600 * 1000;   // 노선 경유정류장
const TTL_LIST     = 6 * 3600 * 1000;    // 노선·정류장 목록
const TTL_LIVE     = 5 * 1000;           // 차량위치·도착정보
const STALE_MAX    = 10 * 60 * 1000;     // 원본 실패 시 이만큼 낡은 값까지 허용
const CACHE_MAX    = 600;

function ttlFor(pathname) {
  if (/getRouteAcctoThrghSttnList|getBusRouteStationList|busRouteLineList/i.test(pathname)) {
    return TTL_STATIONS;
  }
  if (/getRouteNoList|getCtyCodeList|getSttnNoList|getRouteInfoItem/i.test(pathname)) {
    return TTL_LIST;
  }
  return TTL_LIVE;   // 위치·도착정보는 짧게
}

function cacheKey(u) {
  // serviceKey는 키에서 제외 (같은 질의는 같은 캐시)
  const params = [...u.searchParams.entries()]
    .filter(([n]) => n.toLowerCase() !== 'servicekey')
    .map(([n, v]) => n + '=' + v)
    .sort()
    .join('&');
  return u.hostname + u.pathname + '?' + params;
}

function cacheSet(key, body, ct) {
  CACHE.set(key, { t: Date.now(), v: body, ct });
  if (CACHE.size > CACHE_MAX) {
    let oldestKey = null, oldestT = Infinity;
    for (const [k, v] of CACHE) { if (v.t < oldestT) { oldestT = v.t; oldestKey = k; } }
    if (oldestKey) CACHE.delete(oldestKey);
  }
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
          cached: CACHE.size,
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

    // ── 캐시 조회 ──────────────────────────────────────────
    const ck  = cacheKey(u);
    const ttl = ttlFor(u.pathname);
    const now = Date.now();
    const hit = CACHE.get(ck);
    if (hit && (now - hit.t) < ttl) {
      return new Response(hit.v, {
        headers: { 'Content-Type': hit.ct, ...CORS, 'X-Cache': 'HIT' }
      });
    }

    // 서울 TOPIS는 https를 지원하지 않는 경우가 있어 http로 시도 후 실패 시 https 재시도
    const tryFetch = async (urlStr) => {
      return await fetch(urlStr, {
        method: 'GET',
        headers: { 'Accept': '*/*', 'User-Agent': 'gildongmu/1.0' },
        cf: { cacheTtl: Math.max(5, Math.floor(ttl / 1000)), cacheEverything: true }
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
        // ★ 원본이 죽었으면 낡은 값이라도 돌려준다 (빈 화면보다 낫다)
        if (hit && (now - hit.t) < STALE_MAX) {
          return new Response(hit.v, {
            headers: { 'Content-Type': hit.ct, ...CORS, 'X-Cache': 'STALE' }
          });
        }
        return new Response('Upstream error: ' + (e2.message || e2), { status: 502, headers: CORS });
      }
    }

    const body = await upstream.text();
    const ct = upstream.headers.get('Content-Type') || 'text/xml; charset=utf-8';

    // 정상 응답만 캐시한다(에러 XML을 굳히면 더 나쁘다)
    if (upstream.ok && body && body.length > 40 && !/<returnReasonCode>(?!00)/.test(body)) {
      cacheSet(ck, body, ct);
    }

    return new Response(body, {
      status: upstream.status,
      headers: { 'Content-Type': ct, ...CORS, 'X-Cache': 'MISS' }
    });
  }
};
