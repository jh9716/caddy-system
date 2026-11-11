package kr.verthill.caddy;

import android.os.Bundle;
import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import kr.verthill.caddy.kakao.KakaoNativeAuthPlugin;
import kr.verthill.caddy.notice.NoticeFileDownloadPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KakaoNativeAuthPlugin.class);
        registerPlugin(NoticeFileDownloadPlugin.class);
        super.onCreate(savedInstanceState);
        Bridge bridge = getBridge();
        if (bridge != null && bridge.getWebView() != null) {
            HeicNativeJpegConverter.cleanupStale(this);
            bridge.getWebView().setWebChromeClient(new VerthillBridgeWebChromeClient(bridge));
        }
    }
}
