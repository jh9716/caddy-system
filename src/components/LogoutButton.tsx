"use client";

export default function LogoutButton() {
  const onClick = async () => {
    await fetch("/api/logout", { method: "POST", credentials: "include" });
    location.href = "/";
  };
  return (
    <button type="button" onClick={onClick} className="ui-btn ui-btn-ghost">
      로그아웃
    </button>
  );
}
