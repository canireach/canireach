// One-shot probe: gathers a single sample and prints it as JSON. Used by the daemon and for
// manual debugging (`bun src/probe.ts`).
import {
  probeWifi, probeInterface, probeDns, probePings, probeHttps,
  probeProxyConfig, probeProxyEgress, probeCaptive, probeProxyDownload,
  type WifiInfo, type InterfaceInfo, type DnsResult, type PingResult,
  type HttpResult, type ProxyConfig, type CaptiveResult, type HttpTarget,
} from "./probes";
import { judge, type Verdict } from "./verdict";
import { nowIso } from "./util";

export const PROXY_URL = "http://127.0.0.1:7897";

const DNS_SERVERS = ["system", "223.5.5.5", "119.29.29.29", "8.8.8.8", "1.1.1.1"];
const DNS_DOMAINS = ["baidu.com", "google.com", "github.com", "cloudflare.com"];

const PING_TARGETS_BASE = ["223.5.5.5", "119.29.29.29", "1.1.1.1", "8.8.8.8"];

const HTTPS_TARGETS: HttpTarget[] = [
  // Domestic direct
  { label: "baidu_direct", url: "https://www.baidu.com", via: "direct" },
  { label: "taobao_direct", url: "https://www.taobao.com", via: "direct" },
  // Overseas direct — often blocked on restricted networks; useful signal
  { label: "google_direct", url: "https://www.google.com", via: "direct" },
  { label: "cloudflare_direct", url: "https://www.cloudflare.com", via: "direct" },
  { label: "github_direct", url: "https://github.com", via: "direct" },
  // Via proxy
  { label: "google_proxy", url: "https://www.google.com", via: "proxy" },
  { label: "cloudflare_proxy", url: "https://www.cloudflare.com", via: "proxy" },
  { label: "github_proxy", url: "https://github.com", via: "proxy" },
  { label: "youtube_proxy", url: "https://www.youtube.com", via: "proxy" },
  // AI provider API endpoints — these are auth-protected so any HTTP response is "reachable".
  // We probe BOTH direct and proxy: in CN direct usually fails (CF block or timeout),
  // proxy is what the user actually relies on for AI access.
  { label: "anthropic_direct", url: "https://api.anthropic.com/", via: "direct", acceptAnyCode: true },
  { label: "openai_direct",    url: "https://api.openai.com/",    via: "direct", acceptAnyCode: true },
  { label: "anthropic_proxy",  url: "https://api.anthropic.com/", via: "proxy",  acceptAnyCode: true },
  { label: "openai_proxy",     url: "https://api.openai.com/",    via: "proxy",  acceptAnyCode: true },
];

export type Sample = {
  t: string;                     // ISO time
  cycleMs: number;               // total probe wall time
  wifi: WifiInfo | null;
  iface: InterfaceInfo | null;
  dns: DnsResult[];
  pings: PingResult[];
  https: HttpResult[];
  proxyConfig: ProxyConfig;
  proxyEgress: { ok: boolean; ip: string | null; ms: number; err?: string };
  captive: CaptiveResult | null;
  proxyDownload: { ok: boolean; bytes: number; ms: number; mbps: number | null; err?: string } | null;
  verdict: Verdict;
};

export async function collectSample(opts: { withDownload?: boolean } = {}): Promise<Sample> {
  const started = performance.now();

  // We need iface first so we can ping the gateway.
  const iface = await probeInterface().catch(() => null);
  const gateway = iface?.gateway ?? null;
  const pingTargets = gateway ? [gateway, ...PING_TARGETS_BASE] : PING_TARGETS_BASE.slice();

  const [wifi, dns, pings, https, proxyConfig, proxyEgress, captive] = await Promise.all([
    probeWifi().catch(() => null),
    probeDns(DNS_SERVERS, DNS_DOMAINS).catch(() => []),
    probePings(pingTargets).catch(() => []),
    probeHttps(HTTPS_TARGETS, PROXY_URL).catch(() => []),
    probeProxyConfig().catch(() => ({
      envHttp: null, envHttps: null, envAll: null,
      scutil: { HTTPEnable: false, HTTPProxy: null, HTTPPort: null, HTTPSEnable: false, HTTPSProxy: null, HTTPSPort: null, SOCKSEnable: false, SOCKSProxy: null, SOCKSPort: null, raw: "" },
      listening: false, listenerProcess: null,
    } as ProxyConfig)),
    probeProxyEgress(PROXY_URL).catch((e) => ({ ok: false, ip: null, ms: 0, err: String(e) })),
    probeCaptive().catch(() => null),
  ]);

  const proxyDownload = opts.withDownload
    ? await probeProxyDownload(PROXY_URL).catch((e) => ({ ok: false, bytes: 0, ms: 0, mbps: null, err: String(e) }))
    : null;

  const partial: Omit<Sample, "verdict"> = {
    t: nowIso(),
    cycleMs: performance.now() - started,
    wifi, iface, dns, pings, https,
    proxyConfig, proxyEgress, captive, proxyDownload,
  };
  const verdict = judge(partial as Sample);

  return { ...partial, verdict };
}

// CLI entrypoint
if (import.meta.main) {
  const arg = process.argv[2];
  const withDownload = arg === "--with-download";
  const s = await collectSample({ withDownload });
  console.log(JSON.stringify(s, null, 2));
}
