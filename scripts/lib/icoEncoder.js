// A Windows .ico file, written from PNG frames with nothing but Node.
//
// Windows wants an .ico for a shortcut's icon, and this repository only ships
// a .icns (macOS) and the PNG frames that made it. Converting needs no image
// library at all: since Windows Vista an .ico entry may hold a PNG verbatim,
// so the whole job is a 6-byte header, one 16-byte directory entry per frame
// and then the PNG bytes, unchanged.
//
// Layout (all little-endian):
//   header    reserved:2 = 0, type:2 = 1 (icon), count:2
//   entry     width:1, height:1, colours:1, reserved:1, planes:2, bitCount:2,
//             byteLength:4, offset:4
//   data      the frames, in the order of their entries
// A side of 256 is written as 0, because the field is one byte and 256 does
// not fit; that is the format's own convention, not a trick.
import fs from "node:fs";
import path from "node:path";

export const ICO_MAX_SIDE = 256;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const HEADER_BYTES = 6;
const ENTRY_BYTES = 16;

// Width, height and colour depth out of a PNG's first chunk (IHDR), which is
// always the one right after the signature.
export function readPngHeader(bytes) {
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error("Not a PNG file (the 8-byte signature is missing).");
  }
  if (buffer.subarray(12, 16).toString("ascii") !== "IHDR") {
    throw new Error("Not a PNG file (no IHDR chunk where one has to be).");
  }
  const bitDepth = buffer.readUInt8(24);
  const colorType = buffer.readUInt8(25);
  // 6 = truecolour with alpha, 2 = truecolour, 4 = grey with alpha, 3 = palette.
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType] || 4;
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth,
    colorType,
    bitsPerPixel: bitDepth * channels
  };
}

// The byte a directory entry uses for a side: 0 stands for 256.
export function sideByte(side) {
  return side >= ICO_MAX_SIDE ? 0 : side;
}

// `frames` is a list of PNG buffers. They are sorted smallest first and
// written as they are; anything bigger than 256 px is refused, because the
// directory entry could not describe it.
export function encodeIco(frames) {
  const described = frames.map((bytes) => {
    const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
    const header = readPngHeader(buffer);
    if (header.width > ICO_MAX_SIDE || header.height > ICO_MAX_SIDE) {
      throw new Error(`An icon frame may be at most ${ICO_MAX_SIDE} px; this one is ${header.width}x${header.height}.`);
    }
    return { buffer, header };
  });
  if (described.length === 0) {
    throw new Error("An .ico needs at least one frame.");
  }
  described.sort((first, second) => first.header.width - second.header.width);

  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(described.length, 4);

  const directory = Buffer.alloc(ENTRY_BYTES * described.length);
  let offset = HEADER_BYTES + directory.length;
  described.forEach((frame, position) => {
    const base = position * ENTRY_BYTES;
    directory.writeUInt8(sideByte(frame.header.width), base);
    directory.writeUInt8(sideByte(frame.header.height), base + 1);
    directory.writeUInt8(0, base + 2);
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4);
    directory.writeUInt16LE(frame.header.bitsPerPixel, base + 6);
    directory.writeUInt32LE(frame.buffer.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    offset += frame.buffer.length;
  });

  return Buffer.concat([header, directory].concat(described.map((frame) => frame.buffer)));
}

// The PNG frames of the macOS iconset that an .ico may carry: one per side,
// 256 px and below, smallest first. A side that appears twice (icon_128x128@2x
// and icon_256x256 are both 256 px) is only taken once.
export function iconFramePaths(iconsetFolder) {
  let fileNames = [];
  try {
    fileNames = fs.readdirSync(iconsetFolder).filter((fileName) => fileName.toLowerCase().endsWith(".png"));
  } catch (error) {
    return [];
  }
  const bySide = new Map();
  for (const fileName of fileNames.sort()) {
    const filePath = path.join(iconsetFolder, fileName);
    let header = null;
    try {
      header = readPngHeader(fs.readFileSync(filePath));
    } catch (error) {
      continue;
    }
    if (header.width > ICO_MAX_SIDE || header.width !== header.height) {
      continue;
    }
    if (!bySide.has(header.width)) {
      bySide.set(header.width, filePath);
    }
  }
  return Array.from(bySide.keys())
    .sort((first, second) => first - second)
    .map((side) => bySide.get(side));
}

// Writes <targetPath> from the PNG frames of <iconsetFolder>. Returns what
// went in, so the installer can say it out loud.
export function writeIcoFromIconset({ iconsetFolder, targetPath }) {
  const framePaths = iconFramePaths(iconsetFolder);
  if (framePaths.length === 0) {
    throw new Error(`No usable PNG frames in ${iconsetFolder}`);
  }
  const bytes = encodeIco(framePaths.map((filePath) => fs.readFileSync(filePath)));
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, bytes);
  return { targetPath, framePaths, byteLength: bytes.length };
}
