package kr.verthill.caddy;

import android.net.Uri;
import android.util.Log;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.widget.Toast;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeWebViewClient;
import kr.verthill.caddy.notice.NoticeFileDownloadFlavorHosts;

/**
 * Debug-only: keep Vercel Authentication inside the WebView and never hand
 * unallowed hosts to the system browser. Do not log query, cookies, or tokens.
 */
final class DebugPreviewWebViewClient extends BridgeWebViewClient {
    private static final String TAG = "VerthillPreviewNav";
    private final Bridge bridge;

    DebugPreviewWebViewClient(Bridge bridge) {
        super(bridge);
        this.bridge = bridge;
    }

    @Override
    public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
        Uri url = request.getUrl();
        String scheme = url != null ? url.getScheme() : "";
        String host = url != null && url.getHost() != null ? url.getHost().toLowerCase() : "";
        String path = url != null && url.getPath() != null ? url.getPath() : "/";
        boolean main = request.isForMainFrame();
        boolean redirect = request.isRedirect();
        if ("data".equals(scheme) || "blob".equals(scheme)) {
            log("stay", scheme, "", path, main, redirect);
            return super.shouldOverrideUrlLoading(view, request);
        }
        if (stayInWebView(host)) {
            log("stay", scheme, host, path, main, redirect);
            return super.shouldOverrideUrlLoading(view, request);
        }
        log("block", scheme, host, path, main, redirect);
        if (main && isAuthProviderHost(host) && bridge != null && bridge.getContext() != null) {
            Toast.makeText(
                    bridge.getContext(),
                    R.string.debug_preview_auth_blocked,
                    Toast.LENGTH_LONG)
                .show();
        }
        return true;
    }

    private static boolean stayInWebView(String host) {
        if (host == null || host.isEmpty()) {
            return false;
        }
        if ("vercel.com".equals(host)
            || "www.verthill.kr".equals(host)
            || "verthill.kr".equals(host)) {
            return true;
        }
        return NoticeFileDownloadFlavorHosts.extraAllowed(host);
    }

    private static boolean isAuthProviderHost(String host) {
        return "github.com".equals(host)
            || host.endsWith(".github.com")
            || "accounts.google.com".equals(host)
            || "gitlab.com".equals(host)
            || host.endsWith(".gitlab.com")
            || "chatgpt.com".equals(host)
            || "auth.openai.com".equals(host);
    }

    private static void log(
        String decision,
        String scheme,
        String host,
        String path,
        boolean main,
        boolean redirect
    ) {
        Log.i(
            TAG,
            "nav decision="
                + decision
                + " scheme="
                + scheme
                + " host="
                + host
                + " path="
                + path
                + " main="
                + (main ? "1" : "0")
                + " redirect="
                + (redirect ? "1" : "0")
        );
    }
}
