// Stands in for ffmpeg and ffprobe in unit tests. FAKE_MODE selects the behaviour.
import { spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { setInterval } from "node:timers";

const mode = process.env.FAKE_MODE ?? "ok";
const args = process.argv.slice(2);
const wait = () => setInterval(() => {}, 1000);

if (mode === "ok") {
  process.stderr.write(JSON.stringify(args));
} else if (mode === "fail") {
  process.stderr.write("boom: no such file");
  process.exitCode = 3;
} else if (mode === "echo") {
  process.stdin.pipe(process.stdout);
} else if (mode === "noisy") {
  process.stderr.write("a".repeat(5000) + "THE-END");
} else if (mode === "hang") {
  wait();
} else if (mode === "progress") {
  writeSync(3, "frame=1\nfps=N/A\nout_time_us=-5\nprogress=conti");
  writeSync(3, "nue\nframe=2\nfps=29.97\ntotal_size=100\nspeed=1.5x\nprogress=end\n");
} else if (mode === "progress-hang") {
  writeSync(3, "frame=1\nprogress=continue\n");
  wait();
} else if (mode === "orphan") {
  // Exit at once, leaving a grandchild that holds stderr (and fd 3, when there is one) open.
  const fd3 = args.includes("pipe:3") ? [3] : [];
  const grandchild = spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "inherit", ...fd3],
  });
  grandchild.unref();
  process.stderr.write(String(grandchild.pid));
} else if (mode === "probe") {
  process.stdout.write(
    JSON.stringify({
      format: { duration: "2.500000", bit_rate: "1000", probe_score: 100 },
      streams: [
        { index: 0, codec_type: "audio", codec_name: "aac", channels: 2 },
        { index: 1, codec_type: "video", codec_name: "h264", width: 320, height: 240, avg_frame_rate: "30000/1001" },
      ],
      args,
    }),
  );
} else if (mode === "garbage") {
  process.stdout.write("not json");
}
