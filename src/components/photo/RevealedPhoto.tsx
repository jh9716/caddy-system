"use client";

import { useEffect, useState } from "react";

export function RevealedPhoto({
  src,
  className,
  fetchPriority,
  loading,
  decoding = "async",
}: {
  src: string;
  className?: string;
  fetchPriority?: "high" | "low" | "auto";
  loading?: "eager" | "lazy";
  decoding?: "async" | "sync" | "auto";
}) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    setRevealed(false);
  }, [src]);

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt=""
      className={revealed ? `${className ?? ""} is-revealed`.trim() : className}
      fetchPriority={fetchPriority}
      loading={loading}
      decoding={decoding}
      onLoad={(event) => {
        const img = event.currentTarget;
        const reveal = () => setRevealed(true);
        if (typeof img.decode === "function") {
          void img.decode().then(reveal, reveal);
        } else {
          reveal();
        }
      }}
    />
  );
}
