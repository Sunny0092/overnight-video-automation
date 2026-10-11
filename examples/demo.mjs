// Replace this entire module with custom AI-written JavaScript for each prompt.
// The only required export is render(ctx, frameInfo). No browser or Remotion.
const colors = { navy: '#081326', white: '#f5f2eb', muted: '#a6b4cb', coral: '#ff816c', mint: '#7cdbc2', blue: '#7198ff' };
const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => 1 - (1 - clamp(value)) ** 3;

function text(ctx, content, x, y, size, color = colors.white, weight = 600) {
  ctx.font = `${weight} ${size}px "DejaVu Sans", Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.fillText(content, x, y);
}
function pill(ctx, label, x, y, width, active) {
  ctx.fillStyle = active ? colors.coral : '#182842';
  ctx.beginPath(); ctx.roundRect(x, y, width, 66, 18); ctx.fill();
  text(ctx, label, x + 24, y + 44, 23, active ? colors.navy : colors.white);
}
function drawIntro(ctx, t) {
  const reveal = ease(t / 1.1);
  ctx.globalAlpha = reveal;
  text(ctx, 'YOUR IDEA. YOUR VIDEO.', 88, 145, 18, colors.coral);
  text(ctx, 'Words become', 88, 280 - 28 * (1 - reveal), 76);
  text(ctx, 'moving pictures.', 88, 371 - 28 * (1 - reveal), 76);
  text(ctx, 'Custom JavaScript + FFmpeg', 92, 442, 28, colors.muted, 400);
  pill(ctx, '1  PROMPT', 88, 530, 225, t > 0.5);
  pill(ctx, '2  CODE', 340, 530, 215, t > 1.4);
  pill(ctx, '3  MP4', 583, 530, 210, t > 2.3);
  ctx.globalAlpha = 1;
}
function drawChart(ctx, t) {
  text(ctx, 'BUILD THE MOTION', 88, 135, 18, colors.coral);
  text(ctx, 'Make every frame yours.', 88, 220, 55);
  text(ctx, 'A chart drawn and animated directly in JavaScript', 91, 268, 23, colors.muted, 400);
  const values = [0.35, 0.65, 0.92];
  const labels = ['INTRO', 'SCENE', 'FINALE'];
  const fills = [colors.blue, colors.mint, colors.coral];
  const baseY = 590;
  ctx.strokeStyle = '#30405c'; ctx.lineWidth = 2;
  for (let i = 0; i <= 3; i++) {
    const y = baseY - i * 84;
    ctx.beginPath(); ctx.moveTo(91, y); ctx.lineTo(1190, y); ctx.stroke();
  }
  values.forEach((value, i) => {
    const animated = ease((t - 0.5 - i * 0.25) / 1.45);
    const height = value * 255 * animated;
    const x = 195 + i * 320;
    ctx.fillStyle = fills[i];
    ctx.beginPath(); ctx.roundRect(x, baseY - height, 180, height, [14, 14, 0, 0]); ctx.fill();
    text(ctx, `${Math.round(value * 100 * animated)}%`, x + 27, baseY - height - 19, 31, fills[i]);
    text(ctx, labels[i], x + 29, 635, 19, colors.muted);
  });
}
function drawFinal(ctx, t) {
  const reveal = ease(t / 0.8);
  ctx.globalAlpha = reveal;
  ctx.fillStyle = '#142a35'; ctx.beginPath(); ctx.arc(640, 218, 62, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = colors.mint; ctx.lineWidth = 9; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(615, 218); ctx.lineTo(635, 238); ctx.lineTo(672, 195); ctx.stroke();
  ctx.textAlign = 'center';
  text(ctx, 'Finished MP4', 640, 363 + 18 * (1 - reveal), 76);
  text(ctx, 'Ready when you wake up.', 640, 425, 28, colors.muted, 400);
  text(ctx, '1080p capable  /  H.264  /  Original canvas graphics', 640, 510, 20, colors.mint, 400);
  ctx.textAlign = 'left'; ctx.globalAlpha = 1;
}

export function render(ctx, { width, height, t, duration, progress }) {
  ctx.fillStyle = colors.navy; ctx.fillRect(0, 0, width, height);
  ctx.save(); ctx.scale(width / 1280, height / 720);
  const glow = ctx.createRadialGradient(1120 + 30 * Math.sin(t), 190, 0, 1120, 190, 540);
  glow.addColorStop(0, '#223c6044'); glow.addColorStop(1, '#08132600');
  ctx.fillStyle = glow; ctx.fillRect(0, 0, 1280, 720);
  // Timings scale with any job duration, so a short smoke test still contains
  // all three scenes and the same visual rhythm.
  const clock = t / duration * 12;
  if (clock < 4) drawIntro(ctx, clock);
  else if (clock < 9) drawChart(ctx, clock - 4);
  else drawFinal(ctx, clock - 9);
  ctx.fillStyle = '#223149'; ctx.fillRect(88, 683, 1104, 3);
  ctx.fillStyle = colors.coral; ctx.fillRect(88, 683, 1104 * progress, 3);
  const boundaryDistance = Math.min(Math.abs(clock - 4), Math.abs(clock - 9));
  if (boundaryDistance < 0.18) {
    ctx.fillStyle = colors.navy; ctx.globalAlpha = 1 - boundaryDistance / 0.18;
    ctx.fillRect(0, 0, 1280, 680);
  }
  ctx.restore();
}
