'use client';

import { Fragment, useEffect, useState } from 'react';

type Caddy = { id: number; name: string; team: string; status?: string };
type Note = { id: number; text: string; createdAt?: string };
type Extra = { id: number; tag: string; date?: string };

type PreviewLine = {
  action: 'update' | 'unchanged' | 'create' | 'needsReview' | 'missingInImport';
  id: number | null;
  name: string;
  currentTeam: string | null;
  nextTeam: string | null;
  reason?: string;
};

type ImportPreview = {
  summary: {
    update: number;
    unchanged: number;
    new: number;
    needsReview: number;
    missingInImport: number;
  };
  updates: Array<{ id: number; name: string; currentTeam: string; nextTeam: string }>;
  creates: Array<{ name: string; team: string; rowNumber: number }>;
  needsReview: Array<{ name: string; team: string; rowNumber: number; reason: string; candidateIds?: number[] }>;
  missingInImport: Array<{ id: number; name: string; team: string }>;
  lines: PreviewLine[];
  applyPayload: {
    updates: Array<{ id: number; team: string }>;
    creates: Array<{ name: string; team: string }>;
  };
  touchesEmploymentStatus: false;
};

const ACTION_LABEL: Record<PreviewLine['action'], string> = {
  update: 'update (조 변경)',
  unchanged: 'unchanged',
  create: 'create (신규)',
  needsReview: 'needsReview (확인 필요)',
  missingInImport: 'missingInImport (명단 없음)',
};

export default function ManageCaddiesPage() {
  const [rows, setRows] = useState<Caddy[]>([]);
  const [loading, setLoading] = useState(false);

  const [newTeam, setNewTeam] = useState('');
  const [newName, setNewName] = useState('');

  const [importFile, setImportFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [importBusy, setImportBusy] = useState(false);

  // 펼쳐진 행(id)
  const [openId, setOpenId] = useState<number | null>(null);

  // 메모/엑스트라
  const [noteList, setNoteList] = useState<Note[]>([]);
  const [extraList, setExtraList] = useState<Extra[]>([]);
  const [newNote, setNewNote] = useState('');

  // 기간 지정 폼
  const [assignType, setAssignType] = useState<'OFF' | 'SICK' | 'LONG_SICK' | 'FAMILY_EVENT' | 'DUTY' | 'MARSHAL'>('OFF');
  const [startDate, setStartDate] = useState<string>('');
  const [endDate, setEndDate] = useState<string>('');

  async function load() {
    setLoading(true);
    try {
      const res = await fetch('/api/caddies', { cache: 'no-store' });
      const data = await res.json();
      setRows(Array.isArray(data) ? data : []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  // 안전 JSON 파서(404/빈본문/HTML 응답 방지)
  async function safeJson(res: Response | null) {
    if (!res) return [];
    if (!res.ok) return [];
    const ct = res.headers.get('content-type') || '';
    if (!ct.includes('application/json')) return [];
    const text = await res.text();
    if (!text) return [];
    try { return JSON.parse(text); } catch { return []; }
  }

  async function openLists(c: Caddy) {
    // 토글 오픈
    const willOpen = openId !== c.id;
    setOpenId(willOpen ? c.id : null);
    if (!willOpen) return;

    // 초기화
    setNoteList([]);
    setExtraList([]);
    setNewNote('');
    setAssignType('OFF');
    setStartDate('');
    setEndDate('');

    try {
      const [resN, resE] = await Promise.all([
        fetch(`/api/caddies/${c.id}/notes`, { cache: 'no-store' }),
        // /extras 엔드포인트는 아직 없어도 무시
        fetch(`/api/caddies/${c.id}/extras`, { cache: 'no-store' }).catch(() => null),
      ]);
      const [notes, extras] = await Promise.all([safeJson(resN), safeJson(resE)]);
      setNoteList(Array.isArray(notes) ? notes : []);
      setExtraList(Array.isArray(extras) ? extras : []);
    } catch {
      setNoteList([]);
      setExtraList([]);
    }
  }

  async function add() {
    if (!newTeam || !newName) return alert('팀과 이름을 입력하세요.');
    const res = await fetch('/api/caddies', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ team: newTeam, name: newName }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data?.error || '추가 실패');
    setNewName(''); setNewTeam('');
    await load();
  }

  async function remove(id: number) {
    if (!confirm('정말 삭제하시겠습니까?')) return;
    const res = await fetch(`/api/caddies?id=${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data?.error || '삭제 실패');
    if (openId === id) {
      setOpenId(null);
      setNoteList([]);
      setExtraList([]);
    }
    await load();
  }

  async function saveNote() {
    if (!openId) return;
    if (!newNote.trim()) return;
    const res = await fetch(`/api/caddies/${openId}/notes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: newNote.trim() }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data?.error || '메모 저장 실패');
    setNewNote('');
    // 다시 로드
    const resN = await fetch(`/api/caddies/${openId}/notes`, { cache: 'no-store' });
    const notes = await safeJson(resN);
    setNoteList(Array.isArray(notes) ? notes : []);
  }

  async function deleteNote(noteId: number) {
    if (!openId) return;
    const res = await fetch(`/api/caddies/${openId}/notes?noteId=${noteId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) return alert(data?.error || '메모 삭제 실패');
    setNoteList(prev => prev.filter(n => n.id !== noteId));
  }

  // 기간 지정 저장
  async function saveAssignment() {
    if (!openId) return alert('캐디가 선택되지 않았습니다.');
    if (!assignType || !startDate || !endDate) return alert('유형과 기간을 입력하세요.');

    const res = await fetch('/api/assignments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ⚠️ 현재 Prisma 모델엔 subType/comment가 없다면 보내지 않음(오류 방지)
      body: JSON.stringify({
        caddyId: openId,
        type: assignType,
        startDate,
        endDate,
      }),
    });
    const data = await res.json();
    if (!res.ok) return alert(data?.error || '기간 지정 실패');

    alert('기간이 지정되었습니다.');
    // 입력값 초기화
    setAssignType('OFF');
    setStartDate('');
    setEndDate('');
  }

  async function runImportPreview() {
    if (!importFile) return alert('CSV 파일을 선택하세요.');
    setImportBusy(true);
    setPreview(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      const res = await fetch('/api/caddies/import/preview', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json();
      if (!res.ok) return alert(data?.error || '미리보기 실패');
      setPreview(data as ImportPreview);
    } finally {
      setImportBusy(false);
    }
  }

  async function runImportApply() {
    if (!preview) return;
    if (preview.summary.needsReview > 0) {
      const ok = confirm(
        `확인 필요 ${preview.summary.needsReview}건은 적용되지 않습니다. 조 변경 ${preview.summary.update}건 / 신규 ${preview.summary.new}건만 적용할까요?`
      );
      if (!ok) return;
    } else if (!confirm(`조 변경 ${preview.summary.update}건 / 신규 ${preview.summary.new}건을 적용할까요? (기존 ID 유지)`)) {
      return;
    }

    setImportBusy(true);
    try {
      const res = await fetch('/api/caddies/import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ applyPayload: preview.applyPayload }),
      });
      const data = await res.json();
      if (!res.ok) return alert(data?.error || '적용 실패');
      alert(`적용 완료: 조 변경 ${data.updated} / 신규 ${data.created}`);
      setPreview(null);
      setImportFile(null);
      await load();
    } finally {
      setImportBusy(false);
    }
  }

  return (
    <div style={{ maxWidth: 1000, margin: '0 auto' }}>
      <h2 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>👥 캐디 관리</h2>

      {/* 명단 import */}
      <div style={{ marginBottom: 20, paddingBottom: 16, borderBottom: '1px solid #e5e7eb' }}>
        <div style={{ fontWeight: 700, marginBottom: 8 }}>명단 가져오기 (CSV / Excel)</div>
        <p style={{ color: '#64748b', fontSize: 13, marginTop: 0, marginBottom: 8 }}>
          CSV는 team,name 열 / Excel은 1조~12조 가로 + 카트·성명 레이아웃을 지원합니다.
          카트번호·고정카트 색은 저장하지 않습니다. 미리보기 확인 후에만 적용하세요.
          박준형 / 김기환2 / 김예진1 / 김예진2는 확인 필요로 분리됩니다.
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="file"
            accept=".csv,.xlsx,.xls,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel"
            onChange={(e) => {
              setImportFile(e.target.files?.[0] ?? null);
              setPreview(null);
            }}
          />
          <button onClick={runImportPreview} disabled={importBusy || !importFile} style={btnDark}>
            미리보기
          </button>
          <button
            onClick={runImportApply}
            disabled={importBusy || !preview || (preview.summary.update === 0 && preview.summary.new === 0)}
            style={btn}
          >
            적용
          </button>
        </div>
        {preview && (
          <div style={{ marginTop: 12, fontSize: 13, color: '#0f172a' }}>
            <div style={{ marginBottom: 8 }}>
              조 변경 {preview.summary.update} · 동일 {preview.summary.unchanged} · 신규 {preview.summary.new} ·
              확인 필요 {preview.summary.needsReview} · 명단 없음(수동확인) {preview.summary.missingInImport}
            </div>
            <div style={{ overflowX: 'auto', maxHeight: 420, border: '1px solid #e5e7eb' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640 }}>
                <thead>
                  <tr style={{ background: '#f8fafc', position: 'sticky', top: 0 }}>
                    <th style={th}>기존 ID</th>
                    <th style={th}>이름</th>
                    <th style={th}>기존 조</th>
                    <th style={th}>최신 조</th>
                    <th style={th}>처리 결과</th>
                  </tr>
                </thead>
                <tbody>
                  {(preview.lines ?? []).map((line, idx) => (
                    <tr
                      key={`${line.action}-${line.id ?? 'x'}-${line.name}-${idx}`}
                      style={{
                        borderTop: '1px solid #f1f5f9',
                        background:
                          line.action === 'needsReview'
                            ? '#fff7ed'
                            : line.action === 'missingInImport'
                              ? '#f8fafc'
                              : undefined,
                      }}
                    >
                      <td style={td}>{line.id ?? '-'}</td>
                      <td style={{ ...td, textAlign: 'left' }}>{line.name}</td>
                      <td style={td}>{line.currentTeam ?? '-'}</td>
                      <td style={td}>{line.nextTeam ?? '-'}</td>
                      <td style={{ ...td, textAlign: 'left' }}>
                        {ACTION_LABEL[line.action]}
                        {line.reason ? ` — ${line.reason}` : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {/* 추가 폼 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <input
          placeholder="팀 (예: 1조)"
          value={newTeam}
          onChange={e => setNewTeam(e.target.value)}
          style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}
        />
        <input
          placeholder="이름"
          value={newName}
          onChange={e => setNewName(e.target.value)}
          style={{ padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}
        />
        <button
          onClick={add}
          style={{ padding: '8px 12px', borderRadius: 6, border: '1px solid #0f172a', background: '#0f172a', color: '#fff' }}
        >
          추가
        </button>
      </div>

      {loading ? (
        <p>불러오는 중…</p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff' }}>
          <thead>
            <tr style={{ background: '#f8fafc', borderBottom: '1px solid #e5e7eb' }}>
              <th style={th}>#</th>
              <th style={th}>팀</th>
              <th style={th}>이름</th>
              <th style={th}>상태</th>
              <th style={th}>관리</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <Fragment key={r.id}>
                <tr style={{ textAlign: 'center', borderBottom: '1px solid #f1f5f9' }}>
                  <td style={td}>{i + 1}</td>
                  <td style={td}>{r.team}</td>
                  <td style={{ ...td, textAlign: 'left' }}>
                    <button onClick={() => openLists(r)} style={linkBtn}>
                      {openId === r.id ? '▼ ' : '▶ '}
                      {r.name}
                    </button>
                  </td>
                  <td style={td}>{r.status || '근무중'}</td>
                  <td style={td}>
                    <button onClick={() => remove(r.id)} style={btn}>삭제</button>
                  </td>
                </tr>

                {openId === r.id && (
                  <tr>
                    <td colSpan={5} style={{ background: '#fafafa', padding: 12 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
                        {/* 메모(노트) */}
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 8 }}>메모</div>
                          <div style={{ display: 'flex', gap: 8, marginBottom: 8 }}>
                            <input
                              placeholder="메모 입력"
                              value={newNote}
                              onChange={e => setNewNote(e.target.value)}
                              style={{ flex: 1, padding: 8, border: '1px solid #e5e7eb', borderRadius: 6 }}
                            />
                            <button onClick={saveNote} style={btnDark}>추가</button>
                          </div>
                          <ul style={{ margin: 0, paddingLeft: 18 }}>
                            {noteList.length === 0 ? (
                              <li style={{ color: '#64748b' }}>메모가 없습니다.</li>
                            ) : noteList.map(n => (
                              <li key={n.id} style={{ marginBottom: 6 }}>
                                <span>{n.text}</span>
                                <button onClick={() => deleteNote(n.id)} style={{ ...miniBtn, marginLeft: 8 }}>삭제</button>
                              </li>
                            ))}
                          </ul>
                        </div>

                        {/* 기간 지정 */}
                        <div>
                          <div style={{ fontWeight: 700, marginBottom: 8 }}>기간 지정</div>
                          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                            <select
                              value={assignType}
                              onChange={(e) => setAssignType(e.target.value as any)}
                              style={{ padding: 6, border: '1px solid #e5e7eb', borderRadius: 6 }}
                            >
                              <option value="OFF">휴무</option>
                              <option value="SICK">병가</option>
                              <option value="LONG_SICK">장기병가</option>
                              <option value="FAMILY_EVENT">경조사</option>
                              <option value="DUTY">당번</option>
                              <option value="MARSHAL">마샬</option>
                            </select>

                            <input
                              type="date"
                              value={startDate}
                              onChange={(e) => setStartDate(e.target.value)}
                              style={{ padding: 6, border: '1px solid #e5e7eb', borderRadius: 6 }}
                            />
                            <span>~</span>
                            <input
                              type="date"
                              value={endDate}
                              onChange={(e) => setEndDate(e.target.value)}
                              style={{ padding: 6, border: '1px solid #e5e7eb', borderRadius: 6 }}
                            />
                            <button onClick={saveAssignment} style={btnDark}>저장</button>
                          </div>
                          <div style={{ color: '#64748b', fontSize: 12, marginTop: 6 }}>
                            저장 후 <b>가용표</b> 페이지에서 해당 날짜로 조회하면 배지(휴무/병가/마샬/당번 등)가 표시됩니다.
                          </div>
                        </div>

                        {/* (옵션) Extra 영역 – 아직 /extras API 없으면 빈 상태 */}
                        <div style={{ gridColumn: '1 / -1' }}>
                          <div style={{ fontWeight: 700, marginBottom: 8 }}>추가 태그(옵션)</div>
                          {extraList.length === 0 ? (
                            <div style={{ color: '#64748b' }}>표시할 항목이 없습니다.</div>
                          ) : (
                            <ul style={{ margin: 0, paddingLeft: 18 }}>
                              {extraList.map(e => (
                                <li key={e.id}>{e.tag}</li>
                              ))}
                            </ul>
                          )}
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

const th: React.CSSProperties = { padding: 8, fontSize: 13, color: '#334155' };
const td: React.CSSProperties = { padding: 8, fontSize: 14, color: '#0f172a' };
const btn: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', background: '#fff'
};
const btnDark: React.CSSProperties = {
  border: '1px solid #0f172a', borderRadius: 6, padding: '6px 10px', cursor: 'pointer', background: '#0f172a', color: '#fff'
};
const miniBtn: React.CSSProperties = {
  border: '1px solid #e5e7eb', borderRadius: 6, padding: '2px 6px', cursor: 'pointer', background: '#fff', fontSize: 12
};
const linkBtn: React.CSSProperties = {
  background: 'transparent', border: 0, padding: 0, cursor: 'pointer', color: '#0f172a', fontSize: 14
};
