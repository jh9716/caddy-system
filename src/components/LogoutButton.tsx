"use client";

export default function LogoutButton() {
  const onClick = async () => {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    location.href = "/";
  };

  const onLogoutAll = async () => {
    if (
      !confirm(
        "모든 기기에서 로그아웃할까요?\n다른 휴대폰/PC에 남아 있는 로그인도 즉시 끊깁니다."
      )
    ) {
      return;
    }
    const res = await fetch("/api/auth/logout-all", {
      method: "POST",
      credentials: "include",
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(data?.message || data?.error || "전체 로그아웃에 실패했습니다.");
      return;
    }
    location.href = "/login";
  };

  return (
    <span className="vh-logout-group" style={{ display: "inline-flex", gap: 8 }}>
      <button type="button" onClick={onClick} className="ui-btn ui-btn-ghost">
        로그아웃
      </button>
      <button
        type="button"
        onClick={onLogoutAll}
        className="ui-btn ui-btn-ghost"
        title="이 계정의 모든 기기 세션 종료"
      >
        모든 기기 로그아웃
      </button>
    </span>
  );
}
