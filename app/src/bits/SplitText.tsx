import { motion } from "motion/react";

/**
 * React Bits · SplitText
 * 文本按字符逐个入场(位移 + 淡入 + 轻旋转),用于品牌标题。
 */
export default function SplitText({
  text,
  delay = 0,
  duration = 0.4,
  className,
}: {
  text: string;
  delay?: number;
  duration?: number;
  className?: string;
}) {
  const chars = [...text];
  return (
    <span className={className} style={{ display: "inline-flex", overflow: "hidden" }} aria-label={text}>
      {chars.map((ch, i) => (
        <motion.span
          key={i}
          aria-hidden
          initial={{ opacity: 0, y: "0.4em", rotate: -6 }}
          animate={{ opacity: 1, y: 0, rotate: 0 }}
          transition={{ duration, delay: delay + i * 0.045, ease: [0.22, 1, 0.36, 1] }}
          style={{ display: "inline-block", willChange: "transform" }}
        >
          {ch === " " ? "\u00A0" : ch}
        </motion.span>
      ))}
    </span>
  );
}
