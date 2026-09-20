"use client";

import PushNotificationCard from "@/components/PushNotificationCard";
import {
  ADMIN_PUSH_UI_DISABLE,
  ADMIN_PUSH_UI_DISABLE_HINT,
  ADMIN_PUSH_UI_ENABLE,
  ADMIN_PUSH_UI_TITLE,
  adminPushSurfaceStatus,
} from "@/lib/adminPushNotificationUi";

export default function ManageNotificationsPage() {
  return (
    <div className="pt-page">
      <header className="pt-head">
        <h1 className="pt-title">{ADMIN_PUSH_UI_TITLE}</h1>
        <p className="pt-sub">이 관리자 기기에 새 코스 제보 알림을 받습니다.</p>
      </header>
      <PushNotificationCard
        title={ADMIN_PUSH_UI_TITLE}
        enableLabel={ADMIN_PUSH_UI_ENABLE}
        disableLabel={ADMIN_PUSH_UI_DISABLE}
        disableHint={ADMIN_PUSH_UI_DISABLE_HINT}
        statusText={adminPushSurfaceStatus}
      />
      <style>{`
        .pt-page { max-width: 720px; padding-bottom: 24px; }
        .pt-head { margin-bottom: 16px; }
        .pt-title {
          margin: 0; font-size: 1.35rem; font-weight: 800;
          color: var(--vh-green-900);
        }
        .pt-sub { margin: 4px 0 0; font-size: 0.8rem; color: var(--vh-muted); }
      `}</style>
    </div>
  );
}
