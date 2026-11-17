// @codedna
// description: Force Studio v2's YuE2 engine on ComfyUI: the same calls as the other YuE2 backends (call, submitAction, status, cancel, collect), backed by ComfyUI's native YuE2 nodes and the official "YuE2: Text to Music" / "YuE2: Music Cover" workflows.
//
// exports: createComfyYue2 | buildSongGraph | buildPlanGraph | buildTranscribeGraph | YUE2_WORKFLOWS | YUE2_NODES
// used_by: server.mjs
// related: lib.mjs (ACE-Step graph, same graph idiom) | yue2-cpp.mjs / yue2-local.mjs (the other YuE2 backends with the same interface)
// rules:   Every node input required by the installed ComfyUI is written explicitly (no reliance on widget defaults).
//          The audio is copied into the library only after the size and SHA-256 of both written files match.
//          Nothing here spawns ComfyUI: it must be running and reachable, started by the app (comfy-launcher.mjs) or by the user.
// agent:   force-yue2 | 2026-11-14 | s_20261114_comfy | Created so the studio makes songs with ComfyUI's YuE2 nodes instead of ACE-Step.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The two workflows the app installs (and opens) in ComfyUI's own workflow list at start-up. */
export const YUE2_WORKFLOWS = {
  text2music: { file: 'audio_yue2_text2music.json', name: 'YuE2 · Text to Music', id: 'force-studio-v2-text2music' },
  cover: { file: 'audio_yue2_music_cover.json', name: 'YuE2 · Music Cover', id: 'force-studio-v2-music-cover' },
};

/** The ComfyUI nodes this engine drives; health() reports whichever is missing. */
export const YUE2_NODES = [
  'CheckpointLoaderSimple',
  'YuE2GenerateABC',
  'YuE2GenerateMusic',
  'EmptyYuE2LatentAudio',
  'KSampler',
  'ConditioningZeroOut',
  'VAEDecodeAudio',
  'SaveAudio',
  'SaveAudioMP3',
  'LoadAudio',
  'AudioEncoderLoader',
  'SheetSage2AudioToABC',
];

/** A short, human label for the node ComfyUI is executing. */
const PHASE = {
  CheckpointLoaderSimple: 'Loading the YuE2 model',
  AudioEncoderLoader: 'Loading the transcriber',
  LoadAudio: 'Reading the song',
  SheetSage2AudioToABC: 'Transcribing the melody',
  YuE2GenerateABC: 'Writing the score',
  YuE2GenerateMusic: 'Composing the song',
  ConditioningZeroOut: 'Preparing the song',
  EmptyYuE2LatentAudio: 'Preparing the audio',
  KSampler: 'Generating audio',
  VAEDecodeAudio: 'Decoding audio',
  SaveAudio: 'Saving FLAC',
  SaveAudioMP3: 'Saving MP3',
};

const node = (class_type, inputs) => ({ class_type, inputs });
const clamp = (value, min, max, fallback) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** The generation mode of the two YuE2 nodes: 'off' means "no plan", which the music node expresses with an empty ABC. */
export function cotMode(cot, hasAbc) {
  if (hasAbc) return cot === 'melody' ? 'melody' : 'full';
  if (cot === 'melody') return 'melody';
  return 'full';
}

/**
 * The text-to-music (and music-cover) graph: checkpoint → [ABC] → YuE2 music → sampler → audio → FLAC + MP3.
 * `input.abc` (an edited or transcribed score) is used verbatim; otherwise the ABC node writes one, unless cot is 'off'.
 */
export function buildSongGraph(input, seed, options = {}) {
  const checkpoint = options.checkpoint || 'yue2_3b_int8_convrot.safetensors';
  const prefix = options.prefix || 'ForceStudioV2/YuE2/song';
  const duration = clamp(Number(input.duration), 2, 900, 120);
  const mode = cotMode(input.cot ?? 'full', !!input.abc);
  const autoAbc = !input.abc && (input.cot ?? 'full') !== 'off';
  // "How much to change": a free-ranged 0..1 that raises the sampler temperature (and widens top-p),
  // so a low value follows the plan closely and a high one rephrases melody and arrangement.
  const variation = Number.isFinite(input.variation) ? clamp(input.variation, 0, 1, 0.5) : null;
  // Explicit fine tuning wins; without it the macro dial ("How much to change") decides.
  const temperature = Number.isFinite(input.temperature)
    ? clamp(input.temperature, 0.1, 5, 1)
    : variation === null
      ? 1.0
      : Math.round((0.85 + variation * 0.5) * 100) / 100;
  const topP = Number.isFinite(input.topP)
    ? clamp(input.topP, 0.01, 1, 0.95)
    : variation === null
      ? 0.95
      : Math.round((0.9 + variation * 0.07) * 100) / 100;
  const repetition = Number.isFinite(input.repetition) ? clamp(input.repetition, 0.01, 10, 1.2) : 1.2;
  const steps = clamp(Number(input.steps ?? options.steps), 1, 200, 32);
  const graph = {
    1: node('CheckpointLoaderSimple', { ckpt_name: checkpoint }),
    3: node('YuE2GenerateMusic', {
      clip: ['1', 1],
      style: String(input.style ?? ''),
      lyrics: String(input.lyrics ?? ''),
      abc: input.abc ? String(input.abc) : autoAbc ? ['2', 0] : '',
      seed,
      mode,
      max_duration: duration,
      temperature,
      top_p: topP,
      top_k: 100,
      repetition_penalty: repetition,
      cfg_scale: 1.0,
    }),
    4: node('ConditioningZeroOut', { conditioning: ['3', 0] }),
    5: node('EmptyYuE2LatentAudio', { seconds: ['3', 1], batch_size: 1 }),
    6: node('KSampler', {
      model: ['1', 0],
      seed,
      steps,
      cfg: 1,
      sampler_name: options.sampler || 'dpm_2',
      scheduler: options.scheduler || 'sgm_uniform',
      positive: ['3', 0],
      negative: ['4', 0],
      latent_image: ['5', 0],
      denoise: 1,
    }),
    7: node('VAEDecodeAudio', { samples: ['6', 0], vae: ['1', 2] }),
    8: node('SaveAudio', { audio: ['7', 0], filename_prefix: prefix }),
    9: node('SaveAudioMP3', {
      audio: ['7', 0],
      filename_prefix: prefix,
      quality: options.mp3Quality || 'V0',
    }),
    // The real length of the song and (when written in the graph) the score, read back from the history.
    10: node('PreviewAny', { source: ['3', 1] }),
  };
  if (autoAbc) {
    graph[2] = node('YuE2GenerateABC', {
      clip: ['1', 1],
      style: String(input.style ?? ''),
      lyrics: String(input.lyrics ?? ''),
      seed,
      mode,
      max_abc_tokens: clamp(Number(options.maxAbcTokens), 1, 20000, 8192),
      temperature: 0.7,
      top_p: 0.9,
      top_k: 30,
      repetition_penalty: 1.005,
      penalty_window: 100,
    });
    graph[11] = node('PreviewAny', { source: ['2', 0] });
  }
  return graph;
}

/** The ABC-only graph behind "write the plan before creating the song". */
export function buildPlanGraph(input, seed, options = {}) {
  return {
    1: node('CheckpointLoaderSimple', {
      ckpt_name: options.checkpoint || 'yue2_3b_int8_convrot.safetensors',
    }),
    2: node('YuE2GenerateABC', {
      clip: ['1', 1],
      style: String(input.style ?? ''),
      lyrics: String(input.lyrics ?? ''),
      seed,
      mode: input.cot === 'melody' ? 'melody' : 'full',
      max_abc_tokens: clamp(Number(options.maxAbcTokens), 1, 20000, 8192),
      temperature: 0.7,
      top_p: 0.9,
      top_k: 30,
      repetition_penalty: 1.005,
      penalty_window: 100,
    }),
    3: node('PreviewAny', { source: ['2', 0] }),
  };
}

/** The SheetSage2 graph that turns an uploaded song into the ABC melody a cover sings. */
export function buildTranscribeGraph(input, options = {}) {
  return {
    1: node('AudioEncoderLoader', {
      audio_encoder_name: options.audioEncoder || 'sheetsage2_bf16.safetensors',
    }),
    2: node('LoadAudio', { audio: String(input.audioName) }),
    3: node('SheetSage2AudioToABC', {
      audio_encoder: ['1', 0],
      audio: ['2', 0],
      mode: input.chords ? 'full' : 'melody',
    }),
    4: node('PreviewAny', { source: ['3', 0] }),
  };
}

/** The text of a PreviewAny node in a ComfyUI history entry (a string, or the list SheetSage2 can return). */
export function previewText(entry) {
  for (const output of Object.values(entry?.outputs || {})) {
    if (Array.isArray(output?.text)) return output.text.join('\n');
    if (typeof output?.string === 'string') return output.string;
  }
  return '';
}

/** The first audio file of `ext` written by the graph ('flac' from SaveAudio, 'mp3' from SaveAudioMP3). */
export function audioFile(entry, ext) {
  for (const output of Object.values(entry?.outputs || {})) {
    for (const file of output?.audio || []) {
      if (path.extname(String(file.filename || '')).toLowerCase() === `.${ext}`) return file;
    }
  }
  return null;
}

function historyFailure(entry) {
  const event = entry?.status?.messages?.findLast(m =>
    ['execution_error', 'execution_interrupted'].includes(m[0])
  );
  if (!event) return null;
  return {
    cancelled: event[0] === 'execution_interrupted',
    message: event[1]?.exception_message || 'Generation interrupted.',
  };
}

async function describe(file) {
  const digest = createHash('sha256');
  for await (const bytes of fs.createReadStream(file)) digest.update(bytes);
  return { format: path.extname(file).slice(1), bytes: fs.statSync(file).size, sha256: digest.digest('hex') };
}

/**
 * @param settings { url, checkpoint, audioEncoder, steps, mp3Quality, maxAbcTokens } — defaults suit a normal ComfyUI
 *   install with the YuE2 models in models/checkpoints and models/audio_encoders.
 * @param options  { dataDir, fetchImpl?, WebSocketImpl?, now? }
 */
export function createComfyYue2(settings = {}, { dataDir, fetchImpl = fetch, WebSocketImpl = globalThis.WebSocket } = {}) {
  // The address can change while the app runs (Provider settings), so it is read on every call.
  const urlOf = () =>
    String(typeof settings.url === 'function' ? settings.url() : settings.url || '').replace(/\/$/, '');
  const configured = true;
  const base = path.join(dataDir || '.', 'comfy-yue2');
  // ComfyUI sends a prompt's execution events only to the client that queued it: one id for both the queue and the socket.
  const clientId = `force-${randomUUID()}`;
  // The checkpoint can be a string or a function, because the studio lets the user change it while it runs.
  const checkpointOf = () =>
    (typeof settings.checkpoint === 'function' ? settings.checkpoint() : settings.checkpoint) ||
    'yue2_3b_int8_convrot.safetensors';
  const options = {
    audioEncoder: settings.audioEncoder || 'sheetsage2_bf16.safetensors',
    steps: settings.steps ?? 32,
    mp3Quality: settings.mp3Quality || 'V0',
    maxAbcTokens: settings.maxAbcTokens ?? 8192,
  };
  const folder = id => {
    if (!UUID.test(String(id))) throw new Error('Invalid job identifier.');
    return path.join(base, String(id).toLowerCase());
  };
  const readJson = file => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
  };

  async function api(route, init) {
    const r = await fetchImpl(urlOf() + route, { signal: AbortSignal.timeout(30000), ...(init || {}) });
    const text = await r.text();
    let value = null;
    try {
      value = text ? JSON.parse(text) : null;
    } catch {
      value = text;
    }
    if (!r.ok) {
      const detail = typeof value === 'object' && value ? JSON.stringify(value).slice(0, 1200) : String(text).slice(0, 1200);
      throw new Error(`ComfyUI ${r.status}: ${detail}`);
    }
    return value;
  }

  // ---- progress: one websocket for the whole studio; the messages name the prompt they belong to ----
  const live = new Map(); // promptId -> { label, percent }
  let socket = null;
  let reconnect = null;
  function connect() {
    if (socket || typeof WebSocketImpl !== 'function' || !configured) return;
    if (!live.size) return;
    try {
      const u = new URL(urlOf() + '/ws');
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      u.searchParams.set('clientId', clientId);
      const current = new WebSocketImpl(u);
      socket = current;
      current.addEventListener('error', () => {});
      current.addEventListener('close', () => {
        if (socket === current) socket = null;
        if (live.size) reconnect = setTimeout(connect, 5000);
      });
      current.addEventListener('message', event => {
        if (typeof event.data !== 'string') return;
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        const d = message.data || {};
        const state = d.prompt_id ? live.get(d.prompt_id) : null;
        if (!state) return;
        if (message.type === 'executing' && d.node) {
          state.node = d.node;
          state.percent = null;
        }
        if (message.type === 'progress' && Number.isFinite(d.value) && Number.isFinite(d.max) && d.max > 0)
          state.percent = Math.min(99, Math.floor((100 * d.value) / d.max));
      });
    } catch {
      socket = null;
    }
  }
  function track(promptId, graph) {
    live.set(promptId, { graph, node: null, percent: null });
    connect();
  }
  function untrack(promptId) {
    live.delete(promptId);
  }
  function progressOf(promptId) {
    const state = live.get(promptId);
    if (!state) return '';
    const type = state.graph?.[state.node]?.class_type;
    const label = PHASE[type] || '';
    if (label && Number.isFinite(state.percent)) return `${label} · ${state.percent}%`;
    return label;
  }

  async function submit(graph) {
    const promptId = randomUUID();
    const answer = await api('/prompt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: graph, prompt_id: promptId, client_id: clientId }),
    });
    const id = answer?.prompt_id || promptId;
    track(id, graph);
    return id;
  }

  /** Poll a prompt until it leaves the queue and its history entry exists (used by the two text-only calls). */
  async function waitFor(promptId, waitMs) {
    const deadline = Date.now() + waitMs;
    for (;;) {
      const history = await api(`/history/${encodeURIComponent(promptId)}`);
      const entry = history?.[promptId];
      if (entry) {
        const fail = historyFailure(entry);
        if (fail) throw new Error(fail.message);
        if (entry.status?.completed || entry.status?.status_str === 'success') return entry;
      }
      if (Date.now() > deadline) throw new Error('ComfyUI did not answer in time.');
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  /** Upload a song to ComfyUI's input folder so LoadAudio can read it; returns the name LoadAudio wants. */
  async function uploadSong(id, bytes, format) {
    const name = `force-cover-${id}.${format === 'wav' ? 'wav' : 'mp3'}`;
    const form = new FormData();
    form.append('image', new Blob([bytes], { type: format === 'wav' ? 'audio/wav' : 'audio/mpeg' }), name);
    form.append('overwrite', 'true');
    form.append('type', 'input');
    const r = await fetchImpl(urlOf() + '/upload/image', { method: 'POST', body: form, signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`ComfyUI refused the song (HTTP ${r.status}).`);
    const value = await r.json().catch(() => null);
    const saved = value?.name ? (value.subfolder ? `${value.subfolder}/${value.name}` : value.name) : name;
    return saved;
  }

  /** Download one history file into `dir`, keeping the studio's names (track.flac / track.mp3). */
  async function download(file, dir, ext) {
    const q = new URLSearchParams({
      filename: file.filename,
      subfolder: file.subfolder || '',
      type: file.type || 'output',
    });
    const r = await fetchImpl(`${urlOf()}/view?${q}`, { signal: AbortSignal.timeout(120000) });
    if (!r.ok) throw new Error(`ComfyUI cannot serve ${file.filename} (HTTP ${r.status}).`);
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length < 64) throw new Error(`ComfyUI returned an empty ${ext} file.`);
    const target = path.join(dir, `track.${ext}`);
    fs.writeFileSync(target + '.part', bytes);
    fs.renameSync(target + '.part', target);
    return await describe(target);
  }

  /** Turn a finished history entry into Force Studio v2's result.json (audio receipt, score, length). */
  async function finish(id, entry, meta) {
    const dir = folder(id);
    fs.mkdirSync(dir, { recursive: true });
    const flac = audioFile(entry, 'flac');
    const mp3 = audioFile(entry, 'mp3');
    if (!flac || !mp3) throw new Error('ComfyUI did not write both audio files (FLAC and MP3).');
    const audio = [await download(flac, dir, 'flac'), await download(mp3, dir, 'mp3')];
    // Node 10 previews the real length, node 11 the score this graph wrote (a score passed in is in `meta`).
    const outputs = entry?.outputs || {};
    const seconds = Number.parseFloat(outputs['10']?.text?.[0] ?? '');
    const written = Array.isArray(outputs['11']?.text) ? outputs['11'].text.join('\n') : '';
    const abc = meta?.wantsAbc === false ? '' : written || meta?.abc || '';
    const output = {
      localId: id,
      audio,
      ...(abc && /^X:|^K:|^T:/m.test(abc) ? { abc } : {}),
      cot: meta?.cot,
      seed: meta?.seed,
      ...(Number.isFinite(seconds) && seconds > 0 ? { duration: Math.round(seconds * 100) / 100 } : {}),
      seconds: Math.round((Date.now() - meta.started) / 100) / 10,
      engine: 'comfyui',
    };
    fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify(output));
    return output;
  }

  return {
    configured,
    /** ComfyUI reachable, the YuE2 nodes installed and the two model files listed. */
    async health() {
      if (!configured)
        return { online: false, ready: false, backend: 'yue2-comfy', message: 'ComfyUI address is not set.' };
      try {
        const stats = await api('/system_stats');
        const results = await Promise.all(YUE2_NODES.map(n => api('/object_info/' + n)));
        const info = Object.assign({}, ...results);
        const missingNodes = YUE2_NODES.filter(n => !info[n]);
        // ComfyUI lists a combo as ["COMBO", { options }] in newer builds and as ["a", "b"] in older ones.
        const list = schema => {
          if (!Array.isArray(schema)) return [];
          if (Array.isArray(schema[0])) return schema[0];
          if (Array.isArray(schema[1]?.options)) return schema[1].options;
          return schema.filter(item => typeof item === 'string' && item !== 'COMBO');
        };
        const checkpointsList = list(info.CheckpointLoaderSimple?.input?.required?.ckpt_name);
        const encodersList = list(info.AudioEncoderLoader?.input?.required?.audio_encoder_name);
        const checkpoint = checkpointOf();
        const missingModels = [
          !checkpointsList.includes(checkpoint) && checkpoint,
          !encodersList.includes(options.audioEncoder) && options.audioEncoder,
        ].filter(Boolean);
        const ready = !missingNodes.length && !missingModels.length;
        return {
          online: true,
          ready,
          backend: 'yue2-comfy',
          gpu: stats?.devices?.[0]?.name,
          message: !missingNodes.length
            ? missingModels.length
              ? `Missing models: ${missingModels.join(', ')}`
              : ''
            : `YuE2 nodes missing in ComfyUI: ${missingNodes.join(', ')}`,
          missingNodes,
          missingModels,
          // The picker above Compose: every checkpoint ComfyUI lists, with the one in use.
          checkpoint,
          checkpoints: checkpointsList,
          comfyUrl: urlOf(),
        };
      } catch (e) {
        return {
          online: false,
          ready: false,
          backend: 'yue2-comfy',
          message: `ComfyUI is not reachable at ${urlOf()}. ${e.message}`,
          comfyUrl: urlOf(),
        };
      }
    },
    /** A call that waits for its result: the plan (score only, no audio) or the melody of a cover. */
    async call(input, waitMs = 1800000) {
      const started = Date.now();
      if (input.action === 'transcribe') {
        const format = input.format === 'wav' ? 'wav' : 'mp3';
        const audioName = await uploadSong(input.localId || randomUUID(), Buffer.from(input.audio, 'base64'), format);
        const prompt = await submit(buildTranscribeGraph({ audioName, chords: !!input.chords }, options));
        const entry = await waitFor(prompt, waitMs);
        untrack(prompt);
        const abc = previewText(entry);
        if (!abc.trim()) throw new Error('SheetSage2 did not transcribe the song.');
        return { abc, chords: !!input.chords, seconds: Math.round((Date.now() - started) / 100) / 10 };
      }
      if (input.action !== 'plan') throw new Error('Action not supported by ComfyUI YuE2.');
      const seed = Number.isInteger(input.seed) && input.seed >= 0 ? input.seed : 0;
      const prompt = await submit(buildPlanGraph(input, seed, { ...options, checkpoint: checkpointOf() }));
      const entry = await waitFor(prompt, waitMs);
      untrack(prompt);
      const abc = previewText(entry);
      if (!abc.trim()) throw new Error('YuE2 did not write the plan.');
      return { abc, seed, seconds: Math.round((Date.now() - started) / 100) / 10 };
    },
    /** Release the progress socket: the app is closing and nothing should keep the process alive. */
    close() {
      live.clear();
      clearTimeout(reconnect);
      try {
        socket?.close();
      } catch {
        /* already closed */
      }
      socket = null;
    },
    async submitAction(input) {
      if (input.action !== 'generate') throw new Error('Action not supported by ComfyUI YuE2.');
      const id = String(input.localId).toLowerCase();
      const dir = folder(id);
      fs.mkdirSync(dir, { recursive: true });
      for (const stale of ['result.json', 'cancelled']) fs.rmSync(path.join(dir, stale), { force: true });
      const seed = Number.isInteger(input.seed) && input.seed >= 0 ? input.seed : 0;
      const graph = buildSongGraph(
        {
          style: input.style,
          lyrics: input.lyrics,
          abc: input.abc,
          cot: input.cot,
          duration: input.duration,
          // The remix dials: how freely it sings, the sampling fine tuning and the detail steps.
          variation: input.variation,
          temperature: input.temperature,
          topP: input.topP,
          repetition: input.repetition,
          steps: input.steps,
        },
        seed,
        { ...options, checkpoint: checkpointOf(), prefix: `ForceStudioV2/YuE2/${id}` }
      );
      const promptId = await submit(graph);
      fs.writeFileSync(
        path.join(dir, 'engine.json'),
        JSON.stringify({
          promptId,
          started: Date.now(),
          seed,
          cot: input.cot ?? 'full',
          wantsAbc: !!(input.abc || (input.cot ?? 'full') !== 'off'),
          // The score the song was sung from (when the user or a transcription supplied it).
          ...(input.abc ? { abc: String(input.abc) } : {}),
        })
      );
      // The API graph of this song, so it can be downloaded and opened in ComfyUI from the song's page.
      try {
        fs.mkdirSync(path.join(dataDir, 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'workflows', `${id}.json`), JSON.stringify(graph, null, 2));
      } catch {
        /* the download is a convenience, never a reason to fail the song */
      }
      return { host: 'local', engine: 'comfy', id, promptId };
    },
    async status(job) {
      const id = job.remote?.id;
      if (!id) return { status: 'UNKNOWN' };
      const dir = folder(id);
      const done = readJson(path.join(dir, 'result.json'));
      if (done) {
        untrack(readJson(path.join(dir, 'engine.json'))?.promptId);
        return { status: 'COMPLETED', output: done };
      }
      const meta = readJson(path.join(dir, 'engine.json'));
      if (!meta?.promptId) return { status: 'LOST' };
      if (fs.existsSync(path.join(dir, 'cancelled'))) return { status: 'CANCELLED' };
      let entry = null;
      try {
        const history = await api(`/history/${encodeURIComponent(meta.promptId)}`);
        entry = history?.[meta.promptId] || null;
      } catch (e) {
        return { status: 'IN_PROGRESS', progress: 'Waiting for ComfyUI' };
      }
      if (entry) {
        const fail = historyFailure(entry);
        if (fail) {
          untrack(meta.promptId);
          return fail.cancelled
            ? { status: 'CANCELLED' }
            : { status: 'FAILED', error: `ComfyUI: ${fail.message}` };
        }
        if (entry.status?.completed || entry.status?.status_str === 'success') {
          try {
            const output = await finish(id, entry, meta);
            untrack(meta.promptId);
            return { status: 'COMPLETED', output };
          } catch (error) {
            return { status: 'FAILED', error: error.message };
          }
        }
        return { status: 'IN_PROGRESS', progress: progressOf(meta.promptId) };
      }
      try {
        const queue = await api('/queue');
        const running = queue?.queue_running?.some(x => x[1] === meta.promptId);
        const index = queue?.queue_pending?.findIndex(x => x[1] === meta.promptId) ?? -1;
        if (running) return { status: 'IN_PROGRESS', progress: progressOf(meta.promptId) || 'Running in ComfyUI' };
        if (index >= 0) return { status: 'IN_PROGRESS', progress: `Queued · position ${index + 1}` };
      } catch {
        return { status: 'IN_PROGRESS', progress: 'Waiting for ComfyUI' };
      }
      // It left the queue without a history entry: give ComfyUI a moment, then call it lost (never resubmitted).
      if (Date.now() - meta.started < 20000) return { status: 'IN_PROGRESS', progress: 'Starting' };
      untrack(meta.promptId);
      return { status: 'LOST', error: 'ComfyUI no longer knows this song.' };
    },
    async cancel(job) {
      const id = job.remote?.id;
      const dir = folder(id);
      const meta = readJson(path.join(dir, 'engine.json'));
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'cancelled'), '1');
      if (meta?.promptId) {
        untrack(meta.promptId);
        // Rules: only a prompt that is actually running is interrupted (that stops whatever ComfyUI is doing),
        // a prompt still waiting is simply removed from the queue.
        let running = false;
        try {
          const queue = await api('/queue');
          running = !!queue?.queue_running?.some(item => item[1] === meta.promptId);
        } catch {
          running = false;
        }
        if (running)
          await fetchImpl(urlOf() + '/interrupt', { method: 'POST', signal: AbortSignal.timeout(5000) }).catch(
            () => {}
          );
        await fetchImpl(urlOf() + '/queue', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ delete: [meta.promptId] }),
          signal: AbortSignal.timeout(5000),
        }).catch(() => {});
      }
      return { status: 'CANCELLED' };
    },
    /** Copy the finished song into the library after checking both files against the saved receipt. */
    async collect(job, output, libraryDir, onProgress) {
      if (!Array.isArray(output.audio) || output.audio.length !== 2)
        throw new Error('ComfyUI did not produce both audio formats.');
      const dir = folder(job.remote?.id || job.id);
      const assets = {};
      const total = output.audio.reduce((sum, a) => sum + a.bytes, 0);
      let copied = 0;
      for (const asset of output.audio) {
        if (!['mp3', 'flac'].includes(asset.format) || !/^[a-f0-9]{64}$/.test(asset.sha256))
          throw new Error('Invalid audio metadata.');
        const name = `${job.id}.${asset.format}`;
        const target = path.join(libraryDir, 'audio', name);
        if (!fs.existsSync(target)) {
          const from = path.join(dir, `track.${asset.format}`);
          if (!fs.existsSync(from)) throw new Error('The ComfyUI audio copy is gone: generate the song again.');
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.copyFileSync(from, target + '.part');
          fs.renameSync(target + '.part', target);
        }
        const check = await describe(target);
        if (check.bytes !== asset.bytes || check.sha256 !== asset.sha256) {
          fs.rmSync(target, { force: true });
          throw new Error('The copied audio does not match the ComfyUI result.');
        }
        copied += asset.bytes;
        onProgress?.(copied, total);
        assets[asset.format] = name;
      }
      for (const name of ['track.flac', 'track.mp3']) fs.rmSync(path.join(dir, name), { force: true });
      return assets;
    },
  };
}
