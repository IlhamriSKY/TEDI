/**
 * The marks drawn on a screenshot. A click read as a tiny box, or a number that
 * disagrees with the list, would point an AI at the wrong spot with no visible error.
 */
import {
  badgeRadius,
  drawMarks,
  markFromDrag,
  type Mark,
} from "../../src/modules/snapshot/annotate";

let failed = 0;
function ok(label: string, cond: boolean) {
  console.log(`  ${cond ? "ok  " : "FAIL:"} ${label}`);
  if (!cond) failed++;
}

const shown = { w: 500, h: 250 };

console.log("\n[markFromDrag] a click is a number, a drag is a box");
ok(
  "no travel is a point",
  markFromDrag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, shown).kind === "point",
);
ok(
  "a hand's small wobble is still a point",
  markFromDrag({ x: 0.5, y: 0.5 }, { x: 0.504, y: 0.504 }, shown).kind === "point",
);
const box = markFromDrag({ x: 0.8, y: 0.6 }, { x: 0.2, y: 0.1 }, shown);
ok(
  "dragging up and left still makes a box from its top-left",
  box.kind === "box" && box.x === 0.2 && box.y === 0.1 && Math.abs(box.w - 0.6) < 1e-9,
);
const out = markFromDrag({ x: 0.9, y: 0.5 }, { x: 1.4, y: -0.3 }, shown);
ok(
  "a drag past the edge stops at the image",
  out.kind === "box" && out.x + out.w === 1 && out.y === 0,
);

const arrow = markFromDrag({ x: 0.8, y: 0.6 }, { x: 0.2, y: 1.4 }, shown, "arrow");
ok(
  "an arrow keeps its direction, tail where the drag began, and stops at the edge",
  arrow.kind === "arrow" && arrow.x === 0.8 && arrow.x2 === 0.2 && arrow.y2 === 1,
);
ok(
  "with the arrow picked, a click is still a number",
  markFromDrag({ x: 0.5, y: 0.5 }, { x: 0.5, y: 0.5 }, shown, "arrow").kind === "point",
);

console.log("\n[badgeRadius] readable at any size");
ok("a small capture keeps a legible number", badgeRadius(300, 200) === 11);
ok("a 4K capture does not get a giant one", badgeRadius(3840, 2160) === 28);

console.log("\n[drawMarks] numbered by place in the list");
const texts: { t: string; x: number; y: number }[] = [];
let rects = 0;
const lines: { x: number; y: number }[] = [];
const ctx = {
  beginPath() {},
  moveTo() {},
  lineTo(x: number, y: number) {
    lines.push({ x, y });
  },
  closePath() {},
  arc() {},
  fill() {},
  stroke() {},
  strokeRect() {
    rects++;
  },
  fillText(t: string, x: number, y: number) {
    texts.push({ t, x, y });
  },
  fillStyle: "",
  strokeStyle: "",
  lineWidth: 0,
  font: "",
  textAlign: "center",
  textBaseline: "middle",
} as unknown as Parameters<typeof drawMarks>[0];
const marks: Mark[] = [
  { kind: "point", x: 0, y: 0 },
  { kind: "box", x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
  { kind: "point", x: 1, y: 1 },
  { kind: "arrow", x: 0.5, y: 0.5, x2: 0.9, y2: 0.5 },
];
drawMarks(ctx, 1000, 500, marks);
ok("every mark gets its number", texts.map((x) => x.t).join() === "1,2,3,4");
ok("an arrow carries its number at the tail", texts[3].x === 500 && texts[3].y === 250);
ok(
  "and its shaft stops short of the tip, under the head",
  lines[0].x < 900 && lines[0].x > 500 && lines[0].y === 250,
);
ok(
  "its head sits behind the tip, on both sides of the shaft",
  lines[2].x < 900 && lines[3].x < 900 && lines[2].y !== lines[3].y,
);
ok("a box is outlined with its halo under it", rects === 2);
ok(
  "a mark in the corner keeps its number inside the image",
  texts[0].x > 0 && texts[0].y > 0 && texts[2].x < 1000 && texts[2].y < 500,
);

if (failed > 0) throw new Error(`${failed} check(s) FAILED`);
console.log("\nsnapshot-annotate-verify: OK");
