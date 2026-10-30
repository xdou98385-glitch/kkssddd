// 天气 + 她大概在哪：天气用 Open-Meteo（免费，不用 key）；位置来自快捷指令往 /api/events 报的 kind=location 事件，
// 没有（或太久没更新）就用设置里填的城市。位置只取到两位小数（约 1 公里）。
import * as db from "./db.ts";
import { cfg, onConfigChange } from "./config.ts";

export let weatherEnabled = false;
const refresh = () => { weatherEnabled = cfg("WEATHER_CITY").trim() !== ""; };
onConfigChange(refresh);
refresh();

export class WeatherError extends Error {}

type Where = { lat: number; lon: number; name: string; source: "phone" | "city"; ageMin?: number };
const LOCATION_MAX_AGE_MS = 6 * 3600_000;

async function getJson(url: string, headers: Record<string, string> = {}): Promise<any> {
  let res: Response;
  try { res = await fetch(url, { headers, signal: AbortSignal.timeout(12_000) }); }
  catch (err) { throw new WeatherError("连不上天气服务：" + (err as Error).message); }
  if (!res.ok) throw new WeatherError(`天气服务返回 ${res.status}`);
  return res.json();
}

const cityCache = new Map<string, Where>();
async function cityWhere(): Promise<Where> {
  const city = cfg("WEATHER_CITY").trim();
  const hit = cityCache.get(city);
  if (hit) return hit;
  const d = await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=zh`);
  const r = d.results?.[0];
  if (!r) throw new WeatherError(`找不到城市「${city}」，换个写法试试（比如 大阪 / Osaka）`);
  const w: Where = { lat: r.latitude, lon: r.longitude, name: [r.name, r.admin1].filter((x, i, a) => x && a.indexOf(x) === i).join("，"), source: "city" };
  cityCache.set(city, w);
  return w;
}

const placeCache = new Map<string, string>();
/** 坐标 → 地名（OpenStreetMap Nominatim，一个坐标只问一次）。失败就不带地名 */
async function placeName(lat: number, lon: number): Promise<string> {
  const key = `${lat},${lon}`;
  const hit = placeCache.get(key);
  if (hit !== undefined) return hit;
  let name = "";
  try {
    const d = await getJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=14&accept-language=zh,ja&lat=${lat}&lon=${lon}`, { "User-Agent": "kkssddd-personal-companion" });
    const a = d.address ?? {};
    name = [a.neighbourhood || a.suburb || a.quarter, a.city_district || a.city || a.town || a.village, a.state].filter((x, i, arr) => x && arr.indexOf(x) === i).join("，");
  } catch { /* 没有地名也能用 */ }
  placeCache.set(key, name);
  return name;
}

/** 最近一条位置事件（6 小时内）→ 否则设置里的城市 */
export async function whereNow(): Promise<Where> {
  const ev = db.eventsSince(Date.now() - LOCATION_MAX_AGE_MS).filter((e) => e.kind === "location").at(-1);
  const m = ev?.detail?.match(/^(-?\d+(?:\.\d+)?),\s*(-?\d+(?:\.\d+)?)$/);
  if (ev && m) {
    const lat = Number(m[1]), lon = Number(m[2]);
    return { lat, lon, name: (await placeName(lat, lon)) || `坐标 ${lat},${lon}`, source: "phone", ageMin: Math.round((Date.now() - ev.at) / 60_000) };
  }
  return cityWhere();
}

export async function locationText(): Promise<string> {
  const w = await whereNow();
  return w.source === "phone"
    ? `她大概在：${w.name}（手机 ${w.ageMin} 分钟前报的位置，精度约 1 公里）`
    : `没有最近的手机位置（6 小时内没收到），只知道她设置里的城市：${w.name}`;
}

const WMO: Record<number, string> = { 0: "晴", 1: "大致晴", 2: "多云", 3: "阴", 45: "雾", 48: "雾凇", 51: "小毛毛雨", 53: "毛毛雨", 55: "大毛毛雨", 61: "小雨", 63: "中雨", 65: "大雨", 66: "冻雨", 67: "强冻雨", 71: "小雪", 73: "中雪", 75: "大雪", 77: "雪粒", 80: "小阵雨", 81: "阵雨", 82: "强阵雨", 85: "阵雪", 86: "强阵雪", 95: "雷暴", 96: "雷暴伴冰雹", 99: "强雷暴伴冰雹" };
const wmo = (c: number) => WMO[c] ?? `天气代码 ${c}`;

export async function weatherText(): Promise<string> {
  const w = await whereNow();
  const d = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${w.lat}&longitude=${w.lon}&timezone=auto&forecast_days=4` +
      `&current=temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,precipitation` +
      `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max`,
  );
  const c = d.current;
  const lines = [
    `${w.source === "phone" ? "她现在大概在" : "按她设置的城市"}：${w.name}`,
    `现在：${wmo(c.weather_code)}，${c.temperature_2m}°C（体感 ${c.apparent_temperature}°C），湿度 ${c.relative_humidity_2m}%，风 ${c.wind_speed_10m} km/h${c.precipitation ? `，正在下雨/雪（${c.precipitation} mm）` : ""}`,
    "接下来几天：",
  ];
  const t = d.daily;
  const label = ["今天", "明天", "后天", "大后天"];
  for (let i = 0; i < t.time.length; i++) {
    lines.push(`- ${label[i] ?? t.time[i]}（${t.time[i]}）：${wmo(t.weather_code[i])}，${t.temperature_2m_min[i]}~${t.temperature_2m_max[i]}°C，降水概率 ${t.precipitation_probability_max[i] ?? "?"}%`);
  }
  return lines.join("\n");
}

export async function weatherStatus(): Promise<{ enabled: boolean; ok?: boolean; error?: string; detail?: string }> {
  if (!weatherEnabled) return { enabled: false };
  try {
    const w = await whereNow();
    return { enabled: true, ok: true, detail: `${w.source === "phone" ? "用手机最近报的位置" : "用设置里的城市"}：${w.name}` };
  } catch (err) {
    return { enabled: true, ok: false, error: (err as Error).message };
  }
}
