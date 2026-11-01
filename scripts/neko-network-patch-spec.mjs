// Bound the pinned plugin's HTTP work through the response body, not just headers.
// Existing callers and their on-disk cache/ETag behavior remain unchanged.
export const NEKO_NETWORK_PATCHES = [
  {
    package: 'dsh-nekowhale-stickers', version: '1.1.1', rootIndex: 1, file: 'lib/core/sync.js',
    before: 'dbf59ee332c0d6f0ca4043bf4e73372b27b7f16e5fbd80c5dc6e30ecd10cc548',
    after: '649e31ca39b238824240e4ce69e8711b643cfbf02adbb50803046fe7971889ec',
    needle: `const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export async function fetchRetry(url, init = {}, tries = 5) {
    let wait = 1000;
    for (let i = 0;; i++) {
        try {
            const res = await fetch(url, init);
            // EdgeOne answers 570 when its platform rate limit trips; treat like 429.
            if (res.status !== 429 && res.status !== 570 && res.status < 500)
                return res;
            if (i >= tries - 1)
                return res;
        }
        catch (e) {
            if (i >= tries - 1)
                throw e;
        }
        await sleep(wait + Math.random() * 500);
        wait *= 2;
    }
}`,
    replacement: `// QQAI_DSH: bounded headers + body, abortable retries, and no partial cache writes.
export const QQAI_FETCH_LIMITS = Object.freeze({ attemptMs: 12000, totalMs: 30000, maxBytes: 32 * 1024 * 1024, backoffMs: 1000 });
function networkError(code, message) {
    return Object.assign(new Error(message), { code });
}
function abortReason(signal) {
    return signal.reason ?? networkError('QQAI_NETWORK_ABORTED', 'Nekowhale download cancelled');
}
// Also settle if a fetch implementation or body reader fails to honor abort.
function abortable(signal, operation) {
    if (signal.aborted) return Promise.reject(abortReason(signal));
    return new Promise((resolve, reject) => {
        const aborted = () => { cleanup(); reject(abortReason(signal)); };
        const cleanup = () => signal.removeEventListener('abort', aborted);
        signal.addEventListener('abort', aborted, { once: true });
        Promise.resolve().then(() => {
            if (signal.aborted) throw abortReason(signal);
            return operation();
        }).then((value) => { cleanup(); resolve(value); }, (error) => { cleanup(); reject(error); });
    });
}
function retryDelay(ms, signal) {
    return new Promise((resolve, reject) => {
        let timer;
        const done = () => { signal.removeEventListener('abort', aborted); clearTimeout(timer); };
        const aborted = () => { done(); reject(abortReason(signal)); };
        if (signal.aborted) return aborted();
        signal.addEventListener('abort', aborted, { once: true });
        timer = setTimeout(() => { done(); resolve(); }, ms);
    });
}
// A separate factory permits fast real-socket fault tests. Overrides may only
// tighten production limits and are never supplied by model-facing tools.
export function createBoundedFetchRetry(limits = {}) {
    const cfg = { ...QQAI_FETCH_LIMITS, ...limits };
    for (const key of Object.keys(QQAI_FETCH_LIMITS)) {
        if (!Number.isFinite(cfg[key]) || cfg[key] < (key === 'backoffMs' ? 0 : 1) || cfg[key] > QQAI_FETCH_LIMITS[key])
            throw new Error('Invalid Nekowhale network limit: ' + key);
    }
    return async function fetchRetry(url, init = {}, tries = 5) {
        const total = new AbortController();
        const timeout = () => networkError('QQAI_NETWORK_TIMEOUT', 'Nekowhale download exceeded its time budget');
        const parentAbort = () => total.abort(abortReason(init.signal));
        if (init.signal?.aborted) throw abortReason(init.signal);
        init.signal?.addEventListener('abort', parentAbort, { once: true });
        const deadline = setTimeout(() => total.abort(timeout()), cfg.totalMs);
        const attempts = Math.max(1, Math.min(5, Math.trunc(Number(tries)) || 1));
        let delay = cfg.backoffMs;
        try {
            for (let i = 0; i < attempts; i++) {
                const attempt = new AbortController();
                const signal = AbortSignal.any([total.signal, attempt.signal]);
                const timer = setTimeout(() => attempt.abort(timeout()), cfg.attemptMs);
                let reader;
                let complete = false;
                try {
                    const res = await abortable(signal, () => fetch(url, { ...init, signal }));
                    const length = Number(res.headers.get('content-length'));
                    if (Number.isFinite(length) && length > cfg.maxBytes)
                        throw networkError('QQAI_NETWORK_SIZE', 'Nekowhale response exceeds the download size limit');
                    const chunks = [];
                    let size = 0;
                    if (res.body) {
                        reader = res.body.getReader();
                        for (;;) {
                            const { done, value } = await abortable(signal, () => reader.read());
                            if (done) break;
                            size += value.byteLength;
                            if (size > cfg.maxBytes)
                                throw networkError('QQAI_NETWORK_SIZE', 'Nekowhale response exceeds the download size limit');
                            chunks.push(Buffer.from(value));
                        }
                    }
                    complete = true;
                    // Preserve status and validators; downstream arrayBuffer/text
                    // now read bounded local bytes instead of a live network body.
                    const response = new Response(res.body ? Buffer.concat(chunks, size) : null,
                        { status: res.status, statusText: res.statusText, headers: res.headers });
                    if ((res.status !== 429 && res.status !== 570 && res.status < 500) || i === attempts - 1)
                        return response;
                }
                catch (error) {
                    if (total.signal.aborted) throw abortReason(total.signal);
                    if (error?.code === 'QQAI_NETWORK_SIZE' || i === attempts - 1) throw error;
                }
                finally {
                    clearTimeout(timer);
                    if (!complete) {
                        attempt.abort(networkError('QQAI_NETWORK_ABORTED', 'Nekowhale download attempt ended'));
                        if (reader) void reader.cancel().catch(() => {});
                    }
                    else reader?.releaseLock();
                }
                await retryDelay(delay + Math.random() * Math.min(500, delay / 2), total.signal);
                delay *= 2;
            }
            throw timeout();
        }
        finally {
            clearTimeout(deadline);
            init.signal?.removeEventListener('abort', parentAbort);
        }
    };
}
export const fetchRetry = createBoundedFetchRetry();`,
  },
]
