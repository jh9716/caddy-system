/**
 * 가배치표 게시판 전용 사진 전처리 (클라이언트).
 * 엑셀 캡처의 작은 글자가 읽히도록 긴 변 2560px / JPEG 0.9 를 우선 사용하고,
 * 서버 제한(장당 3MB, 공용 상수)을 넘으면 품질 → 크기 순으로 단계적으로 낮춘다.
 * 공용 코스제보/공지 전처리(prepareCourseReportPhoto, 1200px)는 변경하지 않는다.
 */
import {
  COURSE_REPORT_HEIC_CONVERT_MESSAGE,
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
} from "@/lib/courseReportPhotoClient";
import {
  FREE_BOARD_PHOTO_JPEG_QUALITY,
  FREE_BOARD_PHOTO_LONG_EDGE,
  FREE_BOARD_PHOTO_MAX_BYTES,
} from "@/lib/freeBoardConstants";

const SIZE_MESSAGE = "사진은 장당 3MB 이하만 첨부할 수 있습니다.";

/** (긴 변, JPEG 품질) 시도 순서. 첫 항목이 기본값. */
export const FREE_BOARD_ENCODE_STEPS: ReadonlyArray<readonly [number, number]> = [
  [FREE_BOARD_PHOTO_LONG_EDGE, FREE_BOARD_PHOTO_JPEG_QUALITY],
  [FREE_BOARD_PHOTO_LONG_EDGE, 0.8],
  [2048, 0.8],
  [1600, 0.75],
];

export function freeBoardTargetSize(width: number, height: number, longEdge: number) {
  const long = Math.max(width, height) || 1;
  const scale = Math.min(1, longEdge / long);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("encode_failed"))), type, quality)
  );
}

async function loadBitmap(blob: Blob): Promise<{ w: number; h: number; draw: (c: CanvasRenderingContext2D, w: number, h: number) => void; close: () => void }> {
  if (typeof createImageBitmap === "function") {
    try {
      const bm = await createImageBitmap(blob);
      return { w: bm.width, h: bm.height, draw: (c, w, h) => c.drawImage(bm, 0, 0, w, h), close: () => bm.close() };
    } catch {
      // HTMLImageElement 로 재시도
    }
  }
  const url = URL.createObjectURL(blob);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error("decode_failed"));
      i.src = url;
    });
    return { w: img.naturalWidth, h: img.naturalHeight, draw: (c, w, h) => c.drawImage(img, 0, 0, w, h), close: () => {} };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function prepareFreeBoardPhoto(file: File): Promise<Blob> {
  if (file.size > FREE_BOARD_PHOTO_MAX_BYTES * 8) throw new Error("사진이 너무 큽니다.");
  const source = await decodeCourseReportPhotoSource(file);
  let src: Awaited<ReturnType<typeof loadBitmap>>;
  try {
    src = await loadBitmap(source);
  } catch {
    throw new Error(isHeicLikeFile(file) ? COURSE_REPORT_HEIC_CONVERT_MESSAGE : COURSE_REPORT_HEIC_MESSAGE);
  }
  try {
    const type = (source.type || file.type || "").toLowerCase();
    // 작은 PNG(엑셀/화면 캡처)는 재인코딩 없이 그대로 (글자 선명도 최우선).
    // JPEG/WEBP 는 EXIF(위치 등) 제거를 위해 항상 재인코딩.
    if (
      type === "image/png" &&
      source.size <= FREE_BOARD_PHOTO_MAX_BYTES &&
      Math.max(src.w, src.h) <= FREE_BOARD_PHOTO_LONG_EDGE
    ) {
      // 메모리 사본으로 고정 (선택 직후 읽어 둠 → 업로드 시점의 파일 핸들 무효화 문제 방지)
      return new Blob([await source.arrayBuffer()], { type: "image/png" });
    }
    for (const [longEdge, quality] of FREE_BOARD_ENCODE_STEPS) {
      const { width, height } = freeBoardTargetSize(src.w, src.h, longEdge);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("encode_failed");
      // 투명 PNG 대비 흰 배경
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, width, height);
      src.draw(ctx, width, height);
      const blob = await toBlob(canvas, "image/jpeg", quality);
      canvas.width = 0;
      canvas.height = 0;
      if (blob.size <= FREE_BOARD_PHOTO_MAX_BYTES) return blob;
    }
    throw new Error(SIZE_MESSAGE);
  } finally {
    src.close();
  }
}
