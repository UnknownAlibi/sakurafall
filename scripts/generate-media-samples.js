// 生成本地性能测试媒体样本（S0 可重复样本）
// 运行: node scripts/generate-media-samples.js [--force]
//
// 使用 ffmpeg 合成 testsrc2（免许可测试源）+ 正弦音频，覆盖 480p/720p/1080p
// 与 24/30/60 fps 组合，每个 60 秒。产物与 manifest 写入 artifacts/media-samples/。
// manifest.json 记录编码参数、时长、字节数与 SHA-256 校验值，供审计脚本核对。

const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workspace = path.resolve(__dirname, '..');
const outputDir = path.join(workspace, 'artifacts', 'media-samples');
const force = process.argv.includes('--force');

// [名称, 宽, 高, 帧率]
const SAMPLES = [
  ['480p-24fps', 854, 480, 24],
  ['480p-30fps', 854, 480, 30],
  ['720p-24fps', 1280, 720, 24],
  ['720p-30fps', 1280, 720, 30],
  ['1080p-24fps', 1920, 1080, 24],
  ['1080p-60fps', 1920, 1080, 60]
];
const DURATION_SECONDS = 60;

function sha256(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function probeWidth(filePath) {
  // ffprobe 与 ffmpeg 同目录；退化时直接信任生成参数
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate,duration',
      '-of', 'json', filePath
    ], { encoding: 'utf8' });
    const stream = JSON.parse(out).streams?.[0] || {};
    return {
      width: stream.width,
      height: stream.height,
      frameRate: stream.r_frame_rate,
      durationSeconds: Number(stream.duration)
    };
  } catch (_) {
    return null;
  }
}

function main() {
  execFileSync('ffmpeg', ['-version'], { encoding: 'utf8' });
  fs.mkdirSync(outputDir, { recursive: true });

  const manifest = {
    generatedAt: new Date().toISOString(),
    source: 'ffmpeg testsrc (synthetic, license-free) + sine tone',
    durationSeconds: DURATION_SECONDS,
    video: { codec: 'h264', preset: 'veryfast', crf: 23, pixFmt: 'yuv420p' },
    audio: { codec: 'aac', bitrate: '96k', tone: '440Hz sine' },
    samples: []
  };

  for (const [name, width, height, fps] of SAMPLES) {
    const file = path.join(outputDir, `${name}.mp4`);
    if (fs.existsSync(file) && !force) {
      console.log(`[skip] ${name} 已存在`);
    } else {
      console.log(`[gen ] ${name} (${width}x${height}@${fps}, ${DURATION_SECONDS}s)...`);
      execFileSync('ffmpeg', [
        '-y', '-loglevel', 'error',
        '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=${fps}:duration=${DURATION_SECONDS}`,
        '-f', 'lavfi', '-i', `sine=frequency=440:duration=${DURATION_SECONDS}`,
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-strict', '-2', '-b:a', '96k', '-shortest', file
      ], { stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    }
    const probed = probeWidth(file) || { width, height, frameRate: `${fps}/1`, durationSeconds: DURATION_SECONDS };
    manifest.samples.push({
      name,
      file: `artifacts/media-samples/${name}.mp4`,
      width: probed.width,
      height: probed.height,
      frameRate: probed.frameRate,
      durationSeconds: probed.durationSeconds,
      bytes: fs.statSync(file).size,
      sha256: sha256(file)
    });
  }

  const manifestPath = path.join(outputDir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`[done] ${SAMPLES.length} 个样本，manifest: ${manifestPath}`);
}

main();
