package kr.verthill.caddy.kakao;

import android.app.Activity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.kakao.sdk.auth.TokenManagerProvider;
import com.kakao.sdk.auth.model.OAuthToken;
import com.kakao.sdk.common.model.ClientError;
import com.kakao.sdk.common.model.ClientErrorCause;
import com.kakao.sdk.user.UserApiClient;
import kr.verthill.caddy.R;
import kotlin.Unit;

/**
 * Capacitor bridge for Kakao Android SDK login.
 * Returns accessToken in memory only. Never logs or persists the token.
 */
@CapacitorPlugin(name = "KakaoNativeAuth")
public class KakaoNativeAuthPlugin extends Plugin {

    @PluginMethod
    public void login(PluginCall call) {
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("no activity", "kakao_config");
            return;
        }
        String key = activity.getString(R.string.kakao_native_app_key);
        if (key == null || key.isEmpty()) {
            call.reject("kakao native app key missing", "kakao_config");
            return;
        }

        if (UserApiClient.getInstance().isKakaoTalkLoginAvailable(activity)) {
            UserApiClient.getInstance().loginWithKakaoTalk(activity, (token, error) -> {
                if (error != null) {
                    if (isUserCancelled(error)) {
                        call.reject("kakao_denied", "kakao_denied");
                        return Unit.INSTANCE;
                    }
                    loginWithAccount(activity, call);
                    return Unit.INSTANCE;
                }
                resolveToken(call, token);
                return Unit.INSTANCE;
            });
            return;
        }

        loginWithAccount(activity, call);
    }

    private void loginWithAccount(Activity activity, PluginCall call) {
        UserApiClient.getInstance().loginWithKakaoAccount(activity, (token, error) -> {
            if (error != null) {
                String code = isUserCancelled(error) ? "kakao_denied" : "kakao_token";
                call.reject(code, code);
                return Unit.INSTANCE;
            }
            resolveToken(call, token);
            return Unit.INSTANCE;
        });
    }

    private static boolean isUserCancelled(Throwable error) {
        return error instanceof ClientError
            && ((ClientError) error).getReason() == ClientErrorCause.Cancelled;
    }

    private void resolveToken(PluginCall call, OAuthToken token) {
        if (token == null) {
            call.reject("kakao_token", "kakao_token");
            return;
        }
        String accessToken = token.getAccessToken();
        if (accessToken == null || accessToken.isEmpty()) {
            call.reject("kakao_token", "kakao_token");
            return;
        }
        try {
            TokenManagerProvider.getInstance().getManager().clear();
        } catch (Exception ignored) {
            // Best-effort: do not keep Kakao SDK tokens on device.
        }
        JSObject ret = new JSObject();
        ret.put("accessToken", accessToken);
        call.resolve(ret);
    }
}
