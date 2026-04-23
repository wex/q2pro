import { BspFile, SURF_NODRAW, SURF_SKIP, SURF_HINT } from './bsp';

/**
 * texture-export — list distinct, renderable textures referenced by a BSP
 * as `textures/<name>.wal` paths (one per line on stdout).
 *
 * Usage:  npx tsx src/texture-export.ts <file.bsp>
 */

const SKIP_MASK = SURF_NODRAW | SURF_SKIP | SURF_HINT;

function extractTextures(bsp: BspFile): string[] {
  const names = new Set<string>();
  for (const ti of bsp.texinfo) {
    if ((ti.flags & SKIP_MASK) !== 0) continue;
    const name = ti.name.trim();
    if (name.length === 0) continue;
    names.add(name);
  }
  return Array.from(names).sort().map((n) => `textures/${n}.wal`);
}

function main(argv: string[]): number {
  const [bspPath] = argv;
  if (!bspPath) {
    process.stderr.write('Usage: texture-export <file.bsp>\n');
    return 1;
  }

  let bsp: BspFile;
  try {
    bsp = BspFile.loadFile(bspPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`texture-export: ${msg}\n`);
    return 1;
  }

  const paths = extractTextures(bsp);
  if (paths.length > 0) {
    process.stdout.write(paths.join('\n') + '\n');
  }
  return 0;
}

process.exit(main(process.argv.slice(2)));
