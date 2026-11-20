import assert from "node:assert/strict";
import { test } from "vitest";
import { resolveCommandLineToolPath, resolveOhosHdcTarget } from "../src/ohos/ohosUserShellEnv.js";

// spec 11：host 注入 ZCODE_HDC_TARGET，端口来自 `param get persist.hdc.port`。
test("resolveOhosHdcTarget 把 persist.hdc.port 转成 TCP target", () => {
  assert.equal(resolveOhosHdcTarget(() => "46273\n"), "127.0.0.1:46273");
  assert.equal(resolveOhosHdcTarget(() => "  46273  "), "127.0.0.1:46273");
});

test("resolveOhosHdcTarget 拒绝非法端口与空值", () => {
  assert.equal(resolveOhosHdcTarget(() => ""), undefined);
  assert.equal(resolveOhosHdcTarget(() => "   "), undefined);
  assert.equal(resolveOhosHdcTarget(() => "0"), undefined);
  assert.equal(resolveOhosHdcTarget(() => "-1"), undefined);
  assert.equal(resolveOhosHdcTarget(() => "abc"), undefined);
  assert.equal(resolveOhosHdcTarget(() => "1.5"), undefined);
});

test("resolveOhosHdcTarget 吞掉读取异常，不阻断 host 启动", () => {
  assert.equal(
    resolveOhosHdcTarget(() => {
      throw new Error("param not found");
    }),
    undefined,
  );
});

// spec 11：devecocli 只读 COMMAND_LINE_TOOL_PATH，host 把 DEVECO_CLI_CLT_PATH 补成别名。
test("resolveCommandLineToolPath 显式值优先，缺省回落到 DEVECO_CLI_CLT_PATH", () => {
  assert.equal(
    resolveCommandLineToolPath({
      COMMAND_LINE_TOOL_PATH: "/clt/explicit",
      DEVECO_CLI_CLT_PATH: "/clt/deveco",
    }),
    "/clt/explicit",
  );
  assert.equal(
    resolveCommandLineToolPath({ DEVECO_CLI_CLT_PATH: "/clt/deveco" }),
    "/clt/deveco",
  );
});

test("resolveCommandLineToolPath 空值与空白都视为未设置", () => {
  assert.equal(resolveCommandLineToolPath({}), undefined);
  assert.equal(resolveCommandLineToolPath({ COMMAND_LINE_TOOL_PATH: "  " }), undefined);
  assert.equal(
    resolveCommandLineToolPath({ COMMAND_LINE_TOOL_PATH: " ", DEVECO_CLI_CLT_PATH: "  " }),
    undefined,
  );
});
