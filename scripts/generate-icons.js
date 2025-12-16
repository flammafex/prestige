#!/usr/bin/env node

/**
 * PWA Icon Generator for Prestige
 *
 * Generates PNG icons from the SVG source using sharp.
 *
 * Usage:
 *   npm install sharp --save-dev
 *   node scripts/generate-icons.js
 */

import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PUBLIC_DIR = join(__dirname, '../src/web/public');
const SVG_PATH = join(PUBLIC_DIR, 'icon.svg');

// Icon sizes needed for PWA
const SIZES = [16, 32, 72, 96, 128, 144, 152, 167, 180, 192, 384, 512];

async function generateIcons() {
  let sharp;

  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    console.error('Error: sharp is not installed.');
    console.log('');
    console.log('To install sharp, run:');
    console.log('  npm install sharp --save-dev');
    console.log('');
    console.log('Then run this script again:');
    console.log('  node scripts/generate-icons.js');
    console.log('');
    console.log('Alternatively, convert icon.svg manually using:');
    console.log('  - https://cloudconvert.com/svg-to-png');
    console.log('  - https://www.iloveimg.com/resize-image/resize-svg');
    process.exit(1);
  }

  if (!existsSync(SVG_PATH)) {
    console.error('SVG file not found:', SVG_PATH);
    process.exit(1);
  }

  const svgBuffer = readFileSync(SVG_PATH);

  console.log('Generating PWA icons from icon.svg...');
  console.log('');

  for (const size of SIZES) {
    const outputPath = join(PUBLIC_DIR, `icon-${size}.png`);

    await sharp(svgBuffer)
      .resize(size, size)
      .png()
      .toFile(outputPath);

    console.log(`  Created: icon-${size}.png (${size}x${size})`);
  }

  console.log('');
  console.log('Done! All PWA icons generated successfully.');
  console.log('');
  console.log('Icons are ready in src/web/public/');
}

generateIcons().catch((err) => {
  console.error('Error generating icons:', err.message);
  process.exit(1);
});
