#!/usr/bin/env node
/**
 * Crawl an Apple App Store game page into a local reference pack.
 *
 * Usage:
 *   node crawl-app-store.mjs --url https://apps.apple.com/us/app/NAME/idNNNN
 *   node crawl-app-store.mjs --id 6790147739 --slug nitelore [--country us]
 *   node crawl-app-store.mjs --url ... --out /Users/wikz/orca-global/assets/nitelore
 *
 * Writes:
 *   <out>/manifest.json
 *   <out>/icon-1024.png
 *   <out>/iphone/01.jpg …
 *   <out>/ipad/01.jpg …   (if present)
 *   <out>/video/preview.mp4 (+ poster, optional frames/)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function die(msg, code = 1) {
  console.error(`crawl-app-store: ${msg}`);
  process.exit(code);
}

function parseArgs(argv) {
  const out = { country: 'us', frames: true };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--url') out.url = next();
    else if (a === '--id') out.id = next();
    else if (a === '--slug') out.slug = next();
    else if (a === '--country') out.country = next();
    else if (a === '--out') out.out = next();
    else if (a === '--no-frames') out.frames = false;
    else if (a === '--help' || a === '-h') out.help = true;
    else die(`unknown arg: ${a}`);
  }
  return out;
}

function which(cmd) {
  const r = spawnSync('which', [cmd], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) store-game-clone' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function fetchText(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) AppleWebKit/605.1.15' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function download(url, dest) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X) store-game-clone' },
  });
  if (!res.ok) throw new Error(`download HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buf);
  return buf.length;
}

function hiRes(url, maxSide) {
  return url.replace(/\/\d+x\d+[a-z]*\.(jpg|png|webp)$/i, `/${maxSide}x${maxSide}bb.jpg`);
}

function slugify(name) {
  return String(name || 'game')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48) || 'game';
}

function extractAppId(url) {
  const m = String(url || '').match(/\/id(\d+)/);
  return m ? m[1] : null;
}

function extractM3u8(html) {
  const found = new Set();
  for (const m of html.matchAll(/https:\/\/apptrailers\.itunes\.apple\.com[^"'\\\s]+\.m3u8/g)) {
    found.add(m[0].replace(/\\u002F/g, '/'));
  }
  for (const m of html.matchAll(/https:\\\/\\\/apptrailers\.itunes\.apple\.com[^"'\\\s]+\.m3u8/g)) {
    found.add(m[0].replace(/\\\//g, '/'));
  }
  return [...found][0] || null;
}

function runFfmpeg(args) {
  const bin = which('ffmpeg');
  if (!bin) die('ffmpeg not found on PATH (needed for trailer)');
  const r = spawnSync(bin, args, { encoding: 'utf8' });
  if (r.status !== 0) {
    die(`ffmpeg failed: ${(r.stderr || r.stdout || '').slice(-500)}`);
  }
}

function probeDuration(file) {
  const bin = which('ffprobe');
  if (!bin) return null;
  const r = spawnSync(
    bin,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  const n = parseFloat((r.stdout || '').trim());
  return Number.isFinite(n) ? n : null;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(`Usage: node crawl-app-store.mjs --url <app-store-url> [--slug name] [--out dir]
       node crawl-app-store.mjs --id <numericId> [--slug name] [--country us] [--out dir]`);
    process.exit(0);
  }

  const id = args.id || extractAppId(args.url);
  if (!id) die('need --url …/idNNNN or --id NNNN');

  const lookupUrl = `https://itunes.apple.com/lookup?id=${id}&country=${args.country}`;
  console.log(`→ lookup ${lookupUrl}`);
  const data = await fetchJson(lookupUrl);
  const res = data.results?.[0];
  if (!res) die(`no App Store result for id=${id} country=${args.country}`);

  const slug = args.slug || slugify(res.trackCensoredName || res.trackName);
  const outRoot =
    args.out ||
    path.join('/Users/wikz/orca-global/assets', slug);

  const storeUrl =
    args.url ||
    `https://apps.apple.com/${args.country}/app/${slug}/id${id}`;

  console.log(`→ app "${res.trackName}" → ${outRoot}`);
  fs.mkdirSync(outRoot, { recursive: true });
  fs.mkdirSync(path.join(outRoot, 'iphone'), { recursive: true });
  fs.mkdirSync(path.join(outRoot, 'ipad'), { recursive: true });
  fs.mkdirSync(path.join(outRoot, 'video'), { recursive: true });

  const iconUrl = (res.artworkUrl512 || res.artworkUrl100 || '').replace(
    /\/\d+x\d+bb\.(jpg|png)$/i,
    '/1024x1024bb.png',
  );
  if (iconUrl) {
    const n = await download(iconUrl, path.join(outRoot, 'icon-1024.png'));
    console.log(`→ icon-1024.png (${n} bytes)`);
  }

  const iphone = (res.screenshotUrls || []).map((u) => hiRes(u, 2048));
  const ipad = (res.ipadScreenshotUrls || []).map((u) => hiRes(u, 2732));
  for (let i = 0; i < iphone.length; i++) {
    const dest = path.join(outRoot, 'iphone', `${String(i + 1).padStart(2, '0')}.jpg`);
    const n = await download(iphone[i], dest);
    console.log(`→ iphone/${path.basename(dest)} (${n} bytes)`);
  }
  for (let i = 0; i < ipad.length; i++) {
    const dest = path.join(outRoot, 'ipad', `${String(i + 1).padStart(2, '0')}.jpg`);
    const n = await download(ipad[i], dest);
    console.log(`→ ipad/${path.basename(dest)} (${n} bytes)`);
  }

  console.log(`→ scrape trailer from ${storeUrl}`);
  let m3u8 = null;
  try {
    const html = await fetchText(storeUrl);
    m3u8 = extractM3u8(html);
  } catch (e) {
    console.warn(`→ trailer scrape failed: ${e.message}`);
  }

  let durationSec = null;
  let videoRes = null;
  if (m3u8) {
    const mp4 = path.join(outRoot, 'video', 'preview.mp4');
    console.log(`→ ffmpeg ${m3u8}`);
    runFfmpeg(['-y', '-i', m3u8, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', mp4]);
    durationSec = probeDuration(mp4);
    runFfmpeg([
      '-y',
      '-ss',
      '0',
      '-i',
      mp4,
      '-frames:v',
      '1',
      '-update',
      '1',
      '-q:v',
      '2',
      path.join(outRoot, 'video', 'preview-poster.jpg'),
    ]);
    if (args.frames && durationSec) {
      const framesDir = path.join(outRoot, 'video', 'frames');
      fs.mkdirSync(framesDir, { recursive: true });
      const step = Math.max(2, Math.floor(durationSec / 10));
      for (let t = 0; t < durationSec; t += step) {
        const name = `t${String(t).padStart(2, '0')}.jpg`;
        runFfmpeg([
          '-y',
          '-ss',
          String(t),
          '-i',
          mp4,
          '-frames:v',
          '1',
          '-update',
          '1',
          '-q:v',
          '2',
          path.join(framesDir, name),
        ]);
      }
      console.log(`→ video/frames every ~${step}s`);
    }
    videoRes = 'from-m3u8';
  } else {
    console.warn('→ no preview m3u8 found (screenshots-only pack)');
  }

  const iap = [];
  // Best-effort: leave empty; STORE_DATA filled by agent from page if needed.

  const manifest = {
    app: res.trackName,
    subtitle: res.trackCensoredName !== res.trackName ? undefined : undefined,
    appId: res.trackId,
    bundleId: res.bundleId,
    url: storeUrl,
    sellerUrl: res.sellerUrl || null,
    developer: res.artistName,
    seller: res.sellerName,
    genres: res.genres,
    version: res.version,
    rating: res.averageUserRating,
    ratingCount: res.userRatingCount,
    price: res.formattedPrice,
    sizeBytes: Number(res.fileSizeBytes) || null,
    minimumOsVersion: res.minimumOsVersion,
    ageRating: res.contentAdvisoryRating,
    advisories: res.advisories || [],
    releaseDate: res.releaseDate,
    currentVersionReleaseDate: res.currentVersionReleaseDate,
    gameCenter: !!res.isGameCenterEnabled,
    languages: res.languageCodesISO2A,
    description: res.description,
    releaseNotes: res.releaseNotes,
    icon: iconUrl,
    iphoneScreenshots: iphone,
    ipadScreenshots: ipad,
    previewVideoM3u8: m3u8,
    previewVideoDurationSec: durationSec,
    previewVideoNote: videoRes,
    inAppPurchases: iap,
    local: {
      icon: 'icon-1024.png',
      iphone: iphone.map((_, i) => `iphone/${String(i + 1).padStart(2, '0')}.jpg`),
      ipad: ipad.map((_, i) => `ipad/${String(i + 1).padStart(2, '0')}.jpg`),
      video: m3u8 ? 'video/preview.mp4' : null,
      poster: m3u8 ? 'video/preview-poster.jpg' : null,
    },
    crawledAt: new Date().toISOString(),
    crawlScript: path.relative(process.cwd(), path.join(__dirname, 'crawl-app-store.mjs')),
  };

  fs.writeFileSync(path.join(outRoot, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`→ manifest.json`);
  console.log(
    JSON.stringify(
      {
        ok: true,
        slug,
        outRoot,
        app: res.trackName,
        appId: res.trackId,
        screenshots: { iphone: iphone.length, ipad: ipad.length },
        hasTrailer: !!m3u8,
        durationSec,
      },
      null,
      2,
    ),
  );
}

main().catch((e) => die(e.stack || String(e)));
