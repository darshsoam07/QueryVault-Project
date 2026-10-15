import { describe, expect, it } from "vitest";
import { hasComparisonCoverage } from "../retrieval/coverage";
describe("explicit comparison coverage", () => {
  it("requires all selected documents for a complete comparison", () => {
    expect(
      hasComparisonCoverage(
        "Compare these documents",
        ["a", "b", "c"],
        [{ documentId: "a" }, { documentId: "b" }],
      ),
    ).toBe(false);
    expect(
      hasComparisonCoverage(
        "Compare these documents",
        ["a", "b", "c"],
        [{ documentId: "a" }, { documentId: "b" }, { documentId: "c" }],
      ),
    ).toBe(true);
  });
  it("does not force unrelated selected documents into a simple answer", () => {
    expect(
      hasComparisonCoverage("What is the invoice amount?", ["a", "b"], [{ documentId: "a" }]),
    ).toBe(true);
  });
});
