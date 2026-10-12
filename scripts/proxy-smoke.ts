// Optional real-core integration: MBOARD_CORE and MBOARD_NODE select locally installed executables.
import { createApp } from "../src/server/app";
import { mkdtempSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:net";
const core = process.env.MBOARD_CORE,
  agent = process.env.MBOARD_NODE;
if (!core || !agent)
  throw new Error("Set MBOARD_CORE and MBOARD_NODE to local executable paths");
const dir = mkdtempSync(join(tmpdir(), "mboard-proxy-"));
const app = createApp({ dbPath: join(dir, "test.sqlite") });
const panel = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
const origin = panel.url.origin;
const payload = "mboard real proxy acceptance · " + crypto.randomUUID();
const target = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: () => new Response(payload),
});
let cookie = "";
let nodeProcess: ReturnType<typeof Bun.spawn> | undefined;
let clientProcess: ReturnType<typeof Bun.spawn> | undefined;
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
async function call(
  path: string,
  data?: unknown,
  method = data ? "POST" : "GET",
) {
  const r = await fetch(`${origin}/api/v1/${path}`, {
    method,
    headers: {
      Origin: origin,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(data ? { "Content-Type": "application/json" } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  assert(r.ok, `${path}: ${r.status}`);
  if (r.headers.has("set-cookie"))
    cookie = r.headers.get("set-cookie")!.split(";")[0];
  return (await r.json()).data;
}
async function freePort() {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, "127.0.0.1", resolve));
  const p = (s.address() as { port: number }).port;
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return p;
}
async function waitFor(check: () => Promise<boolean>, label: string) {
  const end = Date.now() + 15000;
  while (Date.now() < end) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error(`Timed out: ${label}`);
}
async function exec(command: string[], stdin?: string) {
  const p = Bun.spawn(command, {
    stdout: "pipe",
    stderr: "pipe",
    stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
  });
  const [out, err, status] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  assert(status === 0, `${command[0]} exited ${status}: ${err}`);
  return out;
}
try {
  await call("auth/setup", {
    email: "proxy-smoke@example.test",
    password: "mboard-smoke-setup-2026",
    name: "Proxy test",
  });
  const group = await call("admin/groups", { name: "test" }),
    machine = await call("admin/machines", {
      name: "local-test",
      host: "127.0.0.1",
      enabled: true,
    });
  const token = machine.token;
  const nodes = [];
  for (const protocol of ["vless", "shadowsocks"])
    nodes.push(
      await call("admin/nodes", {
        name: protocol,
        protocol,
        host: "127.0.0.1",
        port: await freePort(),
        machine_id: machine.machine.id,
        group_ids: [group.id],
        enabled: true,
        tls: false,
        server_name: "",
      }),
    );
  const me = await call("me");
  await call(`admin/users/${me.id}`, { group_ids: [group.id] }, "PATCH");
  const agentFile = join(dir, "agent.json");
  await Bun.write(
    agentFile,
    JSON.stringify({
      panel_url: origin,
      token,
      core_binary: resolve(core),
      config_path: join(dir, "server.json"),
      data_dir: join(dir, "node-data"),
      interval: "1s",
      request_timeout: "5s",
    }),
  );
  nodeProcess = Bun.spawn([agent, "run", "-config", agentFile], {
    stdout: "ignore",
    stderr: "pipe",
  });
  await waitFor(async () => {
    const r = await call("admin/machines");
    return r[0].online && (await Bun.file(join(dir, "server.json")).exists());
  }, "Go agent heartbeat + configuration apply");
  const raw = await fetch(`${origin}/s/${me.subscription_token}`);
  assert(raw.ok, "subscription");
  const subscription = await raw.json();
  assert(Array.isArray(subscription.outbounds), "raw subscription root");
  const subscriptionFile = join(dir, "subscription.json");
  await Bun.write(subscriptionFile, JSON.stringify(subscription));
  await exec([core, "check", "-c", subscriptionFile]);
  const clientPort = await freePort();
  for (const node of nodes) {
    const config = {
      log: { level: "error" },
      inbounds: [
        { type: "mixed", listen: "127.0.0.1", listen_port: clientPort },
      ],
      outbounds: subscription.outbounds.filter(
        (x: any) => x.tag === `node-${node.id}`,
      ),
      route: { final: `node-${node.id}` },
    };
    const clientFile = join(dir, "client.json");
    await Bun.write(clientFile, JSON.stringify(config));
    await exec([core, "check", "-c", clientFile]);
    clientProcess = Bun.spawn([core, "run", "-c", clientFile], {
      stdout: "ignore",
      stderr: "pipe",
    });
    await waitFor(async () => {
      try {
        const text = await exec([
          "curl",
          "--max-time",
          "2",
          "--silent",
          "--show-error",
          "--fail",
          "--noproxy",
          "",
          "--proxy",
          `http://127.0.0.1:${clientPort}`,
          target.url.toString(),
        ]);
        return text === payload;
      } catch {
        return false;
      }
    }, `${node.protocol} actual proxy transfer`);
    clientProcess.kill();
    await clientProcess.exited;
    clientProcess = undefined;
  }
  const batch = {
    batch_id: "real-transfer-once",
    records: [
      {
        user_id: me.id,
        node_id: nodes[0].id,
        upload_bytes: 0,
        download_bytes: new TextEncoder().encode(payload).byteLength,
      },
    ],
  };
  await exec([agent, "ingest", "-config", agentFile], JSON.stringify(batch));
  await waitFor(async () => {
    const u = await call("me");
    return (
      u.download_bytes === batch.records[0].download_bytes &&
      readdirSync(join(dir, "node-data", "spool")).length === 0
    );
  }, "durable traffic ACK");
  await exec([agent, "ingest", "-config", agentFile], JSON.stringify(batch));
  await waitFor(
    async () => readdirSync(join(dir, "node-data", "spool")).length === 0,
    "duplicate batch ACK",
  );
  assert(
    (await call("me")).download_bytes === batch.records[0].download_bytes,
    "duplicate counting",
  );
  console.log(
    "PASS: Go heartbeat + config, sing-box raw subscription check, VLESS + Shadowsocks real HTTP transfer, measured payload batch durable ACK + duplicate dedup",
  );
  console.log(
    "Traffic record uses measured HTTP response body bytes for this smoke test; production requires the trusted collector described in node operations.",
  );
} finally {
  clientProcess?.kill();
  if (clientProcess) await clientProcess.exited;
  nodeProcess?.kill();
  if (nodeProcess) await nodeProcess.exited;
  panel.stop(true);
  target.stop(true);
  app.close();
  rmSync(dir, { recursive: true, force: true });
}
