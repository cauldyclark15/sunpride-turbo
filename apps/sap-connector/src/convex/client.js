import { createHmac } from "node:crypto";

export function sign(secret, timestamp, body) {
  return createHmac("sha256", secret)
    .update(`${timestamp}.${body}`)
    .digest("hex");
}

export class ConvexIntegrationClient {
  constructor({ baseUrl, signingSecret }) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.signingSecret = signingSecret;
  }
  async request(path, init = {}) {
    const body = init.body ? JSON.stringify(init.body) : "";
    const timestamp = String(Date.now());
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: init.method ?? "GET",
      body: body || undefined,
      headers: {
        "content-type": "application/json",
        "x-sunpride-timestamp": timestamp,
        "x-sunpride-signature": sign(this.signingSecret, timestamp, body),
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new Error(
        `Convex integration request failed: ${response.status} ${await response.text()}`,
      );
    return response.json();
  }
  publish(envelope) {
    return this.request("/api/sap/events", { method: "POST", body: envelope });
  }
  tasks() {
    return this.request("/api/sap/tasks");
  }
  acknowledge(body) {
    return this.request("/api/sap/tasks/ack", { method: "POST", body });
  }
  heartbeat(body) {
    return this.request("/api/sap/heartbeat", { method: "POST", body });
  }
}
