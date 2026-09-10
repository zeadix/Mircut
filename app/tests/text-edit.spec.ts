import { test, expect } from "@playwright/test";

/// 经窗口菜单开关工作面板(key: 面板英文键;label: 菜单中文名)。
async function toggleWorkPanel(page: import("@playwright/test").Page, key: string, label: string) {
  await page.getByRole("button", { name: "窗口", exact: true }).click();
  await page.getByRole("button").filter({ hasText: label }).last().click();
  return page.locator(`[data-panel="${key}"]`);
}


/**
 * 双击进入文字编辑模式回归:
 * - 双击时间轴文字块 → 选中 + 属性面板文字区高亮聚焦
 * - 修改内容失焦生效 → 预览/列表同步
 */

async function addTextClip(page: import("@playwright/test").Page) {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  const textPanel = await toggleWorkPanel(page, "text", "文字");
  await textPanel.getByRole("button", { name: "+ 在播放头新建文字" }).click();
  await expect
    .poll(
      async () =>
        page.evaluate(() => window.__veditorMock.doc.clips.some((c) => c.text) ? 1 : 0),
      { timeout: 10000 }
    )
    .toBe(1);
  // 等 app 侧 doc(refresh 节流 150ms)真实渲染:文字面板列表出现片段后,
  // 时间轴画布上的文字块才可命中(否则双击落在下方视频块上)
  await expect(
    page.locator('[data-panel="text"]').getByText(/文字片段\(/).first()
  ).toBeVisible({ timeout: 5000 });
  await page.waitForTimeout(400);
  return page.locator("aside").last();
}

test("双击时间轴文字块进入编辑,改内容生效", async ({ page }) => {
  const rightAside = await addTextClip(page);

  // 双击时间轴文字块(文字轨置顶,视频行在轨道顶部;0~90ticks = 0~45px)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.dblclick(cb!.x + 20, cb!.y + 12);

  // 属性面板自动切到"属性"并进入编辑态(完成编辑按钮出现)
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toBeVisible({ timeout: 5000 });

  // 改内容(失焦提交)
  const ta = rightAside.locator("fieldset:has(button:text('完成编辑')) textarea");
  await ta.fill("新标题内容");
  await ta.blur();

  await expect
    .poll(
      async () =>
        page.evaluate(
          () => window.__veditorMock.doc.clips.find((c) => c.text)?.text?.content ?? ""
        ),
      { timeout: 10000 }
    )
    .toBe("新标题内容");

  // 完成编辑 → 编辑态退出
  await rightAside.getByRole("button", { name: "完成编辑" }).click();
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toHaveCount(0);
});

test("双击预览文字层进入编辑", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".asset-card").first()).toBeVisible();
  const rightAside = await addTextClip(page);

  // 等文字层真实渲染进预览(doc 刷新有 150ms 节流,过早双击会命中视频层)
  const frame = page.locator("[data-veditor-comp-frame]");
  await expect(frame.locator("[data-veditor-layer]").filter({ hasText: "双击编辑" })).toBeVisible({
    timeout: 5000,
  });

  // 双击预览舞台中央的文字层(文字片段 rect 居中 80% 宽)
  const fb = await frame.boundingBox();
  await page.mouse.dblclick(fb!.x + fb!.width / 2, fb!.y + fb!.height / 2);

  // 编辑信号:属性面板出现完成编辑按钮
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toBeVisible({ timeout: 5000 });
});

test("退格键不删除元素:清空文字内容后连按退格,文字块仍在", async ({ page }) => {
  const rightAside = await addTextClip(page);

  // 双击时间轴文字块进入编辑模式(textarea 获得焦点)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.dblclick(cb!.x + 20, cb!.y + 12);
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toBeVisible({ timeout: 5000 });

  // 清空内容后在空文本域上连按退格(此前触发全局删除,把文字块删掉)
  const ta = rightAside.locator("fieldset:has(button:text('完成编辑')) textarea");
  await ta.fill("");
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(80);
  }

  // 文字块仍在(仍有一条 text 片段),编辑会话未中断
  await expect
    .poll(async () => page.evaluate(() => window.__veditorMock.doc.clips.filter((c) => c.text).length))
    .toBeGreaterThanOrEqual(1);
  await expect(ta).toBeVisible();
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toBeVisible();
});

test("字体与斜体设置写入文字片段", async ({ page }) => {
  const rightAside = await addTextClip(page);

  // 双击进入编辑(文字区块可见)
  const canvas = page.locator('[data-veditor-drop="timeline"] canvas').first();
  const cb = await canvas.boundingBox();
  await page.mouse.dblclick(cb!.x + 20, cb!.y + 12);
  await expect(rightAside.getByRole("button", { name: "完成编辑" })).toBeVisible({ timeout: 5000 });

  // 选字体(自绘下拉,选项以自身字体渲染):点开 → 点选 Noto Sans CJK SC
  const fontBtn = rightAside.locator("button[title^='字体']");
  await expect(fontBtn).toBeVisible();
  await fontBtn.click();
  await rightAside.getByRole("button", { name: "Noto Sans CJK SC", exact: true }).click();
  await expect
    .poll(async () => page.evaluate(() => window.__veditorMock.doc.clips.find((c) => c.text)?.text?.font ?? ""))
    .toBe("Noto Sans CJK SC");

  // 勾选斜体
  // 受控勾选经 refresh(150ms 节流)回显,用 click + 文档断言(check 会因回显延迟重试点击导致双切换)
  const italic = rightAside.locator("label").filter({ hasText: "斜体" }).locator("input");
  await italic.click();
  await expect
    .poll(async () => page.evaluate(() => window.__veditorMock.doc.clips.find((c) => c.text)?.text?.italic ?? false))
    .toBe(true);
});
