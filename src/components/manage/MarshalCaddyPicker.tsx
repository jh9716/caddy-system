"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import {
  filterMarshalPickerOptions,
  formatMarshalCaddyOptionLabel,
  type MarshalPickerCaddy,
} from "@/lib/marshalRosterUi";

type MarshalCaddyPickerProps = {
  options: MarshalPickerCaddy[];
  value: string;
  onChange: (caddyId: string) => void;
  disabled?: boolean;
  "aria-label"?: string;
};

export default function MarshalCaddyPicker({
  options,
  value,
  onChange,
  disabled = false,
  "aria-label": ariaLabel = "캐디",
}: MarshalCaddyPickerProps) {
  const listId = useId();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const selected = options.find((row) => String(row.id) === value) ?? null;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [typing, setTyping] = useState(false);
  const [highlight, setHighlight] = useState(0);

  useEffect(() => {
    if (!typing) {
      setQuery(selected ? formatMarshalCaddyOptionLabel(selected) : "");
    }
  }, [selected, typing]);

  const filtered = useMemo(
    () => (typing ? filterMarshalPickerOptions(options, query) : options),
    [options, query, typing]
  );

  useEffect(() => {
    setHighlight(0);
  }, [query, typing, open]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root && !root.contains(event.target as Node)) {
        setOpen(false);
        setTyping(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  const commit = (caddy: MarshalPickerCaddy | null) => {
    onChange(caddy ? String(caddy.id) : "");
    setTyping(false);
    setOpen(false);
    setQuery(caddy ? formatMarshalCaddyOptionLabel(caddy) : "");
  };

  const moveHighlight = (delta: number) => {
    if (filtered.length === 0) return;
    setHighlight((prev) => (prev + delta + filtered.length) % filtered.length);
  };

  const activeId =
    open && filtered[highlight]
      ? `${listId}-${filtered[highlight].id}`
      : undefined;

  return (
    <div className="mr-picker" ref={rootRef} data-marshal-picker="1">
      <input
        ref={inputRef}
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        type="search"
        className={`ui-input mr-picker-input${selected ? " is-selected" : ""}`}
        value={query}
        disabled={disabled}
        placeholder="이름 · 조 · 유형 검색"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        onFocus={(e) => {
          setOpen(true);
          e.currentTarget.select();
        }}
        onChange={(e) => {
          const next = e.target.value;
          setTyping(true);
          setQuery(next);
          setOpen(true);
          if (selected && next !== formatMarshalCaddyOptionLabel(selected)) {
            onChange("");
          }
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            if (!open) setOpen(true);
            else moveHighlight(1);
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            if (!open) setOpen(true);
            else moveHighlight(-1);
          } else if (e.key === "Enter") {
            if (open && filtered[highlight]) {
              e.preventDefault();
              commit(filtered[highlight]);
            }
          } else if (e.key === "Escape") {
            e.preventDefault();
            setOpen(false);
            setTyping(false);
          }
        }}
      />
      {selected ? (
        <p className="mr-picker-selected" data-selected-caddy={selected.id}>
          {formatMarshalCaddyOptionLabel(selected)}
        </p>
      ) : null}
      {open ? (
        <ul
          id={listId}
          role="listbox"
          className="mr-picker-list"
          aria-label="캐디 검색 결과"
        >
          {filtered.length === 0 ? (
            <li className="mr-picker-empty">
              {options.length === 0
                ? "등록 가능한 캐디가 없습니다."
                : "검색 결과 없음"}
            </li>
          ) : (
            filtered.map((caddy, index) => {
              const label = formatMarshalCaddyOptionLabel(caddy);
              const active = index === highlight;
              const isSelected = String(caddy.id) === value;
              return (
                <li key={caddy.id} role="presentation">
                  <button
                    id={`${listId}-${caddy.id}`}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    className={`mr-picker-option${active ? " is-active" : ""}${
                      isSelected ? " is-selected" : ""
                    }`}
                    onMouseEnter={() => setHighlight(index)}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => commit(caddy)}
                  >
                    {label}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      ) : null}
    </div>
  );
}
