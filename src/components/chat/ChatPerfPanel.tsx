"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { chatPerf, chatPerfEnabled, chatPerfText, getChatPerfState, initChatPerf, kindLabel, netPerfLine, serverPerfLine, subscribeChatPerf } from "@/lib/chatPerfDiag";

const empty = getChatPerfState();
const f = (v: number | null) => (v == null ? "-" : String(v));

/** Preview + ?chatPerf=1 에서만 렌더. 그 외에는 null. */
export default function ChatPerfPanel() {
  const [on, setOn] = useState(false);
  const [open, setOpen] = useState(true);
  useEffect(() => { setOn(initChatPerf()); }, []);
  const s = useSyncExternalStore(subscribeChatPerf, getChatPerfState, () => empty);
  if (!on || !chatPerfEnabled()) return null;
  const copy = () => { try { void navigator.clipboard?.writeText(chatPerfText(s)); } catch { /* ignore */ } };
  return (
    <div style={{ position: "fixed", right: 6, bottom: 70, zIndex: 9999, background: "rgba(0,0,0,.82)", color: "#fff", font: "11px/1.35 monospace", padding: 6, borderRadius: 6, maxWidth: "94vw", pointerEvents: "auto" }} data-chat-perf-panel>
      <div style={{ display: "flex", gap: 6 }}>
        <b>chatPerf(ms)</b>
        <button type="button" onClick={() => setOpen(!open)}>{open ? "접기" : "펴기"}</button>
        <button type="button" onClick={copy}>복사</button>
        <button type="button" onClick={() => chatPerf.clear()}>지우기</button>
      </div>
      {open ? (
        <table><thead><tr><th>#</th><th>종류</th><th>토큰</th><th>탭→WS</th><th>WS→hist</th><th>hist→렌더</th><th>전체</th></tr></thead>
          <tbody>
            {s.entries.map((e) => (
              <tr key={e.n}><td>{e.n}</td><td>{kindLabel(e.kind)}{e.ok ? "" : "✗"}</td><td>{f(e.tokenMs)}{e.tokenFetched ? "" : "*"}</td><td>{f(e.tapToOpenMs)}</td><td>{f(e.openToHistoryMs)}</td><td>{f(e.historyToRenderMs)}</td><td><b>{f(e.tapToVisibleMs)}</b></td></tr>
            ))}
            {s.list.map((l) => (<tr key={`l${l.n}`}><td>L{l.n}</td><td>목록</td><td>{f(l.tokenMs)}</td><td colSpan={4}>연결→목록 {f(l.connectToListMs)}</td></tr>))}
          </tbody></table>
      ) : null}
      {open ? (s.server || []).map((r) => <div key={`s${r.n}`} style={{ whiteSpace: "normal" }}>{serverPerfLine(r)}</div>) : null}
      {open ? (s.net || []).map((r) => <div key={`n${r.n}`} style={{ whiteSpace: "normal" }}>{netPerfLine(r)}</div>) : null}
    </div>
  );
}
