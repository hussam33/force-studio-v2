# Force Studio v2

A local music studio for **YuE2** running inside **ComfyUI**. It keeps the Sonora Studio interface — Create,
Remix, library, editor, mixer, stems, Audio Lab — and replaces the music engine with ComfyUI's native YuE2
nodes. Two ComfyUI workflows drive everything:

| Workflow | ComfyUI template | What it does here |
| --- | --- | --- |
| **YuE2 · Text to Music** | `audio_yue2_text2music.json` | Writes the melody and chords (the ABC plan), then sings the lyrics |
| **YuE2 · Music Cover** | `audio_yue2_music_cover.json` | Transcribes an uploaded song with SheetSage2, then sings it again with YuE2 |

Both files live in `workflows/` and are installed (opened) in ComfyUI at every start, next to your own
workflows.

## Opening the app

1. `ForceStudioV2.exe` unpacks itself once per build in `%LOCALAPPDATA%\ForceStudioV2\app` and starts the
   studio server (local only, `127.0.0.1:3210`).
2. It looks for ComfyUI — ComfyUI Desktop, the portable build, or a `ComfyUI` folder with a `.venv` — and
   **starts it in the background** if it is not already running.
3. When ComfyUI answers, it **opens the two YuE2 workflows in ComfyUI's workflow list**.
4. The studio window opens on **Create**, already set to YuE2.

Songs and settings live in `%LOCALAPPDATA%\ForceStudioV2\data` and survive updates. `ForceStudioV2.exe --stop`
closes the studio. On the first run of this name, the library of the previous folder (`SonoraYuE2Studio`) is
copied over automatically.

## Requirements

- **Windows 10/11 64-bit** or **Linux x64**, and an NVIDIA graphics card (about 8 GB of memory for the
  int8 3B model).
- **ComfyUI** with the YuE2 nodes: `YuE2 Generate ABC`, `YuE2 Generate Music`, `Empty YuE2 Latent Audio`,
  `SheetSage2 Audio to ABC`.
- **Models** in ComfyUI:
  - `yue2_3b_int8_convrot.safetensors` in `models/checkpoints`
  - `sheetsage2_bf16.safetensors` in `models/audio_encoders` (Music Cover)
- **FFmpeg** on `PATH`.

If ComfyUI is already running, the app reuses it and only installs the workflows. To point the app at a
specific install, add a `config.json` next to the app:

```json
{
  "port": 3210,
  "comfyUrl": "http://127.0.0.1:8188",
  "yue2": {
    "engine": "comfy",
    "comfy": {
      "autoStart": true,
      "start": { "command": "C:\\path\\to\\ComfyUI\\ComfyUI.exe", "args": [] },
      "checkpoint": "yue2_3b_int8_convrot.safetensors",
      "audioEncoder": "sheetsage2_bf16.safetensors",
      "steps": 32
    }
  }
}
```

## Building

Both builds use tools that ship with Windows — the C# compiler and Node.js. No npm packages.

```powershell
# Portable folder: app files + verified Node.js runtime + ForceStudioV2.exe
node scripts/make-portable.mjs

# Single file EXE: the same folder packed into one ForceStudioV2.exe (~36 MB)
node scripts/make-single-exe.mjs

# Linux x64: folder + verified Node.js + `force-studio` launcher, packed as a .tar.gz
node scripts/make-linux.mjs
```

The EXE is unsigned, so Windows asks for confirmation the first time (*More info → Run anyway*).

## Linux

The Linux build is the same studio, packaged with a launcher instead of an EXE:

```bash
tar -xzf Force-Studio-v2-2.0.0-linux-x64.tar.gz
cd Force-Studio-v2-2.0.0-linux-x64
chmod +x force-studio
./force-studio              # starts the studio and opens your browser
FORCE_STUDIO_NO_OPEN=1 ./force-studio   # server only
./force-studio stop         # stops it
./force-studio log          # tail of the log
```

- Songs and settings live in `~/.local/share/ForceStudioV2/data` (override with `FORCE_STUDIO_DATA_DIR`);
  the log is `force-studio.log` there.
- Node.js 22 is bundled in `runtime/node/`; you do not need it on the system.
- **ComfyUI discovery** checks `~/ComfyUI`, `~/comfyui`, `~/Documents/ComfyUI`, `~/.local/share/ComfyUI`,
  `/opt/ComfyUI`, `/usr/local/ComfyUI` and a `ComfyUI/` folder next to the app, using `.venv/bin/python3`,
  `venv/bin/python3` or a system `python3`. If yours lives elsewhere, set it in `config.json`
  (`yue2.comfy.start.command` = the python, `args` = `["-s","main.py"]`, `cwd` = the ComfyUI folder).
- **Desktop icon**: run `./install-desktop-icon.sh`; it writes a `.desktop` entry pointing at this folder
  into `~/.local/share/applications/`.
- **FFmpeg** is not bundled: `sudo apt install ffmpeg` (Debian/Ubuntu) or your distribution's package.

`node scripts/make-linux.mjs` works from Windows too (Windows' `tar` handles the `.xz` Node archive), so the
tarball can be produced on either system.

## How the engine works

`comfy-yue2.mjs` implements the same interface as the studio's other YuE2 backends (`call`, `submitAction`,
`status`, `cancel`, `collect`), so the queue, progress, library and covers are unchanged. For each song it
builds a ComfyUI API graph equivalent to the official template:

```
CheckpointLoaderSimple → [YuE2GenerateABC] → YuE2GenerateMusic → KSampler → VAEDecodeAudio
                                                                        → SaveAudio     (FLAC)
                                                                        → SaveAudioMP3  (MP3)
```

- **Plan** maps to `yueCot`: *Melody and chords* → ABC `mode: full`, *Melody only* → `melody`, *No plan* →
  empty ABC (the model sings directly).
- An edited plan or a cover transcription is passed to the graph verbatim.
- **Remix** on any library song (including uploads) becomes a cover: the melody of the chosen excerpt is
  transcribed with SheetSage2 and sung again with the new style and words. Changing a single section (Edit) is
  not possible with YuE2 and says so.
- Progress comes from ComfyUI's websocket, so the studio shows *Composing the song · 62%* and
  *Generating audio · 40%*.
- Audio is copied into the library only after its size and SHA-256 match the receipt.

`comfy-launcher.mjs` starts ComfyUI and installs the workflows through ComfyUI's `/userdata` API, falling back
to the `user/default/workflows` folder.

## Project layout

| Path | What it is |
| --- | --- |
| `server.mjs` | The studio server: library, queue, editor, stems, Audio Lab, API |
| `comfy-yue2.mjs` | The YuE2 engine on ComfyUI (graphs, jobs, downloads) |
| `comfy-launcher.mjs` | Finds/starts ComfyUI and installs the two workflows |
| `public/` | The interface (same as Sonora's, rebranded) |
| `workflows/` | The two official YuE2 ComfyUI templates |
| `packaging/launcher/Boot.cs` | The single-file EXE bootstrapper |
| `scripts/make-portable.mjs`, `scripts/make-single-exe.mjs` | The two builds |

Environment: `FORCE_STUDIO_DATA_DIR` (data folder), `FORCE_STUDIO_CONFIG` (config file). The local API
requires the `X-Force-Studio: 1` header on mutations.

## Credits and licence

The interface and the studio backend come from [Sonora Studio](https://github.com/barbarabax/sonora-studio)
(MIT, see `LICENSE`). YuE2, SheetSage2 and the ComfyUI templates belong to their authors and keep their own
licences; this app only runs them locally. The two workflow files are the official templates from
[Comfy-Org/workflow_templates](https://github.com/Comfy-Org/workflow_templates).
