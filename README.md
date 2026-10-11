# Overnight videos from prompts left in chat

Give ChatGPT/Codex your video prompt in this chat at any time. Daytime messages only queue the creative brief. At **1:37 AM India time**, the scheduled task returns to the same chat, writes custom JavaScript, tests the animation, and saves the source and job in this repository. It then triggers GitHub Actions to render the MP4 with Canvas and FFmpeg, downloads the result, verifies it, and saves a permanent local copy for you.

There is no Remotion dependency. Codex writes the scene during the overnight scheduled chat turn; the GitHub workflow renders saved JavaScript only and does not call Gemini or an OpenAI API. The computer must stay awake and online with Codex and its authenticated browser connection running for overnight coding, GitHub access, and downloading. GitHub runs the rendering on its own runner.

## Request a video

Tell ChatGPT/Codex what you want. You do not need to write or copy code yourself. For example:

> Write and queue a 15-second vertical video explaining how compound growth works. Use a dark navy background, turquoise curves, English text, and three clear scenes. End with Small steps. Big results. No audio or external images.

Useful details are the topic, language, duration, horizontal or vertical format, visual style, exact text, and any supplied assets. Sensible defaults can fill in missing details.

ChatGPT/Codex saves the prompt in a private local queue outside this public repository. It does not write or render the scene during daytime submission. At night it creates a custom `.mjs` scene and matching JSON job with a `code` path. The example job `demo` illustrates the interface. The earlier Gemini sample `ai-demo` is disabled.

## Run and download

The Codex task **Create queued videos overnight** starts at **1:37 AM IST every day** in the original chat. It processes up to three pending prompts, publishes verified scenes, and dispatches this workflow after the code is ready. If a delayed wake occurs during the day, requests stay queued for the next night. An empty queue does not create example videos.

The independent GitHub timer was removed to keep coding before rendering. Successful jobs are skipped while unchanged, and interrupted requests resume their recorded render run rather than dispatching duplicates. The user does not need to trigger the workflow manually.

To render a saved job immediately, open **Actions → Overnight video render → Run workflow**. Leave **job** blank to process pending jobs, or choose its saved ID. Select **force** to render again even when unchanged.

The scheduled task downloads each completed **finished-videos** artifact, verifies the MP4, and saves it under the chat workspace's `outputs/videos/<request-id>` folder. It reports clickable finished video links in the chat. GitHub artifacts contain MP4s, PNG posters, render manifests, and a queue report and expire after **one day**; saved local copies do not expire. You can also download artifacts manually from a completed run. MP4s use H.264, `yuv420p`, and fast-start metadata.

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

Public standard GitHub-hosted runners have free compute; published scene code and job prompts are public. No paid runner or AI API was configured for the active workflow. The scheduled coding task uses the user's existing Codex allowance and requires this computer and app to remain available. Storage, account usage, scheduling, and access limits still apply. A task that cannot access the account preserves the queue and reports the actual blocker.

The original Gemini generator remains in the source as an optional legacy mode, but the active workflow explicitly uses `VIDEO_CODE_MODE: authored`, has no prompt input, and does not pass the Gemini key. Its API secret is unnecessary for this mode. Never put API keys or sensitive material in public prompts or source files.

Official references: [OpenAI scheduled tasks and computer requirements](https://learn.chatgpt.com/docs/automations), [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions), [OpenAI code generation](https://developers.openai.com/api/docs/guides/code-generation).
