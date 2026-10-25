// Docker containers, volumes and disk usage, grouped by compose project.
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { config } from '../config.mjs';

const execFileAsync = promisify(execFile);
const HOME_DIR = config.homeDir;
const CODEX_HOME = config.codexHome;
const STORAGE_CACHE_MS = 5 * 60 * 1000;
let dockerStorageCache = null;
let dockerStorageCacheAt = 0;

export function parseBytes(value) {
  const match = String(value || '').trim().match(/^([\d.]+)\s*(B|kB|KB|KiB|MB|MiB|GB|GiB|TB|TiB)$/i);
  if (!match) return 0;
  const unit = match[2].toLowerCase();
  const base = /iB$/.test(match[2]) || unit === 'b' ? 1024 : 1000;
  const power = unit.startsWith('t') ? 4 : unit.startsWith('g') ? 3 : unit.startsWith('m') ? 2 : unit.startsWith('k') ? 1 : 0;
  return Math.round(Number(match[1]) * base ** power);
}

function projectLabel(name, composeProject) {
  if (/buildkit/i.test(name)) return 'BuildKit de homologação';
  const known = {
    'contador-habitos': 'Contador de hábitos',
    'hp-cards': 'HP Cards',
    'live-rooms': 'Live Rooms',
    'live-rooms-homolog': 'Live Rooms · homologação',
    'artmeta-media': 'Artmeta Media',
    'codex-agent': 'Proxy do Codex Agent',
  };
  if (known[composeProject]) return known[composeProject];
  if (name.startsWith('live-rooms-')) return 'Live Rooms';
  return composeProject || name.replace(/-[a-z0-9]{6,}$/, '').replace(/[-_]+/g, ' ') || 'Outros';
}

export async function readDockerHealth() {
  try {
    const [statsResult, containersResult] = await Promise.all([
      execFileAsync('docker', ['stats', '--no-stream', '--format', '{{.Name}}\t{{.CPUPerc}}\t{{.MemUsage}}\t{{.MemPerc}}'], { timeout: 25000, maxBuffer: 1024 * 1024 }),
      execFileAsync('docker', ['ps', '-a', '--size', '--format', '{{.Names}}\t{{.Status}}\t{{.Image}}\t{{.Label "com.docker.compose.project"}}\t{{.Size}}'], { timeout: 10000, maxBuffer: 1024 * 1024 }),
    ]);
    const stats = new Map(statsResult.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, cpu, memory, percent] = line.split('\t');
      const [used, limit] = String(memory || '').split('/').map((part) => parseBytes(part));
      return [name, { cpuPercent: Number(String(cpu).replace('%', '')) || 0, memoryBytes: used, memoryLimitBytes: limit, memoryPercent: Number(String(percent).replace('%', '')) || 0 }];
    }));
    const containers = containersResult.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [name, status, image, composeProject, size] = line.split('\t');
      const metric = stats.get(name) || {};
      return {
        name,
        project: projectLabel(name, composeProject),
        image,
        status,
        running: /^Up\b/.test(status),
        health: /\(healthy\)/i.test(status) ? 'healthy' : /\(unhealthy\)/i.test(status) ? 'unhealthy' : /\(health: starting\)/i.test(status) ? 'starting' : null,
        cpuPercent: metric.cpuPercent || 0,
        memoryBytes: metric.memoryBytes || 0,
        memoryLimitBytes: metric.memoryLimitBytes || 0,
        memoryPercent: metric.memoryPercent || 0,
        storageBytes: parseBytes(String(size || '').split(' (virtual')[0]),
      };
    });
    const groups = new Map();
    for (const container of containers) {
      if (!groups.has(container.project)) groups.set(container.project, { name: container.project, containers: 0, running: 0, stopped: 0, cpuPercent: 0, memoryBytes: 0, memoryLimitBytes: 0, containerStorageBytes: 0, volumeStorageBytes: 0, storageBytes: 0, unhealthy: false });
      const group = groups.get(container.project);
      group.containers += 1;
      if (container.running) group.running += 1; else group.stopped += 1;
      group.cpuPercent += container.cpuPercent;
      group.memoryBytes += container.memoryBytes;
      group.memoryLimitBytes += container.memoryLimitBytes;
      group.containerStorageBytes += container.storageBytes;
      group.storageBytes += container.storageBytes;
      group.unhealthy ||= container.health === 'unhealthy';
    }
    return {
      available: true,
      runningCount: containers.filter((item) => item.running).length,
      stoppedCount: containers.filter((item) => !item.running).length,
      projects: [...groups.values()].sort((a, b) => b.memoryBytes - a.memoryBytes),
      containers: containers.sort((a, b) => a.project.localeCompare(b.project) || a.name.localeCompare(b.name)),
    };
  } catch {
    return { available: false, runningCount: 0, stoppedCount: 0, projects: [], containers: [], error: 'Não foi possível consultar o Docker.' };
  }
}

export async function readDockerStorage(force = false) {
  if (!force && dockerStorageCache && Date.now() - dockerStorageCacheAt < STORAGE_CACHE_MS) return dockerStorageCache;
  try {
    const [summaryResult, detailResult, dockerRootResult] = await Promise.all([
      execFileAsync('docker', ['system', 'df', '--format', '{{.Type}}\t{{.TotalCount}}\t{{.Active}}\t{{.Size}}\t{{.Reclaimable}}'], { timeout: 30000, maxBuffer: 64 * 1024 }),
      execFileAsync('docker', ['system', 'df', '-v', '--format', 'json'], { timeout: 30000, maxBuffer: 4 * 1024 * 1024 }),
      execFileAsync('docker', ['info', '--format', '{{.DockerRootDir}}'], { timeout: 10000, maxBuffer: 16 * 1024 }),
    ]);
    const summary = summaryResult.stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [type, total, active, size, reclaimable] = line.split('\t');
      return { type, total: Number(total) || 0, active: Number(active) || 0, size, reclaimable };
    });
    const detail = JSON.parse(detailResult.stdout);
    const volumeProjects = new Map();
    const projectPaths = new Map();
    for (const container of detail.Containers || []) {
      const labels = Object.fromEntries(String(container.Labels || '').split(',').map((label) => {
        const separator = label.indexOf('=');
        return separator < 0 ? [label, ''] : [label.slice(0, separator), label.slice(separator + 1)];
      }).filter(([key]) => key));
      const owner = projectLabel(container.Names || '', labels['com.docker.compose.project']);
      const workingDir = labels['com.docker.compose.project.working_dir'];
      if (workingDir && workingDir.startsWith('/') && !workingDir.includes('..') && !projectPaths.has(owner)) projectPaths.set(owner, workingDir);
      for (const volumeName of String(container.Mounts || '').split(',').map((name) => name.trim()).filter((name) => name && !name.startsWith('/'))) {
        if (!volumeProjects.has(volumeName)) volumeProjects.set(volumeName, owner);
      }
    }
    const volumes = (detail.Volumes || []).map((volume) => {
      const labels = Object.fromEntries(String(volume.Labels || '').split(',').map((label) => {
        const separator = label.indexOf('=');
        return separator < 0 ? [label, ''] : [label.slice(0, separator), label.slice(separator + 1)];
      }).filter(([key]) => key));
      const composeProject = labels['com.docker.compose.project'];
      const project = composeProject ? projectLabel(volume.Name, composeProject) : volumeProjects.get(volume.Name) || (volume.Name.startsWith('buildx_buildkit_') ? 'BuildKit de homologação' : null);
      return { name: volume.Name, size: volume.Size, storageBytes: parseBytes(volume.Size), project, links: Number(volume.Links) || 0 };
    }).sort((a, b) => b.storageBytes - a.storageBytes);
    const projectVolumes = new Map();
    for (const volume of volumes) if (volume.project) projectVolumes.set(volume.project, (projectVolumes.get(volume.project) || 0) + volume.storageBytes);
    const storagePaths = [
      ['Repositórios de projetos', join(HOME_DIR, 'projects')],
      ['Builds', join(HOME_DIR, 'builds')],
      ['Dados e cache do Codex', CODEX_HOME],
      ['Workspaces Live Rooms', join(HOME_DIR, 'live-rooms-workspaces')],
      ['Assets LPC', join(HOME_DIR, 'lpc_assets')],
      ['Cache do usuário', join(HOME_DIR, '.cache')],
      ['Cache npm', join(HOME_DIR, '.npm')],
    ];
    const storageLocations = await Promise.all(storagePaths.map(async ([name, path]) => {
      try {
        const { stdout } = await execFileAsync('du', ['-x', '-B1', '-s', '--', path], { timeout: 15000, maxBuffer: 16 * 1024 });
        const bytes = Number(stdout.trim().split(/\s+/)[0]) || 0;
        return { name, path, bytes };
      } catch { return null; }
    }));
    const projectDirectories = await Promise.all([...projectPaths].map(async ([project, path]) => {
      try {
        const { stdout } = await execFileAsync('du', ['-x', '-B1', '-s', '--', path], { timeout: 15000, maxBuffer: 16 * 1024 });
        return { project, path, bytes: Number(stdout.trim().split(/\s+/)[0]) || 0 };
      } catch { return null; }
    }));
    const dockerRoot = dockerRootResult.stdout.trim();
    if (dockerRoot) {
      try {
        const { stdout } = await execFileAsync('du', ['-x', '-B1', '-s', '--', dockerRoot], { timeout: 30000, maxBuffer: 16 * 1024 });
        storageLocations.unshift({ name: 'Diretório de dados Docker', path: dockerRoot, bytes: Number(stdout.trim().split(/\s+/)[0]) || 0 });
      } catch { /* Docker's summary below remains available if du cannot read its data root. */ }
    }
    dockerStorageCache = { summary, volumes, projectVolumes: [...projectVolumes].map(([project, bytes]) => ({ project, bytes })), projectDirectories: projectDirectories.filter(Boolean), storageLocations: storageLocations.filter(Boolean) };
    dockerStorageCacheAt = Date.now();
    return dockerStorageCache;
  } catch {
    return dockerStorageCache || { summary: [], volumes: [], projectVolumes: [], projectDirectories: [], storageLocations: [] };
  }
}
