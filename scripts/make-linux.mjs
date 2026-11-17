// Builds the Linux (x64) portable folder of Force Studio v2: app files, a verified Node.js runtime,
// the `force-studio` launcher and a .desktop entry, then packs it as a .tar.gz.
//
//   node scripts/make-linux.mjs [--out dist/folder] [--node-version v22.14.0] [--node-tar file.xz] [--skip-node]
//
// Runs on Windows (Windows' tar handles .xz) or on Linux. Nothing here is committed to Git.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION, shouldPackage, shasumFor } from './make-portable.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A tiny ustar + gzip writer. The host tar (Windows) drops the executable bit, which would leave
 * `force-studio` and the bundled node unrunnable after extraction, so the archive is written here
 * with explicit modes: 0755 for the launcher and node, 0644 for everything else.
 */
export function writeTarGz(rootDir, folderName, outFile) {
  const BLOCK = 512;
  const chunks = [];
  const header = (name, size, mode, type) => {
    const h = Buffer.alloc(BLOCK, 0);
    h.write(name, 0, 100, 'utf8');
    h.write(mode.toString(8).padStart(7, '0') + '\0', 100, 8, 'utf8');
    h.write('0000000\0', 108, 8, 'utf8');
    h.write('0000000\0', 116, 8, 'utf8');
    h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    h.write('00000000000\0', 136, 12, 'utf8');
    h.write('        ', 148, 8, 'utf8');
    h.write(type, 156, 1, 'utf8');
    h.write('ustar\0', 257, 6, 'utf8');
    h.write('00', 263, 2, 'utf8');
    let sum = 0;
    for (const byte of h) sum += byte;
    h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');
    return h;
  };
  const walk = (abs, rel) => {
    const stat = fs.statSync(abs);
    const name = `${folderName}/${rel}`;
    if (stat.isDirectory()) {
      chunks.push(header(name + '/', 0, 0o755, '5'));
      for (const entry of fs.readdirSync(abs).sort()) walk(path.join(abs, entry), rel ? `${rel}/${entry}` : entry);
      return;
    }
    const data = fs.readFileSync(abs);
    const executable = ['force-studio', 'runtime/node/node', 'install-desktop-icon.sh'].includes(rel);
    chunks.push(header(name, data.length, executable ? 0o755 : 0o644, '0'));
    chunks.push(data);
    const padding = (BLOCK - (data.length % BLOCK)) % BLOCK;
    if (padding) chunks.push(Buffer.alloc(padding, 0));
  };
  walk(rootDir, '');
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  fs.writeFileSync(outFile, zlib.gzipSync(Buffer.concat(chunks), { level: 9 }));
}

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

async function download(url, target) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Could not download ${url} (HTTP ${response.status}).`);
  fs.writeFileSync(target, Buffer.from(await response.arrayBuffer()));
}

async function obtainNode(version, tarArg, tmp) {
  const folder = `node-${version}-linux-x64`;
  const name = `${folder}.tar.xz`;
  let tar = tarArg;
  if (!tar) {
    tar = path.join(tmp, name);
    console.log(`Downloading ${name} from nodejs.org…`);
    await download(`https://nodejs.org/dist/${version}/${name}`, tar);
  }
  const sums = await (await fetch(`https://nodejs.org/dist/${version}/SHASUMS256.txt`)).text();
  const expected = shasumFor(sums, name);
  if (!expected) throw new Error(`nodejs.org lists no checksum for ${name}.`);
  const actual = crypto.createHash('sha256').update(fs.readFileSync(tar)).digest('hex');
  if (actual !== expected) throw new Error(`Checksum mismatch for ${name}: expected ${expected}, got ${actual}.`);
  execFileSync('tar', ['-xJf', tar, '-C', tmp, `${folder}/bin/node`, `${folder}/LICENSE`], { stdio: 'inherit' });
  return path.join(tmp, folder);
}

const LAUNCHER = `#!/usr/bin/env bash
# Force Studio v2: start, stop or read the log of the local studio.
#   ./force-studio            start (and open the browser)
#   FORCE_STUDIO_NO_OPEN=1 ./force-studio   start without opening a browser
#   ./force-studio stop       stop the studio
#   ./force-studio log        last lines of the log
set -euo pipefail
DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PORT="\${FORCE_STUDIO_PORT:-3210}"
URL="http://127.0.0.1:\${PORT}"
DATA="\${FORCE_STUDIO_DATA_DIR:-\${XDG_DATA_HOME:-\$HOME/.local/share}/ForceStudioV2}"
NODE="\$DIR/runtime/node/node"
# The archive keeps 0755, but a file copied or unzipped by hand may lose it.
if [ -f "\$NODE" ] && [ ! -x "\$NODE" ]; then chmod +x "\$NODE" 2>/dev/null || true; fi
[ -x "\$NODE" ] || NODE="\$(command -v node || true)"
if [ -z "\$NODE" ]; then
  echo "Node.js 22 or newer was not found. Use the portable download (it includes it) or install node." >&2
  exit 1
fi
running() { curl -fsS --max-time 2 "\$URL/api/state" >/dev/null 2>&1; }
open_browser() {
  if [ "\${FORCE_STUDIO_NO_OPEN:-0}" = "1" ]; then return 0; fi
  if command -v xdg-open >/dev/null 2>&1; then xdg-open "\$URL" >/dev/null 2>&1 || true
  elif command -v gio >/dev/null 2>&1; then gio open "\$URL" >/dev/null 2>&1 || true
  else echo "Open \$URL in your browser."; fi
}
case "\${1:-start}" in
  start)
    if running; then open_browser; exit 0; fi
    mkdir -p "\$DATA"
    cd "\$DIR"
    FORCE_STUDIO_DATA_DIR="\$DATA" nohup "\$NODE" server.mjs >>"\$DATA/force-studio.log" 2>&1 &
    for _ in \$(seq 1 120); do
      sleep 0.5
      if running; then break; fi
    done
    if ! running; then
      echo "Force Studio v2 did not start. See \$DATA/force-studio.log" >&2
      exit 1
    fi
    open_browser
    ;;
  stop)
    if running; then
      curl -fsS -X POST -H 'X-Force-Studio: 1' "\$URL/api/shutdown" >/dev/null 2>&1 || true
    fi
    ;;
  log) tail -n 200 "\$DATA/force-studio.log" ;;
  *) echo "Usage: \$0 [start|stop|log]" >&2; exit 2 ;;
esac
`;

const START_HERE = (version, folder) => `Force Studio v2 ${version} (Linux x64)

1. Open a terminal in this folder and make the launcher executable:
     chmod +x force-studio
2. Start the studio:
     ./force-studio
   The studio opens in your browser. The server starts ComfyUI in the background and
   opens the two YuE2 workflows in its list.
   Without a browser:
     FORCE_STUDIO_NO_OPEN=1 ./force-studio
3. Stop it:
     ./force-studio stop
4. Optional launcher icon (adds Force Studio v2 to the applications menu):
     chmod +x install-desktop-icon.sh && ./install-desktop-icon.sh

Songs and settings live in ~/.local/share/ForceStudioV2/data (override with FORCE_STUDIO_DATA_DIR).
The log is at the same place: force-studio.log

Requirements: ComfyUI with the YuE2 nodes and models, and FFmpeg
(Debian/Ubuntu: sudo apt install ffmpeg).
Node.js 22 is bundled in runtime/node; you do not need to install it.

Folder: ${folder}
`;

async function main() {
  const args = process.argv.slice(2);
  // The skins are generated from style.css: refresh them so a build never ships stale rules.
  execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'make-skins.mjs')], { stdio: 'inherit' });
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const folderName = `Force-Studio-v2-${pkg.version}-linux-x64`;
  const out = path.resolve(option(args, '--out', path.join(ROOT, 'dist', folderName)));
  const version = option(args, '--node-version', NODE_VERSION);
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error('The Node.js version must look like v22.14.0.');
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });

  const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  })
    .split('\n')
    .filter(Boolean)
    .filter(shouldPackage);
  for (const file of files) {
    const target = path.join(out, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(ROOT, file), target);
  }
  console.log(`Copied ${files.length} files.`);

  if (!args.includes('--skip-node')) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'force-studio-node-'));
    try {
      const folder = await obtainNode(version, option(args, '--node-tar'), tmp);
      fs.mkdirSync(path.join(out, 'runtime', 'node'), { recursive: true });
      fs.copyFileSync(path.join(folder, 'bin', 'node'), path.join(out, 'runtime', 'node', 'node'));
      fs.copyFileSync(path.join(folder, 'LICENSE'), path.join(out, 'runtime', 'node', 'LICENSE'));
      fs.chmodSync(path.join(out, 'runtime', 'node', 'node'), 0o755);
      console.log(`Node.js ${version} added and verified.`);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }

  fs.writeFileSync(path.join(out, 'force-studio'), LAUNCHER);
  fs.chmodSync(path.join(out, 'force-studio'), 0o755);
  fs.copyFileSync(path.join(out, 'public', 'favicon.png'), path.join(out, 'icon.png'));

  fs.writeFileSync(
    path.join(out, 'force-studio.desktop.in'),
    `[Desktop Entry]
Type=Application
Name=Force Studio v2
Comment=YuE2 music studio on ComfyUI
Exec=@DIR@/force-studio
Icon=@DIR@/icon.png
Terminal=false
Categories=AudioVideo;Audio;X-Music;
`
  );
  fs.writeFileSync(
    path.join(out, 'install-desktop-icon.sh'),
    '#!/usr/bin/env bash\n' +
      'set -euo pipefail\n' +
      'DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"\n' +
      'TARGET="${XDG_DATA_HOME:-$HOME/.local/share}/applications"\n' +
      'mkdir -p "$TARGET"\n' +
      'sed "s|@DIR@|$DIR|g" "$DIR/force-studio.desktop.in" > "$TARGET/force-studio-v2.desktop"\n' +
      'chmod +x "$DIR/force-studio" "$DIR/runtime/node/node" 2>/dev/null || true\n' +
      'echo "Installed $TARGET/force-studio-v2.desktop"\n'
  );
  fs.chmodSync(path.join(out, 'install-desktop-icon.sh'), 0o755);
  fs.writeFileSync(path.join(out, 'START-HERE.txt'), START_HERE(pkg.version, out));
  console.log(`Linux folder ready: ${out}`);

  if (!args.includes('--no-archive')) {
    const archive = path.join(path.dirname(out), `${folderName}.tar.gz`);
    fs.rmSync(archive, { force: true });
    writeTarGz(out, path.basename(out), archive);
    const size = (fs.statSync(archive).size / (1024 * 1024)).toFixed(1);
    console.log(`Archive ready: ${archive} (${size} MB)`);
  }
}

main().catch(error => {
  console.error(error.message);
  process.exit(1);
});
