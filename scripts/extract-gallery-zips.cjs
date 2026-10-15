'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

const root = process.cwd();
const resourcesDir = path.join(root, 'public', 'resources');
const galleryRoot = path.join(root, 'public', 'gallery');
const years = [2023, 2024, 2025];
const imagePattern = /\.(jpe?g|jfif|png|webp)$/i;
const manifest = [];

function findEndOfCentralDirectory(buffer) {
  const minimum = Math.max(0, buffer.length - 65557);
  for (let offset = buffer.length - 22; offset >= minimum; offset--) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error('ZIP end record was not found.');
}

async function extractArchive(year) {
  const sharp = require('sharp');
  const archivePath = path.join(resourcesDir, 'mdgift-' + year + '-photos.zip');
  if (!fs.existsSync(archivePath)) {
    throw new Error('Required photo archive is missing: ' + archivePath);
  }

  const archive = fs.readFileSync(archivePath);
  const digest = crypto.createHash('sha256').update(archive).digest('hex').slice(0, 12);
  const endRecord = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(endRecord + 10);
  let cursor = archive.readUInt32LE(endRecord + 16);
  const entries = [];

  for (let index = 0; index < entryCount; index++) {
    if (cursor + 46 > archive.length || archive.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('Invalid ZIP directory in ' + year + '.zip.');
    }
    const method = archive.readUInt16LE(cursor + 10);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.toString('utf8', cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;

    if (imagePattern.test(name) && !name.endsWith('/')) {
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset });
    }
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  const outputDirName = year + '-' + digest;
  const outputDir = path.join(galleryRoot, outputDirName);
  fs.mkdirSync(outputDir, { recursive: true });
  let imageIndex = 0;

  for (const entry of entries) {
    if (imageIndex >= 12) break;
    if (entry.method !== 0 && entry.method !== 8) continue;
    const local = entry.localOffset;
    if (local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) {
      throw new Error('Invalid image entry in ' + year + '.zip: ' + entry.name);
    }
    const localNameLength = archive.readUInt16LE(local + 26);
    const localExtraLength = archive.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (dataEnd > archive.length) {
      throw new Error('Truncated image entry in ' + year + '.zip: ' + entry.name);
    }
    const compressed = archive.subarray(dataStart, dataEnd);
    const image = entry.method === 0 ? compressed : zlib.inflateRawSync(compressed);
    if (image.length !== entry.uncompressedSize) {
      throw new Error('Image size mismatch in ' + year + '.zip: ' + entry.name);
    }

    const optimized = await sharp(image)
      .rotate()
      .resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 78, effort: 4 })
      .toBuffer();
    const outputName = String(imageIndex + 1).padStart(2, '0') + '.webp';
    fs.writeFileSync(path.join(outputDir, outputName), optimized);
    manifest.push({
      year,
      index: imageIndex,
      src: './gallery/' + outputDirName + '/' + outputName
    });
    imageIndex++;
  }

  if (imageIndex === 0) {
    throw new Error('No supported photos were found in ' + year + '.zip.');
  }
  console.log('Optimized ' + imageIndex + ' photos for ' + year + '.');
}

async function main() {
  fs.rmSync(galleryRoot, { recursive: true, force: true });
  fs.mkdirSync(galleryRoot, { recursive: true });
  for (const year of years) {
    try {
      await extractArchive(year);
    } catch (error) {
      console.warn('Skipping unavailable ' + year + ' photo archive:', error.message);
    }
  }
  fs.writeFileSync(
    path.join(root, 'public', 'gallery-assets.js'),
    'window.MDGIFT_GALLERY_ASSETS = ' + JSON.stringify(manifest) + ';\n',
    'utf8'
  );
}

main().catch(error => {
  console.error('Gallery photo preparation failed:', error);
  process.exitCode = 1;
});

