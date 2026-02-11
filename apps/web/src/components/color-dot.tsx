interface ColorDotProps {
  hex?: string;
  size?: "sm" | "md" | "lg";
  className?: string;
}

const sizeMap = {
  sm: "h-4 w-4",
  md: "h-6 w-6",
  lg: "h-8 w-8",
};

export function ColorDot({ hex, size = "md", className = "" }: ColorDotProps) {
  return (
    <span
      className={`inline-block rounded-full border border-border transition-transform duration-150 ease-out hover:scale-110 ${sizeMap[size]} ${className}`}
      style={{ backgroundColor: hex ?? "#ccc" }}
      aria-hidden="true"
    />
  );
}
