import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";
import net from "node:net";

/**
 * Minimal PostgreSQL LISTEN client (simple protocol, trust/cleartext/md5/SCRAM-SHA-256, no TLS).
 * Bun 1.3.14's `Bun.sql` has no LISTEN support; this keeps one dedicated connection per
 * process and reconnects with backoff.
 */
export class PgListener {
  /**
   * @param {string} url postgres://user:pass@host:port/db
   * @param {string} channel
   * @param {(payload: string) => void} onNotify
   */
  constructor(url, channel, onNotify) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(channel))
      throw new Error("invalid channel");
    this.url = new URL(url);
    this.channel = channel;
    this.onNotify = onNotify;
    /** @type {net.Socket|null} */
    this.socket = null;
    this.closed = false;
    this.backoff = 250;
    /** @type {((err?: Error) => void)|null} */
    this.readyWaiter = null;
  }

  /** Resolve once LISTEN is acknowledged. */
  start() {
    return new Promise((resolve, reject) => {
      this.readyWaiter = (err) => (err ? reject(err) : resolve(undefined));
      this.connect();
    });
  }

  async close() {
    this.closed = true;
    const s = this.socket;
    this.socket = null;
    if (s && !s.destroyed) {
      try {
        s.end(msg("X", Buffer.alloc(0)));
      } catch {}
      s.destroy();
    }
  }

  connect() {
    if (this.closed) return;
    const u = this.url;
    const user = decodeURIComponent(u.username);
    const password = decodeURIComponent(u.password);
    const database = decodeURIComponent(u.pathname.replace(/^\//, "")) || user;
    const socket = net.connect({
      host: u.hostname,
      port: Number(u.port || 5432),
    });
    this.socket = socket;
    let buf = Buffer.alloc(0);
    /** @type {{ nonce: string, clientFirstBare: string, serverSignature?: string }|null} */
    let scram = null;
    let listening = false;

    socket.on("connect", () => {
      const params = Buffer.from(
        `user\0${user}\0database\0${database}\0application_name\0sunpride-api-listen\0\0`,
      );
      const head = Buffer.alloc(8);
      head.writeInt32BE(8 + params.length, 0);
      head.writeInt32BE(196608, 4);
      socket.write(Buffer.concat([head, params]));
    });

    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, /** @type {Buffer} */ (chunk)]);
      while (buf.length >= 5) {
        const type = String.fromCharCode(/** @type {number} */ (buf[0]));
        const len = buf.readInt32BE(1);
        if (buf.length < 1 + len) break;
        const body = buf.subarray(5, 1 + len);
        buf = buf.subarray(1 + len);
        try {
          if (type === "R") {
            const code = body.readInt32BE(0);
            if (code === 0) continue;
            if (code === 3) socket.write(msg("p", cstr(password)));
            else if (code === 5) {
              const salt = body.subarray(4, 8);
              const inner = md5hex(password + user);
              socket.write(
                msg(
                  "p",
                  cstr(
                    `md5${md5hex(Buffer.concat([Buffer.from(inner), salt]))}`,
                  ),
                ),
              );
            } else if (code === 10) {
              if (!body.subarray(4).toString().includes("SCRAM-SHA-256"))
                throw new Error("no SCRAM-SHA-256");
              const nonce = randomBytes(18).toString("base64");
              const clientFirstBare = `n=,r=${nonce}`;
              scram = { nonce, clientFirstBare };
              const first = Buffer.from(`n,,${clientFirstBare}`);
              const len4 = Buffer.alloc(4);
              len4.writeInt32BE(first.length, 0);
              socket.write(
                msg("p", Buffer.concat([cstr("SCRAM-SHA-256"), len4, first])),
              );
            } else if (code === 11) {
              if (!scram) throw new Error("unexpected SASL continue");
              const serverFirst = body.subarray(4).toString();
              const attrs = Object.fromEntries(
                serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]),
              );
              if (!attrs.r?.startsWith(scram.nonce))
                throw new Error("SCRAM nonce mismatch");
              const salted = pbkdf2Sync(
                password,
                Buffer.from(attrs.s ?? "", "base64"),
                Number(attrs.i),
                32,
                "sha256",
              );
              const clientKey = hmac(salted, "Client Key");
              const storedKey = createHash("sha256").update(clientKey).digest();
              const finalNoProof = `c=biws,r=${attrs.r}`;
              const authMessage = `${scram.clientFirstBare},${serverFirst},${finalNoProof}`;
              const sig = hmac(storedKey, authMessage);
              const proof = Buffer.alloc(clientKey.length);
              for (let i = 0; i < clientKey.length; i++)
                proof[i] =
                  /** @type {number} */ (clientKey[i]) ^
                  /** @type {number} */ (sig[i]);
              scram.serverSignature = hmac(
                hmac(salted, "Server Key"),
                authMessage,
              ).toString("base64");
              socket.write(
                msg(
                  "p",
                  Buffer.from(`${finalNoProof},p=${proof.toString("base64")}`),
                ),
              );
            } else if (code === 12) {
              const v = body.subarray(4).toString();
              if (!scram?.serverSignature || v !== `v=${scram.serverSignature}`)
                throw new Error("SCRAM server signature mismatch");
            } else throw new Error(`unsupported auth ${code}`);
          } else if (type === "Z") {
            if (!listening) {
              listening = true;
              socket.write(msg("Q", cstr(`LISTEN ${this.channel}`)));
            }
          } else if (type === "C") {
            if (body.toString().startsWith("LISTEN")) {
              this.backoff = 250;
              const w = this.readyWaiter;
              this.readyWaiter = null;
              w?.();
            }
          } else if (type === "A") {
            let off = 4;
            const chanEnd = body.indexOf(0, off);
            off = chanEnd + 1;
            const payload = body.subarray(off, body.indexOf(0, off)).toString();
            try {
              this.onNotify(payload);
            } catch (err) {
              console.error("[listen] handler failed", err);
            }
          } else if (type === "E") {
            throw new Error(`postgres error: ${parseError(body)}`);
          }
        } catch (err) {
          socket.destroy(/** @type {Error} */ (err));
          return;
        }
      }
    });

    const retry = (/** @type {Error|undefined} */ err) => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.closed) return;
      if (
        this.readyWaiter &&
        err &&
        /auth|SCRAM|postgres error/.test(err.message)
      ) {
        const w = this.readyWaiter;
        this.readyWaiter = null;
        w(err);
        return;
      }
      const delay = this.backoff;
      this.backoff = Math.min(this.backoff * 2, 10_000);
      setTimeout(() => this.connect(), delay).unref?.();
    };
    socket.on("error", (err) => retry(err));
    socket.on("close", () => retry(undefined));
  }
}

/** @param {string} type @param {Buffer} body */
function msg(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0, "ascii");
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
}
/** @param {string} s */
const cstr = (s) => Buffer.from(`${s}\0`);
/** @param {string|Buffer} s */
const md5hex = (s) => createHash("md5").update(s).digest("hex");
/** @param {Buffer} key @param {string} data */
const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
/** @param {Buffer} body */
function parseError(body) {
  /** @type {Record<string,string>} */
  const fields = {};
  let off = 0;
  while (off < body.length && body[off] !== 0) {
    const code = String.fromCharCode(/** @type {number} */ (body[off]));
    const end = body.indexOf(0, off + 1);
    fields[code] = body.subarray(off + 1, end).toString();
    off = end + 1;
  }
  return `${fields.C ?? ""} ${fields.M ?? ""}`.trim();
}
