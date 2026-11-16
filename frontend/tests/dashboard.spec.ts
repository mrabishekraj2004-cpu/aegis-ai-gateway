import { expect, test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

const pages = [
  ["/", "Overview"], ["/analytics/", "Request analytics"], ["/cost/", "Cost intelligence"],
  ["/reliability/", "Reliability center"], ["/routing/", "Routing console"], ["/providers/", "Providers"],
  ["/access/", "Security & access"], ["/playground/", "API playground"],
];

test("renders all screens, graphs and responsive layouts", async ({ page }) => {
  test.setTimeout(90000);
  for (const [width, height] of [[1440, 900], [1024, 768], [820, 1180], [768, 1024], [390, 844], [320, 700]]) {
    await page.setViewportSize({ width, height });
    for (const [path, name] of pages) {
      await page.goto(path);
      await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
      await expect(page.getByText("Demo data", { exact: true })).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth), `${path} at ${width}px`).toBeLessThanOrEqual(width);
    }
  }
});

test("navigation, command search, dialog focus, theme and date range", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeFocused();
  await page.keyboard.press("Enter");
  const navigation = page.getByRole("dialog", { name: "Navigation" });
  await expect(navigation).toBeVisible();
  await navigation.getByRole("link", { name: "Providers" }).click();
  await expect(page).toHaveURL(/\/providers\/$/);
  await page.keyboard.press("Control+k");
  await page.getByLabel("Search console").fill("cost");
  await page.getByRole("dialog").getByRole("link", { name: /Cost intelligence/ }).click();
  await expect(page).toHaveURL(/\/cost\/$/);
  await page.getByRole("button", { name: "Switch light or dark theme" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByLabel("Reporting date range").selectOption("7");
  await expect(page.getByLabel("Reporting date range")).toHaveValue("7");
  await page.getByText("View data", { exact: true }).first().click();
  await expect(page.getByRole("table", { name: "Daily spend in US dollars" })).toBeVisible();
  await page.getByRole("button", { name: "Connect gateway" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Connect to a gateway" });
  await expect(dialog).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("demo playground and policy editing are explicitly previews", async ({ page }) => {
  await page.goto("/playground/");
  await page.getByRole("button", { name: "Run sample" }).click();
  await expect(page.getByText("Sample complete", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Completion output")).toContainText("After streaming begins");
  await expect(page.getByText("No gateway request is made.", { exact: false })).toBeVisible();
  await page.goto("/routing/");
  await page.getByRole("button", { name: "Vision" }).click();
  await expect(page.getByRole("spinbutton", { name: "Priority for OpenAI" })).toBeVisible();
  await expect(page.getByRole("spinbutton", { name: "Priority for Anthropic" })).toHaveCount(0);
  await page.getByRole("spinbutton", { name: "Priority for OpenAI" }).fill("85");
  await expect(page.getByText("Edits update this preview.", { exact: false })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish change" })).toHaveCount(0);
});

test("automated accessibility checks across all screens and both themes", async ({ page }) => {
  test.setTimeout(90000);
  await page.setViewportSize({ width: 1440, height: 900 });
  for (const theme of ["light", "dark"]) {
    await page.goto("/");
    await page.evaluate((value) => localStorage.setItem("aegis-theme", value), theme);
    for (const [path] of pages) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"]).analyze();
      expect(results.violations, `${theme} ${path}`).toEqual([]);
    }
  }
});

test("live gateway smoke with disposable credential", async ({ page }) => {
  const token = process.env.AEGIS_E2E_KEY;
  test.skip(!token, "Requires a disposable live gateway and scoped key.");
  await page.goto("/");
  await page.getByRole("button", { name: "Connect gateway" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Connect to a gateway" });
  await dialog.getByLabel("Gateway URL").fill(process.env.AEGIS_E2E_URL ?? "http://127.0.0.1:18094");
  await dialog.getByLabel("API key", { exact: true }).fill("ag_test_invalid_fixture");
  await dialog.getByRole("button", { name: "Connect gateway" }).click();
  await expect(dialog.getByText("The API key is invalid or inactive.")).toBeVisible();
  await expect(page.getByText("Demo data", { exact: true })).toBeVisible();
  await dialog.getByLabel("API key", { exact: true }).fill(token!);
  await dialog.getByRole("button", { name: "Connect gateway" }).click();
  await expect(page.getByText("Live gateway", { exact: true })).toBeVisible();
  await expect(page.getByText("Provider telemetry unavailable")).toBeVisible();
  await page.getByRole("link", { name: "Playground" }).click();
  await page.getByLabel("Model alias").selectOption("mock-chat");
  await page.getByLabel("Prompt", { exact: true }).fill("Hello from the browser");
  await page.getByRole("button", { name: "Run inference" }).click();
  await expect(page.getByText("Complete", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Completion output")).toContainText("Aegis mock result");
  await expect(page.getByText(/total · .* input · .* output/)).toBeVisible();
  await page.getByRole("link", { name: "Cost intelligence" }).click();
  await expect(page.getByText("Budget limits unavailable")).toBeVisible();
  await expect(page.getByRole("row", { name: /mock-chat/ })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Demo data", { exact: true })).toBeVisible();
});

test("publishes an OIDC policy change and confirms disable with the real backend", async ({ page }) => {
  const token = process.env.AEGIS_E2E_ACCESS_TOKEN;
  const tenant = process.env.AEGIS_E2E_TENANT;
  test.skip(!token || !tenant, "Requires a disposable OIDC tenant and gateway.");
  await page.goto("/routing/");
  await page.getByRole("button", { name: "Connect gateway" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Connect to a gateway" });
  await dialog.getByLabel("Gateway URL").fill(process.env.AEGIS_E2E_URL ?? "http://127.0.0.1:18094");
  await dialog.getByLabel("Credential type").selectOption("user");
  await dialog.getByLabel("OIDC access token", { exact: true }).fill(token!);
  await dialog.getByLabel("Tenant UUID").fill(tenant!);
  await dialog.getByRole("button", { name: "Connect gateway" }).click();
  await expect(page.getByText("Live gateway", { exact: true })).toBeVisible();
  await page.getByRole("spinbutton", { name: /Priority for/ }).first().fill("94");
  await page.getByLabel("Change reason").fill("Browser integration publish");
  await page.getByRole("button", { name: "Publish change" }).click();
  await expect(page.getByText(/Gateway confirmed version 2/)).toBeVisible();
  await page.getByLabel("Change reason").fill("Browser integration disable");
  await page.getByRole("button", { name: "Disable policy" }).click();
  const confirm = page.getByRole("dialog", { name: "Disable routing policy?" });
  await expect(confirm).toBeVisible();
  await confirm.getByRole("button", { name: "Cancel" }).click();
  await expect(confirm).not.toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Disable policy" }).click();
  await confirm.getByRole("button", { name: "Disable policy" }).click();
  await expect(page.getByText(/Gateway confirmed version 3/)).toBeVisible();
  await expect(page.getByText("Disabled", { exact: true })).toBeVisible();
});
