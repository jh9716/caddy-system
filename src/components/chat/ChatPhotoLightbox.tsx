"use client";

import { useEffect, useRef } from "react";
import {
  applyLightboxPan,
  clampLightboxPan,
  clampLightboxScale,
  lightboxDistance,
  lightboxTransformCss,
  nextLightboxDoubleTapScale,
  pinchLightboxScale,
  resetLightboxTransform,
  shouldBlockLightboxBackdropClose,
  type LightboxPoint,
  type LightboxTransform,
} from "@/lib/chatPhotoLightboxZoom";

type Props = {
  src: string;
  onClose: () => void;
};

function touchPoint(touch: { clientX: number; clientY: number }): LightboxPoint {
  return { x: touch.clientX, y: touch.clientY };
}

export default function ChatPhotoLightbox({ src, onClose }: Props) {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const transformRef = useRef<LightboxTransform>(resetLightboxTransform());
  const interactingRef = useRef(false);
  const recentGestureRef = useRef(false);
  const recentTimerRef = useRef<number>(0);
  const pinchOriginRef = useRef<{ scale: number; distance: number } | null>(null);
  const panOriginRef = useRef<LightboxPoint | null>(null);
  const lastTapRef = useRef(0);

  function paint() {
    const img = imgRef.current;
    if (!img) return;
    img.style.transform = lightboxTransformCss(transformRef.current);
  }

  function markRecentGesture() {
    recentGestureRef.current = true;
    window.clearTimeout(recentTimerRef.current);
    recentTimerRef.current = window.setTimeout(() => {
      recentGestureRef.current = false;
    }, 320);
  }

  function setTransform(next: LightboxTransform) {
    const stage = stageRef.current;
    const viewW = stage?.clientWidth || window.innerWidth;
    const viewH = stage?.clientHeight || window.innerHeight;
    const pan = clampLightboxPan(next.x, next.y, next.scale, viewW, viewH);
    transformRef.current = { scale: clampLightboxScale(next.scale), x: pan.x, y: pan.y };
    paint();
  }

  useEffect(() => {
    transformRef.current = resetLightboxTransform();
    paint();
  }, [src]);

  useEffect(() => {
    return () => window.clearTimeout(recentTimerRef.current);
  }, []);

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;

    const onMove = (event: TouchEvent) => {
      if (event.touches.length >= 2) {
        event.preventDefault();
        interactingRef.current = true;
        const origin = pinchOriginRef.current;
        const distance = lightboxDistance(touchPoint(event.touches[0]!), touchPoint(event.touches[1]!));
        if (!origin) {
          pinchOriginRef.current = { scale: transformRef.current.scale, distance };
          panOriginRef.current = null;
          return;
        }
        setTransform({
          ...transformRef.current,
          scale: pinchLightboxScale(origin.scale, origin.distance, distance),
        });
        return;
      }
      if (event.touches.length === 1 && transformRef.current.scale > 1.01) {
        event.preventDefault();
        interactingRef.current = true;
        const point = touchPoint(event.touches[0]!);
        const origin = panOriginRef.current;
        if (!origin) {
          panOriginRef.current = point;
          return;
        }
        const stageEl = stageRef.current;
        setTransform(
          applyLightboxPan(
            transformRef.current,
            point.x - origin.x,
            point.y - origin.y,
            stageEl?.clientWidth || window.innerWidth,
            stageEl?.clientHeight || window.innerHeight
          )
        );
        panOriginRef.current = point;
      }
    };

    const onEnd = () => {
      if (interactingRef.current) markRecentGesture();
      interactingRef.current = false;
      pinchOriginRef.current = null;
      panOriginRef.current = null;
    };

    stage.addEventListener("touchmove", onMove, { passive: false });
    stage.addEventListener("touchend", onEnd);
    stage.addEventListener("touchcancel", onEnd);
    return () => {
      stage.removeEventListener("touchmove", onMove);
      stage.removeEventListener("touchend", onEnd);
      stage.removeEventListener("touchcancel", onEnd);
    };
  }, []);

  function onBackdropClick() {
    if (
      shouldBlockLightboxBackdropClose({
        interacting: interactingRef.current,
        recentGesture: recentGestureRef.current,
      })
    ) {
      return;
    }
    onClose();
  }

  function onImageClick(event: React.MouseEvent<HTMLImageElement>) {
    event.stopPropagation();
  }

  function onImageTouchStart(event: React.TouchEvent<HTMLImageElement>) {
    if (event.touches.length >= 2) {
      interactingRef.current = true;
      pinchOriginRef.current = {
        scale: transformRef.current.scale,
        distance: lightboxDistance(touchPoint(event.touches[0]!), touchPoint(event.touches[1]!)),
      };
      panOriginRef.current = null;
      return;
    }
    if (event.touches.length === 1) {
      panOriginRef.current = touchPoint(event.touches[0]!);
    }
  }

  function onImageTouchEnd(event: React.TouchEvent<HTMLImageElement>) {
    if (event.touches.length > 0) return;
    const now = Date.now();
    if (now - lastTapRef.current < 280 && !recentGestureRef.current) {
      const nextScale = nextLightboxDoubleTapScale(transformRef.current.scale);
      setTransform(
        nextScale === 1 ? resetLightboxTransform() : { scale: nextScale, x: 0, y: 0 }
      );
      lastTapRef.current = 0;
      markRecentGesture();
      return;
    }
    lastTapRef.current = now;
  }

  return (
    <div
      className="vh-chat-lightbox"
      role="dialog"
      aria-label="사진 보기"
      onClick={onBackdropClick}
    >
      <div ref={stageRef} className="vh-chat-lightbox-stage">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          ref={imgRef}
          src={src}
          alt=""
          draggable={false}
          onClick={onImageClick}
          onTouchStart={onImageTouchStart}
          onTouchEnd={onImageTouchEnd}
        />
      </div>
      <button
        type="button"
        className="vh-chat-lightbox-close"
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
