#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourcePaths = [
  "packages/yaade-shared/src/theme/shadcn-tokens.ts",
  "packages/yaade-ui/src/styles/globals.css",
  "packages/yaade-ui/src/styles/materials.css",
  "packages/yaade-ui/src/motion/tokens.ts",
];
const outputPath = path.join(repoRoot, "apps/desktop/design-contract.json");
const [tokensSource, globalsSource, materialsSource, motionSource] = await Promise.all(
  sourcePaths.map(source => readFile(path.join(repoRoot, source), "utf8")),
);

function objectBody(source, exportName) {
  const marker = `export const ${exportName}`;
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) throw new Error(`Could not find ${marker}`);
  const start = source.indexOf("{", markerIndex);
  let depth = 0;
  for (let index = start; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start + 1, index);
    }
  }
  throw new Error(`Could not parse ${exportName}`);
}

function parseStringProperties(source, exportName) {
  const body = objectBody(source, exportName);
  return Object.fromEntries(
    [...body.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*):\s*"([^"]+)"/gmu)].map(match => [
      match[1],
      match[2],
    ]),
  );
}

function toSrgbHex(value) {
  const match = value.trim().match(
    /^oklch\(\s*([+-]?[\d.]+)(%)?\s+([+-]?[\d.]+)\s+([+-]?[\d.]+)(?:\s*\/\s*([+-]?[\d.]+)(%)?)?\s*\)$/i,
  );
  if (!match) {
    const hex = value.trim().match(/^#[\da-f]{6}$/i);
    if (hex) return hex[0].toLowerCase();
    throw new Error(`Desktop color contract needs an opaque OKLCH or hex value, received ${value}`);
  }

  const lightness = Number(match[1]) / (match[2] ? 100 : 1);
  const chroma = Number(match[3]);
  const hue = (Number(match[4]) * Math.PI) / 180;
  const a = chroma * Math.cos(hue);
  const b = chroma * Math.sin(hue);
  const lPrime = lightness + 0.3963377774 * a + 0.2158037573 * b;
  const mPrime = lightness - 0.1055613458 * a - 0.0638541728 * b;
  const sPrime = lightness - 0.0894841775 * a - 1.291485548 * b;
  const l = lPrime ** 3;
  const m = mPrime ** 3;
  const s = sPrime ** 3;
  const linear = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
  const channels = linear.map(channel => {
    const encoded =
      channel <= 0.0031308
        ? 12.92 * channel
        : 1.055 * channel ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, encoded)) * 255);
  });
  return `#${channels.map(channel => channel.toString(16).padStart(2, "0")).join("")}`;
}

function semanticTheme(exportName) {
  return Object.fromEntries(
    Object.entries(parseStringProperties(tokensSource, exportName)).map(([name, value]) => [
      name,
      value.startsWith("oklch(") || value.startsWith("#") ? toSrgbHex(value) : value,
    ]),
  );
}

function cssVariable(name) {
  const source = `${globalsSource}\n${materialsSource}`;
  const match = source.match(new RegExp(`--${name}:\\s*([^;]+);`));
  if (!match) throw new Error(`Could not find CSS variable --${name}`);
  return match[1].trim();
}

const rootFontSizeMatch = globalsSource.match(/html\s*\{[^}]*font-size:\s*([\d.]+)px/s);
if (!rootFontSizeMatch) throw new Error("Could not find the root font size");
const rootFontSizePx = Number(rootFontSizeMatch[1]);

function pxValue(name) {
  const value = cssVariable(name);
  const match = value.match(/^([\d.]+)(rem|px)$/);
  if (!match) throw new Error(`--${name} is not a direct rem/px metric: ${value}`);
  return Number(match[1]) * (match[2] === "rem" ? rootFontSizePx : 1);
}

function durationMs(name) {
  const value = cssVariable(name);
  const match = value.match(/^([\d.]+)ms$/);
  if (!match) throw new Error(`--${name} is not a millisecond duration: ${value}`);
  return Number(match[1]);
}

const sourceHash = createHash("sha256")
  .update(sourcePaths.map((source, index) => `${source}\0${[tokensSource, globalsSource, materialsSource, motionSource][index]}`).join("\0"))
  .digest("hex");

const contract = {
  schemaVersion: 1,
  source: {
    files: sourcePaths,
    sha256: sourceHash,
  },
  fonts: {
    uiFamily: "Geist",
    monoFamily: "Geist Mono",
  },
  metrics: {
    rootFontSizePx,
    islandRadiusPx: pxValue("yaade-island-radius"),
    paneRadiusPx: pxValue("yaade-pane-radius"),
    controlRadiusPx: pxValue("yaade-control-radius"),
    menuRadiusPx: pxValue("yaade-material-menu-radius"),
    tabBarHeightPx: pxValue("yaade-tab-bar-height"),
    tabPillHeightPx: pxValue("yaade-tab-pill-height"),
    terminalWorkspacePaddingPx: 0.625 * rootFontSizePx,
    paneChromeHeightPx: 2 * rootFontSizePx,
  },
  motion: {
    hotMs: durationMs("yaade-motion-hot"),
    menuMs: durationMs("yaade-motion-menu"),
    overlayMs: durationMs("yaade-motion-overlay"),
    panelMs: durationMs("yaade-motion-panel"),
    easeOut: cssVariable("yaade-ease-out"),
    easeInOut: cssVariable("yaade-ease-in-out"),
    easeDrawer: cssVariable("yaade-ease-drawer"),
    pressScale: Number(cssVariable("yaade-press-scale")),
  },
  materials: {
    light: {
      shell: { color: "#ffffff", alpha: 0.42 },
      chrome: { color: "#ffffff", alpha: 0.52 },
      contentColorToken: "background",
      contentAlpha: 0.92,
      floating: { color: "#ffffff", alpha: 0.58 },
      lightEdge: { color: "#ffffff", alpha: 0.38 },
      darkEdgeColorToken: "foreground",
      darkEdgeAlpha: 0.08,
      specular: { color: "#ffffff", alpha: 0.55 },
    },
    dark: {
      shellColorToken: "card",
      shellAlpha: 0.72,
      chromeColorToken: "card",
      chromeAlpha: 0.8,
      contentColorToken: "background",
      contentAlpha: 0.92,
      floatingColorToken: "popover",
      floatingAlpha: 0.38,
      lightEdge: { color: "#ffffff", alpha: 0.12 },
      darkEdgeColorToken: "foreground",
      darkEdgeAlpha: 0.08,
      specular: { color: "#ffffff", alpha: 0.22 },
    },
  },
  themes: {
    light: { semantic: semanticTheme("shadcnDefaultLight") },
    dark: { semantic: semanticTheme("shadcnDefaultDark") },
  },
};

const output = `${JSON.stringify(contract, null, 2)}\n`;
if (process.argv.includes("--check")) {
  const current = await readFile(outputPath, "utf8").catch(() => "");
  if (current !== output) {
    console.error("apps/desktop/design-contract.json is stale. Run: node scripts/export-desktop-design-contract.mjs");
    process.exitCode = 1;
  }
} else {
  await writeFile(outputPath, output);
  console.log(path.relative(repoRoot, outputPath));
}
