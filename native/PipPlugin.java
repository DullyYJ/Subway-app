package com.dullyyj.subway;   // ★ 앱 패키지명으로 바꿀 것 (MainActivity.java 첫 줄과 같게)

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
 *  - setActive({active}) : 웹뷰가 "지금 길 안내 중"인지 미리 알려 준다.
 *                          홈 버튼을 누르는 순간에는 웹뷰에 물어볼 시간이 없어서,
 *                          이 값을 MainActivity.onUserLeaveHint() 에서 그대로 읽는다.
 *  - enter()             : 지금 즉시 PiP로 전환 (앱이 아직 화면에 있을 때만 동작한다)
 *  - isAvailable()       : 이 기기가 PiP를 지원하는지
 */
@CapacitorPlugin(name = "Pip")
public class PipPlugin extends Plugin {

    /** 웹뷰가 알려 준 "안내 중" 상태. MainActivity 가 읽는다. */
    public static volatile boolean guiding = false;

    @PluginMethod
    public void setActive(PluginCall call) {
        guiding = call.getBoolean("active", false);
        call.resolve(new JSObject().put("ok", true));
    }

    @PluginMethod
    public void enter(PluginCall call) {
        int w = call.getInt("width", 239);
        int h = call.getInt("height", 100);
        call.resolve(new JSObject().put("ok", enterPip(w, h)));
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        call.resolve(new JSObject().put("available", supported()));
    }

    private boolean supported() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return false;
        PackageManager pm = getContext().getPackageManager();
        return pm.hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private boolean enterPip(int w, int h) {
        if (!supported()) return false;
        try {
            PictureInPictureParams params = new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(Math.max(1, w), Math.max(1, h)))
                    .build();
            return getActivity().enterPictureInPictureMode(params);
        } catch (Exception e) {
            return false;
        }
    }
}
