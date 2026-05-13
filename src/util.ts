// Small process + timing helpers used by every probe.
import { spawn } from "node:child_process";

export type Run = {
  ok: boolean;       // exit code 0
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  ms: number;        // wall time
};

export async function run(
  cmd: string,
  args: string[],
  opts: { timeoutMs?: number; env?: Record<string, string>; stdin?: string } = {},
): Promise<Run> {
  const timeoutMs = opts.timeoutMs ?? 8000;
  const started = performance.now();
  return await new Promise<Run>((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const child = spawn(cmd, args, {
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", () => {
      clearTimeout(timer);
      resolve({
        ok: false, code: null, stdout, stderr, timedOut,
        ms: performance.now() - started,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        ok: code === 0 && !timedOut,
        code,
        stdout,
        stderr,
        timedOut,
        ms: performance.now() - started,
      });
    });
    if (opts.stdin) { child.stdin.end(opts.stdin); } else { child.stdin.end(); }
  });
}

// curl is the workhorse: -m timeout, -sS quiet but show errors, -o /dev/null discard body,
// -w prints metrics. We always disable env-var proxy unless caller wants it, by passing --noproxy '*'.
export async function curlMetrics(opts: {
  url: string;
  proxy?: string;              // e.g. "http://127.0.0.1:7897" — omit for direct
  timeoutMs?: number;
  resolve?: string;            // host:port:addr override
  captureBody?: boolean;       // include body in stdout
  insecure?: boolean;
  headOnly?: boolean;
}): Promise<{
  ok: boolean;
  httpCode: number;
  timeNamelookup: number;
  timeConnect: number;
  timeAppconnect: number;
  timeStarttransfer: number;
  timeTotal: number;
  sizeDownload: number;
  remoteIp: string;
  errorMsg?: string;
  body?: string;
  timedOut: boolean;
}> {
  // Leading \n+sentinel so we can split the body from the metrics block reliably even when
  // the response body has no trailing newline.
  const fmt =
    "\n__NETMON__\nhttp_code=%{http_code}\nnamelookup=%{time_namelookup}\nconnect=%{time_connect}\nappconnect=%{time_appconnect}\nstarttransfer=%{time_starttransfer}\ntotal=%{time_total}\nsize=%{size_download}\nremote=%{remote_ip}\n";
  const args = ["-sS", "-w", fmt];
  if (opts.headOnly) args.push("-I");
  if (!opts.captureBody) args.push("-o", "/dev/null");
  if (opts.insecure) args.push("-k");
  args.push("-m", String(((opts.timeoutMs ?? 8000) / 1000).toFixed(2)));
  if (opts.proxy) {
    args.push("-x", opts.proxy);
  } else {
    args.push("--noproxy", "*");
  }
  if (opts.resolve) args.push("--resolve", opts.resolve);
  args.push(opts.url);

  const r = await run("/usr/bin/curl", args, {
    timeoutMs: (opts.timeoutMs ?? 8000) + 1500,
    // Make sure env proxies don't leak in.
    env: { http_proxy: "", https_proxy: "", all_proxy: "", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "" },
  });

  // Split body from metrics using our sentinel.
  const sentinelIdx = r.stdout.lastIndexOf("\n__NETMON__\n");
  const body = sentinelIdx >= 0 ? r.stdout.slice(0, sentinelIdx) : "";
  const metricsText = sentinelIdx >= 0 ? r.stdout.slice(sentinelIdx + "\n__NETMON__\n".length) : r.stdout;
  const parsed = parseCurlWrite(metricsText);
  return {
    ok: r.ok && parsed.http_code >= 200 && parsed.http_code < 600 && parsed.http_code !== 0,
    httpCode: parsed.http_code,
    timeNamelookup: parsed.namelookup * 1000,
    timeConnect: parsed.connect * 1000,
    timeAppconnect: parsed.appconnect * 1000,
    timeStarttransfer: parsed.starttransfer * 1000,
    timeTotal: parsed.total * 1000,
    sizeDownload: parsed.size,
    remoteIp: parsed.remote,
    errorMsg: r.ok ? undefined : (r.stderr.trim() || `exit ${r.code}${r.timedOut ? " (timeout)" : ""}`),
    body: opts.captureBody ? body.trim() : undefined,
    timedOut: r.timedOut,
  };
}

function parseCurlWrite(text: string) {
  const get = (k: string) => {
    const m = text.match(new RegExp(`^${k}=(.+)$`, "m"));
    return m ? m[1].trim() : "";
  };
  return {
    http_code: parseInt(get("http_code") || "0", 10),
    namelookup: parseFloat(get("namelookup") || "0"),
    connect: parseFloat(get("connect") || "0"),
    appconnect: parseFloat(get("appconnect") || "0"),
    starttransfer: parseFloat(get("starttransfer") || "0"),
    total: parseFloat(get("total") || "0"),
    size: parseInt(get("size") || "0", 10),
    remote: get("remote"),
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
