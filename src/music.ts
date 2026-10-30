// 陪听：读 Last.fm 里她正在听/最近听过的歌。Spotify（免费号也行）、Apple Music 等在 app 里连上 Last.fm 就会自动记录。
// 只读。API key 和用户名在设置页「连接」里填（key 只写不读）。
import { cfg, onConfigChange } from "./config.ts";

export let musicEnabled = false;
const refresh = () => { musicEnabled = cfg("LASTFM_API_KEY") !== "" && cfg("LASTFM_USER") !== ""; };
onConfigChange(refresh);
refresh();

export class MusicError extends Error {}

async function lastfm(method: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ method, user: cfg("LASTFM_USER").trim(), api_key: cfg("LASTFM_API_KEY").trim(), format: "json", ...params });
  let res: Response;
  try {
    res = await fetch("https://ws.audioscrobbler.com/2.0/?" + qs, { signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    throw new MusicError("连不上 Last.fm：" + (err as Error).message);
  }
  const d: any = await res.json().catch(() => ({}));
  if (d.error) throw new MusicError(d.error === 10 ? "Last.fm 的 API key 不对" : d.error === 6 ? "Last.fm 里没有这个用户名" : `Last.fm 报错 ${d.error}：${d.message}`);
  if (!res.ok) throw new MusicError(`Last.fm 返回 ${res.status}`);
  return d;
}

type Track = { name?: string; artist?: { "#text"?: string; name?: string }; album?: { "#text"?: string }; date?: { uts?: string }; "@attr"?: { nowplaying?: string } };
const line = (t: Track) => `${t.name ?? "?"} — ${t.artist?.["#text"] ?? t.artist?.name ?? "?"}${t.album?.["#text"] ? `（${t.album["#text"]}）` : ""}`;
const ago = (uts?: string) => {
  const m = uts ? Math.round((Date.now() / 1000 - Number(uts)) / 60) : NaN;
  return Number.isFinite(m) ? (m < 1 ? "刚刚" : m < 60 ? `${m} 分钟前` : m < 1440 ? `${Math.round(m / 60)} 小时前` : `${Math.round(m / 1440)} 天前`) : "";
};

export async function musicNow(): Promise<string> {
  const d = await lastfm("user.getrecenttracks", { limit: "1" });
  const t: Track | undefined = [].concat(d.recenttracks?.track ?? [])[0];
  if (!t) return "Last.fm 里还没有她的听歌记录";
  if (t["@attr"]?.nowplaying === "true") return `她正在听：${line(t)}`;
  return `她现在没在放歌（或者还没同步过来）。最近一首是 ${ago(t.date?.uts)}听的：${line(t)}`;
}

export async function musicRecent(): Promise<string> {
  const d = await lastfm("user.getrecenttracks", { limit: "15" });
  const ts: Track[] = [].concat(d.recenttracks?.track ?? []);
  return ts.length ? "她最近听的歌（新的在前）：\n" + ts.map((t) => `- ${t["@attr"]?.nowplaying === "true" ? "正在听" : ago(t.date?.uts)}：${line(t)}`).join("\n") : "还没有听歌记录";
}

export async function musicTop(period: string): Promise<string> {
  const p = ["7day", "1month", "3month", "12month", "overall"].includes(period) ? period : "1month";
  const [a, t] = await Promise.all([lastfm("user.gettopartists", { period: p, limit: "8" }), lastfm("user.gettoptracks", { period: p, limit: "8" })]);
  const artists = ([] as any[]).concat(a.topartists?.artist ?? []).map((x) => `${x.name}（${x.playcount} 次）`);
  const tracks = ([] as any[]).concat(t.toptracks?.track ?? []).map((x) => `${x.name} — ${x.artist?.name}（${x.playcount} 次）`);
  return `她${{ "7day": "最近一周", "1month": "最近一个月", "3month": "最近三个月", "12month": "最近一年", overall: "有记录以来" }[p]}最常听：\n歌手：${artists.join("、") || "（没有）"}\n歌曲：${tracks.join("；") || "（没有）"}`;
}

export async function musicStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!musicEnabled) return { enabled: false };
  try {
    const d = await lastfm("user.getinfo");
    const n = Number(d.user?.playcount) || 0;
    return { enabled: true, ok: true, detail: `连上了。用户 ${d.user?.name}，一共记录 ${n} 次播放。${n === 0 ? "还没有记录：去 Spotify 设置里把 Last.fm 连上，再听几首。" : ""}` };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}
