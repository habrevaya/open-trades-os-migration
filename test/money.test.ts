import { describe, it, expect } from "vitest";
import * as money from "../src/money/index.js";

describe("parsing what sources actually send", () => {
  it("reads plain decimal strings", () => {
    expect(money.normalize("129.00")).toBe("129.0000");
    expect(money.normalize("0")).toBe("0.0000");
    expect(money.normalize("-8.5")).toBe("-8.5000");
  });

  it("reads integer cents when told to", () => {
    expect(money.normalize(34424, { cents: true })).toBe("344.2400");
    expect(money.normalize("248050", { cents: true })).toBe("2480.5000");
    expect(money.normalize(0, { cents: true })).toBe("0.0000");
  });

  it("treats a missing amount as zero rather than throwing", () => {
    expect(money.normalize(null)).toBe("0.0000");
    expect(money.normalize(undefined)).toBe("0.0000");
    expect(money.normalize("")).toBe("0.0000");
  });

  it("strips currency symbols and thousands separators", () => {
    expect(money.normalize("$1,234.56")).toBe("1234.5600");
    expect(money.normalize(" 1 234.56 ")).toBe("1234.5600");
  });

  it("reads a parenthesised negative from an accounting export", () => {
    expect(money.normalize("(120.00)")).toBe("-120.0000");
    expect(money.normalize("($1,120.00)")).toBe("-1120.0000");
  });

  it("refuses more precision than it can hold, instead of truncating silently", () => {
    // Truncating here loses a fraction of a cent per line, which reconciles
    // to nothing and is impossible to trace back afterwards.
    expect(() => money.normalize("1.234567")).toThrow(money.MoneyError);
  });

  it("refuses a non-integer cents amount", () => {
    expect(() => money.normalize(1.5, { cents: true })).toThrow(money.MoneyError);
  });

  it("refuses text that is not an amount", () => {
    expect(() => money.normalize("n/a")).toThrow(money.MoneyError);
    expect(() => money.normalize("12.00 USD")).toThrow(money.MoneyError);
  });
});

describe("arithmetic that does not drift", () => {
  it("adds the case that breaks floats", () => {
    expect(money.add("0.1", "0.2")).toBe("0.3000");
    // The float answer is 0.30000000000000004, and a thousand of those is a
    // reconciliation report that is off by a cent with no explanation.
    expect(money.add("0.1", "0.2")).not.toBe(String(0.1 + 0.2));
  });

  it("sums a long list without accumulating error", () => {
    const pennies = Array.from({ length: 10_000 }, () => "0.01");
    expect(money.sum(pennies)).toBe("100.0000");
  });

  it("subtracts into negative territory", () => {
    expect(money.subtract("344.24", "464.24")).toBe("-120.0000");
  });

  it("multiplies quantity by unit price", () => {
    expect(money.multiply("2", "129.00")).toBe("258.0000");
    expect(money.multiply("4", "15.00")).toBe("60.0000");
  });

  it("rounds half away from zero, the way an invoice does", () => {
    expect(money.multiply("3", "0.3333")).toBe("0.9999");
    // The product needs more precision than the scale holds: 0.0001 x 0.5 is
    // exactly half a unit in the last place, so it rounds up, and its negative
    // rounds down. Banker's rounding would send one of these the other way,
    // and the source system did not use banker's rounding.
    expect(money.multiply("0.0001", "0.5")).toBe("0.0001");
    expect(money.multiply("-0.0001", "0.5")).toBe("-0.0001");
    expect(money.multiply("0.0001", "0.4999")).toBe("0.0000");
  });

  it("compares without converting to a number", () => {
    expect(money.compare("10.00", "9.99")).toBe(1);
    expect(money.compare("9.99", "10.00")).toBe(-1);
    expect(money.equals("10", "10.0000")).toBe(true);
    expect(money.isZero("-0.0000")).toBe(true);
  });

  it("handles an amount larger than a float can hold exactly", () => {
    // Not hypothetical: a multi-branch shop's lifetime invoiced total.
    const huge = "90071992547409.9100";
    expect(money.add(huge, "0.01")).toBe("90071992547409.9200");
  });
});

describe("display", () => {
  it("renders two places with separators for a report", () => {
    expect(money.display("41206.1800")).toBe("$41,206.18");
    expect(money.display("-120.0000")).toBe("-$120.00");
    expect(money.display("0")).toBe("$0.00");
  });

  it("rounds the half cent up rather than down", () => {
    expect(money.display("1.005")).toBe("$1.01");
  });
});
