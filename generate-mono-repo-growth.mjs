#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { extname } from "node:path";

const repoPath = process.env.MONO_REPO_PATH || process.argv[2];
if (!repoPath) {
  throw new Error("Pass the mono-repo path as the first argument or MONO_REPO_PATH.");
}

const year = Number(process.env.CHART_YEAR || new Date().getUTCFullYear());
const requestedAsOf = process.env.CHART_AS_OF || torontoDate();
const asOf = clampDate(requestedAsOf, `${year}-01-01`, `${year}-12-31`);
const outputPath = process.env.CHART_OUTPUT || "mono-repo-growth.svg";
const dataPath = process.env.CHART_DATA || "mono-repo-growth.json";

const sourceExtensions = new Set([
  ".astro", ".bash", ".c", ".cc", ".cpp", ".cs", ".cshtml", ".css", ".dart",
  ".fs", ".fsx", ".go", ".gql", ".graphql", ".h", ".hcl", ".hpp", ".html",
  ".java", ".js", ".jsx", ".kt", ".kts", ".less", ".lua", ".m", ".mjs", ".mm",
  ".php", ".pl", ".proto", ".ps1", ".py", ".r", ".rb", ".razor", ".rs", ".sass",
  ".scss", ".sh", ".sql", ".svelte", ".swift", ".tf", ".ts", ".tsx", ".vb",
  ".vue", ".xml", ".yaml", ".yml", ".zsh",
]);

const excludedSegments = new Set([
  ".next", ".nuxt", ".output", "build", "coverage", "dist", "generated", "node_modules", "vendor",
]);

const palette = {
  background: "#0d1117",
  border: "#30363d",
  foreground: "#f0f6fc",
  muted: "#8b949e",
  faint: "#21262d",
  accent: "#ff6b73",
  accentGlow: "#ff8a91",
};

const trackedFiles = git(["ls-files", "-z"])
  .split("\0")
  .filter(Boolean)
  .filter(isSourcePath);

let currentSourceLines = 0;
for (const path of trackedFiles) {
  const fullPath = `${repoPath}/${path}`;
  if (!existsSync(fullPath)) continue;
  const content = readFileSync(fullPath, "utf8");
  currentSourceLines += content.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
}

const additionsByMonth = new Map(
  Array.from({ length: 12 }, (_, index) => [monthKey(year, index), 0]),
);

let activeMonth = null;
const history = git([
  "log",
  "--no-merges",
  "--numstat",
  "--format=@@@%aI",
  `--since=${year}-01-01T00:00:00Z`,
  `--until=${asOf}T23:59:59Z`,
  "HEAD",
]);

for (const line of history.split("\n")) {
  if (line.startsWith("@@@")) {
    activeMonth = line.slice(3, 10);
    continue;
  }
  if (!activeMonth || !additionsByMonth.has(activeMonth)) continue;
  const match = line.match(/^(\d+)\t(?:\d+|-)\t(.+)$/);
  if (!match || !isSourcePath(match[2])) continue;
  additionsByMonth.set(activeMonth, additionsByMonth.get(activeMonth) + Number(match[1]));
}

const lastMonthIndex = Number(asOf.slice(5, 7)) - 1;
const months = Array.from({ length: lastMonthIndex + 1 }, (_, index) => {
  const key = monthKey(year, index);
  return {
    month: key,
    label: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, index, 1))),
    additions: additionsByMonth.get(key),
    partial: index === lastMonthIndex && asOf !== endOfMonth(year, index),
  };
});

const data = {
  repository: "snapsuiteio/mono-repo",
  branch: process.env.MONO_REPO_BRANCH || git(["rev-parse", "--abbrev-ref", "HEAD"]).trim(),
  commit: git(["rev-parse", "HEAD"]).trim(),
  year,
  asOf,
  managedRepositories: 100,
  currentSourceLines,
  trackedSourceFiles: trackedFiles.length,
  metric: {
    monthly: "Gross added non-blank lines in non-merge commits, grouped by author date.",
    current: "Non-blank lines in tracked source files at the measured commit.",
    exclusions: "Generated, build, dependency, coverage, and minified files are excluded.",
  },
  months,
};

writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(outputPath, renderSvg(data));
process.stdout.write(
  `Rendered ${outputPath}: ${currentSourceLines.toLocaleString("en-US")} current source lines across ${trackedFiles.length.toLocaleString("en-US")} files.\n`,
);

function git(args) {
  return execFileSync("git", ["-C", repoPath, ...args], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 256,
  });
}

function isSourcePath(path) {
  const normalized = path.replaceAll("\\", "/");
  const segments = normalized.toLowerCase().split("/");
  if (segments.some((segment) => excludedSegments.has(segment))) return false;
  if (/\.(?:min|bundle)\.[cm]?[jt]s$/i.test(normalized)) return false;
  if (/\.generated\.[^.]+$/i.test(normalized)) return false;
  return sourceExtensions.has(extname(normalized).toLowerCase());
}

function renderSvg(chartData) {
  const width = 960;
  const height = 540;
  const plot = { left: 92, right: 912, top: 184, bottom: 432 };
  const maximum = Math.max(1, ...chartData.months.map((month) => month.additions));
  const scale = niceScale(maximum);
  const yTicks = Array.from({ length: Math.floor(scale.maximum / scale.step) + 1 }, (_, index) => index * scale.step);
  const slot = (plot.right - plot.left) / 12;
  const barWidth = Math.min(50, slot * 0.7);
  const y = (value) => plot.bottom - (value / scale.maximum) * (plot.bottom - plot.top);

  const gridMarkup = yTicks.map((tick) => {
    const yy = y(tick).toFixed(1);
    return `<line x1="${plot.left}" y1="${yy}" x2="${plot.right}" y2="${yy}" class="grid" />
      <text x="${plot.left - 16}" y="${Number(yy) + 5}" class="tick" text-anchor="end">${formatCompact(tick)}</text>`;
  }).join("\n      ");

  const barsMarkup = Array.from({ length: 12 }, (_, index) => {
    const month = chartData.months[index];
    const center = plot.left + slot * index + slot / 2;
    const label = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, index, 1)));
    const monthLabel = `<text x="${center.toFixed(1)}" y="462" class="month" text-anchor="middle">${label}</text>`;
    if (!month) return monthLabel;
    const top = y(month.additions);
    const heightValue = Math.max(2, plot.bottom - top);
    const valueLabel = month.partial ? `${formatCompact(month.additions)}*` : formatCompact(month.additions);
    return `<rect x="${(center - barWidth / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${heightValue.toFixed(1)}" rx="5" fill="url(#barFill)" filter="url(#rough)" />
      <text x="${center.toFixed(1)}" y="${Math.max(plot.top + 14, top - 10).toFixed(1)}" class="value" text-anchor="middle">${valueLabel}</text>
      ${monthLabel}`;
  }).join("\n      ");

  const accessible = `${year} monthly gross source line additions for the SnapSuite mono-repo through ${longDate(chartData.asOf)}. The repository currently contains ${chartData.currentSourceLines.toLocaleString("en-US")} non-blank source lines.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(accessible)}</title>
  <desc id="description">A hand-drawn-style monthly bar chart. The current partial month is marked with an asterisk.</desc>
  <defs>
    <filter id="rough" x="-3%" y="-3%" width="106%" height="106%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.13" numOctaves="1" seed="27" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.35" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <linearGradient id="barFill" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${palette.accentGlow}" />
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0.45" />
    </linearGradient>
    <style>
      .title { fill: ${palette.foreground}; font: 700 25px "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .kpi-label, .tick, .month, .updated, .note { fill: ${palette.muted}; font-family: "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .kpi-value, .axis-label, .value { fill: ${palette.foreground}; font-family: "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; font-weight: 700; }
      .kpi-value { font-size: 23px; }
      .kpi-label { font-size: 13px; }
      .tick, .month { font-size: 14px; }
      .value { fill: ${palette.accentGlow}; font-size: 13px; }
      .axis-label { font-size: 16px; }
      .updated, .note { font-size: 12px; }
      .grid { stroke: ${palette.faint}; stroke-width: 1; stroke-dasharray: 3 8; }
      .axis { stroke: ${palette.foreground}; stroke-width: 2.2; stroke-linecap: round; }
    </style>
  </defs>

  <rect x="1.5" y="1.5" width="957" height="537" rx="18" fill="${palette.background}" stroke="${palette.border}" stroke-width="3" />
  <circle cx="335" cy="39" r="13" fill="${palette.faint}" />
  <text x="335" y="45" fill="${palette.foreground}" font-size="18" font-weight="700" text-anchor="middle">+</text>
  <text x="356" y="47" class="title">Mono-repo Code Growth</text>

  <g transform="translate(92 70)">
    <rect x="0" y="0" width="242" height="74" rx="9" fill="none" stroke="${palette.border}" stroke-width="2" filter="url(#rough)" />
    <text x="18" y="31" class="kpi-value">${chartData.managedRepositories}</text>
    <text x="18" y="54" class="kpi-label">Repositories managed</text>
  </g>
  <g transform="translate(351 70)">
    <rect x="0" y="0" width="517" height="74" rx="9" fill="none" stroke="${palette.accent}" stroke-width="2" filter="url(#rough)" />
    <text x="18" y="31" class="kpi-value">${chartData.currentSourceLines.toLocaleString("en-US")}</text>
    <text x="18" y="54" class="kpi-label">Current non-blank source lines · snapsuiteio/mono-repo</text>
  </g>

  ${gridMarkup}
  <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}" class="axis" filter="url(#rough)" />
  <line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" class="axis" filter="url(#rough)" />
  ${barsMarkup}

  <text x="28" y="${(plot.top + plot.bottom) / 2}" class="axis-label" text-anchor="middle" transform="rotate(-90 28 ${(plot.top + plot.bottom) / 2})">Gross Lines Added</text>
  <text x="92" y="500" class="note">* Current month is partial · generated, dependency, build, coverage and minified files excluded</text>
  <text x="912" y="500" class="updated" text-anchor="end">Updated ${escapeXml(longDate(chartData.asOf))}</text>
  <text x="912" y="519" class="updated" text-anchor="end">${escapeXml(chartData.commit.slice(0, 9))}</text>
</svg>
`;
}

function monthKey(chartYear, zeroBasedMonth) {
  return `${chartYear}-${String(zeroBasedMonth + 1).padStart(2, "0")}`;
}

function endOfMonth(chartYear, zeroBasedMonth) {
  return new Date(Date.UTC(chartYear, zeroBasedMonth + 1, 0)).toISOString().slice(0, 10);
}

function niceScale(value) {
  const roughStep = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude;
  return { step, maximum: Math.max(step, Math.ceil((value * 1.08) / step) * step) };
}

function formatCompact(value) {
  if (value === 0) return "0";
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(value >= 100_000 ? 0 : 1)}K`;
  return String(value);
}

function torontoDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function clampDate(value, minimum, maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

function longDate(value) {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${value}T12:00:00Z`));
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
