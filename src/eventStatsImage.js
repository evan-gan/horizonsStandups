#!/usr/bin/env node
// Fetch sub-event stats from the integrations endpoint, render a dashboard SVG,
// then rasterize it to PNG with sharp. Text inside each panel is auto-sized so
// labels and values fill the empty space rather than floating in it.

const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const sharp = require("sharp");
const { Resvg } = require("@resvg/resvg-js");

const DEFAULT_EVENT_NAME = "Test Event";

const OUTPUT_DIR = path.resolve(__dirname, "..", "output");
const PNG_SCALE = 2; // Render at 2× pixel density for crisp text on retina/print.

// resvg-js loads the font file directly — no fontconfig, no @font-face data
// URIs (which librsvg quietly ignores). The family name is read from the
// font's `name` table at startup so swapping the file in assets/ Just Works.
const BUNDLED_FONT_PATH = path.resolve(__dirname, "..", "assets", "Play-Bold.ttf");
const BUNDLED_FONT_FAMILY = readFontFamilyName(BUNDLED_FONT_PATH);

/**
 * Read the font family name from a TTF, OTF, or WOFF file's `name` table so we
 * don't have to keep BUNDLED_FONT_FAMILY in sync with the bundled file. Falls
 * back to "sans-serif" if parsing fails so rendering still produces something.
 */
function readFontFamilyName(filePath) {
  try {
    const buffer = fs.readFileSync(filePath);
    const isWoff = buffer.slice(0, 4).toString("ascii") === "wOFF";
    const tables = isWoff ? readWoffTables(buffer) : readSfntTables(buffer);
    const nameTable = tables.get("name");
    if (!nameTable) return "sans-serif";
    return parseNameTable(nameTable) || "sans-serif";
  } catch (error) {
    console.warn(`[stats-image] could not parse font family from ${filePath}: ${error.message}`);
    return "sans-serif";
  }
}

function readSfntTables(buffer) {
  const numTables = buffer.readUInt16BE(4);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const entryOffset = 12 + i * 16;
    const tag = buffer.slice(entryOffset, entryOffset + 4).toString("ascii");
    const offset = buffer.readUInt32BE(entryOffset + 8);
    const length = buffer.readUInt32BE(entryOffset + 12);
    tables.set(tag, buffer.slice(offset, offset + length));
  }
  return tables;
}

function readWoffTables(buffer) {
  const numTables = buffer.readUInt16BE(12);
  const tables = new Map();
  for (let i = 0; i < numTables; i++) {
    const entryOffset = 44 + i * 20;
    const tag = buffer.slice(entryOffset, entryOffset + 4).toString("ascii");
    const offset = buffer.readUInt32BE(entryOffset + 4);
    const compLength = buffer.readUInt32BE(entryOffset + 8);
    const origLength = buffer.readUInt32BE(entryOffset + 12);
    const raw = buffer.slice(offset, offset + compLength);
    const data = compLength < origLength ? zlib.inflateSync(raw) : raw;
    tables.set(tag, data);
  }
  return tables;
}

/**
 * Pull the best font-family string out of an sfnt `name` table. Prefers
 * NameID 16 (Typographic Family) over 1 (Font Family) and English-Windows
 * encoding over everything else, falling back to NameID 4 (Full Name).
 */
function parseNameTable(nameTable) {
  const count = nameTable.readUInt16BE(2);
  const stringOffset = nameTable.readUInt16BE(4);
  const candidates = [];
  for (let i = 0; i < count; i++) {
    const recordOffset = 6 + i * 12;
    const platformId = nameTable.readUInt16BE(recordOffset);
    const encodingId = nameTable.readUInt16BE(recordOffset + 2);
    const languageId = nameTable.readUInt16BE(recordOffset + 4);
    const nameId = nameTable.readUInt16BE(recordOffset + 6);
    const length = nameTable.readUInt16BE(recordOffset + 8);
    const offset = nameTable.readUInt16BE(recordOffset + 10);
    if (nameId !== 1 && nameId !== 4 && nameId !== 16) continue;
    const stringBytes = nameTable.slice(stringOffset + offset, stringOffset + offset + length);
    // Windows/Unicode platforms use UTF-16BE; Macintosh roman is ASCII-ish.
    const isUtf16 = platformId === 0 || platformId === 3;
    const value = isUtf16 ? stringBytes.swap16().toString("utf16le") : stringBytes.toString("latin1");
    candidates.push({ platformId, encodingId, languageId, nameId, value });
  }
  const priorities = [
    (record) => record.nameId === 16 && record.platformId === 3 && record.languageId === 0x0409,
    (record) => record.nameId === 1 && record.platformId === 3 && record.languageId === 0x0409,
    (record) => record.nameId === 16,
    (record) => record.nameId === 1,
    (record) => record.nameId === 4,
  ];
  for (const predicate of priorities) {
    const match = candidates.find(predicate);
    if (match?.value) return match.value;
  }
  return null;
}

function getApiConfig() {
  const url = process.env.EVENT_STATS_API_URL;
  const key = process.env.EVENT_STATS_API_KEY;
  if (!url || !key) {
    throw new Error(
      "EVENT_STATS_API_URL and EVENT_STATS_API_KEY must be set in the environment."
    );
  }
  return { url, key };
}

const COLORS = {
  bg: "#0f1419",
  panel: "#1a212b",
  panelEdge: "#2a3340",
  text: "#e6e9ef",
  muted: "#8a93a4",
  accent: "#ff6b6b",
  accent2: "#4ecdc4",
  good: "#7bd389",
  bad: "#e57373",
  grid: "#2a3340",
  funnel: ["#ff6b6b", "#ffa94d", "#ffd166", "#7bd389"],
};

async function fetchEventStats(name) {
  const { url: apiUrl, key } = getApiConfig();
  const url = new URL("/api/integrations/event-stats", apiUrl);
  url.searchParams.set("name", name);
  const res = await fetch(url, { headers: { "x-api-key": key } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Event stats API ${res.status} for "${name}": ${body}`);
  }
  return res.json();
}

/**
 * Fetch sub-event stats and render a PNG dashboard. If the event has an
 * imageUrl, fetch it and composite it as a dim background behind the panels.
 *
 * Returns:
 *   { buffer: Buffer, filename: string, stats: object }
 */
async function generateStatsPng(eventName) {
  const stats = await fetchEventStats(eventName);
  const buffer = await renderStatsToPng(stats);
  const safeSlug = (stats.event.slug || "event").replace(/[^a-z0-9-]/gi, "-");
  return { buffer, filename: `${safeSlug}.png`, stats };
}

async function renderStatsToPng(stats) {
  const logoBuffer = await fetchLogoSafely(stats.event?.imageUrl);
  const hasLogo = Boolean(logoBuffer);
  const logoDataUri = hasLogo ? bufferToDataUri(logoBuffer) : null;
  const logoAspectRatio = hasLogo ? await getAspectRatio(logoBuffer) : 1;
  const svgMarkup = renderDashboard(stats, {
    transparentBg: hasLogo,
    logoDataUri,
    logoAspectRatio,
  });

  if (!hasLogo) {
    return rasterizeSvgWithResvg(svgMarkup);
  }

  const width = 1600 * PNG_SCALE;
  const height = 1000 * PNG_SCALE;

  // Logo is heavily dimmed and slightly blurred so it reads as a watermark
  // rather than competing with the panels in front of it.
  const dimmedLogo = await sharp(logoBuffer)
    .resize({
      width: Math.round(width * 0.7),
      height: Math.round(height * 0.7),
      fit: "inside",
    })
    .modulate({ brightness: 0.35 })
    .blur(2)
    .png()
    .toBuffer();

  const svgRaster = await rasterizeSvgWithResvg(svgMarkup);

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: COLORS.bg,
    },
  })
    .composite([
      { input: dimmedLogo, gravity: "center" },
      { input: svgRaster, top: 0, left: 0 },
    ])
    .png({ compressionLevel: 9 })
    .toBuffer();
}

/**
 * Rasterize an SVG string to a PNG buffer using resvg-js. We load the bundled
 * TTF directly via `font.fontFiles` so the renderer doesn't need fontconfig or
 * any system fonts on the host.
 */
async function rasterizeSvgWithResvg(svgMarkup) {
  const resvg = new Resvg(svgMarkup, {
    fitTo: { mode: "width", value: 1600 * PNG_SCALE },
    font: {
      fontFiles: [BUNDLED_FONT_PATH],
      loadSystemFonts: false,
      defaultFontFamily: BUNDLED_FONT_FAMILY,
    },
  });
  return resvg.render().asPng();
}

async function getAspectRatio(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (meta.width && meta.height) return meta.width / meta.height;
  } catch {
    // Fall through to square aspect ratio.
  }
  return 1;
}

function bufferToDataUri(buffer) {
  return `data:${sniffImageMime(buffer)};base64,${buffer.toString("base64")}`;
}

// Tiny magic-byte sniffer so the data URI carries the right MIME type for the
// most common formats event organizers will use.
function sniffImageMime(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 6 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return "image/gif";
  }
  if (buffer.length >= 12 && buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") {
    return "image/webp";
  }
  if (buffer.length >= 1 && buffer[0] === 0x3c) {
    return "image/svg+xml";
  }
  return "image/png";
}

const LOGO_FETCH_TIMEOUT_MS = 5000;

async function fetchLogoSafely(imageUrl) {
  if (!imageUrl || typeof imageUrl !== "string") return null;
  try {
    // AbortSignal.timeout caps the request so a slow logo host can't hold up
    // the entire standup post.
    const res = await fetch(imageUrl, { signal: AbortSignal.timeout(LOGO_FETCH_TIMEOUT_MS) });
    if (!res.ok) {
      console.warn(`[stats-image] logo fetch ${res.status} for ${imageUrl}; rendering without it`);
      return null;
    }
    const arrayBuffer = await res.arrayBuffer();
    return Buffer.from(arrayBuffer);
  } catch (error) {
    const reason = error.name === "TimeoutError"
      ? `timed out after ${LOGO_FETCH_TIMEOUT_MS}ms`
      : error.message;
    console.warn(`[stats-image] logo fetch failed for ${imageUrl}: ${reason}; rendering without it`);
    return null;
  }
}

function escapeXml(value) {
  return String(value).replace(/[<>&"']/g, (char) => {
    return { "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[char];
  });
}

// Pick the largest font size that lets `text` fit inside `maxWidth` at the
// given weight. SVG can shrink-fit with textLength, but we want the *font* to
// scale, not the glyph spacing — so we estimate width with an em-ratio per
// weight and binary-search-ish bound.
function fitFontSize(text, maxWidth, maxHeight, weight) {
  const widthRatio = weight >= 700 ? 0.62 : 0.55;
  const byWidth = maxWidth / (Math.max(1, String(text).length) * widthRatio);
  return Math.floor(Math.min(byWidth, maxHeight));
}

function estimateTextWidth(text, fontSize, weight) {
  const widthRatio = weight >= 700 ? 0.62 : 0.55;
  return String(text).length * fontSize * widthRatio;
}

function buildLinePath(points, box, asArea) {
  if (points.length === 0) return "";
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const stepX = points.length > 1 ? box.width / (points.length - 1) : 0;
  const coords = points.map((point, index) => {
    const x = box.x + stepX * index;
    const y = box.y + box.height - (point.value / maxValue) * box.height;
    return { x, y };
  });
  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"}${c.x.toFixed(1)},${c.y.toFixed(1)}`).join(" ");
  if (!asArea) return linePath;
  const first = coords[0];
  const last = coords[coords.length - 1];
  return `${linePath} L${last.x.toFixed(1)},${(box.y + box.height).toFixed(1)} L${first.x.toFixed(1)},${(box.y + box.height).toFixed(1)} Z`;
}

function renderTile(x, y, width, height, label, value, valueColor) {
  const padding = 16;
  const innerWidth = width - padding * 2;
  // Label takes a fixed slim band at the top; the value fills everything else
  // so single-digit counts read clearly from across the room.
  const labelSize = Math.min(fitFontSize(label, innerWidth, height * 0.2, 500), 26);
  const valueAreaHeight = height - padding * 2 - labelSize - 8;
  const valueSize = fitFontSize(value, innerWidth, valueAreaHeight, 700);
  const valueCenterY = y + padding + labelSize + 8 + valueAreaHeight / 2;
  return `
    <g>
      <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.panelEdge}"/>
      <text x="${x + padding}" y="${y + padding + labelSize * 0.85}" fill="${COLORS.muted}" font-size="${labelSize}" font-weight="500" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(label)}</text>
      <text x="${x + width / 2}" y="${valueCenterY + valueSize * 0.35}" text-anchor="middle" fill="${valueColor}" font-size="${valueSize}" font-weight="700" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(value)}</text>
    </g>`;
}

function renderTimelineChart(box, title, points, color, asArea) {
  const titleSize = Math.min(fitFontSize(title, box.width * 0.7, 32, 600), 30);
  const axisSize = 18;
  const innerTop = box.y + titleSize + 20;
  const innerBottom = box.y + box.height - axisSize - 12;
  const path = buildLinePath(points, { x: box.x, y: innerTop, width: box.width, height: innerBottom - innerTop }, asArea);
  const maxValue = Math.max(1, ...points.map((p) => p.value));
  const firstDate = points[0]?.date ?? "";
  const lastDate = points[points.length - 1]?.date ?? "";
  return `
    <g>
      <rect x="${box.x - 16}" y="${box.y - 16}" width="${box.width + 32}" height="${box.height + 32}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.panelEdge}"/>
      <text x="${box.x}" y="${box.y + titleSize}" fill="${COLORS.text}" font-size="${titleSize}" font-weight="600" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(title)}</text>
      <text x="${box.x + box.width}" y="${box.y + titleSize}" text-anchor="end" fill="${COLORS.muted}" font-size="${axisSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">max ${maxValue}</text>
      <path d="${path}" fill="${asArea ? color + "33" : "none"}" stroke="${color}" stroke-width="3"/>
      <text x="${box.x}" y="${box.y + box.height - 2}" fill="${COLORS.muted}" font-size="${axisSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(firstDate)}</text>
      <text x="${box.x + box.width}" y="${box.y + box.height - 2}" text-anchor="end" fill="${COLORS.muted}" font-size="${axisSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(lastDate)}</text>
    </g>`;
}

function renderDonut(centerX, centerY, radius, met, notMet) {
  const total = met + notMet || 1;
  const metFraction = met / total;
  const angle = metFraction * Math.PI * 2;
  const startX = centerX;
  const startY = centerY - radius;
  const endX = centerX + Math.sin(angle) * radius;
  const endY = centerY - Math.cos(angle) * radius;
  const largeArc = angle > Math.PI ? 1 : 0;
  const metPath = `M${centerX},${centerY} L${startX},${startY} A${radius},${radius} 0 ${largeArc} 1 ${endX.toFixed(2)},${endY.toFixed(2)} Z`;
  const percentLabel = `${Math.round(metFraction * 100)}%`;
  const percentSize = fitFontSize(percentLabel, radius * 1.0, radius * 0.55, 700);
  const captionSize = Math.floor(percentSize * 0.32);
  return `
    <g>
      <circle cx="${centerX}" cy="${centerY}" r="${radius}" fill="${COLORS.bad}"/>
      ${met > 0 ? `<path d="${metPath}" fill="${COLORS.good}"/>` : ""}
      <circle cx="${centerX}" cy="${centerY}" r="${radius * 0.6}" fill="${COLORS.panel}"/>
      <text x="${centerX}" y="${centerY + percentSize * 0.18}" text-anchor="middle" fill="${COLORS.text}" font-size="${percentSize}" font-weight="700" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${percentLabel}</text>
      <text x="${centerX}" y="${centerY + percentSize * 0.18 + captionSize + 6}" text-anchor="middle" fill="${COLORS.muted}" font-size="${captionSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">met goal</text>
    </g>`;
}

function renderDonutPanel(box, met, notMet) {
  const titleSize = 26;
  const innerTop = box.y + titleSize + 24;
  const radius = Math.min((box.height - titleSize - 80) / 2, box.width * 0.22);
  const donutCenterX = box.x + 20 + radius;
  const donutCenterY = innerTop + radius;
  const legendX = donutCenterX + radius + 28;
  const legendSize = Math.max(16, Math.floor(radius * 0.32));
  const swatch = legendSize;
  return `
    <g>
      <rect x="${box.x - 16}" y="${box.y - 16}" width="${box.width + 32}" height="${box.height + 32}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.panelEdge}"/>
      <text x="${box.x}" y="${box.y + titleSize}" fill="${COLORS.text}" font-size="${titleSize}" font-weight="600" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">Hour goal split</text>
      ${renderDonut(donutCenterX, donutCenterY, radius, met, notMet)}
      <rect x="${legendX}" y="${donutCenterY - swatch - 8}" width="${swatch}" height="${swatch}" fill="${COLORS.good}" rx="3"/>
      <text x="${legendX + swatch + 10}" y="${donutCenterY - 12}" fill="${COLORS.text}" font-size="${legendSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">Met (${met})</text>
      <rect x="${legendX}" y="${donutCenterY + 8}" width="${swatch}" height="${swatch}" fill="${COLORS.bad}" rx="3"/>
      <text x="${legendX + swatch + 10}" y="${donutCenterY + swatch + 4}" fill="${COLORS.text}" font-size="${legendSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">Not met (${notMet})</text>
    </g>`;
}

function renderFunnel(box, qualification) {
  const stages = [
    { label: "Signed up", value: qualification.signedUp },
    { label: "Engaged (≥1h)", value: qualification.engaged },
    { label: "RSVPed (≥15h)", value: qualification.rsvped },
    { label: "Qualified (≥30h)", value: qualification.qualified },
  ];
  const titleSize = 26;
  const maxValue = Math.max(1, ...stages.map((stage) => stage.value));
  const contentTop = box.y + titleSize + 20;
  const rowHeight = (box.height - (titleSize + 30)) / stages.length;
  // Label column gets the widest "Qualified (≥30h)" text; value column ~80px.
  const labelSize = Math.min(Math.floor(rowHeight * 0.55), 30);
  const valueSize = Math.min(Math.floor(rowHeight * 0.65), 38);
  const labelColumnWidth = labelSize * 11;
  const valueColumnWidth = valueSize * 2.5;
  const barLeft = box.x + labelColumnWidth + 16;
  const barMaxWidth = box.width - labelColumnWidth - valueColumnWidth - 32;
  const rows = stages.map((stage, index) => {
    const barWidth = Math.max(4, (stage.value / maxValue) * barMaxWidth);
    const rowY = contentTop + index * rowHeight;
    const centerY = rowY + rowHeight / 2;
    return `
      <text x="${box.x}" y="${centerY + labelSize * 0.35}" fill="${COLORS.muted}" font-size="${labelSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(stage.label)}</text>
      <rect x="${barLeft}" y="${rowY + rowHeight * 0.18}" width="${barWidth.toFixed(1)}" height="${rowHeight * 0.64}" rx="6" fill="${COLORS.funnel[index]}"/>
      <text x="${barLeft + barWidth + 14}" y="${centerY + valueSize * 0.35}" fill="${COLORS.text}" font-size="${valueSize}" font-weight="700" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${stage.value}</text>`;
  });
  return `
    <g>
      <rect x="${box.x - 16}" y="${box.y - 16}" width="${box.width + 32}" height="${box.height + 32}" rx="12" fill="${COLORS.panel}" stroke="${COLORS.panelEdge}"/>
      <text x="${box.x}" y="${box.y + titleSize}" fill="${COLORS.text}" font-size="${titleSize}" font-weight="600" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">Qualification funnel</text>
      ${rows.join("")}
    </g>`;
}

function renderDashboard(stats, {
  transparentBg = false,
  logoDataUri = null,
  logoAspectRatio = 1,
} = {}) {
  const width = 1600;
  const height = 1000;
  const event = stats.event;
  const headerSubtitle = [
    event.location,
    event.country,
    `${event.startDate?.slice(0, 10)} → ${event.endDate?.slice(0, 10)}`,
    `hour goal: ${event.hourCost}`,
  ]
    .filter(Boolean)
    .join("  •  ");

  const titleSize = fitFontSize(event.title, width * 0.7, 60, 700);
  const subtitleSize = 22;
  const generatedSize = 18;

  // Icon is placed to the right of the title text. Its height equals the title
  // font size (so it visually fills the title's vertical band) and the width is
  // derived from the source aspect ratio, never the other way around — wide
  // logos extend horizontally, never overflowing vertically.
  const iconHeight = logoDataUri ? titleSize : 0;
  const iconWidth = logoDataUri ? iconHeight * logoAspectRatio : 0;
  const iconGap = logoDataUri ? 16 : 0;
  const titleX = 40;
  const titleWidthEstimate = estimateTextWidth(event.title, titleSize, 700);
  const iconX = titleX + titleWidthEstimate + iconGap;
  const iconY = 10; // matches the title's top edge (title baseline is at titleSize + 10).

  const tileY = titleSize + subtitleSize + 50;
  const tileHeight = 170;
  const tileGap = 24;
  const tileWidth = (width - 80 - tileGap * 3) / 4;
  const tiles = [
    renderTile(40 + (tileWidth + tileGap) * 0, tileY, tileWidth, tileHeight, "Pinned users", stats.pinnedCount, COLORS.accent2),
    renderTile(40 + (tileWidth + tileGap) * 1, tileY, tileWidth, tileHeight, "DAU yesterday", stats.dauYesterday, COLORS.accent),
    renderTile(40 + (tileWidth + tileGap) * 2, tileY, tileWidth, tileHeight, "Met hour goal", stats.metHourGoal, COLORS.good),
    renderTile(40 + (tileWidth + tileGap) * 3, tileY, tileWidth, tileHeight, "Not met", stats.notMetHourGoal, COLORS.bad),
  ].join("");

  const chartTop = tileY + tileHeight + 50;
  const chartHeight = 290;
  const chartWidth = (width - 80 - 40) / 2;
  const pinnedChart = renderTimelineChart(
    { x: 56, y: chartTop, width: chartWidth - 32, height: chartHeight },
    "Cumulative pinned users (30d)",
    stats.pinnedTimeline,
    COLORS.accent2,
    true
  );
  const dauChart = renderTimelineChart(
    { x: 64 + chartWidth, y: chartTop, width: chartWidth - 32, height: chartHeight },
    "Daily active users (30d)",
    stats.dauTimeline,
    COLORS.accent,
    false
  );

  const bottomTop = chartTop + chartHeight + 60;
  const bottomHeight = height - bottomTop - 40;
  const donutWidth = 420;
  const donutPanel = renderDonutPanel(
    { x: 56, y: bottomTop, width: donutWidth, height: bottomHeight },
    stats.metHourGoal,
    stats.notMetHourGoal
  );
  const funnelBox = {
    x: 56 + donutWidth + 48,
    y: bottomTop,
    width: width - (56 + donutWidth + 48) - 56,
    height: bottomHeight,
  };
  const funnel = renderFunnel(funnelBox, stats.qualification);

  const bgRect = transparentBg
    ? ""
    : `<rect width="${width}" height="${height}" fill="${COLORS.bg}"/>`;
  const headerIcon = logoDataUri
    ? `<image href="${logoDataUri}" x="${iconX.toFixed(1)}" y="${iconY}" width="${iconWidth.toFixed(1)}" height="${iconHeight}" preserveAspectRatio="xMidYMid meet"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  ${bgRect}
  ${headerIcon}
  <text x="${titleX}" y="${titleSize + 10}" fill="${COLORS.text}" font-size="${titleSize}" font-weight="700" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(event.title)}</text>
  <text x="40" y="${titleSize + subtitleSize + 24}" fill="${COLORS.muted}" font-size="${subtitleSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">${escapeXml(headerSubtitle)}</text>
  <text x="${width - 40}" y="${titleSize + 10}" text-anchor="end" fill="${COLORS.muted}" font-size="${generatedSize}" font-family="${BUNDLED_FONT_FAMILY}, sans-serif">generated ${escapeXml(stats.generatedAt)}</text>
  ${tiles}
  ${pinnedChart}
  ${dauChart}
  ${donutPanel}
  ${funnel}
</svg>`;
}

async function runCli() {
  require("dotenv").config();
  const eventName = process.argv[2] ?? DEFAULT_EVENT_NAME;
  // Optional 2nd CLI arg overrides the event's imageUrl — useful for previewing
  // the logo backdrop before the API has a real logo set.
  const logoOverride = process.argv[3];

  const stats = await fetchEventStats(eventName);
  if (logoOverride) stats.event.imageUrl = logoOverride;

  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const safeSlug = (stats.event.slug || "event").replace(/[^a-z0-9-]/gi, "-");
  const hasLogo = Boolean(stats.event?.imageUrl);
  const svgMarkup = renderDashboard(stats, { transparentBg: hasLogo });
  const svgPath = path.join(OUTPUT_DIR, `${safeSlug}.svg`);
  const pngPath = path.join(OUTPUT_DIR, `${safeSlug}.png`);
  fs.writeFileSync(svgPath, svgMarkup);

  const pngBuffer = await renderStatsToPng(stats);
  fs.writeFileSync(pngPath, pngBuffer);

  console.log(`Wrote ${svgPath}`);
  console.log(`Wrote ${pngPath}`);
}

module.exports = { generateStatsPng, fetchEventStats, renderDashboard };

if (require.main === module) {
  runCli().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
