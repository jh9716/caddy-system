"use client";

import { useState, type ComponentType } from "react";
import type { AssignmentDraft } from "@/lib/assignmentDraft";

type MenuProps = {
  draft: AssignmentDraft;
  onNotice: (msg: string) => void;
  defaultOpen?: boolean;
};

export function LazyBoardImageExportMenu({
  draft,
  onNotice,
}: {
  draft: AssignmentDraft;
  onNotice: (msg: string) => void;
}) {
  const [Menu, setMenu] = useState<ComponentType<MenuProps> | null>(null);
  const [preparing, setPreparing] = useState(false);

  async function loadMenu() {
    if (Menu || preparing) return;
    setPreparing(true);
    try {
      const [{ BoardImageExportMenu }, { loadHtmlToImage }] = await Promise.all([
        import("@/components/board/BoardImageExportMenu"),
        import("@/lib/assignmentBoardExportPng"),
      ]);
      void loadHtmlToImage();
      setMenu(() => BoardImageExportMenu);
    } catch {
      onNotice("이미지 기능을 불러오지 못했습니다.");
    } finally {
      setPreparing(false);
    }
  }

  if (Menu) {
    return <Menu draft={draft} onNotice={onNotice} defaultOpen />;
  }

  return (
    <div className="bx-export-menu">
      <button
        type="button"
        className="bx-export-btn"
        disabled={preparing}
        aria-haspopup="menu"
        aria-expanded={false}
        data-board-image-export="1"
        onClick={() => void loadMenu()}
      >
        {preparing ? "준비 중…" : "이미지"}
      </button>
      <style>{`
        .bx-export-menu { position: relative; }
        .bx-export-btn {
          min-height: 32px;
          padding: 0 10px;
          border-radius: 8px;
          border: 1px solid #cbd5e1;
          background: #fff;
          color: #0f172a;
          font-size: 0.78rem;
          font-weight: 700;
          cursor: pointer;
          white-space: nowrap;
        }
        .bx-export-btn:disabled { opacity: 0.55; cursor: wait; }
      `}</style>
    </div>
  );
}
