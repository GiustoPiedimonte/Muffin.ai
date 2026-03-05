// ---------------------------------------------------------------------------
// Sequential queue with rate limiting for Claude API calls
// ---------------------------------------------------------------------------

const MIN_DELAY_MS = 500;    // minimum gap between consecutive requests
const TIMEOUT_MS = 120_000;  // 2 minutes max per request

let lastCallTime = 0;
let running = false;

interface QueueItem<T> {
    fn: () => Promise<T>;
    resolve: (value: T) => void;
    reject: (reason: unknown) => void;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const pending: QueueItem<any>[] = [];

/**
 * Enqueues an async function to be executed sequentially.
 * Only one function runs at a time; others wait in FIFO order.
 * A minimum delay of MIN_DELAY_MS is enforced between calls.
 * Each call has a TIMEOUT_MS timeout.
 */
export function enqueue<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        pending.push({ fn, resolve, reject });
        drain();
    });
}

async function drain(): Promise<void> {
    if (running) return;
    running = true;

    while (pending.length > 0) {
        const item = pending.shift()!;

        // Enforce minimum delay between calls
        const now = Date.now();
        const elapsed = now - lastCallTime;
        if (elapsed < MIN_DELAY_MS) {
            await sleep(MIN_DELAY_MS - elapsed);
        }

        try {
            const result = await withTimeout(item.fn(), TIMEOUT_MS);
            lastCallTime = Date.now();
            item.resolve(result);
        } catch (err) {
            lastCallTime = Date.now();
            item.reject(err);
        }
    }

    running = false;
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Queue timeout: request exceeded ${ms}ms`)),
            ms
        );

        promise
            .then((val) => {
                clearTimeout(timer);
                resolve(val);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}
