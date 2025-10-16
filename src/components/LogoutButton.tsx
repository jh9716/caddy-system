"use client";

export default function LogoutButton() {
  const onClick = async () => {
    await fetch("/api/logout", { method: "POST" });
    location.href = "/"; // 새로고침 겸 홈으로
  };
  return (
    <button onClick={onClick} className="rounded-md border px-3 py-1.5 hover:bg-slate-50">
      로그아웃
    </button>
  );
}
