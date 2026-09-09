import { test, expect } from "@playwright/test";

/**
 * 导出多格式/多编码器回归(mock 探测:软编全家可用 + h264_nvenc 硬编
 * + h264_vaapi/hevc_qsv 试编失败):
 * - 编码器按版权分组:免版税(AV1×2/VP9)/ 通用(H.264)/ 需注意授权(H.265)
 * - 硬件加速组(NVENC)可选;试编失败组(本机不可用)置灰
 * - 容器五项(含 GIF);WebM 与 H.264 组合被禁用
 * - 一键免版税预设;GIF 选中后编码器禁用;仅音频导出入口
 * - 队列入队后 mock 导出完成
 */

test("导出弹窗:编码器分组/格式/质量 UI", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();

  // 编码器下拉:软编组含 H.265/AV1×2/VP9(按 value 精确断言,避免匹配"不可用"项)
  const encSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "AV1" }) }).first();
  await expect(encSelect.locator("option[value='libx265']")).toHaveCount(1);
  await expect(encSelect.locator("option[value='libsvtav1']")).toHaveCount(1);
  await expect(encSelect.locator("option[value='libaom-av1']")).toHaveCount(1);
  await expect(encSelect.locator("option[value='libvpx-vp9']")).toHaveCount(1);
  // 版权分组标题(免版税优先)
  await expect(encSelect.locator("optgroup[label='免版税(商用无忧)']")).toHaveCount(1);
  await expect(encSelect.locator("optgroup[label='通用']")).toHaveCount(1);
  await expect(encSelect.locator("optgroup[label='需注意授权']")).toHaveCount(1);
  // mock 硬编:h264_nvenc 可用;试编失败组:VAAPI/QSV 置灰
  await expect(encSelect.locator("optgroup[label='硬件加速']")).toHaveCount(1);
  await expect(encSelect.locator("option[value='h264_nvenc']")).toHaveCount(1);
  await expect(encSelect.locator("optgroup[label='本机不可用(试编失败)']")).toHaveCount(1);
  // 注:Playwright 的 toBeDisabled 对 <option> 判定不可靠,统一用 disabled 属性断言
  await expect(encSelect.locator("option[value='h264_vaapi']")).toHaveAttribute("disabled", "");
  await expect(encSelect.locator("option[value='hevc_qsv']")).toHaveAttribute("disabled", "");

  // 默认 MP4:H.264/NVENC 可选,VP9 被禁用(WebM 才允许)
  await expect(encSelect.locator("option[value='libx264']")).toBeEnabled();
  await expect(encSelect.locator("option[value='libvpx-vp9']")).toHaveAttribute("disabled", "");

  // 容器下拉:五项(含 GIF);切到 WebM 后 H.264 变禁用
  const fmtSelect = page.locator("select").filter({ has: page.locator("option[value='webm']") }).first();
  for (const v of ["mp4", "mkv", "webm", "mov", "gif"]) {
    await expect(fmtSelect.locator(`option[value='${v}']`)).toHaveCount(1);
  }
  await fmtSelect.selectOption("webm");
  await expect(encSelect.locator("option[value='libx264']")).toHaveAttribute("disabled", "");
  await expect(encSelect.locator("option[value='libsvtav1']")).toBeEnabled();
  // 输出路径扩展名自动替换为 .webm
  await expect
    .poll(async () => {
      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll("input:not([type='range'])")].map((x) => x.value)
      );
      return inputs.find((v) => v.startsWith("/tmp/veditor-export")) ?? "";
    })
    .toContain(".webm");

  // 质量滑条存在(1-100)
  const qualitySlider = page.locator("input[type='range']").first();
  await expect(qualitySlider).toBeVisible();
});

test("一键免版税:切 WebM + 免版税编码 + 扩展名联动", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();

  await page.getByRole("button", { name: "免版税", exact: true }).click();
  const encSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "AV1" }) }).first();
  // mock:SVT-AV1 可用 -> 选中它;容器切 WebM
  await expect(encSelect).toHaveValue("libsvtav1");
  const fmtSelect = page.locator("select").filter({ has: page.locator("option[value='webm']") }).first();
  await expect(fmtSelect).toHaveValue("webm");
  await expect
    .poll(async () => {
      const inputs = await page.evaluate(() =>
        [...document.querySelectorAll("input:not([type='range'])")].map((x) => x.value)
      );
      return inputs.find((v) => v.startsWith("/tmp/veditor-export")) ?? "";
    })
    .toContain(".webm");
});

test("GIF 容器:选中后编码器禁用,入队完成", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();

  const fmtSelect = page.locator("select").filter({ has: page.locator("option[value='gif']") }).first();
  await fmtSelect.selectOption("gif");
  // GIF 提示出现;编码器下拉禁用(内置编码)
  await expect(page.getByText(/GIF 动图:无音频/)).toBeVisible();
  const encSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "AV1" }) }).first();
  await expect(encSelect).toBeDisabled();

  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
});

test("仅音频导出:入队完成", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();

  // mock 初始文档带音频块:直接入队(默认 MP3)
  const audioSel = page.locator("select").filter({ has: page.locator("option[value='flac']") }).first();
  await expect(audioSel.locator("option", { hasText: "WAV(无损)" })).toHaveCount(1);
  await audioSel.selectOption("flac");
  await page.getByRole("button", { name: "导出音频", exact: true }).click();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
  await expect(page.locator("text=· 仅音频")).toBeVisible();
});

test("导出队列:选择 H.265 + MKV 后入队完成", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();

  // 选 H.265 + MKV
  const encSelect = page.locator("select").filter({ has: page.locator("option", { hasText: "AV1" }) }).first();
  await encSelect.selectOption("libx265");
  const fmtSelect = page.locator("select").filter({ has: page.locator("option[value='webm']") }).first();
  await fmtSelect.selectOption("mkv");

  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
});
