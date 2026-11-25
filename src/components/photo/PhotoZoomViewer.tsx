"use client";

import { useEffect, useRef } from "react";
import {
  PHOTO_ZOOM_DOUBLE_TAP_MS,
  PHOTO_ZOOM_HISTORY_KEY,
  PHOTO_ZOOM_MIN_MAX_SCALE,
  PHOTO_ZOOM_RECENT_GESTURE_MS,
  clampPhotoZoom,
  doubleTapPhotoZoom,
  isPhotoZoomHistoryState,
  isPhotoZoomed,
  panPhotoZoom,
  photoZoomDistance,
  photoZoomMaxScale,
  photoZoomMidpoint,
  photoZoomPointInStage,
  photoZoomTransformCss,
  pinchPhotoZoom,
  resetPhotoZoom,
  shouldBlockPhotoZoomBackdropClose,
  type PhotoZoomBox,
  type PhotoZoomPinchStart,
  type PhotoZoomPoint,
  type PhotoZoomTransform,
} from "@/lib/photoZoomViewer";

type Props = {
  /** 기존과 같은 사진 주소 (원본·인증 그대로). */
  src: string;
  alt?: string;
  onClose: () => void;
};

let tokenSeq = 0;

/**
 * 공지·가배치표·자유게시판 공용 사진 확대 뷰어.
 * - 현재 화면 위에 열림, 기본은 화면에 맞춰 전체 보기
 * - 두 손가락 확대·축소(손가락 기준), 확대 상태에서 이동, 두 번 탭 확대/원래대로
 * - 닫기 버튼, 확대 중 바깥 탭으로는 닫히지 않음
 * - 열려 있는 동안 뒤 화면 스크롤만 잠금 → 닫으면 원래 위치 그대로
 * - 뒤로 가기(브라우저·PWA·Android 앱)는 뷰어만 닫음: 열 때 같은 주소로 history 한 칸 추가
 * 외부 라이브러리 없음. 채팅 뷰어(ChatPhotoLightbox)는 변경하지 않음.
 */
export default function PhotoZoomViewer({ src, alt = "", onClose }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const transformRef = useRef<PhotoZoomTransform>(resetPhotoZoom());
  const maxScaleRef = useRef<number>(PHOTO_ZOOM_MIN_MAX_SCALE);
  const pinchRef = useRef<PhotoZoomPinchStart | null>(null);
  const panRef = useRef<PhotoZoomPoint | null>(null);
  const interactingRef = useRef(false);
  const recentGestureRef = useRef(false);
  const recentTimerRef = useRef<number>(0);
  const lastTapRef = useRef<{ at: number; point: PhotoZoomPoint } | null>(null);
  const movedRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const tokenRef = useRef<string>("");
  const closedByHistoryRef = useRef(false);
  const pendingBackRef = useRef<number>(0);

  onCloseRef.current = onClose;
  if (!tokenRef.current) {
    tokenSeq += 1;
    tokenRef.current = `pz-${Date.now().toString(36)}-${tokenSeq}`;
  }

  function box(): PhotoZoomBox {
    const stage = stageRef.current;
    const img = imgRef.current;
    const viewWidth = stage?.clientWidth || window.innerWidth;
    const viewHeight = stage?.clientHeight || window.innerHeight;
    return {
      viewWidth,
      viewHeight,
      baseWidth: img?.offsetWidth || viewWidth,
      baseHeight: img?.offsetHeight || viewHeight,
    };
  }

  function paint() {
    const img = imgRef.current;
    if (!img) return;
    img.style.transform = photoZoomTransformCss(transformRef.current);
    img.classList.toggle("is-zoomed", isPhotoZoomed(transformRef.current));
  }

  function setTransform(next: PhotoZoomTransform) {
    transformRef.current = clampPhotoZoom(next, box(), maxScaleRef.current);
    paint();
  }

  function updateMaxScale() {
    const img = imgRef.current;
    if (!img) return;
    maxScaleRef.current = photoZoomMaxScale({
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      baseWidth: img.offsetWidth,
      baseHeight: img.offsetHeight,
    });
  }

  function markRecentGesture() {
    recentGestureRef.current = true;
    window.clearTimeout(recentTimerRef.current);
    recentTimerRef.current = window.setTimeout(() => {
      recentGestureRef.current = false;
    }, PHOTO_ZOOM_RECENT_GESTURE_MS);
  }

  function stagePoint(touch: { clientX: number; clientY: number }): PhotoZoomPoint {
    const stage = stageRef.current;
    const rect = stage
      ? stage.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    return photoZoomPointInStage(touch, rect);
  }

  // 사진이 바뀌면 처음 상태로.
  useEffect(() => {
    transformRef.current = resetPhotoZoom();
    maxScaleRef.current = PHOTO_ZOOM_MIN_MAX_SCALE;
    paint();
  }, [src]);

  // 뒤 화면 스크롤 잠금 (위치는 그대로 남음) + Esc 로 닫기.
  useEffect(() => {
    const html = document.documentElement;
    const body = document.body;
    const prevHtml = html.style.overflow;
    const prevBody = body.style.overflow;
    html.style.overflow = "hidden";
    body.style.overflow = "hidden";
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      html.style.overflow = prevHtml;
      body.style.overflow = prevBody;
      window.removeEventListener("keydown", onKey);
      window.clearTimeout(recentTimerRef.current);
    };
  }, []);

  // 뒤로 가기 = 뷰어만 닫기. 주소는 바꾸지 않고 history 한 칸만 추가.
  useEffect(() => {
    const token = tokenRef.current;
    window.clearTimeout(pendingBackRef.current);
    closedByHistoryRef.current = false;
    if (!isPhotoZoomHistoryState(window.history.state, token)) {
      try {
        window.history.pushState({ [PHOTO_ZOOM_HISTORY_KEY]: token }, "");
      } catch {
        // history 를 못 쓰면 닫기 버튼만 사용.
      }
    }
    const onPop = () => {
      if (isPhotoZoomHistoryState(window.history.state, token)) return;
      closedByHistoryRef.current = true;
      onCloseRef.current();
    };
    window.addEventListener("popstate", onPop);
    return () => {
      window.removeEventListener("popstate", onPop);
      if (closedByHistoryRef.current) return;
      // 닫기 버튼·바깥 탭으로 닫힘: 추가했던 한 칸만 되돌린다.
      // (개발 모드 StrictMode 재실행 때는 바로 다시 열리므로 다음 틱까지 미룸)
      pendingBackRef.current = window.setTimeout(() => {
        if (isPhotoZoomHistoryState(window.history.state, token)) {
          window.history.back();
        }
      }, 0);
    };
  }, []);

  // 손가락 동작 (passive:false 로 화면 스크롤·브라우저 확대를 막음).
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onStart = (event: TouchEvent) => {
      if (event.touches.length >= 2) {
        event.preventDefault();
        interactingRef.current = true;
        const a = stagePoint(event.touches[0]!);
        const b = stagePoint(event.touches[1]!);
        pinchRef.current = {
          transform: { ...transformRef.current },
          distance: photoZoomDistance(a, b),
          midpoint: photoZoomMidpoint(a, b),
        };
        panRef.current = null;
        movedRef.current = true;
        return;
      }
      if (event.touches.length === 1) {
        movedRef.current = false;
        panRef.current = stagePoint(event.touches[0]!);
      }
    };

    const onMove = (event: TouchEvent) => {
      event.preventDefault();
      if (event.touches.length >= 2) {
        interactingRef.current = true;
        const a = stagePoint(event.touches[0]!);
        const b = stagePoint(event.touches[1]!);
        if (!pinchRef.current) {
          pinchRef.current = {
            transform: { ...transformRef.current },
            distance: photoZoomDistance(a, b),
            midpoint: photoZoomMidpoint(a, b),
          };
          panRef.current = null;
          return;
        }
        transformRef.current = pinchPhotoZoom(
          pinchRef.current,
          photoZoomDistance(a, b),
          photoZoomMidpoint(a, b),
          box(),
          maxScaleRef.current
        );
        paint();
        return;
      }
      if (event.touches.length === 1) {
        const point = stagePoint(event.touches[0]!);
        const origin = panRef.current;
        if (!origin) {
          panRef.current = point;
          return;
        }
        if (Math.abs(point.x - origin.x) + Math.abs(point.y - origin.y) > 6) {
          movedRef.current = true;
        }
        if (!isPhotoZoomed(transformRef.current)) return;
        interactingRef.current = true;
        transformRef.current = panPhotoZoom(
          transformRef.current,
          point.x - origin.x,
          point.y - origin.y,
          box(),
          maxScaleRef.current
        );
        panRef.current = point;
        paint();
      }
    };

    const onEnd = (event: TouchEvent) => {
      if (event.touches.length > 0) {
        // 두 손가락 중 하나만 뗀 경우: 남은 손가락으로 이어서 이동.
        pinchRef.current = null;
        panRef.current = stagePoint(event.touches[0]!);
        markRecentGesture();
        return;
      }
      const wasInteracting = interactingRef.current;
      if (wasInteracting) markRecentGesture();
      interactingRef.current = false;
      pinchRef.current = null;
      panRef.current = null;

      // 두 번 탭 판정 (움직이지 않은 짧은 탭만).
      const touch = event.changedTouches[0];
      if (!touch || movedRef.current || wasInteracting) {
        lastTapRef.current = null;
        return;
      }
      const point = stagePoint(touch);
      const now = Date.now();
      const last = lastTapRef.current;
      if (
        last &&
        now - last.at < PHOTO_ZOOM_DOUBLE_TAP_MS &&
        photoZoomDistance(last.point, point) < 40
      ) {
        event.preventDefault();
        lastTapRef.current = null;
        transformRef.current = doubleTapPhotoZoom(
          transformRef.current,
          point,
          box(),
          maxScaleRef.current
        );
        paint();
        markRecentGesture();
        return;
      }
      lastTapRef.current = { at: now, point };
    };

    stage.addEventListener("touchstart", onStart, { passive: false });
    stage.addEventListener("touchmove", onMove, { passive: false });
    stage.addEventListener("touchend", onEnd, { passive: false });
    stage.addEventListener("touchcancel", onEnd, { passive: false });
    return () => {
      stage.removeEventListener("touchstart", onStart);
      stage.removeEventListener("touchmove", onMove);
      stage.removeEventListener("touchend", onEnd);
      stage.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  // 화면 크기가 바뀌면(회전 등) 범위를 다시 맞춤.
  useEffect(() => {
    const onResize = () => {
      updateMaxScale();
      setTransform(transformRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
    // 함수들은 ref 만 읽으므로 한 번만 등록해도 안전함.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onBackdropClick(event: React.MouseEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget && event.target !== stageRef.current) return;
    if (
      shouldBlockPhotoZoomBackdropClose({
        zoomed: isPhotoZoomed(transformRef.current),
        interacting: interactingRef.current,
        recentGesture: recentGestureRef.current,
      })
    ) {
      return;
    }
    onClose();
  }

  return (
    <div
      className="vh-photo-zoom"
      role="dialog"
      aria-modal="true"
      aria-label="사진 크게 보기"
      onClick={onBackdropClick}
    >
      <div ref={stageRef} className="vh-photo-zoom-stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt={alt}
          draggable={false}
          decoding="async"
          onLoad={() => {
            updateMaxScale();
            setTransform(transformRef.current);
          }}
          onClick={(event) => event.stopPropagation()}
        />
      </div>
      <button
        type="button"
        className="vh-photo-zoom-close"
        onClick={(event) => {
          event.stopPropagation();
          onClose();
        }}
      >
        닫기
      </button>
    </div>
  );
}
