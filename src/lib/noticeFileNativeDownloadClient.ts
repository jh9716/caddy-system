"use client";

import { Capacitor, registerPlugin } from "@capacitor/core";
import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import {
  NOTICE_FILE_NATIVE_PLUGIN_NAME,
  confirmNativeNoticeDownloadResult,
  nativeNoticeDownloadErrorCode,
  nativeNoticeDownloadFilename,
  nativeNoticeDownloadUserMessage,
  noticeFileDownloadMode,
  noticeFileNativeDownloadPath,
  type NativeNoticeDownloadResult,
} from "@/lib/noticeFileNativeDownload";

type NoticeFileDownloadPlugin = {
  download: (opts: {
    path: string;
    filename: string;
  }) => Promise<{ saved?: boolean; displayName?: string }>;
};

const NoticeFileDownload = registerPlugin<NoticeFileDownloadPlugin>(
  NOTICE_FILE_NATIVE_PLUGIN_NAME
);

export function isNoticeFileDownloadPluginAvailable(): boolean {
  try {
    return Capacitor.isPluginAvailable(NOTICE_FILE_NATIVE_PLUGIN_NAME) === true;
  } catch {
    return false;
  }
}

export async function downloadNoticeFileOnNative(input: {
  noticeId: number;
  fileId: number;
  originalName: string;
  mimeType?: string;
}): Promise<NativeNoticeDownloadResult> {
  const mode = noticeFileDownloadMode({
    isNativePlatform: true,
    pluginAvailable: isNoticeFileDownloadPluginAvailable(),
  });
  if (mode === "missing_plugin") {
    throw new Error(nativeNoticeDownloadUserMessage("unavailable"));
  }
  const path = noticeFileNativeDownloadPath(input.noticeId, input.fileId);
  const filename = nativeNoticeDownloadFilename(input.originalName, input.mimeType);
  if (!path || !filename) {
    throw new Error(nativeNoticeDownloadUserMessage("invalid_url"));
  }
  try {
    const result = await NoticeFileDownload.download({ path, filename });
    return confirmNativeNoticeDownloadResult(result);
  } catch (error) {
    const code = nativeNoticeDownloadErrorCode(error);
    if (code === "unauthorized") {
      consumeUnauthorizedMemberResponse({ status: 401 });
    }
    throw new Error(nativeNoticeDownloadUserMessage(code));
  }
}
