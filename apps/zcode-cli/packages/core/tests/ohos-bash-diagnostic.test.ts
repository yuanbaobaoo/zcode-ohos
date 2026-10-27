import { describe, expect, it } from "vitest";
import {
  buildOhosEnvShebangHint,
  formatOhosBashModelContent,
} from "../src/tool/handlers/ohos-bash-diagnostic.js";

const failure = {
  exitCode: 1,
  stderr: "/storage/Users/currentUser/npm/bin/pnpm: /usr/bin/env: bad interpreter: No such file",
};

describe("ohos bash env shebang diagnostic", () => {
  it("OHOS 且命中 bad interpreter 时给出显式解释器提示", () => {
    const hint = buildOhosEnvShebangHint(failure, "ohos");
    expect(hint).toContain("[ohos]");
    expect(hint).toContain("explicit interpreter");
  });

  it("非 OHOS 平台不提示", () => {
    expect(buildOhosEnvShebangHint(failure, "darwin")).toBeNull();
  });

  it("成功退出或未命中模式不提示", () => {
    expect(
      buildOhosEnvShebangHint({ exitCode: 0, stderr: failure.stderr }, "ohos"),
    ).toBeNull();
    expect(
      buildOhosEnvShebangHint({ exitCode: 1, stderr: "command not found" }, "ohos"),
    ).toBeNull();
  });

  it("OHOS 管道把错误并进 stdout 时仍能命中", () => {
    const hint = buildOhosEnvShebangHint(
      { exitCode: 126, stderr: "", stdout: failure.stderr },
      "ohos",
    );
    expect(hint).toContain("[ohos]");
  });

  it("模型输出追加提示且不重复追加", () => {
    const content = formatOhosBashModelContent(failure, "ohos");
    expect(typeof content).toBe("string");
    expect(content as string).toContain("[ohos]");
    const twice = formatOhosBashModelContent(
      { ...failure, stderr: `${failure.stderr}\n[ohos]` },
      "ohos",
    );
    expect((twice as string).match(/\[ohos\]/g)?.length).toBe(1);
  });

  it("非 OHOS 平台模型输出保持原样", () => {
    const content = formatOhosBashModelContent(failure, "darwin") as string;
    expect(content).not.toContain("[ohos]");
  });

  it("接缝：Bash 工具入口的 formatModelContent 已接到 OHOS 包装", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "ohos", configurable: true });
    try {
      const { createBashToolEntry } = await import("../src/tool/handlers/bash.js");
      const entry = createBashToolEntry();
      const content = entry.formatModelContent?.({ exitCode: 126, stderr: failure.stderr });
      expect(String(content)).toContain("[ohos]");
    } finally {
      Object.defineProperty(process, "platform", { value: original, configurable: true });
    }
  });
});
