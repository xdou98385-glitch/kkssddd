// 五子棋（15×15，自由规则：横竖斜连成五子即赢，没有禁手）。
// 小月执黑 ●，内置程序执白 ○。程序是简单的评分算法，不调用 Claude（不花钱）；Claude 只负责看棋盘、聊天。
import { getSetting, setSetting } from "./db.ts";

export const N = 15;
export type Level = "easy" | "normal" | "hard";
export const LEVEL_LABEL: Record<Level, string> = { easy: "容易", normal: "普通", hard: "较难" };

export interface Gomoku {
  cells: string; // 225 位：0 空 / 1 她 / 2 程序
  moves: [number, 1 | 2][];
  level: Level;
  first: "me" | "it";
  status: "playing" | "won" | "draw";
  winner: 0 | 1 | 2;
  line: number[];
  startedAt: number;
}

const DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]] as const;
const at = (cells: string, r: number, c: number) => (r < 0 || c < 0 || r >= N || c >= N ? "x" : cells[r * N + c]);

/** 刚下在 idx 的这一手，有没有连成五子；有就返回这条线上的格子 */
export function winLine(cells: string, idx: number): number[] | null {
  const p = cells[idx];
  if (p === "0") return null;
  const r0 = Math.floor(idx / N), c0 = idx % N;
  for (const [dr, dc] of DIRS) {
    const line = [idx];
    for (const s of [1, -1]) for (let k = 1; at(cells, r0 + dr * k * s, c0 + dc * k * s) === p; k++) line.push((r0 + dr * k * s) * N + c0 + dc * k * s);
    if (line.length >= 5) return line.sort((a, b) => a - b);
  }
  return null;
}

// ---- 程序下棋：给每个空点打分（自己的进攻 + 对方的威胁），挑最高的 ----
const PATTERNS: [RegExp, number][] = [
  [/xxxxx/g, 100000],
  [/\.xxxx\./g, 10000],
  [/xxxx\.|\.xxxx|x\.xxx|xxx\.x|xx\.xx/g, 1500],
  [/\.xxx\.|\.x\.xx\.|\.xx\.x\./g, 900],
  [/xxx\.|\.xxx|x\.xx|xx\.x|\.x\.xx|xx\.x\./g, 120],
  [/\.xx\.|\.x\.x\./g, 70],
  [/xx\.|\.xx|x\.x/g, 12],
];
/** 假设 player 下在 idx，四个方向的形状合计打分 */
function shapeScore(cells: string, idx: number, player: "1" | "2"): number {
  const r0 = Math.floor(idx / N), c0 = idx % N;
  let total = 0;
  for (const [dr, dc] of DIRS) {
    let s = "";
    for (let k = -4; k <= 4; k++) {
      if (k === 0) { s += "x"; continue; }
      const v = at(cells, r0 + dr * k, c0 + dc * k);
      s += v === "0" ? "." : v === player ? "x" : "o"; // o = 对方的子或边界
    }
    let best = 0;
    for (const [re, score] of PATTERNS) {
      re.lastIndex = 0;
      for (let m = re.exec(s); m; m = re.exec(s)) {
        if (m.index <= 4 && m.index + m[0].length > 4) { best = Math.max(best, score); break; } // 必须包含刚下的这一子
        re.lastIndex = m.index + 1;
      }
    }
    total += best;
  }
  return total;
}

function candidates(cells: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < N * N; i++) {
    if (cells[i] !== "0") continue;
    const r = Math.floor(i / N), c = i % N;
    let near = false;
    for (let dr = -2; dr <= 2 && !near; dr++) for (let dc = -2; dc <= 2; dc++) if (at(cells, r + dr, c + dc) === "1" || at(cells, r + dr, c + dc) === "2") { near = true; break; }
    if (near) out.push(i);
  }
  return out;
}

export function engineMove(cells: string, level: Level, rnd: () => number = Math.random): number {
  const cand = candidates(cells);
  if (!cand.length) return cells.indexOf("0") === -1 ? -1 : Math.floor(N / 2) * N + Math.floor(N / 2); // 空盘下天元
  const def = level === "easy" ? 0.6 : level === "normal" ? 0.95 : 1.1;
  const noise = level === "easy" ? 0.5 : level === "normal" ? 0.12 : 0;
  const scored = cand.map((i) => {
    const atk = shapeScore(cells, i, "2"), dfn = shapeScore(cells, i, "1");
    const centre = 8 - Math.max(Math.abs(Math.floor(i / N) - 7), Math.abs((i % N) - 7)); // 同分时偏向中间
    let s = atk + dfn * def + centre;
    if (atk >= 100000) s += 1e9; // 自己能连五，直接赢
    else if (dfn >= 100000) s += 5e8; // 对方下一步连五，必须堵
    return { i, s: s * (1 + (rnd() - 0.5) * noise) };
  }).sort((a, b) => b.s - a.s);
  return scored[0].i;
}

// ---- 一局棋的状态（存在 settings 里）----
const KEY = "gomoku";
const fresh = (level: Level, first: "me" | "it"): Gomoku => {
  const g: Gomoku = { cells: "0".repeat(N * N), moves: [], level, first, status: "playing", winner: 0, line: [], startedAt: Date.now() };
  if (first === "it") put(g, engineMove(g.cells, level), 2);
  return g;
};
function put(g: Gomoku, idx: number, who: 1 | 2): void {
  g.cells = g.cells.slice(0, idx) + who + g.cells.slice(idx + 1);
  g.moves.push([idx, who]);
  const line = winLine(g.cells, idx);
  if (line) { g.status = "won"; g.winner = who; g.line = line; }
  else if (!g.cells.includes("0")) g.status = "draw";
}
export function load(): Gomoku {
  try { const g = JSON.parse(getSetting(KEY) || "null"); if (g?.cells?.length === N * N) return g as Gomoku; } catch { /* 坏了就开新局 */ }
  const g = fresh("normal", "me");
  save(g);
  return g;
}
export const save = (g: Gomoku) => setSetting(KEY, JSON.stringify(g));
export function newGame(level: string, first: string): Gomoku {
  const g = fresh(level === "easy" || level === "hard" ? level : "normal", first === "it" ? "it" : "me");
  save(g);
  return g;
}

/** 她下一手，程序接着回一手。出错返回原因 */
export function play(index: number): string | null {
  const g = load();
  if (g.status !== "playing") return "这局已经结束了，开新的吧";
  if (!Number.isInteger(index) || index < 0 || index >= N * N) return "位置不对";
  if (g.cells[index] !== "0") return "这里已经有子了";
  put(g, index, 1);
  if (g.status === "playing") {
    const m = engineMove(g.cells, g.level);
    if (m >= 0) put(g, m, 2);
  }
  save(g);
  return null;
}

/** 悔棋：撤到她上一手之前 */
export function undo(): string | null {
  const g = load();
  if (!g.moves.length) return "还没下呢";
  while (g.moves.length) { const [, who] = g.moves.pop()!; if (who === 1) break; }
  g.cells = "0".repeat(N * N);
  for (const [i, who] of g.moves) g.cells = g.cells.slice(0, i) + who + g.cells.slice(i + 1);
  g.status = "playing"; g.winner = 0; g.line = [];
  save(g);
  return null;
}

export function publicState(g: Gomoku) {
  const last = (who: 1 | 2) => [...g.moves].reverse().find((m) => m[1] === who)?.[0] ?? -1;
  return { cells: g.cells, status: g.status, winner: g.winner, line: g.line, level: g.level, levelLabel: LEVEL_LABEL[g.level], first: g.first, moves: g.moves.length, lastMe: last(1), lastIt: last(2) };
}

// ---- 给 Claude 看的文字 ----
const COLS = "ABCDEFGHIJKLMNO";
export const nameOf = (i: number) => `${COLS[i % N]}${Math.floor(i / N) + 1}`;
export function viewText(g: Gomoku): string {
  const rows = [`   ${COLS.split("").join(" ")}`];
  for (let r = 0; r < N; r++) rows.push(`${String(r + 1).padStart(2)} ${Array.from({ length: N }, (_, c) => ({ "0": "·", "1": "●", "2": "○" })[g.cells[r * N + c] as "0" | "1" | "2"]).join(" ")}`);
  const last = g.moves.slice(-6).map(([i, w]) => `${w === 1 ? "她" : "程序"}${nameOf(i)}`).join(" → ");
  const state = g.status === "won" ? (g.winner === 1 ? `她赢了（${g.line.map(nameOf).join(" ")} 连成五子）` : `程序赢了（${g.line.map(nameOf).join(" ")} 连成五子）`) : g.status === "draw" ? "平局，棋盘满了" : "还在下";
  return [`五子棋（● 是小月，○ 是内置程序替你下的白棋；列 A-O，行 1-15）。难度：${LEVEL_LABEL[g.level]}，${g.first === "me" ? "她先手" : "程序先手"}，共 ${g.moves.length} 手，${state}。`, rows.join("\n"), g.moves.length ? `最近几手：${last}` : "还没有人落子"].join("\n");
}
