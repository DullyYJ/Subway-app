#!/usr/bin/env python3
"""
버스 첫차·막차·배차를 D1 bus_routes 에 적재한다.  (2026-09-08)

왜 이렇게 만들었나
──────────────────
· getRouteInfoIem 은 노선 하나당 한 번 불러야 해서 노선이 수천 개면 트래픽(1만/일)이 모자란다.
· getRouteNoList 는 도시 하나당 최대 1000행씩 통째로 주고, 그 안에 첫차·막차가 들어 있다.
  → 1단계로 도시별 목록을 훑어 첫차·막차를 다 채우고(호출 수십 번),
    2단계로 배차가 필요한 노선만 getRouteInfoIem 을 부른다(--interval 옵션).
· 도시코드는 D1 의 route_key 앞부분에서 직접 뽑는다. 따로 목록을 들고 있지 않는다.

사용법
──────
  export TAGO_KEY='디코딩된_인증키'
  python3 load-bus-hours.py --routes routes.json --out fill.sql
  python3 load-bus-hours.py --routes routes.json --out fill.sql --interval   # 배차까지

routes.json 은 D1 에서 뽑아 온 목록:
  SELECT route_key FROM bus_routes;      → [{"route_key":"23_ICB165000123"}, ...]
"""
import argparse, functools, json, os, sys, time, urllib.parse, urllib.request

# 2026-09-08: Actions 로그가 1번 줄만 보이던 이유.
#   파이썬은 터미널이 아니면 출력을 모아뒀다 한꺼번에 내보낸다.
#   한 시간짜리 작업이 아무 것도 안 찍히면 멈춘 건지 도는 건지 알 수가 없다.
print = functools.partial(print, flush=True)

BASE = "https://apis.data.go.kr/1613000/BusRouteInfoInqireService"
PAGE = 1000          # 명세상 페이지당 최대
SLEEP = 0.12         # 초당 30tps 상한을 넉넉히 밑돈다

# D1 bus_routes 에 실제로 들어 있는 도시코드 (2026-09-08 기준 137곳 / 21,485 노선).
#   --routes 로 목록을 주지 않으면 이걸 쓴다. D1 을 내보낼 필요가 없어진다.
DEFAULT_CITIES = ("12 21 22 23 24 25 26 31010 31020 31030 31040 31050 31060 31070 31080 31090 "
                  "31100 31110 31120 31130 31140 31150 31160 31170 31180 31190 31200 31210 31220 "
                  "31230 31240 31250 31260 31270 31320 31350 31370 31380 32010 32020 32050 32310 "
                  "32360 33010 33020 33030 33320 33330 33340 33350 33360 33370 33380 34010 34020 "
                  "34030 34040 34050 34060 34070 34310 34330 34340 34350 34380 34390 35010 35020 "
                  "35030 35040 35050 35060 35320 35330 35340 35350 35360 35370 35380 36010 36020 "
                  "36030 36040 36060 36320 36330 36350 36380 36400 36410 36420 36430 36450 36460 "
                  "36470 36480 37010 37020 37030 37040 37050 37060 37070 37080 37090 37100 37320 "
                  "37330 37340 37350 37360 37370 37380 37390 37400 37410 37420 37430 38010 38030 "
                  "38050 38060 38070 38080 38090 38100 38310 38320 38330 38340 38350 38360 38370 "
                  "38380 38390 38400 39").split()


# 2026-09-08: 137개 도시가 전부 timed out 으로 죽은 일이 있었다.
#   원인은 응답 본문에 있는데(트래픽 초과/키 미등록 등) 그걸 못 보고
#   그냥 '실패'로만 찍어서 100분을 헛돌았다.
#   → 타임아웃을 늘리고, JSON 이 아닌 응답은 앞부분을 그대로 보여준다.
TIMEOUT = 45

def call(op, params, key, tries=3):
    q = dict(params); q["serviceKey"] = key; q["_type"] = "json"
    url = BASE + "/" + op + "?" + urllib.parse.urlencode(q, safe="%")
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gildongmu-loader/1.0"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                raw = r.read().decode("utf-8", "replace")
            try:
                return json.loads(raw)
            except Exception:
                # XML 오류 응답이 그대로 오는 경우가 많다. 본문을 알려 준다.
                raise RuntimeError("JSON 아님: " + " ".join(raw.split())[:200])
        except Exception as e:
            last = e
            time.sleep(1.0 * (i + 1))
    raise RuntimeError(f"{op} 실패: {last}")


def items_of(js):
    """TAGO 응답 파싱.

    2026-09-08: 결과가 0건인 도시는 items 를 빈 문자열 ""로 준다. 그런데 그 습관이
      한 단계 위에서도 나와서, body 자체가 문자열로 오는 도시가 있었다(35060 다음).
      dict 가 아닌 것은 전부 '결과 없음'으로 본다.
      항목이 1개면 dict, 여러 개면 list 로 오는 것도 여기서 흡수한다.
    """
    if not isinstance(js, dict):
        return []
    resp = js.get("response")
    if not isinstance(resp, dict):
        return []
    body = resp.get("body")
    if not isinstance(body, dict):
        return []
    it = body.get("items")
    if not isinstance(it, dict):
        return []
    it = it.get("item")
    if isinstance(it, dict):
        return [it]
    if isinstance(it, list):
        return [x for x in it if isinstance(x, dict)]
    return []


def total_of(js):
    """전체 건수. 못 읽으면 0."""
    try:
        return int(js["response"]["body"].get("totalCount") or 0)
    except Exception:
        return 0


def pick(d, *names):
    """필드 철자가 버전마다 조금씩 달라서 후보를 여러 개 본다."""
    for n in names:
        for k in (n, n.lower(), n.upper()):
            if k in d and d[k] not in (None, "", " "):
                return d[k]
    return None


def hhmm(v):
    """'05:10' / '0510' / 510 → '0510'. 못 읽으면 None."""
    if v is None:
        return None
    s = str(v).strip().replace(":", "")
    if not s.isdigit():
        return None
    s = s.zfill(4)[:4]
    h, m = int(s[:2]), int(s[2:])
    if h > 29 or m > 59:            # 25:30 같은 표기는 허용, 30시 이상은 오류로 본다
        return None
    return s


def num(v):
    try:
        n = int(float(str(v).strip()))
        return n if 1 <= n <= 240 else None
    except Exception:
        return None


def q(s):
    return "NULL" if s is None else "'" + str(s).replace("'", "''") + "'"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--routes", help="D1 에서 뽑은 목록(json). 없으면 --cities 로 전체를 훑는다")
    ap.add_argument("--cities", help="쉼표로 구분한 도시코드. 기본은 D1 에 들어 있는 137곳")
    ap.add_argument("--out", required=True, help="생성할 SQL 파일")
    ap.add_argument("--interval", action="store_true", help="배차(intervaltime)까지 노선별로 조회")
    ap.add_argument("--max-calls", type=int, default=9000, help="일일 트래픽 여유분")
    ap.add_argument("--chunk", type=int, default=2000, help="SQL 파일 하나에 담을 UPDATE 수")
    ap.add_argument("--selftest", metavar="CITY", help="도시 하나만 불러 원문을 그대로 출력 (예: 23)")
    args = ap.parse_args()

    key = os.environ.get("TAGO_KEY", "").strip()
    if not key:
        sys.exit("TAGO_KEY 환경변수가 없습니다")

    # 2026-09-08: 연결이 되는지부터 확인하는 모드.
    #   timed out 만 보고는 한도 초과인지 망 문제인지 구분이 안 돼서 만들었다.
    if args.selftest:
        city = args.selftest
        url = (BASE + "/getRouteNoList?" + urllib.parse.urlencode(
            {"serviceKey": key, "cityCode": city, "numOfRows": 3, "pageNo": 1, "_type": "json"}, safe="%"))
        print("요청:", url.replace(key, "<KEY>"))
        t0 = time.time()
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "gildongmu-loader/1.0"})
            with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
                raw = r.read().decode("utf-8", "replace")
            print(f"응답 {time.time()-t0:.1f}초 · {len(raw)}바이트")
            print("── 원문 앞 800자 ──")
            print(raw[:800])
        except Exception as e:
            print(f"실패 ({time.time()-t0:.1f}초): {type(e).__name__}: {e}")
            raise SystemExit(2)
        return

    rows = []
    if args.routes:
        rows = json.load(open(args.routes, encoding="utf-8"))
        if isinstance(rows, dict):             # wrangler 출력 형태 흡수
            rows = rows.get("results") or rows.get("rows") or []
    want = {}                                   # route_key -> (city, routeid)
    done_itv = set()                            # 배차가 이미 D1 에 있는 노선
    for r in rows:
        rk = r["route_key"] if isinstance(r, dict) else str(r)
        # 2026-09-08: bus_routes 에 city_code / route_id 컬럼이 이미 있다.
        #   route_key 를 쪼개는 것보다 컬럼을 그대로 쓰는 쪽이 안전하다
        #   (형식이 다른 행이 섞여 있어도 놓치지 않는다).
        city = str((r.get("city_code") if isinstance(r, dict) else "") or "").strip()
        rid  = str((r.get("route_id")  if isinstance(r, dict) else "") or "").strip()
        if not city or not rid:
            if "_" not in rk:
                continue
            city, rid = rk.split("_", 1)
        if not city.isdigit():
            continue
        want[rk] = (city, rid)
        if isinstance(r, dict) and r.get("itv_wd") not in (None, "", 0):
            done_itv.add(rid)
    if want:
        cities = sorted({c for c, _ in want.values()})
        print(f"노선 {len(want)}개 / 도시 {len(cities)}곳")
    else:
        cities = [c.strip() for c in (args.cities.split(",") if args.cities else DEFAULT_CITIES) if c.strip()]
        print(f"목록 없이 도시 {len(cities)}곳을 훑습니다 (D1 내보내기 불필요)")

    calls = 0
    bad = []                                    # 응답이 이상해 건너뛴 도시
    streak = 0                                  # 연속 실패 수
    GIVE_UP = 8                                 # 이만큼 연속 실패하면 중단
    found = {}                                  # routeid -> dict(start,end,itv...)

    # ── 1단계: 도시별 노선목록 (첫차·막차) ──────────────────────────
    MAX_PAGE = 20                               # TAGO 가 pageNo 를 무시하고 같은 쪽을
                                                #   계속 주는 경우가 있어 안전장치를 둔다
    for city in cities:
        page = 1
        while page <= MAX_PAGE:
            if calls >= args.max_calls:
                print("트래픽 상한 도달 — 여기까지만 적재합니다"); break
            try:
                js = call("getRouteNoList", {"cityCode": city, "numOfRows": PAGE, "pageNo": page}, key)
            except Exception as e:
                print(f"  [{city}] 조회 실패 — 건너뜀: {e}")
                bad.append(city); streak += 1
                if streak >= GIVE_UP:
                    print(f"\n연속 {streak}회 실패 — 여기서 중단합니다.")
                    print("  · 트래픽(1만/일)을 이미 다 썼거나")
                    print("  · 인증키가 이 API 에 등록되지 않았거나")
                    print("  · TAGO 서버가 응답하지 않는 상태입니다.")
                    print("  위 오류 메시지의 본문을 확인하세요.")
                    raise SystemExit(2)
                break
            calls += 1; streak = 0; time.sleep(SLEEP)
            its = items_of(js)
            for d in its:
                rid = pick(d, "routeid", "routeId")
                if not rid:
                    continue
                found[str(rid)] = {
                    "city": city,
                    "start": hhmm(pick(d, "startvehicletime", "startVehicleTime")),
                    "end":   hhmm(pick(d, "endvehicletime", "endVehicleTime")),
                    "wd":  num(pick(d, "intervaltime", "intervalTime")),
                    "sat": num(pick(d, "intervalsaturtime", "intervalSaturTime")),
                    "sun": num(pick(d, "intervalsuntime", "intervalSunTime")),
                }
            total = total_of(js)
            print(f"  [{city}] page {page}: {len(its)}행 (누적 {len(found)} / 전체 {total})")
            if len(its) < PAGE or page * PAGE >= total:
                break
            page += 1
            if page > MAX_PAGE:
                print(f"  [{city}] 페이지 상한({MAX_PAGE}) 도달 — 다음 도시로")

    # ── 2단계: 배차가 비어 있는 노선만 개별 조회 ────────────────────
    if args.interval:
        # 이미 D1 에 배차가 있거나 1단계에서 받은 노선은 건너뛴다.
        #   노선이 2만 개가 넘어 하루 트래픽(1만)으로는 한 번에 못 끝낸다.
        #   여러 날에 나눠 돌려도 남은 것부터 이어서 채워진다.
        need = [(rk, c, r) for rk, (c, r) in want.items()
                if r not in done_itv and not (found.get(r, {}) or {}).get("wd")]
        print(f"배차 미확보 {len(need)}개 — 개별 조회 (남은 트래픽 {args.max_calls - calls})")
        t0 = time.time()
        for i, (rk, city, rid) in enumerate(need, 1):
            if calls >= args.max_calls:
                print("트래픽 상한 도달 — 배차는 여기까지"); break
            if i % 200 == 0:
                el = time.time() - t0
                left = (len(need) - i) * (el / i)
                print(f"  {i}/{len(need)} · 경과 {el/60:.0f}분 · 남은 예상 {left/60:.0f}분")
            try:
                js = call("getRouteInfoIem", {"cityCode": city, "routeId": rid}, key)
            except Exception as e:
                print("  실패", rid, e); continue
            calls += 1; time.sleep(SLEEP)
            for d in items_of(js):
                cur = found.setdefault(str(rid), {})
                cur["start"] = cur.get("start") or hhmm(pick(d, "startvehicletime", "startVehicleTime"))
                cur["end"]   = cur.get("end")   or hhmm(pick(d, "endvehicletime", "endVehicleTime"))
                cur["wd"]    = cur.get("wd")    or num(pick(d, "intervaltime", "intervalTime"))
                cur["sat"]   = cur.get("sat")   or num(pick(d, "intervalsaturtime", "intervalSaturTime"))
                cur["sun"]   = cur.get("sun")   or num(pick(d, "intervalsuntime", "intervalSunTime"))

    # ── SQL 생성 ────────────────────────────────────────────────
    now = time.strftime("%Y-%m-%dT%H:%M:%S")
    # UPDATE 는 city_code + route_id 로 건다.
    #   route_key 형식을 몰라도 되고, D1 목록을 안 뽑아도 된다.
    lines = []
    for rid, v in sorted(found.items()):
        if not v or not (v.get("start") or v.get("end") or v.get("wd")):
            continue
        city = v.get("city") or ""
        lines.append(
            "UPDATE bus_routes SET "
            f"start_time={q(v.get('start'))}, end_time={q(v.get('end'))}, "
            f"itv_wd={v.get('wd') or 'NULL'}, itv_sat={v.get('sat') or 'NULL'}, "
            f"itv_sun={v.get('sun') or 'NULL'}, hours_at={q(now)} "
            f"WHERE route_id={q(rid)}" + (f" AND city_code={q(city)}" if city else "") + ";")

    # wrangler 는 한 파일에 2만 문장을 넣으면 타임아웃 난다. 조각내서 낸다.
    base = args.out[:-4] if args.out.endswith(".sql") else args.out
    files, i = [], 0
    while i < len(lines):
        part = lines[i:i + args.chunk]
        fn = f"{base}.{len(files)+1:03d}.sql"
        with open(fn, "w", encoding="utf-8") as f:
            f.write("-- load-bus-hours.py 생성 · " + now + "\n")
            f.write("\n".join(part) + "\n")
        files.append(fn); i += args.chunk
    if not files:                      # 빈 결과여도 파일 하나는 만든다
        fn = f"{base}.001.sql"
        open(fn, "w", encoding="utf-8").write("-- 적재할 내용 없음 · " + now + "\n")
        files.append(fn)

    miss = (len(want) - len(lines)) if want else 0
    if bad:
        print("건너뛴 도시:", ", ".join(bad))
    print(f"\nAPI 호출 {calls}회 · 적재 대상 {len(lines)}개 · 못 채운 노선 {miss}개")
    print("SQL 파일:", ", ".join(files))


if __name__ == "__main__":
    main()
