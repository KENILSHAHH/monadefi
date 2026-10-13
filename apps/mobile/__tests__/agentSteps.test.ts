import { currentStep, elapsedLabel, humanize, stepInfo, stepsOf } from "../src/lib/agentSteps";
import type { ChatMessage } from "../src/lib/chatModel";

describe("agent step line", () => {
  it("maps tool names to an icon and a plain label", () => {
    expect(stepInfo("perpl_markets")).toEqual({ icon: "chart-line", label: "Reading Perpl markets" });
    expect(stepInfo("risk_check")).toEqual({ icon: "shield-check", label: "Checking Nansen risk" });
    expect(stepInfo("bash").icon).toBe("console");
    expect(stepInfo("web_fetch").icon).toBe("magnify");
    expect(stepInfo("perpl_docs__searchDocumentation")).toEqual({ icon: "magnify", label: "Searching the Perpl docs" });
    expect(stepInfo("nansen__smart_money").icon).toBe("shield-check");
    expect(stepInfo("swap").icon).toBe("swap-horizontal");
    expect(stepInfo("bridge_quote").icon).toBe("swap-horizontal");
    expect(stepInfo("job_schedule").icon).toBe("clock-outline");
    expect(stepInfo("memory_recall").icon).toBe("brain");
    expect(stepInfo("evm_simulate")).toEqual({ icon: "flash", label: "Simulating on Monad" });
    expect(stepInfo("some_new_tool")).toEqual({ icon: "circle-small", label: "Some new tool" });
    expect(humanize("getPage")).toBe("Get page");
  });

  it("the current step follows the stream", () => {
    const m: ChatMessage = { role: "assistant", parts: [] };
    expect(currentStep(m).label).toBe("Thinking");
    const m2: ChatMessage = { role: "assistant", parts: [{ kind: "tool", id: "t1", name: "perpl_book" }] };
    expect(currentStep(m2)).toMatchObject({ key: "t1", label: "Reading the order book" });
    const m3: ChatMessage = { role: "assistant", parts: [{ kind: "tool", id: "t1", name: "perpl_book", result: "ok" }, { kind: "text", text: "Hi" }] };
    expect(currentStep(m3).label).toBe("Writing the answer");
    expect(stepsOf(m3)).toEqual([expect.objectContaining({ id: "t1", done: true, isError: false, preview: "ok" })]);
  });

  it("elapsed label", () => {
    expect(elapsedLabel(14_200)).toBe("14s");
    expect(elapsedLabel(125_000)).toBe("2m 05s");
  });
});
