import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { describe, expect, it } from "vitest";

function decodePng(png: Buffer) {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect(png[24]).toBe(8);
  expect(png[25]).toBe(2);
  const chunks: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    if (png.toString("ascii", offset + 4, offset + 8) === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
  }
  const filtered = inflateSync(Buffer.concat(chunks));
  const stride = width * 3;
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x++) {
      const index = y * stride + x;
      const left = x >= 3 ? pixels[index - 3] : 0;
      const above = y > 0 ? pixels[index - stride] : 0;
      const upperLeft = y > 0 && x >= 3 ? pixels[index - stride - 3] : 0;
      const estimate = left + above - upperLeft;
      const distances = [Math.abs(estimate - left), Math.abs(estimate - above), Math.abs(estimate - upperLeft)];
      const paeth = distances[0] <= distances[1] && distances[0] <= distances[2] ? left
        : distances[1] <= distances[2] ? above : upperLeft;
      const prediction = [0, left, above, Math.floor((left + above) / 2), paeth][filter];
      pixels[index] = filtered[y * (stride + 1) + x + 1] + prediction;
    }
  }
  return { width, height, hash: createHash("sha256").update(pixels).digest("hex") };
}

const smallHash = "fa0122b21bad7d697e1daf435bac048e6d13f9f56f331cb8beea395218dd88a5";
const largeHash = "a8f9ab9acdfbdadfdd1d7a4035f73f000e955d063282c975803b4ced48efadc3";

describe("compressed PWA icons", () => {
  it.each([
    ["apple-touch-icon.png", 180, 15000, "132f710c1ed3e62d69bbad308e4ecea1bd0aea0fbf18b8c20ff164121aa26851"],
    ["icon-192.png", 192, 16500, smallHash],
    ["icon-maskable-192.png", 192, 16500, smallHash],
    ["icon-512.png", 512, 57000, largeHash],
    ["icon-maskable-512.png", 512, 57000, largeHash],
  ] as const)("preserves every pixel of %s within its byte budget", (file, size, maxBytes, hash) => {
    const png = readFileSync(`public/${file}`);
    expect(decodePng(png)).toEqual({ width: size, height: size, hash });
    expect(png.length).toBeLessThan(maxBytes);
  });
});
