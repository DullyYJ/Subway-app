package com.dullyyj.subway;   // ★ MainActivity.java 첫 줄과 같아야 한다

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Rational;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 작은 요약 화면(PiP) 플러그인.
 *
 * 2026-09-08 개정 이유
 * ────────────────────
 * ① PiP 가 아예 안 뜨는 문제
 *    예전 구조는 setActive() 로 guiding 만 적어 두고, 실제 전환은
 *    MainActivity.onUserLeaveHint() 가 해 주기를 기다렸다.
 *    MainActivity 가 그 코드를 잃어버리면(플랫폼 재생성·cap sync 등)
 *    플러그인은 멀쩡한데 PiP 만 조용히 사라진다.
 *    → 안드로이드 12+ 는 setAutoEnterEnabled(true) 로 시스템이 알아서
 *      전환하게 만든다. MainActivity 에 의존하지 않는다.
 *
 * ② 최근 앱에서 다른 앱이 안 눌리는 문제
 *    onUserLeaveHint() 는 홈뿐 아니라 '최근 앱'으로 나갈 때도 불리는 기기가 있다.
 *    그러면 최근 앱 화면이 열리는 도중에 PiP 로 바뀌면서 태스크가 꼬여
 *    카드가 안 눌린다. autoEnter 는 홈 제스처에서만 동작해서 이 문제가 없다.
 *
 * ③ 크기
 *    시스템 PiP 는 사용자의 확대/축소를 막는 API 가 없다(안드로이드 12+ 핀치).
 *    다만 가로비를 시스템 상한인 2.39:1 로 고정하면 시스템이 허용하는
 *    가장 작은 창이 되고, setSeamlessResizeEnabled(false) 로 늘어지는 것도 막는다.
 */
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {

    /** 안드로이드가 허용하는 최대 가로비(2.39:1). 더 납작하면 진입 자체가 실패한다. */
    private static final int DEF_W = 239, DEF_H = 100;

    /** 웹뷰가 알려 준 "안내 중" 상태. 구버전(11 이하)에서 MainActivity 가 읽는다. */
    public static volatile boolean guiding = false;
    private static volatile int lastW = DEF_W, lastH = DEF_H;

    @PluginMethod
    public void setActive(PluginCall call) {
        guiding = call.getBoolean("active", false);
        lastW = call.getInt("width", DEF_W);
        lastH = call.getInt("height", DEF_H);
        boolean auto = applyParams(getActivity(), guiding, lastW, lastH);
        call.resolve(new JSObject()
                .put("ok", true)
                .put("guiding", guiding)
                .put("autoEnter", auto)          // 12+ 에서 시스템이 알아서 전환하는가
                .put("supported", supported()));
    }

    @PluginMethod
    public void enter(PluginCall call) {
        int w = call.getInt("width", DEF_W);
        int h = call.getInt("height", DEF_H);
        lastW = w; lastH = h;
        call.resolve(new JSObject().put("ok", enterPip(getActivity(), w, h)));
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        call.resolve(new JSObject()
                .put("available", supported())
                .put("autoEnter", Build.VERSION.SDK_INT >= Build.VERSION_CODES.S)
                .put("guiding", guiding));
    }

    private boolean supported() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        PackageManager pm = getContext().getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    // ── 아래 두 개는 MainActivity 에서도 부를 수 있게 static 으로 둔다 ──

    /** 파라미터만 갱신한다. 12+ 면 autoEnter 까지 켜서 홈 제스처에 시스템이 반응하게 한다. */
    public static boolean applyParams(Activity act, boolean active, int w, int h) {
        if (act == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        final boolean auto = Build.VERSION.SDK_INT >= Build.VERSION_CODES.S;
        try {
            final PictureInPictureParams p = build(active, w, h);
            act.runOnUiThread(() -> {
                try { act.setPictureInPictureParams(p); } catch (Exception ignored) {}
            });
            return auto;
        } catch (Exception e) {
            return false;
        }
    }

    /** 구버전(8~11)용. MainActivity.onUserLeaveHint() 에서 부른다. */
    public static boolean enterFromLeaveHint(Activity act) {
        if (!guiding) return false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return false;  // 12+ 는 autoEnter 가 한다
        return enterPip(act, lastW, lastH);
    }

    private static boolean enterPip(Activity act, int w, int h) {
        if (act == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        try {
            return act.enterPictureInPictureMode(build(true, w, h));
        } catch (Exception e) {
            return false;
        }
    }

    private static PictureInPictureParams build(boolean active, int w, int h) {
        PictureInPictureParams.Builder b = new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(Math.max(1, w), Math.max(1, h)));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            b.setAutoEnterEnabled(active);      // 홈 제스처에서만 전환 (최근 앱은 건드리지 않는다)
            b.setSeamlessResizeEnabled(false);  // 늘어지듯 리사이즈 금지
        }
        return b.build();
    }
}
