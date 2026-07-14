import { describe, expect, it } from "vitest";
import { APP_NAME } from "../src/index";

describe("PlanForge scaffold", () => {
  it("exports the app name", () => {
    expect(APP_NAME).toBe("PlanForge");
  });
});
