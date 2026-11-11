package kr.verthill.caddy;

import com.getcapacitor.Bridge;

/** Debug-only WebView client. Release twin is a no-op. */
final class DebugWebViewHook {
    private DebugWebViewHook() {}

    static void install(Bridge bridge) {
        if (bridge == null || bridge.getWebView() == null) {
            return;
        }
        bridge.getWebView().setWebViewClient(new DebugPreviewWebViewClient(bridge));
    }
}
