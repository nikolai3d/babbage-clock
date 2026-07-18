#!/usr/bin/env node
/**
 * Generates the sample material folders under `public/assets/materials/`.
 *
 * These stand in for an Adobe Substance 3D Sampler export, which cannot be
 * produced in this environment. They are **synthetic but format-accurate**:
 * the same file naming, the same channel packing (occlusion/roughness/metallic
 * in R/G/B), the same colour spaces (base colour and emissive sRGB, everything
 * else linear data) and the same OpenGL Y+ normal convention that Sampler's
 * "PBR Metallic Roughness (glTF)" export template writes. Swapping in a real
 * Sampler folder is a file copy — see `docs/materials.md`.
 *
 * Committed output is small on purpose (256 px, structured rather than noisy,
 * so it deflates well). Real materials go up to the 2K cap.
 *
 *   node scripts/generate-material-textures.mjs
 */

import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'public', 'assets', 'materials');
const SIZE = 256;

// ---------------------------------------------------------------------------
// A minimal PNG encoder. Writing one is cheaper than taking an image
// dependency for four sample textures, and it keeps the repository's install
// footprint where it is.
// ---------------------------------------------------------------------------

function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

/** 8-bit RGB PNG. `pixels` is a Uint8Array of size*size*3. */
function encodePng(size, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // colour type: truecolour
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlace

  // Sub filtering: these maps are smooth left-to-right, so predicting each
  // byte from its neighbour is what makes the committed files small.
  const stride = size * 3;
  const raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 1;
    for (let x = 0; x < stride; x += 1) {
      const value = pixels[y * stride + x];
      const left = x >= 3 ? pixels[y * stride + x - 3] : 0;
      raw[rowStart + 1 + x] = (value - left) & 0xff;
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function writePng(path, generate) {
  const pixels = new Uint8Array(SIZE * SIZE * 3);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const [r, g, b] = generate(x / SIZE, y / SIZE, x, y);
      const i = (y * SIZE + x) * 3;
      pixels[i] = clamp255(r);
      pixels[i + 1] = clamp255(g);
      pixels[i + 2] = clamp255(b);
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  const png = encodePng(SIZE, pixels);
  writeFileSync(path, png);
  return png.length;
}

const clamp255 = (value) => Math.max(0, Math.min(255, Math.round(value)));
const TAU = Math.PI * 2;

// ---------------------------------------------------------------------------
// Height fields. Every map of a material derives from one of these, which is
// how a real bake works: the normal, the occlusion and the roughness all
// describe the same surface, so they agree with each other under light.
// ---------------------------------------------------------------------------

/**
 * Hammered/planished metal: overlapping shallow dishes, tileable.
 *
 * Deliberately low frequency. A stand-in texture with fine detail packed into
 * it reads as woven cloth once it is tiled across a five-metre case, which is
 * a good demonstration of nothing.
 */
function hammered(u, v) {
  return (
    0.5 +
    0.3 * Math.sin(TAU * 2 * u) * Math.sin(TAU * 2 * v) +
    0.12 * Math.sin(TAU * 3 * (u + 0.13)) * Math.cos(TAU * 2 * (v - 0.21))
  );
}

/** Brushed metal: fine grain running along u, with a slow waviness across it. */
function brushed(u, v) {
  let grain = 0;
  for (let i = 1; i <= 5; i += 1) {
    grain += (Math.sin(TAU * (i * 11) * v + i * 1.7) / i) * 0.1;
  }
  return 0.5 + grain + 0.05 * Math.sin(TAU * 2 * u) * Math.cos(TAU * 3 * v);
}

/**
 * Central differences of a height field, encoded the OpenGL way.
 *
 * OpenGL (Y+) means green increases as the surface tilts *up* in UV space.
 * DirectX exports invert that channel; the loader flips them back from the
 * manifest rather than asking anyone to re-bake.
 */
function normalFromHeight(height, strength) {
  const step = 1 / SIZE;
  return (u, v) => {
    const dx = (height(u + step, v) - height(u - step, v)) * strength;
    const dy = (height(u, v + step) - height(u, v - step)) * strength;
    const length = Math.hypot(-dx, -dy, 1);
    return [
      ((-dx / length) * 0.5 + 0.5) * 255,
      ((-dy / length) * 0.5 + 0.5) * 255,
      ((1 / length) * 0.5 + 0.5) * 255,
    ];
  };
}

const tint = (hex, scale) => [
  ((hex >> 16) & 0xff) * scale,
  ((hex >> 8) & 0xff) * scale,
  (hex & 0xff) * scale,
];

// ---------------------------------------------------------------------------
// The materials.
// ---------------------------------------------------------------------------

const materials = {
  /** Hammered copper. ORM-packed, the shape of a default Sampler glTF export. */
  'copper-plate': {
    manifest: {
      name: 'Hammered copper plate',
      description:
        'Synthetic stand-in for a Substance 3D Sampler glTF metallic-roughness export. ORM-packed.',
      maps: {
        baseColor: 'basecolor.png',
        normal: 'normal.png',
        orm: 'orm.png',
      },
      normal: { convention: 'opengl', scale: 1 },
      // One repeat every ~1.7 m of surface: the dishes come out a hand's width
      // across on the case, which is what planished copper looks like.
      tiling: [0.6, 0.6],
      scalars: {
        baseColor: '#b87333',
        metalness: 1,
        roughness: 0.38,
        aoIntensity: 1,
      },
      physical: { clearcoat: 0.08, clearcoatRoughness: 0.5 },
    },
    files: {
      'basecolor.png': (u, v) => {
        const h = hammered(u, v);
        const patina = 0.5 + 0.5 * Math.sin(TAU * 2 * (u + v));
        const base = tint(0xb87333, 0.78 + 0.34 * h);
        return [base[0], base[1] * (1 - 0.06 * patina), base[2] * (1 - 0.1 * patina)];
      },
      'normal.png': normalFromHeight(hammered, 7),
      'orm.png': (u, v) => {
        const h = hammered(u, v);
        // R: occlusion — dishes hold shadow. G: roughness — struck faces are
        // duller than the flats. B: metallic — copper is metal everywhere.
        //
        // Kept well off zero: a fully metallic surface at low roughness is a
        // mirror, and a mirror under a bright IBL mood is a white blob rather
        // than copper. Planished copper is satin, not chrome.
        return [(0.72 + 0.28 * h) * 255, (0.52 + 0.3 * (1 - h)) * 255, 252];
      },
    },
  },

  /**
   * Brushed blued steel. Deliberately exported as *separate* roughness,
   * metallic and occlusion maps, so both export shapes are exercised end to
   * end rather than only the packed one.
   */
  'blued-steel': {
    manifest: {
      name: 'Brushed blued steel',
      description:
        'Synthetic stand-in for a Sampler export using separate roughness/metallic/occlusion maps.',
      maps: {
        baseColor: 'basecolor.png',
        normal: 'normal.png',
        roughness: 'roughness.png',
        metallic: 'metallic.png',
        ambientOcclusion: 'ao.png',
      },
      normal: { convention: 'opengl', scale: 0.7 },
      tiling: [0.8, 0.8],
      scalars: { baseColor: '#3d4756', metalness: 1, roughness: 0.3 },
      physical: { anisotropy: 0.45, anisotropyRotation: 1.5708 },
    },
    files: {
      'basecolor.png': (u, v) => {
        const h = brushed(u, v);
        const heat = 0.5 + 0.5 * Math.sin(TAU * (u * 0.5 + 0.25));
        return [
          (0.2 + 0.16 * h) * 255,
          (0.24 + 0.15 * h) * 255,
          (0.34 + 0.16 * h + 0.06 * heat) * 255,
        ];
      },
      'normal.png': normalFromHeight(brushed, 12),
      'roughness.png': (u, v) => {
        const value = (0.34 + 0.3 * (1 - brushed(u, v))) * 255;
        return [value, value, value];
      },
      'metallic.png': (u, v) => {
        // Not a flat white: a couple of scuffed patches read as bare steel
        // that has lost its blueing, which is what makes the map worth having.
        const scuff = Math.max(0, Math.sin(TAU * 1.5 * u) * Math.cos(TAU * 1.5 * v));
        const value = (1 - 0.18 * scuff) * 255;
        return [value, value, value];
      },
      'ao.png': (u, v) => {
        const value = (0.82 + 0.18 * brushed(u, v)) * 255;
        return [value, value, value];
      },
    },
  },

  /**
   * A material with no textures at all.
   *
   * Every map is optional, and a folder that only states scalars is a valid,
   * complete material. This one proves that path renders without a warning and
   * without a single request.
   */
  'dark-enamel': {
    manifest: {
      name: 'Dark enamel',
      description: 'Scalars only — no maps. Proves the manifest-fallback path.',
      maps: {},
      tiling: [1, 1],
      scalars: { baseColor: '#241a12', metalness: 0.08, roughness: 0.62 },
      physical: { clearcoat: 0.35, clearcoatRoughness: 0.25 },
    },
    files: {},
  },

  /**
   * The UV diagnostic.
   *
   * An 8x8 checker with a red first column and a green first row, so a flip, a
   * rotation or a stretched parameterisation is readable at a glance rather
   * than inferred. This is what the bent numeral UVs were verified against.
   */
  'uv-grid': {
    manifest: {
      name: 'UV grid',
      description: 'Diagnostic checker for inspecting UV layout and texel density.',
      maps: { baseColor: 'basecolor.png' },
      // Eight cells per 2 m, so a cell is 25 cm of surface and a stretched or
      // rotated parameterisation is measurable by eye against the geometry.
      tiling: [0.5, 0.5],
      scalars: { baseColor: '#ffffff', metalness: 0, roughness: 0.55 },
    },
    files: {
      'basecolor.png': (u, v) => {
        const cells = 8;
        const cx = Math.floor(u * cells);
        const cy = Math.floor(v * cells);
        const fx = u * cells - cx;
        const fy = v * cells - cy;
        const line = 0.045;
        // Cell borders, so a squashed cell is measurable, not just visible.
        if (fx < line || fy < line || fx > 1 - line || fy > 1 - line) return [20, 20, 24];
        if (cx === 0 && cy === 0) return [255, 235, 60];
        if (cy === 0) return [220, 60, 50];
        if (cx === 0) return [60, 190, 90];
        return (cx + cy) % 2 === 0 ? [232, 232, 236] : [96, 100, 112];
      },
    },
  },
};

let total = 0;
for (const [id, spec] of Object.entries(materials)) {
  const folder = join(OUT, id);
  mkdirSync(folder, { recursive: true });

  for (const [file, generate] of Object.entries(spec.files)) {
    const bytes = writePng(join(folder, file), generate);
    total += bytes;
    console.log(`  ${id}/${file}  ${(bytes / 1024).toFixed(1)} kB`);
  }

  writeFileSync(join(folder, 'material.json'), `${JSON.stringify(spec.manifest, null, 2)}\n`);
}

console.log(`\n${Object.keys(materials).length} materials, ${(total / 1024).toFixed(1)} kB of PNG`);
