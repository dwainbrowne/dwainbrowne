#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const repository = process.env.PERFORMANCE_REPOSITORY || "snapsuiteio/mono-repo";
const year = Number(process.env.CHART_YEAR || new Date().getUTCFullYear());
const requestedAsOf = process.env.CHART_AS_OF || torontoDate();
const asOf = clampDate(requestedAsOf, `${year}-01-01`, `${year}-12-31`);
const outputPath = process.env.CHART_OUTPUT || "delivery-performance.svg";
const dataPath = process.env.CHART_DATA || "delivery-performance.json";
const lastMonthIndex = Number(asOf.slice(5, 7)) - 1;

const monthRanges = Array.from({ length: lastMonthIndex + 1 }, (_, index) => {
  const start = `${year}-${String(index + 1).padStart(2, "0")}-01`;
  const naturalEnd = endOfMonth(year, index);
  return {
    key: start.slice(0, 7),
    label: new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, index, 1))),
    start,
    end: naturalEnd < asOf ? naturalEnd : asOf,
    partial: index === lastMonthIndex && asOf !== naturalEnd,
  };
});

const searchFields = monthRanges.flatMap((month, index) => {
  const alias = `m${String(index + 1).padStart(2, "0")}`;
  return [
    `${alias}Pr: search(query: ${JSON.stringify(`repo:${repository} is:pr is:merged merged:${month.start}..${month.end}`)}, type: ISSUE, first: 1) { issueCount }`,
    `${alias}Issue: search(query: ${JSON.stringify(`repo:${repository} is:issue is:closed closed:${month.start}..${month.end}`)}, type: ISSUE, first: 1) { issueCount }`,
  ];
});

const searchData = JSON.parse(gh(["api", "graphql", "-f", `query=query { ${searchFields.join(" ")} }`])).data;
const releases = JSON.parse(gh([
  "api", "--paginate", "--slurp", "--method", "GET",
  `repos/${repository}/releases`, "-f", "per_page=100",
])).flat();

const releaseCounts = new Map();
for (const release of releases) {
  if (release.draft || !release.published_at) continue;
  const key = release.published_at.slice(0, 7);
  releaseCounts.set(key, (releaseCounts.get(key) || 0) + 1);
}

const months = monthRanges.map((month, index) => {
  const alias = `m${String(index + 1).padStart(2, "0")}`;
  return {
    month: month.key,
    label: month.label,
    mergedPullRequests: searchData[`${alias}Pr`].issueCount,
    closedIssues: searchData[`${alias}Issue`].issueCount,
    publishedReleases: releaseCounts.get(month.key) || 0,
    partial: month.partial,
  };
});

const totals = months.reduce(
  (sum, month) => ({
    mergedPullRequests: sum.mergedPullRequests + month.mergedPullRequests,
    closedIssues: sum.closedIssues + month.closedIssues,
    publishedReleases: sum.publishedReleases + month.publishedReleases,
  }),
  { mergedPullRequests: 0, closedIssues: 0, publishedReleases: 0 },
);

const data = {
  repository,
  year,
  asOf,
  totals,
  metric: {
    mergedPullRequests: "Pull requests whose GitHub merged timestamp falls in the month.",
    closedIssues: "Issues, excluding pull requests, whose GitHub closed timestamp falls in the month.",
    publishedReleases: "Non-draft GitHub releases whose published timestamp falls in the month.",
  },
  months,
};

writeFileSync(dataPath, `${JSON.stringify(data, null, 2)}\n`);
writeFileSync(outputPath, renderSvg(data));
process.stdout.write(
  `Rendered ${outputPath}: ${totals.mergedPullRequests} merged PRs, ${totals.closedIssues} closed issues, ${totals.publishedReleases} published releases.\n`,
);

function gh(args) {
  return execFileSync("gh", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 64,
    env: process.env,
  });
}

function renderSvg(chartData) {
  const palette = {
    background: "#0d1117",
    border: "#30363d",
    foreground: "#f0f6fc",
    muted: "#8b949e",
    faint: "#21262d",
    pullRequests: "#ff6b73",
    issues: "#58a6ff",
    releases: "#3fb950",
  };
  const plot = { left: 86, right: 914, top: 190, bottom: 430 };
  const values = chartData.months.flatMap((month) => [
    month.mergedPullRequests,
    month.closedIssues,
    month.publishedReleases,
  ]);
  const scale = niceScale(Math.max(1, ...values));
  const slot = (plot.right - plot.left) / 12;
  const groupWidth = Math.min(58, slot * 0.8);
  const barGap = 2;
  const barWidth = (groupWidth - barGap * 2) / 3;
  const y = (value) => plot.bottom - (value / scale.maximum) * (plot.bottom - plot.top);
  const yTicks = Array.from({ length: Math.floor(scale.maximum / scale.step) + 1 }, (_, index) => index * scale.step);

  const grid = yTicks.map((tick) => {
    const yy = y(tick).toFixed(1);
    return `<line x1="${plot.left}" y1="${yy}" x2="${plot.right}" y2="${yy}" class="grid" />
      <text x="${plot.left - 14}" y="${Number(yy) + 5}" class="tick" text-anchor="end">${tick}</text>`;
  }).join("\n      ");

  const bars = Array.from({ length: 12 }, (_, index) => {
    const month = chartData.months[index];
    const center = plot.left + slot * index + slot / 2;
    const label = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" })
      .format(new Date(Date.UTC(year, index, 1)));
    const monthLabel = `<text x="${center.toFixed(1)}" y="459" class="month" text-anchor="middle">${label}${month?.partial ? "*" : ""}</text>`;
    if (!month) return monthLabel;

    const series = [
      [month.mergedPullRequests, palette.pullRequests],
      [month.closedIssues, palette.issues],
      [month.publishedReleases, palette.releases],
    ];
    const groupStart = center - groupWidth / 2;
    const monthBars = series.map(([value, color], seriesIndex) => {
      const top = y(value);
      const height = value === 0 ? 0 : Math.max(2, plot.bottom - top);
      const x = groupStart + seriesIndex * (barWidth + barGap);
      return `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="3" fill="${color}" opacity="0.9" filter="url(#rough)" />`;
    }).join("\n      ");
    return `${monthBars}\n      ${monthLabel}`;
  }).join("\n      ");

  const accessible = `${year} delivery performance for ${chartData.repository} through ${longDate(chartData.asOf)}: ${chartData.totals.mergedPullRequests} merged pull requests, ${chartData.totals.closedIssues} closed issues, and ${chartData.totals.publishedReleases} published releases.`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-labelledby="title description">
  <title id="title">${escapeXml(accessible)}</title>
  <desc id="description">A grouped monthly bar chart. Coral bars are merged pull requests, blue bars are closed issues, and green bars are published releases. The current partial month is marked with an asterisk.</desc>
  <defs>
    <filter id="rough" x="-4%" y="-4%" width="108%" height="108%">
      <feTurbulence type="fractalNoise" baseFrequency="0.018 0.13" numOctaves="1" seed="31" result="noise" />
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="1.15" xChannelSelector="R" yChannelSelector="G" />
    </filter>
    <style>
      .title { fill: ${palette.foreground}; font: 700 25px "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .kpi-value, .axis-label { fill: ${palette.foreground}; font-family: "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; font-weight: 700; }
      .kpi-value { font-size: 23px; }
      .kpi-label, .tick, .month, .updated, .note { fill: ${palette.muted}; font-family: "Comic Sans MS", "Chalkboard SE", "Bradley Hand", "Segoe Print", cursive; }
      .kpi-label { font-size: 13px; }
      .tick, .month { font-size: 14px; }
      .axis-label { font-size: 16px; }
      .updated, .note { font-size: 12px; }
      .grid { stroke: ${palette.faint}; stroke-width: 1; stroke-dasharray: 3 8; }
      .axis { stroke: ${palette.foreground}; stroke-width: 2.2; stroke-linecap: round; }
    </style>
  </defs>

  <rect x="1.5" y="1.5" width="957" height="537" rx="18" fill="${palette.background}" stroke="${palette.border}" stroke-width="3" />
  <circle cx="333" cy="39" r="13" fill="${palette.faint}" />
  <text x="333" y="45" fill="${palette.foreground}" font-size="17" font-weight="700" text-anchor="middle">✓</text>
  <text x="354" y="47" class="title">Monthly Delivery Performance</text>

  ${kpiCard(86, 70, 250, chartData.totals.mergedPullRequests, "Pull requests merged", palette.pullRequests)}
  ${kpiCard(355, 70, 250, chartData.totals.closedIssues, "Issues closed", palette.issues)}
  ${kpiCard(624, 70, 250, chartData.totals.publishedReleases, "Releases published", palette.releases)}

  ${grid}
  <line x1="${plot.left}" y1="${plot.top}" x2="${plot.left}" y2="${plot.bottom}" class="axis" filter="url(#rough)" />
  <line x1="${plot.left}" y1="${plot.bottom}" x2="${plot.right}" y2="${plot.bottom}" class="axis" filter="url(#rough)" />
  ${bars}

  <text x="28" y="${(plot.top + plot.bottom) / 2}" class="axis-label" text-anchor="middle" transform="rotate(-90 28 ${(plot.top + plot.bottom) / 2})">Completed Items</text>
  <text x="86" y="500" class="note">* Current month is partial · GitHub timestamps · snapsuiteio/mono-repo</text>
  <text x="914" y="500" class="updated" text-anchor="end">Updated ${escapeXml(longDate(chartData.asOf))}</text>
</svg>
`;

  function kpiCard(x, y, width, value, label, color) {
    return `<g transform="translate(${x} ${y})">
    <rect x="0" y="0" width="${width}" height="74" rx="9" fill="none" stroke="${color}" stroke-width="2" filter="url(#rough)" />
    <rect x="18" y="17" width="11" height="11" rx="3" fill="${color}" />
    <text x="39" y="31" class="kpi-value">${value.toLocaleString("en-US")}</text>
    <text x="18" y="54" class="kpi-label">${escapeXml(label)}</text>
  </g>`;
  }
}

function niceScale(value) {
  const roughStep = value / 4;
  const magnitude = 10 ** Math.floor(Math.log10(roughStep));
  const normalized = roughStep / magnitude;
  const nice = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  const step = nice * magnitude;
  return { step, maximum: Math.max(step, Math.ceil((value * 1.08) / step) * step) };
}

function endOfMonth(chartYear, zeroBasedMonth) {
  return new Date(Date.UTC(chartYear, zeroBasedMonth + 1, 0)).toISOString().slice(0, 10);
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
