// @vitest-environment jsdom
// spec：specs/ohos-port/13-本机电脑控制产品化.md（缺陷修复五）——共享设置快照的乐观预写。
// 输入框按钮显隐读共享快照，默认要等 update+get 两段 RPC 往返（宿主繁忙时秒级延迟）；
// 预写让共享快照即时变化，成功路径由 get 真值覆盖，失败路径由调用方 refresh 回滚。
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import type { AppSettings } from "@zcode/shared";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/hooks/useServices.js", () => ({ useServices: () => ({}) }));
vi.mock("@/hooks/usePlatform.js", () => ({
  usePlatform: () => ({}),
}));

// 全文件共用同一模块实例：用例内重新 import 会拿到 resetModules 后的新实例，
// probe 与 refresh 会落在两个平行快照上（快照按 service 实例分槽，无需 reset）。
const settingsModule = await import("@/hooks/useSettingService.js");
const { applyOptimisticSettingsPatch, useSettings } = settingsModule;

type FakeService = {
  get: () => Promise<AppSettings>;
  update: (patch: Partial<AppSettings>) => Promise<void>;
};

function createFakeService(): { service: FakeService; current: () => AppSettings } {
  let value: AppSettings = {
    computerUseComposerEntryHidden: true,
  } as unknown as AppSettings;
  return {
    service: {
      get: async () => value,
      update: async (patch: Partial<AppSettings>) => {
        value = { ...value, ...patch };
      },
    },
    current: () => value,
  };
}

/** 渲染一个 useSettings 探针组件，返回当前读到的 settings（共享快照的消费者视角）。 */
function mountProbe(service: FakeService): { read: () => AppSettings | null; unmount: () => void } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  let settings: AppSettings | null = null;
  const root: Root = createRoot(container);
  function ProbeComponent(): null {
    const { settings: snapshot } = useSettings({ services: { settingService: service } as never });
    settings = snapshot;
    return null;
  }
  act(() => {
    root.render(createElement(ProbeComponent));
  });
  return {
    read: () => settings,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("applyOptimisticSettingsPatch（共享设置快照乐观预写）", () => {
  it("预写即时更新共享快照（不等 RPC），成功路径 get 真值随后校准", async () => {
    const fake = createFakeService();
    const probe = mountProbe(fake.service);
    try {
      // 播种完成（probe 挂载即 get）：初始 hidden=true。
      await act(async () => {});
      expect(probe.read()?.computerUseComposerEntryHidden).toBe(true);

      // 预写：共享快照立即翻为 false，此刻服务端事实仍是 true（update 尚未发生）。
      applyOptimisticSettingsPatch({
        settingService: fake.service,
        patch: { computerUseComposerEntryHidden: false },
      });
      await act(async () => {});
      expect(probe.read()?.computerUseComposerEntryHidden).toBe(false);
      expect(fake.current().computerUseComposerEntryHidden).toBe(true);

      // 成功路径：服务端落盘后 get 真值覆盖（仍为一致结论）。
      await fake.service.update({ computerUseComposerEntryHidden: false });
      await act(async () => {
        await settingsModule.updateSettingsAndRefreshSnapshot({
          settingService: fake.service,
          patch: {},
        });
      });
      expect(probe.read()?.computerUseComposerEntryHidden).toBe(false);
    } finally {
      probe.unmount();
    }
  });

  it("预写偏离服务端事实且落盘失败时，refresh 以服务端真值回滚", async () => {
    const fake = createFakeService();
    const probe = mountProbe(fake.service);
    try {
      await act(async () => {});
      applyOptimisticSettingsPatch({
        settingService: fake.service,
        patch: { computerUseComposerEntryHidden: false },
      });
      await act(async () => {});
      expect(probe.read()?.computerUseComposerEntryHidden).toBe(false);

      // 模拟失败路径：update 未发生，直接 refresh（设置页 catch 分支的行为）。
      await act(async () => {
        await settingsModule.updateSettingsAndRefreshSnapshot({
          settingService: fake.service,
          patch: {},
        });
      });
      expect(probe.read()?.computerUseComposerEntryHidden).toBe(true);
    } finally {
      probe.unmount();
    }
  });

  it("冷启动无快照时预写为 no-op，不制造事实", () => {
    const fake = createFakeService();
    expect(() =>
      applyOptimisticSettingsPatch({
        settingService: fake.service,
        patch: { computerUseComposerEntryHidden: false },
      }),
    ).not.toThrow();
  });
});
