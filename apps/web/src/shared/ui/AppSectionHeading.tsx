import { type ReactNode } from "react";

export function AppSectionHeading({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 mb-[10px]">
      <div>
        <h2 id={id} className="text-xl leading-normal [@media(max-width:650px)]:text-lg">
          {title}
        </h2>
        {description && (
          <p className="mt-1 text-muted text-[13px] [@media(max-width:650px)]:text-xs">
            {description}
          </p>
        )}
      </div>
      {children}
    </div>
  );
}
