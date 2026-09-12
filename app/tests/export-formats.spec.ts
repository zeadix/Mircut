import { test, expect } from "@playwright/test";

/**
 * 导出多格式/多编码器回归(mock 探测:软编全家可用 + h264_nvenc 硬编
 * + h264_vaapi/hevc_qsv 试编失败)。下拉为 PopupSelect 自定义弹层
 * (触发器 data-select / 弹层 data-select-popup / 选项行 data-value,
 * 禁用行带 data-disabled="1",分组标题 data-group):
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
  const encBtn = page.locator("button[data-select='export-encoder']");
  await encBtn.click();
  const encPopup = page.locator("[data-select-popup='export-encoder']");
  await expect(encPopup.locator("[data-value='libx265']")).toHaveCount(1);
  await expect(encPopup.locator("[data-value='libsvtav1']")).toHaveCount(1);
  await expect(encPopup.locator("[data-value='libaom-av1']")).toHaveCount(1);
  await expect(encPopup.locator("[data-value='libvpx-vp9']")).toHaveCount(1);
  // 版权分组标题(免版税优先)
  await expect(encPopup.locator("[data-group='免版税(商用无忧)']")).toHaveCount(1);
  await expect(encPopup.locator("[data-group='通用']")).toHaveCount(1);
  await expect(encPopup.locator("[data-group='需注意授权']")).toHaveCount(1);
  // mock 硬编:h264_nvenc 可用;试编失败组:VAAPI/QSV 置灰
  await expect(encPopup.locator("[data-group='硬件加速']")).toHaveCount(1);
  await expect(encPopup.locator("[data-value='h264_nvenc']")).toHaveCount(1);
  await expect(encPopup.locator("[data-group='本机不可用(试编失败)']")).toHaveCount(1);
  await expect(encPopup.locator("[data-value='h264_vaapi']")).toHaveAttribute("data-disabled", "1");
  await expect(encPopup.locator("[data-value='hevc_qsv']")).toHaveAttribute("data-disabled", "1");

  // 默认 MP4:H.264 可选,VP9 被禁用(WebM 才允许)
  await expect(encPopup.locator("[data-value='libx264']")).not.toHaveAttribute("data-disabled", "1");
  await expect(encPopup.locator("[data-value='libvpx-vp9']")).toHaveAttribute("data-disabled", "1");

  // 容器下拉:五项(含 GIF)。真实用户路径:先选 WebM 兼容编码器(SVT-AV1,
  // 自定义下拉尊重禁用行,不再像 selectOption 那样绕过),再切 WebM
  const fmtBtn = page.locator("button[data-select='export-format']");
  await page.keyboard.press("Escape"); // 先关编码器弹层(展开时遮挡容器触发器)
  await encBtn.click();
  await encPopup.locator("[data-value='libsvtav1']").click();
  await expect(encBtn).toHaveAttribute("data-value", "libsvtav1");
  await fmtBtn.click();
  const fmtPopup = page.locator("[data-select-popup='export-format']");
  for (const v of ["mp4", "mkv", "webm", "mov", "gif"]) {
    await expect(fmtPopup.locator(`[data-value='${v}']`)).toHaveCount(1);
  }
  await fmtPopup.locator("[data-value='webm']").click();
  await encBtn.click();
  await expect(encPopup.locator("[data-value='libx264']")).toHaveAttribute("data-disabled", "1");
  await expect(encPopup.locator("[data-value='libsvtav1']")).not.toHaveAttribute("data-disabled", "1");
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
  const encBtn = page.locator("button[data-select='export-encoder']");
  // mock:SVT-AV1 可用 -> 选中它;容器切 WebM
  await expect(encBtn).toHaveAttribute("data-value", "libsvtav1");
  await expect(page.locator("button[data-select='export-format']")).toHaveAttribute("data-value", "webm");
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

  const fmtBtn = page.locator("button[data-select='export-format']");
  await fmtBtn.click();
  await page.locator("[data-select-popup='export-format'] [data-value='gif']").click();
  // GIF 提示出现;编码器下拉禁用(内置编码)
  await expect(page.getByText(/GIF 动图:无音频/)).toBeVisible();
  const encBtn = page.locator("button[data-select='export-encoder']");
  await expect(encBtn).toBeDisabled();

  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
});

test("仅音频导出:入队完成", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  await page.getByRole("button", { name: "导出", exact: true }).click();
  await expect(page.getByText("导出队列")).toBeVisible();

  // mock 初始文档带音频块:直接入队(默认 MP3)
  const audioBtn = page.locator("button[data-select='export-audio']");
  await audioBtn.click();
  const audioPopup = page.locator("[data-select-popup='export-audio']");
  await expect(audioPopup.locator("div", { hasText: "WAV(无损)" })).toHaveCount(1);
  await audioPopup.locator("[data-value='flac']").click();
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
  const encBtn = page.locator("button[data-select='export-encoder']");
  await encBtn.click();
  await page.locator("[data-select-popup='export-encoder'] [data-value='libx265']").click();
  const fmtBtn = page.locator("button[data-select='export-format']");
  await fmtBtn.click();
  await page.locator("[data-select-popup='export-format'] [data-value='mkv']").click();

  await page.getByRole("button", { name: "加入队列", exact: true }).click();
  await expect(page.locator("text=完成").first()).toBeVisible({ timeout: 5000 });
});
