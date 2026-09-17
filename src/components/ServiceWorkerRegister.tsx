"use client";

import { useEffect } from "react";
import { registerVerthillServiceWorker } from "@/lib/registerServiceWorker";

export default function ServiceWorkerRegister() {
  useEffect(() => {
    void registerVerthillServiceWorker();
  }, []);

  return null;
}
