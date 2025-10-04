import React from "react";

interface BadgeProps {
  text: string;
  color?: string;
}

export default function Badge({ text, color = "#e0e0e0" }: BadgeProps) {
  return (
    <span
      style={{
        display: "inline-block",
        padding: "4px 8px",
        borderRadius: "6px",
        backgroundColor: color,
        color: "#000",
        fontSize: "12px",
        fontWeight: 500,
      }}
    >
      {text}
    </span>
  );
}
