"use client";

import { registerPlugin } from "@capacitor/core";
import {
  KAKAO_NATIVE_PLUGIN_NAME,
  type KakaoNativeLoginResult,
} from "@/lib/kakaoNativeBridge";

type KakaoNativeAuthPlugin = {
  login: () => Promise<KakaoNativeLoginResult>;
};

export const KakaoNativeAuth = registerPlugin<KakaoNativeAuthPlugin>(
  KAKAO_NATIVE_PLUGIN_NAME
);
