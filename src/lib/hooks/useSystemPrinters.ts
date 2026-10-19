import { useEffect, useState } from "react";
import { invoke } from "@/lib/invoke";

export interface SystemPrinter {
  id: string;
  name: string;
  address: string;
  printer_type: string;
  language: string;
  status?: string;
}

let cache: SystemPrinter[] | null = null;
let cacheAt = 0;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

export function useSystemPrinters() {
  const [printers, setPrinters] = useState<SystemPrinter[]>(cache ?? []);
  const [loading, setLoading] = useState(!cache);

  useEffect(() => {
    if (cache && Date.now() - cacheAt < TTL_MS) {
      setPrinters(cache);
      setLoading(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const list = await invoke<SystemPrinter[]>("enumerate_system_printers");
        if (cancelled) return;
        cache = list ?? [];
        cacheAt = Date.now();
        setPrinters(cache);
      } catch {
        if (!cancelled) setPrinters([]);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const refresh = async () => {
    try {
      const list = await invoke<SystemPrinter[]>("enumerate_system_printers");
      cache = list ?? [];
      cacheAt = Date.now();
      setPrinters(cache);
      return cache;
    } catch {
      return [];
    }
  };

  return { printers, loading, refresh };
}
