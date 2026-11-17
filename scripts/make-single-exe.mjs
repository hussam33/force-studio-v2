// Builds the single-file Windows EXE of Force Studio v2: the portable folder and the bundled Node.js are
// packed into one payload that Boot.cs unpacks in %LOCALAPPDATA% and starts.
//
//   node scripts/make-single-exe.mjs [--out dist\ForceStudioV2.exe] [--folder <portable folder>] [--port 3210]
//
// The compiler is the C# one that ships with Windows, so no extra tool is needed. Nothing here is committed to Git.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NODE_VERSION } from './make-portable.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function csc() {
  const compiler = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Microsoft.NET',
    'Framework64',
    'v4.0.30319',
    'csc.exe'
  );
  if (!fs.existsSync(compiler))
    throw new Error('The C# compiler that ships with Windows was not found, so the EXE cannot be built.');
  return compiler;
}

/** Zip a folder with the .NET archive writer (fast for the bundled Node.js). */
function zipFolder(folder, target) {
  const script = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `[System.IO.Compression.ZipFile]::CreateFromDirectory(${JSON.stringify(folder)}, ${JSON.stringify(target)}, [System.IO.Compression.CompressionLevel]::Optimal, $false)`,
  ].join('; ');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'inherit' });
}

export function buildSingleExe({ folder, out, port = 3210 } = {}) {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const payloadFolder = folder || path.join(ROOT, 'dist', `Force-Studio-v2-${pkg.version}-win-x64`);
  if (!fs.existsSync(path.join(payloadFolder, 'server.mjs')))
    throw new Error(`The portable folder is missing or incomplete: ${payloadFolder}`);
  if (!fs.existsSync(path.join(payloadFolder, 'runtime', 'node', 'node.exe')))
    throw new Error(`The portable folder has no Node.js runtime: ${payloadFolder}. Build it without --skip-node.`);
  const target = out || path.join(ROOT, 'dist', 'ForceStudioV2.exe');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'force-exe-'));
  try {
    const payload = path.join(work, 'payload.zip');
    console.log(`Packing ${payloadFolder}…`);
    zipFolder(payloadFolder, payload);
    const stamp = `${pkg.version}+${crypto
      .createHash('sha256')
      .update(fs.readFileSync(payload))
      .digest('hex')
      .slice(0, 16)}`;
    const source = path.join(ROOT, 'packaging', 'launcher', 'Boot.cs');
    const code = fs
      .readFileSync(source, 'utf8')
      .replace('@STAMP@', stamp)
      .replace('@PORT@', String(port));
    const program = path.join(work, 'Boot.cs');
    fs.writeFileSync(program, code);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    console.log('Compiling the EXE…');
    execFileSync(
      csc(),
      [
        '/nologo',
        '/target:winexe',
        '/platform:anycpu',
        `/out:${target}`,
        '/reference:System.Windows.Forms.dll',
        '/reference:System.IO.Compression.dll',
        '/reference:System.IO.Compression.FileSystem.dll',
        `/win32icon:${path.join(ROOT, 'packaging', 'ForceStudioV2.ico')}`,
        `/resource:${payload},payload.zip`,
        program,
      ],
      { stdio: 'inherit' }
    );
    const size = (fs.statSync(target).size / (1024 * 1024)).toFixed(1);
    console.log(`Single-file EXE ready: ${target} (${size} MB, Node.js ${NODE_VERSION}).`);
    return target;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const folder = option(args, '--folder', null);
  if (!folder) {
    // Build the portable folder first (app files + verified Node.js runtime); the inner ForceStudioV2.exe is not needed.
    execFileSync(
      process.execPath,
      [path.join(ROOT, 'scripts', 'make-portable.mjs'), '--skip-launcher', ...(args.includes('--skip-node') ? [] : [])],
      { cwd: ROOT, stdio: 'inherit' }
    );
  }
  buildSingleExe({
    folder: folder || undefined,
    out: option(args, '--out', undefined),
    port: Number(option(args, '--port', 3210)),
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error.message);
    process.exit(1);
  });
}
