import axios, { type AxiosRequestConfig } from "axios";
import { GetRequiredSecrets, ReplaceAllOccurrences, ApplySecretsToHeaders } from "../tool.js";
import { plaintextSecretRefusal, redirectWouldLeak, plaintextSecretError } from "./secretTransport.js";
import GC from "../../global-constants.js";
import * as cheerio from "cheerio";
import { DefaultAPIEval } from "../../anywhere.js";
import version from "../../version.js";
import { AxiosProxyConfig } from "../proxy.js";
import { performance } from "node:perf_hooks";
import type { ApiMonitor, EvalResponse, MonitoringResult } from "../types/monitor.js";

class ApiCall {
  monitor: ApiMonitor;
  envSecrets: Array<{ find: string; replace: string | undefined }>;

  constructor(monitor: ApiMonitor) {
    this.monitor = monitor;
    // Read type_data defensively: a malformed monitor (missing type_data) must
    // be reported by execute() as an ERROR result, so the constructor must not
    // throw before execute() ever runs.
    const td = monitor.type_data;
    this.envSecrets = GetRequiredSecrets(
      `${td?.url ?? ""} ${td?.body || ""} ${td?.proxy ?? ""} ${JSON.stringify(td?.headers || [])}`,
    );
  }

  async execute(): Promise<MonitoringResult> {
    // Malformed config (missing type_data) must record a result, not throw out
    // of the worker and leave a gap in the timeline.
    if (!this.monitor.type_data) {
      return {
        status: GC.DOWN,
        latency: 0,
        type: GC.ERROR,
        error_message: "API monitor is missing configuration",
      };
    }

    let axiosHeaders: Record<string, string> = {};
    axiosHeaders["User-Agent"] = `Kener/${version()}`;
    axiosHeaders["Accept"] = "*/*";

    let body = this.monitor.type_data.body;
    let url = this.monitor.type_data.url;
    let proxy = this.monitor.type_data.proxy;

    let method = this.monitor.type_data.method;
    let timeout = this.monitor.type_data.timeout || 10000;

    let monitorEval = !!this.monitor.type_data.eval ? this.monitor.type_data.eval : DefaultAPIEval;

    for (let i = 0; i < this.envSecrets.length; i++) {
      const secret = this.envSecrets[i];
      if (secret.replace === undefined) continue;
      if (!!body) {
        body = ReplaceAllOccurrences(body, secret.find, secret.replace);
      }
      if (!!url) {
        url = ReplaceAllOccurrences(url, secret.find, secret.replace);
      }
      if (!!proxy) {
        proxy = ReplaceAllOccurrences(proxy, secret.find, secret.replace);
      }
    }

    // I6. Refuse before anything is sent, on the *resolved* URL: substitution can
    // change the host, so the scheme that matters is the one the request will
    // actually use. Recorded as an ERROR result rather than thrown, so the minute
    // gets a row saying what happened instead of a hole in the timeline.
    const refusal = plaintextSecretRefusal({
      url,
      secrets: this.envSecrets,
      typeData: this.monitor.type_data,
    });
    if (refusal) {
      return { status: GC.DOWN, latency: 0, type: GC.ERROR, error_message: refusal };
    }

    // Substitute secrets into each header key/value individually - never into a
    // JSON blob, which a secret value could corrupt and drop the whole set.
    axiosHeaders = { ...axiosHeaders, ...ApplySecretsToHeaders(this.monitor.type_data.headers, this.envSecrets) };
    const followRedirects = this.monitor.type_data.follow_redirects ?? true;

    const maxRedirects = this.monitor.type_data.max_redirects ?? 5;

    const options: AxiosRequestConfig = {
      method: method,
      headers: axiosHeaders,
      timeout: timeout,
      transformResponse: (r: string) => r,
      maxRedirects: followRedirects ? maxRedirects : 0,
      // I6, the downgrade case. An `https://` URL answering 302 to `http://` is
      // followed by default and carries the Authorization header with it, and
      // nothing in the monitor's configuration looks wrong. `beforeRedirect` is
      // axios's hook into follow-redirects; throwing here aborts the request
      // rather than completing the hop.
      beforeRedirect: (options: { protocol?: string; href?: string }) => {
        const target = options.href ?? `${options.protocol ?? ""}//`;
        if (redirectWouldLeak(target, { secrets: this.envSecrets, typeData: this.monitor.type_data })) {
          throw new Error(plaintextSecretError("a redirect to this URL"));
        }
      },
      validateStatus: () => true,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      ...AxiosProxyConfig(
        proxy,
        { keepAlive: true, keepAliveMsecs: 30000, maxSockets: 50, maxFreeSockets: 10, timeout },
        { rejectUnauthorized: !this.monitor.type_data.allowSelfSignedCert },
      ),
    };

    if (!!body) {
      options.data = body;
    }
    let statusCode = 500;
    let latency = 0;
    let errorMessage = "";
    let resp = "";
    let timeoutError = false;
    const start = performance.now();
    try {
      let data = await axios(url, options);
      statusCode = data.status;
      resp = data.data;
    } catch (err: unknown) {
      const error = err as {
        code?: string;
        message?: string;
        response?: { status?: number; data?: string };
      };
      errorMessage = error.message || "Unknown error";
      // Better timeout detection
      if (error.code === "ECONNABORTED" || (error.message && error.message.includes("timeout"))) {
        timeoutError = true;
        errorMessage = "Request timed out";
      }

      if (error.response?.status !== undefined) {
        statusCode = error.response.status;
      }
      if (error.response?.data !== undefined) {
        resp = error.response.data;
      } else {
        resp = error.message || "";
      }
    } finally {
      const end = performance.now();
      latency = Math.round(end - start);
      if (resp === undefined || resp === null) {
        resp = "";
      }
    }

    let evalResp: EvalResponse | undefined = undefined;
    let modules = { cheerio };

    try {
      const evalFunction = new Function(
        "statusCode",
        "responseTime",
        "responseRaw",
        "modules",
        `return (${monitorEval})(statusCode, responseTime, responseRaw, modules);`,
      );
      evalResp = await evalFunction(statusCode, latency, resp, modules);
    } catch (error: unknown) {
      if (error instanceof Error) {
        if (error.message.length > 200) {
          errorMessage += ` | Eval error: ${error.message.substring(0, 200)}...`;
        } else {
          errorMessage += ` | Eval error: ${error.message}`;
        }
      } else {
        errorMessage += ` | Eval error: ${String(error)}`;
      }
    }

    if (!evalResp || typeof evalResp !== "object") {
      evalResp = {
        status: GC.DOWN,
        latency: latency,
        type: GC.ERROR,
      };
      errorMessage += " | Eval must return an object with 'status' and 'latency' fields, got no response";
    } else if (evalResp.status === undefined) {
      evalResp = {
        status: GC.DOWN,
        latency: latency,
        type: GC.ERROR,
      };
      errorMessage += ` | Eval must return an object with a 'status' field (one of: ${GC.UP}, ${GC.DOWN}, ${GC.DEGRADED}, ${GC.MAINTENANCE}), but 'status' was missing`;
    } else if (([GC.UP, GC.DOWN, GC.DEGRADED, GC.MAINTENANCE] as string[]).indexOf(evalResp.status) === -1) {
      evalResp = {
        status: GC.DOWN,
        latency: latency,
        type: GC.ERROR,
      };
      errorMessage += ` | Eval returned invalid 'status' value "${evalResp.status}". Must be one of: ${GC.UP}, ${GC.DOWN}, ${GC.DEGRADED}, ${GC.MAINTENANCE}`;
    } else {
      evalResp.type = GC.REALTIME;
      // Ensure latency is a valid number; fall back to measured latency
      if (typeof evalResp.latency !== "number" || isNaN(evalResp.latency)) {
        errorMessage += ` | Eval 'latency' must be a number, got ${JSON.stringify(evalResp.latency)}. Using measured latency instead`;
        evalResp.latency = latency;
      }
    }

    let toWrite: MonitoringResult = {
      status: GC.DOWN,
      latency: latency,
      type: GC.ERROR,
      error_message: errorMessage,
    };
    if (evalResp.status !== undefined && evalResp.status !== null) {
      toWrite.status = evalResp.status;
    }
    if (evalResp.latency !== undefined && evalResp.latency !== null) {
      toWrite.latency = evalResp.latency;
    }
    if (evalResp.type !== undefined && evalResp.type !== null) {
      toWrite.type = evalResp.type;
    }
    if (timeoutError) {
      toWrite.type = GC.TIMEOUT;
    }

    return toWrite;
  }
}

export default ApiCall;
