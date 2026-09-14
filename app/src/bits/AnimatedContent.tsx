import { motion } from "motion/react";
import { type ReactNode } from "react";

/**
 * React Bits · AnimatedContent
 * 内容进入动画:方向位移 + 淡入(motion 弹簧)。
 * 用于 dock 面板内容首次挂载时的进入反馈。
 */
export default function AnimatedContent({
  children,
  distance = 14,
  duration = 0.35,
  delay = 0,
  direction = "vertical",
}: {
  children: ReactNode;
  distance?: number;
  duration?: number;
  delay?: number;
  direction?: "vertical" | "horizontal";
}) {
  const offset = direction === "vertical" ? { y: distance } : { x: distance };
  return (
    <motion.div
      initial={{ opacity: 0, ...offset }}
      animate={{ opacity: 1, x: 0, y: 0 }}
      transition={{ duration, delay, ease: [0.22, 1, 0.36, 1] }}
      style={{ height: "100%" }}
    >
      {children}
    </motion.div>
  );
}
