#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const username = process.env.PROFILE_USERNAME || "dwainbrowne";
const year = Number(process.env.CHART_YEAR || new Date().getUTCFullYear());
const outputPath = process.env.CHART_OUTPUT || `commit-history-${year}.svg`;
const dataPath = process.env.CHART_DATA || `commit-history-${year}.json`;
const requestedAsOf = process.env.CHART_AS_OF || torontoDate();
const asOf = clampDate(requestedAsOf, `${year}-01-01`, `${year}-12-31`);
const refreshAll = process.argv.includes("--refresh-all");

const palette = {
  background: "#0d1117",
  border: "#30363d",
  foreground: "#f0f6fc",
  muted: "#8b949e",
  faint: "#21262d",
  accent: "#ff6b73",
  accentGlow: "#ff8a91",
};

const width = 960;
const height = 540;
const plot = { left: 104, right: 902, top: 126, bottom: 444 };

const weeks = buildWeeks(year);
const prior = readData(dataPath);
const priorByStart = new Map((prior.weeks || []).map((week) => [week.start, week]));
const elapsedWeeks = weeks.filter((week) => week.start <= asOf);
const counts = [];

for (let index = 0; index < elapsedWeeks.length; index += 1) {
  const week = elapsedWeeks[index];
  const queryEnd = week.end < asOf ? week.end : asOf;
  const cached = priorByStart.get(week.start);
  const isComplete = week.end < asOf;

  if (!refreshAll && isComplete && cached?.end === week.end && Number.isInteger(cached.count)) {
    counts.push({ ...week, count: cached.count });
    continue;
  }

  const count = await fetchCommitCount(username, week.start, queryEnd);
  counts.push({ ...week, end: queryEnd, count });
  process.stdout.write(`Week ${index + 1}/${elapsedWeeks.length}: ${week.start}..${queryEnd} = ${count}\n`);
  persistProgress(counts);

  if (index < elapsedWeeks.length - 1) {
    await delay(6500);
  }
}

const totalCommits = counts.reduce((sum, week) => sum + week.count, 0);
const data = {
  username,
  year,
  asOf,
  totalCommits,
  weeks: counts,
};

writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(outputPath, renderSvg(data));
process.stdout.write(`Rendered ${outputPath} with ${totalCommits.toLocaleString("en-US")} commits.\n`);

async function fetchCommitCount(login, from, to) {
  const query = `author:${login} author-date:${from}..${to}`;
  let raw = "";

  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      raw = execFileSync(
        "gh",
        [
          "api",
          "--method",
          "GET",
          "search/commits",
          "-H",
          "Accept: application/vnd.github+json",
          "-f",
          `q=${query}`,
          "-f",
          "per_page=1",
          "--jq",
          ".total_count",
        ],
        { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      ).trim();
      break;
    } catch (error) {
      const detail = `${error.stdout || ""}\n${error.stderr || ""}`;
      const throttled = detail.includes("rate limit") || detail.includes("HTTP 403");
      if (!throttled || attempt === 4) throw error;
      const waitMs = 70000 * attempt;
      process.stderr.write(`GitHub throttled the request; retrying in ${Math.round(waitMs / 1000)} seconds.\n`);
      await delay(waitMs);
    }
  }

  const count = Number(raw);
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`GitHub returned an invalid commit count for ${from}..${to}`);
  }
  return count;
}

function persistProgress(completedWeeks) {
  const progress = {
    username,
    year,
    asOf,
    totalCommits: completedWeeks.reduce((sum, week) => sum + week.count, 0),
    weeks: completedWeeks,
  };
  writeFileSync(dataPath, `${JSON.stringify(progress, null, 2)}\n`);
}

function renderSvg(chartData) {
  const points = [{ date: `${year}-01-01`, cumulative: 0 }];
  let cumulative = 0;
  for (const week of chartData.weeks) {
    cumulative += week.count;
    points.push({ date: week.end, cumulative });
  }

  const yScale = niceScale(Math.max(1, chartData.totalCommits));
  const yMax = yScale.maximum;
  const yTicks = Array.from(
    { length: Math.floor(yMax / yScale.step) + 1 },
    (_, index) => yScale.step * index,
  );
  const months = Array.from({ length: 12 }, (_, index) => ({
    label: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(year, index, 1))),
    date: `${year}-${String(index + 1).padStart(2, "0")}-01`,
  }));

  const x = (date) => {
    const start = Date.parse(`${year}-01-01T00:00:00Z`);
    const end = Date.parse(`${year}-12-31T23:59:59Z`);
    return plot.left + ((Date.parse(`${date}T12:00:00Z`) - start) / (end - start)) * (plot.right - plot.left);
  };
  const y = (value) => plot.bottom - (value / yMax) * (plot.bottom - plot.top);

  const path = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${x(point.date).toFixed(1)},${y(point.cumulative).toFixed(1)}`)
    .join(" ");
  const areaPath = `${path} L${x(points.at(-1).date).toFixed(1)},${plot.bottom} L${plot.left},${plot.bottom} Z`;

  const yMarkup = yTicks
    .map((tick) => {
      const yy = y(tick).toFixed(1);
      return `
        <line x1="${plot.left}" y1="${yy}" x2="${plot.right}" y2="${yy}" class="grid" />
        <text x="${plot.left - 18}" y="${Number(yy) + 5}" class="tick" text-anchor="end">${formatCompact(tick)}</text>`;
    })
    .join("");

  const monthMarkup = months
    .map((month) => {
      const xx = x(month.date).toFixed(1);
      return `
        <line x1="${xx}" y1="${plot.bottom}" x2="${xx}" y2="${plot.bottom + 8}" class="axis" />
        <text x="${xx}" y="${plot.bottom + 30}" class="month" text-anchor="${month.label === "Jan" ? "start" : month.label === "Dec" ? "end" : "middle"}">${month.label}</text>`;
    })
    .join("");

  const last = points.at(-1);
  const lastX = x(last.date);
  const lastY = y(last.cumulative);
  const totalLabelX = Math.min(plot.right - 12, lastX + 18);
  const labelAnchor = totalLabelX >= plot.right - 14 ? "end" : "start";
  const accessible = `${year} cumulative commit history for ${username}. ${chartData.totalCommits.toLocaleString("en-US")} authored commits through ${longDate(chartData.asOf)}.`;
  const pointMarkup = points
    .slice(1)
    .map((point) => `<circle cx="${x(point.date).toFixed(1)}" cy="${y(point.cumulative).toFixed(1)}" r="2.1" fill="${palette.accentGlow}" opacity="0.9" />`)
    .join("\n    ");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(accessible)}</title>
  <desc id="description">A hand-drawn-style line chart with weekly points from January through ${longDate(chartData.asOf)} and the remaining months visible through December.</desc>
  <defs>
    <filter id="rough" x="-3%" y="-3%" width="106%" height="106%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.13" numOctaves="1" seed="27" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.7" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <linearGradient id="lineGlow" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0" stop-color="${palette.accent}" stop-opacity="0.22" />
      <stop offset="1" stop-color="${palette.accent}" stop-opacity="0" />
    </linearGradient>
    <filter id="softGlow" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="4" result="blur" />
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
    <style>
      .hand { font-family: "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .title { fill: ${palette.foreground}; font: 700 25px "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .legend { fill: ${palette.foreground}; font: 600 17px "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .tick, .month, .axis-label, .updated { fill: ${palette.muted}; font-family: "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .tick { font-size: 15px; }
      .month { font-size: 15px; }
      .axis-label { fill: ${palette.foreground}; font-size: 17px; font-weight: 600; }
      .updated { font-size: 13px; }
      .grid { stroke: ${palette.faint}; stroke-width: 1; stroke-dasharray: 3 8; }
      .axis { stroke: ${palette.foreground}; stroke-width: 2.4; stroke-linecap: round; }
    </style>
  </defs>

  <rect x="1.5" y="1.5" width="957" height="537" rx="18" fill="${palette.background}" stroke="${palette.border}" stroke-width="3" />

  <g class="hand">
    <circle cx="376" cy="39" r="13" fill="${palette.faint}" />
    <text x="376" y="45" fill="${palette.foreground}" font-size="18" font-weight="700" text-anchor="middle">/</text>
    <text x="397" y="47" class="title">Commit History</text>

    <g transform="translate(${plot.left + 14} 88)">
      <rect x="0" y="-22" width="290" height="40" rx="7" fill="none" stroke="${palette.foreground}" stroke-width="2" filter="url(#rough)" />
      <rect x="14" y="-7" width="12" height="12" rx="3" fill="${palette.accent}" transform="rotate(-8 20 -1)" />
      <text x="36" y="5" class="legend">${escapeXml(username)} · ${chartData.totalCommits.toLocaleString("en-US")} commits</text>
    </g>

    ${yMarkup}
    <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}" class="axis" filter="url(#rough)" />
    <line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" class="axis" filter="url(#rough)" />
    ${monthMarkup}

    <path d="${areaPath}" fill="url(#lineGlow)" />
    <path d="${path}" fill="none" stroke="${palette.accent}" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" filter="url(#rough)" />
    ${pointMarkup}
    <circle cx="${lastX.toFixed(1)}" cy="${lastY.toFixed(1)}" r="5.5" fill="${palette.accentGlow}" filter="url(#softGlow)" />
    <text x="${totalLabelX.toFixed(1)}" y="${(lastY - 14).toFixed(1)}" fill="${palette.accentGlow}" font-size="17" font-weight="700" text-anchor="${labelAnchor}">${chartData.totalCommits.toLocaleString("en-US")}</text>

    <text x="${(plot.left + plot.right) / 2}" y="508" class="axis-label" text-anchor="middle">${year}</text>
    <text x="28" y="${(plot.top + plot.bottom) / 2}" class="axis-label" text-anchor="middle" transform="rotate(-90 28 ${(plot.top + plot.bottom) / 2})">Cumulative Commits</text>
    <text x="${plot.right}" y="508" class="updated" text-anchor="end">Updated ${escapeXml(longDate(chartData.asOf))}</text>
  </g>
</svg>
`;
}

function buildWeeks(chartYear) {
  const weeks = [];
  let cursor = new Date(Date.UTC(chartYear, 0, 1));
  const last = new Date(Date.UTC(chartYear, 11, 31));

  while (cursor <= last) {
    const start = new Date(cursor);
    const daysUntilSunday = (7 - start.getUTCDay()) % 7;
    const span = weeks.length === 0 ? daysUntilSunday : 6;
    const end = new Date(Math.min(start.getTime() + span * 86400000, last.getTime()));
    weeks.push({ start: isoDate(start), end: isoDate(end) });
    cursor = new Date(end.getTime() + 86400000);
  }
  return weeks;
}

function readData(path) {
  if (!existsSync(path)) return { weeks: [] };
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { weeks: [] };
  }
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

function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

function niceScale(value) {
  const roughStep = value / 5;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude;
  return {
    step,
    maximum: Math.ceil((value * 1.02) / step) * step,
  };
}

function formatCompact(value) {
  if (value === 0) return "0";
  if (value >= 1000) {
    const rounded = value / 1000;
    return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1)}K`;
  }
  return String(Math.round(value));
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

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
