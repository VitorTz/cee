import { SUPABASE_URL, SUPABASE_ANON_KEY } from "../config.js";
import { qs } from "./utils.js";

class AsyncMutex {
    constructor() {
        this.locked = false;
        this.queue = [];
    }

    async acquire() {
        if (!this.locked) {
            this.locked = true;
            return;
        }
        return new Promise(resolve => this.queue.push(resolve));
    }

    release() {
        if (this.queue.length > 0) {
            const nextResolve = this.queue.shift();
            nextResolve();
        } else {
            this.locked = false;
        }
    }
}


/**
 * Wrapper for the Supabase client to track extensive request metrics.
 * Tracks local session and periodically flushes data to global telemetry.
 */
class SupabaseWrapper {
    constructor(supabaseUrl, supabaseKey, options = {}) {
        this.mutex = new AsyncMutex();

        // Buffer to hold requests temporarily before sending them to the DB
        this.telemetryBuffer = [];
        this.flushIntervalMs = 15000; // 15 seconds

        this.stats = {
            sessionStartTime: new Date().toISOString(),
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            requestsPerMinute: 0,
            statusCodes: {},
            methods: {},
            totalResponseTimeMs: 0,
            averageResponseTimeMs: 0,
            minResponseTimeMs: null,
            maxResponseTimeMs: 0,
            lastRequestTimestamp: null,
            requestsLog: []
        };

        const enhancedOptions = {
            ...options,
            global: {
                ...options.global,
                fetch: this._createFetchInterceptor(options.global?.fetch || window.fetch.bind(window))
            }
        };

        this.client = window.supabase.createClient(supabaseUrl, supabaseKey, enhancedOptions);

        // Start the background process to flush metrics globally
        this._startTelemetrySync();
    }

    _createFetchInterceptor(originalFetch) {
        return async (url, fetchOptions) => {
            const startTime = performance.now();
            const method = (fetchOptions?.method || 'GET').toUpperCase();
            let status = 0;
            let isSuccess = false;

            try {
                const response = await originalFetch(url, fetchOptions);
                status = response.status;
                isSuccess = response.ok;
                return response;
            } catch (error) {
                status = 'NETWORK_ERROR';
                isSuccess = false;
                throw error;
            } finally {
                const endTime = performance.now();
                const duration = endTime - startTime;
                const urlString = url.toString();

                // Prevent recursive tracking of our own background tasks
                const isPingRequest = method === 'POST' && urlString.includes('/rest/v1/rpc/get_pg_version');
                const isTelemetryRequest = method === 'POST' && urlString.includes('/rest/v1/rpc/flush_client_metrics');
                const isGlobalMetricsRequest = method === 'POST' && urlString.includes('/rest/v1/rpc/get_global_metrics_24h');

                if (!isPingRequest && !isTelemetryRequest && !isGlobalMetricsRequest) {
                    this._recordMetrics(method, urlString, duration, status, isSuccess).catch(console.error);
                }
            }
        };
    }

    async _recordMetrics(method, url, duration, status, isSuccess) {
        await this.mutex.acquire();
        try {
            const durationMs = Number(duration.toFixed(2));
            this.stats.totalRequests++;
            this.stats.totalResponseTimeMs += duration;
            this.stats.lastRequestTimestamp = new Date().toISOString();

            if (isSuccess) this.stats.successfulRequests++;
            else this.stats.failedRequests++;

            this.stats.methods[method] = (this.stats.methods[method] || 0) + 1;
            this.stats.statusCodes[status] = (this.stats.statusCodes[status] || 0) + 1;

            if (this.stats.minResponseTimeMs === null || duration < this.stats.minResponseTimeMs) {
                this.stats.minResponseTimeMs = durationMs;
            }
            if (duration > this.stats.maxResponseTimeMs) {
                this.stats.maxResponseTimeMs = durationMs;
            }

            this.stats.averageResponseTimeMs = Number((this.stats.totalResponseTimeMs / this.stats.totalRequests).toFixed(2));

            const elapsedMinutes = (Date.now() - new Date(this.stats.sessionStartTime).getTime()) / 60000;
            if (elapsedMinutes > 0) {
                this.stats.requestsPerMinute = Number((this.stats.totalRequests / elapsedMinutes).toFixed(2));
            }

            // Extract a clean endpoint for telemetry to avoid storing massive URLs
            let endpoint = url;
            try {
                const urlObj = new URL(url);
                endpoint = urlObj.pathname;
            } catch (e) { }

            const logEntry = {
                method,
                endpoint,
                status: status === 'NETWORK_ERROR' ? 0 : status,
                durationMs
            };

            this.telemetryBuffer.push(logEntry);
            this.stats.requestsLog.push({ ...logEntry, timestamp: this.stats.lastRequestTimestamp, url });
            if (this.stats.requestsLog.length > 128) {
                this.stats.requestsLog.shift();
            }
        } finally {
            this.mutex.release();
        }
    }

    _startTelemetrySync() {
        setInterval(() => this._flushTelemetry(), this.flushIntervalMs);
    }

    async _flushTelemetry() {
        if (this.telemetryBuffer.length === 0 || !currentUser) return;

        let batch;
        await this.mutex.acquire();
        try {
            batch = [...this.telemetryBuffer];
            this.telemetryBuffer = [];
        } finally {
            this.mutex.release();
        }

        try {
            await this.client.rpc('flush_client_metrics', { metrics: batch });
        } catch (error) {
            console.error("Failed to sync telemetry", error);
        }
    }

    async getStatsSnapshot() {
        await this.mutex.acquire();
        try {
            return JSON.parse(JSON.stringify(this.stats));
        } finally {
            this.mutex.release();
        }
    }

    getClient() {
        return this.client;
    }
}

const supabaseWrapper = new SupabaseWrapper(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: false,
    },
});

export const UserRoles = Object.freeze({
    ADMIN: 'admin',
    SUPERVISOR: 'supervisor',
    CARTEIRO: 'carteiro'
});

let supabasePingInitialized = false;
export let appInitialized = false;
export let currentUserRole = null;
export let currentUser = null;
export const sb = supabaseWrapper.getClient();


export function setCurrentUser(user) {
    currentUser = user;
}

export function setCurrentUserRole(role) {
    currentUserRole = role
}

export function setAppInitialized(value) {
    appInitialized = value
}

export function initSupabasePing() {
    const dot = qs('#ping-dot');
    const text = qs('#ping-text');
    supabasePingInitialized = true;
    setInterval(async () => {
        if (document.visibilityState !== 'visible' || currentUserRole != UserRoles.ADMIN) return;
        const start = performance.now();

        try {
            // Execute the RPC call to retrieve the PostgreSQL version
            const { data, error } = await sb.rpc('get_pg_version');

            const end = performance.now();
            const latency = Math.round(end - start);

            if (error) {
                throw error;
            }

            // Update the UI based on latency
            text.textContent = `${latency}ms`;
            if (latency < 200) {
                dot.className = 'ping-dot ping-green';
            } else if (latency < 800) {
                dot.className = 'ping-dot ping-yellow';
            } else {
                dot.className = 'ping-dot ping-red';
            }

        } catch (error) {
            dot.className = 'ping-dot ping-red';
            text.textContent = 'Err';
        }
    }, 3000);
}