/**
 * test/fixtures/doubles.ts — the seed install.sh drops into a repo that has none.
 *
 * WHAT MAY LIVE IN THIS FILE, and the rule is narrow on purpose: a factory
 * belongs here only if it is true for ANY node service. `stub` and `spy` are
 * shapes, not collaborators. An Express request/response pair is the framework's
 * own contract, identical in every service that mounts a handler. Everything
 * below that line — a row out of this service's schema, its cache client, its
 * provider SDK, its logger — is SERVICE knowledge, and a template that guesses it
 * ships a double that silently does not match the thing it replaces. That is the
 * same defect as naming a factory that does not exist, pointing the other way.
 *
 * ONE NAME THE PIPELINE ITSELF INJECTS IS HERE: `ioredisMiss()`. The default
 * policy (`real-except-cache`, and `right-level`) mocks the `ioredis` PACKAGE in
 * every row of a repo that depends on it, so the double stands for that
 * package's own API — `get` → null, `set` → "OK", `on`, `quit`, `status` — which
 * is the same in every repo that installs it. It is not a guess at a service.
 * It was left out once on the argument that it is the repo's transport, and
 * every ioredis repo on a fresh clone then died in stage 4: ai-centralization
 * `20260922T213127Z`, record.mjs exit 1 for the whole batch (fix plan 1, F1.1).
 *
 * `axiosSilenced()` is still NOT here. That injection is switched off (axios is
 * a transport, not an endpoint), and a repo that turns it back on writes it
 * against its own senders. `policy.mjs` reads this file (`doublesExport`) and a
 * row that needs an absent double is skipped with a named pipeline defect.
 *
 * `record.mjs` reads this file unconditionally, hashes it into `harnessVersion`,
 * and every emitted spec opens `import * as doubles from "<...>/doubles.ts"` —
 * so every export here is reachable as `doubles.<name>` from a proposal's
 * `build`, and nothing else is.
 *
 * `install.sh` carries a FALLBACK copy of `stub`, `spy` and `FIXED_UUID` in a
 * heredoc, for the case where this template cannot be copied. Those three are the
 * floor and must keep behaving exactly as they do there; add to this file, never
 * change them out from under it.
 */

/** A value a stubbed method answers with, in the four shapes a boundary can answer. */
export type StubAnswer = {
  resolves?: unknown;
  rejects?: unknown;
  returns?: unknown;
  throws?: unknown;
};

/**
 * An object of methods, one per key, each answering from its own spec.
 *
 * This is a NAMESPACE of callables — `stub({ findFirst: { resolves: row } })` is
 * something whose `.findFirst()` resolves, not something that IS callable. A
 * boundary read by property (`prisma.user.findFirst()`) needs a stub per level:
 * `stub({ findFirst: … })` nested inside a plain object under `user`.
 */
export function stub(spec: Record<string, StubAnswer>) {
  const out: Record<string, unknown> = {};
  for (const [n, s] of Object.entries(spec)) out[n] = (..._a: unknown[]) => {
    if ("rejects" in s) return Promise.reject(s.rejects);
    if ("resolves" in s) return Promise.resolve(s.resolves);
    if ("throws" in s) throw s.throws;
    return s.returns;
  };
  return out;
}

/** A callable that records every call and answers `undefined`. `spy().calls` is the log. */
export function spy() { const calls: unknown[][] = []; const f = (...a: unknown[]) => { calls.push(a); return undefined; }; (f as any).calls = calls; return f; }

/** One uuid, so a recorded pair does not differ from itself run to run. */
export const FIXED_UUID = "00000000-0000-4000-8000-000000000000";

/**
 * The `ioredis` PACKAGE, in the state the policy wants: connected, and every
 * lookup MISSES.
 *
 *   vi.mock("ioredis", () => ({ default: doubles.ioredisMiss() }))  // what record.mjs injects
 *
 * Answers a CLASS, not an instance, because that is what `ioredis` exports and
 * what the subject does with it: `new Redis(options)`. The options are kept on
 * the instance (`.options`), and every constructed instance is on the class's
 * own `instances`, because a row that wants `retryStrategy` can only reach it
 * through the options literal the subject wrote inline. A fresh class per call,
 * so no instance outlives the row that built it.
 *
 * WHY A MISS. `tools/policy.mjs`: "a cache that ANSWERS is a cache that hides
 * the call underneath it". A miss is transparent — the cache wrapper takes the
 * compute path and the real query below it runs. So every read answers the
 * protocol's reply for a key that is not there (`get` → null, `mget` → nulls,
 * `hgetall` → {}, `ttl` → -2, `exists` → 0), and a write answers the
 * protocol's success reply without creating a hit: `set` → "OK", which is also
 * what `SET key v NX PX ttl` answers when the lock is acquired, so a
 * request-coalescing leader runs the wrapped function rather than waiting on a
 * lock nobody holds. `SET … XX` and `SET … GET` answer null, as they do on a
 * missing key.
 *
 * CONNECTED, because a client that never connects takes a different arm:
 * `status` is "ready" and "connect" then "ready" are emitted to the listeners
 * the subject registered — on a microtask after construction, or from
 * `connect()` for `lazyConnect: true`. "error" and "close" are never emitted;
 * inventing a failure is a branch the harness chose.
 *
 * Every command is recorded on the instance's `calls`, so the recording shows
 * what the subject asked the cache even though the cache had nothing. A
 * trailing Node-style callback is called too, as ioredis does. `pipeline()` and
 * `multi()` queue the same commands and `exec()` answers `[[null, reply], …]`.
 * A command that is not listed is absent, not invented: a subject calling one
 * fails visibly on it.
 */
export function ioredisMiss() {
  type Call = { method: string; args: unknown[] };
  const flatArgs = (a: unknown[]) => (a as any[]).flat(Infinity) as unknown[];
  const hasFlag = (a: unknown[], flag: string) => a.some((x) => typeof x === "string" && x.toUpperCase() === flag);
  const num = (x: unknown, dflt = 1) => (x === undefined ? dflt : Number(x));
  // Each reply is the protocol's answer for a key that does not exist.
  const replies: Record<string, (...a: any[]) => unknown> = {
    get: () => null, getdel: () => null, getex: () => null, getset: () => null, getBuffer: () => null,
    hget: () => null, lpop: () => null, rpop: () => null, spop: () => null, lindex: () => null,
    srandmember: () => null, zscore: () => null, eval: () => null, evalsha: () => null,
    mget: (...a) => flatArgs(a).map(() => null),
    hmget: (_k, ...f) => flatArgs(f).map(() => null),
    set: (...a) => (hasFlag(a, "XX") || hasFlag(a, "GET") ? null : "OK"),
    setex: () => "OK", psetex: () => "OK", mset: () => "OK", hmset: () => "OK",
    flushdb: () => "OK", flushall: () => "OK", select: () => "OK", auth: () => "OK",
    setnx: () => 1, msetnx: () => 1, hsetnx: () => 1,
    del: () => 0, unlink: () => 0, exists: () => 0, expire: () => 0, pexpire: () => 0,
    expireat: () => 0, pexpireat: () => 0, persist: () => 0, hdel: () => 0, srem: () => 0,
    zrem: () => 0, lrem: () => 0, hexists: () => 0, sismember: () => 0,
    llen: () => 0, scard: () => 0, zcard: () => 0, hlen: () => 0, strlen: () => 0, dbsize: () => 0,
    publish: () => 0,
    ttl: () => -2, pttl: () => -2,
    incr: () => 1, decr: () => -1,
    incrby: (_k, n) => num(n), decrby: (_k, n) => -num(n), hincrby: (_k, _f, n) => num(n),
    incrbyfloat: (_k, n) => String(num(n)),
    hset: (_k, ...rest) => {
      const f = flatArgs(rest);
      return f.length === 1 && f[0] !== null && typeof f[0] === "object" ? Object.keys(f[0] as object).length : Math.floor(f.length / 2);
    },
    sadd: (_k, ...m) => flatArgs(m).length, lpush: (_k, ...v) => flatArgs(v).length, rpush: (_k, ...v) => flatArgs(v).length,
    zadd: (_k, ...rest) => Math.floor(rest.filter((x) => typeof x !== "string" || !/^(NX|XX|GT|LT|CH|INCR)$/i.test(x)).length / 2),
    keys: () => [], lrange: () => [], smembers: () => [], zrange: () => [], zrangebyscore: () => [],
    zrevrange: () => [], hkeys: () => [], hvals: () => [], sinter: () => [], sunion: () => [],
    hgetall: () => ({}),
    scan: () => ["0", []], sscan: () => ["0", []], hscan: () => ["0", []], zscan: () => ["0", []],
    type: () => "none", ping: () => "PONG", echo: (m) => m,
    subscribe: (...c) => flatArgs(c).filter((x) => typeof x !== "function").length,
    psubscribe: (...c) => flatArgs(c).filter((x) => typeof x !== "function").length,
    unsubscribe: () => 0, punsubscribe: () => 0,
    quit: () => "OK",
  };

  class IoredisMiss {
    static instances: IoredisMiss[] = [];
    options: Record<string, any>;
    args: unknown[];
    status = "wait";
    calls: Call[] = [];
    private listeners = new Map<string, Array<{ fn: (...a: unknown[]) => unknown; once: boolean }>>();
    [command: string]: any;

    constructor(...args: unknown[]) {
      this.args = args;
      // new Redis(), new Redis(port, host?, options?), new Redis(url, options?), new Redis(options)
      const opts = args.find((a) => a !== null && typeof a === "object") as Record<string, any> | undefined;
      this.options = { ...(opts ?? {}) };
      if (typeof args[0] === "number") this.options.port ??= args[0];
      if (typeof args[0] === "string") this.options.url ??= args[0];
      if (typeof args[1] === "string") this.options.host ??= args[1];
      IoredisMiss.instances.push(this);
      for (const [name, reply] of Object.entries(replies)) {
        this[name] = (...a: unknown[]) => this.command(name, a, reply);
      }
      if (!this.options.lazyConnect) {
        this.status = "connecting";
        Promise.resolve().then(() => this.markReady());
      }
    }

    private command(name: string, a: unknown[], reply: (...a: any[]) => unknown) {
      const cb = typeof a[a.length - 1] === "function" ? (a.pop() as (e: unknown, r?: unknown) => void) : undefined;
      this.calls.push({ method: name, args: a });
      const r = reply(...a);
      if (cb) Promise.resolve().then(() => cb(null, r));
      return Promise.resolve(r);
    }

    private markReady() {
      if (this.status === "ready" || this.status === "end") return;
      this.status = "ready";
      this.emit("connect");
      this.emit("ready");
    }

    connect(cb?: (e: unknown) => void) {
      this.calls.push({ method: "connect", args: [] });
      return Promise.resolve().then(() => {
        this.markReady();
        if (typeof cb === "function") cb(null);
      });
    }

    disconnect() { this.calls.push({ method: "disconnect", args: [] }); this.status = "end"; return undefined; }

    duplicate(override: Record<string, unknown> = {}) {
      this.calls.push({ method: "duplicate", args: [override] });
      return new IoredisMiss({ ...this.options, ...override });
    }

    defineCommand(name: string, ...rest: unknown[]) {
      this.calls.push({ method: "defineCommand", args: [name, ...rest] });
      this[name] = (...a: unknown[]) => this.command(name, a, () => null);
    }

    private queue(kind: "pipeline" | "multi", initial: unknown[][] = []) {
      const queued: Array<{ name: string; args: unknown[] }> = [];
      const chain: Record<string, any> = {};
      const add = (name: string, args: unknown[]) => { queued.push({ name, args }); return chain; };
      for (const name of Object.keys(replies)) chain[name] = (...a: unknown[]) => add(name, a);
      for (const [name, ...args] of initial) add(String(name), args);
      chain.exec = (cb?: (e: unknown, r?: unknown) => void) => {
        this.calls.push({ method: `${kind}.exec`, args: queued.map((q) => [q.name, ...q.args]) });
        const out = queued.map((q) => {
          this.calls.push({ method: q.name, args: q.args });
          return [null, (replies[q.name] ?? (() => null))(...q.args)];
        });
        if (typeof cb === "function") Promise.resolve().then(() => cb(null, out));
        return Promise.resolve(out);
      };
      Object.defineProperty(chain, "length", { get: () => queued.length });
      return chain;
    }

    pipeline(commands?: unknown[][]) { return this.queue("pipeline", commands ?? []); }
    multi(commands?: unknown[][] | Record<string, unknown>) { return this.queue("multi", Array.isArray(commands) ? commands : []); }

    on(event: string, fn: (...a: unknown[]) => unknown) { return this.listen(event, fn, false); }
    addListener(event: string, fn: (...a: unknown[]) => unknown) { return this.listen(event, fn, false); }
    once(event: string, fn: (...a: unknown[]) => unknown) { return this.listen(event, fn, true); }
    off(event: string, fn: (...a: unknown[]) => unknown) {
      this.listeners.set(event, (this.listeners.get(event) ?? []).filter((l) => l.fn !== fn));
      return this;
    }
    removeListener(event: string, fn: (...a: unknown[]) => unknown) { return this.off(event, fn); }
    removeAllListeners(event?: string) {
      if (event === undefined) this.listeners.clear(); else this.listeners.delete(event);
      return this;
    }
    listenerCount(event: string) { return (this.listeners.get(event) ?? []).length; }
    emit(event: string, ...a: unknown[]) {
      const ls = this.listeners.get(event) ?? [];
      this.listeners.set(event, ls.filter((l) => !l.once));
      for (const l of ls) l.fn.apply(this, a);
      return ls.length > 0;
    }
    private listen(event: string, fn: (...a: unknown[]) => unknown, once: boolean) {
      this.calls.push({ method: once ? "once" : "on", args: [event] });
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), { fn, once }]);
      return this;
    }
  }
  return IoredisMiss;
}

/**
 * The node-redis v5 PACKAGE (`redis`, `@redis/client`), in the state the policy
 * wants: every lookup MISSES, and no socket is ever opened. It is `ioredisMiss()`
 * for the other Redis client, under the same policy, for the same reason.
 *
 *   out.createClient = doubles.nodeRedisMiss()   // what record.mjs injects, kind "value"
 *
 * Answers `createClient` ITSELF, a factory, because that is what the package
 * exports and what the subject calls: `createClient(options)`. Each call builds a
 * fresh client, so a service that makes a client and a subscriber gets two. The
 * options are kept on the client (`.options`) and every client is on the
 * factory's own `clients`, because a row that wants `socket.reconnectStrategy`
 * can only reach it through the options literal the subject wrote.
 *
 * WHY. The real client dials `redis://localhost:6379` in a mocked run and gets
 * ECONNREFUSED, and its reconnect strategy retries on a TIMER. Each retry fires
 * the subject's `on("error")` listener, so a varying number of `logger.error(
 * "Redis Client Error:")` calls landed in each row's call list and the emitted
 * test saw a different list: qode-ptp-ms, September 2026, cigate withheld 162
 * tests and 161 of them had those calls.
 *
 * NODE-REDIS SEMANTICS, NOT IOREDIS'S. The client starts CLOSED (`isOpen` and
 * `isReady` false) and opens only on `connect()`, which emits "connect" then
 * "ready" to the subject's listeners and resolves the client. A second
 * `connect()` on an open client rejects "Socket already opened", and a command
 * on a closed client rejects `ClientClosedError`, "The client is closed" — both
 * are what the real client does, without any server. "error" and
 * "reconnecting" are never emitted: inventing a failure is a branch the harness
 * chose. `close()` / `quit()` / `destroy()` / `disconnect()` close it and emit
 * "end".
 *
 * Every reply is the protocol's answer for a key that is not there, in v5's
 * shapes: `get` → null, `mGet` → nulls, `hGetAll` → {}, `exists`/`del`/`expire`
 * → 0, `ttl` → -2, `keys` → [], `scan` → `{ cursor: "0", keys: [] }`, `info` →
 * "". A write answers success without creating a hit: `set` → "OK" (null with
 * `XX` or `GET`, as on a missing key), `setEx` → "OK". Each command is reachable
 * by its camelCase name and its upper-case one (`get` and `GET`). `multi()`
 * queues the same commands and `exec()` answers the replies in order. Every
 * command is recorded on the client's `calls`. A command that is not listed is
 * absent, not invented: a subject calling one fails visibly on it.
 */
export function nodeRedisMiss() {
  type Call = { method: string; args: unknown[] };
  type Listener = { fn: (...a: unknown[]) => unknown; once: boolean };
  const flatArgs = (a: unknown[]) => (a as any[]).flat(Infinity) as unknown[];
  const num = (x: unknown, dflt = 1) => (x === undefined ? dflt : Number(x));
  // `set(key, value, { XX: true })`, `{ condition: "XX" }`, `{ GET: true }` - or the flags as strings.
  const setAnswersNull = (a: unknown[]) =>
    a.slice(2).some((x) =>
      typeof x === "string"
        ? /^(XX|GET)$/i.test(x)
        : x !== null && typeof x === "object" && ((x as any).XX === true || (x as any).GET === true || String((x as any).condition ?? "").toUpperCase() === "XX")
    );
  // Each reply is the protocol's answer for a key that does not exist, in node-redis v5's shape.
  const replies: Record<string, (...a: any[]) => unknown> = {
    get: () => null, getDel: () => null, getEx: () => null, getSet: () => null,
    hGet: () => null, lPop: () => null, rPop: () => null, sPop: () => null, lIndex: () => null,
    sRandMember: () => null, zScore: () => null, randomKey: () => null,
    eval: () => null, evalSha: () => null, evalRo: () => null, evalShaRo: () => null,
    mGet: (...a) => flatArgs(a).map(() => null),
    hmGet: (_k, ...f) => flatArgs(f).map(() => null),
    set: (...a) => (setAnswersNull(a) ? null : "OK"),
    setEx: () => "OK", pSetEx: () => "OK", mSet: () => "OK",
    flushDb: () => "OK", flushAll: () => "OK", auth: () => "OK",
    setNX: () => 1, mSetNX: () => 1, hSetNX: () => 1,
    del: () => 0, unlink: () => 0, exists: () => 0, touch: () => 0,
    expire: () => 0, pExpire: () => 0, expireAt: () => 0, pExpireAt: () => 0, persist: () => 0,
    hDel: () => 0, sRem: () => 0, zRem: () => 0, lRem: () => 0, hExists: () => 0, sIsMember: () => 0,
    lLen: () => 0, sCard: () => 0, zCard: () => 0, hLen: () => 0, strLen: () => 0, dbSize: () => 0,
    publish: () => 0, sPublish: () => 0,
    ttl: () => -2, pTTL: () => -2,
    incr: () => 1, decr: () => -1,
    incrBy: (_k, n) => num(n), decrBy: (_k, n) => -num(n), hIncrBy: (_k, _f, n) => num(n),
    incrByFloat: (_k, n) => String(num(n)),
    hSet: (_k, ...rest) => {
      const f = flatArgs(rest);
      return f.length === 1 && f[0] !== null && typeof f[0] === "object" ? Object.keys(f[0] as object).length : Math.floor(f.length / 2);
    },
    sAdd: (_k, ...m) => flatArgs(m).length, lPush: (_k, ...v) => flatArgs(v).length, rPush: (_k, ...v) => flatArgs(v).length,
    zAdd: (_k, ...m) => flatArgs(m).length,
    keys: () => [], lRange: () => [], sMembers: () => [], zRange: () => [], zRangeByScore: () => [],
    hKeys: () => [], hVals: () => [], sInter: () => [], sUnion: () => [], sDiff: () => [],
    hGetAll: () => ({}),
    scan: () => ({ cursor: "0", keys: [] }),
    sScan: () => ({ cursor: "0", members: [] }),
    hScan: () => ({ cursor: "0", entries: [] }),
    zScan: () => ({ cursor: "0", members: [] }),
    type: () => "none", ping: () => "PONG", echo: (m) => m, info: () => "",
    select: () => "OK",
  };
  const closed = () => Object.assign(new Error("The client is closed"), { name: "ClientClosedError" });

  const clients: Array<Record<string, any>> = [];
  const createClient = (options: Record<string, any> = {}): Record<string, any> => {
    const calls: Call[] = [];
    const listeners = new Map<string, Listener[]>();
    let open = false;
    let ready = false;
    const client: Record<string, any> = { options: { ...(options ?? {}) }, calls };

    const emit = (event: string, ...a: unknown[]) => {
      const ls = listeners.get(event) ?? [];
      listeners.set(event, ls.filter((l) => !l.once));
      for (const l of ls) l.fn.apply(client, a);
      return ls.length > 0;
    };
    const listen = (event: string, fn: (...a: unknown[]) => unknown, once: boolean) => {
      calls.push({ method: once ? "once" : "on", args: [event] });
      listeners.set(event, [...(listeners.get(event) ?? []), { fn, once }]);
      return client;
    };
    const command = (name: string, a: unknown[], reply: (...a: any[]) => unknown) => {
      calls.push({ method: name, args: a });
      if (!open) return Promise.reject(closed());
      return Promise.resolve(reply(...a));
    };
    const shut = (method: string, answer: unknown) => {
      calls.push({ method, args: [] });
      const was = open;
      open = false;
      ready = false;
      if (was) emit("end");
      return Promise.resolve(answer);
    };

    for (const [name, reply] of Object.entries(replies)) {
      client[name] = (...a: unknown[]) => command(name, a, reply);
      client[name.toUpperCase()] = client[name];
    }
    Object.defineProperty(client, "isOpen", { get: () => open, enumerable: true });
    Object.defineProperty(client, "isReady", { get: () => ready, enumerable: true });
    Object.defineProperty(client, "isPubSubActive", { get: () => false, enumerable: true });

    client.connect = async () => {
      calls.push({ method: "connect", args: [] });
      if (open) throw new Error("Socket already opened");
      open = true;
      await Promise.resolve();
      emit("connect");
      ready = true;
      emit("ready");
      return client;
    };
    client.close = () => shut("close", undefined);
    client.quit = client.QUIT = () => shut("quit", "OK");
    client.destroy = () => { void shut("destroy", undefined); return undefined; };
    client.disconnect = () => shut("disconnect", undefined);
    client.duplicate = (overrides: Record<string, any> = {}) => {
      calls.push({ method: "duplicate", args: [overrides] });
      return createClient({ ...client.options, ...overrides });
    };
    client.sendCommand = (args: unknown[] = []) => {
      const name = String((args as unknown[])[0] ?? "");
      const hit = Object.keys(replies).find((k) => k.toUpperCase() === name.toUpperCase());
      return command(`sendCommand:${name.toUpperCase()}`, (args as unknown[]).slice(1), hit ? replies[hit] : () => null);
    };
    for (const name of ["subscribe", "unsubscribe", "pSubscribe", "pUnsubscribe", "sSubscribe", "sUnsubscribe"]) {
      client[name] = (channels: unknown, ..._rest: unknown[]) => command(name, [channels], () => undefined);
      client[name.toUpperCase()] = client[name];
    }
    const iterator = (name: string) => async function* (..._a: unknown[]) { calls.push({ method: name, args: _a }); if (!open) throw closed(); };
    client.scanIterator = iterator("scanIterator");
    client.hScanIterator = iterator("hScanIterator");
    client.sScanIterator = iterator("sScanIterator");
    client.zScanIterator = iterator("zScanIterator");

    client.multi = client.MULTI = () => {
      const queued: Array<{ name: string; args: unknown[] }> = [];
      const chain: Record<string, any> = {};
      for (const name of Object.keys(replies)) {
        chain[name] = (...a: unknown[]) => { queued.push({ name, args: a }); return chain; };
        chain[name.toUpperCase()] = chain[name];
      }
      chain.addCommand = (args: unknown[] = []) => { queued.push({ name: String(args[0] ?? ""), args: args.slice(1) }); return chain; };
      const exec = (kind: string) => () => {
        calls.push({ method: kind, args: queued.map((q) => [q.name, ...q.args]) });
        if (!open) return Promise.reject(closed());
        return Promise.resolve(queued.map((q) => {
          calls.push({ method: q.name, args: q.args });
          const hit = Object.keys(replies).find((k) => k.toUpperCase() === q.name.toUpperCase());
          return (hit ? replies[hit] : () => null)(...q.args);
        }));
      };
      chain.exec = chain.EXEC = exec("multi.exec");
      chain.execAsPipeline = exec("multi.execAsPipeline");
      return chain;
    };

    client.on = (event: string, fn: (...a: unknown[]) => unknown) => listen(event, fn, false);
    client.addListener = client.on;
    client.once = (event: string, fn: (...a: unknown[]) => unknown) => listen(event, fn, true);
    client.off = (event: string, fn: (...a: unknown[]) => unknown) => {
      listeners.set(event, (listeners.get(event) ?? []).filter((l) => l.fn !== fn));
      return client;
    };
    client.removeListener = client.off;
    client.removeAllListeners = (event?: string) => {
      if (event === undefined) listeners.clear(); else listeners.delete(event);
      return client;
    };
    client.listenerCount = (event: string) => (listeners.get(event) ?? []).length;
    client.emit = emit;
    client.ref = () => undefined;
    client.unref = () => undefined;

    clients.push(client);
    return client;
  };
  return Object.assign(createClient, { clients });
}

/* ==========================================================================
 * REUSABLE BOUNDARY ADAPTERS
 *
 * A TOOL HAS THE TYPES. IT DOES NOT HAVE THE DOMAIN. Everything below supplies
 * the SHAPE a collaborator must have — the methods, the call signature, the
 * chaining, the record of what it was handed — and NEVER the value it answers
 * with. `prismaClient({ user: {} }).user.findFirst()` throws; it does not hand
 * back a row. Knowing that a row's `countryId` has to match the country in the
 * other query result is domain knowledge no type carries, so it stays with the
 * agent, every time. An adapter that shipped a plausible default would let a row
 * validate, record and FREEZE a value nobody chose, which is the worst outcome
 * available here — worse than the `TypeError` a missing method throws, because
 * that one an agent notices.
 *
 * MEASURED, twice, on blind runs against a real service: "I wrote the Express
 * doubles and the decorator appliers as inline `build` expressions", and a
 * per-row monkey-patch of a shared fixture that "silently diverges between
 * rows". The PLUMBING is mechanical and repeated, so it lives here. The PAYLOAD
 * is domain work and does not.
 *
 * WHY THESE FOUR SHAPES ARE GENERIC. Each one is a PACKAGE IDENTITY or a
 * PLATFORM contract, which is the same basis `tools/policy.mjs` classifies
 * boundaries on: "`@prisma/client` means the same thing in ai-centralization,
 * location-ms and a repo neither of them has heard of; `CachedLangfusePrompt`
 * did not." A delegate method list, `fetch`'s two arguments, the Redis command
 * names and the shape of a decorator are facts about the package or the
 * platform. A row out of a schema, a cache key, a URL and a status code are
 * facts about a service, and none of them is here.
 *
 * WHAT THESE ADAPTERS DO NOT DO: DECIDE WHETHER A BOUNDARY MAY BE ANSWERED AT
 * ALL. `policy.mjs` decides that, per symbol, from the target's own scan, and it
 * cannot see how a `build` expression was written. A database or a downstream
 * classifies REAL, and in a live `--policy real-except-cache` run record.mjs
 * DROPS the declared answer for an observing passthrough (record.mjs's `live`
 * flag) — arranging one of these by hand or by adapter makes no difference to
 * that. What they are for is the arrangements the policy does permit: a MOCKED
 * run, where "there is no real call for a mocked run to defer to" and the
 * declared answer is the only boundary there is; `--policy as-declared`; the
 * cache, which is the one legitimate mock point; a wrapper strictly below the
 * row's arms; and the in-process case where the row is arranging ITSELF.
 *
 * PLACEMENT: these stay ABOVE `expressResponse`. The genericity guard in
 * `tests/doubles.express-response-surface.test.mjs` reads from that export to
 * the end of the file and refuses a service's vocabulary there; moving a
 * package name below it would fail that check for the right reason at the wrong
 * place.
 * ========================================================================== */

/**
 * The one error every adapter raises instead of inventing an answer.
 *
 * NOT EXPORTED, on purpose: every export in this file has to be buildable from
 * no arguments (the named-factories test calls each one), and a bare throw is
 * not. Thrown SYNCHRONOUSLY even for a method whose real counterpart returns a
 * promise — an unawaited rejection would land as an unhandled rejection in some
 * other row's output, where nobody can attribute it, and a throw at the call
 * site cannot be lost. It names the double, so a subject that swallows it into
 * its own catch arm still records WHOSE failure it was.
 */
function notConfigured(where: string, hint: string): never {
  const e = new Error(`${where}: nothing was configured for this call, and a double does not get to choose one. ${hint}`);
  e.name = "DoubleNotConfigured";
  throw e;
}

/**
 * Answer from one `StubAnswer`, in `stub`'s four shapes and `stub`'s order.
 *
 * ONE DELIBERATE DIFFERENCE from `stub`: an answer carrying none of the four
 * keys is NOT configured, and throws, where `stub` answers `undefined`. `stub`
 * is the floor `install.sh` also carries and does not change; an adapter is new,
 * and `{}` meaning "undefined" is exactly the silent default this file exists to
 * refuse. A row that means `undefined` writes `{ returns: undefined }`.
 */
function answerFrom(spec: StubAnswer, where: string, hint: string): unknown {
  if ("rejects" in spec) return Promise.reject(spec.rejects);
  if ("resolves" in spec) return Promise.resolve(spec.resolves);
  if ("throws" in spec) throw spec.throws;
  if ("returns" in spec) return spec.returns;
  return notConfigured(where, hint);
}

/**
 * The delegate method list every Prisma model gets, in every repo that has one.
 *
 * This is the package's own generated surface, not a service's: the names come
 * from `@prisma/client`'s delegate type, so a model called `user` and a model
 * called `googleLocation` have exactly these. WHICH MODELS EXIST is the schema's
 * business and therefore the row's — `prismaClient()` invents none.
 */
const PRISMA_DELEGATE_METHODS = [
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow", "findMany",
  "create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert",
  "delete", "deleteMany", "count", "aggregate", "groupBy",
];

/**
 * A Prisma-shaped client. It is CALLABLE and OBSERVABLE; it answers nothing.
 *
 *   doubles.prismaClient({ user: { findFirst: { resolves: theRowThisRowChose } } })
 *
 * Keys that start with `$` are the client's own API and are stubbed at the top
 * level (`{ $queryRaw: { resolves: [...] } }`); every other key is a MODEL, and
 * gets a delegate carrying the whole method list above. A delegate method the
 * row did not configure EXISTS — `typeof client.user.findFirst === "function"`,
 * so a subject that passes it around or feature-detects it behaves — and throws
 * the moment it is called, rather than resolving something plausible.
 *
 * WHAT IS IMPLEMENTED RATHER THAN STUBBED, and each one derives its answer from
 * the caller's own input, so none of them chooses anything:
 *
 *   `$transaction(fn)`   runs `fn` and answers with what IT answered, handing it
 *                        this same client — which is what the real one does with
 *                        its transactional client. A synchronous throw comes
 *                        back as a rejection, as it does there.
 *   `$transaction([…])`  `Promise.all` over the promises the row itself built.
 *   `$connect`/`$disconnect`  resolve `undefined`, which is their real return
 *                        type (`Promise<void>`) and not an invented value.
 *   `$on`/`$use`         record the handler and answer `undefined`, as they do.
 *
 * DELIBERATELY ABSENT: `$extends`, because the real one answers a NEW extended
 * client and handing back this one would be a fiction; and every model, because
 * a schema is not a package fact.
 *
 * THE LOG IS `$calls`, NOT `calls`. `$` is the prefix the package reserves for
 * client-level API, so `$calls` is the one name a model can never collide with —
 * a service with a `Calls` table would otherwise have `prisma.calls` mean two
 * things at once.
 */
export function prismaClient(spec: Record<string, Record<string, StubAnswer> | StubAnswer> = {}) {
  const $calls: Array<{ model: string | null; method: string; args: unknown[] }> = [];
  const client: Record<string, any> = {
    $calls,
    $transaction(arg?: unknown, ...rest: unknown[]) {
      $calls.push({ model: null, method: "$transaction", args: [arg, ...rest] });
      if (typeof arg === "function") {
        try {
          return Promise.resolve((arg as (c: unknown) => unknown)(client));
        } catch (e) {
          return Promise.reject(e);
        }
      }
      if (Array.isArray(arg)) return Promise.all(arg);
      return notConfigured(
        "doubles.prismaClient().$transaction",
        "the real one takes an array of promises or a callback; it was handed neither, and what a third form would answer is this repo's to say."
      );
    },
    $connect() { $calls.push({ model: null, method: "$connect", args: [] }); return Promise.resolve(undefined); },
    $disconnect() { $calls.push({ model: null, method: "$disconnect", args: [] }); return Promise.resolve(undefined); },
    $on(...args: unknown[]) { $calls.push({ model: null, method: "$on", args }); return undefined; },
    $use(...args: unknown[]) { $calls.push({ model: null, method: "$use", args }); return undefined; },
  };
  for (const [name, entry] of Object.entries(spec)) {
    if (name.startsWith("$")) {
      const s = entry as StubAnswer;
      client[name] = (...args: unknown[]) => {
        $calls.push({ model: null, method: name, args });
        return answerFrom(s, `doubles.prismaClient().${name}`, "give it one of resolves/rejects/returns/throws.");
      };
      continue;
    }
    const methods = (entry ?? {}) as Record<string, StubAnswer>;
    const delegate: Record<string, any> = {};
    for (const method of new Set([...PRISMA_DELEGATE_METHODS, ...Object.keys(methods)])) {
      delegate[method] = (...args: unknown[]) => {
        $calls.push({ model: name, method, args });
        const s = methods[method];
        if (!s) {
          return notConfigured(
            `doubles.prismaClient().${name}.${method}`,
            "the row it answers with is domain knowledge no type carries — choose it in this proposal's build."
          );
        }
        return answerFrom(s, `doubles.prismaClient().${name}.${method}`, "give it one of resolves/rejects/returns/throws.");
      };
    }
    client[name] = delegate;
  }
  return client;
}

/**
 * A `Headers`-shaped bag, following the platform's contract and not express's.
 *
 * The two disagree and the difference is not cosmetic: `Headers#append` JOINS
 * with ", " into one string where express's `res.append` builds an ARRAY, and
 * `Headers#get` answers `null` for a header that is not there where express's
 * answers `undefined`. A double that copied the express behaviour onto a fetch
 * response would record a value the real response cannot produce. Iteration is
 * sorted by name, as the real one's is.
 */
function fetchHeaders(init: Record<string, unknown> = {}) {
  const store = new Map<string, string>();
  const sorted = () => [...store.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h: Record<string, any> = {
    get(name: string) { const v = store.get(String(name).toLowerCase()); return v === undefined ? null : v; },
    has(name: string) { return store.has(String(name).toLowerCase()); },
    set(name: string, value: unknown) { store.set(String(name).toLowerCase(), String(value)); return undefined; },
    append(name: string, value: unknown) {
      const at = String(name).toLowerCase();
      const prev = store.get(at);
      store.set(at, prev === undefined ? String(value) : `${prev}, ${String(value)}`);
      return undefined;
    },
    delete(name: string) { store.delete(String(name).toLowerCase()); return undefined; },
    forEach(cb: (value: string, name: string, parent: unknown) => void) { for (const [k, v] of sorted()) cb(v, k, h); },
    entries() { return sorted()[Symbol.iterator](); },
    keys() { return sorted().map((e) => e[0])[Symbol.iterator](); },
    values() { return sorted().map((e) => e[1])[Symbol.iterator](); },
  };
  (h as any)[Symbol.iterator] = () => sorted()[Symbol.iterator]();
  for (const [name, value] of Object.entries(init)) h.append(name, value);
  return h;
}

/**
 * A `fetch`-shaped Response. Every field is the platform's or the row's.
 *
 *   doubles.fetchResponse({ status: 404, json: whateverThisServiceReturns })
 *
 * `ok` is DERIVED from `status` (200–299) rather than settable, because it is
 * derived on the real one: letting a row set them apart would let it record a
 * response that cannot exist. `status` defaults to 200 and `statusText` to "",
 * which are `new Response()`'s own defaults — the same precedent as
 * `expressResponse`'s `statusCode: 200`, and checked against the real global in
 * `tests/doubles.boundary-adapters.test.mjs` rather than assumed.
 *
 * THE BODY IS NEVER INVENTED. `json()` and `text()` answer only from what the
 * row configured, and derive from EACH OTHER the way the real ones do — `text`
 * is the wire body, `json` is that body parsed, so configuring either answers
 * both, and unparseable text rejects with the `SyntaxError` a real `json()`
 * rejects with. Configure NEITHER and both throw: an empty body is a choice, and
 * a row that means one writes `{ text: "" }`.
 *
 * DELIBERATELY ABSENT: `body` (a stream this file would have to invent, landing
 * the payload somewhere `text()` cannot see — the same reason express's `write`
 * is absent), `clone`, `arrayBuffer`, `blob`, `formData`.
 */
export function fetchResponse(spec: Record<string, any> = {}) {
  const status = typeof spec.status === "number" ? spec.status : 200;
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const hasJson = Object.prototype.hasOwnProperty.call(spec, "json");
  const hasText = Object.prototype.hasOwnProperty.call(spec, "text");
  const NOTHING = "the payload is this service's, not the harness's — configure { json } or { text } on this row.";
  const res: Record<string, any> = {
    status,
    ok: status >= 200 && status < 300,
    statusText: typeof spec.statusText === "string" ? spec.statusText : "",
    url: typeof spec.url === "string" ? spec.url : "",
    redirected: spec.redirected === true,
    headers: fetchHeaders((spec.headers ?? {}) as Record<string, unknown>),
    calls,
    json() {
      calls.push({ method: "json", args: [] });
      if (hasJson) return Promise.resolve(spec.json);
      if (hasText) {
        try { return Promise.resolve(JSON.parse(String(spec.text))); } catch (e) { return Promise.reject(e); }
      }
      return notConfigured("doubles.fetchResponse().json", NOTHING);
    },
    text() {
      calls.push({ method: "text", args: [] });
      if (hasText) return Promise.resolve(String(spec.text));
      if (hasJson) return Promise.resolve(JSON.stringify(spec.json));
      return notConfigured("doubles.fetchResponse().text", NOTHING);
    },
  };
  return res;
}

/** What a `fetch(input, init)` call asked for, in the three shapes `input` comes in. */
function fetchRequestOf(input?: unknown, init?: unknown) {
  const i = input as any;
  const o = (init ?? {}) as any;
  const url =
    typeof i === "string" ? i
      : i && typeof i.url === "string" ? String(i.url)
        : i === undefined || i === null ? ""
          : String(i);
  const method = String(o.method ?? (i && typeof i.method === "string" ? i.method : "GET")).toUpperCase();
  return { url, method, headers: o.headers ?? (i ? i.headers : undefined), body: o.body ?? (i ? i.body : undefined) };
}

/**
 * A `fetch`-shaped callable that RECORDS and answers only what it was handed.
 *
 *   doubles.fetchStub([{ resolves: doubles.fetchResponse({ status: 200, json: … }) }])
 *
 * The answers are consumed IN ORDER, one per call, because a row that needs a
 * second call to answer differently from the first is stating a sequence and not
 * a rule. Run past the end and it throws, naming the method and URL it was asked
 * for — a fifth call the row did not plan for is a fact about the subject the
 * row should see, not a fourth answer repeated.
 *
 * `.calls` is the raw arguments, so nothing is ever swallowed; `.requests` is
 * the same calls normalised to `{ url, method, headers, body }`, which is the
 * mechanical part — `input` arrives as a string, a URL or a Request, and the
 * method defaults to GET, both of which are the platform's own rules and checked
 * against the real `Request` in the test.
 */
export function fetchStub(answers: StubAnswer[] = []) {
  const calls: unknown[][] = [];
  const requests: Array<{ url: string; method: string; headers: unknown; body: unknown }> = [];
  let next = 0;
  const f = (input?: unknown, init?: unknown) => {
    calls.push([input, init]);
    const request = fetchRequestOf(input, init);
    requests.push(request);
    const answer = answers[next];
    next += 1;
    if (!answer) {
      return notConfigured(
        `doubles.fetchStub() call ${next} (${request.method} ${request.url})`,
        `${answers.length} answer(s) were configured — what this call comes back with is this row's to choose.`
      );
    }
    return answerFrom(answer, `doubles.fetchStub() call ${next}`, "give it one of resolves/rejects/returns/throws.");
  };
  (f as any).calls = calls;
  (f as any).requests = requests;
  return f as typeof f & { calls: unknown[][]; requests: Array<{ url: string; method: string; headers: unknown; body: unknown }> };
}

/**
 * A cache client, in the state the pipeline's own policy requires: MISSING.
 *
 *   doubles.cacheClient()                      every lookup misses
 *   doubles.cacheClient({ store: { k: v } })   these hit, and only these
 *
 * WHY THE MISS IS NOT A CHOSEN VALUE, and this is the one adapter where a
 * default answer is legitimate: it is `tools/policy.mjs`'s stated rule, not an
 * invention — "Redis is mocked at `ioredis`, one level below the code under
 * test, in a state where every lookup MISSES", because "a cache that ANSWERS is
 * a cache that hides the call underneath it". `null` is the absence of a value,
 * not a plausible one, and it is what the protocol answers for a key that is not
 * there. A HIT is the opposite — a hit is a payload — so a hit only ever comes
 * from `store`, which the row writes.
 *
 * `set` RECORDS BUT DOES NOT CREATE A HIT, for the same reason: a row that
 * writes and then reads inside one subject call would otherwise take the cached
 * path and hide the recompute the row was aiming at. What it was handed is in
 * `.calls`, so the recording is not a lie — it is readable, it just is not a
 * lookup. `del` and `expire` DO act on `store`, because there the row has
 * already chosen the contents.
 *
 * THIS IS NOT `ioredisMiss()`. That one is a MODULE mock the policy injects
 * at the `ioredis` package itself, and it is a CLASS the subject constructs.
 * This is an OBJECT a row hands to a subject that takes a client. Different
 * seam, and a row picks the one its subject actually has.
 *
 * ONE-WORD COMMANDS ONLY, and that is the genericity line: `get`, `set`, `del`,
 * `exists`, `expire` are spelled identically by every client because they are
 * the Redis command names. The multi-word ones are not — `mget`/`mGet`,
 * `setex`/`setEx`, `hgetall`/`hGetAll` — so their spelling is a fact about WHICH
 * client a service installed, and shipping both spellings would claim a client
 * that has both. They are absent, and so is `ttl` (−1, −2 or a number is a
 * choice the row has to make), `incr` (which answers 1 on a missing key, i.e.
 * invents state) and `keys` (a glob over a store the row seeded, where a partial
 * pattern implementation mismatches silently).
 */
export function cacheClient(spec: { store?: Record<string, unknown> } = {}) {
  const store = new Map<string, unknown>(Object.entries(spec.store ?? {}));
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const client: Record<string, any> = {
    store,
    calls,
    get(key?: unknown) {
      calls.push({ method: "get", args: [key] });
      const k = String(key);
      return Promise.resolve(store.has(k) ? store.get(k) : null);
    },
    // "OK" is the protocol's own reply to SET, the same string in every client.
    set(...args: unknown[]) { calls.push({ method: "set", args }); return Promise.resolve("OK"); },
    del(...keys: unknown[]) {
      calls.push({ method: "del", args: keys });
      const flat = keys.flat();
      let removed = 0;
      for (const key of flat) if (store.delete(String(key))) removed += 1;
      return Promise.resolve(removed);
    },
    exists(...keys: unknown[]) {
      calls.push({ method: "exists", args: keys });
      return Promise.resolve(keys.flat().filter((key) => store.has(String(key))).length);
    },
    expire(key?: unknown, ...rest: unknown[]) {
      calls.push({ method: "expire", args: [key, ...rest] });
      return Promise.resolve(store.has(String(key)) ? 1 : 0);
    },
    quit() { calls.push({ method: "quit", args: [] }); return Promise.resolve("OK"); },
    // ioredis's is synchronous and void; awaiting `undefined` is harmless, so
    // this one shape serves a caller that awaits it and one that does not.
    disconnect() { calls.push({ method: "disconnect", args: [] }); return undefined; },
    // A client is an EventEmitter, and `EventEmitter#on` answers the emitter —
    // so this one does too, and the handler is recorded rather than fired. An
    // invented "error" event is a branch the harness chose.
    on(...args: unknown[]) { calls.push({ method: "on", args }); return client; },
    once(...args: unknown[]) { calls.push({ method: "once", args }); return client; },
    off(...args: unknown[]) { calls.push({ method: "off", args }); return client; },
  };
  return client;
}

/**
 * A decorator that decorates NOTHING, and is transparent about it.
 *
 *   const withSomething = doubles.decoratorApplier();
 *   const wrapped = withSomething(theSubjectsOwnFunction);
 *
 * The applier takes a function and answers a function that forwards its
 * arguments AND its `this` to the original and answers with exactly what the
 * original answered — or throws exactly what it threw. That is the whole point:
 * the decorated path runs, so the arms inside the wrapped function are the ones
 * the row reaches, and nothing about the result is the harness's.
 *
 * Observable at both levels: `.calls` on the applier is what it was asked to
 * decorate, `.calls` on each wrapped function is every invocation with its
 * `returned` or `threw`.
 *
 * Handed something that is not a function, it throws rather than guessing which
 * argument was meant. A CURRIED decorator — `withThing(options)(fn)` — is one
 * expression away and is not modelled, because deciding whether a call is the
 * options call or the function call from the arguments is exactly the guess this
 * file refuses: write `() => doubles.decoratorApplier()`.
 */
export function decoratorApplier() {
  const calls: unknown[][] = [];
  const apply = (fn?: unknown, ...rest: unknown[]) => {
    calls.push([fn, ...rest]);
    if (typeof fn !== "function") {
      return notConfigured(
        "doubles.decoratorApplier()",
        `it decorates a function and was handed ${fn === null ? "null" : typeof fn}.`
      );
    }
    const target = fn as (...a: unknown[]) => unknown;
    const invocations: Array<{ args: unknown[]; returned?: unknown; threw?: unknown }> = [];
    const wrapped = function (this: unknown, ...args: unknown[]) {
      const invocation: { args: unknown[]; returned?: unknown; threw?: unknown } = { args };
      invocations.push(invocation);
      try {
        const out = target.apply(this, args);
        invocation.returned = out;
        return out;
      } catch (e) {
        invocation.threw = e;
        throw e;
      }
    };
    (wrapped as any).calls = invocations;
    return wrapped as typeof wrapped & { calls: typeof invocations };
  };
  (apply as any).calls = calls;
  return apply as typeof apply & { calls: unknown[][] };
}

/**
 * The other half of the same shape: a wrapper that RUNS the callback it is
 * handed, rather than answering instead of it.
 *
 *   doubles.callbackRunner()          the producer runs and its result is the answer
 *   doubles.callbackRunner(theTx)     and it is handed `theTx`, which the row chose
 *
 * This is the `wrap(key, () => load())` / `runInTransaction(cb)` / `retry(fn)`
 * shape. It answers with EXACTLY what the callback answered — a promise stays a
 * promise, and nothing is wrapped in one, because whether the real wrapper is
 * async is the wrapper's affair and `await` on a plain value is harmless either
 * way. The arguments handed to the callback are the ones the row passed to this
 * factory; the default is none.
 *
 * A call with no function in it throws, and so does a call with MORE THAN ONE:
 * picking between two callbacks is a guess, and a guess that runs the wrong one
 * records a behaviour the subject does not have.
 */
export function callbackRunner(...handed: unknown[]) {
  const calls: Array<{ args: unknown[]; returned?: unknown; threw?: unknown }> = [];
  const run = (...args: unknown[]) => {
    const call: { args: unknown[]; returned?: unknown; threw?: unknown } = { args };
    calls.push(call);
    const fns = args.filter((a) => typeof a === "function");
    if (fns.length !== 1) {
      return notConfigured(
        "doubles.callbackRunner()",
        `it answers by RUNNING the callback it was handed, and this call carried ${fns.length} function arguments.`
      );
    }
    try {
      const out = (fns[0] as (...a: unknown[]) => unknown)(...handed);
      call.returned = out;
      return out;
    } catch (e) {
      call.threw = e;
      throw e;
    }
  };
  (run as any).calls = calls;
  return run as typeof run & { calls: typeof calls };
}

/**
 * An Express-shaped request.
 *
 * Generic because it is the framework's contract, not a service's: the same six
 * fields in every service that mounts a handler. Overrides are shallow-merged, so
 * `expressRequest({ headers: { "x-forwarded-for": "203.0.113.9" } })` keeps the
 * empty query/params/body rather than dropping them — a handler that reads
 * `req.query.id` off a request built without one throws on the first line, which
 * is a harness failure wearing the costume of a recorded behaviour.
 *
 * MEASURED: `req`/`res` written as plain object literals instead of a double was
 * one of the five mechanical classes behind a run's aim errors.
 */
export function expressRequest(overrides: Record<string, any> = {}) {
  const headers: Record<string, any> = { ...(overrides.headers ?? {}) };
  const req: Record<string, any> = {
    method: "GET",
    url: "/",
    originalUrl: "/",
    path: "/",
    ip: "127.0.0.1",
    query: {},
    params: {},
    body: {},
    socket: { remoteAddress: "127.0.0.1" },
    ...overrides,
    headers,
    // Express matches a header name case-insensitively; a double that does not
    // answers `undefined` for a header the caller did set.
    get(name: string) { return headers[String(name).toLowerCase()] ?? headers[name]; },
  };
  req.header = req.get;
  return req;
}

/**
 * An Express-shaped response that RECORDS instead of writing.
 *
 * Chainable exactly as the real one is (`res.status(404).json(...)`), and every
 * terminal call is readable afterwards: `.statusCode`, `.body`, `.sent`,
 * `.headers`, and `.calls` for the order they came in. It writes to no socket, so
 * a handler under it completes rather than hanging on a response that never ends.
 *
 * WHY THESE METHODS AND NOT MORE. An express `Response` is two surfaces stacked:
 * node's own `http.ServerResponse` — `setHeader`, `getHeader`, `getHeaders`,
 * `getHeaderNames`, `hasHeader`, `removeHeader`, `appendHeader`, `headersSent` —
 * and express's additions on top of it — `status`, `json`, `send`, `sendStatus`,
 * `set`/`header`, `get`, `type`/`contentType`, `append`, `vary`, `links`,
 * `redirect`. Both halves are the framework's own contract, present on every
 * response object in every service that mounts a handler, so both belong here.
 *
 * DELIBERATELY ABSENT, each for the same reason: it cannot behave correctly
 * without something this file does not have. `location` and `format` read
 * `res.req`; `cookie` and `clearCookie` read the cookie-parser secret off it to
 * sign; `jsonp` reads an app setting; `attachment`, `sendFile`, `download` and
 * `render` need a mime table, a filesystem or a view engine. `write` is left out
 * for the same reason wearing different clothes: a streamed body would land
 * somewhere other than `.body`, and a row reading `.body` would see nothing while
 * believing it saw the response. A method that guesses any of this records a
 * fiction, and a fiction is worse than the `TypeError` a missing method throws —
 * that one an agent notices.
 *
 * MEASURED: `appendHeader` was missing, and an agent deriving against a target
 * whose error handler chains `res.status(403).appendHeader("Content-Type",
 * "application/json").json(...)` (`src/server.ts:51` and `:60`) patched it per
 * row as `r.appendHeader = (n, v) => r.set(n, v)` — which REPLACES where the real
 * one APPENDS. That is why everything below that is chainable in express returns
 * `res`, and why `removeHeader`, which node does NOT make chainable, does not.
 */
export function expressResponse(overrides: Record<string, any> = {}) {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const headers: Record<string, unknown> = {};
  const res: Record<string, any> = {
    statusCode: 200,
    body: undefined as unknown,
    sent: false,
    headers,
    calls,
    // Node writes the head on the first terminal call, and `sent` is that moment.
    // An error handler guarding `if (res.headersSent)` takes the wrong arm
    // without this, and a branch the harness invented is not a behaviour.
    get headersSent() { return res.sent; },
    status(code: number) { calls.push({ method: "status", args: [code] }); res.statusCode = code; return res; },
    sendStatus(code: number) { calls.push({ method: "sendStatus", args: [code] }); res.statusCode = code; res.sent = true; return res; },
    json(payload?: unknown) { calls.push({ method: "json", args: [payload] }); res.body = payload; res.sent = true; return res; },
    send(payload?: unknown) { calls.push({ method: "send", args: [payload] }); res.body = payload; res.sent = true; return res; },
    end(payload?: unknown) { calls.push({ method: "end", args: [payload] }); res.sent = true; return res; },
    set(name: string, value?: unknown) { calls.push({ method: "set", args: [name, value] }); headers[String(name).toLowerCase()] = value; return res; },
    get(name: string) { return headers[String(name).toLowerCase()]; },
    setHeader(name: string, value?: unknown) { return res.set(name, value); },
    type(value: string) { return res.set("content-type", value); },
    contentType(value: string) { return res.type(value); },
    /**
     * ADDS to a header instead of replacing it — the one thing `set` cannot do,
     * and the reason a second value under the same name is not lost. Express's
     * `append` and node's `appendHeader` agree on the shape: no prior value
     * leaves the value as it came, a prior value makes an array of both.
     */
    append(name: string, value?: unknown) {
      calls.push({ method: "append", args: [name, value] });
      const at = String(name).toLowerCase();
      const prev = headers[at];
      const added = Array.isArray(value) ? value : [value];
      headers[at] = prev === undefined ? value : Array.isArray(prev) ? [...prev, ...added] : [prev, ...added];
      return res;
    },
    appendHeader(name: string, value?: unknown) { return res.append(name, value); },
    getHeader(name: string) { return res.get(name); },
    getHeaders() { return { ...headers }; },
    getHeaderNames() { return Object.keys(headers); },
    hasHeader(name: string) { return String(name).toLowerCase() in headers; },
    // Node's `removeHeader` answers `undefined`. It is the one header method that
    // is not chainable, so this one does not pretend to be either.
    removeHeader(name: string) { calls.push({ method: "removeHeader", args: [name] }); delete headers[String(name).toLowerCase()]; return undefined; },
    /** `Vary`, appended and de-duplicated case-insensitively, `*` swallowing the rest. */
    vary(field: string | string[]) {
      calls.push({ method: "vary", args: [field] });
      const add = (Array.isArray(field) ? field : [field]).map(String);
      const prev = headers["vary"];
      const have = prev === undefined ? [] : String(prev).split(",").map((f) => f.trim()).filter(Boolean);
      if (have.includes("*") || add.includes("*")) { headers["vary"] = "*"; return res; }
      for (const f of add) if (!have.some((h) => h.toLowerCase() === f.toLowerCase())) have.push(f);
      headers["vary"] = have.join(", ");
      return res;
    },
    /** `Link`, in express's own `<url>; rel="name"` form, appended to any already set. */
    links(rels: Record<string, unknown>) {
      calls.push({ method: "links", args: [rels] });
      const prev = headers["link"];
      const next = Object.keys(rels).map((rel) => `<${String(rels[rel])}>; rel="${rel}"`).join(", ");
      headers["link"] = prev === undefined || prev === "" ? next : `${String(prev)}, ${next}`;
      return res;
    },
    redirect(...args: unknown[]) { calls.push({ method: "redirect", args }); res.sent = true; return res; },
    ...overrides,
  };
  res.header = res.set;
  return res;
}

/**
 * An Express `next`, recording what it was handed.
 *
 * `next()` and `next(err)` are different outcomes on the same arm, and the
 * difference is only readable if the double keeps it: `.calls` is the log and
 * `.error` is the first argument it ever received.
 */
export function expressNext() {
  const calls: unknown[][] = [];
  const next = (...a: unknown[]) => { calls.push(a); return undefined; };
  (next as any).calls = calls;
  Object.defineProperty(next, "error", { get: () => calls.find((c) => c.length > 0)?.[0] });
  return next as typeof next & { calls: unknown[][]; error: unknown };
}
