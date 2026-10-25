// Shared mutable client state. Modules read and write these objects directly.

function loadProjectColors() {
  try {
    const value = JSON.parse(localStorage.getItem('codex-project-colors') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

function loadThreadColors() {
  try {
    const value = JSON.parse(localStorage.getItem('codex-thread-colors') || '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch { return {}; }
}

export const state = {
  models: [], threads: [], projects: [], selectedProjectId: localStorage.getItem('codex-project') || '', selectedThreadId: null, selectedThread: null,
  expandedProjectId: localStorage.getItem('codex-expanded-project') || '', projectColors: loadProjectColors(), threadColors: loadThreadColors(), unassignedExpanded: localStorage.getItem('codex-unassigned-expanded') !== 'false', agentThreads: new Map(),
  cwd: localStorage.getItem('codex-cwd') || '', defaultCwd: '', projectsRoot: '', activeThreadProjectId: '', archivedView: false, loadingThreadId: null,
  historyThreadId: '', historyTurns: [], renderedHistorySnapshot: '', historyNextCursor: null, historyLoadedOlder: false, historyLoadingOlder: false,
  modelId: localStorage.getItem('codex-model') || '', effort: localStorage.getItem('codex-effort') || '',
  files: [], busy: false, sending: false, interrupting: false, account: null, rateLimits: null, usage: null, contextUsage: null,
  queueItems: [], recoveredQueueItems: [], deferredQueueItems: [], rateLimitFailure: null, draftQueueGroupId: localStorage.getItem('codex-draft-queue-group') || '', turnStartedAtMs: null, turnTimer: null,
  streamedMessages: new Map(), activityCards: new Map(), commandGroups: new Map(), reasoningGroups: new Map(), turnIntermediates: new Map(), userMessageIds: new Set(), pendingApprovals: new Map(),
  activeTurnId: null,
  completedTurnIds: new Set(), progressSegments: new Map(), executionRevision: 0, lastExecutionEventAt: Date.now(),
  activeThreadIds: new Set(),
  followLatest: true,
  threadListRequest: 0,
  accounts: [], rotation: null, providers: [], tasks: [], openTaskId: '',
};

export const authUi = { mode: 'login', step: 'credentials', challengeId: '', setupRequired: false, countdown: null, started: false };

export const queueActions = new Map();

export const completionSound = { context: null, playedTurnIds: new Set() };

export const voice = { phase: 'idle', recorder: null, stream: null, chunks: [], blob: null, url: '', timer: null, startedAt: 0, seconds: 0, request: null, jobId: null, cancelled: false, context: null, meterSource: null, meterFrame: null, hasSignal: false, generation: 0, transcriptInserted: false };

// Module-level handles that several modules reassign (timers, in-flight requests).
export const runtime = {
  vpsHealthRequest: null,
  executionSyncRequest: null,
  authCheckRequest: null,
  queueRefreshSequence: 0,
  deferredQueueDbPromise: null,
  deferredDrainPromise: null,
  quotaRefreshPromise: null,
  quotaResetTimer: null,
  quotaPollTimer: null,
  scheduledQuotaResetAt: 0,
};
