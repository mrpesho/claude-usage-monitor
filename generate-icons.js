// Icon generator for Claude Usage Monitor
// Run: node generate-icons.js

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// Create icon with circular design and progress arc on left side
function createIcon(size) {
  const pixels = new Uint8Array(size * size * 4);
  const center = size / 2;
  const radius = size / 2 - 1;

  // Colors
  const teal = { r: 8, g: 145, b: 178 };          // #0891B2 - main circle
  const trackColor = { r: 6, g: 115, b: 142 };   // Darker teal for empty track
  const fillColor = { r: 255, g: 255, b: 255 };  // White for filled portion

  // Arc parameters (left-side semi-circle progress bar)
  const arcRadius = radius * 0.62;
  const arcThickness = size * 0.15;
  const capRadius = arcThickness / 2;

  // Progress amount (0 to 1) - show ~65% filled for the icon
  const progress = 0.65;

  // Calculate cap positions (centers of rounded ends)
  // Start cap: bottom of arc (angle = PI/2)
  const startCapX = center + Math.cos(Math.PI / 2) * arcRadius;
  const startCapY = center + Math.sin(Math.PI / 2) * arcRadius;

  // Progress cap: where filled meets unfilled
  const progressAngle = Math.PI / 2 + progress * Math.PI;
  const progressCapX = center + Math.cos(progressAngle) * arcRadius;
  const progressCapY = center + Math.sin(progressAngle) * arcRadius;


  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const dx = x - center;
      const dy = y - center;
      const dist = Math.sqrt(dx * dx + dy * dy);

      // Default: transparent
      pixels[idx] = 0;
      pixels[idx + 1] = 0;
      pixels[idx + 2] = 0;
      pixels[idx + 3] = 0;

      // Main circle
      if (dist <= radius) {
        // Anti-aliasing at edge
        const edgeDist = radius - dist;
        const alpha = Math.min(1, edgeDist * 2) * 255;

        pixels[idx] = teal.r;
        pixels[idx + 1] = teal.g;
        pixels[idx + 2] = teal.b;
        pixels[idx + 3] = Math.round(alpha);

        // Check for rounded caps first
        const distToStartCap = Math.sqrt((x - startCapX) ** 2 + (y - startCapY) ** 2);
        const distToProgressCap = Math.sqrt((x - progressCapX) ** 2 + (y - progressCapY) ** 2);

        // Start cap (filled, solid white)
        if (distToStartCap <= capRadius) {
          const capAlpha = Math.min(1, (capRadius - distToStartCap) * 2.5);
          const blend = capAlpha * 0.95;
          pixels[idx] = Math.round(teal.r * (1 - blend) + fillColor.r * blend);
          pixels[idx + 1] = Math.round(teal.g * (1 - blend) + fillColor.g * blend);
          pixels[idx + 2] = Math.round(teal.b * (1 - blend) + fillColor.b * blend);
          continue;
        }

        // Progress cap (filled, solid white)
        if (distToProgressCap <= capRadius) {
          const capAlpha = Math.min(1, (capRadius - distToProgressCap) * 2.5);
          const blend = capAlpha * 0.95;
          pixels[idx] = Math.round(teal.r * (1 - blend) + fillColor.r * blend);
          pixels[idx + 1] = Math.round(teal.g * (1 - blend) + fillColor.g * blend);
          pixels[idx + 2] = Math.round(teal.b * (1 - blend) + fillColor.b * blend);
          continue;
        }


        // Draw progress arc on the LEFT side
        const angle = Math.atan2(dy, dx);
        const isLeftHalf = dx < 0;

        const distFromArcCenter = Math.abs(dist - arcRadius);
        const isOnArc = distFromArcCenter <= arcThickness / 2;

        if (isOnArc && isLeftHalf) {
          let normalizedProgress;
          if (angle >= 0) {
            normalizedProgress = (angle - Math.PI / 2) / Math.PI;
          } else {
            normalizedProgress = (angle + Math.PI * 1.5) / Math.PI;
          }

          const isFilled = normalizedProgress <= progress;

          if (isFilled) {
            const arcEdgeDist = arcThickness / 2 - distFromArcCenter;
            const arcAlpha = Math.min(1, arcEdgeDist * 2.5);
            const blend = arcAlpha * 0.95;

            pixels[idx] = Math.round(teal.r * (1 - blend) + fillColor.r * blend);
            pixels[idx + 1] = Math.round(teal.g * (1 - blend) + fillColor.g * blend);
            pixels[idx + 2] = Math.round(teal.b * (1 - blend) + fillColor.b * blend);
          }
          // Unfilled portion: no track, just empty
        }
      }
    }
  }

  return createPNG(size, size, pixels);
}

// PNG encoder
function createPNG(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type (RGBA)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const ihdrChunk = createChunk('IHDR', ihdr);

  // IDAT chunk (image data)
  const rawData = [];
  for (let y = 0; y < height; y++) {
    rawData.push(0); // filter byte for each row
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      rawData.push(pixels[idx], pixels[idx + 1], pixels[idx + 2], pixels[idx + 3]);
    }
  }

  const compressed = zlib.deflateSync(Buffer.from(rawData));
  const idatChunk = createChunk('IDAT', compressed);

  // IEND chunk
  const iendChunk = createChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function createChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);

  const typeBuffer = Buffer.from(type);
  const crcData = Buffer.concat([typeBuffer, data]);
  const crc = crc32(crcData);

  const crcBuffer = Buffer.alloc(4);
  crcBuffer.writeUInt32BE(crc >>> 0, 0);

  return Buffer.concat([length, typeBuffer, data, crcBuffer]);
}

// CRC32 implementation
function crc32(data) {
  let crc = 0xffffffff;
  const table = getCRCTable();

  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }

  return crc ^ 0xffffffff;
}

let crcTable = null;
function getCRCTable() {
  if (crcTable) return crcTable;

  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      if (c & 1) {
        c = 0xedb88320 ^ (c >>> 1);
      } else {
        c = c >>> 1;
      }
    }
    crcTable[n] = c;
  }
  return crcTable;
}

// Generate icons
const sizes = [16, 48, 128];
const iconDir = path.join(__dirname, 'icons');

for (const size of sizes) {
  const png = createIcon(size);
  const filename = path.join(iconDir, `icon${size}.png`);
  fs.writeFileSync(filename, png);
  console.log(`Created ${filename}`);
}

console.log('Icons generated successfully!');
