/**
 * 공지·가배치표·자유게시판 공용 사진 확대 뷰어 계산 (순수 함수, DOM 없음).
 * 채팅 뷰어(chatPhotoLightboxZoom)의 방식을 참고했지만 채팅 파일은 건드리지 않는다.
 *
 * 좌표계: 화면(stage) 가운데를 (0,0)으로 둔다. 사진은 가운데에 "화면에 맞춤" 크기
 * (baseWidth × baseHeight)로 놓이고, CSS transform `translate(x,y) scale(s)`
 * (transform-origin: center)로 확대·이동한다.
 */

export const PHOTO_ZOOM_MIN_SCALE = 1;
/** 사용자 결정: 최대 약 10배 이내. */
export const PHOTO_ZOOM_ABSOLUTE_MAX_SCALE = 10;
/** 원본이 작아도 최소한 이만큼은 확대할 수 있게 한다. */
export const PHOTO_ZOOM_MIN_MAX_SCALE = 2;
/** 원본 1픽셀을 화면 CSS 2픽셀까지 키우는 것까지만 허용 (그 이상은 흐려지기만 함). */
export const PHOTO_ZOOM_PIXEL_UPSCALE_LIMIT = 2;
export const PHOTO_ZOOM_DOUBLE_TAP_SCALE = 2.5;
export const PHOTO_ZOOM_DOUBLE_TAP_MS = 280;
export const PHOTO_ZOOM_RECENT_GESTURE_MS = 320;
/** history.state 에 넣는 표시. 뒤로 가기로 뷰어만 닫을 때 쓴다. */
export const PHOTO_ZOOM_HISTORY_KEY = "__vhPhotoZoom";

export type PhotoZoomPoint = { x: number; y: number };
export type PhotoZoomTransform = { scale: number; x: number; y: number };
export type PhotoZoomBox = {
  /** 화면(stage) 크기 */
  viewWidth: number;
  viewHeight: number;
  /** scale=1 일 때 사진이 화면에 맞춰 그려진 크기 */
  baseWidth: number;
  baseHeight: number;
};

function finitePositive(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function resetPhotoZoom(): PhotoZoomTransform {
  return { scale: PHOTO_ZOOM_MIN_SCALE, x: 0, y: 0 };
}

/**
 * 원본 해상도를 고려한 최대 배율.
 * - 원본 픽셀이 화면 CSS 픽셀 2개보다 커지는 배율은 막는다 (불필요한 화질 저하 방지).
 * - 그래도 최소 2배, 최대 10배.
 */
export function photoZoomMaxScale(input: {
  naturalWidth: number;
  naturalHeight: number;
  baseWidth: number;
  baseHeight: number;
}): number {
  const nw = Number(input.naturalWidth);
  const nh = Number(input.naturalHeight);
  const bw = Number(input.baseWidth);
  const bh = Number(input.baseHeight);
  if (!(nw > 0 && nh > 0 && bw > 0 && bh > 0) || ![nw, nh, bw, bh].every(Number.isFinite)) {
    return PHOTO_ZOOM_MIN_MAX_SCALE;
  }
  const nativeRatio = Math.max(nw / bw, nh / bh);
  const byResolution = nativeRatio * PHOTO_ZOOM_PIXEL_UPSCALE_LIMIT;
  return Math.min(
    PHOTO_ZOOM_ABSOLUTE_MAX_SCALE,
    Math.max(PHOTO_ZOOM_MIN_MAX_SCALE, byResolution)
  );
}

export function clampPhotoZoomScale(scale: number, maxScale: number): number {
  const max = Math.min(
    PHOTO_ZOOM_ABSOLUTE_MAX_SCALE,
    Math.max(PHOTO_ZOOM_MIN_SCALE, finitePositive(maxScale, PHOTO_ZOOM_MIN_MAX_SCALE))
  );
  if (!Number.isFinite(scale)) return PHOTO_ZOOM_MIN_SCALE;
  return Math.min(max, Math.max(PHOTO_ZOOM_MIN_SCALE, scale));
}

/**
 * 이동 범위 제한: 확대된 사진의 가장자리가 화면 안쪽으로 들어오지 않게 한다.
 * 확대된 사진이 화면보다 작은 방향은 가운데에 고정 → 사진이 화면 밖으로 사라지지 않음.
 */
export function clampPhotoZoomPan(
  x: number,
  y: number,
  scale: number,
  box: PhotoZoomBox
): PhotoZoomPoint {
  const vw = finitePositive(box.viewWidth, 1);
  const vh = finitePositive(box.viewHeight, 1);
  const bw = finitePositive(box.baseWidth, vw);
  const bh = finitePositive(box.baseHeight, vh);
  const s = finitePositive(scale, 1);
  const maxX = Math.max(0, (bw * s - vw) / 2);
  const maxY = Math.max(0, (bh * s - vh) / 2);
  const cx = Number.isFinite(x) ? x : 0;
  const cy = Number.isFinite(y) ? y : 0;
  return {
    x: Math.min(maxX, Math.max(-maxX, cx)) + 0,
    y: Math.min(maxY, Math.max(-maxY, cy)) + 0,
  };
}

export function clampPhotoZoom(
  next: PhotoZoomTransform,
  box: PhotoZoomBox,
  maxScale: number
): PhotoZoomTransform {
  const scale = clampPhotoZoomScale(next.scale, maxScale);
  if (scale <= PHOTO_ZOOM_MIN_SCALE + 0.001) return resetPhotoZoom();
  const pan = clampPhotoZoomPan(next.x, next.y, scale, box);
  return { scale, x: pan.x, y: pan.y };
}

/**
 * focal(화면 가운데 기준 좌표) 아래의 사진 지점이 그대로 손가락 아래에 남도록
 * 배율을 바꾼다.
 */
export function zoomPhotoAt(
  current: PhotoZoomTransform,
  nextScale: number,
  focal: PhotoZoomPoint,
  box: PhotoZoomBox,
  maxScale: number
): PhotoZoomTransform {
  const s0 = finitePositive(current.scale, 1);
  const s1 = clampPhotoZoomScale(nextScale, maxScale);
  const ratio = s1 / s0;
  return clampPhotoZoom(
    {
      scale: s1,
      x: focal.x - (focal.x - current.x) * ratio,
      y: focal.y - (focal.y - current.y) * ratio,
    },
    box,
    maxScale
  );
}

export function photoZoomDistance(a: PhotoZoomPoint, b: PhotoZoomPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function photoZoomMidpoint(a: PhotoZoomPoint, b: PhotoZoomPoint): PhotoZoomPoint {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

export type PhotoZoomPinchStart = {
  transform: PhotoZoomTransform;
  distance: number;
  midpoint: PhotoZoomPoint;
};

/**
 * 두 손가락 확대: 시작할 때 손가락 가운데에 있던 사진 지점이 지금 손가락 가운데를
 * 따라오게 한다 (확대와 이동을 동시에).
 */
export function pinchPhotoZoom(
  start: PhotoZoomPinchStart,
  distance: number,
  midpoint: PhotoZoomPoint,
  box: PhotoZoomBox,
  maxScale: number
): PhotoZoomTransform {
  const s0 = finitePositive(start.transform.scale, 1);
  if (!(start.distance > 0) || !Number.isFinite(distance) || !(distance > 0)) {
    return clampPhotoZoom(start.transform, box, maxScale);
  }
  const s1 = clampPhotoZoomScale(s0 * (distance / start.distance), maxScale);
  const contentX = (start.midpoint.x - start.transform.x) / s0;
  const contentY = (start.midpoint.y - start.transform.y) / s0;
  return clampPhotoZoom(
    { scale: s1, x: midpoint.x - contentX * s1, y: midpoint.y - contentY * s1 },
    box,
    maxScale
  );
}

export function panPhotoZoom(
  current: PhotoZoomTransform,
  dx: number,
  dy: number,
  box: PhotoZoomBox,
  maxScale: number
): PhotoZoomTransform {
  if (current.scale <= PHOTO_ZOOM_MIN_SCALE + 0.01) return resetPhotoZoom();
  return clampPhotoZoom(
    { scale: current.scale, x: current.x + dx, y: current.y + dy },
    box,
    maxScale
  );
}

/** 두 번 탭: 기본 상태면 탭한 곳을 기준으로 확대, 확대 상태면 원래대로. */
export function doubleTapPhotoZoom(
  current: PhotoZoomTransform,
  focal: PhotoZoomPoint,
  box: PhotoZoomBox,
  maxScale: number
): PhotoZoomTransform {
  if (current.scale > PHOTO_ZOOM_MIN_SCALE + 0.05) return resetPhotoZoom();
  const target = Math.min(clampPhotoZoomScale(maxScale, maxScale), PHOTO_ZOOM_DOUBLE_TAP_SCALE);
  return zoomPhotoAt(current, target, focal, box, maxScale);
}

export function isPhotoZoomed(transform: PhotoZoomTransform): boolean {
  return transform.scale > PHOTO_ZOOM_MIN_SCALE + 0.01;
}

/** 확대 중이거나 방금 손가락 동작이 있었으면 바깥 탭으로 닫지 않는다. */
export function shouldBlockPhotoZoomBackdropClose(input: {
  zoomed: boolean;
  interacting: boolean;
  recentGesture: boolean;
}): boolean {
  return Boolean(input.zoomed || input.interacting || input.recentGesture);
}

export function photoZoomTransformCss(transform: PhotoZoomTransform): string {
  return `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}

/** 화면 좌표(clientX/Y)를 stage 가운데 기준 좌표로 바꾼다. */
export function photoZoomPointInStage(
  client: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number }
): PhotoZoomPoint {
  return {
    x: client.clientX - rect.left - rect.width / 2,
    y: client.clientY - rect.top - rect.height / 2,
  };
}

/** history.state 가 이 뷰어가 넣은 항목인지. */
export function isPhotoZoomHistoryState(state: unknown, token: string): boolean {
  if (!state || typeof state !== "object") return false;
  return (state as Record<string, unknown>)[PHOTO_ZOOM_HISTORY_KEY] === token;
}
