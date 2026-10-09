import { test } from "node:test";
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
import { ensureOhosSshWrappers, ohosSshWrapperBinDir } from "../src/ohos/ohosUserShellEnv.js";
import {
  applyOhosLoginShellSnapshotToProcessEnv,
  diffAgainstBaseline,
  loadOhosLoginShellSnapshot,
  ohosLoginSnapshotPath,
  ohosTerminalShellHintPath,
  readOhosTerminalShellHint,
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

test("ensureOhosSshWrappers: ZCODE_OHOS_BREW_PREFIX 时 brew 候选在最前", () => {
  const home = makeFakeHome();
  const previous = process.env.ZCODE_OHOS_BREW_PREFIX;
  process.env.ZCODE_OHOS_BREW_PREFIX = join(home, ".harmonybrew");
  try {
    const binDir = ensureOhosSshWrappers(home);
    assert.ok(binDir);
    const ssh = readFileSync(join(binDir, "ssh"), "utf8");
    const brewIndex = ssh.indexOf(join(home, ".harmonybrew", "bin", "ssh"));
    const sysIndex = ssh.indexOf("/usr/bin/ssh");
    assert.ok(brewIndex > 0 && sysIndex > brewIndex, "brew 候选应排在系统 ssh 之前");
  } finally {
    if (previous === undefined) delete process.env.ZCODE_OHOS_BREW_PREFIX;
    else process.env.ZCODE_OHOS_BREW_PREFIX = previous;
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

function writeSnapshot(home: string, env: Record<string, string>) {
  writeFileSync(
    ohosLoginSnapshotPath(home),
    JSON.stringify({ version: 2, capturedAt: Date.now(), env }),
    "utf8",
  );
}

test("基线差集：只保留新增或改值的键，main 进程内部变量被剔除", () => {
  const diff = diffAgainstBaseline(
    {
      // 新增（rc 演算产出）
      BSK_HOME: "/data/bsk",
      SSH_AUTH_SOCK: "/tmp/agent.sock",
      // 改值（rc 修改了继承值）
      PATH: "/brew/bin:/usr/bin",
      // 与基线相同（继承自 main，非 rc 产出）——必须剔除，否则泄给 host
      OHOS_SOCKET_AppSpawn: "14",
      NODE_PATH: "/main/only",
      ZCODE_ENV_PROBE: "1",
    },
    {
      OHOS_SOCKET_AppSpawn: "14",
      NODE_PATH: "/main/only",
      ZCODE_ENV_PROBE: "1",
      PATH: "/usr/bin",
    },
  );
  assert.deepEqual(diff, {
    BSK_HOME: "/data/bsk",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    PATH: "/brew/bin:/usr/bin",
  });
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

test("快照合并：PATH 整体替换、差集键补缺不覆盖、SKIP_KEYS 不动", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  const saved = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    FOO_DYNAMIC: process.env.FOO_DYNAMIC,
    BSK_HOME: process.env.BSK_HOME,
  };
  try {
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    // 快照文件本身即差集（采集端已剔除基线键），apply 全量补缺。
    writeSnapshot(home, {
      PATH: "/snapshot/bin:/usr/bin",
      FOO_DYNAMIC: "from-snapshot",
      BSK_HOME: "snapshot-value",
      HOME: "/should-not-apply",
      LANG: "C",
    });
    process.env.FOO_DYNAMIC = "already-set";
    process.env.BSK_HOME = undefined;
    delete process.env.BSK_HOME;

    const applied = applyOhosLoginShellSnapshotToProcessEnv(home);
    assert.equal(process.env.PATH, "/snapshot/bin:/usr/bin");
    assert.equal(process.env.FOO_DYNAMIC, "already-set", "已定义键不被覆盖");
    assert.equal(process.env.BSK_HOME, "snapshot-value", "差集键未定义时补齐");
    assert.equal(process.env.HOME, saved.HOME, "SKIP_KEYS(HOME) 不被快照覆盖");
    assert.ok(applied.includes("PATH"));
    assert.ok(applied.includes("BSK_HOME"));
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.HOME === undefined) delete process.env.HOME;
    else process.env.HOME = saved.HOME;
    if (saved.FOO_DYNAMIC === undefined) delete process.env.FOO_DYNAMIC;
    else process.env.FOO_DYNAMIC = saved.FOO_DYNAMIC;
    if (saved.BSK_HOME === undefined) delete process.env.BSK_HOME;
    else process.env.BSK_HOME = saved.BSK_HOME;
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

test("快照加载：损坏 json 与缺失文件都返回 null（保持静态重放结果）", () => {
  const home = mkdtempSync(join(tmpdir(), "zcode-ohos-env-"));
  try {
    assert.equal(loadOhosLoginShellSnapshot(home), null, "无快照文件");
    mkdirSync(join(home, ".zcode", "v2"), { recursive: true });
    writeFileSync(ohosLoginSnapshotPath(home), "{broken", "utf8");
    assert.equal(loadOhosLoginShellSnapshot(home), null, "损坏 json");
    writeFileSync(
      ohosLoginSnapshotPath(home),
      JSON.stringify({ version: 3, env: { A: "1" } }),
      "utf8",
    );
    assert.equal(loadOhosLoginShellSnapshot(home), null, "未知版本");
    assert.deepEqual(applyOhosLoginShellSnapshotToProcessEnv(home), []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
