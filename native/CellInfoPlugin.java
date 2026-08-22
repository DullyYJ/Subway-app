package com.dullyyj.subway;

import android.Manifest;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.telephony.CellIdentityGsm;
import android.telephony.CellIdentityLte;
import android.telephony.CellIdentityNr;
import android.telephony.CellIdentityWcdma;
import android.telephony.CellInfo;
import android.telephony.CellInfoGsm;
import android.telephony.CellInfoLte;
import android.telephony.CellInfoNr;
import android.telephony.CellInfoWcdma;
import android.telephony.TelephonyManager;

import androidx.core.content.ContextCompat;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.List;

/**
 * 기지국(Cell ID) 조회 플러그인 — 지하 구간 보조 측위용.
 *
 * 설계 원칙: 어떤 상황에서도 예외를 던지지 않는다.
 *   권한이 없거나, 통신 모듈이 없거나, 기기가 값을 안 주면
 *   빈 배열을 돌려주고 앱은 조용히 기존 로직으로 동작한다.
 *
 * 반환 형식:
 *   { cells: [ { type, mcc, mnc, tac, cid, pci, dbm, registered } ] }
 *     type       "lte" | "nr" | "wcdma" | "gsm"
 *     mcc/mnc    통신사 식별 (숫자, 모르면 생략)
 *     tac        LTE/NR: TAC,  WCDMA/GSM: LAC
 *     cid        셀 식별자 (LTE: CI, NR: NCI, WCDMA/GSM: CID)
 *     pci        물리 셀 ID — cid 를 못 받았을 때의 대체 식별자
 *     dbm        신호 세기 (음수, 클수록 강함)
 *     registered 지금 실제로 붙어 있는 셀인지
 */
@CapacitorPlugin(
    name = "CellInfo",
    permissions = {}   // 위치 권한은 앱이 이미 별도로 요청/보유한다
)
public class CellInfoPlugin extends Plugin {

    @PluginMethod
    public void getCurrent(PluginCall call) {
        JSObject ret = new JSObject();
        JSArray cells = new JSArray();

        try {
            Context ctx = getContext();
            if (ctx == null) { ret.put("cells", cells); call.resolve(ret); return; }

            // 위치 권한이 없으면 조회 자체가 SecurityException 이므로 미리 확인한다.
            boolean fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            boolean coarse = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_COARSE_LOCATION)
                    == PackageManager.PERMISSION_GRANTED;
            if (!fine && !coarse) {
                ret.put("cells", cells);
                ret.put("reason", "no-location-permission");
                call.resolve(ret);
                return;
            }

            TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
            if (tm == null) {
                ret.put("cells", cells);
                ret.put("reason", "no-telephony");
                call.resolve(ret);
                return;
            }

            List<CellInfo> list = null;
            try {
                list = tm.getAllCellInfo();
            } catch (SecurityException se) {
                ret.put("cells", cells);
                ret.put("reason", "security");
                call.resolve(ret);
                return;
            } catch (Throwable t) {
                // 일부 기기에서 내부 예외가 나는 사례가 보고돼 있어 통째로 막는다
                list = null;
            }

            if (list != null) {
                for (CellInfo ci : list) {
                    JSObject o = toJs(ci);
                    if (o != null) cells.put(o);
                }
            }

            ret.put("cells", cells);
            call.resolve(ret);

        } catch (Throwable t) {
            // 무슨 일이 있어도 앱을 멈추지 않는다
            try {
                ret.put("cells", new JSArray());
                ret.put("reason", "error");
                call.resolve(ret);
            } catch (Throwable ignored) {
                call.resolve(new JSObject());
            }
        }
    }

    /** 최신 셀 정보를 요청한다. Android 10+ 는 캐시만 주므로 갱신을 따로 요청해야 한다.
     *  (rate-limit 이 걸려 있어 매번 갱신되지는 않는다 — 실패해도 무해하다) */
    @PluginMethod
    public void requestUpdate(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            if (ctx != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                TelephonyManager tm = (TelephonyManager) ctx.getSystemService(Context.TELEPHONY_SERVICE);
                boolean fine = ContextCompat.checkSelfPermission(ctx, Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
                if (tm != null && fine) {
                    tm.requestCellInfoUpdate(ctx.getMainExecutor(),
                        new TelephonyManager.CellInfoCallback() {
                            @Override public void onCellInfo(List<CellInfo> cellInfo) { /* 캐시 갱신만 */ }
                        });
                }
            }
        } catch (Throwable ignored) { }
        ret.put("ok", true);
        call.resolve(ret);
    }

    // ── CellInfo → JS 객체 ───────────────────────────────────────────
    private JSObject toJs(CellInfo ci) {
        if (ci == null) return null;
        try {
            JSObject o = new JSObject();
            o.put("registered", ci.isRegistered());

            if (ci instanceof CellInfoLte) {
                CellInfoLte c = (CellInfoLte) ci;
                CellIdentityLte id = c.getCellIdentity();
                o.put("type", "lte");
                putInt(o, "cid", id.getCi());
                putInt(o, "tac", id.getTac());
                putInt(o, "pci", id.getPci());
                putMccMnc(o, id.getMccString(), id.getMncString(), id.getMcc(), id.getMnc());
                o.put("dbm", c.getCellSignalStrength().getDbm());
                return o;
            }

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && ci instanceof CellInfoNr) {
                CellInfoNr c = (CellInfoNr) ci;
                CellIdentityNr id = (CellIdentityNr) c.getCellIdentity();
                o.put("type", "nr");
                putLong(o, "cid", id.getNci());
                putInt(o, "tac", id.getTac());
                putInt(o, "pci", id.getPci());
                putMccMnc(o, id.getMccString(), id.getMncString(), Integer.MAX_VALUE, Integer.MAX_VALUE);
                o.put("dbm", c.getCellSignalStrength().getDbm());
                return o;
            }

            if (ci instanceof CellInfoWcdma) {
                CellInfoWcdma c = (CellInfoWcdma) ci;
                CellIdentityWcdma id = c.getCellIdentity();
                o.put("type", "wcdma");
                putInt(o, "cid", id.getCid());
                putInt(o, "tac", id.getLac());
                putInt(o, "pci", id.getPsc());
                putMccMnc(o, id.getMccString(), id.getMncString(), id.getMcc(), id.getMnc());
                o.put("dbm", c.getCellSignalStrength().getDbm());
                return o;
            }

            if (ci instanceof CellInfoGsm) {
                CellInfoGsm c = (CellInfoGsm) ci;
                CellIdentityGsm id = c.getCellIdentity();
                o.put("type", "gsm");
                putInt(o, "cid", id.getCid());
                putInt(o, "tac", id.getLac());
                putMccMnc(o, id.getMccString(), id.getMncString(), id.getMcc(), id.getMnc());
                o.put("dbm", c.getCellSignalStrength().getDbm());
                return o;
            }

            return null;   // 모르는 타입은 버린다
        } catch (Throwable t) {
            return null;
        }
    }

    /** Android 는 값을 모를 때 Integer.MAX_VALUE 를 준다 — 그건 넣지 않는다. */
    private void putInt(JSObject o, String k, int v) {
        if (v != Integer.MAX_VALUE && v != -1) o.put(k, v);
    }
    private void putLong(JSObject o, String k, long v) {
        if (v != Long.MAX_VALUE && v != -1) o.put(k, v);
    }
    /** MCC/MNC 는 API 28+ 에서 문자열, 그 이하는 int. 둘 다 대응한다. */
    private void putMccMnc(JSObject o, String mccStr, String mncStr, int mccInt, int mncInt) {
        try {
            if (mccStr != null && mccStr.length() > 0) o.put("mcc", Integer.parseInt(mccStr));
            else if (mccInt != Integer.MAX_VALUE) o.put("mcc", mccInt);
        } catch (Throwable ignored) { }
        try {
            if (mncStr != null && mncStr.length() > 0) o.put("mnc", Integer.parseInt(mncStr));
            else if (mncInt != Integer.MAX_VALUE) o.put("mnc", mncInt);
        } catch (Throwable ignored) { }
    }
}
