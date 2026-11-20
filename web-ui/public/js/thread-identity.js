// Provider sessions and consolidated branches open the same visible conversation.
export function canonicalThreadId(threadId, threads = []) {
  if (!threadId) return threadId;
  const owner = threads.find((thread) => thread.id !== threadId
    && [...(thread.internalCodexThreadIds || []), ...(thread.mergedThreadIds || [])].includes(threadId));
  return owner?.id || threadId;
}
