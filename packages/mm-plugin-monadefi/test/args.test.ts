import { describe, expect, it } from "vitest";
import { InputError, parseFraction, parseLeverage, parseMarket, parseOriginChain, parsePercent, parsePositive, parseRiskProfile, parseSide, toBaseUnits } from "../src/lib/args";

describe("argument parsing", () => {
  it("parses sides and aliases", () => {
    expect(parseSide("long")).toBe("long");
    expect(parseSide("BUY")).toBe("long");
    expect(parseSide("sell")).toBe("short");
    expect(() => parseSide("up")).toThrow(InputError);
  });

  it("parses leverage and refuses more than the market maximum", () => {
    expect(parseLeverage("5")).toBe(5);
    expect(parseLeverage("2x")).toBe(2);
    expect(parseLeverage("1.5X", 12)).toBe(1.5);
    expect(() => parseLeverage("13", 12)).toThrow(/most leverage on this Perpl market is 12x/);
    expect(() => parseLeverage("0.5")).toThrow(/at least 1x/);
    expect(() => parseLeverage("2.555")).toThrow(/two decimals/);
    expect(() => parseLeverage("abc")).toThrow(InputError);
  });

  it("parses positive numbers strictly", () => {
    expect(parsePositive("margin", "20")).toBe(20);
    expect(parsePositive("margin", "1,000")).toBe(1000);
    expect(() => parsePositive("margin", "")).toThrow(/required/);
    expect(() => parsePositive("margin", "-5")).toThrow(/number/);
    expect(() => parsePositive("margin", "0")).toThrow(/above zero/);
    expect(() => parsePositive("margin", "5", { max: 4 })).toThrow(/at most 4/);
  });

  it("parses percentages and fractions", () => {
    expect(parsePercent("trailing", "3%")).toBeCloseTo(0.03);
    expect(parsePercent("trailing", "2.5")).toBeCloseTo(0.025);
    expect(() => parsePercent("trailing", "100%")).toThrow(/below 100%/);
    expect(parseFraction(undefined)).toBe(1);
    expect(parseFraction("0.5")).toBe(0.5);
    expect(parseFraction("25%")).toBe(0.25);
    expect(() => parseFraction("1.5")).toThrow(/at most 1/);
  });

  it("normalizes market symbols", () => {
    expect(parseMarket("eth")).toBe("ETH");
    expect(parseMarket("ETH-PERP")).toBe("ETH");
    expect(parseMarket("btc/usdc")).toBe("BTC");
    expect(() => parseMarket("")).toThrow(/required/);
  });

  it("resolves origin chains with Aurora chain codes", () => {
    expect(parseOriginChain("base")).toMatchObject({ chainId: 8453, aurora: "base" });
    expect(parseOriginChain("arb")).toMatchObject({ chainId: 42161, aurora: "arb" });
    expect(parseOriginChain("42161").key).toBe("arbitrum");
    expect(() => parseOriginChain("solana")).toThrow(/--from must be one of/);
  });

  it("parses risk profiles", () => {
    expect(parseRiskProfile("Conservative")).toBe("conservative");
    expect(() => parseRiskProfile("yolo")).toThrow(InputError);
  });

  it("converts decimal amounts to base units without float loss", () => {
    expect(toBaseUnits("50", 6)).toBe(50_000_000n);
    expect(toBaseUnits("0.1", 18)).toBe(100_000_000_000_000_000n);
    expect(toBaseUnits("123.456789", 6)).toBe(123_456_789n);
    expect(() => toBaseUnits("1.1234567", 6)).toThrow(/decimals/);
  });
});
