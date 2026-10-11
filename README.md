# Overnight videos with code written in chat

Give ChatGPT/Codex your video prompt in this chat. It writes custom JavaScript, tests the animation, and saves the source and job in this repository. GitHub Actions then renders pending jobs at **1:37 AM India time**, using Canvas and FFmpeg to export H.264 MP4 files. Your computer can be off during the GitHub render.

There is no Remotion dependency. The active workflow renders saved JavaScript only. It does not call Gemini or an OpenAI API. ChatGPT writes new code when you send a prompt here; it does not automatically write new code inside the overnight GitHub job.

## Request a video

Tell ChatGPT/Codex what you want. You do not need to write or copy code yourself. For example:

> Write and queue a 15-second vertical video explaining how compound growth works. Use a dark navy background, turquoise curves, English text, and three clear scenes. End with Small steps. Big results. No audio or external images.

Useful details are the topic, language, duration, horizontal or vertical format, visual style, exact text, and any supplied assets. Sensible defaults can fill in missing details.

ChatGPT/Codex saves a custom `.mjs` scene and a matching JSON job with a `code` path. Code generation, testing, and saving take place in the chat before the overnight render. The example job `demo` illustrates the interface. The earlier Gemini sample `ai-demo` is disabled.

## Run and download

The schedule is **1:37 AM IST every day** (20:07 UTC on the previous day). It checks the repository for new or changed jobs. Successful jobs are skipped while unchanged, so the same video is not needlessly rendered every night.

To render a saved job immediately, open **Actions → Overnight video render → Run workflow**. Leave **job** blank to process pending jobs, or choose its saved ID. Select **force** to render again even when unchanged.

Open a completed run and download its **finished-videos** artifact. Artifacts contain MP4s, PNG posters, render manifests, and a queue report. They expire after **one day**; download videos you want to keep. MP4s use H.264, `yuv420p`, and fast-start metadata.

## Saved job format

```json
{
  "id": "compound-growth",
  "enabled": true,
  "prompt": "A 15-second animated explainer about compound growth.",
  "code": "scenes/compound-growth.mjs",
  "width": 1080,
  "height": 1920,
  "fps": 24,
  "duration": 15
}
```

The `prompt` records the creative brief. The active workflow requires an existing `code` file. It rejects enabled prompt-only jobs rather than silently sending them to another AI. Ordinary jobs render once; adding `"repeat": "daily"` rerenders the saved scene daily, without generating new code. Disable a job with `"enabled": false`.

A scene exports `render(ctx, frameInfo)`. `ctx` is a Canvas 2D context; frame fields include `t`, `time`, `frame`, `fps`, `duration`, `progress`, `width`, `height`, `prompt`, and prepared assets. An optional asynchronous `prepare` export loads local assets once. See `examples/demo.mjs`.

Typography, animated shapes, charts, original illustrations, and declared local image assets are supported. Local audio can be included. Without an audio asset the video is silent. Photorealistic footage, narration, and licensed music are not created automatically by this renderer.

## Isolation and limits

Saved scene code executes in a Docker container with no network, no API credentials, read-only source and root filesystem, and limits on memory, process count, and runtime. The workflow processes at most three pending jobs per run with a seven-minute budget per job. Rendering failures appear in the Actions report.

Public standard GitHub-hosted runners have free compute; the repository's code and saved prompts are public. No paid runner or AI API was configured for the active render-only workflow. Storage limits still apply. GitHub scheduling can be delayed or skipped under load, and public schedules can be disabled after 60 days without repository activity. A new saved video job constitutes repository activity.

The original Gemini generator remains in the source as an optional legacy mode, but the active workflow explicitly uses `VIDEO_CODE_MODE: authored`, has no prompt input, and does not pass the Gemini key. Its API secret is unnecessary for this mode. Never put API keys or sensitive material in public prompts or source files.

Official references: [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [schedule behavior](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule), [OpenAI code generation](https://developers.openai.com/api/docs/guides/code-generation).
