#!/usr/bin/env node
/**
 * Merge a `unity-apk-rip` output folder into a store-game-clone reference pack.
 *
 * Usage:
 *   node merge-rip-pack.mjs --rip /path/to/<game>/output --slug <slug>
 *     [--assets-root /Users/wikz/orca-global/assets]
 *     [--models-priority P0|P1|none]   # which catalog priorities to copy into models/ (default P0)
 *     [--include-full-images]          # also copy images/ (full Texture2D dump; default: skipped when images_ingame/ exists)
 *     [--force]                        # overwrite models/*.glb that already exist
 *     [--dry-run]
 *
 * Writes:
 *   <assets-root>/<slug>/rip/                      ← rsync of the rip output (minus excluded dirs)
 *   <assets-root>/<slug>/rip/RIP_PACK.json         ← what was merged, from where, what was skipped
 *   <assets-root>/<slug>/models/<file>.glb         ← catalog P0 (default) meshes, flat, so the
 *                                                   existing "prefer import reference/<slug>/models/*.glb" path works
 *   <assets-root>/<slug>/manifest.json             ← adds a `rip` key when the store manifest exists
 *
 * Prints one JSON summary on stdout. Exit ≠ 0 only when the rip folder is unusable.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PRIORITY_RANK = { P0: 0, P1: 1, P2: 2, P3: 3 };

function die(msg, code = 1) {
  console.error(`merge-rip-pack: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = {
    assetsRoot: '/Users/wikz/orca-global/assets',
    modelsPriority: 'P0',
    includeFullImages: false,
    force: false,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--rip') out.rip = next();
    else if (a === '--slug') out.slug = next();
    else if (a === '--assets-root') out.assetsRoot = next();
    else if (a === '--models-priority') out.modelsPriority = next();
    else if (a === '--include-full-images') out.includeFullImages = true;
    else if (a === '--force') out.force = true;
    else if (a === '--dry-run') out.dryRun = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else die(`unknown arg: ${a}`);
  }
  return out;
}

function usage() {
  console.log(
    'node merge-rip-pack.mjs --rip <unity-apk-rip output dir> --slug <slug> ' +
      '[--assets-root <dir>] [--models-priority P0|P1|none] [--include-full-images] [--force] [--dry-run]',
  );
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function isDir(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function countFiles(dir) {
  if (!isDir(dir)) return 0;
  return fs.readdirSync(dir).filter((f) => !f.startsWith('.')).length;
}

/** Validate that <rip> looks like a unity-apk-rip `output/` folder. */
function inspectRip(rip) {
  if (!isDir(rip)) die(`rip folder not found: ${rip}`);
  const manifest = readJson(path.join(rip, 'manifest.json'));
  const dirs = ['images', 'images_ingame', 'fonts', 'meshes', 'levels', 'briefs'].filter((d) => isDir(path.join(rip, d)));
  const guides = ['README.md', 'IMAGES_INGAME_GUIDE.md', 'MESHES_GUIDE.md'].filter((f) =>
    fs.existsSync(path.join(rip, f)),
  );
  const catalogs = [
    'images_ingame_catalog.json',
    'meshes_catalog.json',
    'images_ingame_manifest.json',
    'de_atlas_lookup.json',
    'de_atlas_manifest.json',
  ].filter((f) => fs.existsSync(path.join(rip, f)));
  const briefs = isDir(path.join(rip, 'briefs'))
    ? fs.readdirSync(path.join(rip, 'briefs')).filter((f) => f.endsWith('.md'))
    : [];

  const looksLikeRip = Boolean(manifest && (manifest.unity_version || manifest.counts));
  if (dirs.length === 0) die(`no images/ images_ingame/ meshes/ levels/ briefs/ under ${rip}`);

  return {
    manifest,
    format: looksLikeRip ? 'unity-apk-rip' : 'unknown',
    dirs,
    guides,
    catalogs,
    briefs,
    counts: Object.fromEntries(dirs.map((d) => [d, countFiles(path.join(rip, d))])),
  };
}

function rsync(src, dest, excludes, dryRun) {
  const args = ['-a', '--exclude', '.DS_Store'];
  for (const e of excludes) args.push('--exclude', e);
  if (dryRun) args.push('--dry-run');
  args.push(src.endsWith('/') ? src : `${src}/`, dest.endsWith('/') ? dest : `${dest}/`);
  const r = spawnSync('rsync', args, { encoding: 'utf8' });
  if (r.status !== 0) die(`rsync failed: ${r.stderr || r.stdout}`);
}

/** Pick GLBs from meshes_catalog.json whose priority rank ≤ threshold. */
function selectModels(rip, threshold) {
  if (threshold === 'none') return { selected: [], reason: 'models-priority none' };
  const maxRank = PRIORITY_RANK[threshold];
  if (maxRank === undefined) die(`bad --models-priority ${threshold}`);
  const catalog = readJson(path.join(rip, 'meshes_catalog.json'));
  if (!catalog || !Array.isArray(catalog.entries)) {
    return { selected: [], reason: 'no meshes_catalog.json — nothing copied to models/ (import from rip/meshes by hand)' };
  }
  const selected = catalog.entries
    .filter((e) => e.file && PRIORITY_RANK[e.priority] !== undefined && PRIORITY_RANK[e.priority] <= maxRank)
    .filter((e) => fs.existsSync(path.join(rip, 'meshes', e.file)))
    .map((e) => ({ file: e.file, priority: e.priority, category: e.category ?? '', maps_to: e.maps_to ?? '' }));
  return { selected, reason: `catalog priority ≤ ${threshold}` };
}

function main() {
  const args = parseArgs(process.argv);
  if (args.help || !args.rip || !args.slug) {
    usage();
    process.exit(args.help ? 0 : 2);
  }
  const rip = path.resolve(args.rip);
  const packRoot = path.join(args.assetsRoot, args.slug);
  const ripDest = path.join(packRoot, 'rip');
  const modelsDest = path.join(packRoot, 'models');

  const info = inspectRip(rip);

  const excludes = [];
  if (info.dirs.includes('images') && info.dirs.includes('images_ingame') && !args.includeFullImages) {
    excludes.push('/images/');
  }

  if (!args.dryRun) fs.mkdirSync(ripDest, { recursive: true });
  rsync(rip, ripDest, excludes, args.dryRun);

  const models = selectModels(rip, args.modelsPriority);
  const copied = [];
  const skippedExisting = [];
  if (models.selected.length && !args.dryRun) fs.mkdirSync(modelsDest, { recursive: true });
  for (const m of models.selected) {
    const src = path.join(rip, 'meshes', m.file);
    const dest = path.join(modelsDest, m.file);
    if (fs.existsSync(dest) && !args.force) {
      skippedExisting.push(m.file);
      continue;
    }
    if (!args.dryRun) fs.copyFileSync(src, dest);
    copied.push(m.file);
  }

  const summary = {
    ok: true,
    dryRun: args.dryRun,
    slug: args.slug,
    source: rip,
    format: info.format,
    rip_path: ripDest,
    copied_dirs: info.dirs.filter((d) => !excludes.includes(`/${d}/`)),
    excluded_dirs: excludes.map((e) => e.replaceAll('/', '')),
    counts: info.counts,
    guides: info.guides,
    catalogs: info.catalogs,
    briefs: info.briefs,
    unity_version: info.manifest?.unity_version ?? null,
    scripting_backend: info.manifest?.scripting_backend ?? null,
    source_paths: info.manifest?.source_paths ?? {
      ripped: isDir(path.join(path.dirname(rip), 'ripped'))
        ? path.join(path.dirname(rip), 'ripped') : null,
    },
    code_availability: info.manifest?.code_availability ?? 'unassessed',
    workflow: 'rip-port',
    models: {
      dest: modelsDest,
      rule: models.reason,
      copied: copied.length,
      skipped_existing: skippedExisting.length,
      files: models.selected,
    },
    merged_at: new Date().toISOString(),
  };

  if (!args.dryRun) {
    fs.writeFileSync(path.join(ripDest, 'RIP_PACK.json'), JSON.stringify(summary, null, 2) + '\n');
    const storeManifestPath = path.join(packRoot, 'manifest.json');
    const storeManifest = readJson(storeManifestPath);
    if (storeManifest && typeof storeManifest === 'object' && !Array.isArray(storeManifest)) {
      storeManifest.rip = {
        path: 'rip/',
        source: rip,
        format: info.format,
        unity_version: summary.unity_version,
        source_paths: summary.source_paths,
        workflow: 'rip-port',
        dirs: summary.copied_dirs,
        excluded_dirs: summary.excluded_dirs,
        models_from_rip: copied.length + skippedExisting.length,
        merged_at: summary.merged_at,
      };
      fs.writeFileSync(storeManifestPath, JSON.stringify(storeManifest, null, 2) + '\n');
      summary.store_manifest_updated = true;
    } else {
      summary.store_manifest_updated = false;
    }
  }

  console.log(JSON.stringify(summary, null, 2));
}

main();
