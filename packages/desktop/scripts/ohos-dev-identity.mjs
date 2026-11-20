// 开发包（dev product）身份：派生包名/label、本机 build-profile 补齐、dev 调试签名。
//
// 为什么单独成文件：dev-ohos.mjs 是设备热推脚本，bundle-ohos.mjs 是正式打包脚本；
// 两者都必须知道「正式身份」与「开发身份」的边界，而身份规则（点号后缀、product+
// target 成对、签名与包名强绑定）只在 specs/ohos-port/19 定义一次。放这里避免两个
// 脚本各抄一份字面量。
//
// 关键事实（真机 + devecocli 源码核实）：
// - HarmonyOS 的 bundleName 只允许多段字母/数字/下划线，连字符非法 → 包名后缀是
//   `.dev`；用户可见名称才是 `-dev`。
// - devecocli 从 AppScope/app.json5 读 bundleName（不认 product 级 bundleName），
//   生成 dev 签名时要临时改写该文件再还原。
// - 产出目录由 product + target 决定：product=dev + target=dev →
//   entry/build/dev/outputs/dev/electron-dev-*.hap。

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import { ensureOhosAppJson5, readOhosBundleName } from "./ohos-version.mjs";

// 包名后缀（bundleName 分段）：bundleName 不允许连字符，只能用点号分段。
const DEV_BUNDLE_SUFFIX = ".dev";
// 用户可见名称后缀（label 与窗口标题）。
const DEV_NAME_SUFFIX = "-dev";
const DEV_PRODUCT = "dev";
const DEV_APP_LABEL_RESOURCE = "$string:app_name_dev";
// dev 签名材料目录（devecocli 的约定落点，不入库）。
const OHOS_SIGNING_CONFIG_DIR = join(process.env.HOME?.trim() || "", ".ohos", "config");

/** 正式包名 → 开发包名。唯一派生规则，不在第二处写死 `.dev`。 */
export function devBundleNameFrom(releaseBundleName) {
  return `${releaseBundleName}${DEV_BUNDLE_SUFFIX}`;
}

/** 判断一个包名是否是本工程派生的开发包名。 */
export function isDevBundleName(bundleName, releaseBundleName) {
  return typeof bundleName === "string" && bundleName === devBundleNameFrom(releaseBundleName);
}

/**
 * 把打包好的渲染页标题改成开发名（`ZCode` → `ZCode-dev`）。
 *
 * 为什么需要：桌面窗口标题跟随页面的 `<title>`（Electron 默认行为），页面加载完成后会
 * 覆盖启动时的 ability label，导致开发包的 dock/任务预览从 `ZCode-dev` 变回 `ZCode`。
 * 只改 HAP 内组装副本，不碰本地 `out/`；正式打包不带该步骤。
 *
 * @param {string} appDir resfile 里组装好的 app 目录（.../resfile/resources/app）
 * @param {{log?: (message: string) => void}} [options]
 * @returns {boolean} 是否写入
 */
export function applyDevWindowTitle(appDir, { log } = {}) {
  const file = join(appDir, "out", "renderer", "index.html");
  let html;
  try {
    html = readFileSync(file, "utf-8");
  } catch {
    log?.(`窗口标题补丁跳过：找不到 ${file}`);
    return false;
  }
  const match = /<title>([^<]*)<\/title>/u.exec(html);
  if (!match) {
    log?.(`窗口标题补丁跳过：${file} 没有 <title>`);
    return false;
  }
  const title = match[1].trim();
  if (!title || title.endsWith(DEV_NAME_SUFFIX)) return false;
  writeFileSync(file, html.replace(match[0], `<title>${title}${DEV_NAME_SUFFIX}</title>`), "utf-8");
  log?.(`窗口标题改为 ${title}${DEV_NAME_SUFFIX}`);
  return true;
}

// ── build-profile.json5 文本编辑（JSON5，含注释；不引入额外依赖）──

/**
 * 从 `openIndex` 处的 `[` 或 `{` 找到配对的收括号下标；跳过字符串与注释，
 * 避免把注释里的括号当结构。
 */
export function findMatchingBracket(text, openIndex) {
  const open = text[openIndex];
  if (open !== "[" && open !== "{") {
    throw new Error(`findMatchingBracket: 期望 [ 或 {，实际 ${JSON.stringify(open)}`);
  }
  const close = open === "[" ? "]" : "}";
  let depth = 0;
  for (let index = openIndex; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      index = text.indexOf("\n", index);
      if (index === -1) return -1;
      continue;
    }
    if (char === "/" && next === "*") {
      index = text.indexOf("*/", index + 2);
      if (index === -1) return -1;
      index += 1;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(text, index);
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

function skipString(text, quoteIndex) {
  const quote = text[quoteIndex];
  for (let index = quoteIndex + 1; index < text.length; index += 1) {
    if (text[index] === "\\") {
      index += 1;
      continue;
    }
    if (text[index] === quote) return index;
  }
  return text.length;
}

/**
 * 把注释与字符串内容替换成空格（保持长度），用于只在「代码」上做结构定位。
 * 为什么需要：配置文件里的注释可能写着 `products: [...]`，直接正则会把注释当结构。
 */
function maskNonCode(text) {
  // 按 UTF-16 code unit 拆分，保证下标与 text[index] 一致；中文注释在多字节字符下
  // 用码点拆分会让掩码整体错位。
  const chars = text.split("");
  const blank = (from, to) => {
    for (let index = from; index < to; index += 1) {
      if (chars[index] !== "\n") chars[index] = " ";
    }
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      blank(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const close = text.indexOf("*/", index + 2);
      const stop = close === -1 ? text.length : close + 2;
      blank(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === '"' || char === "'") {
      const end = skipString(text, index);
      blank(index, end + 1);
      index = end;
    }
  }
  return chars.join("");
}

/** 在 `from` 之后找到代码里 `<key>:` 后的 `[` 下标（注释/字符串里的同名文本不算）。 */
function findArrayForKey(text, key, from = 0) {
  const masked = maskNonCode(text);
  const pattern = new RegExp(`(^|[^\\w])${key}\\s*:\\s*\\[`, "u");
  const match = pattern.exec(masked.slice(from));
  if (!match) return -1;
  return from + match.index + match[0].lastIndexOf("[");
}

/** 把 `entry` 追加到数组末尾（保留原有缩进与尾逗号风格）。 */
function appendArrayEntry(text, arrayOpenIndex, entry) {
  const close = findMatchingBracket(text, arrayOpenIndex);
  if (close === -1) throw new Error("appendArrayEntry: 数组未闭合");
  const contentEnd = close;
  const before = text.slice(0, contentEnd);
  const trimmed = before.replace(/\s+$/u, "");
  const needsComma = !trimmed.endsWith(",") && !trimmed.endsWith("[");
  const trailing = before.slice(trimmed.length);
  const closingIndent = trailing.includes("\n")
    ? trailing.slice(trailing.lastIndexOf("\n") + 1)
    : "";
  const entryIndent = `${closingIndent}  `;
  const body = entry
    .split("\n")
    .map((line) => (line.length > 0 ? `${entryIndent}${line}` : line))
    .join("\n");
  const insertion = `${needsComma ? "," : ""}\n${body}\n${closingIndent}`;
  return `${trimmed}${insertion}${text.slice(contentEnd)}`;
}

/** 拆出数组里顶层 `{...}` 对象的区间（用于按 name 定位 product/target）。 */
function listArrayObjects(text, arrayOpenIndex) {
  const close = findMatchingBracket(text, arrayOpenIndex);
  if (close === -1) return [];
  const objects = [];
  for (let index = arrayOpenIndex + 1; index < close; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      index = text.indexOf("\n", index);
      if (index === -1) break;
      continue;
    }
    if (char === '"' || char === "'") {
      index = skipString(text, index);
      continue;
    }
    if (char === "{") {
      const end = findMatchingBracket(text, index);
      if (end === -1) break;
      objects.push({ start: index, end });
      index = end;
    }
  }
  return objects;
}

function readStringField(block, key) {
  const pattern = new RegExp(`(^|[^\\w])${key}\\s*:\\s*(['"])((?:\\\\.|(?!\\2).)*)\\2`, "u");
  const match = pattern.exec(block);
  return match ? match[3] : undefined;
}

function readName(block) {
  return readStringField(block, "name");
}

/** dev product 文本块（缩进由 appendArrayEntry 统一加）。 */
function buildDevProductBlock({ bundleName }) {
  return `{
  name: 'dev',
  bundleName: '${bundleName}',
  label: '${DEV_APP_LABEL_RESOURCE}',
  compatibleSdkVersion: '6.0.2(22)',
  targetSdkVersion: '26.0.0',
  runtimeOS: 'HarmonyOS',
  buildOption: {
    nativeLib: {
      collectAllLibs: true,
    },
  },
},`;
}

/** entry 模块的 dev target 文本块。 */
export function buildDevTargetBlock() {
  return `{
  name: 'dev',
  applyToProducts: [
    'dev',
  ],
},`;
}

/**
 * 把 dev product 与 entry 的 dev target 合并进本机 build-profile.json5 文本。
 * 只做增量与一处纠正（default target 不得同时声明 dev，否则 product→target 歧义）。
 * 已存在条目保持原样（含 devecocli 回填的 signingConfig）。
 *
 * @param {string} text 本机 build-profile.json5 原文
 * @param {{bundleName: string}} options 派生出的开发包名
 * @returns {{text: string, changed: string[]}}
 */
export function mergeDevIdentityIntoBuildProfile(text, { bundleName }) {
  const changed = [];
  let next = text;

  // products：app.products
  const productsOpen = findArrayForKey(next, "products");
  if (productsOpen === -1) throw new Error("build-profile.json5: 未找到 app.products");
  const products = listArrayObjects(next, productsOpen);
  const hasDevProduct = products.some(
    ({ start, end }) => readName(next.slice(start, end + 1)) === "dev",
  );
  if (!hasDevProduct) {
    next = appendArrayEntry(next, productsOpen, buildDevProductBlock({ bundleName }));
    changed.push("dev product");
  }

  // modules[electron].targets
  const modulesOpen = findArrayForKey(next, "modules");
  if (modulesOpen === -1) throw new Error("build-profile.json5: 未找到 modules");
  const electronModule = listArrayObjects(next, modulesOpen).find(({ start, end }) => {
    const block = next.slice(start, end + 1);
    const name = readName(block);
    const srcPath = readStringField(block, "srcPath");
    return name === "electron" || srcPath === "./entry";
  });
  if (!electronModule) throw new Error("build-profile.json5: modules 里没有 electron 模块");
  const moduleBlock = next.slice(electronModule.start, electronModule.end + 1);
  const targetsRelative = findArrayForKey(moduleBlock, "targets");
  if (targetsRelative === -1) throw new Error("build-profile.json5: electron 模块没有 targets");
  const targetsOpen = electronModule.start + targetsRelative;
  const targets = listArrayObjects(next, targetsOpen);
  const targetBlocks = targets.map(({ start, end }) => next.slice(start, end + 1));
  const devTargetIndex = targetBlocks.findIndex((block) => readName(block) === "dev");
  if (devTargetIndex === -1) {
    next = appendArrayEntry(next, targetsOpen, buildDevTargetBlock());
    changed.push("entry 的 dev target");
  }

  // 纠正：default target 不能同时 applyToProducts dev（一个 product 只命中一个 target）。
  const defaultTargetIndex = targetBlocks.findIndex((block) => readName(block) === "default");
  if (defaultTargetIndex !== -1) {
    const block = targetBlocks[defaultTargetIndex];
    const applyRelative = findArrayForKey(block, "applyToProducts");
    if (applyRelative !== -1) {
      const applyText = block.slice(applyRelative);
      const cleaned = applyText.replace(/,\s*(['"])dev\1(?=\s*[,\]])/u, "");
      if (cleaned !== applyText) {
        const absoluteStart = targets[defaultTargetIndex].start + applyRelative;
        next =
          next.slice(0, absoluteStart) + cleaned + next.slice(absoluteStart + applyText.length);
        changed.push("从 default target 移除 dev");
      }
    }
  }

  return { text: next, changed };
}

/**
 * 确保本机 build-profile.json5 含 dev product/target，并校验开发包名。
 * 本机文件被 gitignore，早于本改造的 checkout 不会自动带上 dev 条目。
 *
 * @param {string} ohosRoot packages/desktop/ohos
 * @param {{log?: (message: string) => void}} [options]
 * @returns {{bundleName: string, changed: string[]}}
 */
function ensureDevProduct(ohosRoot, { log } = {}) {
  const profilePath = join(ohosRoot, "build-profile.json5");
  const templatePath = join(ohosRoot, "build-profile.template.json5");
  const bundleName = devBundleNameFrom(readOhosBundleName(ohosRoot));
  if (!existsSync(profilePath)) {
    if (!existsSync(templatePath)) throw new Error("build-profile.template.json5 缺失");
    writeFileSync(profilePath, readFileSync(templatePath, "utf-8"), "utf-8");
    log?.("build-profile.json5 从模板创建");
  }
  const original = readFileSync(profilePath, "utf-8");
  const { text, changed } = mergeDevIdentityIntoBuildProfile(original, { bundleName });
  if (text !== original) {
    writeFileSync(profilePath, text, "utf-8");
    log?.(`build-profile.json5 补齐：${changed.join("、")}`);
  }
  // 校验：dev product 的 bundleName 必须是派生值（防止模板/本机被改坏后静默装错身份）。
  const productsOpen = findArrayForKey(text, "products");
  const devProduct = listArrayObjects(text, productsOpen)
    .map(({ start, end }) => text.slice(start, end + 1))
    .find((block) => readName(block) === "dev");
  const actual = devProduct ? readStringField(devProduct, "bundleName") : undefined;
  if (actual !== bundleName) {
    throw new Error(
      `build-profile.json5 中 dev product 的包名是 ${actual ?? "(未声明)"}，应为 ${bundleName}`,
    );
  }
  return { bundleName, changed };
}

// ── dev 调试签名 ──

/**
 * 读取 devecocli 生成的 .p7b（PKCS#7 内嵌 JSON）：包名、失效时间、授权设备 UDID。
 *
 * @param {string} file .p7b 路径
 * @returns {{bundleName: string|null, notAfter: number|null, deviceIds: string[]}|null}
 */
export function readDebugProfile(file) {
  let raw;
  try {
    raw = readFileSync(file, "latin1");
  } catch {
    return null;
  }
  const start = raw.indexOf('{"');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < raw.length; index += 1) {
    const char = raw[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}" && --depth === 0) {
      try {
        const json = JSON.parse(raw.slice(start, index + 1));
        return {
          bundleName: json["bundle-info"]?.["bundle-name"] ?? null,
          notAfter: json.validity?.["not-after"] ?? null,
          deviceIds: (json["debug-info"]?.["device-ids"] ?? []).map((id) =>
            String(id).toUpperCase(),
          ),
        };
      } catch {
        return null;
      }
    }
  }
  return null;
}

/** 设备 UDID（调试 profile 按 UDID 授权设备）；查询失败返回 null。 */
function deviceUdid(hdcPath, serial) {
  const result = spawnSync(hdcPath, ["-t", serial, "shell", "bm", "get", "--udid"], {
    encoding: "utf-8",
    stdio: "pipe",
  });
  if (result.status !== 0) return null;
  const match = /[0-9A-Fa-f]{64}/u.exec(result.stdout ?? "");
  return match ? match[0].toUpperCase() : null;
}

/**
 * 本地 dev 签名可用性检查：在签名材料目录的 dev profile 里找绑定开发包名、未过期、
 * 覆盖所有已连接设备的调试 profile。不访问 AGC，不读 build-profile（避免解析 JSON5）。
 *
 * @param {{materialsDir?: string, bundleName: string, udids: string[], now?: number}} params
 * @returns {string|null} 需要生成的原因；可用时返回 null
 */
export function devSigningProblem({
  materialsDir = OHOS_SIGNING_CONFIG_DIR,
  bundleName,
  udids,
  now = Date.now(),
}) {
  // UDID 统一大写比较：p7b 里是大写，调用方可能直接传 hdc 输出。
  const wanted = udids.map((udid) => udid.toUpperCase());
  // 只看 dev 自己的材料（devecocli 命名 `${product}_<工程>_<hash>=.p7b`）：
  // 正式 HAP 不签名，不需要理会其它 product 的 profile。
  const profiles = existsSync(materialsDir)
    ? readdirSync(materialsDir).filter(
        (name) => name.startsWith(`${DEV_PRODUCT}_`) && name.endsWith(".p7b"),
      )
    : [];
  if (profiles.length === 0) return "没有 dev 签名材料（应存在 dev_*.p7b）";
  const bound = profiles
    .map((name) => ({ name, info: readDebugProfile(join(materialsDir, name)) }))
    .filter(({ info }) => info && info.bundleName === bundleName);
  if (bound.length === 0) return `没有绑定 ${bundleName} 的 profile`;
  const usable = bound.filter(
    ({ info }) =>
      (info.notAfter === null || info.notAfter * 1000 > now) &&
      wanted.every((udid) => info.deviceIds.includes(udid)),
  );
  if (usable.length === 0) {
    const candidates = bound
      .map(({ info }) => {
        const expired = info.notAfter !== null && info.notAfter * 1000 <= now;
        const missing = wanted.filter((udid) => !info.deviceIds.includes(udid));
        return expired ? "已过期" : `未覆盖设备 ${missing.join("、") || "(未知)"}`;
      })
      .join("；");
    return candidates;
  }
  return null;
}

/**
 * 临时把 AppScope/app.json5 的 bundleName 换成 name，执行 action 后还原。
 * devecocli 只认这里的 bundleName（不认 product 级 bundleName）。期间接管
 * SIGINT/SIGTERM，避免子进程被中断后 finally 来不及还原。
 */
export function withAppBundleName(ohosRoot, name, action) {
  const appJsonPath = join(ohosRoot, "AppScope/app.json5");
  const original = readFileSync(appJsonPath, "utf-8");
  const releaseBundleName = readOhosBundleName(ohosRoot);
  const from = `bundleName: "${releaseBundleName}"`;
  if (!original.includes(from)) {
    throw new Error(`AppScope/app.json5 中未找到 ${from}（可能上次生成被中断，先重跑构建自愈）`);
  }
  const keepAlive = () => {};
  process.on("SIGINT", keepAlive);
  process.on("SIGTERM", keepAlive);
  writeFileSync(appJsonPath, original.replace(from, `bundleName: "${name}"`), "utf-8");
  try {
    action();
  } finally {
    writeFileSync(appJsonPath, original, "utf-8");
    process.off("SIGINT", keepAlive);
    process.off("SIGTERM", keepAlive);
  }
}

/**
 * 生成 dev 调试签名并回填 build-profile。只在本地检查不通过或 force 时调用，
 * 由 devecocli 自己做更深层校验（ACL、证书、密码），其自身也会在无需重签时早退。
 *
 * @param {{ohosRoot: string, hdcPath: string, serials: string[], force?: boolean, log?: (message: string) => void}} params
 * @returns {{bundleName: string}}
 */
export function ensureDevSigning({ ohosRoot, hdcPath, serials, force = false, log }) {
  const { bundleName } = ensureDevProduct(ohosRoot, { log });
  // 签名生成要改写 app.json5；首次 checkout（文件尚未生成）或上次中断残留时先按模板
  // 重生成，保证包名基线是正式名（后续 withAppBundleName 才能精确替换）。
  ensureOhosAppJson5(ohosRoot, { log });
  const udids = serials.map((serial) => deviceUdid(hdcPath, serial)).filter(Boolean);
  if (udids.length === 0) {
    throw new Error(
      "无法读取已连接设备的 UDID；dev 调试签名需要至少一台设备（devecocli 生成时要注册设备）",
    );
  }
  const reason = force ? "--resign 指定重新生成" : devSigningProblem({ bundleName, udids });
  if (!reason) return { bundleName };

  log?.(`dev 调试签名需要生成（${reason}）：devecocli signature generate --product ${DEV_PRODUCT}`);
  withAppBundleName(ohosRoot, bundleName, () => {
    const args = ["signature", "generate", "--product", DEV_PRODUCT];
    if (force) args.push("--force");
    const result = spawnSync("devecocli", args, {
      cwd: ohosRoot,
      stdio: "inherit",
      env: process.env,
    });
    if (result.error) {
      throw new Error(
        `无法执行 devecocli（${result.error.message}）：安装 @deveco/deveco-cli 后重试，或按 specs/ohos-port/01 准备签名材料`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `devecocli signature generate 失败（exit ${result.status}）：先 devecocli auth login，并确认已连接设备`,
      );
    }
  });

  const remaining = devSigningProblem({ bundleName, udids });
  if (remaining) {
    throw new Error(`devecocli 执行后 dev 签名仍不可用（${remaining}）；可加 --resign 强制重签`);
  }
  return { bundleName };
}
