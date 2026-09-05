import fs from "node:fs";
import path from "node:path";

export const UA = "DMCL/0.1 (https://github.com/BaiGave/dmcl)";

interface FetchOpts {
  retries?: number;
  timeoutMs?: number;
}

async function fetchWithRetry(url: string, opts: FetchOpts = {}): Promise<Response> {
  const { retries = 2, timeoutMs = 15_000 } = opts;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": UA },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      if (i < retries) await new Promise((resolve) => setTimeout(resolve, 450 * (i + 1)));
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Request failed: ${url} (${reason || "unknown network error"})`);
}

export async function fetchJson<T>(url: string, opts?: FetchOpts): Promise<T> {
  const res = await fetchWithRetry(url, opts);
  return (await res.json()) as T;
}

export async function fetchText(url: string, opts?: FetchOpts): Promise<string> {
  const res = await fetchWithRetry(url, opts);
  return res.text();
}

export type UrlProbe = "ok" | "missing" | "unreachable";

export async function probeUrl(url: string, opts?: FetchOpts): Promise<UrlProbe> {
  const timeoutMs = opts?.timeoutMs ?? 12_000;
  const retries = opts?.retries ?? 1;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const head = await fetch(url, {
        method: "HEAD",
        redirect: "follow",
        headers: { "user-agent": UA },
        signal,
      });
      if (head.ok) return "ok";
      if (head.status === 404 || head.status === 410) return "missing";
    } catch {
      // Some CDNs reject HEAD. Try a tiny GET before deciding it is unreachable.
    }
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": UA, range: "bytes=0-0" },
        signal: AbortSignal.timeout(timeoutMs),
      });
      await res.body?.cancel();
      if (res.ok) return "ok";
      if (res.status === 404 || res.status === 410) return "missing";
    } catch {
      // retry
    }
  }
  return "unreachable";
}

export async function urlExists(url: string, opts?: FetchOpts): Promise<boolean> {
  return (await probeUrl(url, opts)) === "ok";
}

export async function downloadFile(url: string, dest: string, opts: FetchOpts = {}): Promise<void> {
  const retries = opts.retries ?? 2;
  const timeoutMs = opts.timeoutMs ?? 45_000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        redirect: "follow",
        headers: {
          "user-agent": UA,
          "accept": "*/*",
        },
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1) throw new Error("empty response");
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      await fs.promises.writeFile(dest, buf);
      return;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 650 * (attempt + 1)));
    }
  }
  const reason = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`Download failed: ${url} (${reason || "unknown network error"})`);
}
