// Mirror outbox: HTTP delivery of usage events to a central ingest endpoint,
// with a persistent local queue and exponential-backoff retry.

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return null;
}

function normalizeMirrorConfig(raw = {}) {
  return {
    enabled: Boolean(raw.enabled && raw.url && raw.apiKey),
    url: firstString(raw.url),
    apiKey: firstString(raw.apiKey),
    timeoutMs: Number(raw.timeoutMs ?? 5000) || 5000,
    retryIntervalMs: Number(raw.retryIntervalMs ?? 15000) || 15000,
    retryBaseDelayMs: Number(raw.retryBaseDelayMs ?? 2000) || 2000,
    retryMaxDelayMs: Number(raw.retryMaxDelayMs ?? 300000) || 300000,
    maxBatchSize: Number(raw.maxBatchSize ?? 50) || 50
  };
}

export function createMirrorManager({ mirrorConfig, db, fetchImpl, dbReady, debugLog }) {
  const mirror = normalizeMirrorConfig(mirrorConfig);

  const canUseMirrorQueue = mirror.enabled
    && typeof db.enqueueMirrorEvent === "function"
    && typeof db.listPendingMirrorEvents === "function"
    && typeof db.markMirrorEventSynced === "function"
    && typeof db.markMirrorEventFailed === "function";
  let mirrorFlushRunning = false;

  function computeNextRetryAt(attemptCount) {
    const safeAttempt = Math.max(1, Number(attemptCount) || 1);
    const base = Math.max(100, mirror.retryBaseDelayMs);
    const max = Math.max(base, mirror.retryMaxDelayMs);
    const jitterMs = Math.floor(Math.random() * Math.min(base, 1000));
    const delayMs = Math.min(max, base * (2 ** (safeAttempt - 1))) + jitterMs;
    return new Date(Date.now() + delayMs).toISOString();
  }

  async function mirrorUsageEvent(row) {
    if (!mirror.enabled || !mirror.url || !mirror.apiKey || typeof fetchImpl !== "function") {
      return { ok: false, error: "mirror_not_configured" };
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), mirror.timeoutMs);

    try {
      const response = await fetchImpl(mirror.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${mirror.apiKey}`
        },
        body: JSON.stringify(row),
        signal: controller.signal
      });

      if (!response.ok) {
        debugLog({ event: "mirror_http_error", status: response.status, url: mirror.url, id: row.id });
        return { ok: false, error: `http_${response.status}` };
      }
      return { ok: true };
    } catch (error) {
      debugLog({ event: "mirror_request_error", url: mirror.url, id: row.id, message: error?.message ?? String(error) });
      return { ok: false, error: error?.message ?? String(error) };
    } finally {
      clearTimeout(timeout);
    }
  }

  async function flushMirrorQueue() {
    if (!canUseMirrorQueue || mirrorFlushRunning) return;
    await dbReady;
    mirrorFlushRunning = true;
    try {
      const batchLimit = Math.max(1, Math.min(500, mirror.maxBatchSize));
      while (true) {
        const pending = await db.listPendingMirrorEvents(batchLimit);
        if (!pending.length) break;

        for (const entry of pending) {
          if (!entry?.id) continue;
          if (!entry.payload || typeof entry.payload !== "object") {
            await db.markMirrorEventSynced(entry.id);
            continue;
          }

          const result = await mirrorUsageEvent(entry.payload);
          if (result.ok) {
            await db.markMirrorEventSynced(entry.id);
          } else {
            const attempt = (Number(entry.attemptCount) || 0) + 1;
            const nextRetryAt = computeNextRetryAt(attempt);
            await db.markMirrorEventFailed(entry.id, nextRetryAt, firstString(result.error, "mirror_failed"));
          }
        }

        if (pending.length < batchLimit) break;
      }
    } catch (error) {
      debugLog({ event: "mirror_queue_flush_error", message: error?.message ?? String(error) });
    } finally {
      mirrorFlushRunning = false;
    }
  }

  if (canUseMirrorQueue) {
    const timer = setInterval(() => {
      void flushMirrorQueue();
    }, Math.max(1000, mirror.retryIntervalMs));
    if (typeof timer.unref === "function") timer.unref();
  }

  async function enqueueMirror(row) {
    if (!mirror.enabled) return;
    if (canUseMirrorQueue) {
      await db.enqueueMirrorEvent(row);
      void flushMirrorQueue();
      return;
    }
    void mirrorUsageEvent(row);
  }

  return { enqueueMirror };
}
