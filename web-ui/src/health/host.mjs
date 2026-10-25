// Host metrics from /proc, cgroup v2 and df.
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { cpus, freemem, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let previousCpuSample = null;
let previousCodexServiceCpuSample = null;

function cpuSample() {
  const cores = cpus();
  const total = cores.reduce((sum, core) => sum + Object.values(core.times).reduce((a, b) => a + b, 0), 0);
  const idle = cores.reduce((sum, core) => sum + core.times.idle, 0);
  const current = { total, idle };
  let percent = 0;
  if (previousCpuSample) {
    const totalDelta = total - previousCpuSample.total;
    const idleDelta = idle - previousCpuSample.idle;
    if (totalDelta > 0) percent = Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
  }
  previousCpuSample = current;
  return { cores: cores.length, percent: Math.round(percent * 10) / 10 };
}

export async function readHostHealth() {
  const cgroupText = await readFile('/proc/self/cgroup', 'utf8').catch(() => '');
  const cgroupRelative = cgroupText.match(/^0::\/(.+)$/m)?.[1];
  const cgroupDir = cgroupRelative && !cgroupRelative.split('/').includes('..') && /^[A-Za-z0-9_./-]+$/.test(cgroupRelative)
    ? join('/sys/fs/cgroup', cgroupRelative)
    : null;
  const [memInfo, diskResult, serviceMemory, serviceMemoryMax, serviceCpuStat] = await Promise.all([
    readFile('/proc/meminfo', 'utf8'),
    execFileAsync('df', ['-B1', '--output=size,used,avail,pcent', '/'], { timeout: 5000, maxBuffer: 16 * 1024 }),
    cgroupDir ? readFile(join(cgroupDir, 'memory.current'), 'utf8').catch(() => '0') : '0',
    cgroupDir ? readFile(join(cgroupDir, 'memory.max'), 'utf8').catch(() => 'max') : 'max',
    cgroupDir ? readFile(join(cgroupDir, 'cpu.stat'), 'utf8').catch(() => '') : '',
  ]);
  const mem = Object.fromEntries(memInfo.split('\n').map((line) => {
    const match = line.match(/^([A-Za-z_()]+):\s+(\d+)\s+kB$/);
    return match ? [match[1], Number(match[2]) * 1024] : [];
  }).filter((entry) => entry.length));
  const diskLines = diskResult.stdout.trim().split('\n');
  const disk = diskLines.length > 1 ? diskLines.at(-1).trim().split(/\s+/) : [];
  const cpu = cpuSample();
  const serviceCpuUsec = Number(serviceCpuStat.match(/^usage_usec\s+(\d+)$/m)?.[1]) || 0;
  const now = Date.now();
  const serviceCpuPercent = previousCodexServiceCpuSample && serviceCpuUsec >= previousCodexServiceCpuSample.usec
    ? Math.max(0, Math.min(100, ((serviceCpuUsec - previousCodexServiceCpuSample.usec) / 1000 / (now - previousCodexServiceCpuSample.at)) / Math.max(1, cpus().length) * 100))
    : 0;
  previousCodexServiceCpuSample = { usec: serviceCpuUsec, at: now };
  const memoryTotal = mem.MemTotal || totalmem();
  const memoryAvailable = mem.MemAvailable || freemem();
  return {
    cpu,
    load1m: Number((await readFile('/proc/loadavg', 'utf8')).split(' ')[0]) || 0,
    memory: { totalBytes: memoryTotal, usedBytes: Math.max(0, memoryTotal - memoryAvailable), availableBytes: memoryAvailable },
    services: [{ name: 'Interface Codex', status: 'Em execução · systemd', cpuPercent: Math.round(serviceCpuPercent * 10) / 10, memoryBytes: Number(serviceMemory) || 0, memoryLimitBytes: serviceMemoryMax.trim() === 'max' ? null : Number(serviceMemoryMax) || null }],
    disk: disk.length >= 4 ? {
      totalBytes: Number(disk[0]) || 0,
      usedBytes: Number(disk[1]) || 0,
      availableBytes: Number(disk[2]) || 0,
      usedPercent: Number(String(disk[3]).replace('%', '')) || 0,
    } : null,
  };
}
