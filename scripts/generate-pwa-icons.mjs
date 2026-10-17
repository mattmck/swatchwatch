#!/usr/bin/env node
// Generates the PWA / home-screen PNG icons in apps/web/public from the brand
// app icon (apps/web/public/brand/swatchwatch-app-icon.svg).
//
// Uses `sharp`, which is already a dependency of packages/functions (hoisted
// into the root node_modules), so the web app gains no new dependency.
//
//   npm run generate:pwa-icons
//
// Outputs (committed):
//   icon-192.png, icon-512.png   purpose "any"      rounded-square app icon from the SVG
//   icon-maskable-512.png        purpose "maskable" full-bleed background, glyph inside the safe zone
//   apple-touch-icon.png (180)   opaque full-bleed (iOS applies its own mask; transparent corners render black)

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = join(root, "apps/web/public");
const sourceSvg = join(publicDir, "brand/swatchwatch-app-icon.svg");

const BACKGROUND = "#42107e";

// Same droplet glyph as the source SVG, on a full-bleed square. Everything sits
// within ~92/256 of the centre (radius 36% of the icon), inside the 40% maskable
// safe zone, so launcher masks (circle, squircle, ...) never clip it.
// `scale` > 1 enlarges the glyph about the icon centre.
const fullBleedSvg = (scale) => `<svg width="256" height="256" viewBox="0 0 256 256" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" fill="${BACKGROUND}"/>
  <g transform="translate(128 128) scale(${scale}) translate(-128 -128)">
    <circle cx="128" cy="148" r="64" fill="#7b2eff" fill-opacity="0.2"/>
    <path d="M128 44C128 44 80 108 80 148a48 48 0 0096 0c0-40-48-104-48-104z" fill="#ff4fb8"/>
    <circle cx="106" cy="140" r="10" fill="#ffffff" fill-opacity="0.35"/>
  </g>
</svg>`;

const render = async (svg, size, file) => {
  // High density so the 256px vector is rasterised sharply, not upscaled.
  await sharp(Buffer.from(svg), { density: (72 * size) / 256 * 2 })
    .resize(size, size)
    .png({ compressionLevel: 9 })
    .toFile(join(publicDir, file));
  console.log(`wrote apps/web/public/${file} (${size}x${size})`);
};

const source = await readFile(sourceSvg, "utf8");

await render(source, 192, "icon-192.png");
await render(source, 512, "icon-512.png");
await render(fullBleedSvg(1.1), 512, "icon-maskable-512.png");
await render(fullBleedSvg(1.1), 180, "apple-touch-icon.png");
