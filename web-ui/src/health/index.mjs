// Aggregated VPS health snapshot with a short cache and request coalescing.
import { readDockerHealth, readDockerStorage } from './docker.mjs';
import { readHostHealth } from './host.mjs';

const HEALTH_CACHE_MS = 20_000;
let vpsHealthCache = null;
let vpsHealthCacheAt = 0;
let vpsHealthInFlight = null;

export async function getVpsHealth(force = false) {
  if (!force && vpsHealthCache && Date.now() - vpsHealthCacheAt < HEALTH_CACHE_MS) return vpsHealthCache;
  if (vpsHealthInFlight) return vpsHealthInFlight;
  vpsHealthInFlight = (async () => {
    const [host, docker, dockerStorage] = await Promise.all([readHostHealth(), readDockerHealth(), readDockerStorage(force)]);
    const volumeBytesByProject = new Map((dockerStorage.projectVolumes || []).map((item) => [item.project, item.bytes]));
    const projectDirByName = new Map((dockerStorage.projectDirectories || []).map((item) => [item.project, item]));
    for (const project of docker.projects || []) {
      project.volumeStorageBytes = volumeBytesByProject.get(project.name) || 0;
      const projectDir = projectDirByName.get(project.name);
      project.sourceBytes = projectDir?.bytes || 0;
      project.sourcePath = projectDir?.path || null;
      project.storageBytes += project.volumeStorageBytes + project.sourceBytes;
    }
    const data = { checkedAt: new Date().toISOString(), host, docker, dockerStorage: dockerStorage.summary || [], dockerVolumes: dockerStorage.volumes || [], storageLocations: dockerStorage.storageLocations || [], projectDirectories: dockerStorage.projectDirectories || [] };
    vpsHealthCache = data;
    vpsHealthCacheAt = Date.now();
    return data;
  })();
  try { return await vpsHealthInFlight; }
  finally { vpsHealthInFlight = null; }
}
