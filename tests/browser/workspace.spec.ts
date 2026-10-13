import {
  test,
  expect,
  type Page,
  type APIRequestContext,
} from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
const origin = "http://127.0.0.1:8790";
const admin = {
  email: "review-admin@example.test",
  password: "mboard-review-admin-2026",
  name: "设计验收",
};
const reader = {
  email: "review-user@example.test",
  password: "mboard-review-user-2026",
  name: "体验用户",
};
let userId = 0,
  nodeId = 0,
  machineToken = "";
async function post<T>(
  r: APIRequestContext,
  path: string,
  data: unknown,
  method = "POST",
): Promise<T> {
  const result = await r.fetch(`/api/v1/${path}`, {
    method,
    data,
    headers: { Origin: origin },
  });
  expect(result.ok(), `${path}: ${await result.text()}`).toBeTruthy();
  return (await result.json()).data;
}
async function login(page: Page, account = admin) {
  await post(page.request, "auth/login", {
    email: account.email,
    password: account.password,
  });
}
async function invariant(page: Page) {
  await expect(page.locator("h1")).toHaveCount(1);
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    )
    .toBe(true);
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(
    /不[^\s，。]{1,12}|没有|商业收入指标已从自用构建中移除/,
  );
  const aligned = await page.evaluate(() =>
    Array.from(document.querySelectorAll("table")).every((table) => {
      const headers = Array.from(table.querySelectorAll("thead th"));
      return Array.from(table.querySelectorAll("tbody tr")).every((row) =>
        Array.from(row.children).every(
          (cell, index) =>
            !headers[index] ||
            getComputedStyle(cell).textAlign ===
              getComputedStyle(headers[index]).textAlign,
        ),
      );
    }),
  );
  expect(aligned).toBe(true);
  const chartLegible = await page.evaluate(() =>
    Array.from(
      document.querySelectorAll<SVGTextElement>(".traffic-chart text"),
    ).every(
      (element) =>
        parseFloat(getComputedStyle(element).fontSize) *
          (element.getScreenCTM()?.a || 1) >=
        11.9,
    ),
  );
  expect(chartLegible).toBe(true);
  await expect(page.locator(".error-state")).toHaveCount(0);
}
test.describe.configure({ mode: "serial" });
test("初始化和真实授权数据", async ({ page }) => {
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "建立你的工作区" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 900 });
  mkdirSync("docs/review", { recursive: true });
  await page.screenshot({
    path: "docs/review/setup-desktop.png",
    fullPage: true,
    animations: "disabled",
  });
  await page.getByLabel("管理员名称").fill(admin.name);
  await page.getByLabel("邮箱", { exact: true }).fill(admin.email);
  await page.getByLabel("密码", { exact: true }).fill(admin.password);
  await page.getByRole("button", { name: "创建工作区" }).click();
  await expect(page).toHaveURL(/admin\/overview/);
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const group = await post<{ id: number }>(page.request, "admin/groups", {
    name: "个人网络",
  });
  const machine = await post<{ machine: { id: number }; token: string }>(
    page.request,
    "admin/machines",
    { name: "Tokyo · 01", host: "127.0.0.1", enabled: true },
  );
  machineToken = machine.token;
  const node = await post<{ id: number }>(page.request, "admin/nodes", {
    name: "Tokyo · Direct",
    host: "127.0.0.1",
    port: 19443,
    protocol: "vless",
    enabled: true,
    machine_id: machine.machine.id,
    group_ids: [group.id],
    tls: false,
    server_name: "",
  });
  nodeId = node.id;
  const me = (await (await page.request.get("/api/v1/me")).json()).data;
  await post(
    page.request,
    `admin/users/${me.id}`,
    { group_ids: [group.id] },
    "PATCH",
  );
  const user = await post<{ id: number }>(page.request, "admin/users", {
    ...reader,
    enabled: true,
    quota_bytes: 100 * 1024 ** 3,
    expires_at: null,
    group_ids: [group.id],
  });
  userId = user.id;
  await post(page.request, "admin/notices", {
    title: "欢迎来到你的网络工作区",
    body: "复制订阅链接，导入 sing-box 客户端后选择连接入口。管理员可以在同一工作区管理授权、节点和流量。",
  });
  await post(page.request, "admin/guides", {
    title: "导入 sing-box 配置",
    category: "连接指南",
    body: "1. 在连接概览下载配置。\n2. 将配置导入 sing-box 客户端。\n3. 选择连接入口，再开启系统代理。",
  });
  const heart = await fetch(`${origin}/api/node/v1/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      version: "mboard-node/review",
      uptime_seconds: 120,
      config_revision: 0,
    }),
  });
  expect(heart.ok).toBeTruthy();
  const traffic = await fetch(`${origin}/api/node/v1/traffic`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${machineToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      batch_id: "browser-review-first",
      records: [
        {
          node_id: nodeId,
          user_id: userId,
          upload_bytes: 1543210000,
          download_bytes: 8456780000,
        },
      ],
    }),
  });
  expect(traffic.ok).toBeTruthy();
  await invariant(page);
});
test("桌面和移动布局、双主题、页面能力文案", async ({ page }) => {
  await login(page);
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ]) {
    await page.setViewportSize({ width, height });
    for (const area of ["admin", "user"])
      for (const route of area === "admin"
        ? [
            "overview",
            "users",
            "nodes",
            "machines",
            "groups",
            "content",
            "tickets",
            "settings",
          ]
        : ["overview", "nodes", "traffic", "guides", "tickets", "account"]) {
        await page.goto(`/#/${area}/${route}`);
        await expect(page.locator(".mb-custom-loading")).toHaveCount(0);
        await invariant(page);
        await expect(page.locator('.mb-custom-motion-number[data-motion-state="animating"]')).toHaveCount(0);
        if (route === "overview" || route === "users" || route === "nodes")
          await page.screenshot({
            path: `docs/review/${area}-${route}-${width}.png`,
            fullPage: true,
            animations: "disabled",
          });
        if (route === "overview")
          await page.screenshot({
            path: `docs/review/${area}-${width}.png`,
            fullPage: true,
            animations: "disabled",
          });
      }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/admin/overview");
  await expect(
    page.getByRole("button", { name: "打开导航" }),
  ).not.toBeVisible();
  await expect(
    page.getByRole("button", { name: "关闭导航" }),
  ).not.toBeVisible();
  await expect(page.locator(".traffic-chart polygon")).toHaveCount(0);
  await expect(page.locator(".traffic-chart circle")).toHaveCount(2);
  await page.goto("/#/user/overview");
  await expect(page.getByRole("heading", { name: "连接，从这里开始", exact: true })).toBeVisible();
  await expect(page.locator('.mb-custom-motion-number[data-motion-state="animating"]')).toHaveCount(0);
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await expect(page.locator("html")).toHaveClass("dark");
  await invariant(page);
  await expect(page.locator(".card").first()).toHaveCSS("background-color", "rgb(24, 47, 46)");
  await page.screenshot({ path: "docs/review/user-dark.png", fullPage: true, animations: "disabled" });
  expect(errors).toEqual([]);
  const metrics = await page.evaluate(() => {
    const h = document.querySelector("h1")!,
      k = document.querySelector(".kpi-value")!,
      b = document.querySelector(".button-primary")!;
    const style = (e: Element) => {
      const s = getComputedStyle(e);
      return {
        font: s.fontFamily,
        size: s.fontSize,
        weight: s.fontWeight,
        lineHeight: s.lineHeight,
        color: s.color,
        background: s.backgroundColor,
      };
    };
    return {
      viewport: [innerWidth, innerHeight],
      title: style(h),
      number: style(k),
      action: style(b),
      pagePadding: getComputedStyle(document.querySelector(".page-content")!)
        .padding,
      overflow: document.documentElement.scrollWidth,
    };
  });
  writeFileSync("docs/review/computed.json", JSON.stringify(metrics, null, 2));
});
test("用户提交问题、管理员回复、订阅下载", async ({ page }) => {
  await login(page, reader);
  await page.goto("/#/user/overview");
  await expect(
    page.getByRole("heading", { name: "连接，从这里开始" }),
  ).toBeVisible();
  await expect(page.locator(".kpi-value").first()).toHaveText(/9\.31 GB/);
  const dl = page.locator("a[download]").first();
  const href = await dl.getAttribute("href");
  const config = await page.request.get(href!);
  expect(config.ok()).toBeTruthy();
  expect(
    (await config.json()).outbounds.some((x: any) => x.type === "vless"),
  ).toBeTruthy();
  await page.goto("/#/user/tickets");
  await page
    .getByRole("button", { name: "提交问题", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("问题标题").fill("连接配置咨询");
  await dialog.getByLabel("问题描述").fill("希望确认客户端配置导入方式。");
  await dialog.getByRole("button", { name: "提交问题", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "连接配置咨询", exact: true }),
  ).toBeVisible();
  await page.getByLabel("补充说明").fill("客户端运行在 Linux。");
  await page.getByRole("button", { name: "发送回复" }).click();
  await expect(
    page.getByText("客户端运行在 Linux。", { exact: false }),
  ).toBeVisible();
  await post(page.request, "auth/logout", {});
  await login(page);
  const tickets = (
    await (await page.request.get("/api/v1/admin/tickets")).json()
  ).data;
  await post(page.request, `tickets/${tickets[0].id}/messages`, {
    body: "在连接概览下载 JSON 配置，再导入客户端。",
  });
  await post(page.request, "auth/logout", {});
  await login(page, reader);
  await page.goto("/#/user/tickets");
  await page.reload();
  await page.getByRole("button", { name: /连接配置咨询/ }).click();
  await expect(
    page.getByText("在连接概览下载 JSON 配置，再导入客户端。", {
      exact: false,
    }),
  ).toBeVisible();
  await invariant(page);
});
test("管理端 CRUD、一次性令牌和站点展示", async ({ page }) => {
  await login(page);
  await page.goto("/#/admin/groups");
  await page
    .getByRole("button", { name: "创建分组", exact: true })
    .first()
    .click();
  let d = page.getByRole("dialog");
  await d.getByLabel("分组名称").fill("验收分组");
  await d.getByRole("button", { name: "创建分组", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "验收分组", exact: true }),
  ).toBeVisible();
  await page.goto("/#/admin/users");
  await page
    .getByRole("button", { name: "创建用户", exact: true })
    .first()
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("姓名", { exact: true }).fill("验收账户");
  await d.getByLabel("电子邮箱").fill("crud-user@example.test");
  await d.getByLabel("初始密码").fill("mboard-crud-user-2026");
  await d.getByLabel("验收分组", { exact: true }).check();
  await d.getByRole("button", { name: "创建用户", exact: true }).click();
  await expect(page.getByText("验收账户", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "编辑验收账户", exact: true }).click();
  await page
    .getByRole("dialog")
    .getByLabel("流量配额（字节）")
    .fill("1000000000");
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "保存更改" })
    .click();
  await expect(page.getByRole("cell", { name: /953.67 MB/ })).toBeVisible();
  await page.goto("/#/admin/machines");
  await page
    .getByRole("button", { name: "创建机器", exact: true })
    .first()
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("机器名称").fill("验收机器");
  await d.getByLabel("机器地址").fill("127.0.0.1");
  await d.getByRole("button", { name: "创建机器", exact: true }).click();
  d = page.getByRole("dialog");
  await expect(d.getByLabel("机器接入令牌")).toHaveValue(/^[a-f0-9]{64}$/);
  const initial = await d.getByLabel("机器接入令牌").inputValue();
  await d.getByRole("button", { name: "已安全保存" }).click();
  await expect(page.getByLabel("机器接入令牌", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "轮换验收机器的接入令牌" }).click();
  await page
    .getByRole("dialog")
    .getByRole("button", { name: "确认轮换" })
    .click();
  d = page.getByRole("dialog");
  await expect(d.getByLabel("机器接入令牌")).toHaveValue(/^[a-f0-9]{64}$/);
  expect(await d.getByLabel("机器接入令牌").inputValue()).not.toBe(initial);
  await d.getByRole("button", { name: "已安全保存" }).click();
  await page.goto("/#/admin/nodes");
  await page
    .getByRole("button", { name: "创建节点", exact: true })
    .first()
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("节点名称").fill("验收入口");
  await d.getByLabel("服务地址").fill("127.0.0.1");
  await d.getByLabel("监听端口").fill("19444");
  await d.getByLabel("协议", { exact: true }).selectOption("shadowsocks");
  await expect(d.getByLabel("启用 TLS", { exact: true })).toHaveCount(0);
  await d
    .getByLabel("接入机器")
    .selectOption({ label: "验收机器 · 127.0.0.1" });
  await d.getByLabel("验收分组", { exact: true }).check();
  await d.getByRole("button", { name: "创建节点", exact: true }).click();
  await expect(page.getByText("验收入口", { exact: true })).toBeVisible();
  await page.goto("/#/admin/content");
  await page
    .getByRole("button", { name: "创建公告", exact: true })
    .first()
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("公告标题").fill("验收公告");
  await d.getByLabel("公告正文").fill("管理员发布的消息以纯文本展示。");
  await d.getByRole("button", { name: "创建公告", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "验收公告", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "使用指南", exact: true }).click();
  await page
    .getByRole("button", { name: "创建指南", exact: true })
    .first()
    .click();
  d = page.getByRole("dialog");
  await d.getByLabel("指南标题").fill("验收指南");
  await d.getByLabel("指南分类").fill("客户端");
  await d.getByLabel("指南正文").fill("下载配置后导入客户端。");
  await d.getByRole("button", { name: "创建指南", exact: true }).click();
  await expect(
    page.getByRole("cell", { name: "验收指南", exact: true }),
  ).toBeVisible();
  await page.goto("/#/admin/settings");
  await page.getByLabel("站点名称", { exact: true }).fill("mboard 验收");
  await page
    .getByLabel("站点介绍", { exact: true })
    .fill("连接入口和访问授权由你掌握。");
  await page.getByRole("button", { name: "保存设置" }).click();
  await expect(page.getByRole("button", { name: "保存设置" })).toBeDisabled();
  await page.goto("/#/user/overview");
  await expect(page.locator(".workspace-label")).toHaveText("mboard 验收");
  await expect(page).toHaveTitle("mboard 验收 · mboard");
  for (const [route, name] of [
    ["nodes", "验收入口"],
    ["users", "验收账户"],
    ["machines", "验收机器"],
    ["groups", "验收分组"],
  ]) {
    await page.goto(`/#/admin/${route}`);
    await page
      .getByRole("button", { name: `删除${name}`, exact: true })
      .click();
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "确认删除" })
      .click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: `删除${name}`, exact: true }),
    ).toHaveCount(0);
    await invariant(page);
  }
});
test("订阅专用域名链接和跨域下载", async ({ page, context }) => {
  await login(page);
  const subscriptionOrigin = "https://subscription.example.test";
  let expected = "";
  for (const path of ["auth/status", "overview"])
    await page.route(`**/api/v1/${path}`, async (route) => {
      const response = await route.fetch();
      const payload = await response.json();
      const user = payload.data.user;
      if (user) {
        user.subscription_url = `${subscriptionOrigin}/s/${user.subscription_token}`;
        expected = user.subscription_url;
      }
      await route.fulfill({ response, json: payload });
    });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  await page.goto("/#/user/overview");
  await expect(page.locator("a[download]").first()).toHaveAttribute(
    "href",
    new RegExp("^https://subscription\\.example\\.test/s/"),
  );
  await page.getByRole("button", { name: "复制订阅链接" }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(expected);
  await page.route(`${subscriptionOrigin}/s/*`, async (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      headers: { "Content-Disposition": 'attachment; filename="mboard.json"' },
      body: JSON.stringify({ outbounds: [{ type: "direct", tag: "direct" }] }),
    }),
  );
  const download = page.waitForEvent("download");
  await page.getByRole("link", { name: "下载配置" }).click();
  expect((await download).suggestedFilename()).toBe("mboard.json");
  await page.goto("/#/user/account");
  await expect(page.getByLabel("订阅链接", { exact: true })).toHaveValue(
    expected,
  );
  await expect(page.locator("a[download]")).toHaveAttribute("href", expected);
  await invariant(page);
});

test("移动导航和对话框键盘操作", async ({ page }) => {
  await login(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/#/user/tickets");
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(
    page.getByRole("button", { name: "打开导航", includeHidden: true }),
  ).toHaveAttribute("aria-expanded", "true");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  expect(
    await page.evaluate(
      () => getComputedStyle(document.activeElement!).outlineWidth,
    ),
  ).toBe("2px");
  await page
    .getByRole("button", { name: "提交问题", exact: true })
    .first()
    .click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Shift+Tab");
  const inModal = await page.evaluate(() =>
    Boolean(document.activeElement?.closest("dialog")),
  );
  expect(inModal).toBe(true);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).not.toBeVisible();
  await invariant(page);
});

test("流量 Webhook 配置、预览、排队和凭据清除", async ({ page }) => {
  await login(page);
  const configRoot="admin/traffic-reports";
  await post(page.request,`${configRoot}/settings`,{enabled:false,webhook_url:"https://receiver.example.test/private-hook?token=synthetic-secret",authorization_header:"Bearer synthetic-auth",top_limit:5},"PATCH");
  await page.goto("/#/admin/settings");
  await page.reload();
  const section=page.locator(".card").filter({has:page.getByRole("heading",{name:"流量 Webhook",exact:true})});
  await expect(section.getByText(/已配置：receiver.example.test/)).toBeVisible();
  await expect(section.getByLabel("Webhook 地址",{exact:true})).toHaveValue("");
  await expect(section.getByLabel("Authorization 请求头",{exact:true})).toHaveValue("");
  expect(await section.innerText()).not.toContain("synthetic-secret");
  expect(await section.innerText()).not.toContain("synthetic-auth");
  await section.getByLabel("排行数量").fill("6");
  await section.getByRole("button",{name:"保存 Webhook 设置",exact:true}).click();
  await expect(section.getByRole("button",{name:"保存 Webhook 设置",exact:true})).toBeDisabled();
  const secretRow=(await(await page.request.get(`/api/v1/${configRoot}/settings`)).json()).data;
  expect(secretRow.authorization_configured).toBe(true);expect(secretRow.top_limit).toBe(6);
  const previewCard=page.locator(".card").filter({has:page.getByRole("heading",{name:"报告预览",exact:true})});
  await previewCard.getByRole("button",{name:"生成预览",exact:true}).click();
  await expect(previewCard.getByLabel("报告预览",{exact:true})).toHaveValue(/每日流量报告/);
  await expect(previewCard.getByLabel("报告预览",{exact:true})).toHaveAttribute("readonly","");
  const fieldsBefore=await section.getByLabel("Webhook 地址",{exact:true}).inputValue();
  expect(fieldsBefore).toBe("");
  await section.getByRole("button",{name:"发送测试消息",exact:true}).click();
  const modal=page.getByRole("dialog");
  await expect(modal).toContainText("固定测试消息");
  const pending=page.waitForResponse(r=>r.url().endsWith('/traffic-reports/send')&&r.request().method()==='POST');
  await modal.getByRole("button",{name:"确认发送",exact:true}).click();
  expect((await pending).status()).toBe(202);
  await expect(page.getByRole("dialog")).not.toBeVisible();
  const runCard=page.locator(".card").filter({has:page.getByRole("heading",{name:"发送记录",exact:true})});
  await expect(runCard).toContainText("排队中");
  const jobs=(await(await page.request.get(`/api/v1/${configRoot}/runs`)).json()).data;
  expect(jobs[0].kind).toBe("test");expect(jobs[0].attempts).toBe(0);
  // No worker is started in this test: mock only the GET run result to review status presentation.
  await page.route("**/api/v1/admin/traffic-reports/runs",route=>route.fulfill({json:{data:[{...jobs[0],status:"sent",attempts:1,http_status:200}]}}));
  await runCard.getByRole("button",{name:"刷新记录",exact:true}).click();
  await expect(runCard).toContainText("已发送");
  await section.getByLabel("清除 Authorization 请求头",{exact:true}).check();
  await section.getByRole("button",{name:"保存 Webhook 设置",exact:true}).click();
  await expect(section.getByText("按接收端要求填写完整的 Authorization 值。",{exact:true})).toBeVisible();
  await invariant(page);
  mkdirSync("docs/review/webhook",{recursive:true});
  for(const[width,height]of[[1440,900],[390,844]]){
    await page.setViewportSize({width,height});await invariant(page);
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({path:`docs/review/webhook/settings-${width}.png`,fullPage:true,animations:"disabled"});
  }
});

test("真实数字的动效、暂停和减少动态效果切换", async ({ page }) => {
  await login(page, reader);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.goto("/#/user/overview");
  const number = page.locator(".kpi-card .mb-custom-motion-number").first();
  await expect(number).toHaveAttribute("data-motion-state", "animating");
  const finalLabel = await number.locator(".mb-custom-motion-number-label").textContent();
  await expect(number.locator(".mb-custom-motion-number-visible")).toHaveAttribute("aria-hidden", "true");
  await page.clock.runFor(200);
  const midValue = await number.locator(".mb-custom-motion-number-visible").textContent();
  expect(midValue).not.toBe(finalLabel);
  expect(midValue).not.toBe("0 B");
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1000);
  await expect(number.locator(".mb-custom-motion-number-visible")).toHaveText(midValue!);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", { configurable: true, value: false });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.clock.runFor(1000);
  await expect(number).toHaveAttribute("data-motion-state", "settled");
  await expect(number.locator(".mb-custom-motion-number-visible")).toHaveText(finalLabel!);
  const source = (await (await page.request.get("/api/v1/overview")).json()).data;
  expect(Number(await number.getAttribute("data-motion-value"))).toBe(source.user.upload_bytes + source.user.download_bytes);
  await page.goto("/#/user/traffic");
  const next = page.locator(".mb-custom-motion-number").first();
  await expect(next).toHaveAttribute("data-motion-state", "animating");
  await page.clock.runFor(100);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(next).toHaveAttribute("data-motion-state", "settled");
  expect(await next.locator(".mb-custom-motion-number-visible").textContent()).toBe(await next.locator(".mb-custom-motion-number-label").textContent());
  await invariant(page);
});

test("页面、图表和导航动效保留布局与真实数据点", async ({ page }) => {
  await login(page, reader);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/user/overview");
  await expect(page.locator(".kpi-card")).toHaveCount(4);
  expect(await page.locator("main").evaluate(el => getComputedStyle(el).animationName)).toBe("mb-page-enter");
  const cards = page.locator(".kpi-card");
  expect(await cards.nth(0).evaluate(el => getComputedStyle(el).animationDelay)).toBe("0.09s");
  expect(await cards.nth(3).evaluate(el => getComputedStyle(el).animationDelay)).toBe("0.255s");
  const single = page.locator(".mb-custom-chart-series");
  await expect(single).toHaveAttribute("data-motion-points", "1");
  await expect(single.locator(".mb-custom-chart-point")).toHaveCount(2);
  await page.evaluate(() => { (window as any).__motionSeries = document.querySelector(".mb-custom-chart-series"); });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(() => page.evaluate(() => (window as any).__motionSeries === document.querySelector(".mb-custom-chart-series"))).toBe(true);
  await invariant(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  const marker = page.locator(".mb-custom-nav-marker");
  await expect(marker).toHaveCSS("transition-duration", "0.42s, 0.24s, 0.16s");
  const previous = await marker.getAttribute("style");
  await page.getByRole("link", { name: "连接入口", exact: true }).click();
  await expect(page.locator("h1")).toHaveText("连接入口");
  await expect.poll(() => marker.getAttribute("style")).not.toBe(previous);
  await page.route("**/api/v1/overview", async route => {
    const response = await route.fetch();
    const body = await response.json();
    const point = body.data.traffic[0];
    body.data.traffic = [
      { ...point, date: "2026-01-01" },
      { ...point, date: "2026-01-02", upload_bytes: point.upload_bytes + 1024, download_bytes: point.download_bytes + 2048 },
    ];
    await route.fulfill({ response, json: body });
  });
  await page.goto("/#/user/overview");
  await expect(page.locator(".mb-custom-chart-line")).toHaveCount(2);
  for (const line of await page.locator(".mb-custom-chart-line").all()) {
    await expect(line).toHaveAttribute("pathLength", "1");
    expect(await line.evaluate(el => getComputedStyle(el).animationName)).toBe("mb-chart-draw");
  }
  await expect(page.locator('.mb-custom-motion-number[data-motion-state="animating"]')).toHaveCount(0);
  mkdirSync("docs/review/motion", { recursive: true });
  await page.screenshot({ path: "docs/review/motion/user-desktop.png", fullPage: true, animations: "disabled" });
  await page.getByRole("button", { name: "切换深色主题" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await invariant(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "docs/review/motion/user-mobile-dark.png", fullPage: true, animations: "disabled" });
});

test("弹窗进退场、提示反馈和减少动态效果的键盘操作", async ({ page }) => {
  await login(page, reader);
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/#/user/tickets");
  const trigger = page.getByRole("button", { name: "提交问题", exact: true }).first();
  await trigger.click();
  const dialog = page.locator("dialog[open]");
  await expect(dialog).toHaveAttribute("data-phase", "enter");
  expect(await dialog.evaluate(el => getComputedStyle(el).animationName)).toBe("mb-dialog-enter");
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await page.keyboard.press("Escape");
  const exiting = page.locator('dialog[data-phase="exit"]');
  await expect(exiting).toHaveAttribute("inert", "");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.clock.runFor(200);
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/#/user/overview");
  await page.getByRole("button", { name: "复制订阅链接", exact: true }).click();
  const toast = page.locator(".toast").first();
  await expect(toast).toContainText("订阅链接已经复制。");
  expect(await toast.evaluate(el => getComputedStyle(el).animationName)).toBe("mb-toast-enter");
  await toast.getByRole("button", { name: "关闭提示" }).click();
  await expect(toast).toHaveAttribute("data-exiting", "true");
  await page.clock.runFor(200);
  await expect(page.locator(".toast")).toHaveCount(0);
  await page.goto("/#/user/tickets");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole("button", { name: "打开导航" }).click();
  await expect(page.locator(".sidebar")).toHaveClass(/is-open/);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("button", { name: "打开导航" })).toBeFocused();
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(page.locator("dialog[open]")).toHaveCount(0);
  await expect(trigger).toBeFocused();
  const delays = await page.locator(".page-header h1").evaluate(el => ({
    animationDuration: getComputedStyle(el).animationDuration,
    animationDelay: getComputedStyle(el).animationDelay,
    transitionDelay: getComputedStyle(el).transitionDelay,
  }));
  expect(parseFloat(delays.animationDuration)).toBeLessThanOrEqual(0.00001);
  expect(delays.animationDelay).toBe("0s");
  expect(delays.transitionDelay).toBe("0s");
  await invariant(page);
  await post(page.request, "auth/logout", {});
  await login(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/#/admin/overview");
  await page.reload();
  await expect(page.getByRole("complementary", { name: "管理面板导航" })).toBeVisible();
  await expect(page.locator(".mb-custom-motion-number")).toHaveCount(4);
  await expect(page.locator('.mb-custom-motion-number[data-motion-state="animating"]')).toHaveCount(0);
  const overview = (await (await page.request.get("/api/v1/admin/overview")).json()).data;
  expect(Number(await page.locator(".mb-custom-motion-number").first().getAttribute("data-motion-value"))).toBe(overview.users);
  await invariant(page);
  await page.screenshot({ path: "docs/review/motion/admin-desktop.png", fullPage: true, animations: "disabled" });
});
