export const LIGHTBOX_MIN_SCALE = 1;
export const LIGHTBOX_MAX_SCALE = 4;
export const LIGHTBOX_DOUBLE_TAP_SCALE = 2;

export type LightboxPoint = { x: number; y: number };
export type LightboxTransform = { scale: number; x: number; y: number };

export function clampLightboxScale(scale: number): number {
  if (!Number.isFinite(scale)) return LIGHTBOX_MIN_SCALE;
  return Math.min(LIGHTBOX_MAX_SCALE, Math.max(LIGHTBOX_MIN_SCALE, scale));
}

export function resetLightboxTransform(): LightboxTransform {
  return { scale: LIGHTBOX_MIN_SCALE, x: 0, y: 0 };
}

export function nextLightboxDoubleTapScale(scale: number): number {
  return scale <= 1.05 ? LIGHTBOX_DOUBLE_TAP_SCALE : LIGHTBOX_MIN_SCALE;
}

export function lightboxDistance(a: LightboxPoint, b: LightboxPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pinchLightboxScale(
  originScale: number,
  originDistance: number,
  currentDistance: number
): number {
  if (!(originDistance > 0) || !Number.isFinite(currentDistance)) {
    return clampLightboxScale(originScale);
  }
  return clampLightboxScale(originScale * (currentDistance / originDistance));
}

export function clampLightboxPan(
  x: number,
  y: number,
  scale: number,
  viewWidth: number,
  viewHeight: number
): LightboxPoint {
  if (scale <= 1.01) return { x: 0, y: 0 };
  const maxX = Math.max(0, (Math.max(1, viewWidth) * (scale - 1)) / 2);
  const maxY = Math.max(0, (Math.max(1, viewHeight) * (scale - 1)) / 2);
  return {
    x: Math.min(maxX, Math.max(-maxX, x)),
    y: Math.min(maxY, Math.max(-maxY, y)),
  };
}

export function applyLightboxPan(
  current: LightboxTransform,
  dx: number,
  dy: number,
  viewWidth: number,
  viewHeight: number
): LightboxTransform {
  const next = clampLightboxPan(current.x + dx, current.y + dy, current.scale, viewWidth, viewHeight);
  return { scale: current.scale, x: next.x, y: next.y };
}

export function shouldBlockLightboxBackdropClose(input: {
  interacting: boolean;
  recentGesture: boolean;
}): boolean {
  return Boolean(input.interacting || input.recentGesture);
}

export function lightboxTransformCss(transform: LightboxTransform): string {
  return `translate(${transform.x}px, ${transform.y}px) scale(${transform.scale})`;
}
