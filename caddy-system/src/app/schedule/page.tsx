// app/schedule/page.tsx
"use client";
import React from "react";

interface Team {
  조: number;
  성명: string;
  특이사항?: string[];
}

const SAMPLE: Team[] = [
  { 조: 1, 성명: "홍길동", 특이사항: ["지각"] },
  { 조: 2, 성명: "김철수", 특이사항: ["병가"] },
  { 조: 3, 성명: "이영희", 특이사항: ["휴무"] },
];

export default function SchedulePage() {
  return (
    <div style={{ padding: "20px" }}>
      <h1>가용표</h1>
      <table border={1} cellPadding={10} style={{ borderCollapse: "collapse" }}>
        <thead>
          <tr>
            <th>조</th>
            <th>성명</th>
            <th>특이사항</th>
          </tr>
        </thead>
        <tbody>
          {SAMPLE.map((member, idx) => (
            <tr key={idx}>
              <td>{member.조}</td>
              <td>{member.성명}</td>
              <td>{member.특이사항?.join(", ") || "-"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
