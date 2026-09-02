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
