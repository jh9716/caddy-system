package kr.verthill.caddy.kakao;

import android.app.Activity;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.kakao.sdk.auth.TokenManagerProvider;
import com.kakao.sdk.auth.model.OAuthToken;
import com.kakao.sdk.common.model.ApiError;
import com.kakao.sdk.common.model.ApiErrorCause;
import com.kakao.sdk.common.model.AppsError;
import com.kakao.sdk.common.model.AuthError;
import com.kakao.sdk.common.model.ClientError;
import com.kakao.sdk.common.model.ClientErrorCause;
import com.kakao.sdk.user.UserApiClient;
import kr.verthill.caddy.R;
import kotlin.Unit;

/**
 * Capacitor bridge for Kakao Android SDK login.
 * Returns accessToken in memory only. Never logs or persists the token.
 * Failure diagnostics are allowlisted enum/class names only.
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
                if (isUserCancelled(error)) {
                    call.reject("kakao_denied", "kakao_denied");
                    return Unit.INSTANCE;
                }
                String diagnostic = safeDiagnostic("account", error);
                call.reject(diagnostic, "kakao_token");
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
            call.reject(safeTokenEmptyDiagnostic("token-null"), "kakao_token");
            return;
        }
        String accessToken = token.getAccessToken();
        if (accessToken == null || accessToken.isEmpty()) {
            call.reject(safeTokenEmptyDiagnostic("access-empty"), "kakao_token");
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

    static String safeTokenEmptyDiagnostic(String detail) {
        return "kakao_native_token-empty: empty / " + safeToken(detail, "unknown");
    }

    static String safeDiagnostic(String stage, Throwable error) {
        return "kakao_native_"
            + safeToken(stage, "unknown")
            + ": "
            + safeTypeName(error)
            + " / "
            + safeReason(error);
    }

    private static String safeTypeName(Throwable error) {
        if (error == null) {
            return "unknown";
        }
        return safeToken(error.getClass().getSimpleName(), "unknown");
    }

    private static String safeReason(Throwable error) {
        if (error instanceof ClientError) {
            return safeToken(((ClientError) error).getReason().name(), "Unknown");
        }
        if (error instanceof AuthError) {
            return safeToken(((AuthError) error).getReason().name(), "Unknown");
        }
        if (error instanceof ApiError) {
            ApiErrorCause cause = ((ApiError) error).getReason();
            return safeToken(cause.name(), "Unknown") + "/" + cause.getErrorCode();
        }
        if (error instanceof AppsError) {
            return safeToken(((AppsError) error).getReason().name(), "Unknown");
        }
        return "unknown";
    }

    private static String safeToken(String value, String fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            boolean ok =
                (c >= 'A' && c <= 'Z')
                    || (c >= 'a' && c <= 'z')
                    || (c >= '0' && c <= '9')
                    || c == '_'
                    || c == '-'
                    || c == '.';
            if (!ok) {
                return fallback;
            }
        }
        if (value.length() > 64) {
            return fallback;
        }
        return value;
    }
}
