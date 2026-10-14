import { describe, expect, it } from "vitest";
import { IGenUiService, type GenUiPrepareParams } from "./contract.js";
import { exampleGenUiPrepare } from "./contract.example.js";

describe("gen-ui service contract", () => {
  it("keeps the example prepare params aligned with the contract surface", () => {
    const example: GenUiPrepareParams = exampleGenUiPrepare;
    expect(example.workspacePath).toBe("/workspace");
    expect(example.html).toContain("chart");
    expect(example.ownerWebContentsId).toBeGreaterThan(0);
    expect(example.instanceKey).toBe("message-1");
  });

  it("exposes the stable service descriptor channel", () => {
    expect(IGenUiService.channelName).toBe("gen-ui");
  });
});
