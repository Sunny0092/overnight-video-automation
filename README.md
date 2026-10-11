# Overnight videos from prompts

Give the automation a video prompt. Gemini writes a custom JavaScript animation, the JavaScript draws the frames, and FFmpeg exports a finished H.264 MP4. GitHub Actions runs the work on GitHub's computer, so your computer can be off.

There is no Remotion dependency. Each video gets its own JavaScript, rather than being forced into a slideshow template.

## One-time setup

1. Finish GitHub signup in the browser and choose **GitHub Free**. Enter your password and verification codes directly on GitHub.
2. Create a repository named `overnight-video-automation`. A public repository has free standard GitHub-hosted runner time; its code and committed prompts are visible to everyone. A private repository uses your account's included monthly minutes.
3. Upload this folder's source files to the repository root. Include the hidden `.github/workflows/render.yml` file; without it, the Actions tab will not contain this workflow. Do not upload `node_modules`, `.env`, generated videos, or API keys.
4. Create a free Gemini API project and key in [Google AI Studio](https://aistudio.google.com/api-keys). Keep the project on **Free Tier** and do not link billing. The default text model is `gemini-3.8-flash`. It writes code; it does not call a paid video-generation service.
5. In the repository, open **Settings → Secrets and variables → Actions → New repository secret**. Name it `GEMINI_API_KEY`, paste the key, and save. Keep the key out of prompts, code, screenshots, and commit messages.
6. Open **Actions → Overnight video render → Run workflow**. Run the included example first, or enter a video prompt in the manual prompt field. Download the video artifact after the run succeeds.

The schedule is **1:37 AM India time every day**. The workflow uses 20:07 UTC, which is 1:37 AM IST on the following calendar day. It must be on the repository's default branch. GitHub can delay scheduled runs; public schedules are disabled after 60 days without repository activity. The manual Run workflow button remains available.

The included `ai-demo` prompt creates a new variation each night. The authored `demo` is rendered once. Replace the sample prompt with your own creative brief when you are ready.

Account verification and the first API connection require the account owner. After setup, code generation and MP4 rendering happen automatically. You still supply the creative prompts, either through the workflow's prompt field or through saved jobs.

## Give it a prompt

Use **Run workflow → prompt** for an immediate video. For example:

> Make a 15-second animated explainer about compound growth. Use a dark navy background, turquoise curves, large readable text, and three clear beats: start small, stay consistent, watch it grow. Animate the graph smoothly. No external images. End with “Small steps. Big results.”

The dimensions, duration, and frame rate in the job settings determine the export. To queue a video for the overnight run, save a JSON job in `jobs/` with an ID and prompt, and omit `code`:

```json
{
  "id": "compound-growth",
  "enabled": true,
  "prompt": "Make a 15-second animated explainer about compound growth, with navy and turquoise colors and a smoothly animated graph.",
  "width": 1280,
  "height": 720,
  "fps": 24,
  "duration": 15
}
```

For vertical video, use `width: 1080` and `height: 1920`. For a fresh version of the same prompt each night, add `"repeat": "daily"`. Ordinary jobs are rendered once and are skipped while their content remains unchanged. Disable a saved job with `"enabled": false`. The workflow processes up to three pending jobs per run to bound compute and storage use.

You can also give Codex a prompt and ask it to save a queued job through GitHub. You do not need to write JavaScript yourself.

## What you download

The Actions artifact contains the MP4, a PNG poster, a render manifest, a queue report, and the custom code used for generated videos. Artifacts are retained for **one day**; download them the next morning. MP4s use H.264 and `yuv420p` with fast-start metadata for common players and social platforms.

This pipeline can draw typography, charts, animated shapes, illustrations, and compositions using local image assets. Local audio can be mixed into the export. Without an audio asset, the video is silent. It does not create photorealistic footage, narrations, or licensed music by itself.

## Custom JavaScript contract

A hand-written or AI-authored `.mjs` module can be committed and referenced by a job's `code` field. It must export:

```js
export function render(ctx, { time, width, height, progress }) {
  ctx.fillStyle = '#08111f';
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = '#58e0c5';
  ctx.font = 'bold 64px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('Your idea, in motion', width / 2, height / 2);
}
```

`ctx` is a Canvas 2D context. The frame information includes `t` and `time` in seconds, `frame`, `fps`, `duration`, `progress`, `width`, `height`, `prompt`, and prepared assets. An optional asynchronous `prepare` export can load local assets once. See `examples/demo.mjs` and the renderer source for the exact interface.

Generated code is syntax-checked before use. Its execution takes place in a separate container with no network, no API credentials, read-only source files, and limits on memory, process count, and runtime. The AI credential is available only to the code-generation process. Generation or rendering failures appear in the Actions report; a failed run is not presented as a finished video.

If generated code fails during rendering, the automation sends the error back to the AI and attempts one repair. It stops after that attempt if the scene still fails.

## Free limits and costs

GitHub currently provides free standard hosted runner time for public repositories. GitHub Free includes **2,000 private-repository minutes per month** and **500 MB of artifact storage**. Storage is shared with other relevant account usage, so download promptly and keep retention short. No larger paid runners are configured here.

Gemini's free tier has project-specific rate limits and availability. Free-tier prompts and responses may be used to improve Google's products. Keep the Google project on Free Tier. This code cannot determine whether the key belongs to a billed project, and never switches to a paid model if a request is rejected.

GitHub Actions scheduling is a best-effort service. A render can fail because of an account restriction, exhausted quota, a model error, an invalid prompt-generated program, or a missing asset. Check the run status when downloading.

Official references checked October 11, 2026:

- [GitHub Actions billing](https://docs.github.com/en/billing/concepts/product-billing/github-actions)
- [GitHub Actions limits](https://docs.github.com/en/actions/reference/limits)
- [Scheduling events and inactivity](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
- [Gemini free pricing](https://ai.google.dev/gemini-api/docs/pricing)
- [Gemini quotas](https://ai.google.dev/gemini-api/docs/rate-limits)
- [Gemini API keys](https://ai.google.dev/gemini-api/docs/api-key)
- [Gemini current API quickstart](https://ai.google.dev/gemini-api/docs/get-started)
- [GitHub Models retirement](https://docs.github.com/en/github-models)
