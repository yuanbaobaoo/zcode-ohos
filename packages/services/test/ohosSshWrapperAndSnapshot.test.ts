import { test } from "vitest";
import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyOhosUserShellEnvToProcessEnv,
  ensureOhosSshWrappers,
  ohosSshWrapperBinDir,
} from "../src/ohos/ohosUserShellEnv.js";
import {
  applyOhosLoginShellSnapshotToProcessEnv,
  loadOhosLoginShellSnapshot,
  ohosLoginSnapshotPath,
  ohosTerminalShellHintPath,
  readOhosTerminalShellHint,
  sanitizeCapturedEnv,
  writeOhosTerminalShellHint,
} from "../src/ohos/ohosLoginShellSnapshot.js";

function makeFakeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  mkdirSync(join(home, ".ssh"), { recursive: true });
  writeFileSync(join(home, ".ssh", "config"), "Host hsl\n  HostName 172.16.105.2\n");
  return home;
}

test("ensureOhosSshWrappers: 无 ~/.ssh/config 不生成", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  assert.equal(ensureOhosSshWrappers(home), undefined);
});

test("ensureOhosSshWrappers: 生成 ssh/scp wrapper，候选链含 -F 与系统路径", () => {
  const home = makeFakeHome();
  try {
    const binDir = ensureOhosSshWrappers(home);
    assert.ok(binDir, "应返回 wrapper bin 目录");
    assert.equal(binDir, ohosSshWrapperBinDir(home));
    assert.equal(binDir, join(home, ".zcode/bridge/bin"));
    const ssh = readFileSync(join(binDir, "ssh"), "utf8");
    assert.match(ssh, /exec "\$s" -F .*\.ssh\/config "\$@"/);
    assert.match(ssh, /\/usr\/bin\/ssh/);
    assert.match(ssh, /exit 127/);
    const scp = readFileSync(join(binDir, "scp"), "utf8");
    assert.match(scp, /\/usr\/bin\/scp/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureOhosSshWrappers: 不写死工具链前缀，按运行时 PATH（登录快照）兜底", () => {
  const home = makeFakeHome();
  const previous = process.env.HOMEBREW_PREFIX;
  process.env.HOMEBREW_PREFIX = join(home, ".harmonybrew");
  try {
    const binDir = ensureOhosSshWrappers(home);
    assert.ok(binDir);
    const ssh = readFileSync(join(binDir, "ssh"), "utf8");
    assert.equal(ssh.includes(join(home, ".harmonybrew")), false, "不按前缀写死候选");
    assert.match(ssh, /for d in \$PATH/, "系统路径之后按运行时 PATH 兜底");
  } finally {
    if (previous === undefined) delete process.env.HOMEBREW_PREFIX;
    else process.env.HOMEBREW_PREFIX = previous;
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureOhosSshWrappers: 权限不达标时删除重建恢复可执行", () => {
  const home = makeFakeHome();
  try {
    const binDir = ensureOhosSshWrappers(home);
    assert.ok(binDir);
    // 模拟平台坑：chmod 后不可执行（虚拟化层把 755 落成 660 一类）。
    chmodSync(join(binDir, "ssh"), 0o660);
    const repaired = ensureOhosSshWrappers(home);
    assert.ok(repaired);
    // mac 上 chmod 语义正常，660 再 ensure 会触发删除重建，恢复 x 位。
    const restored = ensureOhosSshWrappers(home);
    assert.ok(restored);
    assert.equal(readFileSync(join(binDir, "ssh"), "utf8").includes("-F"), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureOhosSshWrappers: 内容已一致且可执行时幂等不重写", () => {
  const home = makeFakeHome();
  try {
    const first = ensureOhosSshWrappers(home);
    assert.ok(first);
    const before = readFileSync(join(first!, "ssh"), "utf8");
    const again = ensureOhosSshWrappers(home);
    assert.ok(again);
    assert.equal(readFileSync(join(again!, "ssh"), "utf8"), before);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ensureOhosSshWrappers: 旧位置 .zcode/bin 的生成产物被迁移清理，用户自放文件保留", () => {
  const home = makeFakeHome();
  try {
    const legacyDir = join(home, ".zcode", "bin");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      join(legacyDir, "ssh"),
      "#!/bin/sh\n# zcode-ohos 生成（可安全删除，下次启动重建）...\n",
      "utf8",
    );
    writeFileSync(join(legacyDir, "my-own-tool"), "#!/bin/sh\necho mine\n", "utf8");
    const binDir = ensureOhosSshWrappers(home);
    assert.ok(binDir);
    assert.equal(existsSync(join(legacyDir, "ssh")), false, "旧 wrapper 被清理");
    assert.equal(existsSync(join(legacyDir, "my-own-tool")), true, "用户自放文件不动");
    assert.equal(existsSync(legacyDir), true, "目录非空（用户文件）不删");
    assert.equal(existsSync(join(binDir!, "ssh")), true, "新位置 wrapper 就绪");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

function writeSnapshot(home: string, env: Record<string, string>) {
  mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
  writeFileSync(
    ohosLoginSnapshotPath(home),
    JSON.stringify({
      version: 3,
      capturedAt: Date.now(),
      shell: "/usr/bin/zsh",
      cwd: home,
      env,
    }),
    "utf8",
  );
}

test("采集结果清洗：剔除 shell 内部键与空值", () => {
  assert.deepEqual(
    sanitizeCapturedEnv({
      _: "/usr/bin/env",
      SHLVL: "2",
      PWD: "/",
      OLDPWD: "/",
      TERM: "dumb",
      EMPTY: "",
      HOME: "/storage/Users/currentUser",
      BSK_HOME: "/data/bsk",
    }),
    {
      HOME: "/storage/Users/currentUser",
      BSK_HOME: "/data/bsk",
    },
  );
});

test("快照合并：PATH 整体替换、用户键覆盖、SKIP_KEYS 不动", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FOO_DYNAMIC: process.env.FOO_DYNAMIC,
    BSK_HOME: process.env.BSK_HOME,
    TMPDIR: process.env.TMPDIR,
  };
  try {
    writeSnapshot(home, {
      PATH: "/snapshot/bin:/usr/bin",
      FOO_DYNAMIC: "from-snapshot",
      BSK_HOME: "snapshot-value",
      HOME: "/should-not-apply",
      TMPDIR: "/should-not-apply",
      LANG: "C",
    });
    process.env.FOO_DYNAMIC = "already-set";
    delete process.env.BSK_HOME;
    process.env.TMPDIR = "keep-me";

    const applied = applyOhosLoginShellSnapshotToProcessEnv(home);
    assert.equal(process.env.PATH, "/snapshot/bin:/usr/bin");
    assert.equal(process.env.FOO_DYNAMIC, "from-snapshot", "快照是 rc 演算结果，覆盖进程值");
    assert.equal(process.env.BSK_HOME, "snapshot-value", "未定义键补齐");
    assert.equal(process.env.HOME, saved.HOME, "SKIP_KEYS(HOME) 不被快照覆盖");
    assert.equal(process.env.TMPDIR, "keep-me", "SKIP_KEYS(TMPDIR) 不被快照覆盖");
    assert.ok(applied.includes("PATH"));
    assert.ok(applied.includes("BSK_HOME"));
    assert.ok(!applied.includes("TMPDIR"));
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.FOO_DYNAMIC === undefined) delete process.env.FOO_DYNAMIC;
    else process.env.FOO_DYNAMIC = saved.FOO_DYNAMIC;
    if (saved.BSK_HOME === undefined) delete process.env.BSK_HOME;
    else process.env.BSK_HOME = saved.BSK_HOME;
    if (saved.TMPDIR === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = saved.TMPDIR;
    rmSync(home, { recursive: true, force: true });
  }
});

test("无快照：不重放 rc，PATH 保持引导值；有快照才整体替换", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  const saved = {
    PATH: process.env.PATH,
    ZCODE_OHOS_REAL_HOME: process.env.ZCODE_OHOS_REAL_HOME,
    FOO: process.env.FOO,
  };
  try {
    writeFileSync(
      join(home, ".zshrc"),
      ['export FOO="from-rc"', 'export PATH="$HOME/ctl:$PATH"', ""].join("\n"),
      "utf8",
    );
    process.env.ZCODE_OHOS_REAL_HOME = home;
    process.env.PATH = "/data/app/bin:/data/service/hnp/bin";
    delete process.env.FOO;

    applyOhosUserShellEnvToProcessEnv();
    assert.equal(process.env.FOO, undefined, "rc 不再静态重放");
    assert.equal(process.env.PATH, "/data/app/bin:/data/service/hnp/bin", "PATH 保持引导值");

    writeSnapshot(home, { PATH: "/snapshot/bin:/usr/bin", FOO: "from-snapshot" });
    const result = applyOhosUserShellEnvToProcessEnv();
    assert.equal(process.env.PATH?.startsWith("/snapshot/bin:/usr/bin"), true);
    assert.equal(process.env.FOO, "from-snapshot");
    assert.equal(result?.pathTouched, true);
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    rmSync(home, { recursive: true, force: true });
  }
});

test("终端 shell hint：落盘回读往返；缺失与非法路径安全回退", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  try {
    assert.equal(readOhosTerminalShellHint(home), undefined, "无 hint 文件");
    writeOhosTerminalShellHint(home, "/usr/bin/zsh");
    assert.equal(readOhosTerminalShellHint(home), "/usr/bin/zsh");
    assert.equal(ohosTerminalShellHintPath(home), join(home, ".zcode/v2/ohos-terminal-shell"));
    writeFileSync(ohosTerminalShellHintPath(home), "relative/bin/sh\n", "utf8");
    assert.equal(readOhosTerminalShellHint(home), undefined, "非绝对路径不信任");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("快照加载：损坏 json、旧版本与字段缺失都返回 null", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  try {
    assert.equal(loadOhosLoginShellSnapshot(home), null, "无快照文件");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(ohosLoginSnapshotPath(home), "{broken", "utf8");
    assert.equal(loadOhosLoginShellSnapshot(home), null, "损坏 json");
    writeFileSync(
      ohosLoginSnapshotPath(home),
      JSON.stringify({ version: 2, capturedAt: Date.now(), env: { A: "1" } }),
      "utf8",
    );
    assert.equal(loadOhosLoginShellSnapshot(home), null, "v2 快照不再兼容");
    writeFileSync(
      ohosLoginSnapshotPath(home),
      JSON.stringify({ version: 3, capturedAt: Date.now(), env: { A: "1" } }),
      "utf8",
    );
    assert.equal(loadOhosLoginShellSnapshot(home), null, "缺 shell/cwd");
    assert.deepEqual(applyOhosLoginShellSnapshotToProcessEnv(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
