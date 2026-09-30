// 数独：出题（保证唯一解）、校验、提示。棋盘全部用 81 位字符串表示，'0' 或 '.' 为空。
import { getSetting, setSetting } from "./db.ts";

export type Difficulty = "easy" | "medium" | "hard";
export const DIFFICULTY_LABEL: Record<Difficulty, string> = { easy: "简单", medium: "中等", hard: "困难" };

export interface Game {
  difficulty: Difficulty;
  puzzle: string; // 题目（0 = 空）
  solution: string; // 答案
  cells: string; // 当前盘面
  by: string; // 每格是谁填的：g 题目给的 / p 小月 / c Claude / . 空
  startedAt: number;
  solvedAt: number | null;
  moves: number;
}

// ---------- 基础结构 ----------
const rc = (i: number) => [Math.floor(i / 9), i % 9] as const;
const boxOf = (i: number) => Math.floor(i / 27) * 3 + Math.floor((i % 9) / 3);

const UNITS: number[][] = [];
for (let r = 0; r < 9; r++) UNITS.push(Array.from({ length: 9 }, (_, c) => r * 9 + c));
for (let c = 0; c < 9; c++) UNITS.push(Array.from({ length: 9 }, (_, r) => r * 9 + c));
for (let b = 0; b < 9; b++)
  UNITS.push(
    Array.from({ length: 9 }, (_, k) => (Math.floor(b / 3) * 3 + Math.floor(k / 3)) * 9 + (b % 3) * 3 + (k % 3)),
  );

const PEERS: number[][] = Array.from({ length: 81 }, (_, i) => {
  const s = new Set<number>();
  for (const u of UNITS) if (u.includes(i)) for (const j of u) if (j !== i) s.add(j);
  return [...s];
});

const popcount = (m: number) => {
  let n = 0;
  for (; m; m &= m - 1) n++;
  return n;
};

/** 某格还能填哪些数字，返回位掩码（bit d 表示数字 d） */
function candMask(g: number[], i: number): number {
  let used = 0;
  for (const p of PEERS[i]) if (g[p]) used |= 1 << g[p];
  return ~used & 0x3fe;
}

const toGrid = (s: string) => Array.from(s, (ch) => (ch >= "1" && ch <= "9" ? Number(ch) : 0));
const toStr = (g: number[]) => g.join("");

// ---------- 求解 / 计数 ----------
function countSolutions(grid: number[], limit = 2): number {
  const g = grid.slice();
  let count = 0;
  const rec = () => {
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const m = candMask(g, i);
      const n = popcount(m);
      if (n === 0) return;
      if (n < bestN) { best = i; bestMask = m; bestN = n; if (n === 1) break; }
    }
    if (best < 0) { count++; return; }
    for (let d = 1; d <= 9 && count < limit; d++) {
      if (bestMask & (1 << d)) { g[best] = d; rec(); g[best] = 0; }
    }
  };
  rec();
  return count;
}

function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function randomSolution(): number[] {
  const g = new Array(81).fill(0);
  const rec = (): boolean => {
    let best = -1, bestMask = 0, bestN = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i]) continue;
      const m = candMask(g, i);
      const n = popcount(m);
      if (n === 0) return false;
      if (n < bestN) { best = i; bestMask = m; bestN = n; }
    }
    if (best < 0) return true;
    for (const d of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      if (bestMask & (1 << d)) {
        g[best] = d;
        if (rec()) return true;
        g[best] = 0;
      }
    }
    return false;
  };
  rec();
  return g;
}

/** 只靠「唯一候选数 / 唯一位置」两种基础技巧能不能解完 */
function solvableBySingles(grid: number[]): boolean {
  const g = grid.slice();
  for (;;) {
    const h = findSingle(g);
    if (!h) return g.every((v) => v);
    g[h.index] = h.value;
  }
}

interface Single {
  kind: "naked" | "hidden";
  index: number;
  value: number;
  unit?: "行" | "列" | "宫";
  unitNo?: number;
}

function findSingle(g: number[]): Single | null {
  // 唯一候选数：这格只剩一个数字能填
  for (let i = 0; i < 81; i++) {
    if (g[i]) continue;
    const m = candMask(g, i);
    if (popcount(m) === 1) return { kind: "naked", index: i, value: Math.log2(m) };
  }
  // 唯一位置：某个数字在一行/列/宫里只有一个格子能放
  for (let u = 0; u < 27; u++) {
    for (let d = 1; d <= 9; d++) {
      if (UNITS[u].some((i) => g[i] === d)) continue;
      const spots = UNITS[u].filter((i) => !g[i] && candMask(g, i) & (1 << d));
      if (spots.length === 1)
        return { kind: "hidden", index: spots[0], value: d, unit: (["行", "列", "宫"] as const)[Math.floor(u / 9)], unitNo: (u % 9) + 1 };
    }
  }
  return null;
}

// ---------- 出题 ----------
const TARGET_CLUES: Record<Difficulty, number> = { easy: 40, medium: 34, hard: 27 };

function carve(solution: number[], clues: number): number[] {
  const g = solution.slice();
  let left = 81;
  for (const i of shuffle(Array.from({ length: 81 }, (_, k) => k))) {
    if (left <= clues) break;
    const keep = g[i];
    g[i] = 0;
    if (countSolutions(g) !== 1) g[i] = keep;
    else left--;
  }
  return g;
}

export function generate(difficulty: Difficulty): Game {
  let puzzle: number[] = [];
  let solution: number[] = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    solution = randomSolution();
    puzzle = carve(solution, TARGET_CLUES[difficulty]);
    // 困难：要用到更高级的技巧才行，不行就换一盘重出
    if (difficulty === "hard" && !solvableBySingles(puzzle)) break;
    if (difficulty !== "hard") break;
  }
  if (difficulty !== "hard") {
    // 简单/中等：保证只靠基础技巧就能解完；解不完就多给几个数字
    const hidden = shuffle(puzzle.flatMap((v, i) => (v ? [] : [i])));
    while (!solvableBySingles(puzzle) && hidden.length) {
      const i = hidden.pop()!;
      puzzle[i] = solution[i];
    }
  }
  const p = toStr(puzzle);
  return {
    difficulty,
    puzzle: p,
    solution: toStr(solution),
    cells: p,
    by: Array.from(p, (ch) => (ch === "0" ? "." : "g")).join(""),
    startedAt: Date.now(),
    solvedAt: null,
    moves: 0,
  };
}

// ---------- 存取 ----------
export function loadGame(): Game | null {
  const raw = getSetting("sudoku");
  return raw ? (JSON.parse(raw) as Game) : null;
}
export const saveGame = (g: Game) => setSetting("sudoku", JSON.stringify(g));

export function currentOrNew(): Game {
  const g = loadGame();
  if (g) return g;
  const fresh = generate("medium");
  saveGame(fresh);
  return fresh;
}

// ---------- 落子 / 检查 ----------
/** 成功返回 null，失败返回原因。value 为 0 表示擦除 */
export function place(g: Game, index: number, value: number, who: "p" | "c"): string | null {
  if (!Number.isInteger(index) || index < 0 || index > 80) return "格子位置不对";
  if (!Number.isInteger(value) || value < 0 || value > 9) return "数字要在 1-9 之间（0 是擦除）";
  if (g.solvedAt) return "这盘已经完成了";
  if (g.puzzle[index] !== "0") return "这格是题目给的数字，不能改";
  g.cells = g.cells.slice(0, index) + value + g.cells.slice(index + 1);
  g.by = g.by.slice(0, index) + (value ? who : ".") + g.by.slice(index + 1);
  g.moves++;
  if (g.cells === g.solution) g.solvedAt = Date.now();
  return null;
}

/** 与同行/列/宫重复的格子 */
export function conflicts(cells: string): number[] {
  const g = toGrid(cells);
  return g.flatMap((v, i) => (v && PEERS[i].some((p) => g[p] === v) ? [i] : []));
}

/** 和答案不一致的格子（包括没有造成冲突的错误） */
export function wrongCells(g: Game): number[] {
  return Array.from(g.cells, (ch, i) => (ch !== "0" && ch !== g.solution[i] ? i : -1)).filter((i) => i >= 0);
}

export function publicState(g: Game) {
  return {
    difficulty: g.difficulty,
    label: DIFFICULTY_LABEL[g.difficulty],
    puzzle: g.puzzle,
    cells: g.cells,
    by: g.by,
    startedAt: g.startedAt,
    solvedAt: g.solvedAt,
    moves: g.moves,
    empty: Array.from(g.cells).filter((c) => c === "0").length,
    conflicts: conflicts(g.cells),
  };
}

// ---------- 给 Claude 用的文本 ----------
export const cellName = (i: number) => `r${rc(i)[0] + 1}c${rc(i)[1] + 1}`;

export function parseCell(name: string): number | null {
  const m = /^r([1-9])c([1-9])$/i.exec(name.trim());
  return m ? (Number(m[1]) - 1) * 9 + (Number(m[2]) - 1) : null;
}

export function viewText(g: Game): string {
  const rows = [];
  for (let r = 0; r < 9; r++) {
    const parts = [0, 1, 2].map((b) =>
      [0, 1, 2].map((k) => { const ch = g.cells[r * 9 + b * 3 + k]; return ch === "0" ? "." : ch; }).join(" "),
    );
    rows.push(`r${r + 1}  ${parts.join(" | ")}`);
    if (r % 3 === 2 && r < 8) rows.push("    ------+-------+------");
  }
  const bad = conflicts(g.cells);
  const wrong = wrongCells(g);
  const empty = Array.from(g.cells).filter((c) => c === "0").length;
  return [
    `数独（${DIFFICULTY_LABEL[g.difficulty]}），列号 c1..c9 从左到右，行号 r1..r9 从上到下。'.' 是空格。`,
    "    c1..c3 | c4..c6 | c7..c9",
    ...rows,
    `空格：${empty}`,
    `重复冲突的格子：${bad.length ? bad.map(cellName).join("、") : "无"}`,
    `和正确答案不一致的格子：${wrong.length ? wrong.map(cellName).join("、") : "无"}`,
    g.solvedAt ? "这盘已经完成。" : "还没完成。",
  ].join("\n");
}

/** 给出下一步提示：先指出填错的格子，再找基础技巧，实在没有就给出答案位置 */
export function hintText(g: Game): string {
  if (g.solvedAt) return "这盘已经完成了，没有要提示的。";
  const wrong = wrongCells(g);
  if (wrong.length) return `盘面上有填错的格子：${wrong.map(cellName).join("、")}。先让她检查这几格，再往下走。`;
  const s = findSingle(toGrid(g.cells));
  if (s) {
    const where = cellName(s.index);
    return s.kind === "naked"
      ? `技巧：唯一候选数。${where} 所在的行、列、宫已经排除了其余数字，只能填 ${s.value}。`
      : `技巧：唯一位置。在第 ${s.unitNo} ${s.unit}里，数字 ${s.value} 只有 ${where} 一个格子能放。`;
  }
  const empties = Array.from(g.cells, (ch, i) => (ch === "0" ? i : -1)).filter((i) => i >= 0);
  const i = empties.sort((a, b) => popcount(candMask(toGrid(g.cells), a)) - popcount(candMask(toGrid(g.cells), b)))[0];
  return `没有基础技巧能直接推出来了，需要更高级的办法（数对、区块排除、X-Wing 这类）。供你参考的答案：${cellName(i)} = ${g.solution[i]}。`;
}
