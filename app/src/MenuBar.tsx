import { Button, Dropdown, MenuProps } from "antd";
import { CheckOutlined } from "@ant-design/icons";

export interface MenuItem {
  label?: string;
  hint?: string;
  fn?: () => void;
  checked?: boolean;
  separator?: boolean;
  disabled?: boolean;
  /// 子菜单(悬停展开;仅支持一级嵌套)。
  children?: MenuItem[];
}

export interface MenuDef {
  label: string;
  items: MenuItem[];
}

type AntdItem = NonNullable<MenuProps["items"]>[number];

/// 递归转换应用菜单定义 → antd Menu items(叶子项点击即执行 fn)。
/// 勾选位 = CheckOutlined;快捷键 hint = 右侧 kbd 样式。
function toAntdItems(items: MenuItem[]): AntdItem[] {
  return items.map((item, i) => {
    if (item.separator) return { type: "divider", key: `sep-${i}` };
    const label = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 18, width: "100%", justifyContent: "space-between" }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
          <span style={{ display: "inline-block", width: 12, color: "var(--accent)" }}>
            {item.checked ? <CheckOutlined /> : null}
          </span>
          {item.label}
        </span>
        {item.hint && (
          <span
            style={{
              fontSize: 10,
              color: "var(--text-dim)",
              border: "1px solid var(--border)",
              borderRadius: 4,
              padding: "0 4px",
              lineHeight: "16px",
            }}
          >
            {item.hint}
          </span>
        )}
      </span>
    );
    return {
      key: `${item.label ?? i}-${i}`,
      label,
      disabled: item.disabled,
      children: item.children ? toAntdItems(item.children) : undefined,
      onClick: item.children
        ? undefined
        : () => {
            item.fn?.();
          },
    };
  });
}

/**
 * 顶部菜单栏(antd Dropdown + Menu):点击展开、悬停切换分组;
 * 条目支持勾选位/快捷键提示/禁用/一级子菜单。
 * 弹层经 getPopupContainer 挂在本组件容器内(不逃逸顶栏堆叠上下文)。
 */
export default function MenuBar({ menus }: { menus: MenuDef[] }) {
  return (
    <div
      style={{ display: "flex", alignItems: "center", gap: 2 }}
      onClick={(e) => e.stopPropagation()}
    >
      {menus.map((m) => (
        <Dropdown
          key={m.label}
          trigger={["click"]}
          placement="bottomLeft"
          getPopupContainer={(trigger) => trigger.parentElement as HTMLElement}
          menu={{
            items: toAntdItems(m.items),
          }}
        >
          <Button size="small" className="menu-trigger">
            {m.label}
          </Button>
        </Dropdown>
      ))}
    </div>
  );
}
