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
import argparse, json, os, sys, time, urllib.parse, urllib.request

BASE = "http://apis.data.go.kr/1613000/BusRouteInfoInqireService"
PAGE = 1000          # 명세상 페이지당 최대
SLEEP = 0.12         # 초당 30tps 상한을 넉넉히 밑돈다


def call(op, params, key, tries=3):
    q = dict(params); q["serviceKey"] = key; q["_type"] = "json"
    url = BASE + "/" + op + "?" + urllib.parse.urlencode(q, safe="%")
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=20) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            last = e
            time.sleep(0.6 * (i + 1))
    raise RuntimeError(f"{op} 실패: {last}")


def items_of(js):
    """TAGO 응답은 항목이 1개면 dict, 여러 개면 list 로 온다."""
    try:
        body = js["response"]["body"]
    except Exception:
        return []
    it = (body.get("items") or {})
    if not it:
        return []
    it = it.get("item", [])
    if isinstance(it, dict):
        return [it]
    return it or []


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
    ap.add_argument("--routes", required=True, help="D1 에서 뽑은 route_key 목록(json)")
    ap.add_argument("--out", required=True, help="생성할 SQL 파일")
    ap.add_argument("--interval", action="store_true", help="배차(intervaltime)까지 노선별로 조회")
    ap.add_argument("--max-calls", type=int, default=9000, help="일일 트래픽 여유분")
    args = ap.parse_args()

    key = os.environ.get("TAGO_KEY", "").strip()
    if not key:
        sys.exit("TAGO_KEY 환경변수가 없습니다")

    rows = json.load(open(args.routes, encoding="utf-8"))
    if isinstance(rows, dict):                 # wrangler 출력 형태 흡수
        rows = rows.get("results") or rows.get("rows") or []
    want = {}                                   # route_key -> (city, routeid)
    for r in rows:
        rk = r["route_key"] if isinstance(r, dict) else str(r)
        if "_" not in rk:
            continue
        city, rid = rk.split("_", 1)
        if city.isdigit():
            want[rk] = (city, rid)
    cities = sorted({c for c, _ in want.values()})
    print(f"노선 {len(want)}개 / 도시 {len(cities)}곳: {', '.join(cities)}")

    calls = 0
    found = {}                                  # routeid -> dict(start,end,itv...)

    # ── 1단계: 도시별 노선목록 (첫차·막차) ──────────────────────────
    for city in cities:
        page = 1
        while True:
            if calls >= args.max_calls:
                print("트래픽 상한 도달 — 여기까지만 적재합니다"); break
            js = call("getRouteNoList", {"cityCode": city, "numOfRows": PAGE, "pageNo": page}, key)
            calls += 1; time.sleep(SLEEP)
            its = items_of(js)
            for d in its:
                rid = pick(d, "routeid", "routeId")
                if not rid:
                    continue
                found[str(rid)] = {
                    "start": hhmm(pick(d, "startvehicletime", "startVehicleTime")),
                    "end":   hhmm(pick(d, "endvehicletime", "endVehicleTime")),
                    "wd":  num(pick(d, "intervaltime", "intervalTime")),
                    "sat": num(pick(d, "intervalsaturtime", "intervalSaturTime")),
                    "sun": num(pick(d, "intervalsuntime", "intervalSunTime")),
                }
            total = 0
            try: total = int(js["response"]["body"].get("totalCount") or 0)
            except Exception: pass
            print(f"  [{city}] page {page}: {len(its)}행 (누적 {len(found)} / 전체 {total})")
            if len(its) < PAGE or page * PAGE >= total:
                break
            page += 1

    # ── 2단계: 배차가 비어 있는 노선만 개별 조회 ────────────────────
    if args.interval:
        need = [(rk, c, r) for rk, (c, r) in want.items()
                if not (found.get(r, {}) or {}).get("wd")]
        print(f"배차 미확보 {len(need)}개 — 개별 조회 (남은 트래픽 {args.max_calls - calls})")
        for rk, city, rid in need:
            if calls >= args.max_calls:
                print("트래픽 상한 도달 — 배차는 여기까지"); break
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
    n = 0
    with open(args.out, "w", encoding="utf-8") as f:
        f.write("-- load-bus-hours.py 생성 · " + now + "\n")
        for rk, (city, rid) in sorted(want.items()):
            v = found.get(rid)
            if not v or not (v.get("start") or v.get("end") or v.get("wd")):
                continue
            f.write(
                "UPDATE bus_routes SET "
                f"start_time={q(v.get('start'))}, end_time={q(v.get('end'))}, "
                f"itv_wd={v.get('wd') or 'NULL'}, itv_sat={v.get('sat') or 'NULL'}, "
                f"itv_sun={v.get('sun') or 'NULL'}, hours_at={q(now)} "
                f"WHERE route_key={q(rk)};\n")
            n += 1
    miss = len(want) - n
    print(f"\nAPI 호출 {calls}회 · 적재 대상 {n}개 · 못 채운 노선 {miss}개")
    print(f"→ {args.out}")
    print("적용:  npx wrangler d1 execute subway-db --remote --file=" + args.out)


if __name__ == "__main__":
    main()
