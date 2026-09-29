#!/usr/bin/env node
// OHOS 真机 UI 自动化：CDP 通道（应用 web 内容层）。
//
// 前置：应用已启动（main 自带 --remote-debugging-port=9229），且已执行
//   hdc fport tcp:9229 tcp:9229
// 系统层（弹窗/锁屏/多窗口）用 devecocli ui（click/swipe/screenshot/layout），
// 与本脚本互补——CDP 只能看到 web 内容，系统弹窗只能 uitest/devecocli 点。
//
// 用法（node ohos/scripts/device-cdp.mjs <子命令> …）：
//   elements            枚举页面可点元素（tag、文本、中心坐标）
//   eval '<js>'         页面内求值（returnByValue）
//   click <x> <y>       Chromium 层真实点击（Input.dispatchMouseEvent）
//   clicksel <sel>      按 CSS 选择器点击元素中心
//   type '<text>'       逐字符键入（Input.dispatchKeyEvent）
//   key <key>           单键（如 Enter、Escape）
//   shot [path]         截图（默认 /tmp/zcode-cdp.png）
//   info                页面摘要（readyState/#root/bodyText）

import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const repoRoot = new URL("../..", import.meta.url);
const WebSocket = require(
  `${fileURLToPath(repoRoot)}/node_modules/ws/index.js`,
);

const CDP_BASE = process.env.ZCODE_CDP_BASE ?? "http://127.0.0.1:9229";

async function connect() {
  const targets = await (await fetch(`${CDP_BASE}/json/list`)).json();
  const page = targets.find((t) => t.type === "page");
  if (!page) throw new Error("no page target (app not running?)");
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let seq = 0;
  const pending = new Map();
  ws.on("message", (data) => {
    const msg = JSON.parse(data);
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++seq;
      pending.set(id, (msg) =>
        msg.error ? reject(new Error(`${method}: ${msg.error.message}`)) : resolve(msg.result),
      );
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ws, send };
}

const KEY_MAP = {
  Enter: { keyCode: 13, key: "Enter", code: "Enter", text: "\r" },
  Escape: { keyCode: 27, key: "Escape", code: "Escape" },
  Tab: { keyCode: 9, key: "Tab", code: "Tab" },
  Backspace: { keyCode: 8, key: "Backspace", code: "Backspace" },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd) {
    console.log("usage: device-cdp.mjs <elements|eval|click|clicksel|type|key|shot|info> …");
    process.exit(2);
  }
  const { ws, send } = await connect();
  const evalExpr = async (expression, awaitPromise = false) => {
    const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? "eval failed");
    return r.result.value;
  };

  try {
    if (cmd === "info") {
      console.log("readyState:", await evalExpr("document.readyState"));
      console.log("url:", await evalExpr("location.href.slice(0, 120)"));
      console.log("root:", await evalExpr("(() => { const r = document.getElementById('root'); return r ? `${r.childElementCount} elems` : 'none'; })()"));
      console.log("bodyText:", await evalExpr("document.body.innerText.replace(/\\n+/g, ' | ').slice(0, 200)"));
    } else if (cmd === "elements") {
      const list = await evalExpr(`(() => {
        const seen = [];
        for (const el of document.querySelectorAll('button, a, [role="button"], input, [tabindex]:not([tabindex="-1"])')) {
          const r = el.getBoundingClientRect();
          if (r.width < 2 || r.height < 2) continue;
          seen.push({
            tag: el.tagName.toLowerCase(),
            text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 40),
            x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2),
            w: Math.round(r.width), h: Math.round(r.height),
          });
        }
        return seen.slice(0, 60);
      })()`);
      for (const [i, e] of list.entries()) console.log(`${String(i).padStart(2)}  (${e.x},${e.y}) ${e.w}x${e.h} <${e.tag}> ${e.text}`);
      console.log(`-- ${list.length} elements`);
    } else if (cmd === "eval") {
      console.log(JSON.stringify(await evalExpr(args[0], true)));
    } else if (cmd === "click") {
      const [x, y] = args.map(Number);
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
      }
      console.log(`clicked (${x},${y})`);
    } else if (cmd === "clicksel") {
      const center = await evalExpr(`(() => {
        const el = document.querySelector(${JSON.stringify(args[0])});
        if (!el) return null;
        el.scrollIntoView({ block: "center" });
        const r = el.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      })()`);
      if (!center) throw new Error(`selector not found: ${args[0]}`);
      await new Promise((r) => setTimeout(r, 120));
      for (const type of ["mousePressed", "mouseReleased"]) {
        await send("Input.dispatchMouseEvent", { type, x: center.x, y: center.y, button: "left", clickCount: 1 });
      }
      console.log(`clicked ${args[0]} @ (${center.x},${center.y})`);
    } else if (cmd === "type") {
      for (const ch of args[0]) {
        await send("Input.dispatchKeyEvent", { type: "keyDown", text: ch, key: ch, unmodifiedText: ch });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      }
      console.log(`typed ${args[0].length} chars`);
    } else if (cmd === "key") {
      const k = KEY_MAP[args[0]] ?? { key: args[0], code: args[0] };
      await send("Input.dispatchKeyEvent", { type: "keyDown", ...k });
      await send("Input.dispatchKeyEvent", { type: "keyUp", ...k });
      console.log(`key ${args[0]}`);
    } else if (cmd === "shot") {
      await send("Page.enable");
      const shot = await send("Page.captureScreenshot", { format: "png" });
      const path = args[0] ?? "/tmp/zcode-cdp.png";
      writeFileSync(path, Buffer.from(shot.data, "base64"));
      console.log(`saved ${path}`);
    } else {
      throw new Error(`unknown command: ${cmd}`);
    }
  } finally {
    ws.close();
  }
}

main().catch((error) => {
  console.error(`[device-cdp] ${error.message}`);
  process.exit(1);
});
