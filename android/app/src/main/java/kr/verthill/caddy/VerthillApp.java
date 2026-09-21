package kr.verthill.caddy;

import android.app.Application;
import com.kakao.sdk.common.KakaoSdk;

public class VerthillApp extends Application {

    @Override
    public void onCreate() {
        super.onCreate();
        String key = getString(R.string.kakao_native_app_key);
        if (key != null && !key.isEmpty()) {
            KakaoSdk.init(this, key);
            KakaoSdk.INSTANCE.setLoggingEnabled(false);
        }
    }
}
