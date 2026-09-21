package kr.verthill.caddy;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;
import kr.verthill.caddy.kakao.KakaoNativeAuthPlugin;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(KakaoNativeAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
