// @codedna
// description: Brings ComfyUI up in the background when the studio starts: finds an install, starts it hidden, waits for its API, and installs (opens) the two YuE2 workflows in its workflow list.
//
// exports: createComfyLauncher | findComfyInstall | workflowFileName
// used_by: server.mjs
// related: comfy-yue2.mjs (the engine that then talks to it) | workflows/*.json (the files installed)
// rules:   Never start a second ComfyUI when the API already answers on the configured port.
//          The install is only ever started from a program that exists on disk; nothing is downloaded here.
//          Workflows are written through ComfyUI's own /userdata API, with the user/default/workflows folder as a fallback.
// agent:   force-yue2 | 2026-11-14 | s_20261114_comfy | Created so opening the app is enough: no manual ComfyUI start or workflow opening.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { YUE2_WORKFLOWS } from './comfy-yue2.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/** The name a workflow gets in ComfyUI's list (one file per workflow, stable between starts). */
export function workflowFileName(workflow) {
  return `Force Studio v2 - YuE2 ${workflow.name.replace(/^YuE2 · /, '')}.json`;
}

/** Workflows written by earlier names of the app: removed from ComfyUI's list so it shows no duplicates. */
export const LEGACY_WORKFLOW_FILES = [
  'Sonora YuE2 - Text to Music.json',
  'Sonora YuE2 - Music Cover.json',
  'sonora-probe.json',
];

/** The python interpreter inside a ComfyUI folder, whichever layout it uses (Windows or Linux). */
function pythonOf(base) {
  for (const rel of [
    ['.venv', 'bin', 'python3'],
    ['.venv', 'bin', 'python'],
    ['venv', 'bin', 'python3'],
    ['venv', 'bin', 'python'],
    ['.venv', 'Scripts', 'python.exe'],
    ['venv', 'Scripts', 'python.exe'],
  ]) {
    const candidate = path.join(base, ...rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every place a ComfyUI may live on this machine, most specific first. */
export function comfyCandidates({ home = os.homedir(), localAppData = process.env.LOCALAPPDATA } = {}) {
  const list = [];
  const add = (entry, args, cwd) => {
    if (!entry) return;
    const key = entry.toLowerCase();
    if (!list.some(item => item.entry.toLowerCase() === key)) list.push({ entry, args, cwd });
  };
  // ComfyUI Desktop (Electron): starting the program brings its own server up.
  if (localAppData) add(path.join(localAppData, 'Programs', 'ComfyUI', 'ComfyUI.exe'), [], undefined);
  // ComfyUI Desktop's Python installation, started headless from its own folder.
  if (localAppData) {
    const installs = path.join(localAppData, 'Comfy-Desktop', 'ComfyUI-Installs');
    // ComfyUI Desktop keeps its model folders in a generated YAML; without it the server starts but sees no models.
    const desktopData = process.env.APPDATA ? path.join(process.env.APPDATA, 'Comfy Desktop', 'instance-model-paths') : '';
    const modelPaths = desktopData
      ? safeRead(desktopData)
          .filter(name => name.endsWith('.yaml'))
          .map(name => path.join(desktopData, name))
      : [];
    for (const name of safeRead(installs)) {
      const dir = path.join(installs, name);
      const python = path.join(dir, 'ComfyUI', '.venv', 'Scripts', 'python.exe');
      const withModels = modelPaths.length ? ['--extra-model-paths-config', modelPaths[0]] : [];
      add(python, ['-s', 'ComfyUI/main.py', ...withModels], dir);
    }
  }
  // The Windows portable build (python_embeded next to ComfyUI).
  for (const base of [ROOT, path.join(ROOT, '..'), home, path.join(home, 'Desktop'), path.join(home, 'Downloads')])
    add(path.join(base, 'ComfyUI_windows_portable', 'python_embeded', 'python.exe'), ['-s', 'ComfyUI/main.py'], base);
  // Linux: a git/venv install in the usual places, plus a portable folder next to the app.
  const linuxBases = [
    path.join(home, 'ComfyUI'),
    path.join(home, 'comfyui'),
    path.join(home, 'Documents', 'ComfyUI'),
    path.join(home, '.local', 'share', 'ComfyUI'),
    '/opt/ComfyUI',
    '/usr/local/ComfyUI',
    path.join(ROOT, 'ComfyUI'),
    path.join(ROOT, '..', 'ComfyUI'),
  ];
  for (const base of linuxBases) {
    const python = pythonOf(base);
    if (python) add(python, ['-s', 'main.py'], base);
  }
  // Windows: the same folder layouts with Scripts/python.exe.
  for (const base of [path.join(home, 'ComfyUI'), path.join(home, 'Documents', 'ComfyUI'), 'C:\\ComfyUI']) {
    const python = pythonOf(base);
    if (python) add(python, ['-s', 'main.py'], base);
  }
  return list;
}

function safeRead(dir) {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

/** The first candidate that really exists, with what is needed to start it. */
export function findComfyInstall(candidates = comfyCandidates()) {
  for (const candidate of candidates) {
    try {
      if (candidate.entry && fs.existsSync(candidate.entry)) return candidate;
    } catch {
      /* unreadable path */
    }
  }
  return null;
}

/**
 * @param settings { url, autoStart?, start?: { command, args?, cwd? }, workflows?: boolean, waitMs? }
 * @param options  { dataDir, fetchImpl?, spawnImpl?, candidates?, installDir?, log? }
 */
export function createComfyLauncher(
  settings = {},
  { dataDir = '.', fetchImpl = fetch, spawnImpl = spawn, candidates, installDir, log = () => {} } = {}
) {
  const urlOf = () =>
    String(typeof settings.url === 'function' ? settings.url() : settings.url || 'http://127.0.0.1:8188').replace(/\/$/, '');
  const autoStart = settings.autoStart !== false;
  // Rules: a cold ComfyUI Desktop start can take minutes on a busy graphics card (167 s measured on an RTX 4070 laptop).
  const waitMs = Number.isFinite(settings.waitMs) ? settings.waitMs : 360000;
  const state = {
    online: false,
    started: false,
    ready: false,
    message: 'Connecting to ComfyUI…',
    workflows: { installed: 0, dir: '', files: [] },
    install: '',
  };
  let starting = null;

  async function ping(timeout = 2000) {
    try {
      const r = await fetchImpl(urlOf() + '/system_stats', { signal: AbortSignal.timeout(timeout) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  }

  /**
   * Where ComfyUI keeps user/default/workflows, from the command line it was started with:
   * --user-directory points at `user`, the others at the root that contains it.
   */
  function workflowsDir(stats) {
    const argv = stats?.system?.argv;
    const flags = {
      '--user-directory': value => path.join(path.resolve(value), 'default', 'workflows'),
      '--base-directory': value => path.join(path.resolve(value), 'user', 'default', 'workflows'),
      // ComfyUI Desktop passes the input folder, whose parent is the root (…\ComfyUI\input → …\ComfyUI).
      '--input-directory': value => path.join(path.dirname(path.resolve(value)), 'user', 'default', 'workflows'),
    };
    if (Array.isArray(argv))
      for (const [flag, resolve] of Object.entries(flags)) {
        const index = argv.findIndex(a => typeof a === 'string' && (a === flag || a.startsWith(flag + '=')));
        if (index < 0) continue;
        const value = argv[index].includes('=') ? argv[index].split('=').slice(1).join('=') : argv[index + 1];
        if (typeof value === 'string' && value && value.length < 500) return resolve(value);
      }
    if (installDir) return path.join(installDir, 'user', 'default', 'workflows');
    return path.join(os.homedir(), 'Documents', 'ComfyUI', 'user', 'default', 'workflows');
  }

  /** Install (open) the YuE2 workflows in ComfyUI's list: first through its API, then on disk. */
  async function installWorkflows(stats) {
    const dir = workflowsDir(stats);
    const files = [];
    for (const legacy of LEGACY_WORKFLOW_FILES)
      await fetchImpl(`${urlOf()}/userdata/${encodeURIComponent('workflows/' + legacy)}`, {
        method: 'DELETE',
        signal: AbortSignal.timeout(8000),
      }).catch(() => {});
    for (const workflow of Object.values(YUE2_WORKFLOWS)) {
      const source = path.join(ROOT, 'workflows', workflow.file);
      if (!fs.existsSync(source)) continue;
      const name = workflowFileName(workflow);
      const bytes = fs.readFileSync(source);
      let written = false;
      try {
        const r = await fetchImpl(`${urlOf()}/userdata/${encodeURIComponent('workflows/' + name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: bytes,
          signal: AbortSignal.timeout(15000),
        });
        written = r.ok;
      } catch {
        written = false;
      }
      if (!written) {
        try {
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, name), bytes);
          written = true;
        } catch (e) {
          log(`Cannot install ${name}: ${e.message}`);
        }
      }
      if (written) files.push(name);
    }
    state.workflows = { installed: files.length, dir, files };
    try {
      fs.mkdirSync(path.join(dataDir, 'comfy'), { recursive: true });
      fs.writeFileSync(
        path.join(dataDir, 'comfy', 'workflows.json'),
        JSON.stringify({ at: new Date().toISOString(), url: urlOf(), dir, files }, null, 2)
      );
    } catch {
      /* the report is optional */
    }
    return state.workflows;
  }

  /** Start the install found on disk, detached, with its log in data/comfy/start.log. */
  function spawnTarget(target) {
    state.install = target.entry;
    fs.mkdirSync(path.join(dataDir, 'comfy'), { recursive: true });
    const logFile = fs.openSync(path.join(dataDir, 'comfy', 'start.log'), 'a');
    log(`Starting ComfyUI: ${target.entry}`);
    const child = spawnImpl(target.entry, target.args || [], {
      cwd: target.cwd || path.dirname(target.entry),
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFile, logFile],
    });
    fs.closeSync(logFile);
    child.on?.('error', error => log(`ComfyUI did not start: ${error.message}`));
    child.unref?.();
    state.started = true;
    return child;
  }

  function candidateList() {
    if (settings.start?.command)
      return [{ entry: settings.start.command, args: settings.start.args || [], cwd: settings.start.cwd }];
    return (
      candidates || [
        ...(settings.start?.candidates || []).map(entry => ({ entry, args: [], cwd: undefined })),
        ...comfyCandidates(),
      ]
    ).filter(target => target?.entry && fs.existsSync(target.entry));
  }

  /**
   * Every install on disk is tried in turn: the desktop launcher, then the same install's Python server.
   * A program that exits at once (a broken desktop shell) does not cost the whole wait.
   */
  async function start() {
    const targets = candidateList();
    if (!targets.length) throw new Error('I cannot find ComfyUI on this computer: set its program in the settings.');
    const tried = [];
    for (const target of targets) {
      const child = spawnTarget(target);
      let exited = false;
      child.once?.('exit', () => {
        exited = true;
      });
      const deadline = Date.now() + Math.min(waitMs, 90000);
      while (Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        if (await ping(1500)) return;
        if (exited) break;
      }
      tried.push(path.basename(target.entry));
      log(`ComfyUI did not answer from ${target.entry}${exited ? ' (the program exited)' : ''}; trying the next one.`);
      try {
        if (!exited && child.pid) process.kill(child.pid);
      } catch {
        /* it is already gone */
      }
    }
    throw new Error(
      'ComfyUI did not answer. Tried: ' + tried.join(', ') + '. See data/comfy/start.log.'
    );
  }

  /**
   * Make sure ComfyUI answers; start it when it does not (once, all callers share the same start).
   * Rules: a failing start is only retried every minute, so the studio's periodic health check cannot spawn a storm.
   */
  let lastAttemptAt = 0;
  async function ensure() {
    let stats = await ping();
    if (!stats) {
      if (!autoStart) {
        Object.assign(state, { online: false, ready: false, message: 'ComfyUI is not running. Start it, then press Check again.' });
        return state;
      }
      if (!starting && Date.now() - lastAttemptAt < 60000) {
        Object.assign(state, { online: false, ready: false, message: state.message || 'Starting ComfyUI…' });
        return state;
      }
      if (!starting) {
        lastAttemptAt = Date.now();
        starting = (async () => {
          await start();
          const deadline = Date.now() + waitMs;
          while (Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 1000));
            const found = await ping();
            if (found) return found;
          }
          throw new Error('ComfyUI did not answer within ' + Math.round(waitMs / 1000) + ' s: see data/comfy/start.log.');
        })().finally(() => {
          starting = null;
        });
      }
      stats = await starting;
    }
    state.online = true;
    state.ready = true;
    state.message = '';
    if (settings.workflows !== false) await installWorkflows(stats);
    return state;
  }

  return {
    ensure,
    /** The last known state without touching ComfyUI (for /api/state). */
    snapshot: () => ({ ...state, workflows: { ...state.workflows } }),
    /** Install the two workflows again (the "Open workflows in ComfyUI" action). */
    async install() {
      const stats = await ping(5000);
      if (!stats) throw new Error('ComfyUI is not reachable.');
      return await installWorkflows(stats);
    },
    async stop() {
      // Nothing is killed: ComfyUI may be the desktop app the user keeps open for other work.
    },
  };
}

