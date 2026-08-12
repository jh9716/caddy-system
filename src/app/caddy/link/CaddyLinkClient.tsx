"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  resolveStaffLinkUiMode,
  staffLinkErrorMessage,
  type MineLinkPayload,
  type StaffLinkRequestView,
} from "@/lib/caddyLinkRequestUi";

export default function CaddyLinkClient() {
  const router = useRouter();
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [mine, setMine] = useState<MineLinkPayload | null>(null);

  const applyMine = useCallback(
    (data: MineLinkPayload) => {
      setMine(data);
      const mode = resolveStaffLinkUiMode(data);
      if (mode === "redirect_caddy") {
        router.replace("/caddy");
      }
      return mode;
    },
    [router]
  );

  const refreshMine = useCallback(async () => {
    const res = await fetch("/api/caddy-link-requests/mine", {
      credentials: "include",
      cache: "no-store",
    });
    if (res.status === 401) {
      router.replace("/login?callbackUrl=/caddy/link");
      return null;
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        staffLinkErrorMessage(data?.error, data?.message) || "조회 실패"
      );
    }
    const payload: MineLinkPayload = {
      linked: !!data.linked,
      caddyId: data.caddyId ?? null,
      request: data.request ?? null,
    };
    applyMine(payload);
    return payload;
  }, [applyMine, router]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const roleRes = await fetch("/api/check-role", {
          credentials: "include",
          cache: "no-store",
        });
        const roleData = await roleRes.json().catch(() => ({}));
        if (roleData.role !== "caddy") {
          router.replace("/login?callbackUrl=/caddy/link");
          return;
        }
        await refreshMine();
      } catch (e: any) {
        if (!cancelled) {
          setError(e?.message || "정보를 불러오지 못했습니다.");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshMine, router]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const res = await fetch("/api/caddy-link-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ name, phone }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(staffLinkErrorMessage(data?.error, data?.message));
        if (data?.error === "already_linked" || data?.error === "pending_exists") {
          await refreshMine();
        }
        return;
      }
      setPhone(""); // 원문 입력값 화면에서 제거 — 이후 masked만 표시
      const request = data.request as StaffLinkRequestView;
      applyMine({
        linked: false,
        caddyId: null,
        request,
      });
    } catch {
      setError("요청 전송에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  const onCancel = async () => {
    const req = mine?.request;
    if (!req || req.status !== "PENDING") return;
    if (!window.confirm("승인 대기 중인 요청을 취소할까요?")) return;
    setError("");
    setBusy(true);
    try {
      const res = await fetch(`/api/caddy-link-requests/${req.id}/cancel`, {
        method: "POST",
        credentials: "include",
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(staffLinkErrorMessage(data?.error, data?.message));
        await refreshMine();
        return;
      }
      setName("");
      setPhone("");
      applyMine({
        linked: false,
        caddyId: null,
        request: data.request ?? null,
      });
    } catch {
      setError("취소에 실패했습니다. 잠시 후 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  if (loading || !mine) {
    return (
      <p className="mt-16 text-center text-slate-500">불러오는 중…</p>
    );
  }

  const mode = resolveStaffLinkUiMode(mine);
  if (mode === "redirect_caddy") {
    return (
      <p className="mt-16 text-center text-slate-500">대시보드로 이동 중…</p>
    );
  }

  const request = mine.request;

  return (
    <div className="mx-auto max-w-md">
      <h1 className="mb-2 text-xl font-bold text-slate-900">캐디 본인확인</h1>
      <p className="mb-6 text-sm leading-relaxed text-slate-600">
        카카오 계정과 캐디 정보를 연결하려면 이름과 휴대폰번호를 제출해 주세요.
        관리자 승인 후 이용할 수 있습니다.
      </p>

      {error && (
        <div
          className="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700"
          role="alert"
        >
          {error}
        </div>
      )}

      {mode === "pending" && request && (
        <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="mb-1 text-sm font-semibold text-amber-700">
            관리자 승인 대기 중
          </p>
          <p className="mb-4 text-sm text-slate-600">
            제출하신 정보로 승인 대기 중입니다. 승인이 완료되면 캐디 메뉴를 이용할
            수 있습니다.
          </p>
          <dl className="mb-5 space-y-2 text-sm">
            <div className="flex justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">제출 이름</dt>
              <dd className="font-medium text-slate-900">{request.submittedName}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">휴대폰</dt>
              <dd className="font-medium text-slate-900">
                {request.maskedPhone || "010-****-****"}
              </dd>
            </div>
          </dl>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="w-full rounded-lg border border-slate-300 px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-60"
          >
            {busy ? "처리 중…" : "요청 취소"}
          </button>
        </div>
      )}

      {mode === "rejected" && request && (
        <div className="mb-5 rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
          <p className="mb-1 text-sm font-semibold text-red-700">요청이 반려되었습니다</p>
          <p className="mb-3 text-sm text-slate-600">
            아래 내용을 확인한 뒤 다시 신청할 수 있습니다.
          </p>
          <dl className="mb-3 space-y-2 text-sm">
            <div className="flex justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">제출 이름</dt>
              <dd className="font-medium text-slate-900">{request.submittedName}</dd>
            </div>
            <div className="flex justify-between gap-3 border-b border-slate-100 py-2">
              <dt className="text-slate-500">휴대폰</dt>
              <dd className="font-medium text-slate-900">
                {request.maskedPhone || "010-****-****"}
              </dd>
            </div>
            {request.decisionNote ? (
              <div className="py-2">
                <dt className="mb-1 text-slate-500">안내</dt>
                <dd className="text-slate-800">{request.decisionNote}</dd>
              </div>
            ) : null}
          </dl>
        </div>
      )}

      {(mode === "form" || mode === "rejected") && (
        <form
          onSubmit={onSubmit}
          className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm"
        >
          {mode === "rejected" && (
            <p className="mb-4 text-sm font-medium text-slate-800">다시 신청하기</p>
          )}
          {mode === "form" && request?.status === "CANCELLED" && (
            <p className="mb-4 text-sm text-slate-600">
              이전 요청이 취소되었습니다. 필요하면 다시 신청해 주세요.
            </p>
          )}

          <label className="mb-1 block text-sm text-slate-700" htmlFor="link-name">
            이름
          </label>
          <input
            id="link-name"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="mb-4 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
            autoComplete="name"
            required
            disabled={busy}
            placeholder="캐디 등록 이름과 동일하게"
          />

          <label className="mb-1 block text-sm text-slate-700" htmlFor="link-phone">
            휴대폰번호
          </label>
          <input
            id="link-phone"
            name="phone"
            type="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            className="mb-2 w-full rounded-lg border border-slate-300 px-3 py-2 outline-none focus:ring-2 focus:ring-slate-300"
            autoComplete="tel"
            required
            disabled={busy}
            placeholder="010-1234-5678"
          />
          <p className="mb-5 text-xs text-slate-500">
            제출 후에는 마스킹된 번호만 화면에 표시됩니다.
          </p>

          <button
            type="submit"
            disabled={busy || !name.trim() || !phone.trim()}
            className="w-full rounded-lg bg-slate-900 px-4 py-2.5 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-60"
          >
            {busy ? "제출 중…" : "본인확인 요청"}
          </button>
        </form>
      )}
    </div>
  );
}
