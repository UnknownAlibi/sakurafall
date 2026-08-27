const { execSync } = require('child_process');
const PORT = 5173;

try {
  const output = execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8', windowsHide: true });
  const lines = output.trim().split('\n');
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (pid && pid !== '0') {
      try {
        execSync(`taskkill /PID ${pid} /F`, { windowsHide: true });
        console.log(`Killed PID ${pid} on port ${PORT}`);
      } catch {}
    }
  }
} catch {}

console.log(`Port ${PORT} cleared`);
