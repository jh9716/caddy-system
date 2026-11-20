import { formatKstDisplay, kstYmd } from "@/lib/kstDate";

/** 목록 시각: 오늘 글은 HH:mm, 이전 글은 MM.DD (KST). */
export function formatTalkListTime(iso: string, now: Date = new Date()): string {
  const full = formatKstDisplay(iso, "ymd-hm");
  if (!full) return "";
  const [ymd, hm] = full.split(" ");
  if (ymd === kstYmd(now)) return hm;
  const [, m, d] = ymd.split("-");
  return `${m}.${d}`;
}

/** 상세 시각: YYYY.MM.DD HH:mm (KST). */
export function formatTalkDetailTime(iso: string): string {
  return formatKstDisplay(iso, "captured");
}
