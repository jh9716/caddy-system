package kr.verthill.caddy.kakao;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Capacitor bridge for Kakao Android SDK login.
 *
 * This step does not call KakaoSdk.init / loginWithKakaoTalk /
 * loginWithKakaoAccount. Those land after Kakao Developers registration.
 * Never log or persist an access token.
 */
@CapacitorPlugin(name = "KakaoNativeAuth")
public class KakaoNativeAuthPlugin extends Plugin {

    @PluginMethod
    public void login(PluginCall call) {
        call.unimplemented("native kakao login not wired");
    }
}
