import { ausd, eta, fixed, num, parseAmount, pct, price, relativeTime, short, shortDate, signedUsd, usd } from "../src/lib/format";
import { clampLeverage, fundingApr, roughLiquidation } from "../src/lib/markets";

describe("amount formatting", () => {
  it("fixed: separators, rounding, negatives", () => {
    expect(fixed(1234567.891, 2)).toBe("1,234,567.89");
    expect(fixed(0.005, 2)).toBe("0.01");
    expect(fixed(-1.234, 1)).toBe("-1.2");
    expect(fixed(-0.001, 2)).toBe("0.00");
    expect(fixed(1e3, 0)).toBe("1,000");
    expect(fixed(Number.NaN, 2)).toBe("—");
  });

  it("usd and AUSD", () => {
    expect(usd(202.6)).toBe("$202.60");
    expect(usd(-4)).toBe("-$4.00");
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.0042)).toBe("$0.0042");
    expect(usd(null)).toBe("—");
    expect(ausd(120.5)).toBe("120.50 AUSD");
    expect(signedUsd(12.3)).toBe("+$12.30");
    expect(signedUsd(-4)).toBe("-$4.00");
  });

  it("num drops trailing zeros", () => {
    expect(num(2431.5, 2)).toBe("2,431.5");
    expect(num(0.00012, 6)).toBe("0.00012");
    expect(num(3, 2)).toBe("3");
    expect(num(undefined)).toBe("—");
  });

  it("price precision follows the size", () => {
    expect(price(104250.54)).toBe("104,250.5");
    expect(price(2431.256)).toBe("2,431.26");
    expect(price(1.23456)).toBe("1.2346");
    expect(price(0.0123456)).toBe("0.01235");
    expect(price(0.000123456)).toBe("0.00012346");
  });

  it("pct from a fraction", () => {
    expect(pct(0.1234)).toBe("12.34%");
    expect(pct(0.05, 1, true)).toBe("+5.0%");
    expect(pct(-0.05, 1, true)).toBe("-5.0%");
  });

  it("parses typed amounts", () => {
    expect(parseAmount("12")).toBe(12);
    expect(parseAmount("12.5")).toBe(12.5);
    expect(parseAmount("12,5")).toBe(12.5);
    expect(parseAmount("1,234.5")).toBe(1234.5);
    expect(parseAmount(" .5 ")).toBe(0.5);
    expect(parseAmount("0")).toBeNull();
    expect(parseAmount("-3")).toBeNull();
    expect(parseAmount("abc")).toBeNull();
    expect(parseAmount("1.2.3")).toBeNull();
    expect(parseAmount("")).toBeNull();
  });

  it("short address, dates and times", () => {
    expect(short("0xF278cF59F82eDcf871d630F28EcC8056f25C1cdb")).toBe("0xF278…1cdb");
    expect(shortDate("2026-11-12T10:00:00")).toBe("Nov 12, 2026");
    const now = Date.parse("2026-10-13T12:00:00Z");
    expect(relativeTime("2026-10-13T11:58:00Z", now)).toBe("2 min ago");
    expect(relativeTime("2026-10-13T09:00:00Z", now)).toBe("3 h ago");
    expect(relativeTime("2026-10-13T12:00:02Z", now)).toBe("now");
    expect(eta(45)).toBe("about 45 s");
    expect(eta(600)).toBe("about 10 min");
    expect(eta(0)).toBe("—");
  });
});

describe("market helpers", () => {
  it("clamps leverage to whole steps within the market max", () => {
    expect(clampLeverage(0, 10)).toBe(1);
    expect(clampLeverage(4.6, 10)).toBe(5);
    expect(clampLeverage(20, 12)).toBe(12);
    expect(clampLeverage(3, 2.5)).toBe(2);
  });

  it("yearly funding from the per-interval rate", () => {
    expect(fundingApr({ fundingRate: 0.0001, fundingIntervalSec: 3600 })).toBeCloseTo(0.876, 6);
    expect(fundingApr({ fundingRate: 0.0001, fundingIntervalSec: 0 })).toBe(0);
  });

  it("rough liquidation for long and short", () => {
    expect(roughLiquidation(100, 10, 0.05, "long")).toBeCloseTo(95, 9);
    expect(roughLiquidation(100, 10, 0.05, "short")).toBeCloseTo(105, 9);
    expect(roughLiquidation(100, 25, 0.05, "long")).toBeNull();
  });
});
