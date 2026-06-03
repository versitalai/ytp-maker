# YTP Maker

A **100% browser-based**, DaVinci Resolve–styled video editor built for YouTube Poops (YTPs), memes, and remixes. No backend, no installs, no sign-up — open the page, drop a file (or paste a YouTube URL), and start chopping.

**[Open the live app](https://versitalai.github.io/ytp-maker/)** *(after the first deploy)*

---

## Features

**Auto Sentence Chopper** — AI detects words and silences in your source. Click any word to bake it to the timeline; rearrange the fragments into new sentences.

**Repeat / Loop / Stutter** — One-click buttons for: stutter, sentence loop, word loop, frame loop, infinite zoom. Stacks on top of the selected clip.

**Reverse Everything** — Reverse audio, reverse video, reverse only selected clips, or reverse every other word (visual stutter + audio flip).

**Mouth Warp** — Filter-chain face effects: talking-mouth stretch, eye distortion, liquid face. Real-time on the preview canvas.

**Meme Injector** — Built-in soundboard: Vine Boom, Metal Pipe, Gnome, Airhorn, Taco Bell, Bruh, Sus, Curb, Wheeze, Windows Error, Fart, Sax. Drag any sound onto the timeline.

**Captions** — Hit **C** to toggle captions. Words from the auto-detected transcript get burned onto the preview as Impact-style text.

**Collaboration** — Local clip library (IndexedDB) + a Remix Mode (open another user's exported project file, fork, modify, publish).

**Multi-track Timeline** — V2 / V1 / A1 / A2. Drag-drop from the source bin. Razor tool, magnetic snap, frame-step (←/→), in/out marks (I/O), 5s skip (J/L), play/pause (Space).

**Color Grading** — Exposure, contrast, gamma, saturation, hue-shift with a real pixel-level pass per frame.

**Audio Mixer** — Per-clip volume, pan, pitch shift. Master low-cut / high-cut EQ.

**Export** — One-click WebM export via `MediaRecorder` with the timeline rendered at full frame rate.

**Recording** — Mic / webcam / screen capture, all in-browser.

**Save / Load** — Project file (`.ytp.json`) with timeline + transcript baked in. Sources need to be re-attached on load (they're local files).

---

## Run locally

```bash
# Just open the file:
xdg-open "YTP Maker/index.html"

# Or serve it (recommended for CORS reasons on some browsers):
cd "YTP Maker"
python3 -m http.server 8765
# then open http://127.0.0.1:8765/
```

That's it. No `pip install`, no `npm install`, no API keys.

## Deploy

Drop the `YTP Maker/` folder on GitHub Pages, Netlify, Vercel, or any static host.

```bash
cd "YTP Maker"
git init && git add . && git commit -m "YTP Maker v1.0"
gh repo create ytp-maker --public --source=. --push --remote=origin
# then: gh repo edit --enable-pages --branch=main
```

## Keyboard shortcuts

| Key | Action |
|---|---|
| `Space` / `K` | Play / Pause |
| `J` / `L` | Rewind / Forward 5s |
| `←` / `→` | Frame step |
| `I` / `O` | Mark in / Mark out |
| `Ctrl+Z` / `Ctrl+Shift+Z` | Undo / Redo |
| `Ctrl+Y` | Redo |
| `Ctrl+S` | Save project |
| `Del` / `Backspace` | Delete selected clip |
| `C` | Toggle captions |

## How does it work without a backend?

- **Local files** — `URL.createObjectURL` on a `File` from `<input>` or drop event. The browser does the rest.
- **YouTube URLs** — A chain of 6 public **Piped** instances (open-source YouTube front-end APIs) is tried in order. Piped returns a CORS-enabled JSON payload with the direct stream URL. We `<video src>` that URL. If the chosen instance is CORS-strict, we fetch the stream into a Blob and use that.
- **Transcription** — Two strategies, in order:
  1. **Voice-Activity-Detection (VAD)** — Decode the audio buffer with the Web Audio API, scan RMS amplitude over time, split on silence gaps. Always works, zero dependencies. Word "text" is synthetic (chunk 0, chunk 1, …) since there's no ASR.
  2. **Web Speech API** — If the browser is Chromium-based, real transcript with word timing is captured as the media plays. This is what's shown in the captions when you toggle **C**.
- **Effects (stutter / loop / reverse / zoom / warp)** — Pure JavaScript on the preview canvas. The timeline clips store a list of `fx` objects; `ytp.js` resolves the current frame from those.
- **Export** — `MediaRecorder` on a `canvas.captureStream()` mixed with a `MediaStreamDestination` for the audio mixer. Output: WebM.

## Limitations

- YouTube fetching depends on the public Piped instances staying up. If all 6 fail, you can manually grab a stream URL from a YouTube mirror and drop the file in. We're keeping an eye on `piped-instances.kavin.rocks` as the most reliable.
- Web Speech API only exists in Chromium browsers. Firefox/Safari will fall back to VAD chunks.
- Export is browser-limited: Firefox and Safari don't support all the same codecs. WebM with VP9 + Opus is the safest bet.
- Recordings are stored in browser memory only; refresh = gone (use Save → Project File to persist).

## Stack

- **Frontend** — vanilla JavaScript (ES modules), HTML5 Canvas, Web Audio API, MediaRecorder, File System Access API, Web Speech API, Service Worker
- **No build step** — open the file and it runs
- **No frameworks** — custom observable state store in 100 lines
- **Total LOC** — ~3,500 lines of code

## License

MIT — do whatever you want with it.

---

# Original spec (preserved for posterity)

Auto Sentence Chopper
Upload a video.
AI automatically detects sentences, words, and phonemes.
Click words to rearrange them into new sentences.

Example:

"I am going to the store."

becomes

"Store. Store. Store. I am the store."

Repeat Generator

One-click:

Stutter
Sentence looping
Word looping
Frame looping
Infinite zoom

Common YTP effects become instant buttons.

Reverse Everything

Quick toggles:

Reverse audio
Reverse video
Reverse only selected clips
Reverse every other word

Meme Injector

Search:

Vine boom
Metal pipe
Gnome
Airhorn
Taco Bell bong

Drag directly onto timeline.

Mouth Warp

Effects:

Talking mouth stretches
Eye distortions
Liquid face effects

Classic YTP energy.

Collaboration Features
Community Clip Library

Users upload:

Source clips
Sound effects
Green screens

Searchable by:

Character
Meme
Phrase

Remix Mode

Open another user's YTP project and:

Fork it
Modify it
Publish your version

Like GitHub for YTPs.
